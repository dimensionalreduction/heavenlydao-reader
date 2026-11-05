// Your library, kept in your browser: by the extension, and by the library site's page beside it.
//
// The library is library-api.js's state (it answers the /api/... calls from it), split into records: one
// per glossary's details, per part of a glossary's terms, per novel, cover, chapter list, note, term of yours... The site's page and the
// extension each keep a copy and pass records to each other over the link between them (p2p-core.js), so both hold the same library. There is
// one library in a browser: a copy that comes to the link with records of its own (the page used before the extension was installed) adds them.
//
// A record:
//   { v: 2, key, ver: [ms, counter, copy], body }
//   body: the JSON of what the record holds; null is a deletion. The newest `ver` of a key wins, except the parts of a glossary's terms,
//   which are merged term by term (a term's updatedAt decides).
//
// Library.open({ adapter }) -> library; the adapter keeps it: memoryAdapter() (tests) or idbAdapter(name) (the extension, the site).
//
// (Until 2026-11 a library had an id and keys: its records were encrypted and signed, and the extension joined the page's library to read
// them. A library kept that way is read once with its keys and written again as plain records: migrate.)
//
(function (root) {
  "use strict";
  const LibraryApi = root.LibraryApi || (typeof require === "function" ? require("./library-api.js") : null);
  const webcrypto = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : require("node:crypto").webcrypto;
  const subtle = webcrypto.subtle;
  const dec = new TextDecoder();

  const V = 2;
  const MAX_RECORD = 2 * 1024 * 1024; // the body of one record, as sent (a chapter list of 6,700 chapters is 1.2 MB)
  const BUCKETS = 16; // a glossary's terms are kept in this many records, so changing one term rewrites a sixteenth of it
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
  const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  const newId = () => hex(webcrypto.getRandomValues(new Uint8Array(8)));

  // Canonical JSON (sorted keys): two copies of a glossary's part compare equal when they hold the same.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  }

  // ---------- versions ----------
  // A hybrid logical clock: [ms, counter, copy]. Later than every version this copy has made or seen, and comparable between the two copies.
  const cmpVer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  const validVer = (v) => Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && v[0] > 0 && Number.isInteger(v[1]) && v[1] >= 0 && typeof v[2] === "string" && v[2].length <= 40;

  // ---------- what the state is made of ----------
  // A glossary term's part: the same for a source word in both copies.
  function bucketOf(source) {
    let h = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) { h ^= source.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) % BUCKETS;
  }

  // The kinds of records, each a part of the state. `one`: a single record; `map`: one record per id in S[field].
  const MAPS = {
    binding: "bindings", novel: "novels", chapters: "chapterIndex", term: "myTerms", note: "termNotes", "comment-link": "commentLinks",
    rating: "myRatings", watch: "watches"
  };
  const ONES = { "novel-links": "novelLinks", settings: "settings", "wtr-library": "wtrLibrary", "comment-identity": "commentIdentity" };
  const CHANGE_TO_PREFIX = { binding: "binding", novel: "novel", chapterIndex: "chapters", myTerm: "term", note: "note", commentLink: "comment-link", rating: "rating", watch: "watch" };
  const CHANGE_TO_ONE = { novelLinks: "novel-links", settings: "settings", wtrLibrary: "wtr-library", commentIdentity: "comment-identity" };

  const splitKey = (key) => {
    const i = key.indexOf(":");
    return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
  };
  // Is this the key of a part of the state? (gterms:<glossary id>:<0 to 15>, novel:<id>, settings...)
  function knownKey(key) {
    const [kind, id] = splitKey(key);
    if (kind === "gterms") return /^.+:(\d|1[0-5])$/.test(id);
    if (kind === "glossary" || kind === "cover" || kind === "notice" || MAPS[kind]) return id.length > 0;
    return !!ONES[kind] && id === "";
  }

  // ---------- adapters ----------
  function memoryAdapter() {
    const records = new Map();
    let meta = null;
    return {
      async load() { return { meta, records: [...records.values()] }; },
      async putRecords(list) { for (const r of list) records.set(r.key, r); },
      async deleteRecords(keys) { for (const k of keys) records.delete(k); },
      async getRecord(key) { return records.get(key) || null; },
      async setMeta(m) { meta = JSON.parse(JSON.stringify(m)); },
      async clear() { records.clear(); meta = null; }
    };
  }

  // IndexedDB: "records" by key, "meta" holds this copy's id and clock.
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
      deleteRecords: (keys) => tx(["records"], "readwrite", (t) => { const st = t.objectStore("records"); for (const k of keys) st.delete(k); }),
      getRecord: (key) => tx(["records"], "readonly", (t) => t.objectStore("records").get(key)).then((r) => r || null),
      setMeta: (m) => tx(["meta"], "readwrite", (t) => t.objectStore("meta").put(m, "meta")),
      clear: () => tx(["records", "meta"], "readwrite", (t) => { t.objectStore("records").clear(); t.objectStore("meta").clear(); })
    };
  }

  // ---------- a library kept before 2026-11 ----------
  // Its records are read with the keys this copy had (the owner key of each generation) and written again as plain ones, with their versions,
  // so the page's copy and the extension's, which held the same library, still agree. What cannot be read (a copy that asked to join and was
  // never let in) and the records of devices, keys and sharing go.
  async function migrate(saved, adapter) {
    const old = saved.meta;
    const keys = old.keys || (old.ownerKey ? { 0: old.ownerKey } : {});
    const aes = {};
    const keyOf = (gen) => aes[gen] || (aes[gen] = subtle.importKey("raw", unb64(keys[gen]), { name: "AES-GCM" }, false, ["decrypt"]));
    const kept = [];
    const gone = [];
    for (const r of saved.records) {
      if (r && r.v === V) { kept.push(r); continue; } // (written again already: a migration stopped part way)
      if (r && typeof r.key === "string") gone.push(r.key);
      if (!old.libId || !r || typeof r.key !== "string" || !knownKey(r.key) || !validVer(r.ver)) continue;
      let body = null;
      if (r.body !== null) {
        if (!keys[r.kg || 0] || typeof r.iv !== "string" || typeof r.body !== "string") continue;
        try {
          body = dec.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv) }, await keyOf(r.kg || 0), unb64(r.body)));
        } catch (e) {
          continue;
        }
      }
      kept.push({ v: V, key: r.key, ver: r.ver, body });
    }
    const meta = { id: (old.device && old.device.id) || newId(), hlc: Array.isArray(old.hlc) ? old.hlc : [0, 0] };
    const keptKeys = new Set(kept.map((r) => r.key));
    await adapter.putRecords(kept);
    await adapter.deleteRecords(gone.filter((k) => !keptKeys.has(k)));
    await adapter.setMeta(meta);
    return { meta, records: kept };
  }

  // ---------- the library ----------
  async function open({ adapter }) {
    let saved = await adapter.load();
    if (saved.meta && !saved.meta.id) saved = await migrate(saved, adapter);
    let meta = saved.meta;
    if (!meta) {
      meta = { id: newId(), hlc: [0, 0] }; // this copy's id: the last part of the versions it makes
      await adapter.setMeta(meta);
    }

    const records = new Map(); // key -> the record as it travels
    let S = LibraryApi.normalizeState({});
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
      if (isLazy(r.key) && r.body !== null) records.set(r.key, { v: r.v, key: r.key, ver: r.ver, body: "", lazy: true });
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
        const body = bodyOfRecord(r);
        if (!body || typeof body.data !== "string") return null;
        const bytes = unb64(body.data);
        keepCover(id, bytes);
        return bytes;
      } catch (e) {
        return null;
      }
    }
    const listeners = { records: new Set(), change: new Set() };
    let changes = 0; // (how many changes so far: what is made from the library can be kept until the next)
    const emit = (what, x) => { if (what === "change") changes++; for (const fn of listeners[what]) { try { fn(x); } catch (e) { /* a listener's own trouble */ } } };

    // ----- the clock -----
    function tick() {
      const ms = Math.max(Date.now(), meta.hlc[0]);
      meta.hlc = [ms, ms === meta.hlc[0] ? meta.hlc[1] + 1 : 0];
      return [meta.hlc[0], meta.hlc[1], meta.id];
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

    // Merges an arriving part of a glossary's terms with this copy's: per term, the later change wins (a deleted term stays deleted until
    // changed again), so the page and the extension changing different terms both keep what they did. Changed in the same millisecond, the
    // arriving one wins: its record is the later one.
    function mergeTerms(mine, theirs) {
      const out = {};
      const later = (a, b) => {
        if (!a) return b;
        if (!b) return a;
        return (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
      };
      for (const s of new Set([...Object.keys(mine), ...Object.keys(theirs)])) out[s] = later(mine[s], theirs[s]);
      return out;
    }

    // ----- making and checking records -----
    const makeRecord = (key, body) => ({ v: V, key, ver: tick(), body: body === null ? null : JSON.stringify(body) });
    // What a record holds (null: deleted). Throws when it is not JSON.
    const bodyOfRecord = (r) => (r.body === null ? null : JSON.parse(r.body));

    // Is this a record of the library this copy can keep? (Not yet: whether it is newer.)
    function check(r) {
      if (!r || typeof r !== "object" || r.v !== V || typeof r.key !== "string" || r.key.length > 600 || !validVer(r.ver)) return "malformed";
      if (r.body !== null && (typeof r.body !== "string" || r.body.length > MAX_RECORD * 1.4)) return "too big";
      return knownKey(r.key) ? "" : "unknown kind";
    }

    // ----- loading -----
    {
      // (each part of a glossary goes in after the glossary itself, so its details are there)
      const all = saved.records.slice().sort((a, b) => (a.key.startsWith("gterms:") ? 1 : 0) - (b.key.startsWith("gterms:") ? 1 : 0));
      for (const r of all) {
        if (check(r)) continue;
        try {
          applyBody(r.key, bodyOfRecord(r));
          keep(r);
        } catch (e) {
          /* (a record that cannot be read: the other copy is asked for it again) */
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
        out.push(makeRecord(key, body));
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

      // One /api/... call, answered from the library (library-api.js). What it changes is written as records and
      // handed to the "records" listeners, to be sent to the other copy.
      api: (method, path, body) => serial(async () => {
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

      // A record from the other copy. Kept when it is a record of the library and newer than the one kept; a part of a glossary that this
      // copy has newer terms for is merged and written again (returned in `out`, to be sent back).
      receive: (r) => serial(async () => {
        const why = check(r);
        if (why) return { stored: false, why };
        const cur = records.get(r.key);
        if (cur && cmpVer(cur.ver, r.ver) >= 0) return { stored: false, why: "not newer" };
        let body;
        try {
          body = bodyOfRecord(r);
        } catch (e) {
          return { stored: false, why: "cannot be read" };
        }
        seen(r.ver);
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

      changeCount: () => changes,
      // The glossary of a novel known by these keys (the extension's in-page translation reads it): the glossaries bound to it (a key that is a glossary's own id counts) and
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
      // a cover's picture: { type, bytes, at } or null (read from its record when not kept: covers are not all held in memory)
      cover: async (id) => {
        const m = S.covers[id];
        const bytes = m ? await coverBytesOf(id) : null;
        return m && bytes ? { type: m.type, bytes, at: m.at } : null;
      },

      // [[key, ver], ...] of every record kept: what the other copy compares with its own.
      versions: () => [...records.values()].map((r) => [r.key, r.ver]),
      // (a cover's whole record is read from the adapter: a promise then)
      get: (key) => { const r = records.get(key); return r && r.lazy ? adapter.getRecord(key) : r || null; },
      // Is a record of this version newer than the one kept (so worth asking for)?
      wants: (key, ver) => { const cur = records.get(key); return !cur || cmpVer(cur.ver, ver) < 0; },

      // A whole state (library-api.js's, as a glossary server once exported it) and its covers ({ id: bytes }), as this library's content, written as records.
      importState: (raw, covers) => serial(async () => {
        const prevKeys = [...records.keys()];
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

  // What the link between the site's page and the extension needs of a library (p2p-core.js opts.library).
  function roomLink(lib) {
    return {
      versions: () => lib.versions(),
      wants: (k, v) => lib.wants(k, v),
      wantsMany: (rows) => (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && lib.wants(r[0], r[1])), // ([[key, ver]] -> the rows worth asking for)
      get: (k) => lib.get(k),
      receive: (r) => lib.receive(r)
    };
  }

  // Its calls, and what each answers where there is no library to ask.
  const ROOM_CALLS = Object.freeze({ versions: Object.freeze([]), wants: false, wantsMany: Object.freeze([]), get: null, receive: Object.freeze({ stored: false, why: "no library" }) });

  // The same, for a library still being opened (a promise of it, or of null where it could not be opened): the link can be made at once.
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

  const Library = {
    open, roomLink, lazyRoomLink, ROOM_CALLS, memoryAdapter, idbAdapter, bucketOf, cmpVer, stable, BUCKETS
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Library;
  else root.Library = Library;
})(typeof self !== "undefined" ? self : this);
