// The libraries you follow, looked after by the extension too, with no page open (docs/SHARED-LIBRARIES.md, "Keep this library available").
// The library site's tab in this browser tells it which ones you follow, which you keep available and their limits (library-host.js op
// "follows", from sharing.js). The extension is then in the rooms of the ones kept and of the 20 newest others, so their lists stay current
// here; it fetches the kept novels whole, and their new chapters every 5 minutes, and passes them on as any reader does. The same limits as on
// the site: what a library keeps here (its own, else the default), all of them together, and what is sent their readers a day.
// library-host.js gives it the rooms it publishes in (attach), once the extension is in a library.
(function () {
  if (typeof ShareRooms === "undefined" || typeof Library === "undefined") return;
  const GB = 1024 ** 3;
  const DETAILS_OVER = 50 * 1024 * 1024; // (a library's lists and details may go this far past its limit, no further: as on the site)
  const KEEP_EVERY_MS = 5 * 60 * 1000;
  const NEWEST = 20;
  const log = (...a) => console.debug("[follow]", ...a);

  const store = ShareRooms.followStore(ShareRooms.idbAdapter("p2p-read-ext-follows"));
  let defaults = { store: 5 * GB, out: 50 * GB, total: 20 * GB };
  let rooms = null;
  let tally = null; // what was sent each library's readers (library-host.js's "seeded")
  const roomLib = new Map(); // room id -> library id
  const joined = new Map(); // library id -> { id, room }
  const runs = new Map(); // library id -> { running, got, missed, stop, capped }
  let timer = null;

  const capsOf = (f) => Object.assign({}, defaults, (f && f.caps) || {});
  const isBulkKey = (key) => !key || /^(chapter|cover|bcover):/.test(key);
  const kept = (f) => !!((f.keep && f.keep.on) || (f.fork && f.fork.on));
  async function allHeld() {
    let n = 0;
    for (const f of await store.follows()) n += await store.heldBytes(f.libId);
    return n;
  }
  // May no more of this library's records be kept here? (key: the record asked; none: chapters)
  async function full(libId, key) {
    const f = await store.follow(libId);
    if (!f) return true;
    const over = isBulkKey(key) ? 0 : DETAILS_OVER;
    if ((await store.heldBytes(libId)) >= capsOf(f).store + over) return true;
    return (await allHeld()) >= defaults.total + over;
  }

  async function roomOf(libId) {
    if (!rooms) return null;
    const f = await store.follow(libId);
    if (!f || !f.readKey) return null;
    const { libRoom } = await Library.shareKeys(libId, f.readKey);
    const cur = joined.get(libId);
    if (cur && cur.id === libRoom) return cur.room;
    roomLib.set(libRoom, libId);
    const room = rooms.join(libRoom, ShareRooms.follower({ store, libId, scope: "lib", full: (key) => full(libId, key) }));
    joined.set(libId, { id: libRoom, room });
    return room;
  }

  // One novel whole: its details, its list, its terms, then each chapter not here yet, 4 at a time (as "Download whole library" on the site).
  async function fetchNovel(libId, bookId, run) {
    const room = await roomOf(libId);
    if (!room) return false;
    await room.open(bookId);
    for (const k of ["book:", "bhead:", "terms:"]) if (!(await store.get(libId, k + bookId))) await room.fetch(k + bookId);
    const head = await store.body(libId, "bhead:" + bookId);
    if (!head) return false; // (nobody online has it now)
    const todo = [];
    for (const c of head.chapters || []) if (!(await store.get(libId, "chapter:" + c[2]))) todo.push("chapter:" + c[2]);
    for (let i = 0; i < todo.length && !run.stop; i += 4) {
      if (await full(libId)) { run.capped = true; break; }
      const got = await Promise.all(todo.slice(i, i + 4).map((k) => room.fetch(k)));
      for (const g of got) (g ? run.got++ : run.missed++);
    }
    return true;
  }

  let soonTimer = null;
  const soon = () => { if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = null; look().catch(() => {}); }, 15000); };

  // Now and every KEEP_EVERY_MS: the rooms of the libraries kept and the 20 newest others (the rest left), the kept novels fetched.
  let lookedAt = 0;
  async function look() {
    if (!rooms) return;
    lookedAt = Date.now();
    const list = (await store.follows()).filter((f) => f.readKey && f.followed !== false).sort((a, b) => b.at - a.at);
    const want = list.filter(kept).concat(list.filter((f) => !kept(f)).slice(0, NEWEST));
    const wantIds = new Set(want.map((f) => f.libId));
    for (const [libId, { id }] of joined) {
      if (wantIds.has(libId)) continue;
      rooms.leave(id);
      joined.delete(libId);
      roomLib.delete(id);
    }
    for (const f of want) await roomOf(f.libId).catch((e) => log("room not joined", f.libId, e && e.message));
    for (const f of list) {
      if (!f.keep || !f.keep.on) continue;
      const cur = runs.get(f.libId);
      if (cur && cur.running) continue;
      const head = await store.body(f.libId, "head");
      if (!head) { soon(); continue; } // (its list comes first: its room is joined; looked at again shortly)
      const ids = Object.keys(head.books || {}).filter((id) => !f.keep.books || f.keep.books.includes(id));
      const run = { running: true, got: 0, missed: 0, stop: false, capped: false };
      runs.set(f.libId, run);
      (async () => { for (const id of ids) { if (run.stop || run.capped) break; await fetchNovel(f.libId, id, run).catch(() => {}); } })()
        .finally(() => { run.running = false; });
    }
  }

  self.FollowHost = {
    // the rooms library-host.js publishes in, and its tally of what was sent: from then on, looked at now and every 5 minutes
    attach(r, sent) {
      rooms = r;
      tally = sent;
      look().catch((e) => log("look failed", e && e.message));
      if (!timer) timer = setInterval(() => look().catch((e) => log("look failed", e && e.message)), KEEP_EVERY_MS);
    },
    // What the site's tab follows: [{ libId, readKey, books, name, at, followed, keep, caps, fork }], and the default limits. Follows not in
    // the list are dropped (what they held stays until their limits are needed by others: it is not looked at any more).
    async set(list, dflt) {
      if (dflt && typeof dflt === "object") defaults = Object.assign({ store: 5 * GB, out: 50 * GB, total: 20 * GB }, dflt);
      const now = new Set();
      for (const f of Array.isArray(list) ? list : []) {
        if (!f || typeof f.libId !== "string" || !f.libId || f.libId.length > 100) continue;
        now.add(f.libId);
        const { libId, readKey, books, name, at, followed, keep, caps, fork } = f;
        await store.adapter.putFollow({ libId, readKey: readKey || undefined, books: books || {}, name: String(name || ""), at: Number(at) || Date.now(), followed, keep: keep || null, caps: caps || null, fork: fork || null });
      }
      for (const f of await store.follows()) if (!now.has(f.libId)) await store.unfollow(f.libId);
      look().catch((e) => log("look failed", e && e.message));
      return { follows: now.size };
    },
    libOf: (roomId) => roomLib.get(roomId) || null,
    // may `bytes` more go to this library's readers today?
    async canSend(libId, bytes) {
      return !tally || tally.todayOf(libId) + bytes <= capsOf(await store.follow(libId)).out;
    },
    // for the popup: how many libraries are followed and kept here, and what they take
    look, // (tests)
    _store: store,
    // when the kept libraries' new chapters are fetched next (the site's Activity › Upcoming): its last look, how often, the next, and which are kept
    async schedule() {
      const kept = (await store.follows()).filter((f) => f.followed !== false && f.keep && f.keep.on).map((f) => ({ libId: f.libId, name: f.name || "", books: f.keep.books || null }));
      return { at: lookedAt, every: KEEP_EVERY_MS, next: timer && lookedAt ? lookedAt + KEEP_EVERY_MS : 0, kept };
    },
    async status() {
      const list = (await store.follows()).filter((f) => f.followed !== false);
      let held = 0;
      for (const f of list) held += await store.heldBytes(f.libId);
      return { follows: list.length, kept: list.filter((f) => f.keep && f.keep.on).length, rooms: joined.size, held };
    }
  };
})();
