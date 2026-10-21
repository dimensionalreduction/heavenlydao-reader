// Your library, kept on your own devices (docs/SHARED-LIBRARIES.md).
//
// The library is library-api.js's state (it answers the /api/... calls from it), split into records: one
// per glossary's details, per part of a glossary's terms, per novel, cover, chapter list, note, term of yours... Each record is encrypted with
// the owner key and signed by the device that wrote it, so the devices of the library can pass records to each other through the passphrase
// room and every one can check that a record came, unchanged, from a device of the library.
//
// Devices. The device that creates the library is its main device and keeps the root key; the library's id is the root key's public half. The
// `devices` record, signed with the root key, lists the devices whose records count. A new device asks to join (joinRequest), the main device
// is asked to allow it, and on Allow it lists the device and sends it the owner key, encrypted so only that device can read it (sealed with
// the device's X25519 key), with the new list of devices beside it. Knowing the passphrase alone is not enough to write into a library.
//
// A record:
//   { v: 1, lib, key, ver: [ms, counter, device], by: <device id> | "root", iv, body, sig }
//   body: the JSON of what the record holds, AES-GCM encrypted with the owner key (base64; iv is its nonce); the devices record's body is
//   plain JSON; null in both is a deletion. sig: Ed25519, by the device `by` (the root key for `devices`), of the canonical JSON of the rest.
//   The newest `ver` of a key wins, except the parts of a glossary's terms, which are merged term by term (a term's updatedAt decides).
//
// Library.open({ adapter, deviceName }) -> library; the adapter keeps it: memoryAdapter() (tests) or idbAdapter(name) (the extension, the site).
//
// Removing a device (main device only) lists the devices without it and replaces the owner key: every record is written again with the new key
// (its generation is the record's `kg`), and the new key goes to each remaining device sealed with its X25519 key (an `okey:<device>` record), so
// the removed device can read nothing written after.
//
// Sharing (docs/SHARED-LIBRARIES.md, step 2). The library's read key (in its share link, kept in the private `share` record) gives a catalog key
// and one key per book (HKDF), and the ids of the rooms they are read in. What readers get are "published" records: made by the owner's devices
// from the novels shared (`sbook:<book id>`: the list the library page made of a novel and its chapters) and from the chapters they hold, signed
// by the device that made them and encrypted with the catalog key or the book's key; their version comes from what they are made of, so two
// devices publishing the same novel make the same records. readPublished checks one for a reader.
(function (root) {
  "use strict";
  const LibraryApi = root.LibraryApi || (typeof require === "function" ? require("./library-api.js") : null);
  const webcrypto = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : require("node:crypto").webcrypto;
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const V = 1;
  const MAX_RECORD = 2 * 1024 * 1024; // the body of one record, as sent (a chapter list of 6,700 chapters is 1.2 MB)
  const BUCKETS = 16; // a glossary's terms are kept in this many records, so changing one term rewrites a sixteenth of it
  const JOIN_TTL = 10 * 60 * 1000; // a request to join is shown this long
  const COVERS_KEPT = 30; // covers' pictures kept in memory (the others are read from their records when asked for)

  // ---------- encoding ----------
  function b64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const b64u = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");

  // Canonical JSON (sorted keys), so what is signed is the same bytes on every device.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  }

  // ---------- keys ----------
  const ED = { name: "Ed25519" };
  const XDH = { name: "X25519" };
  async function edPair() {
    const k = await subtle.generateKey(ED, true, ["sign", "verify"]);
    return { pub: b64u(new Uint8Array(await subtle.exportKey("raw", k.publicKey))), priv: b64(new Uint8Array(await subtle.exportKey("pkcs8", k.privateKey))) };
  }
  async function xPair() {
    const k = await subtle.generateKey(XDH, true, ["deriveBits"]);
    return { pub: b64u(new Uint8Array(await subtle.exportKey("raw", k.publicKey))), priv: b64(new Uint8Array(await subtle.exportKey("pkcs8", k.privateKey))) };
  }
  const keyCache = new Map();
  function cached(id, make) {
    if (!keyCache.has(id)) keyCache.set(id, make().catch((e) => { keyCache.delete(id); throw e; }));
    return keyCache.get(id);
  }
  const signKey = (priv) => cached("s" + priv, () => subtle.importKey("pkcs8", unb64(priv), ED, false, ["sign"]));
  const verifyKey = (pub) => cached("v" + pub, () => subtle.importKey("raw", unb64u(pub), ED, false, ["verify"]));
  const aesKey = (raw) => cached("a" + raw, () => subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));

  async function sign(priv, data) {
    return b64(new Uint8Array(await subtle.sign(ED, await signKey(priv), enc.encode(data))));
  }
  async function verify(pub, data, sig) {
    try {
      return await subtle.verify(ED, await verifyKey(pub), unb64(sig), enc.encode(data));
    } catch (e) {
      return false;
    }
  }
  async function seal(key, plain) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    return { iv: b64(iv), body: b64(new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)))) };
  }
  async function unseal(key, iv, body) {
    return dec.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(body)));
  }
  // An AES key both sides can make from an X25519 pair: mine (private) and theirs (public).
  async function sharedKey(myPriv, theirPub, info) {
    const priv = await subtle.importKey("pkcs8", unb64(myPriv), XDH, false, ["deriveBits"]);
    const pub = await subtle.importKey("raw", unb64u(theirPub), XDH, false, []);
    const bits = await subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
    const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // Can this browser make and check the library's keys? (Ed25519 and X25519 in WebCrypto: Chrome 137, Firefox 130, Safari 17.)
  async function supported() {
    try {
      await subtle.generateKey(ED, true, ["sign", "verify"]);
      await subtle.generateKey(XDH, true, ["deriveBits"]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- versions ----------
  // A hybrid logical clock: [ms, counter, device]. Later than every version this device has made or seen, and comparable between devices.
  const cmpVer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  const validVer = (v) => Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && v[0] > 0 && Number.isInteger(v[1]) && v[1] >= 0 && typeof v[2] === "string" && v[2].length <= 40;

  // ---------- what the state is made of ----------
  // A glossary term's part: the same for a source word on every device.
  function bucketOf(source) {
    let h = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) { h ^= source.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) % BUCKETS;
  }

  // The kinds of records, each a part of the state. `one`: a single record; `map`: one record per id in S[field].
  // (`private` ones are the owner's alone: they will never be shared beyond the owner's devices, docs/SHARED-LIBRARIES.md section 1.)
  const MAPS = {
    binding: "bindings", novel: "novels", chapters: "chapterIndex", term: "myTerms", note: "termNotes", "comment-link": "commentLinks",
    rating: "myRatings", watch: "watches"
  };
  const ONES = { "novel-links": "novelLinks", settings: "settings", "wtr-library": "wtrLibrary", "comment-identity": "commentIdentity" };
  // Records of the owner's devices that are not part of the API's state: the share key (`share`: the link's read key), the library's public
  // profile (`profile`: its name), the novels shared (`sbook:<book id>`), each device's X25519 key (`dh:<device>`, written by that device) and
  // the owner key sealed for one device after another was removed (`okey:<device>`, written by the main device). The last two are not encrypted
  // with the owner key: dh is public, okey is sealed for its device.
  // Step 3: your version of a novel someone shared (`layer:<book id>`: { lib, bookKey, title, chapters: { their chapter's address: your chapter's
  // key } }, made the first time you change it) and how you use another library's edition of a novel you own (`edition:<book id>`:
  // { modes: { <library id>: "off" | "notify" | "use" }, asked: { <chapter number>: when } }).
  // Step 4: pull requests to you: each as it arrived (`prin:<id>`, the sealed envelope) and what you decided (`prdone:<id>`: { state, accepted,
  // at, from, book }), on every device of yours.
  const OWNER_ONES = new Set(["share", "profile", "sharing"]);
  const OWNER_MAPS = new Set(["sbook", "dh", "okey", "layer", "edition", "prin", "prdone"]);
  const PLAIN = new Set(["devices", "dh", "okey"]);
  const PRIVATE = new Set(["rating", "watch", "notice", "settings", "wtr-library", "comment-identity", "share", "sharing", "sbook", "dh", "okey", "layer", "edition", "prin", "prdone"]);
  const CHANGE_TO_PREFIX = { binding: "binding", novel: "novel", chapterIndex: "chapters", myTerm: "term", note: "note", commentLink: "comment-link", rating: "rating", watch: "watch" };
  const CHANGE_TO_ONE = { novelLinks: "novel-links", settings: "settings", wtrLibrary: "wtr-library", commentIdentity: "comment-identity" };

  const splitKey = (key) => {
    const i = key.indexOf(":");
    return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
  };
  const isPrivate = (key) => PRIVATE.has(splitKey(key)[0]);
  // Is this the key of a part of the state? (gterms:<glossary id>:<0 to 15>, novel:<id>, settings...)
  function knownKey(key) {
    const [kind, id] = splitKey(key);
    if (kind === "gterms") return /^.+:(\d|1[0-5])$/.test(id);
    if (kind === "glossary" || kind === "cover" || kind === "notice" || MAPS[kind] || OWNER_MAPS.has(kind)) return id.length > 0;
    return (!!ONES[kind] || OWNER_ONES.has(kind)) && id === "";
  }

  // What a record's signature covers: everything but the signature. (kg, the owner key's generation, only on records written after a removal.)
  const signedPart = (r) => stable({ v: r.v, lib: r.lib, key: r.key, ver: r.ver, by: r.by, iv: r.iv, body: r.body, kg: r.kg });

  // ---------- adapters ----------
  function memoryAdapter() {
    const records = new Map();
    let meta = null;
    return {
      async load() { return { meta, records: [...records.values()] }; },
      async putRecords(list) { for (const r of list) records.set(r.key, r); },
      async getRecord(key) { return records.get(key) || null; },
      async setMeta(m) { meta = JSON.parse(JSON.stringify(m)); },
      async clear() { records.clear(); meta = null; }
    };
  }

  // IndexedDB: "records" by key, "meta" holds this device's keys and the library it is in.
  function idbAdapter(name) {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("records"); req.result.createObjectStore("meta"); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const tx = async (stores, mode, fn) => {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode);
        const out = fn(t);
        t.oncomplete = () => resolve(out && "result" in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    };
    return {
      async load() {
        const meta = await tx(["meta"], "readonly", (t) => t.objectStore("meta").get("meta"));
        const records = await tx(["records"], "readonly", (t) => t.objectStore("records").getAll());
        return { meta: meta || null, records: records || [] };
      },
      putRecords: (list) => tx(["records"], "readwrite", (t) => { const st = t.objectStore("records"); for (const r of list) st.put(r, r.key); }),
      getRecord: (key) => tx(["records"], "readonly", (t) => t.objectStore("records").get(key)).then((r) => r || null),
      setMeta: (m) => tx(["meta"], "readwrite", (t) => t.objectStore("meta").put(m, "meta")),
      clear: () => tx(["records", "meta"], "readwrite", (t) => { t.objectStore("records").clear(); t.objectStore("meta").clear(); })
    };
  }

  // ---------- the library ----------
  async function open({ adapter, deviceName }) {
    const saved = await adapter.load();
    let meta = saved.meta;
    if (!meta || !meta.device) {
      // This device's own keys, made once: it signs with one, and receives the owner key on the other.
      const sig = await edPair();
      const dh = await xPair();
      meta = { device: { id: hex(webcrypto.getRandomValues(new Uint8Array(8))), name: String(deviceName || "Device").slice(0, 60), pub: sig.pub, priv: sig.priv, dhPub: dh.pub, dhPriv: dh.priv }, hlc: [0, 0] };
      await adapter.setMeta(meta);
    }
    const me = meta.device;

    const records = new Map(); // key -> the record as it travels
    let S = LibraryApi.normalizeState({});
    const extra = { share: null, profile: null, sharing: null, sbook: {}, dh: {}, okey: {}, layer: {}, edition: {}, prin: {}, prdone: {} }; // the owner's records outside the API's state (OWNER_ONES, OWNER_MAPS)
    if (meta.ownerKey && !meta.keys) { meta.keys = { 0: meta.ownerKey }; meta.gen = 0; } // (a library from before keys had generations)
    // Covers are not all held here: a cover record is kept by its head alone (`lazy`: the whole of it is in the adapter, read when it is sent),
    // and a cover's picture is read and opened when it is asked for (the last COVERS_KEPT of them are kept). pendingCovers: pictures being
    // written (the API saved one, an import), until their records are made.
    const coverCache = new Map(); // id -> bytes (the latest last)
    const pendingCovers = new Map(); // id -> bytes
    const keepCover = (id, bytes) => {
      coverCache.delete(id);
      coverCache.set(id, bytes);
      while (coverCache.size > COVERS_KEPT) coverCache.delete(coverCache.keys().next().value);
    };
    const isLazy = (key) => key.startsWith("cover:");
    // a record, kept: a cover's by its head alone
    function keep(r) {
      if (isLazy(r.key) && r.body !== null) records.set(r.key, { v: r.v, lib: r.lib, key: r.key, ver: r.ver, by: r.by, kg: r.kg, body: "", lazy: true });
      else records.set(r.key, r);
    }
    async function wholeRecord(key) {
      const r = records.get(key);
      return r && r.lazy ? adapter.getRecord(key) : r || null;
    }
    // a cover's picture: written now, kept, or read from its record
    async function coverBytesOf(id) {
      if (pendingCovers.has(id)) return pendingCovers.get(id);
      if (coverCache.has(id)) { const b = coverCache.get(id); keepCover(id, b); return b; }
      if (!S.covers[id]) return null;
      const r = await wholeRecord("cover:" + id);
      if (!r || r.body === null) return null;
      try {
        const body = await bodyOfRecord(r);
        if (!body || typeof body.data !== "string") return null;
        const bytes = unb64(body.data);
        keepCover(id, bytes);
        return bytes;
      } catch (e) {
        return null;
      }
    }
    let devices = []; // [{ id, pub, name, added, main }]
    let ownerAes = null;
    const joins = new Map(); // device id -> a request to join, on the main device
    const asking = new Map(); // (a device that is not the main one) who asks to join, as they pass: id -> { id, name, seenAt }
    const listeners = { records: new Set(), change: new Set() };
    let changes = 0; // (how many changes so far: what is made from the library can be kept until the next)
    const emit = (what, x) => { if (what === "change") changes++; for (const fn of listeners[what]) { try { fn(x); } catch (e) { /* a listener's own trouble */ } } };

    // ----- the clock -----
    function tick() {
      const ms = Math.max(Date.now(), meta.hlc[0]);
      meta.hlc = [ms, ms === meta.hlc[0] ? meta.hlc[1] + 1 : 0];
      return [meta.hlc[0], meta.hlc[1], me.id];
    }
    function seen(ver) {
      if (cmpVer([ver[0], ver[1], ""], [meta.hlc[0], meta.hlc[1], ""]) > 0 && ver[0] < Date.now() + 24 * 3600 * 1000) meta.hlc = [ver[0], ver[1]];
    }

    // ----- records <-> state -----
    // The body of a record, from the state as it is now (null: it is gone).
    function bodyOf(key) {
      const [kind, id] = splitKey(key);
      if (kind === "glossary") {
        const g = S.glossaries[id];
        if (!g) return null;
        const { terms, rev, ...rest } = g;
        return rest;
      }
      if (kind === "gterms") {
        const cut = id.lastIndexOf(":");
        const g = S.glossaries[id.slice(0, cut)];
        const b = Number(id.slice(cut + 1));
        if (!g) return null;
        const terms = {};
        for (const [s, t] of Object.entries(g.terms)) if (bucketOf(s) === b) { const { rev, ...rest } = t; terms[s] = rest; }
        return Object.keys(terms).length ? { terms } : null;
      }
      if (kind === "cover") {
        const m = S.covers[id];
        const bytes = pendingCovers.get(id) || coverCache.get(id);
        return m && bytes ? Object.assign({}, m, { data: b64(bytes) }) : null;
      }
      if (kind === "notice") return S.notices.find((n) => n.id === id) || null;
      if (OWNER_ONES.has(kind) && !id) return extra[kind];
      if (OWNER_MAPS.has(kind)) return extra[kind][id] === undefined ? null : extra[kind][id];
      if (MAPS[kind]) {
        const v = S[MAPS[kind]][id];
        if (v === undefined) return null;
        if (kind === "binding") return { ids: v.ids, updatedAt: v.updatedAt };
        return v;
      }
      if (ONES[kind]) return S[ONES[kind]];
      return undefined; // not a part of the state
    }

    // Puts a record's body into the state.
    function applyBody(key, body) {
      const [kind, id] = splitKey(key);
      if (kind === "glossary") {
        const cur = S.glossaries[id];
        if (body === null) { if (cur) cur.deleted = true; else return; }
        else S.glossaries[id] = Object.assign({}, body, { terms: cur ? cur.terms : {} });
        S.glossaries[id].rev = ++S.rev;
        return;
      }
      if (kind === "gterms") {
        const cut = id.lastIndexOf(":");
        const gid = id.slice(0, cut);
        const b = Number(id.slice(cut + 1));
        const g = S.glossaries[gid] || (S.glossaries[gid] = { id: gid, name: gid, site: "", rawId: "", slug: "", createdAt: 0, updatedAt: 0, terms: {} });
        for (const s of Object.keys(g.terms)) if (bucketOf(s) === b && !(body && body.terms[s])) delete g.terms[s];
        if (body) for (const [s, t] of Object.entries(body.terms)) g.terms[s] = Object.assign({}, t, { rev: S.rev + 1 });
        g.rev = ++S.rev;
        return;
      }
      if (kind === "cover") {
        coverCache.delete(id); // (its picture is read from its record when asked for)
        if (body === null) { delete S.covers[id]; return; }
        const { data, ...m } = body;
        S.covers[id] = m;
        return;
      }
      if (kind === "notice") {
        S.notices = S.notices.filter((n) => n.id !== id);
        if (body) { S.notices.push(body); S.notices.sort((a, b) => b.at - a.at); }
        return;
      }
      if (OWNER_ONES.has(kind) && !id) { extra[kind] = body; return; }
      if (OWNER_MAPS.has(kind)) {
        if (body === null) delete extra[kind][id];
        else extra[kind][id] = body;
        return;
      }
      if (MAPS[kind]) {
        const map = S[MAPS[kind]];
        if (body === null) delete map[id];
        else map[id] = kind === "binding" ? { ids: body.ids, updatedAt: body.updatedAt, rev: ++S.rev } : body;
        if (kind === "binding" && body === null) S.rev++;
        return;
      }
      if (ONES[kind]) {
        S[ONES[kind]] = body === null ? LibraryApi.normalizeState({})[ONES[kind]] : body;
      }
    }

    // Merges an arriving part of a glossary's terms with this device's: per term, the later change wins (a deleted term stays deleted until
    // changed again), so two devices changing different terms both keep what they did.
    function mergeTerms(mine, theirs) {
      const out = {};
      const later = (a, b) => {
        if (!a) return b;
        if (!b) return a;
        if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
        return stable(a) >= stable(b) ? a : b;
      };
      for (const s of new Set([...Object.keys(mine), ...Object.keys(theirs)])) out[s] = later(mine[s], theirs[s]);
      return out;
    }

    // ----- making and checking records -----
    async function makeRecord(key, body) {
      const r = { v: V, lib: meta.libId, key, ver: tick(), by: me.id, iv: null, body: null };
      if (body !== null && PLAIN.has(splitKey(key)[0])) r.body = JSON.stringify(body);
      else if (body !== null) {
        Object.assign(r, await seal(ownerAes, JSON.stringify(body)));
        if (meta.gen) r.kg = meta.gen;
      }
      r.sig = await sign(me.priv, signedPart(r));
      return r;
    }

    // What a record holds (null: deleted). Throws when it cannot be read; "key not known yet" when it was written with an owner key this
    // device has not got yet (the sealed one is on its way).
    async function bodyOfRecord(r) {
      if (r.body === null) return null;
      if (PLAIN.has(splitKey(r.key)[0])) return JSON.parse(r.body);
      const k = meta.keys && meta.keys[r.kg || 0];
      if (!k) throw new Error("key not known yet");
      return JSON.parse(await unseal(await aesKey(k), r.iv, r.body));
    }

    // The owner key sealed for this device (after a device was removed): kept, and used for writing from now on when it is the newest.
    async function takeOwnerKey(body) {
      if (!body || !Number.isInteger(body.gen)) return false;
      try {
        const key = await sharedKey(me.dhPriv, body.epk, "p2p-read owner key " + me.id + " " + body.gen);
        const raw = JSON.parse(await unseal(key, body.iv, body.ct));
        if (typeof raw.key !== "string") return false;
        meta.keys = Object.assign({}, meta.keys, { [body.gen]: raw.key });
        if (body.gen > (meta.gen || 0)) { meta.gen = body.gen; meta.ownerKey = raw.key; ownerAes = await aesKey(raw.key); }
        return true;
      } catch (e) {
        return false;
      }
    }

    async function makeDevices(list) {
      const r = { v: V, lib: meta.libId, key: "devices", ver: tick(), by: "root", iv: null, body: JSON.stringify(list) };
      r.sig = await sign(meta.root.priv, signedPart(r));
      return r;
    }

    // Is this record what a device of the library signed, and something this device can keep? (Not yet: whether it is newer.)
    async function check(r) {
      if (!r || typeof r !== "object" || r.v !== V || r.lib !== meta.libId || typeof r.key !== "string" || r.key.length > 600 || !validVer(r.ver)) return "malformed";
      if (r.body !== null && (typeof r.body !== "string" || r.body.length > MAX_RECORD * 1.4)) return "too big";
      if (r.key === "devices") {
        if (r.by !== "root" || typeof r.body !== "string") return "malformed";
        return (await verify(meta.libId, signedPart(r), r.sig)) ? "" : "bad signature";
      }
      if (!knownKey(r.key)) return "unknown kind";
      const dev = devices.find((d) => d.id === r.by);
      if (!dev) return "not a device of this library";
      const [kind, id] = splitKey(r.key);
      if (PLAIN.has(kind) ? r.iv !== null : r.body !== null && typeof r.iv !== "string") return "malformed";
      if (kind === "dh" && id !== r.by) return "a device's key is written by that device";
      if (kind === "okey" && !dev.main) return "owner keys are sent by the main device";
      return (await verify(dev.pub, signedPart(r), r.sig)) ? "" : "bad signature";
    }

    function setDevices(r) {
      try {
        const list = JSON.parse(r.body);
        devices = Array.isArray(list) ? list.filter((d) => d && typeof d.id === "string" && typeof d.pub === "string").slice(0, 50) : [];
      } catch (e) {
        devices = [];
      }
      if (devices.some((d) => d.id === me.id)) meta.wasListed = true;
    }
    const listed = () => !!ownerAes && devices.some((d) => d.id === me.id);
    // A list of devices kept as the one in use (checked and newer: receive, takeDevices).
    async function keepDevices(r) {
      records.set("devices", r);
      setDevices(r);
      await adapter.putRecords([r]);
      await adapter.setMeta(meta);
    }
    // The list that came with the keys (receiveKeys): kept when it is a real list of this library, newer than the one here.
    async function takeDevices(r) {
      if (await check(r)) return false;
      if (r.key !== "devices") return false;
      const cur = records.get("devices");
      if (cur && cmpVer(cur.ver, r.ver) >= 0) return false;
      seen(r.ver);
      await keepDevices(r);
      await ensureDh();
      return true;
    }

    // ----- loading -----
    if (meta.libId) {
      const all = saved.records;
      const dev = all.find((r) => r.key === "devices");
      if (dev) { records.set("devices", dev); setDevices(dev); }
      if (meta.ownerKey) {
        ownerAes = await aesKey(meta.keys[meta.gen || 0]);
        // (each part of a glossary goes in after the glossary itself, so its details are there)
        all.sort((a, b) => (a.key.startsWith("gterms:") ? 1 : 0) - (b.key.startsWith("gterms:") ? 1 : 0));
        for (const r of all) {
          if (r.key === "devices") continue;
          keep(r);
          try {
            applyBody(r.key, await bodyOfRecord(r));
          } catch (e) {
            records.delete(r.key); // (a record this device cannot read: it is asked for again)
          }
        }
      }
    }

    // ----- writing, from the API -----
    let writing = Promise.resolve();
    const serial = (fn) => { const p = writing.then(fn, fn); writing = p.catch(() => {}); return p; };

    // A record's body as it is now; a cover's picture read from its record first when it is not being written (bodyOf cannot wait).
    async function bodyFor(key) {
      const [kind, id] = splitKey(key);
      if (kind === "cover" && S.covers[id] && !pendingCovers.has(id) && !coverCache.has(id)) await coverBytesOf(id);
      return bodyOf(key);
    }
    async function publish(keys) {
      const out = [];
      for (const key of keys) {
        const body = await bodyFor(key);
        if (body === undefined) continue;
        const cur = records.get(key);
        if (body === null && (!cur || cur.body === null)) continue; // gone, and already said so (or never was)
        out.push(await makeRecord(key, body));
      }
      if (out.length) {
        await adapter.putRecords(out);
        for (const r of out) keep(r);
        for (const r of out) { const [kind, id] = splitKey(r.key); if (kind === "cover") pendingCovers.delete(id); }
        await adapter.setMeta(meta);
        emit("records", out);
      }
      return out;
    }

    function keysOf(change) {
      if (change.kind === "glossary") return ["glossary:" + change.id];
      if (change.kind === "terms") return [...new Set(change.sources.map((s) => "gterms:" + change.id + ":" + bucketOf(s)))];
      if (change.kind === "cover") return ["cover:" + change.id];
      if (change.kind === "notice") return ["notice:" + change.id];
      if (CHANGE_TO_PREFIX[change.kind]) return [CHANGE_TO_PREFIX[change.kind] + ":" + change.id];
      if (CHANGE_TO_ONE[change.kind]) return [CHANGE_TO_ONE[change.kind]];
      return [];
    }

    // Each listed device says its X25519 key once (dh:<device>), so the main device can send it a new owner key after removing another.
    async function ensureDh() {
      if (!listed() || extra.dh[me.id]) return [];
      extra.dh[me.id] = { dh: me.dhPub };
      return publish(["dh:" + me.id]);
    }

    // The API works on S; an import replaces S, so the API is made again then.
    let pending = [];
    let handler = null;
    const rebuild = () => {
      handler = LibraryApi.createLibraryApi({
        state: S,
        persist: (change) => pending.push(...keysOf(change)),
        covers: { save: (id, bytes) => { pendingCovers.set(id, new Uint8Array(bytes)); keepCover(id, new Uint8Array(bytes)); }, read: (id) => coverBytesOf(id) }
      });
    };
    rebuild();

    const lib = {
      on(what, fn) { listeners[what].add(fn); return () => listeners[what].delete(fn); },

      // none: in no library · joining: asked, or let in and waiting for the list of devices to say so · member · removed: taken off the list
      status() {
        const listed = devices.some((d) => d.id === me.id);
        let state = "none";
        if (meta.libId && ownerAes) state = listed ? "member" : meta.wasListed ? "removed" : "joining";
        else if (meta.joinAsked) state = "joining";
        const now = Date.now();
        return {
          state, libId: meta.libId || "", code: meta.libId ? codeOf(meta.libId) : "",
          device: { id: me.id, name: me.name }, main: !!meta.root,
          devices: devices.map((d) => ({ id: d.id, name: d.name, added: d.added, main: !!d.main, me: d.id === me.id })),
          refused: meta.root ? (meta.refused || []).map((id) => ({ id, name: (meta.refusedNames && meta.refusedNames[id]) || "Device" })) : [],
          joins: [...joins.values()].filter((j) => now - j.seenAt < JOIN_TTL).map((j) => ({ id: j.id, name: j.name, at: j.at })),
          asking: meta.root ? [] : [...asking.values()].filter((j) => now - j.seenAt < JOIN_TTL && !devices.some((d) => d.id === j.id)).map((j) => ({ id: j.id, name: j.name })),
          name: (extra.profile && extra.profile.name) || "", sharing: !!extra.share, shared: Object.keys(extra.sbook).length,
          prs: (extra.profile && extra.profile.prs) || "anyone", approved: (extra.profile && extra.profile.approved) || []
        };
      },

      // A new library, with this device as its main device.
      create: () => serial(async () => {
        if (meta.libId) throw new Error("this device is already in a library");
        const rootKey = await edPair();
        meta.libId = rootKey.pub;
        meta.root = { priv: rootKey.priv };
        meta.ownerKey = b64(webcrypto.getRandomValues(new Uint8Array(32)));
        ownerAes = await aesKey(meta.ownerKey);
        meta.keys = { 0: meta.ownerKey };
        meta.gen = 0;
        const list = [{ id: me.id, pub: me.pub, name: me.name, added: Date.now(), main: true, dh: me.dhPub }];
        const r = await makeDevices(list);
        records.set("devices", r);
        setDevices(r);
        await adapter.putRecords([r]);
        await adapter.setMeta(meta);
        emit("records", [r]);
        await ensureDh();
        emit("change", { status: true });
        return lib.status();
      }),

      // Drops a library to join yours instead: one no other device is in (one a page started by itself on a first visit), or one this device was
      // taken off (its list no longer has it, so it can only ask again). What it holds goes, this device's own keys stay, and it asks to join.
      abandon: () => serial(async () => {
        if (listed() && devices.some((d) => d.id !== me.id)) throw new Error("other devices are in this library: remove them first");
        await adapter.clear();
        meta = { device: me, hlc: meta.hlc, joinAsked: Date.now() };
        await adapter.setMeta(meta);
        records.clear();
        devices = [];
        ownerAes = null;
        S = LibraryApi.normalizeState({});
        for (const k of Object.keys(extra)) extra[k] = k === "share" || k === "profile" || k === "sharing" ? null : {};
        coverCache.clear();
        pendingCovers.clear();
        joins.clear();
        asking.clear();
        pending = [];
        rebuild();
        emit("change", { status: true });
      }),

      // A connection's proof that this is a device of the library (p2p-core.js, "pf"): what it signs is made by the room, from both ends'
      // keys for that connection. null when this device is in no library (whether it is listed is for the other end to see: a device just let
      // in has not had the list yet).
      peerProof: async (data) => (meta.libId && ownerAes ? { d: me.id, s: await sign(me.priv, data) } : null),
      // Did a device listed in this library sign `data`?
      peerCheck: async (id, data, sig) => {
        const d = typeof id === "string" && typeof sig === "string" && devices.find((x) => x.id === id);
        return !!d && verify(d.pub, data, sig);
      },

      // What this device sends to ask to join the library of the devices it meets.
      joinRequest() {
        if (!meta.joinAsked) { meta.joinAsked = Date.now(); adapter.setMeta(meta).catch(() => {}); }
        return { t: "jn", id: me.id, name: me.name, pub: me.pub, dh: me.dhPub, at: meta.joinAsked };
      },
      cancelJoin: () => serial(async () => { delete meta.joinAsked; await adapter.setMeta(meta); emit("change", { status: true }); }),

      // A request to join, arriving at a device of the library. Only the main device can answer it, so only it keeps it. Another device of the
      // library notes who asks (status().asking), to say so (its notifications: the main device is where it is answered), and passes it on.
      joinAsked(msg) {
        if (!meta.root && msg && typeof msg.id === "string" && /^[0-9a-f]{16}$/.test(msg.id) && meta.libId && ownerAes && !devices.some((d) => d.id === msg.id)) {
          const fresh = !asking.has(msg.id);
          asking.set(msg.id, { id: msg.id, name: String(msg.name || "Device").slice(0, 60), seenAt: Date.now() });
          if (asking.size > 50) asking.delete(asking.keys().next().value);
          if (fresh) emit("change", { status: true });
          return false;
        }
        if (!meta.root || !msg || typeof msg.id !== "string" || !/^[0-9a-f]{16}$/.test(msg.id) || typeof msg.pub !== "string" || typeof msg.dh !== "string") return false;
        if (devices.some((d) => d.id === msg.id) || meta.refused && meta.refused.includes(msg.id)) return false;
        const fresh = !joins.has(msg.id);
        joins.set(msg.id, { id: msg.id, name: String(msg.name || "Device").slice(0, 60), pub: msg.pub.slice(0, 100), dh: msg.dh.slice(0, 100), at: Number(msg.at) || Date.now(), seenAt: Date.now() });
        if (fresh) emit("change", { status: true });
        return true;
      },

      // Allow a device that asked: list it, and give it the owner key, sealed for that device only.
      allow: (id) => serial(async () => {
        if (!meta.root) throw new Error("only the main device can add devices");
        const j = joins.get(id);
        if (!j) throw new Error("that device is no longer asking");
        joins.delete(id);
        const list = devices.filter((d) => d.id !== id).concat([{ id: j.id, pub: j.pub, name: j.name, added: Date.now(), main: false, dh: j.dh }]);
        const r = await makeDevices(list);
        records.set("devices", r);
        setDevices(r);
        await adapter.putRecords([r]);
        await adapter.setMeta(meta);
        const eph = await xPair();
        const key = await sharedKey(eph.priv, j.dh, "p2p-read join " + j.id);
        const sealed = await seal(key, JSON.stringify({ lib: meta.libId, ownerKey: meta.ownerKey, keys: meta.keys, gen: meta.gen || 0 }));
        emit("records", [r]);
        emit("change", { status: true });
        // dv: the list that has it, so it is a device of the library as the keys come, whichever devices pass them on (one in no library
        // passes them, but has no list to send)
        return { keys: { t: "jk", to: j.id, epk: eph.pub, iv: sealed.iv, ct: sealed.body, dv: r }, records: [r] };
      }),

      // Not this device: it is kept on the refused list (status().refused, with the name it asked with), so its asking is not shown again,
      // until unrefuse takes it off.
      refuse: (id) => serial(async () => {
        const j = joins.get(id);
        joins.delete(id);
        meta.refused = (meta.refused || []).filter((x) => x !== id).concat(id).slice(-50);
        meta.refusedNames = Object.assign({}, meta.refusedNames, { [id]: (j && j.name) || (meta.refusedNames && meta.refusedNames[id]) || "Device" });
        for (const k of Object.keys(meta.refusedNames)) if (!meta.refused.includes(k)) delete meta.refusedNames[k];
        await adapter.setMeta(meta);
        emit("change", { status: true });
      }),
      // Take a device off the refused list: when it asks again (a device asks whenever it meets the main device), it is shown, to be allowed.
      unrefuse: (id) => serial(async () => {
        meta.refused = (meta.refused || []).filter((x) => x !== id);
        if (meta.refusedNames) delete meta.refusedNames[id];
        await adapter.setMeta(meta);
        emit("change", { status: true });
      }),

      // The owner key, sent by the main device after Allow. Opens only with this device's own X25519 key.
      receiveKeys: (msg) => serial(async () => {
        if (!msg || msg.t !== "jk" || msg.to !== me.id || meta.ownerKey) return false;
        let got;
        try {
          const key = await sharedKey(me.dhPriv, msg.epk, "p2p-read join " + me.id);
          got = JSON.parse(await unseal(key, msg.iv, msg.ct));
        } catch (e) {
          return false;
        }
        if (!got || typeof got.lib !== "string" || typeof got.ownerKey !== "string") return false;
        meta.libId = got.lib;
        meta.ownerKey = got.ownerKey;
        meta.keys = got.keys && typeof got.keys === "object" ? got.keys : { 0: got.ownerKey };
        meta.gen = Number.isInteger(got.gen) ? got.gen : 0;
        delete meta.joinAsked;
        ownerAes = await aesKey(meta.ownerKey);
        await adapter.setMeta(meta);
        if (msg.dv) await takeDevices(msg.dv).catch(() => false); // (from a main device of before: the list comes from the devices met)
        emit("change", { status: true });
        return true;
      }),

      // One /api/... call, answered from the library (library-api.js). What it changes is written as records and
      // handed to the "records" listeners, to be sent to the other devices.
      api: (method, path, body) => serial(async () => {
        if (!listed()) throw Object.assign(new Error(meta.wasListed ? "this device was removed from the library" : "this device is not in a library yet"), { status: 503 });
        pending = [];
        let out;
        try {
          out = await handler.handle(method, path, body);
        } finally {
          const keys = [...new Set(pending)];
          pending = [];
          if (keys.length) await publish(keys);
        }
        return out;
      }),

      // A record from another device. Kept when it is a real record of this library and newer than the one kept; a part of a glossary that
      // this device has newer terms for is merged and written again (returned in `out`, to be sent on).
      receive: (r) => serial(async () => {
        if (!meta.libId) return { stored: false, why: "not in a library" };
        const why = await check(r);
        if (why) return { stored: false, why };
        const cur = records.get(r.key);
        if (cur && cmpVer(cur.ver, r.ver) >= 0) return { stored: false, why: "not newer" };
        seen(r.ver);
        if (r.key === "devices") {
          await keepDevices(r);
          const out = await ensureDh();
          emit("change", { status: true });
          return { stored: true, out };
        }
        if (!ownerAes) return { stored: false, why: "no owner key yet" };
        let body;
        try {
          body = await bodyOfRecord(r);
        } catch (e) {
          return { stored: false, why: e.message === "key not known yet" ? e.message : "cannot be read" };
        }
        if (r.key === "okey:" + me.id && body) await takeOwnerKey(body);
        let out = [];
        if (r.key.startsWith("gterms:") && cur && cur.body !== null) {
          const mine = bodyOf(r.key) || { terms: {} };
          const merged = { terms: mergeTerms(mine.terms, body ? body.terms : {}) };
          applyBody(r.key, merged);
          records.set(r.key, r);
          if (stable(merged) !== stable(body || { terms: {} })) out = await publish([r.key]); // (mine had later terms: the merge goes out)
          else await adapter.putRecords([r]);
        } else {
          applyBody(r.key, body);
          await adapter.putRecords([r]);
          keep(r);
        }
        await adapter.setMeta(meta);
        emit("change", { key: r.key });
        return { stored: true, out };
      }),

      // ----- the owner's records outside the API: the profile, the novels shared -----
      // put("profile", { name }) · put("sbook:<book id>", list | null) · put("layer:<book id>", ...) · put("edition:<book id>", ...). Written only
      // when it changed; the answer says whether it did.
      put: (key, body) => serial(async () => {
        if (!listed()) throw new Error("this device is not in a library yet");
        const [kind] = splitKey(key);
        if (!["profile", "sharing", "sbook", "layer", "edition", "prin", "prdone"].includes(kind) || !knownKey(key)) throw new Error("not something to put: " + key);
        const cur = bodyOf(key);
        if (stable(cur === undefined ? null : cur) === stable(body)) return { changed: false };
        applyBody(key, body);
        await publish([key]);
        emit("change", { key });
        return { changed: true };
      }),
      sharedBooks: () => JSON.parse(JSON.stringify(extra.sbook)),
      sharedBookIds: () => Object.keys(extra.sbook), // (the ids alone: no copy of every novel's list of chapters)
      changeCount: () => changes,
      // What is shared with readers (`sharing`, the owner's own): every novel (all), but those stopped one by one (off: book ids); all false:
      // only the novels shared one by one. Every novel by default.
      sharing: () => Object.assign({ all: true, off: [], outCap: 0 }, JSON.parse(JSON.stringify(extra.sharing || {}))), // (outCap: what each device sends readers a day at most; 0: OUT_CAP)
      layers: () => JSON.parse(JSON.stringify(extra.layer)),
      editions: () => JSON.parse(JSON.stringify(extra.edition)),
      // Your terms for a novel known by these keys (and those for every novel), with their versions: what readers of it get.
      termsFor: (keys) => {
        const ks = new Set(keys || []);
        return Object.values(S.myTerms)
          .filter((t) => !t.gone && (!(t.keys && t.keys.length) || t.keys.some((k) => ks.has(k))))
          .map((t) => ({ term: { id: t.id, from: t.from, to: t.to, cs: !!t.cs }, ver: records.has("term:" + t.id) ? records.get("term:" + t.id).ver : [1, 0, ""] }));
      },
      // The glossary of a novel known by these keys, for readers who get the novel: the glossaries bound to it (a key that is a glossary's own id counts) and
      // the ones in other languages made from them ("<id>@<code>"), as { ver, langs: { en: [[source, rendering, list]], es: [...] } } where list is novel, ai,
      // shared:<name>, yours, gemini or copied; a term deleted here is not in it. null when it has none. A source in two of the glossaries has the first's.
      glossaryFor: (keys) => {
        const ids = [];
        for (const k of keys || []) {
          const b = S.bindings[k];
          for (const id of (b && b.ids) || []) if (!ids.includes(id)) ids.push(id);
          if (S.glossaries[k] && !S.glossaries[k].deleted && !ids.includes(k)) ids.push(k);
        }
        const langs = {};
        const seen = {};
        let at = 0;
        let rev = 0;
        for (const base of ids) {
          for (const g of Object.values(S.glossaries)) {
            if (g.deleted) continue;
            const cut = g.id.indexOf("@");
            if ((cut < 0 ? g.id : g.id.slice(0, cut)) !== base) continue;
            const lang = cut < 0 ? "en" : g.id.slice(cut + 1);
            const rows = langs[lang] || (langs[lang] = []);
            const had = seen[lang] || (seen[lang] = new Set());
            for (const [s, v] of Object.entries(g.terms)) {
              if (v.deleted || !v.t || had.has(s)) continue;
              had.add(s);
              rows.push([s, v.t, v.src === "user" ? "yours" : String(v.o || "novel")]);
            }
            at = Math.max(at, g.updatedAt || 0);
            rev = Math.max(rev, g.rev || 0);
          }
        }
        for (const lang of Object.keys(langs)) if (!langs[lang].length) delete langs[lang];
        return Object.keys(langs).length ? { ver: [at || 1, rev, ""], langs } : null;
      },
      // a novel's cover copy, for publishing it: { type, bytes, at } or null
      // a cover's picture: { type, bytes, at } or null (read from its record when not kept: covers are not all held in memory)
      cover: async (id) => {
        const m = S.covers[id];
        const bytes = m ? await coverBytesOf(id) : null;
        return m && bytes ? { type: m.type, bytes, at: m.at } : null;
      },
      sharedBook: (id) => (extra.sbook[id] ? Object.assign({ ver: records.get("sbook:" + id).ver }, extra.sbook[id]) : null),
      profile: () => Object.assign({ ver: records.has("profile") ? records.get("profile").ver : [0, 0, ""] }, extra.profile || { name: "" }),

      // The library's read key (made the first time it is asked for), and with it the catalog key and the library room. newLink: a new read key,
      // so the links given so far get nothing new.
      share: (newLink) => serial(async () => {
        if (!listed()) throw new Error("this device is not in a library yet");
        // with the read key, the seal key pull requests are sealed with (made once, kept across new links; a library from before it has one
        // added now)
        if (!extra.share || newLink || !extra.share.sealPub) {
          const seal = extra.share && extra.share.sealPub ? { sealPub: extra.share.sealPub, sealPriv: extra.share.sealPriv } : await xPair().then((x) => ({ sealPub: x.pub, sealPriv: x.priv }));
          const readKey = !extra.share || newLink ? b64u(webcrypto.getRandomValues(new Uint8Array(32))) : extra.share.readKey;
          applyBody("share", Object.assign({ readKey, at: Date.now() }, seal));
          await publish(["share"]);
          emit("change", { key: "share" });
        }
        return Object.assign({ libId: meta.libId }, extra.share, await shareKeys(meta.libId, extra.share.readKey));
      }),
      shareNow: () => (extra.share ? Object.assign({ libId: meta.libId }, extra.share) : null),

      // A record for readers, signed by this device: key, its version, what it holds, and the key it is encrypted with (none: plain).
      makePublished: async (key, ver, body, aesB64u) => {
        const r = { v: V, lib: meta.libId, key, ver, by: me.id, iv: null, body: null };
        if (body !== null && aesB64u) Object.assign(r, await seal(await aesKeyU(aesB64u), JSON.stringify(body)));
        else if (body !== null) r.body = JSON.stringify(body);
        r.sig = await sign(me.priv, signedPart(r));
        return r;
      },

      // ----- comments (step 5) -----
      // A comment (or the deleting of one) signed by this device for its library, for the comments server: its author is the library.
      //   what: { t: "comment", thread, text, name, url } or { t: "delete", id } -> { lib, by, at, devices, sig }
      signComment: async (what) => {
        if (!listed()) throw new Error("this device is not in a library yet");
        const s = { lib: meta.libId, by: me.id, at: Date.now() };
        const sig = await sign(me.priv, stable(Object.assign({}, what, s)));
        return Object.assign(s, { devices: records.get("devices"), sig });
      },

      // ----- pull requests -----
      // A pull request from this library to another's (its changes to one novel), sealed with that library's seal key: only its owner opens it.
      makePr: async ({ to, book, sealKey, body }) => {
        if (!listed()) throw new Error("this device is not in a library yet");
        const eph = await xPair();
        const sealed = await seal(await sharedKey(eph.priv, sealKey, "p2p-read pr " + to), JSON.stringify(body));
        const at = Date.now();
        const e = { v: V, t: "pr", id: hex(webcrypto.getRandomValues(new Uint8Array(12))), to, from: meta.libId, by: me.id, book: String(book), at, expires: at + PR_TTL,
          epk: eph.pub, iv: sealed.iv, ct: sealed.body, devices: records.get("devices") };
        e.sig = await sign(me.priv, prSigned(e));
        return e;
      },
      // What a pull request to this library says (owner devices only: the seal key is theirs).
      openPr: async (e) => {
        if (!extra.share || !extra.share.sealPriv) throw new Error("this library has no seal key");
        return JSON.parse(await unseal(await sharedKey(extra.share.sealPriv, e.epk, "p2p-read pr " + meta.libId), e.iv, e.ct));
      },
      // The pull requests that came, opened: [{ id, from, book, at, body, done }] (done: what you decided, or null), newest first.
      inbox: async () => {
        const out = [];
        for (const [id, e] of Object.entries(extra.prin)) {
          let body = null;
          try { body = await lib.openPr(e); } catch (err) { body = { error: "cannot be opened (sealed with an older key)" }; }
          out.push({ id, from: e.from, book: e.book, at: e.at, expires: e.expires, body, done: extra.prdone[id] || null });
        }
        return out.sort((a, b) => b.at - a.at);
      },
      prDone: (id) => extra.prdone[id] || null,
      prsDone: () => JSON.parse(JSON.stringify(extra.prdone)),
      hasPr: (id) => !!(extra.prin[id] || extra.prdone[id]),
      shareVer: () => (records.has("share") ? records.get("share").ver : [0, 0, ""]),

      // ----- removing a device (main device only) -----
      // The list of devices without it; a new owner key, sealed for each remaining device; every record written again with it. newLink: a new
      // read key too (the removed device knows the old one). Answers which devices could not be sent the new key (from before devices said theirs).
      removeDevice: (id, opts = {}) => serial(async () => {
        if (!meta.root) throw new Error("only the main device can remove devices");
        if (id === me.id) throw new Error("the main device cannot remove itself");
        if (!devices.some((d) => d.id === id)) throw new Error("no such device");
        const list = devices.filter((d) => d.id !== id);
        const dr = await makeDevices(list);
        records.set("devices", dr);
        setDevices(dr);
        await adapter.putRecords([dr]);
        emit("records", [dr]);
        const gen = (meta.gen || 0) + 1;
        const key = b64(webcrypto.getRandomValues(new Uint8Array(32)));
        meta.keys = Object.assign({}, meta.keys, { [gen]: key });
        meta.gen = gen;
        meta.ownerKey = key;
        ownerAes = await aesKey(key);
        const missed = [];
        for (const d of list) {
          if (d.id === me.id) continue;
          const dh = (extra.dh[d.id] && extra.dh[d.id].dh) || d.dh;
          if (!dh) { missed.push(d.name); continue; }
          const eph = await xPair();
          const sealed = await seal(await sharedKey(eph.priv, dh, "p2p-read owner key " + d.id + " " + gen), JSON.stringify({ key }));
          extra.okey[d.id] = { gen, epk: eph.pub, iv: sealed.iv, ct: sealed.body };
        }
        delete extra.okey[id];
        delete extra.dh[id];
        if (extra.share) {
          // a new seal key (the removed device could open pull requests sealed with the old one), and a new read key when asked
          const x = await xPair();
          applyBody("share", Object.assign({}, extra.share, { sealPub: x.pub, sealPriv: x.priv, at: Date.now() }, opts.newLink ? { readKey: b64u(webcrypto.getRandomValues(new Uint8Array(32))) } : {}));
        }
        // everything again: the owner keys first, so a device can read what follows
        const keys = [...records.keys()].filter((k) => k !== "devices");
        keys.sort((a, b) => (b.startsWith("okey:") ? 1 : 0) - (a.startsWith("okey:") ? 1 : 0));
        for (const d of list) if (extra.okey[d.id] && !keys.includes("okey:" + d.id)) keys.unshift("okey:" + d.id);
        if (!keys.includes("share") && extra.share) keys.push("share");
        const rewritten = [];
        for (const k of keys) {
          const body = await bodyFor(k);
          if (body === undefined || body === null) continue;
          rewritten.push(await makeRecord(k, body));
        }
        await adapter.putRecords(rewritten);
        for (const r of rewritten) keep(r);
        await adapter.setMeta(meta);
        emit("records", rewritten);
        emit("change", { status: true });
        return { removed: id, missed, records: rewritten.length };
      }),

      // [[key, ver], ...] of every record kept: what another device compares with its own.
      versions: () => [...records.values()].map((r) => [r.key, r.ver]),
      // (a cover's whole record is read from the adapter: a promise then)
      get: (key) => { const r = records.get(key); return r && r.lazy ? adapter.getRecord(key) : r || null; },
      // Is a record of this version newer than the one kept (so worth asking for)?
      wants: (key, ver) => { const cur = records.get(key); return !cur || cmpVer(cur.ver, ver) < 0; },

      // A whole state (library-api.js's, as a glossary server once exported it) and its covers ({ id: bytes }), as this library's content, written as records.
      importState: (raw, covers) => serial(async () => {
        if (!listed()) throw new Error("this device is not in a library yet");
        const prevKeys = [...records.keys()].filter((k) => k !== "devices" && !OWNER_ONES.has(splitKey(k)[0]) && !OWNER_MAPS.has(splitKey(k)[0]));
        S = LibraryApi.normalizeState(raw);
        coverCache.clear();
        pendingCovers.clear();
        for (const [id, bytes] of Object.entries(covers || {})) if (S.covers[id]) pendingCovers.set(id, new Uint8Array(bytes));
        for (const id of Object.keys(S.covers)) if (!pendingCovers.has(id)) delete S.covers[id]; // (a cover whose picture could not be had)
        rebuild();
        const keys = new Set(prevKeys);
        for (const id of Object.keys(S.glossaries)) {
          keys.add("glossary:" + id);
          for (const s of Object.keys(S.glossaries[id].terms)) keys.add("gterms:" + id + ":" + bucketOf(s));
        }
        for (const [kind, field] of Object.entries(MAPS)) for (const id of Object.keys(S[field])) keys.add(kind + ":" + id);
        for (const kind of Object.keys(ONES)) keys.add(kind);
        for (const id of Object.keys(S.covers)) keys.add("cover:" + id);
        for (const n of S.notices) keys.add("notice:" + n.id);
        const out = await publish([...keys]);
        emit("change", { status: true });
        return { records: out.length };
      }),

      // (tests) the state as the API sees it
      _state: () => S
    };
    return lib;
  }

  // ---------- sharing ----------
  const aesKeyU = (raw) => cached("u" + raw, () => subtle.importKey("raw", unb64u(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
  async function hkdf(raw, info) {
    const k = await subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) }, k, 256));
  }
  const sha256hex = async (x) => hex(new Uint8Array(await subtle.digest("SHA-256", typeof x === "string" ? enc.encode(x) : x)));
  // From a library's read key: the catalog key, and the library room (where the catalog is read).
  async function shareKeys(libId, readKey) {
    const catalogKey = b64u(await hkdf(unb64u(readKey), "p2p-read catalog"));
    return { catalogKey, libRoom: await sha256hex("p2p-read:lib:v1:" + libId + ":" + (await sha256hex(unb64u(catalogKey)))) };
  }
  // A book's key, from the library's read key, and its room (where its chapters are read). From a book link the key is given, not made.
  const bookKeyOf = async (readKey, bookId) => b64u(await hkdf(unb64u(readKey), "p2p-read book:" + bookId));
  const bookRoomOf = async (libId, bookKey) => sha256hex("p2p-read:book:v1:" + libId + ":" + (await sha256hex(unb64u(bookKey))));

  // Links: "<site>#/f/<library id>/<read key>" (the whole library) or "<site>#/f/<library id>/b/<book id>/<book key>" (one novel).
  const B64U = /^[A-Za-z0-9_-]{40,50}$/;
  const libraryLink = (base, libId, readKey) => base.replace(/#.*$/, "") + "#/f/" + libId + "/" + readKey;
  // (a book link may end with the title as words, "/the-golden-elixir…", only to read: it is not part of what opens it)
  const slugOf = (title) => String(title || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  const bookLink = (base, libId, bookId, bookKey, title) => base.replace(/#.*$/, "") + "#/f/" + libId + "/b/" + encodeURIComponent(bookId).replace(/%3A/gi, ":") + "/" + bookKey + (slugOf(title) ? "/" + slugOf(title) : "");
  function parseLink(text) {
    const m = /#\/f\/([A-Za-z0-9_-]+)\/(?:b\/([^/]+)\/([A-Za-z0-9_-]+)(?:\/[a-z0-9-]*)?|([A-Za-z0-9_-]+))\s*$/.exec(String(text || "").trim());
    const key = m && (m[3] || m[4]);
    if (!m || !B64U.test(m[1]) || !B64U.test(key)) return null;
    let bookId = null;
    if (m[2]) {
      try { bookId = decodeURIComponent(m[2]); } catch (e) { return null; }
      if (!bookId || bookId.length > 300) return null;
    }
    return bookId ? { libId: m[1], bookId, bookKey: key } : { libId: m[1], readKey: key };
  }

  // What readers get. In the library room: devices, profile (both plain), head, entry:<book>, cover:<book> (the catalog key); in a book's room:
  // devices, profile, book:<book>, bhead:<book>, bcover:<book> (its cover, for a reader with only the book's link), terms:<book> (the owner's
  // terms for it, shown over its text), chapter:<source url> (that book's key).
  const PUBLISHED = { devices: "plain", profile: "plain", head: "catalog", entry: "catalog", cover: "catalog", book: "book", bhead: "book", bcover: "book", terms: "book", pr: "book", chapter: "book" };
  function publishedScope(key) {
    const [kind, id] = splitKey(key);
    const scope = PUBLISHED[kind];
    if (!scope) return null;
    if ((kind === "devices" || kind === "profile" || kind === "head") !== (id === "")) return null;
    return scope;
  }

  // A record from a share room, as a reader checks it: { lib, devices (the list, once known), keyOf(key) -> the AES key (base64url) it is
  // encrypted with, or null when this reader has none }. -> { body } (null: deleted) or { why }.
  async function readPublished(r, ctx) {
    if (!r || typeof r !== "object" || r.v !== V || r.lib !== ctx.lib || typeof r.key !== "string" || r.key.length > 600 || !validVer(r.ver)) return { why: "malformed" };
    if (r.body !== null && (typeof r.body !== "string" || r.body.length > MAX_RECORD * 1.4)) return { why: "too big" };
    const scope = publishedScope(r.key);
    if (!scope) return { why: "unknown kind" };
    if (r.key === "devices") {
      if (r.by !== "root" || typeof r.body !== "string") return { why: "malformed" };
      if (!(await verify(ctx.lib, signedPart(r), r.sig))) return { why: "bad signature" };
      try { return { body: JSON.parse(r.body) }; } catch (e) { return { why: "malformed" }; }
    }
    const dev = (ctx.devices || []).find((d) => d.id === r.by);
    if (!dev) return { why: "not a device of this library" };
    if (!(await verify(dev.pub, signedPart(r), r.sig))) return { why: "bad signature" };
    if (r.body === null) return { body: null };
    try {
      if (scope === "plain") return { body: JSON.parse(r.body) };
      const k = ctx.keyOf(r.key);
      if (!k) return { why: "no key" };
      return { body: JSON.parse(await unseal(await aesKeyU(k), r.iv, r.body)) };
    } catch (e) {
      return { why: "cannot be read" };
    }
  }

  // ---------- pull requests ----------
  // A pull request as it travels (everything but what it says is readable, so every device passing it on can check it):
  //   { v, t: "pr", id, to: <library id>, from: <the sender's library id>, by: <its device>, book, at, expires, epk, iv, ct (sealed: what it says),
  //     devices: <the sender's list of devices, signed with its root key>, sig: <by that device> }
  const PR_TTL = 30 * 24 * 3600 * 1000; // a pull request is passed on for at most 30 days
  const MAX_PR = 1024 * 1024; // what one says, sealed: 1 MB at most
  const prSigned = (e) => stable(Object.assign({}, e, { sig: undefined }));
  // Is this a pull request the library it is for takes, by what its profile says? policy: { prs: "anyone" | "approved" | "off", approved: [library
  // id], sealKey }. -> "" or why not.
  async function checkPr(e, { to, policy, now }) {
    if (!e || typeof e !== "object" || e.v !== V || e.t !== "pr" || typeof e.id !== "string" || !/^[0-9a-f]{16,32}$/.test(e.id)) return "malformed";
    if (e.to !== to || typeof e.from !== "string" || e.from === to || typeof e.book !== "string" || !e.book || e.book.length > 300) return "malformed";
    if (!Number.isFinite(e.at) || !Number.isFinite(e.expires) || e.expires > e.at + PR_TTL + 60000) return "malformed";
    if ((now || Date.now()) > e.expires) return "expired";
    if (typeof e.ct !== "string" || e.ct.length > MAX_PR * 1.4 || typeof e.iv !== "string" || typeof e.epk !== "string") return "too big";
    const p = policy || {};
    if (!p.sealKey || p.prs === "off") return "not taken";
    if (p.prs === "approved" && !(p.approved || []).includes(e.from)) return "not approved";
    const d = e.devices;
    if (!d || d.key !== "devices" || d.lib !== e.from || d.by !== "root" || typeof d.body !== "string" || !(await verify(e.from, signedPart(d), d.sig))) return "bad sender";
    let list = null;
    try { list = JSON.parse(d.body); } catch (err) { return "bad sender"; }
    const dev = Array.isArray(list) && list.find((x) => x && x.id === e.by);
    if (!dev || !(await verify(dev.pub, prSigned(e), e.sig))) return "bad signature";
    return "";
  }

  // What the sync room needs of a library (p2p-core.js opts.library). A device asks to join only once its user has asked (lib.joinRequest()
  // from the page or the popup), never by itself.
  function roomLink(lib) {
    return {
      lib: () => lib.status().libId,
      versions: () => lib.versions(),
      wants: (k, v) => lib.wants(k, v),
      wantsMany: (rows) => (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && lib.wants(r[0], r[1])), // ([[key, ver]] -> the rows worth asking for)
      get: (k) => lib.get(k),
      receive: (r) => lib.receive(r),
      joinAsked: (m) => lib.joinAsked(m),
      receiveKeys: (m) => lib.receiveKeys(m),
      peerProof: (data) => lib.peerProof(data),
      peerCheck: (id, data, sig) => lib.peerCheck(id, data, sig),
      joinRequest: () => {
        const st = lib.status();
        return st.state === "joining" && !st.libId ? lib.joinRequest() : null;
      }
    };
  }

  // Its calls, and what each answers where there is no library to ask.
  const ROOM_CALLS = Object.freeze({ lib: "", versions: Object.freeze([]), wants: false, wantsMany: Object.freeze([]), get: null, receive: Object.freeze({ stored: false, why: "not in a library" }), joinAsked: false, receiveKeys: false, joinRequest: null, peerProof: null, peerCheck: false });

  // The same, for a library still being opened (a promise of it, or of null where the browser cannot make its keys): the room can be made at once.
  function lazyRoomLink(ready) {
    const out = {};
    for (const name of Object.keys(ROOM_CALLS)) {
      out[name] = async (...a) => {
        const lib = await ready;
        if (lib) return roomLink(lib)[name](...a);
        return ROOM_CALLS[name];
      };
    }
    return out;
  }

  // A short code to tell libraries apart by eye ("4F2A-91C0"): the start of a hash of the library's id would do, but its own first letters are
  // as good and need no hashing.
  function codeOf(libId) {
    const h = hex(unb64u(libId)).toUpperCase();
    return h.slice(0, 4) + "-" + h.slice(4, 8);
  }

  const Library = {
    open, supported, roomLink, lazyRoomLink, ROOM_CALLS, memoryAdapter, idbAdapter, isPrivate, bucketOf, codeOf, cmpVer, stable, BUCKETS,
    shareKeys, bookKeyOf, bookRoomOf, libraryLink, bookLink, parseLink, readPublished, publishedScope, checkPr, PR_TTL, MAX_PR
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Library;
  else root.Library = Library;
})(typeof self !== "undefined" ? self : this);
