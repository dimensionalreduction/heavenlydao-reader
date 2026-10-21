// Sharing a library with readers (docs/SHARED-LIBRARIES.md, step 2): the rooms readers meet in, and what each device keeps for them.
//
// Rooms. A library room (its catalog: the list of novels) and one room per shared novel (its chapters), found through the trackers by ids made
// from the share keys (library.js shareKeys, bookRoomOf). One WebTorrent client holds every room a device is in; in each, the devices speak
// "p2plib" (BEP-10) and send records straight over that connection, in pieces, with no torrent per record:
//   vs  the versions of the records this device holds (every one but chapters) · rq  the keys it wants · rc  a record, in pieces
//   bf  which of the novel's chapters this device holds, as bits over the novel's chapter list (its bhead) · hv  "I have this chapter now"
//   pv / pg / pc  pull requests held / wanted / sent (in pieces), pvq "say again which you hold": each device holds the ones to the room's library and passes them on (within
//   limits), until one of the owner's devices has taken it (its answer, pr:<id>, is published in the novel's room)
// A reader asks for the catalog when it follows a library, for a novel's list when it opens the novel, and for a chapter when it reads it (and
// the few after it): never the whole library. It asks a device that said it has the record, and passes on what it holds to whoever asks.
//
// Holders: what a device keeps in a room.
//   publisher({ lib, scope, bookId, getChapter, getCover }) — one of the owner's devices: makes the records from the library (the novels shared,
//     sbook:<id>) and from the chapters it holds; their versions come from what they are made of, so two devices make the same records.
//   follower({ store, libId, scope, bookId }) — a reader: checks each record (Library.readPublished) and keeps it in its store.
// followStore(adapter) keeps a reader's follows and records: memoryAdapter() / idbAdapter(name), as library.js.
(function (root) {
  "use strict";
  const Library = root.Library || (typeof require === "function" ? require("./library.js") : null);
  const EXT = "p2plib";
  const CHUNK = 8000;
  const MAX_RECORD_BYTES = 4 * 1024 * 1024;
  const ASK_TIMEOUT_MS = 15000;
  // Pull-through: a device asked for a record it does not hold, that none of the asker's neighbours said it holds, fetches it from its own
  // neighbours (keeps it, and passes it on), up to PULL_HOPS devices away; PULL_FANOUT neighbours are asked at each step.
  const PULL_HOPS = 2;
  const PULL_FANOUT = 3;
  const PULL_TIMEOUT_MS = 30000;
  const PULL_AT_ONCE = 30; // pull-throughs a room runs for others at once
  const PLAN_MS = 3000; // an owner's device makes its room's records (not chapters) again at most this often
  const LIMITED_MS = 10 * 60 * 1000; // a device that said it sends nothing more today ("lim") is not asked again for this long
  const NOVELS_PR = "~novels"; // the "book" of a pull request of whole novels (site/sharing.js has the same)
  const PR_PER_SENDER = 3; // open pull requests held per sender
  const PR_PER_LIBRARY = 200; // and per library
  const PR_BYTES = 5 * 1024 * 1024;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const { cmpVer, stable } = Library;
  // A message goes over the wire as-is only as the bundle's own Buffer (anything else is bencoded, and arrives unreadable): in node it is the
  // global one, in a browser the one WebTorrent's bundle has, taken from the first torrent made (as p2p-core.js does).
  let BufferClass = typeof Buffer !== "undefined" ? Buffer : null;

  function b64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function unb64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const kindOf = (key) => { const i = key.indexOf(":"); return i < 0 ? key : key.slice(0, i); };
  const idOf = (key) => { const i = key.indexOf(":"); return i < 0 ? "" : key.slice(i + 1); };
  const maxVer = (vers) => vers.reduce((m, v) => (cmpVer(v, m) > 0 ? v : m), [0, 0, ""]);
  // A version of the records made from other records: [their newest time, a count of them, ""] (the same on every device that makes it).
  const madeVer = (vers) => { const m = maxVer(vers); return [m[0], vers.reduce((n, v) => n + v[1], 0) + vers.length, ""]; };

  // Bits over a chapter list: which chapters a device holds.
  const bitsNew = (n) => new Uint8Array(Math.ceil(n / 8));
  const bitGet = (bits, i) => !!bits && i >= 0 && (bits[i >> 3] & (1 << (i & 7))) !== 0;
  const bitSet = (bits, i) => { bits[i >> 3] |= 1 << (i & 7); };

  // ---------- what a reader keeps ----------
  function memoryAdapter() {
    const records = new Map();
    const follows = new Map();
    return {
      async getRecord(id) { return records.get(id) || null; },
      async putRecord(id, row) { records.set(id, row); },
      async deleteRecord(id) { records.delete(id); },
      async listRecords(prefix) { return [...records.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v); },
      async getFollows() { return [...follows.values()]; },
      async putFollow(f) { follows.set(f.libId, f); },
      async deleteFollow(libId) { follows.delete(libId); }
    };
  }
  function idbAdapter(name) {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("records"); req.result.createObjectStore("follows"); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const tx = async (store, mode, fn) => {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out && "result" in out ? out.result : out);
        t.onerror = () => reject(t.error);
      });
    };
    return {
      getRecord: (id) => tx("records", "readonly", (st) => st.get(id)).then((x) => x || null),
      putRecord: (id, row) => tx("records", "readwrite", (st) => st.put(row, id)),
      deleteRecord: (id) => tx("records", "readwrite", (st) => st.delete(id)),
      listRecords: (prefix) => tx("records", "readonly", (st) => st.getAll(IDBKeyRange.bound(prefix, prefix + "￿"))),
      getFollows: () => tx("follows", "readonly", (st) => st.getAll()),
      putFollow: (f) => tx("follows", "readwrite", (st) => st.put(f, f.libId)),
      deleteFollow: (libId) => tx("follows", "readwrite", (st) => st.delete(libId))
    };
  }

  // The follows ({ libId, readKey?, books: { <book id>: bookKey }, name, at }) and the records read from each library ({ r, body }, by
  // "<library id>|<key>"), with the keys each reader has: the catalog key from the read key, a book's key from the read key or its link.
  function followStore(adapter) {
    const keys = new Map(); // libId -> { catalogKey, books: Map(bookId -> key) }
    // what each record held takes (only those with a body: what was fetched), by library: built from the records the first time it is asked
    // for (sizesOf), then kept up to date as records are put and deleted here
    const sizes = new Map(); // libId -> Map(key -> bytes)
    const rowBytes = (row) => (row && row.body ? JSON.stringify(row).length : 0);
    const totals = new Map(); // libId -> what its records held take, in all (the sum of sizes, kept with them)
    const sized = (libId, key, row) => {
      const m = sizes.get(libId);
      if (!m) return;
      const was = m.get(key) || 0;
      const n = rowBytes(row);
      if (n) m.set(key, n); else m.delete(key);
      totals.set(libId, (totals.get(libId) || 0) + n - was);
    };
    async function keysOf(f) {
      let k = keys.get(f.libId);
      if (!k || k.readKey !== f.readKey) {
        k = { readKey: f.readKey, catalogKey: f.readKey ? (await Library.shareKeys(f.libId, f.readKey)).catalogKey : null, books: new Map() };
        keys.set(f.libId, k);
      }
      for (const [b, key] of Object.entries(f.books || {})) k.books.set(b, key);
      return k;
    }
    const store = {
      adapter,
      follows: () => adapter.getFollows(),
      follow: async (libId) => (await adapter.getFollows()).find((f) => f.libId === libId) || null,
      // From a parsed link: the library (read key) or one book of it (its key). A later link of the same library adds to what is kept.
      // A library opened from its link is not followed (followed: false) until its Follow button: it is only shown.
      async addLink(link) {
        const cur = (await store.follow(link.libId)) || { libId: link.libId, books: {}, name: "", at: Date.now() };
        if (link.readKey && !cur.readKey) cur.followed = false;
        if (link.readKey) cur.readKey = link.readKey;
        if (link.bookId) cur.books = Object.assign({}, cur.books, { [link.bookId]: link.bookKey });
        await adapter.putFollow(cur);
        return cur;
      },
      unfollow: (libId) => adapter.deleteFollow(libId),
      // Following a library (its Follow button), or no longer. Records from before this have no "followed": followed.
      async setFollowed(libId, on) {
        const f = await store.follow(libId);
        if (f) { f.followed = !!on; if (on) f.at = Date.now(); await adapter.putFollow(f); }
      },
      // Making a library one's own (on this device): { on, at } (its novels become one's versions, new ones as they come)
      async setFork(libId, fork) {
        const f = await store.follow(libId);
        if (f) { f.fork = fork; await adapter.putFollow(f); }
      },
      // A library's own limits on this device: { store: bytes kept here at most, out: bytes sent its readers a day at most }, or null (the defaults)
      async setCaps(libId, caps) {
        const f = await store.follow(libId);
        if (f) { f.caps = caps; await adapter.putFollow(f); }
      },
      // Keeping a library available for other readers (on this device): { on, books: null (every novel) or [book ids] }
      async setKeep(libId, keep) {
        const f = await store.follow(libId);
        if (f) { f.keep = keep; await adapter.putFollow(f); }
      },
      async setName(libId, name) {
        const f = await store.follow(libId);
        if (f && f.name !== name) { f.name = name; await adapter.putFollow(f); }
      },
      // The rooms a follow reads in, and their keys.
      async catalogKey(libId) { const f = await store.follow(libId); return f && f.readKey ? (await keysOf(f)).catalogKey : null; },
      async bookKey(libId, bookId) {
        const f = await store.follow(libId);
        if (!f) return null;
        const k = await keysOf(f);
        if (!k.books.has(bookId) && f.readKey) k.books.set(bookId, await Library.bookKeyOf(f.readKey, bookId));
        return k.books.get(bookId) || null;
      },
      get: (libId, key) => adapter.getRecord(libId + "|" + key),
      put: async (libId, key, row) => { await adapter.putRecord(libId + "|" + key, row); sized(libId, key, row); },
      del: async (libId, key) => { await adapter.deleteRecord(libId + "|" + key); sized(libId, key, null); },
      // Map(key -> bytes) of the records held of a library (read from them once, then kept)
      async sizesOf(libId) {
        if (!sizes.has(libId)) {
          const m = new Map();
          for (const row of await adapter.listRecords(libId + "|")) { const n = row && row.r ? rowBytes(row) : 0; if (n) m.set(row.r.key, n); }
          if (!sizes.has(libId)) { sizes.set(libId, m); totals.set(libId, [...m.values()].reduce((a, b) => a + b, 0)); }
        }
        return sizes.get(libId);
      },
      // what a library's records take on this device, in all (for its limit)
      async heldBytes(libId) { await store.sizesOf(libId); return totals.get(libId) || 0; },
      list: (libId, prefix) => adapter.listRecords(libId + "|" + (prefix || "")),
      body: async (libId, key) => { const row = await adapter.getRecord(libId + "|" + key); return row ? row.body : null; },
      // A novel removed from this device: its details and the chapters of its list (the library's list of novels stays). -> chapters removed
      async removeBook(libId, bookId) {
        const head = await store.body(libId, "bhead:" + bookId);
        let n = 0;
        for (const c of (head && head.chapters) || []) {
          if (await adapter.getRecord(libId + "|chapter:" + c[2])) { await store.del(libId, "chapter:" + c[2]); n++; }
        }
        for (const k of ["book:", "bhead:", "bcover:", "terms:"]) await store.del(libId, k + bookId);
        return n;
      }
    };
    return store;
  }

  // ---------- holders ----------
  // A reader's: checks and keeps. scope "lib": the library's room, which carries all of it: the catalog (devices, profile, head, entry:*,
  // cover:*), fetched when the library is followed, and every novel's own records (book:, bhead:, terms:, chapter:*, and pr:* for the pull
  // requests this device holds), a novel's when it is opened (open(bookId)) and its chapters when asked for. scope "book": one novel's room
  // (devices, profile, book:<id>, bhead:<id>, bcover:<id>, terms:<id>, chapter:* of its list), for a reader with only that novel's link.
  // Covers and chapters are fetched only when asked for; a record once held is kept up to date.
  const BOOK_KINDS = new Set(["book", "bhead", "bcover", "terms"]);
  // full(key): may this record not be taken, the library having all it may on this device (its limits)? Asked of every record but the list of
  // devices, new or a newer version of one held: the page says when (chapters and covers at its limit; its lists and details a little past it)
  function follower({ store, libId, scope, bookId, full }) {
    const all = scope === "lib";
    const opened = new Set(); // (a library room) the novels opened here: their details are fetched as soon as a device says it has them
    const inScope = (key) => {
      const kind = kindOf(key);
      if (kind === "devices" || kind === "profile") return true;
      if (all) return kind === "head" || kind === "entry" || kind === "cover" || BOOK_KINDS.has(kind) || kind === "chapter" || kind === "pr";
      if (kind === "pr") return true; // (what became of a pull request on this novel)
      return BOOK_KINDS.has(kind) ? idOf(key) === bookId : kind === "chapter";
    };
    // the chapter lists held (from the novels' bheads): book id -> { list: [[num, title, url, savedAt], ...], ver }; chapter key -> book id
    let lists = null;
    let bookOfChapter = new Map();
    async function loadLists() {
      const next = new Map();
      const of = new Map();
      const rows = all ? await store.list(libId, "bhead:") : [await store.get(libId, "bhead:" + bookId)];
      for (const row of rows) {
        if (!row || !row.r || !row.body) continue;
        const b = idOf(row.r.key);
        if (!all && b !== bookId) continue;
        const list = row.body.chapters || [];
        next.set(b, { list, ver: row.r.ver, keys: list.map((c) => "chapter:" + c[2]) });
        for (const c of list) of.set("chapter:" + c[2], b);
      }
      lists = next;
      bookOfChapter = of;
    }
    // the key a record is encrypted with: the catalog's, or its novel's (a chapter's novel is the one whose list has it; a pull request's
    // answer, the novel of the pull request held here)
    async function keyFor(key) {
      const kind = kindOf(key);
      if (kind === "head" || kind === "entry" || kind === "cover") return store.catalogKey(libId);
      if (kind === "chapter") {
        if (lists === null) await loadLists();
        const b = bookOfChapter.get(key);
        return b ? store.bookKey(libId, b) : null;
      }
      if (kind === "pr") {
        if (!all) return store.bookKey(libId, bookId);
        const held = await store.get(libId, "prenv:" + idOf(key));
        if (held && held.env && held.env.book === NOVELS_PR) return store.catalogKey(libId); // (a pull request of whole novels: of no novel of theirs)
        return held && held.env && held.env.book ? store.bookKey(libId, held.env.book) : null;
      }
      return store.bookKey(libId, idOf(key));
    }
    const h = {
      scope,
      bookId: all ? null : bookId,
      // the novel a chapter is of ("" when none of the lists held has it)
      async bookOf(key) {
        if (lists === null) await loadLists();
        return bookOfChapter.get(key) || (all ? "" : bookId);
      },
      // (a library room) this novel is being read: its details are wanted now. False when it was already.
      open(id) {
        if (!all || opened.has(id)) return false;
        opened.add(id);
        return true;
      },
      // its records were removed from this device: not wanted until it is opened again
      forget(id) {
        opened.delete(id);
        lists = null;
      },
      async versions() {
        const rows = await store.list(libId);
        return rows.filter((x) => x.r && inScope(x.r.key) && kindOf(x.r.key) !== "chapter").map((x) => [x.r.key, x.r.ver]); // (records only: not the pull requests held)
      },
      async wants(key, ver, lazy) {
        if (!inScope(key)) return false;
        const row = await store.get(libId, key);
        if (row && cmpVer(row.r.ver, ver) >= 0) return false;
        if (full && key !== "devices" && (await full(key))) return false; // (its limits on this device)
        if (row) return true; // (a newer version of one kept: brought up to date)
        const kind = kindOf(key);
        // what is fetched only when asked: a cover, a chapter; in a library room also a novel's details, unless the novel was opened here
        if (kind === "cover" || kind === "bcover" || kind === "chapter") return !!lazy;
        if (all && BOOK_KINDS.has(kind)) return !!lazy || opened.has(idOf(key));
        if (all && kind === "pr") return !!(await store.get(libId, "prenv:" + idOf(key))); // (what became of a pull request held here)
        return true;
      },
      get: async (key) => { const row = await store.get(libId, key); return row ? row.r : null; },
      async receive(r) {
        if (!r || typeof r.key !== "string" || !inScope(r.key)) return { why: "not of this room" };
        const cur = await store.get(libId, r.key);
        if (cur && cmpVer(cur.r.ver, r.ver) >= 0) return { why: "not newer" };
        const devRow = await store.get(libId, "devices");
        const kind = kindOf(r.key);
        if (kind === "chapter") {
          if (lists === null) await loadLists();
          const b = bookOfChapter.get(r.key);
          if (!b || (!all && b !== bookId)) return { why: "not in the novel's list" };
        }
        const key = await keyFor(r.key);
        const res = await Library.readPublished(r, { lib: libId, devices: devRow ? devRow.body : [], keyOf: () => key });
        if (res.why) return res;
        await store.put(libId, r.key, { r, body: res.body });
        if (kind === "profile" && res.body && res.body.name) await store.setName(libId, String(res.body.name).slice(0, 100));
        if (kind === "bhead") await loadLists();
        return { stored: true };
      },
      // ----- pull requests to this library, held and passed on -----
      // [[id, at]] of the ones held (not expired, not answered yet)
      async prs() {
        const out = [];
        for (const row of await store.list(libId, "prenv:")) {
          const e = row.env;
          if (!e || Date.now() > e.expires || (scope === "book" && e.book !== bookId)) continue;
          if (await store.get(libId, "pr:" + e.id)) continue; // answered
          out.push([e.id, e.at]);
        }
        return out;
      },
      hasPr: async (id) => !!(await store.get(libId, "prenv:" + id)) || !!(await store.get(libId, "pr:" + id)),
      getPr: async (id) => { const row = await store.get(libId, "prenv:" + id); return row ? row.env : null; },
      async receivePr(e) {
        if (!e || e.to !== libId || (scope === "book" && e.book !== bookId)) return { why: "not of this room" };
        if (await h.hasPr(e.id)) return { why: "held already" };
        const prof = await store.body(libId, "profile");
        const why = await Library.checkPr(e, { to: libId, policy: prof || {} });
        if (why) return { why };
        // limits: 3 open per sender, 200 and 5 MB per library (the oldest go first)
        const held = (await store.list(libId, "prenv:")).filter((x) => x.env && Date.now() <= x.env.expires);
        if (held.filter((x) => x.env.from === e.from).length >= PR_PER_SENDER) return { why: "too many from this sender" };
        const size = (x) => JSON.stringify(x).length;
        let total = held.reduce((n, x) => n + size(x.env), 0) + size(e);
        held.sort((a, b) => a.env.at - b.env.at);
        while (held.length && (held.length >= PR_PER_LIBRARY || total > PR_BYTES)) {
          const old = held.shift();
          total -= size(old.env);
          await store.put(libId, "prenv:" + old.env.id, { env: null, dropped: Date.now() });
        }
        await store.put(libId, "prenv:" + e.id, { env: e });
        return { stored: true };
      },
      // A pull request this device sent: held like the others, so it travels from here too.
      async keepMine(e) { await store.put(libId, "prenv:" + e.id, { env: e, mine: true }); },

      // The novels' chapter lists held here, and which of their chapters this device holds: [{ bookId, ver, keys, bits }].
      async chapterLists() {
        if (lists === null) await loadLists();
        // (the records held, as the store keeps them: reading every chapter held each time made a whole novel slower with each chapter)
        const have = await store.sizesOf(libId);
        const out = [];
        for (const [b, { list, ver, keys }] of lists) {
          const bits = bitsNew(list.length);
          keys.forEach((k, i) => { if (have.has(k)) bitSet(bits, i); });
          out.push({ bookId: b, ver, keys, bits });
        }
        return out;
      }
    };
    return h;
  }

  // One of the owner's devices: makes the records readers get, from the library and the chapters this device holds.
  //   getChapter(key) -> the chapter entry ({ translated, savedAt, ... }) or null; listChapters() -> Map(key -> savedAt) of every chapter this
  //   device holds (one call, for the bits); getCover(novelId) -> { type, bytes, at } or null
  // scope "lib": the library's room, with the catalog and every shared novel's records (a reader with the library's link reads it all there);
  // scope "book": one novel's room, for readers with only that novel's link.
  function publisher({ lib, scope, bookId, getChapter, listChapters, getCover }) {
    const bitsFor = new Map(); // book id -> { ver (the novel's list it was made for), bits }
    const made = new Map(); // key -> record (made once per version)
    const bookKeys = new Map(); // "<read key>|<book id>" -> its key
    async function keys() {
      const share = lib.shareNow();
      if (!share) return null;
      const { catalogKey } = await Library.shareKeys(share.libId, share.readKey);
      const bookKey = async (id) => {
        const k = share.readKey + "|" + id;
        if (!bookKeys.has(k)) bookKeys.set(k, await Library.bookKeyOf(share.readKey, id));
        return bookKeys.get(k);
      };
      return { catalogKey, bookKey, readKey: share.readKey };
    }
    // the novels this room serves
    // (their ids alone: copying every shared novel's list of chapters for each record asked for made a library's chapters slow to send)
    const bookIds = () => (scope === "book" ? (lib.sharedBook(bookId) ? [bookId] : []) : lib.sharedBookIds ? lib.sharedBookIds() : Object.keys(lib.sharedBooks()));
    const chapterKey = (c) => "chapter:" + String(c[2]).replace(/^translation:/, "");
    async function make(key, ver, body, aes) {
      const cached = made.get(key);
      if (cached && stable(cached.ver) === stable(ver) && cached.aes === aes) return cached.r;
      const r = await lib.makePublished(key, ver, body, aes);
      made.set(key, { ver, aes, r });
      return r;
    }
    // what a reader sees of a novel (its page as the owner's library shows it)
    const entryOf = (b, id) => ({
      title: b.title || "", author: b.author || "", authorRaw: b.authorRaw || "", rawTitle: b.rawTitle || "", names: b.names || [], synopsis: b.synopsis || "",
      cover: b.cover || "", genres: b.genres || [], tags: b.tags || [], status: b.status || "", rawStatus: b.rawStatus || "", rating: b.rating || 0, views: b.views || 0,
      source: b.source || "", sources: b.sources || [], url: b.url || "", chapters: (b.chapters || []).length,
      // a novel shared as someone's version of another's (a layer): where the rest of it is, for its readers to fetch too
      // (and, a version made by making the whole library one's own, that library's read key: its readers read it in its library's room)
      layer: b.layer && b.layer.lib && b.layer.bookKey
        ? Object.assign({ lib: b.layer.lib, bookKey: b.layer.bookKey, book: b.layer.book || id }, typeof b.layer.readKey === "string" ? { readKey: b.layer.readKey } : {})
        : null,
      updated: Math.max(0, ...(b.chapters || []).map((c) => Number(c[3]) || 0))
    });
    const verOf = (sb) => [sb.ver[0], sb.ver[1], ""];
    // the records this device can make for its room: key -> [ver, () => body, aes key or null]. Kept until the library changes, or PLAN_MS
    // (it reads every shared novel, and their covers): a reader fetching a whole library asks for many records at once.
    let planned = null;
    function plan() {
      const n = lib.changeCount ? lib.changeCount() : -1;
      if (!planned || planned.n !== n || n < 0 || Date.now() - planned.at > PLAN_MS) {
        const p = makePlan();
        planned = { at: Date.now(), n, p };
        p.catch(() => { if (planned && planned.p === p) planned = null; });
      }
      return planned.p;
    }
    async function makePlan() {
      const k = await keys();
      if (!k) return new Map();
      const out = new Map();
      // the library's name, and whom it takes pull requests from, and the key to seal them with (made with the share key)
      const prof = lib.profile();
      const sealKey = (lib.shareNow() || {}).sealPub || "";
      const pv = madeVer([[Math.max(1, prof.ver[0]), prof.ver[1], ""], lib.shareVer ? lib.shareVer() : [1, 0, ""]]);
      out.set("profile", [pv, () => ({ name: prof.name || "", prs: prof.prs || "anyone", approved: prof.approved || [], sealKey }), null]);
      if (scope === "lib") {
        const head = {};
        const vers = [];
        for (const id of bookIds()) {
          const sb = lib.sharedBook(id);
          const v = verOf(sb);
          vers.push(v);
          head[id] = { ver: v, n: (sb.chapters || []).length, title: sb.title || "" };
          out.set("entry:" + id, [v, () => entryOf(sb, id), k.catalogKey]);
          if (sb.coverId && getCover) {
            const c = await getCover(sb.coverId);
            if (c && c.bytes) out.set("cover:" + id, [[Number(c.at) || 1, 0, ""], () => ({ type: c.type, data: b64(c.bytes) }), k.catalogKey]);
          }
        }
        out.set("head", [madeVer(vers.length ? vers : [[1, 0, ""]]), () => ({ books: head }), k.catalogKey]);
      }
      const done = lib.prsDone ? Object.entries(lib.prsDone()) : [];
      // what became of the pull requests of whole novels (they are of no novel of this library's): in the library room, with the catalog's key
      if (scope === "lib") for (const [prId, d] of done) {
        if (d.book !== NOVELS_PR) continue;
        out.set("pr:" + prId, [[Number(d.at) || 1, 0, ""], () => ({ state: d.state, accepted: d.accepted || [], at: d.at, from: d.from, note: d.note || "" }), k.catalogKey]);
      }
      for (const id of bookIds()) {
        const sb = lib.sharedBook(id);
        const bk = await k.bookKey(id);
        const v = verOf(sb);
        out.set("book:" + id, [v, () => entryOf(sb, id), bk]);
        out.set("bhead:" + id, [v, () => ({ chapters: (sb.chapters || []).map((c) => [c[0], c[1], String(c[2]).replace(/^translation:/, ""), c[3]]) }), bk]);
        // (in the library room the catalog's cover:<id> is the cover)
        if (scope === "book" && sb.coverId && getCover) {
          const c = await getCover(sb.coverId);
          if (c && c.bytes) out.set("bcover:" + id, [[Number(c.at) || 1, 0, ""], () => ({ type: c.type, data: b64(c.bytes) }), bk]);
        }
        // what became of the pull requests on this novel
        for (const [prId, d] of done) {
          if (d.book !== id) continue;
          out.set("pr:" + prId, [[Number(d.at) || 1, 0, ""], () => ({ state: d.state, accepted: d.accepted || [], at: d.at, from: d.from, note: d.note || "" }), bk]);
        }
        // the owner's terms for it (what its text is shown with): those kept for this novel, and those for every novel
        // and the glossary of the novel (its terms, source -> rendering, in each language it has one), so a reader who copies the novel gets them too
        if (lib.termsFor) {
          const keys = sb.keys && sb.keys.length ? sb.keys : [id];
          const terms = lib.termsFor(keys);
          const glossary = lib.glossaryFor ? lib.glossaryFor(keys) : null;
          const vers = terms.map((t) => t.ver).concat(glossary ? [glossary.ver] : []);
          out.set("terms:" + id, [vers.length ? madeVer(vers) : [1, 0, ""], () => ({ terms: terms.map((t) => t.term), ...(glossary ? { glossary: { v: 1, langs: glossary.langs } } : {}) }), bk]);
        }
      }
      return out;
    }
    // the shared novels' lists, by chapter key -> [book id, its row] (sig: their ids and versions): made again when one of them changes
    let chapterIndex = { sig: "", of: new Map() };
    function chapterAt(key) {
      const ids = bookIds();
      const sig = ids.map((id) => id + "@" + stable(verOf(lib.sharedBook(id)))).join("|");
      if (sig !== chapterIndex.sig) {
        const of = new Map();
        for (const id of ids) for (const c of lib.sharedBook(id).chapters || []) if (!of.has(chapterKey(c))) of.set(chapterKey(c), [id, c]);
        chapterIndex = { sig, of };
      }
      return chapterIndex.of.get(key) || null;
    }
    const h = {
      scope,
      bookId: scope === "book" ? bookId : null,
      async bookOf(key) {
        const at = chapterAt(key);
        return at ? at[0] : "";
      },
      async versions() {
        const p = await plan();
        const rows = [...p.entries()].map(([key, [ver]]) => [key, ver]);
        const dev = lib.get("devices");
        if (dev) rows.unshift(["devices", dev.ver]);
        return rows;
      },
      wants: async () => false, // (the owner's devices make what readers get; they take nothing from readers)
      async get(key) {
        if (key === "devices") return lib.get("devices");
        if (kindOf(key) === "chapter") {
          // (the novel whose list has it: in a library room, any of those shared)
          const at = chapterAt(key);
          if (!at) return null;
          const [id, row] = at;
          const entry = await getChapter("translation:" + idOf(key));
          if (!entry || !entry.translated || Number(entry.savedAt) !== Number(row[3])) return null; // (not this device's to give: another version)
          const k = await keys();
          const body = { translated: String(entry.translated), pageTitle: String(entry.pageTitle || ""), novelName: String(entry.novelName || ""), model: entry.model || null, savedAt: Number(entry.savedAt) || 0, num: row[0] };
          return make(key, [Number(row[3]) || 1, 0, ""], body, await k.bookKey(id));
        }
        const p = await plan();
        const it = p.get(key);
        return it ? make(key, it[0], it[1](), it[2]) : null;
      },
      receive: async () => ({ why: "the owner's devices take nothing from readers" }),
      // pull requests to this library: taken into the inbox (every device of the owner's has it); none held to pass on
      prs: async () => [],
      hasPr: async (id) => !!(lib.hasPr && lib.hasPr(id)),
      getPr: async () => null,
      async receivePr(e) {
        if (!lib.hasPr || lib.hasPr(e && e.id)) return { why: "held already" };
        const prof = lib.profile();
        const share = lib.shareNow() || {};
        const why = await Library.checkPr(e, { to: share.libId, policy: { prs: prof.prs || "anyone", approved: prof.approved || [], sealKey: share.sealPub } });
        if (why) return { why };
        if (scope === "book" && e.book !== bookId) return { why: "not of this room" };
        await lib.put("prin:" + e.id, e);
        return { stored: true };
      },
      // The shared novels' chapter lists, and which of their chapters this device holds: [{ bookId, ver, keys, bits }].
      async chapterLists() {
        const out = [];
        let have = null;
        for (const id of bookIds()) {
          const sb = lib.sharedBook(id);
          const list = sb.chapters || [];
          const ver = verOf(sb);
          let b = bitsFor.get(id);
          if (!b || stable(b.ver) !== stable(ver)) {
            if (!have) have = await listChapters();
            const bits = bitsNew(list.length);
            list.forEach((c, i) => { if (Number(have.get(String(c[2]))) === Number(c[3])) bitSet(bits, i); });
            b = { ver, bits, keys: list.map(chapterKey) }; // (its keys too: made once per version of its list)
            bitsFor.set(id, b);
          }
          out.push({ bookId: id, ver, keys: b.keys, bits: b.bits });
        }
        return out;
      },
      // A chapter this device saved: its bit, if it is the version a novel's list has. True when it is one of this room's novels'.
      chapterSaved(key, savedAt) {
        let hit = false;
        for (const id of bookIds()) {
          const b = bitsFor.get(id);
          const sb = lib.sharedBook(id);
          if (!b || !sb) continue;
          const i = (sb.chapters || []).findIndex((c) => c[2] === key && Number(c[3]) === Number(savedAt));
          if (i < 0) continue;
          bitSet(b.bits, i);
          hit = true;
        }
        return hit;
      }
    };
    return h;
  }

  // The owner's device publishing: in the library room, and in the rooms of the novels shared (at most maxBookRooms at once; with more, a
  // different set every rotateMs, so each is there some of the time). Follows the library: a novel shared or no longer, a new link, a new
  // name. chapterSaved(key, savedAt): this device saved a chapter, which the readers of its novel are told about.
  function publishing({ lib, rooms, getChapter, listChapters, getCover, maxBookRooms = 10, rotateMs = 3 * 60 * 1000, log = () => {} }) {
    const joined = new Map(); // room id -> { scope, bookId }
    let turn = 0;
    let timer = null;
    let running = Promise.resolve();
    async function update() {
      const st = lib.status();
      // (a library shared before pull requests existed gets its seal key now: its profile says it, so they can be sent)
      if (st.state === "member" && lib.shareNow() && !lib.shareNow().sealPub && lib.share) await lib.share();
      const share = lib.shareNow();
      const want = new Map();
      if (st.state === "member" && share) {
        want.set((await Library.shareKeys(share.libId, share.readKey)).libRoom, { scope: "lib" });
        const ids = Object.keys(lib.sharedBooks()).sort();
        let pick = ids;
        if (ids.length > maxBookRooms) {
          const start = (turn * maxBookRooms) % ids.length;
          pick = ids.slice(start).concat(ids.slice(0, start)).slice(0, maxBookRooms);
        }
        for (const id of pick) want.set(await Library.bookRoomOf(share.libId, await Library.bookKeyOf(share.readKey, id)), { scope: "book", bookId: id });
      }
      for (const id of [...joined.keys()]) if (!want.has(id)) { rooms.leave(id); joined.delete(id); }
      for (const [id, w] of want) {
        if (!joined.has(id)) {
          rooms.join(id, publisher({ lib, scope: w.scope, bookId: w.bookId, getChapter, listChapters, getCover }));
          joined.set(id, w);
        } else {
          const r = rooms.get(id);
          if (r) await r.refresh();
        }
      }
    }
    const again = () => { running = running.then(update).catch((e) => log("publishing failed", e)); return running; };
    // what in the library changes what readers get
    const off = lib.on("change", (c) => {
      const k = (c && c.key) || "";
      if (c && c.status || k === "share" || k === "profile" || k === "devices" || k.startsWith("sbook:") || k.startsWith("cover:") || k.startsWith("term:") || k.startsWith("prdone:")) again();
    });
    timer = setInterval(() => { if (Object.keys(lib.sharedBooks()).length > maxBookRooms) { turn++; again(); } }, rotateMs);
    again();
    return {
      update: again,
      rooms: () => [...joined.entries()].map(([id, w]) => Object.assign({ id, peers: rooms.get(id) ? rooms.get(id).peers().length : 0, devices: rooms.get(id) ? rooms.get(id).peerBooks() : [] }, w)),
      async chapterSaved(key, savedAt) {
        for (const [id, w] of joined) {
          const r = rooms.get(id);
          if (r && r.holder.chapterSaved(key, savedAt)) await r.refresh();
        }
      },
      stop() { off(); clearInterval(timer); for (const id of joined.keys()) rooms.leave(id); joined.clear(); }
    };
  }

  // ---------- the rooms ----------
  // (opts.rtcConfig: as p2p-core's, the RTCPeerConnection settings, kept by reference)
  // createRooms({ WebTorrent, trackers, makeSeedInput, log, rtcConfig? }) -> { join(roomId, holder), leave(roomId), rooms(), devices(), announceNow(), stop() }
  // A room: { id, holder, peers(), fetch(key) -> record | null, refresh() (the holder changed: tell the others), status() }
  // opts.onSent(roomId, key, bytes, bookId): a record was sent to another device (bookId: its novel, "" for the library's own records)
  // opts.canSend(roomId, bytes): may this record be sent (a limit of what is sent a day)? false: nothing more is sent that device for now
  function createRooms(opts) {
    const log = opts.log || (() => {});
    let client = null;
    const rooms = new Map(); // roomId -> room
    const onChange = opts.onChange || (() => {});

    function getClient() {
      if (!client) {
        client = new opts.WebTorrent({ dht: false, lsd: false, utp: false, tracker: opts.rtcConfig ? { rtcConfig: opts.rtcConfig } : {} });
        client.on("error", (e) => log("share client error", e && e.message));
      }
      return client;
    }

    function makeRoom(roomId, firstHolder) {
      let holder = firstHolder;
      const peers = new Set();
      const assemblies = new Map();
      const asked = new Map(); // key -> { at, resolve[], waitOn: Set(peer) | undefined (the devices asked, that have not said they cannot) }
      // nothing will come of it: every device asked said it cannot ("nf", or "lim": its limit for the day), so it ends now, not at its timeout
      const settle = (key) => { const a = asked.get(key); if (!a) return; asked.delete(key); for (const r of a.resolve) r(null); };
      const isBulk = (key) => /^(chapter|cover|bcover):/.test(key);
      const prAsked = new Map(); // pull request id -> when it was asked for
      const prAssemblies = new Map();
      const relaying = new Map(); // key -> { at, to: Set(peer) }: records being fetched here for neighbours that asked (pull-through)
      let receiving = Promise.resolve();
      let torrent = null;
      let left = false;
      // the novel a record is of: a novel's own records say it; a chapter's, the holder (the novel whose list has it)
      async function bookOfKey(key) {
        const kind = kindOf(key);
        if (kind === "book" || kind === "bhead" || kind === "bcover" || kind === "terms" || kind === "entry" || kind === "cover") return idOf(key);
        if (kind !== "chapter") return "";
        return (holder.bookOf ? await holder.bookOf(key) : "") || holder.bookId || "";
      }

      // (bits: book id -> { ver, bits }, which chapters of each novel's list the device holds)
      function Ext(wire) { this._wire = wire; this.versions = new Map(); this.bits = new Map(); }
      Ext.prototype.name = EXT;
      Ext.prototype.onHandshake = function () {};
      Ext.prototype.onExtendedHandshake = function () { peers.add(this); greet(this).catch((e) => log("greet failed", e)); };
      Ext.prototype.onMessage = function (buf) {
        let msg;
        try { msg = JSON.parse(dec.decode(buf)); } catch (e) { return; }
        onMessage(this, msg).catch((e) => log("share message failed", e));
      };
      Ext.prototype.send = function (obj) {
        const json = JSON.stringify(obj);
        try { this._wire.extended(EXT, BufferClass ? BufferClass.from(json, "utf8") : enc.encode(json)); } catch (e) { /* closed */ }
      };
      const attach = (wire) => {
        if (wire[EXT]) return;
        wire.use(Ext);
        wire.once("close", () => peers.delete(wire[EXT]));
      };

      async function sendVersions(peer) {
        const rows = await holder.versions();
        rows.sort((a, b) => (b[0] === "devices") - (a[0] === "devices"));
        for (let i = 0; i < rows.length || i === 0; i += 200) peer.send({ t: "vs", v: rows.slice(i, i + 200) });
      }
      async function sendBits(peer) {
        for (const c of (holder.chapterLists ? await holder.chapterLists() : [])) peer.send({ t: "bf", bk: c.bookId, hv: c.ver, b: b64(c.bits) });
      }
      // The novel a "bf" / "hv" is about: said (bk), or (a device from before library rooms carried every novel) the novel of this room.
      const bookOfMsg = (msg) => (typeof msg.bk === "string" && msg.bk.length <= 300 ? msg.bk : holder.bookId || "");
      // A chapter's novel, its list's version and its place in it, by this device's lists: null when no list here has it.
      // where a chapter is in its novel's list: { bookId, ver, i } (an index of every list here, made again when one of them changes)
      let places = { sig: "", of: new Map() };
      async function placeOf(key) {
        const lists = holder.chapterLists ? await holder.chapterLists() : [];
        const sig = lists.map((c) => c.bookId + "@" + stable(c.ver)).join("|");
        if (sig !== places.sig) {
          const of = new Map();
          for (const c of lists) { const ver = stable(c.ver); c.keys.forEach((k, i) => { if (!of.has(k)) of.set(k, { bookId: c.bookId, ver, i }); }); }
          places = { sig, of };
        }
        return places.of.get(key) || null;
      }
      const peerHas = (p, at) => { const b = p.bits.get(at.bookId); return !!b && b.ver === at.ver && bitGet(b.bits, at.i); };
      async function sendPrs(peer) {
        if (!holder.prs) return;
        const held = await holder.prs();
        if (held.length) peer.send({ t: "pv", v: held.slice(0, 300) });
      }
      async function greet(peer) {
        await sendVersions(peer);
        await sendBits(peer);
        await sendPrs(peer);
      }

      // asks a device that has it (or every device, when none said so) for these keys
      function ask(peer, keys) {
        const now = Date.now();
        const fresh = keys.filter((k) => { const a = asked.get(k); return !a || now - a.at > ASK_TIMEOUT_MS; });
        for (const k of fresh) asked.set(k, Object.assign(asked.get(k) || { resolve: [] }, { at: now }));
        fresh.sort((a, b) => (b === "devices") - (a === "devices"));
        if (fresh.length) peer.send({ t: "rq", k: fresh.slice(0, 200) });
      }

      async function onMessage(peer, msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.t === "vs" && Array.isArray(msg.v)) {
          const want = [];
          for (const row of msg.v) {
            if (!Array.isArray(row) || typeof row[0] !== "string" || row[0].length > 600 || !Array.isArray(row[1])) continue;
            peer.versions.set(row[0], row[1]);
            if (await holder.wants(row[0], row[1], false)) want.push(row[0]);
          }
          if (want.length) ask(peer, want);
        } else if (msg.t === "bf" && Array.isArray(msg.hv) && typeof msg.b === "string") {
          const bk = bookOfMsg(msg);
          if (!bk || (peer.bits.size >= 5000 && !peer.bits.has(bk))) return;
          try { peer.bits.set(bk, { ver: stable(msg.hv), bits: unb64(msg.b) }); } catch (e) { return; }
          onChange({ room: roomId, holders: true }); // (a page waiting for a chapter asks again: now someone may have it)
        } else if (msg.t === "hv" && Array.isArray(msg.hv) && Array.isArray(msg.i)) {
          const b = peer.bits.get(bookOfMsg(msg));
          if (!b || b.ver !== stable(msg.hv)) return;
          for (const i of msg.i) if (Number.isInteger(i) && i >= 0 && i < b.bits.length * 8) bitSet(b.bits, i);
          onChange({ room: roomId, holders: true });
        } else if (msg.t === "rq" && Array.isArray(msg.k)) {
          const keys = msg.k.filter((k) => typeof k === "string" && k.length <= 600).slice(0, 200);
          const held = [];
          const missing = [];
          for (const k of keys) ((await holder.get(k)) ? held : missing).push(k);
          queueSend(peer, held);
          // asked to fetch what it does not hold (pull-through): only a few keys at a time, with the hops left; the rest it says it cannot
          const via = Number.isInteger(msg.via) ? Math.min(msg.via, PULL_HOPS) : 0;
          const bk = typeof msg.bk === "string" && msg.bk.length <= 300 ? msg.bk : "";
          const pulling = via > 0 ? missing.slice(0, 10) : [];
          for (const k of pulling) pullThrough(peer, k, via - 1, bk).catch((e) => log("pull-through failed", e));
          const cannot = missing.filter((k) => !pulling.includes(k));
          if (cannot.length) peer.send({ t: "nf", k: cannot });
        } else if (msg.t === "nf" && Array.isArray(msg.k)) {
          for (const k of msg.k.slice(0, 200)) {
            const a = typeof k === "string" && asked.get(k);
            if (a && a.waitOn && a.waitOn.delete(peer) && !a.waitOn.size) settle(k);
          }
        } else if (msg.t === "rc" && typeof msg.k === "string") {
          await receivePiece(peer, msg);
        } else if (msg.t === "lim") {
          peer.limitedAt = Date.now(); // (it sends nothing more today: not asked for LIMITED_MS)
          for (const [k, a] of [...asked]) if (isBulk(k) && a.waitOn && a.waitOn.delete(peer) && !a.waitOn.size) settle(k);
        } else if (msg.t === "pv" && Array.isArray(msg.v) && holder.receivePr) {
          const want = [];
          for (const row of msg.v.slice(0, 300)) {
            const id = Array.isArray(row) ? row[0] : null;
            if (typeof id !== "string" || !/^[0-9a-f]{16,32}$/.test(id) || prAsked.has(id) || (await holder.hasPr(id))) continue;
            prAsked.set(id, Date.now());
            want.push(id);
          }
          if (want.length) peer.send({ t: "pg", ids: want });
        } else if (msg.t === "pvq") {
          await sendPrs(peer);
        } else if (msg.t === "pg" && Array.isArray(msg.ids) && holder.getPr) {
          for (const id of msg.ids.slice(0, 300)) {
            const e = typeof id === "string" ? await holder.getPr(id) : null;
            if (!e) continue;
            const bytes = enc.encode(JSON.stringify(e));
            if (bytes.length > MAX_RECORD_BYTES) continue;
            const n = Math.ceil(bytes.length / CHUNK);
            for (let i = 0; i < n; i++) peer.send({ t: "pc", id, i, n, d: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
          }
        } else if (msg.t === "pc" && typeof msg.id === "string" && holder.receivePr) {
          await receivePrPiece(peer, msg);
        }
      }

      // A neighbour asked for a record this device does not hold: fetched from this device's own neighbours (all but the asker), kept, and
      // sent to every neighbour that asked meanwhile. A chapter needs its novel's list here first (to be checked against it): fetched first.
      // Only what this device would keep itself (holder.wants); the owner's devices take nothing, so they never fetch for others.
      async function pullThrough(peer, key, via, bk) {
        if (await holder.get(key)) return; // (held: queueSend sends it)
        const now = Date.now();
        const cur = relaying.get(key);
        if (cur && now - cur.at < PULL_TIMEOUT_MS) { cur.to.add(peer); return; }
        if (relaying.size >= PULL_AT_ONCE || !(await holder.wants(key, [0, 0, ""], true))) { peer.send({ t: "nf", k: [key] }); return; }
        relaying.set(key, { at: now, to: new Set([peer]) });
        try {
          if (kindOf(key) === "chapter" && bk && !(await placeOf(key))) await room.fetch("bhead:" + bk, 0, { via, exclude: peer });
          const r = await room.fetch(key, 0, { via, exclude: peer, bk });
          const waiting = relaying.get(key);
          if (waiting) for (const p of waiting.to) if (peers.has(p)) (r ? queueSend(p, [key]) : p.send({ t: "nf", k: [key] })); // (none of its own had it)
        } finally {
          relaying.delete(key);
        }
      }

      function queueSend(peer, keys) {
        peer.queue = peer.queue || [];
        // (a cover, a novel's details or list go before the chapters waiting: they are small, and what a page shows first)
        const small = keys.filter((k) => kindOf(k) !== "chapter" && !peer.queue.includes(k));
        peer.queue.unshift(...small);
        for (const k of keys) if (!peer.queue.includes(k)) peer.queue.push(k);
        if (peer.sending) return;
        peer.sending = true;
        (async () => {
          while (peer.queue.length && peers.has(peer) && !left) {
            const r = await holder.get(peer.queue.shift());
            if (!r) continue;
            const bytes = enc.encode(JSON.stringify(r));
            if (bytes.length > MAX_RECORD_BYTES) continue;
            // (its limit for the day reached: the device asking is told, so it asks others instead of waiting on this one)
            // (chapters and covers only: a novel's list and details still go, so a reader sees what is there)
            const bulk = /^(chapter|cover|bcover):/.test(r.key);
            if (bulk && opts.canSend && !(await opts.canSend(roomId, bytes.length))) { peer.queue = peer.queue.filter((k) => !/^(chapter|cover|bcover):/.test(k)); peer.send({ t: "lim" }); continue; }
            const n = Math.ceil(bytes.length / CHUNK);
            const s = stable(r.ver);
            for (let i = 0; i < n; i++) peer.send({ t: "rc", k: r.key, s, i, n, d: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
            if (opts.onSent) { try { opts.onSent(roomId, r.key, bytes.length, await bookOfKey(r.key)); } catch (e) { /* only counted */ } }
            await new Promise((res) => setTimeout(res, 0));
          }
        })().catch((e) => log("sending failed", e)).finally(() => { peer.sending = false; });
      }

      async function receivePiece(peer, msg) {
        const key = msg.k;
        if (!asked.has(key)) return; // only what was asked for
        const max = Math.ceil(MAX_RECORD_BYTES / CHUNK);
        if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > max || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string") return;
        let a = assemblies.get(key);
        if (!a || a.id !== msg.s || a.n !== msg.n) {
          if (assemblies.size >= 30) assemblies.delete(assemblies.keys().next().value);
          a = { id: msg.s, n: msg.n, parts: new Array(msg.n), got: 0 };
          assemblies.set(key, a);
        }
        if (a.parts[msg.i]) return;
        let piece;
        try { piece = unb64(msg.d); } catch (e) { return; }
        if (piece.length > CHUNK) return;
        a.parts[msg.i] = piece;
        if (++a.got < a.n) return;
        assemblies.delete(key);
        const bytes = new Uint8Array(a.parts.reduce((s, x) => s + x.length, 0));
        let at = 0;
        for (const x of a.parts) { bytes.set(x, at); at += x.length; }
        let r;
        try { r = JSON.parse(dec.decode(bytes)); } catch (e) { return; }
        if (!r || r.key !== key) return;
        // one record at a time, in the order they came: the list of devices is kept before the records it lets in are checked
        const turn = receiving.then(() => holder.receive(r));
        receiving = turn.catch(() => {});
        const res = await turn.catch(() => ({ why: "failed" }));
        const waiting = asked.get(key);
        asked.delete(key);
        if (res.stored) {
          for (const p of peers) {
            if (p === peer) continue;
            if (kindOf(key) === "chapter") {
              const at = await placeOf(key);
              const c = at && (await holder.chapterLists()).find((x) => x.bookId === at.bookId);
              if (c) p.send({ t: "hv", bk: at.bookId, hv: c.ver, i: [at.i] });
            } else p.send({ t: "vs", v: [[key, r.ver]] });
          }
          if (kindOf(key) === "bhead") for (const p of peers) sendBits(p).catch(() => {});
          // the library's profile came (whom it takes pull requests from): the ones refused for want of it are asked for again
          if (key === "profile") for (const p of peers) p.send({ t: "pvq" });
          // the list of devices came: what was refused because its device was not known yet is asked for again
          if (key === "devices") {
            for (const p of peers) {
              const want = [];
              for (const [k, v] of p.versions) if (k !== "devices" && (await holder.wants(k, v, false))) want.push(k);
              if (want.length) ask(p, want);
            }
          }
          onChange({ room: roomId, key });
        }
        if (waiting) for (const fn of waiting.resolve) fn(res.stored ? r : null);
      }

      async function receivePrPiece(peer, msg) {
        if (!prAsked.has(msg.id)) return;
        const max = Math.ceil(MAX_RECORD_BYTES / CHUNK);
        if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > max || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string") return;
        let a = prAssemblies.get(msg.id);
        if (!a || a.n !== msg.n) { a = { n: msg.n, parts: new Array(msg.n), got: 0 }; prAssemblies.set(msg.id, a); }
        if (a.parts[msg.i]) return;
        try { a.parts[msg.i] = unb64(msg.d); } catch (e) { return; }
        if (++a.got < a.n) return;
        prAssemblies.delete(msg.id);
        prAsked.delete(msg.id);
        const bytes = new Uint8Array(a.parts.reduce((s, x) => s + x.length, 0));
        let at = 0;
        for (const x of a.parts) { bytes.set(x, at); at += x.length; }
        let e;
        try { e = JSON.parse(dec.decode(bytes)); } catch (err) { return; }
        if (!e || e.id !== msg.id) return;
        const res = await holder.receivePr(e);
        if (res.stored) {
          for (const p of peers) if (p !== peer) p.send({ t: "pv", v: [[e.id, e.at]] }); // passed on
          onChange({ room: roomId, pr: e.id });
        }
      }

      const room = {
        id: roomId,
        holder,
        peers: () => [...peers],
        // the devices here that said they send nothing more today (their limit)
        limited: () => [...peers].filter((p) => p.limitedAt && Date.now() - p.limitedAt < LIMITED_MS).length,
        // The devices connected here, and the novels each has of this room's: [{ id (its peer id), books: [book id] }]. In a novel's own room,
        // that novel; in a library's room, those it said it holds chapters of, or whose list of chapters it has.
        peerBooks: () => [...peers].map((p, i) => {
          const books = new Set();
          if (holder.bookId) books.add(holder.bookId);
          for (const [bk, b] of p.bits) if (b && b.bits && b.bits.some((x) => x)) books.add(bk);
          for (const k of p.versions.keys()) if (k.startsWith("bhead:")) books.add(k.slice(6));
          return { id: String((p._wire && p._wire.peerId) || "peer" + i), books: [...books] };
        }),
        // A record asked for now (a cover, a chapter): from a device that said it has it; or, when none here did, through a few neighbours
        // that fetch it from theirs (pull-through, up to o.via devices away: PULL_HOPS by default). null when nobody gives it in time.
        // newerThan: a version time the copy kept must reach, else a newer one is asked for (a chapter the novel's list says was changed).
        // o: { via, exclude (a neighbour not to ask: the one this is fetched for), bk (the novel a chapter is of) }
        async fetch(key, newerThan, o = {}) {
          const have = await holder.get(key);
          if (have && !(newerThan && have.ver[0] < newerThan)) return have;
          const at = kindOf(key) === "chapter" ? await placeOf(key) : null;
          if (kindOf(key) === "chapter" && !at) return null; // (its novel's list is not here: it could not be checked)
          const others = [...peers].filter((p) => p !== o.exclude && !(p.limitedAt && Date.now() - p.limitedAt < LIMITED_MS));
          const holders = others.filter((p) => (at ? peerHas(p, at) : p.versions.has(key)));
          const via = o.via === undefined ? PULL_HOPS : o.via;
          let pulled = [];
          if (!holders.length) {
            if (via <= 0 || !others.length) return null;
            pulled = others.sort(() => Math.random() - 0.5).slice(0, PULL_FANOUT);
          }
          const wait = pulled.length ? PULL_TIMEOUT_MS : ASK_TIMEOUT_MS;
          return new Promise((resolve) => {
            const a = asked.get(key) || { at: 0, resolve: [] };
            a.resolve.push(resolve);
            asked.set(key, a);
            if (Date.now() - a.at > wait) {
              a.at = Date.now();
              if (pulled.length) {
                const bk = o.bk || (at ? at.bookId : idOf(key));
                a.waitOn = new Set(pulled);
                for (const p of pulled) p.send({ t: "rq", k: [key], via, bk });
              } else {
                a.at = 0;
                const p = holders[Math.floor(Math.random() * holders.length)];
                a.waitOn = new Set([p]);
                ask(p, [key]);
              }
            }
            setTimeout(() => resolve(null), wait);
          });
        },
        // Which devices here hold a chapter (for showing it: "available from 3 devices").
        async holdersOf(key) {
          const at = await placeOf(key);
          return at ? [...peers].filter((p) => peerHas(p, at)).length : 0;
        },
        // (a library room) a novel opened: its details (book:, bhead:, terms:) are asked for at once from a device that has them, and
        // whenever one says so later
        async open(bookId) {
          if (!holder.open || !holder.open(bookId)) return;
          const keys = ["book:" + bookId, "bhead:" + bookId, "terms:" + bookId];
          const listed = new Set();
          for (const p of peers) {
            const want = [];
            for (const k of keys) {
              const v = p.versions.get(k);
              if (!v) continue;
              listed.add(k);
              if (await holder.wants(k, v, false)) want.push(k);
            }
            if (want.length) ask(p, want);
          }
          // none of the devices here has them (they never opened it): through them, from theirs
          for (const k of keys) if (!listed.has(k) && peers.size && !(await holder.get(k))) room.fetch(k).catch(() => {});
        },
        // A novel removed from this device: no longer wanted here, nor said to be held.
        async forget(bookId) {
          if (holder.forget) holder.forget(bookId);
          for (const p of peers) p.send({ t: "bf", bk: bookId, hv: [0, 0, ""], b: "" }); // (none of its chapters here any more)
          await room.refresh();
        },
        // The holder changed (a novel shared, a chapter kept): the devices here are told.
        async refresh() {
          for (const p of peers) { await sendVersions(p); await sendBits(p); await sendPrs(p); }
        },
        status: () => ({ id: roomId, peers: peers.size, scope: holder.scope }),
        _setHolder(h) { holder = h; room.holder = h; },
        _start() {
          const cl = getClient();
          const name = "share-" + roomId.slice(0, 16);
          torrent = cl.seed(opts.makeSeedInput(enc.encode(roomId), name), { name, announce: opts.trackers }, (t) => {
            if (!BufferClass && t.torrentFile) BufferClass = t.torrentFile.constructor;
            // offers only when someone could take them (p2p-core.js, offerOnlyWhenNeeded); where p2p-core is not loaded, as before
            if (root.P2PCore && root.P2PCore.offerOnlyWhenNeeded) root.P2PCore.offerOnlyWhenNeeded(t);
          });
          torrent.on("wire", attach);
          torrent.on("error", (e) => log("share room error", e && e.message));
        },
        // announce now (a relay was just switched on: the next offers carry its addresses)
        _announce() {
          try { if (torrent && torrent.discovery && torrent.discovery.tracker) torrent.discovery.tracker.update(); } catch (e) { /* not started yet */ }
        },
        _leave() {
          left = true;
          try { if (torrent) torrent.destroy(); } catch (e) { /* gone */ }
          peers.clear();
        },
        // (tests, and two pages of one browser) a direct link: { send(obj) } and what comes back goes to the returned receive()
        link(sendFn) {
          const peer = new Ext({ extended: (n, payload) => sendFn(JSON.parse(typeof payload === "string" ? payload : dec.decode(payload))) });
          peer.send = (obj) => { try { sendFn(JSON.parse(JSON.stringify(obj))); } catch (e) { /* gone */ } };
          peers.add(peer);
          greet(peer).catch(() => {});
          return { receive: (msg) => onMessage(peer, msg).catch(() => {}), close: () => peers.delete(peer) };
        }
      };
      return room;
    }

    return {
      join(roomId, holder, { network = !!opts.WebTorrent } = {}) {
        if (rooms.has(roomId)) {
          const r = rooms.get(roomId);
          r._setHolder(holder);
          return r;
        }
        const room = makeRoom(roomId, holder);
        rooms.set(roomId, room);
        if (network) room._start();
        return room;
      },
      leave(roomId) {
        const r = rooms.get(roomId);
        if (!r) return;
        r._leave();
        rooms.delete(roomId);
      },
      get: (roomId) => rooms.get(roomId) || null,
      rooms: () => [...rooms.values()],
      // how many devices are connected over all the rooms (one device in two rooms counts once: its wires carry the same peer id)
      devices() {
        const ids = new Set();
        for (const r of rooms.values()) for (const p of r.peers()) ids.add((p._wire && p._wire.peerId) || p);
        return ids.size;
      },
      announceNow() {
        for (const r of rooms.values()) r._announce();
      },
      stop() {
        for (const r of rooms.values()) r._leave();
        rooms.clear();
        if (client) { try { client.destroy(); } catch (e) { /* gone */ } client = null; }
      }
    };
  }

  // ---------- other libraries' editions of your novels ----------
  // "Tell me about new chapters" (edition:<book id>: mode "notify" for a library, and the novel's key in that library, `keys`): run by the
  // extension, with no page open. A chapter an edition has past the last one you have (by your own chapter lists of the novel: its own and those
  // of the sources bound to it) is fetched from your own source and translated, the next 3 at most, each at most once a day; a chapter your
  // lists do not have yet makes them be read again (at most once an hour). The edition's list comes from its room, joined as a reader.
  //   listChapters() -> Map(chapter key -> saved at) of the chapters this device holds; fetchChapter("<chapter key>#original", meta): fetch it
  //   and translate it (p2p-host.js); readList(list page address): read a source's chapter list again
  function editionWatch({ lib, rooms, store, listChapters, fetchChapter, readList, log = () => {}, now = () => Date.now() }) {
    const ASK_AGAIN_MS = 24 * 3600 * 1000;
    const LIST_AGAIN_MS = 3600 * 1000;
    const AHEAD = 3;
    async function check() {
      const asked = [];
      if (lib.status().state !== "member") return asked;
      const have = await listChapters();
      for (const [bookId, ed] of Object.entries(lib.editions())) {
        const watched = Object.entries(ed.modes || {}).filter(([id, mode]) => mode === "notify" && ed.keys && ed.keys[id]).map(([id]) => id);
        if (!watched.length) continue;
        const bound = ((await lib.api("GET", "/api/bindings")).bindings || []).filter((b) => (b.ids || []).includes(bookId)).map((b) => b.key);
        const lists = (await lib.api("GET", "/api/chapter-index?key=" + encodeURIComponent([bookId].concat(bound).join(",")))).indexes || [];
        const rows = lists.flatMap((ix) => (ix.chapters || []).map((c) => ({ num: c[0], title: c[1], url: c[2], wtr: /^https:\/\/wtr-lab\.com\//.test(c[2]) })));
        const myMax = Math.max(0, ...rows.filter((r) => have.has("translation:" + r.url)).map((r) => r.num));
        const nameOf = async (libId) => {
          const n = ((await lib.api("GET", "/api/novels")).novels || []).find((x) => x.id === bookId);
          return (n && n.title) || ((await store.body(libId, "book:" + bookId)) || {}).title || bookId;
        };
        const wtr = /^wtr-lab:(\d+)$/.exec(bookId);
        const next = Object.assign({}, ed.asked || {});
        let changed = false;
        for (const libId of watched) {
          await store.addLink({ libId, bookId, bookKey: ed.keys[libId] });
          rooms.join(await Library.bookRoomOf(libId, ed.keys[libId]), follower({ store, libId, scope: "book", bookId }));
          const theirs = ((await store.body(libId, "bhead:" + bookId)) || { chapters: [] }).chapters || [];
          const nums = [...new Set(theirs.map((c) => c[0]).filter((n) => Number.isFinite(n) && n > myMax))].sort((a, b) => a - b).slice(0, AHEAD);
          for (const num of nums) {
            if (next[num] && now() - next[num] < ASK_AGAIN_MS) continue;
            // the chapter of that number in your own lists: a source's own first (its translation is kept at its own address)
            const row = rows.filter((r) => r.num === num).sort((a, b) => a.wtr - b.wtr)[0];
            if (row) {
              if (have.has("translation:" + row.url)) continue;
              next[num] = now();
              changed = true;
              asked.push(num);
              Promise.resolve(fetchChapter("translation:" + row.url + "#original", { translate: true, novelName: await nameOf(libId), pageTitle: row.title, wtrRawId: wtr ? wtr[1] : "" }))
                .catch((e) => log("edition chapter not fetched", num, e && e.message));
            } else if (now() - (next.list || 0) > LIST_AGAIN_MS) {
              next.list = now(); // your lists do not have it yet: read again
              changed = true;
              for (const ix of lists) if (ix.url) Promise.resolve(readList(ix.url)).catch((e) => log("list not read", e && e.message));
            }
          }
        }
        if (changed) await lib.put("edition:" + bookId, Object.assign({}, ed, { asked: next }));
      }
      return asked;
    }
    return { check };
  }

  // How much was sent to other devices, kept: { [library id]: { total, books: { [book id]: bytes } } }, written at most every few seconds.
  //   storage: { load() -> object | null, save(object) }
  const today = () => { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
  function sentTally(storage) {
    let data = null;
    let timer = null;
    const load = () => { if (!data) { try { data = storage.load() || {}; } catch (e) { data = {}; } } return data; };
    return {
      add(libId, bookId, bytes) {
        if (!libId || !(bytes > 0)) return;
        const d = load();
        const t = d[libId] || (d[libId] = { total: 0, books: {} });
        t.total += bytes;
        const day = today();
        if (t.day !== day) { t.day = day; t.today = 0; }
        t.today += bytes;
        if (bookId) t.books[bookId] = (t.books[bookId] || 0) + bytes;
        if (!timer) timer = setTimeout(() => { timer = null; try { storage.save(d); } catch (e) { /* not kept */ } }, 3000);
      },
      get: (libId) => load()[libId] || { total: 0, books: {} },
      // what was sent today (this device's own day)
      todayOf: (libId) => { const t = load()[libId]; return t && t.day === today() ? t.today || 0 : 0; },
      forget(libId) { const d = load(); delete d[libId]; try { storage.save(d); } catch (e) { /* not kept */ } }
    };
  }
  // the same in localStorage (a page, Firefox's background page, Chrome's offscreen page), else only while it runs
  function localTally(name) {
    const ls = (() => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (e) { return null; } })();
    let mem = null;
    return sentTally({ load: () => (ls ? JSON.parse(ls.getItem(name) || "null") : mem), save: (d) => { if (ls) ls.setItem(name, JSON.stringify(d)); else mem = d; } });
  }

  const ShareRooms = { sentTally, localTally, createRooms, publisher, publishing, follower, followStore, memoryAdapter, idbAdapter, madeVer, editionWatch };
  if (typeof module !== "undefined" && module.exports) module.exports = ShareRooms;
  else root.ShareRooms = ShareRooms;
})(typeof self !== "undefined" ? self : this);
