// The sync core: a small index of the translated chapters (chapter key -> version) that the library site's tab and the extension in the same
// browser exchange over a link between them (site-bridge.js: no network), and the chapters themselves sent over the same link.
// (Until 2026-10 it also linked your other devices and readers over WebRTC, through WebTorrent trackers: that is on the branch characters.)
//
// The core is storage-agnostic: the host passes an adapter, so the same code runs in the browser extension (storage.local) and on the
// library site (IndexedDB).
//
// adapter = {
//   getConfig(): Promise<{ fetch? }>,   fetch: "all" (every chapter in the index is fetched, the default) or "open" (only the chapters asked
//     for with request(), and newer versions of the ones this side holds: a phone with a big library)
//   getIndex(): Promise<object>, setIndex(index): Promise<void>, putIndex?(changes: { key: entry | null }): Promise<void> (when there, only
//   the entries that changed are saved, not the whole index: bucketedIndex makes one over a key-value storage),
//   getTranslation(key): Promise<entry|undefined>,
//   setTranslation(key, entry): Promise<void>,
//   listTranslations(): Promise<[key, { savedAt, translated: boolean }][]>   (light rows, no text)
// }
//
// The links: addLocalPeer(link, { trusted }) -> { receive(msg), refresh(), close() }. The host gives a link { send(obj) } and passes what
// comes back to receive(msg). trusted: a boolean, or a function asked each time; refresh() after it may have changed. Nothing of the chapters
// goes to a link before it is trusted, and nothing of that kind it sends is taken or answered. (The extension links only the site's own tabs,
// and the page only the extension in its browser: both trust the link.)
//
// The library (library.js): when opts.library is given, the two ends of a link also swap its records: each says which records it has ("lv",
// with their versions), asks for the newer ones ("lq"), sends them in pieces ("lr") and tells the other when it has new ones ("lh"). Every
// record is checked by the library itself; this only carries them.
//   opts.library = {
//     versions(): [[key, ver]],  wants(key, ver): bool,  wantsMany?(rows): the rows of [[key, ver]] wanted,  get(key): record | null,
//     receive(record): { stored, why?, out?: [records written again] }
//   }   (each may answer with a promise)
(function (root) {
  const MAX_MSG_BYTES = 12000; // (the versions said in one message)
  const MAX_CHAPTER_BYTES = 2 * 1024 * 1024;
  const RETRY_INTERVAL_MS = 2 * 60 * 1000;
  const KEY_PREFIX = "translation:";
  // A chapter in another language than English is its own entry beside the chapter's, "<chapter key>#lang=<code>" (the chapter key itself holds the English one):
  // versions of the same chapter, which the library lists as one. The language is in the key, so nothing else says it.
  const LANG_KEY = /#lang=([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/;
  const langOf = (key) => { const m = LANG_KEY.exec(String(key || "")); return m ? m[1] : ""; }; // "es", or "" for the chapter's own
  const baseKeyOf = (key) => String(key || "").replace(LANG_KEY, "");
  const langKey = (key, lang) => baseKeyOf(key) + (lang && lang !== "en" ? "#lang=" + lang : "");
  // What this build of the sync protocol can do. Bumped when the ends gain a message the other must understand, so one can tell what the
  // other is: 2 = direct sending ("get"/"blob"), 3 = original texts and translating on request ("raw"/"rs"), 4 = looking up a next-chapter link,
  // 5 = redoing a chapter, 6 = the ends carry an id, 7 = the library's records ("lv" / "lq" / "lr" / "lh"), 8 to 11 = what the network had
  // (reading a library without joining it, proofs between devices, pictures as torrents), 12 = no network: the link in this browser only,
  // 13 = one library in a browser: its records carry no library id
  const PROTOCOL = 13;
  const MEMBER_ONLY = new Set(["ent", "raw", "rs", "rawfail", "rawstop"]);
  const CHAPTER_TALK = new Set(["ver", "need", "get", "blob"]);
  // A chapter is sent over the link in pieces small enough for one message each.
  const DIRECT_CHUNK = 8000; // raw bytes per message
  const DIRECT_REASK_MS = 5000;
  // A version of a chapter the other end does not answer for (it holds an older copy) is asked for again less and less often: after
  // DIRECT_REASK_MS, then REASK_BACKOFF_MS, twice as long each time up to REASK_MAX_MS. A link connecting, a newer version, or a person
  // opening the chapter (request) asks at once.
  const REASK_BACKOFF_MS = 2 * 60 * 1000;
  const REASK_MAX_MS = 60 * 60 * 1000;
  const reaskAfter = (n) => (n < 2 ? DIRECT_REASK_MS : Math.min(REASK_BACKOFF_MS * 2 ** (n - 2), REASK_MAX_MS));
  const MAX_ASSEMBLIES = 30;
  const MAX_RECORD_BYTES = 4 * 1024 * 1024; // one library record as sent (its body is at most 2 MB: library.js)

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function toB64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromB64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Canonical JSON (sorted keys) so the same entry always serializes to the same bytes, which makes the
  // same chapter always hash to the same id (its index entry's "infohash") — after a restart too.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
      return (
        "{" +
        Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(v);
  }

  // Only translated chapters are synced this way. Glossaries and the rest of the library pass as library records (library.js).
  //   translation:<url>   { translated, suggestions, savedAt, model, pageTitle, novelName }   (`savedAt`: newest wins)
  function kindOf(key) {
    if (typeof key !== "string" || key.length >= 2048) return null;
    return key.startsWith(KEY_PREFIX + "http") ? "translation" : null;
  }

  // Returns a clean copy of a chapter entry, or null if the key isn't a chapter.
  function sanitize(key, e) {
    if (!kindOf(key) || !e || typeof e !== "object") return null;
    return {
      translated: String(e.translated || ""),
      suggestions: Array.isArray(e.suggestions) ? e.suggestions : [],
      savedAt: Number(e.savedAt) || 0,
      model: e.model || null,
      pageTitle: e.pageTitle ? String(e.pageTitle) : "",
      novelName: e.novelName ? String(e.novelName) : "",
      // where the next chapter is on the source site (https only), so a reader can go on past the chapters it knows about
      next: typeof e.next === "string" && /^https:\/\//.test(e.next) && e.next.length <= 500 ? e.next : undefined
    };
  }

  const hasContent = (key, e) => !!(sanitize(key, e) || {}).translated;

  // What the index shows for a chapter.
  const describe = (key, clean) => ({ novelName: clean.novelName, pageTitle: clean.pageTitle, model: clean.model });

  // The index over a key-value storage (chrome.storage.local, browser.storage.local): kept in INDEX_BUCKETS parts ("<base>:<n>", by a hash of
  // the chapter key), so a change rewrites its part and not the whole index; an index kept whole under "<base>" (before this) is moved into
  // them the first time it is read. get(names) -> { name: value }, set({ name: value }), remove(name). -> { getIndex, setIndex, putIndex }
  const INDEX_BUCKETS = 64;
  function bucketedIndex({ get, set, remove, base }) {
    const partOf = (k) => { let h = 0x811c9dc5; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) % INDEX_BUCKETS; };
    const names = Array.from({ length: INDEX_BUCKETS }, (_, i) => base + ":" + i);
    let chain = Promise.resolve(); // (one change at a time: each reads its parts, then writes them)
    const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    const split = (index) => {
      const out = {};
      for (const n of names) out[n] = {};
      for (const [k, v] of Object.entries(index || {})) out[names[partOf(k)]][k] = v;
      return out;
    };
    return {
      getIndex: () => serial(async () => {
        const got = (await get(names.concat(base))) || {};
        if (got[base] && typeof got[base] === "object") {
          await set(split(got[base]));
          await remove(base);
          return got[base];
        }
        return Object.assign({}, ...names.map((n) => got[n] || {}));
      }),
      setIndex: (index) => serial(() => set(split(index))),
      putIndex: (changes) => serial(async () => {
        const touched = [...new Set(Object.keys(changes).map((k) => names[partOf(k)]))];
        if (!touched.length) return;
        const got = (await get(touched)) || {};
        const out = {};
        for (const n of touched) out[n] = Object.assign({}, got[n] || {});
        for (const [k, v] of Object.entries(changes)) { const part = out[names[partOf(k)]]; if (v) part[k] = v; else delete part[k]; }
        await set(out);
      })
    };
  }

  function createP2P(opts) {
    const { adapter } = opts;
    const log = opts.log || (() => {});
    // skip(key): a chapter this side ignores (a novel deleted from it): not asked for, not taken from the other end, not offered again
    const skip = typeof opts.skip === "function" ? opts.skip : () => false;
    const onChange = opts.onChange || (() => {});

    let cfg = null;
    let index = {};
    const peers = new Set();
    // A random name for this running copy of the core, told to the other end (in "hi").
    const ownId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    const locals = new Set(); // the links (see addLocalPeer): kept across restarts

    const trustedNow = (p) => !!(typeof p.trusted === "function" ? p.trusted() : p.trusted);
    // The ones the host trusts: the only ones chapters go to and come from.
    const memberPeers = () => [...peers].filter((p) => p.ready && trustedNow(p));
    let retryTimer = null;
    let persistTimer = null;
    let stopped = true;
    const stats = { fetched: 0, published: 0, errors: 0, direct: 0 };
    const directAsked = new Map(); // chapter key -> when the direct transfer was last asked for
    const unanswered = new Map(); // chapter key -> { n, at, ver }: asks for that version nobody answered yet (reaskAfter)
    const assemblies = new Map(); // chapter key -> pieces received so far
    const transfers = new Map(); // chapter key -> { direct: { since } }: what the activity view shows
    const lib = opts.library || null;
    const recAsked = new Map(); // library record key -> { at, ver }: when it was asked for, and which version
    const recHeard = new Map(); // library record key -> { ver, peer }: the newest version the other end said it has (asked for again if what came is older)
    const recAssemblies = new Map(); // library record key -> pieces received so far
    let onDemand = false; // cfg.fetch === "open": only what is asked for
    const wanted = new Set(); // (on demand) chapters asked for and not here yet
    const rawAsks = new Map(); // chapters asked of the extension (requestRaw) and not said done yet -> whether the original text alone was asked for
    let retrySoon = null;

    // ---------- helpers ----------
    function encodeChapter(key, entry) {
      return enc.encode(stable({ v: 1, key, entry: sanitize(key, entry) }));
    }

    // The index is saved shortly after it changes: the entries that changed (adapter.putIndex), else the whole of it.
    const dirty = new Set();
    function schedulePersist(keys) {
      for (const k of keys || []) dirty.add(k);
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistIndex, 300);
    }
    function persistIndex() {
      if (adapter.putIndex) {
        if (!dirty.size) return;
        const changes = {};
        for (const k of dirty) changes[k] = index[k] || null;
        dirty.clear();
        adapter.putIndex(changes).catch((e) => log("index not saved", e));
      } else {
        dirty.clear();
        adapter.setIndex(index).catch(() => {});
      }
    }

    function validKey(key) {
      return kindOf(key) !== null;
    }

    // A chapter's id in the index: the first 40 hex digits of its bytes' SHA-256. It is still called "infohash", and kept at 40 hex digits,
    // because it was a torrent's infohash once and the ends from then accept an index entry only in that form.
    async function chapterId(bytes) {
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(buf).subarray(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function validMeta(m) {
      return (
        m &&
        validKey(m.key) &&
        typeof m.infohash === "string" &&
        /^[0-9a-f]{40}$/.test(m.infohash) &&
        Number.isFinite(m.savedAt) &&
        m.savedAt > 0
      );
    }

    function metaOf(key) {
      return Object.assign({ key }, index[key]);
    }

    // Splits `items` into messages that each serialize to <= MAX_MSG_BYTES.
    function sendChunked(peer, makeMsg, items, fits) {
      let batch = [];
      let size = 0;
      const flush = (last) => {
        peer.send(makeMsg(batch, last));
        batch = [];
        size = 0;
      };
      for (const it of items) {
        const itSize = fits(it);
        if (batch.length && size + itSize > MAX_MSG_BYTES) flush(false);
        batch.push(it);
        size += itSize;
      }
      flush(true);
    }

    function sendVersions(peer) {
      const rows = Object.keys(index).map((k) => [k, index[k].savedAt]);
      sendChunked(peer, (b, last) => ({ t: "ver", v: b, last }), rows, (r) => r[0].length + 24);
    }

    function sendEntries(peer, keys) {
      const metas = keys.filter((k) => index[k]).map(metaOf);
      if (!metas.length) return;
      sendChunked(peer, (b) => ({ t: "ent", e: b }), metas, (m) => JSON.stringify(m).length + 2);
    }

    function broadcastEntries(keys, exceptPeer) {
      for (const p of memberPeers()) {
        if (p !== exceptPeer) sendEntries(p, keys);
      }
    }

    // ---------- the links ----------
    function attachLocal(l) {
      l.peer = { ready: true, local: true, trusted: l.trusted, remoteVersions: {}, info: undefined, send: (obj) => { try { l.link.send(obj); } catch (e) { /* the link just closed */ } } };
      peers.add(l.peer);
      onPeerReady(l.peer);
    }
    // After the host's trust may have changed: once trusted, what this side holds is said to it.
    function refreshLocal(l) {
      const p = l.peer;
      if (!p || stopped) return;
      const now = trustedNow(p);
      if (now && !p.toldTrusted) { sendVersions(p); retryMissing(); }
      p.toldTrusted = now;
    }

    function addLocalPeer(link, { trusted = false } = {}) {
      const l = { link, trusted: typeof trusted === "function" ? trusted : !!trusted, peer: null };
      locals.add(l);
      if (!stopped) attachLocal(l);
      return {
        receive: (msg) => { if (l.peer && msg && typeof msg === "object") onPeerMessage(l.peer, msg).catch((e) => log("local peer message error", e)); },
        refresh: () => refreshLocal(l),
        close: () => { locals.delete(l); if (l.peer) peers.delete(l.peer); l.peer = null; }
      };
    }

    function onPeerReady(peer) {
      unanswered.clear(); // (the other end came: it may have what nobody had)
      // (b: which build of its role this is, when it says: the site tells an extension too old for what it is asked, opts.build)
      peer.send({ t: "hi", r: String(opts.role || "device").slice(0, 20), v: PROTOCOL, i: ownId, b: Math.max(0, Math.floor(Number(opts.build) || 0)) });
      refreshLocal({ peer }); // trusted: what this side holds is said now
      retryMissing();
      if (lib) sendRecordVersions(peer).catch((e) => log("library versions failed", e));
    }

    // ---------- the library's records ----------
    async function sendRecordVersions(peer) {
      const rows = (await lib.versions()).map(([k, v]) => [k, v]);
      sendChunked(peer, (b, last) => ({ t: "lv", v: b, last }), rows, (r) => r[0].length + 40);
    }

    const verAfter = (a, b) => JSON.stringify(a) !== JSON.stringify(b) && (a[0] - b[0] || a[1] - b[1] || (a[2] > b[2] ? 1 : -1)) > 0;
    // rows: [[key, ver]] this peer has and this side wants
    async function askRecords(peer, rows) {
      const fresh = [];
      const now = Date.now();
      for (const [k, v] of rows) {
        const heard = recHeard.get(k);
        if (!heard || verAfter(v, heard.ver)) recHeard.set(k, { ver: v, peer });
        const asked = recAsked.get(k);
        if (asked && now - asked.at < DIRECT_REASK_MS * 4 && !verAfter(v, asked.ver)) continue; // this version (or a later one) is on its way
        recAsked.set(k, { at: now, ver: v });
        fresh.push(k);
      }
      for (let i = 0; i < fresh.length; i += 300) peer.send({ t: "lq", k: fresh.slice(i, i + 300) });
    }

    // What the other end asked for goes out one record at a time, so asking for the whole library does not stop everything else.
    function queueRecords(peer, keys) {
      peer.recQueue = peer.recQueue || [];
      for (const k of keys) if (!peer.recQueue.includes(k)) peer.recQueue.push(k);
      if (peer.recSending) return;
      peer.recSending = true;
      (async () => {
        while (peer.recQueue.length && !stopped && peers.has(peer)) {
          const r = await lib.get(peer.recQueue.shift());
          if (!r) continue;
          const bytes = enc.encode(JSON.stringify(r));
          if (bytes.length > MAX_RECORD_BYTES) continue;
          const n = Math.ceil(bytes.length / DIRECT_CHUNK);
          const s = JSON.stringify(r.ver);
          for (let i = 0; i < n; i++) peer.send({ t: "lr", k: r.key, s, i, n, d: toB64(bytes.subarray(i * DIRECT_CHUNK, (i + 1) * DIRECT_CHUNK)) });
          await new Promise((res) => setTimeout(res, 0));
        }
      })().catch((e) => log("sending records failed", e)).finally(() => { peer.recSending = false; });
    }

    async function receiveRecordPiece(peer, msg) {
      const key = msg.k;
      if (!recAsked.has(key)) return; // only what was asked for
      const maxPieces = Math.ceil(MAX_RECORD_BYTES / DIRECT_CHUNK);
      if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > maxPieces || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string") return;
      let a = recAssemblies.get(key);
      if (!a || a.id !== msg.s || a.n !== msg.n) {
        if (recAssemblies.size >= MAX_ASSEMBLIES) recAssemblies.delete(recAssemblies.keys().next().value);
        a = { id: msg.s, n: msg.n, parts: new Array(msg.n), got: 0 };
        recAssemblies.set(key, a);
      }
      if (a.parts[msg.i]) return;
      // (a library record is not a chapter: it is not counted as downloading, so nothing is left there that no entry of the log follows)
      let piece;
      try {
        piece = fromB64(msg.d);
      } catch (e) {
        return;
      }
      if (piece.length > DIRECT_CHUNK) return;
      a.parts[msg.i] = piece;
      if (++a.got < a.n) return;
      recAssemblies.delete(key);
      recAsked.delete(key);
      const bytes = new Uint8Array(a.parts.reduce((sum, x) => sum + x.length, 0));
      let at = 0;
      for (const x of a.parts) {
        bytes.set(x, at);
        at += x.length;
      }
      let record;
      try {
        record = JSON.parse(dec.decode(bytes));
      } catch (e) {
        return;
      }
      if (!record || record.key !== key) return;
      const res = (await lib.receive(record)) || {};
      // a later version was said to be there while this one was on its way: that one is asked for now
      const heard = recHeard.get(key);
      if (heard && Array.isArray(record.ver) && verAfter(heard.ver, record.ver) && peers.has(heard.peer)) askRecords(heard.peer, [[key, heard.ver]]);
      else recHeard.delete(key);
      if (!res.stored) return;
      stats.records = (stats.records || 0) + 1;
      const told = [[record.key, record.ver]].concat((res.out || []).map((r) => [r.key, r.ver]));
      for (const p of peers) if (p !== peer && p.ready) p.send({ t: "lh", v: told }); // passed on
      if (res.out && res.out.length) peer.send({ t: "lh", v: res.out.map((r) => [r.key, r.ver]) }); // (merged: the sender wants it too)
      onChange({ type: "record", key });
    }

    // Records this side wrote (from the library's API): the other ends are told, and ask for them.
    async function announceRecords(records) {
      if (!lib || stopped || !records.length) return;
      const v = records.map((r) => [r.key, r.ver]);
      for (const p of peers) if (p.ready) p.send({ t: "lh", v });
    }

    // Now and then: every other end is asked for what it has.
    function syncLibrary() {
      if (!lib || stopped) return;
      for (const p of peers) {
        if (!p.ready) continue;
        p.send({ t: "lvq" });
        sendRecordVersions(p).catch(() => {});
      }
    }

    // What this side lacks of what the other end holds (asked for) and what that end lacks of this one's (sent), by the versions it told.
    function compareVersions(peer) {
      const need = [];
      const give = [];
      for (const k of Object.keys(peer.remoteVersions)) {
        if (skip(k)) continue;
        if (!index[k] || index[k].savedAt < peer.remoteVersions[k]) need.push(k);
      }
      for (const k of Object.keys(index)) {
        if (!(k in peer.remoteVersions) || peer.remoteVersions[k] < index[k].savedAt) give.push(k);
      }
      if (need.length) peer.send({ t: "need", k: need.slice(0, 500) });
      if (give.length) sendEntries(peer, give);
    }
    // Compared again with every other end, from the versions they told: after chapters this side ignored are taken again.
    function resync() {
      if (stopped) return;
      for (const p of peers) if (p.ready) compareVersions(p);
    }

    async function onPeerMessage(peer, msg) {
      if (!msg || typeof msg !== "object") return;
      if ((MEMBER_ONLY.has(msg.t) || CHAPTER_TALK.has(msg.t)) && !trustedNow(peer)) return; // (not trusted yet: nothing of the chapters)
      if (msg.t === "ver" && Array.isArray(msg.v)) {
        for (const row of msg.v) {
          if (Array.isArray(row) && validKey(row[0]) && Number.isFinite(row[1])) peer.remoteVersions[row[0]] = row[1];
        }
        if (msg.last) compareVersions(peer);
      } else if (msg.t === "need" && Array.isArray(msg.k)) {
        sendEntries(peer, msg.k.filter(validKey).slice(0, 500));
      } else if (msg.t === "ent" && Array.isArray(msg.e)) {
        const changed = [];
        for (const m of msg.e) {
          if (!validMeta(m) || skip(m.key)) continue;
          const local = index[m.key];
          if (local && local.savedAt >= m.savedAt) continue;
          index[m.key] = {
            infohash: m.infohash,
            savedAt: m.savedAt,
            novelName: m.novelName ? String(m.novelName) : "",
            pageTitle: m.pageTitle ? String(m.pageTitle) : "",
            model: m.model || null,
            size: Number(m.size) || 0
          };
          changed.push(m.key);
          if (!onDemand || wanted.has(m.key)) enqueueFetch(m.key);
        }
        if (changed.length) {
          // on demand: a newer version of a chapter this side holds is fetched too (looked up all at once, shortly)
          if (onDemand) { clearTimeout(retrySoon); retrySoon = setTimeout(retryMissing, 2000); }
          schedulePersist(changed);
          broadcastEntries(changed, peer); // (to the other links: the extension's other tabs of the site)
          onChange({ type: "index", keys: changed });
        }
      } else if (msg.t === "hi") {
        peer.info = { role: String(msg.r || "device").slice(0, 20), v: Math.max(0, Math.floor(Number(msg.v) || 0)), id: String(msg.i || "").slice(0, 40), b: Math.max(0, Math.floor(Number(msg.b) || 0)) };
      } else if (msg.t === "get" && validKey(msg.k)) {
        await sendDirect(peer, msg.k);
      } else if (msg.t === "blob" && validKey(msg.k)) {
        await receiveDirect(msg);
      } else if (msg.t === "raw" && validKey(msg.k) && opts.onRawRequest) {
        // The site's tab asks the extension (which can reach the source site) to download a chapter's original text. The answer is the chapter
        // arriving like any other; a failure is reported back so the tab can show why nothing came.
        Promise.resolve()
          .then(() => opts.onRawRequest(msg.k, { novelName: String(msg.n || "").slice(0, 300), pageTitle: String(msg.p || "").slice(0, 300), translate: !!msg.tr, source: String(msg.s || "").slice(0, 100), ahead: Math.max(0, Math.min(10, Number(msg.a) || 0)), findNext: !!msg.f, force: !!msg.x, retranslate: !!msg.rt, wtrRawId: /^\d{1,12}$/.test(String(msg.w || "")) ? String(msg.w) : "",
            // lang: the language to translate it into (a code), when it is not the one the library says
            lang: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(msg.l || "")) ? String(msg.l) : "",
            // notes: how many chapters from this one (it, and the ones asked for ahead of it) get Gemini's notes on terms; none said: the library-wide switch decides
            ...(Number.isFinite(msg.nt) ? { notes: Math.max(0, Math.min(11, Math.floor(msg.nt))) } : {}),
            // custom: the reader's Custom prompt, for this one request: the prompt (instead of the one in use) and what is sent with it
            ...(msg.cp && typeof msg.cp === "object" && typeof msg.cp.p === "string" && msg.cp.p.trim() ? { custom: { prompt: msg.cp.p.slice(0, 8000), notes: !!msg.cp.n, glossary: msg.cp.g !== false, replace: !!msg.cp.e } } : {}) }))
          .catch((e) => peer.send({ t: "rawfail", k: msg.k, e: String((e && e.message) || e).slice(0, 300) }));
      } else if (msg.t === "rs" && validKey(msg.k) && opts.onRawStatus) {
        // on demand: a chapter this side asked the extension for (requestRaw) is wanted once that one has it, whichever address it is kept
        // under (the one asked, or the source site's own, said in "u"), though nothing opened it by its own key. Asked for its original text alone
        // (translate: false, a novel this page translates with a profile), the original text is wanted too.
        if (msg.s === "done" && rawAsks.has(msg.k)) {
          const original = rawAsks.get(msg.k);
          rawAsks.delete(msg.k);
          const own = [msg.k.replace(/#original$/, ""), /^https:\/\//.test(String(msg.u || "")) ? "translation:" + String(msg.u).slice(0, 600) : "", original ? msg.k : ""].filter((k) => k && validKey(k));
          for (const k of own) { if (onDemand) wanted.add(k); enqueueFetch(k, true); }
        }
        opts.onRawStatus(msg.k, String(msg.s || "").slice(0, 30), { pageTitle: String(msg.p || "").slice(0, 300), error: String(msg.e || "").slice(0, 300), url: /^https:\/\//.test(String(msg.u || "")) ? String(msg.u).slice(0, 600) : "", note: String(msg.n || "").slice(0, 120) });
      } else if (msg.t === "rawfail" && validKey(msg.k) && opts.onRawFail) {
        opts.onRawFail(msg.k, String(msg.e || "").slice(0, 300));
      } else if (msg.t === "rawstop" && validKey(msg.k) && opts.onRawStop) {
        opts.onRawStop(msg.k); // the tab that asked no longer wants it (a long chapter list, stopped part way)
      } else if (lib) {
        await onLibraryMessage(peer, msg);
      }
    }

    async function onLibraryMessage(peer, msg) {
      const rows = (v) => (Array.isArray(v) ? v : []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && r[0].length <= 600 && Array.isArray(r[1]));
      if (msg.t === "lv" || msg.t === "lh") {
        if (msg.t === "lv") {
          peer.recVersions = (peer.recVersions || []).concat(rows(msg.v));
          if (!msg.last) return;
        }
        const list = msg.t === "lv" ? peer.recVersions : rows(msg.v);
        if (msg.t === "lv") peer.recVersions = [];
        let want = [];
        if (lib.wantsMany) want = rows(await lib.wantsMany(list));
        else for (const [k, v] of list) if (await lib.wants(k, v)) want.push([k, v]);
        if (want.length) await askRecords(peer, want);
      } else if (msg.t === "lvq") {
        await sendRecordVersions(peer);
      } else if (msg.t === "lq" && Array.isArray(msg.k)) {
        queueRecords(peer, msg.k.filter((k) => typeof k === "string" && k.length <= 600).slice(0, 300));
      } else if (msg.t === "lr" && typeof msg.k === "string") {
        await receiveRecordPiece(peer, msg);
      }
    }

    // ---------- publishing ----------
    async function publishLocal(key, entry) {
      const clean = sanitize(key, entry);
      if (!clean) throw new Error("not a valid document: " + key);
      const bytes = encodeChapter(key, entry);
      const meta = {
        infohash: await chapterId(bytes),
        savedAt: clean.savedAt,
        ...describe(key, clean),
        size: bytes.length
      };
      const existing = index[key];
      const changed = !existing || existing.infohash !== meta.infohash || existing.savedAt !== meta.savedAt;
      if (changed && (!existing || existing.savedAt <= meta.savedAt)) {
        index[key] = meta;
        schedulePersist([key]);
        stats.published++;
        broadcastEntries([key]);
        onChange({ type: "index", keys: [key] });
      }
    }

    // These chapters are no longer here (their novel was deleted from this side): off the index, so they are not offered or fetched again
    // (skip keeps them out when the other end lists them). Their texts are the adapter's to delete.
    function forget(keys) {
      for (const k of keys || []) {
        delete index[k];
        wanted.delete(k);
        unanswered.delete(k);
      }
      schedulePersist(keys);
    }

    async function onLocalSave(key, entry) {
      if (stopped || !hasContent(key, entry)) return;
      const known = index[key];
      if (known && known.savedAt >= (entry.savedAt || 0)) return;
      try {
        await publishLocal(key, entry);
      } catch (e) {
        stats.errors++;
        log("publish failed", key, e);
      }
    }

    // ---------- direct transfer (over the link) ----------
    function untrack(key, part) {
      const t = transfers.get(key);
      if (!t) return;
      delete t[part];
      if (!t.direct) transfers.delete(key);
    }

    // Asks the other ends for this chapter's text. Safe to call often: it asks again only after DIRECT_REASK_MS, and a version nobody answered
    // for less and less often (reaskAfter), unless `force` (a person opened it).
    function askDirect(key, force) {
      if (stopped || !index[key]) return;
      const now = Date.now();
      if (now - (directAsked.get(key) || 0) < DIRECT_REASK_MS) return;
      const u = unanswered.get(key);
      if (u && u.ver !== index[key].savedAt) unanswered.delete(key); // (a newer version: maybe the other end has that one)
      else if (u && !force && now - u.at < reaskAfter(u.n)) return;
      let asked = false;
      for (const p of memberPeers()) {
        p.send({ t: "get", k: key });
        asked = true;
      }
      if (!asked) return;
      directAsked.set(key, now);
      unanswered.set(key, { n: (u && u.ver === index[key].savedAt ? u.n : 0) + 1, at: now, ver: index[key].savedAt });
    }

    async function sendDirect(peer, key) {
      const local = await adapter.getTranslation(key);
      const clean = hasContent(key, local) && sanitize(key, local);
      if (!clean) return;
      const bytes = encodeChapter(key, local);
      if (bytes.length > MAX_CHAPTER_BYTES) return;
      const n = Math.ceil(bytes.length / DIRECT_CHUNK);
      for (let i = 0; i < n; i++) {
        peer.send({ t: "blob", k: key, s: clean.savedAt, i, n, d: toB64(bytes.subarray(i * DIRECT_CHUNK, (i + 1) * DIRECT_CHUNK)) });
      }
    }

    async function receiveDirect(msg) {
      const key = msg.k;
      if (!directAsked.has(key)) return; // only what we asked for
      const maxPieces = Math.ceil(MAX_CHAPTER_BYTES / DIRECT_CHUNK);
      if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > maxPieces || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string") return;
      let a = assemblies.get(key);
      if (!a || a.id !== msg.s || a.n !== msg.n) {
        if (assemblies.size >= MAX_ASSEMBLIES) assemblies.delete(assemblies.keys().next().value);
        a = { id: msg.s, n: msg.n, parts: new Array(msg.n), got: 0 };
        assemblies.set(key, a);
      }
      if (a.parts[msg.i]) return;
      let piece;
      try {
        piece = fromB64(msg.d);
      } catch (e) {
        return;
      }
      if (piece.length > DIRECT_CHUNK) return;
      a.parts[msg.i] = piece;
      if (++a.got < a.n) return;
      assemblies.delete(key);
      const bytes = new Uint8Array(a.parts.reduce((sum, x) => sum + x.length, 0));
      let at = 0;
      for (const x of a.parts) {
        bytes.set(x, at);
        at += x.length;
      }
      let payload;
      try {
        payload = JSON.parse(dec.decode(bytes));
      } catch (e) {
        return;
      }
      const refused = () => untrack(key, "direct"); // (not the version asked for: it is not on its way)
      if (!payload || payload.key !== key) return refused();
      const entry = sanitize(key, payload.entry);
      const meta = index[key];
      if (!entry || !entry.translated || !meta || entry.savedAt < meta.savedAt) return refused();
      if ((await chapterId(bytes)) !== meta.infohash) return refused(); // only the text its index entry names
      const have = await adapter.getTranslation(key);
      if (have && have.savedAt >= entry.savedAt) return refused();
      await adapter.setTranslation(key, entry);
      directAsked.delete(key);
      unanswered.delete(key);
      untrack(key, "direct");
      stats.fetched++;
      stats.direct++;
      onChange({ type: "chapter", key });
    }

    // ---------- fetching ----------
    function enqueueFetch(key, force) {
      if (stopped) return;
      askDirect(key, force);
    }

    function retryMissing() {
      if (stopped) return;
      adapter
        .listTranslations()
        .then((rows) => {
          const have = new Map(rows.map(([k, e]) => [k, e && e.savedAt]));
          for (const k of Object.keys(index)) {
            if (have.get(k) >= index[k].savedAt) { wanted.delete(k); continue; }
            if (!onDemand || wanted.has(k) || have.has(k)) enqueueFetch(k); // (on demand: asked for, or an older copy is here)
          }
        })
        .catch(() => {});
    }

    // ---------- lifecycle ----------
    async function reconcileLocal() {
      const rows = await adapter.listTranslations();
      rows.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
      for (const [key, light] of rows) {
        if (stopped) return;
        if (!validKey(key) || !light || !light.translated || skip(key)) continue;
        const known = index[key];
        if (known && known.savedAt >= light.savedAt) continue; // (indexed already: nothing to do for it)
        const entry = await adapter.getTranslation(key);
        if (hasContent(key, entry)) await publishLocal(key, entry).catch((e) => log("publish failed", key, e));
      }
      retryMissing();
    }

    async function start() {
      stop();
      cfg = (await adapter.getConfig()) || {};
      stopped = false;
      onDemand = cfg.fetch === "open";
      index = (await adapter.getIndex()) || {};
      retryTimer = setInterval(() => { retryMissing(); syncLibrary(); }, RETRY_INTERVAL_MS);
      for (const l of locals) attachLocal(l); // (the links survive a restart)
      reconcileLocal().catch((e) => log("reconcile failed", e));
      return true;
    }

    function stop() {
      stopped = true;
      clearInterval(retryTimer);
      clearTimeout(persistTimer);
      clearTimeout(retrySoon);
      peers.clear();
      for (const l of locals) l.peer = null;
    }

    // What is moving right now, for the activity view: each chapter being fetched, plus totals.
    // The chapters asked for that have not come yet (one nobody answered for 30 s is dropped: the next ask starts a new one).
    function inFlight() {
      const now = Date.now();
      for (const [key, t] of transfers) if (t.direct && now - t.direct.since > 30000) untrack(key, "direct");
      return transfers;
    }

    function activity() {
      const now = Date.now();
      const rows = [...inFlight()].map(([key, t]) => ({ key, direct: { ms: now - t.direct.since } }));
      return { rows, direct: stats.direct };
    }

    function status() {
      return {
        running: !stopped,
        peers: memberPeers().length, // (the links trusted now)
        indexed: Object.keys(index).length,
        queued: inFlight().size, // chapters asked for that have not come yet
        fetch: onDemand ? "open" : "all",
        protocol: PROTOCOL,
        // the other ends linked right now: what each says it is, or "unknown" for a build from before they introduced themselves
        devices: memberPeers().map((p) => ({ ...(p.info || { role: "unknown", v: 0 }), via: "local" })),
        stats
      };
    }

    return {
      start,
      stop,
      status,
      onLocalSave,
      forget,
      resync,
      getIndex: () => index,
      addLocalPeer,
      id: ownId,
      request: (key) => { if (onDemand && validKey(key)) wanted.add(key); enqueueFetch(key, true); }, // (a person opened it, or reads ahead: asked at once)
      // "all" or "open" (see getConfig): which chapters this side fetches, changed without restarting
      setFetch: (mode) => { onDemand = mode === "open"; if (!onDemand) retryMissing(); },
      // Tells the other ends how a chapter's original text is coming along (downloading, translating, done, failed).
      announceRaw: (key, state, info = {}) => {
        for (const p of memberPeers()) p.send({ t: "rs", k: key, s: state, p: info.pageTitle || "", e: info.error || "", u: info.url || "", n: info.note || "" });
      },
      queuedKeys: () => [...inFlight().keys()],
      // the library: records this side wrote, and asking the other ends again
      announceRecords: (records) => announceRecords(records).catch((e) => log("announce failed", e)),
      syncLibrary,
      activity,
      // Asks the extension (which can fetch from the source site) to save this chapter's original text. Returns how many were asked.
      requestRaw: (key, meta = {}) => {
        let asked = 0;
        if (!meta.findNext && !String(key).endsWith("#notes") && !String(key).endsWith("#details") && !String(key).endsWith("#list")) {
          rawAsks.delete(key); // (asked again: kept as the newest, with what this ask wants)
          rawAsks.set(key, meta.translate === false && String(key).endsWith("#original")); // (not said: a site chapter read from its source, kept under its own key)
          if (rawAsks.size > 200) rawAsks.delete(rawAsks.keys().next().value);
        }
        for (const p of memberPeers()) {
          p.send({ t: "raw", k: key, n: meta.novelName || "", p: meta.pageTitle || "", tr: !!meta.translate, s: meta.source || "", a: meta.ahead || 0, f: !!meta.findNext, x: !!meta.force, rt: !!meta.retranslate, w: meta.wtrRawId || "", ...(meta.lang ? { l: String(meta.lang) } : {}), ...(Number.isFinite(meta.notes) ? { nt: meta.notes } : {}), ...(meta.custom ? { cp: { p: String(meta.custom.prompt || ""), n: !!meta.custom.notes, g: meta.custom.glossary !== false, e: !!meta.custom.replace } } : {}) });
          asked++;
        }
        return asked;
      },
      // Tells them to stop working on something asked for with requestRaw (a chapter list being read page after page). Returns how many were told.
      stopRaw: (key) => {
        let told = 0;
        for (const p of memberPeers()) {
          p.send({ t: "rawstop", k: key });
          told++;
        }
        return told;
      },
      _internals: { sha256Hex, stable }
    };
  }

  root.P2PCore = { createP2P, KEY_PREFIX, langOf, baseKeyOf, langKey, kindOf, bucketedIndex, INDEX_BUCKETS, reaskAfter };
})(typeof globalThis !== "undefined" ? globalThis : this);
