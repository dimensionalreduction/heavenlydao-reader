// Notifications from the extension, with no page of the library site open (the site has its own, bell.js, for a browser without the
// extension: this does the same here). It runs where the library is kept (Chrome's offscreen page, Firefox's background page) and looks for:
// a device asking to join your library (on the device that lets new ones in), a device joined or taken off, pull requests to your library,
// your novels' chapters past the last one they had, the new novels and chapters of the libraries you follow, and new chapters a "New chapters"
// watch found on a source site. Each is told once; what was there the first time a library is looked at is not news.
// What is told goes to show(): notice-bg.js, which shows it as a system notification only while no page of the site is open in this browser
// (an open page tells you itself). Those shown are kept (the last Notify.MAX), and the site's bell takes them in when it opens.
// The site's Settings › Notifications says what to tell (library-host.js op "noticeSettings"): each kind and each library on or off, and
// whether the extension tells you at all.
//
//   NoticeHost.create({ lib, follows, chapters, novelsOf, show, storage, now }) -> { look(what), soonChapters(), setSettings(s), list() }
//     lib()        the library (library.js) or null; follows: { follows(), body(libId, key) } (follow-host.js's store) or null
//     chapters()   { getIndex(), listTranslations() } of this device, or null; novelsOf({ index, have }) -> Map of novels (ShareLists.novelsOf)
//     show(item)   -> whether it was shown; storage: { get(key), set(key, value) }; now() -> ms
(function (root) {
  const N = () => root.Notify || Notify; // (notify.js, loaded before)
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const SETTLE_MS = 60 * 1000; // what comes the first minute after a library is first looked at here is noted, not told

  function create({ lib, follows, chapters, novelsOf, show, storage, now = () => Date.now() }) {
    const load = (k, d) => { try { const v = storage.get(k); return v == null ? d : v; } catch (e) { return d; } };
    const save = (k, v) => { try { storage.set(k, v); } catch (e) { /* kept for this run only */ } };
    let settings = load("noticeSettings", { on: true, until: 0, kinds: {}, libs: {}, ext: true });
    const seen = new Set(load("noticeSeen", []));
    let list = load("noticeList", []);
    const devicesKnown = load("noticeDevices", {}); // library id -> { device id: name }
    const headsKnown = load("noticeHeads", {}); // followed library id -> { book id: chapters in its list }
    const ownKnown = load("noticeOwn", {}); // library id -> { at, last: { novel: its last chapter's number } }
    const based = new Set(load("noticeBased", [])); // what was looked at once: "pr:<lib>", "wn:<lib>"

    async function tell(n, quiet) {
      if (n.key && seen.has(n.key)) return null;
      if (n.key) { seen.add(n.key); save("noticeSeen", [...seen].slice(-1000)); }
      if (quiet || settings.ext === false || !N().allowed(settings, n.kind, n.lib, now())) return null;
      const item = { id: n.key, kind: n.kind, lib: n.lib || "", title: n.title, text: n.text || "", href: n.href || "", at: now(), read: false, join: n.join || null };
      let shown = false;
      try { shown = !!(await show(item)); } catch (e) { shown = false; }
      if (!shown) return null; // (a page of the site is open: it told you itself)
      list = N().add(list, item);
      save("noticeList", list);
      return item;
    }
    const base = (what) => { if (based.has(what)) return false; based.add(what); save("noticeBased", [...based]); return true; };

    // ----- your library: requests to join, your devices -----
    async function lookDevices(l, st) {
      // a request to join: answered here when this is the main device; else said, with where it is answered (the main device's Settings ›
      // Library: often the site's page in this same browser, which a click opens)
      const main = (st.devices || []).find((d) => d.main);
      const pending = st.main ? st.joins || [] : st.asking || [];
      for (const j of pending) {
        await tell({ key: "join:" + st.libId + ":" + j.id, kind: "join", lib: N().OWN, title: "“" + j.name + "” asks to join your library",
          text: st.main ? "Allow it, and it gets your library and can change it." : "Allow it on your main device" + (main ? " (" + main.name + ")" : "") + ": Settings › Library.",
          href: "#/settings/library", join: { id: j.id, name: j.name, elsewhere: !st.main } });
      }
      const asking = new Set(pending.map((j) => j.id));
      if (list.some((x) => x.join && !x.join.done && !asking.has(x.join.id))) {
        list = list.map((x) => (x.join && !x.join.done && !asking.has(x.join.id) ? Object.assign({}, x, { join: Object.assign({}, x.join, { done: "answered" }) }) : x));
        save("noticeList", list);
      }
      const cur = {};
      for (const d of st.devices || []) cur[d.id] = d.name;
      const was = devicesKnown[st.libId];
      if (JSON.stringify(was) === JSON.stringify(cur)) return;
      devicesKnown[st.libId] = cur;
      save("noticeDevices", devicesKnown);
      if (!was) return;
      for (const [id, name] of Object.entries(cur)) {
        if (!(id in was)) await tell({ key: "dev+:" + st.libId + ":" + id, kind: "devices", lib: N().OWN, title: "“" + name + "” joined your library", text: "It gets your novels, glossaries and terms, and can change them.", href: "#/settings/library" });
      }
      for (const [id, name] of Object.entries(was)) {
        if (!(id in cur)) await tell({ key: "dev-:" + st.libId + ":" + id, kind: "devices", lib: N().OWN, title: "“" + name + "” was taken off your library", text: "It reads nothing written after.", href: "#/settings/library" });
      }
    }

    // ----- pull requests to your library -----
    async function lookPrs(l, st) {
      if (!st.sharing) return;
      const all = (await l.inbox().catch(() => null)) || [];
      const first = base("pr:" + st.libId);
      const books = (await l.sharedBooks().catch(() => null)) || {};
      for (const pr of all.filter((x) => !x.done)) {
        const b = pr.body || {};
        const book = books[pr.book] || {};
        await tell({ key: "pr:" + pr.id, kind: "pr", lib: N().OWN, title: "Pull request from " + (b.name || "a reader"), text: (book.title ? book.title + ": " : "") + "their changes, for you to take or not.", href: "#/inbox" }, first);
      }
    }

    // ----- what a "New chapters" watch found on a source site -----
    async function lookWatches(l, st) {
      const notices = ((await l.api("GET", "/api/notices").catch(() => null)) || {}).notices || [];
      const first = base("wn:" + st.libId);
      const fresh = notices.filter((x) => !x.seen);
      if (!fresh.length) return;
      const records = ((await l.api("GET", "/api/novels").catch(() => null)) || {}).novels || [];
      for (const x of fresh) {
        const r = records.find((n) => n.id === x.novel) || {};
        const span = x.firstNum && x.lastNum ? (x.firstNum === x.lastNum ? "Chapter " + x.lastNum : "Chapters " + x.firstNum + " to " + x.lastNum) : "";
        await tell({ key: "wn:" + x.id, kind: "chapters", lib: N().OWN, title: (r.title || x.novel) + ": " + plural(x.count || 1, "new chapter") + " on " + x.source,
          text: span ? span + "." : "Found on " + x.source + ".", href: "#/n/" + encodeURIComponent(x.novel) + "/novel" }, first);
      }
    }

    // ----- your novels: chapters past the last one each had -----
    async function lookChapters(st) {
      const ch = chapters && chapters();
      if (!ch || !novelsOf) return;
      const index = (await ch.getIndex()) || {};
      const have = new Set(((await ch.listTranslations()) || []).filter(([, e]) => e && e.translated).map(([k]) => k));
      const novels = novelsOf({ index, have });
      const next = {};
      for (const n of novels.values()) {
        let last = 0;
        for (const r of n.chapters) if (!r.indexedOnly && Number.isFinite(r.num) && r.num > last) last = r.num;
        next[n.name] = last;
      }
      const was = ownKnown[st.libId];
      const news = was && now() - was.at > SETTLE_MS ? N().newChapters(was.last, next) : [];
      const last = Object.assign({}, was && was.last);
      for (const [name, n] of Object.entries(next)) last[name] = Math.max(last[name] || 0, n);
      ownKnown[st.libId] = { at: was ? was.at : now(), last };
      save("noticeOwn", ownKnown);
      for (const e of news.slice(0, 5)) {
        const nv = novels.get(e.name);
        const added = nv ? nv.chapters.filter((r) => !r.indexedOnly && r.num > e.from && r.num <= e.to).length : e.to - e.from;
        await tell({ key: "ch:" + st.libId + ":" + e.name + ":" + e.to, kind: "chapters", lib: N().OWN, title: e.name + ": " + plural(added || 1, "new chapter"), text: "Up to chapter " + e.to + ".", href: "#/n/" + encodeURIComponent(e.name) });
      }
      if (news.length > 5) await tell({ key: "ch:" + st.libId + ":more:" + now(), kind: "chapters", lib: N().OWN, title: "New chapters in " + (news.length - 5) + " more novels", text: "The Latest tab of your library lists them.", href: "#/" });
    }

    // ----- the libraries you follow -----
    async function lookFollowed() {
      if (!follows) return;
      const followed = (await follows.follows()).filter((f) => f.readKey && f.followed !== false);
      let changed = false;
      for (const f of followed) {
        const head = await follows.body(f.libId, "head");
        if (!head || !head.books) continue;
        const next = {};
        for (const [id, b] of Object.entries(head.books)) next[id] = { title: b.title || id, n: Number(b.n) || 0 };
        const news = N().newInLibrary(headsKnown[f.libId] || null, next);
        const counts = Object.fromEntries(Object.entries(next).map(([id, b]) => [id, b.n]));
        if (JSON.stringify(counts) !== JSON.stringify(headsKnown[f.libId])) { headsKnown[f.libId] = counts; changed = true; }
        const name = f.name || "A library you follow";
        const link = "#/following/" + encodeURIComponent(f.libId);
        const bookLink = (id) => "#/fb/" + encodeURIComponent(f.libId) + "/" + encodeURIComponent(id); // (the site's address of a followed novel)
        for (const e of news.slice(0, 5)) {
          await tell(e.type === "novel"
            ? { key: "fl:" + f.libId + ":" + e.id, kind: "follow", lib: f.libId, title: "New in " + name + ": " + e.title, text: plural(e.added, "chapter"), href: bookLink(e.id) }
            : { key: "fl:" + f.libId + ":" + e.id + ":" + next[e.id].n, kind: "follow", lib: f.libId, title: e.title + ": " + plural(e.added, "new chapter"), text: "In " + name, href: bookLink(e.id) });
        }
        if (news.length > 5) await tell({ key: "fl:" + f.libId + ":more:" + now(), kind: "follow", lib: f.libId, title: name + ": " + (news.length - 5) + " more novels are new or have new chapters", href: link });
      }
      for (const id of Object.keys(headsKnown)) if (!followed.some((f) => f.libId === id)) { delete headsKnown[id]; changed = true; }
      if (changed) save("noticeHeads", headsKnown);
    }

    // what: "devices" (every few seconds), "all" (every few minutes), "chapters" (after chapters were saved here)
    let busy = false;
    async function look(what = "all") {
      if (busy) return;
      busy = true;
      try {
        const l = await lib();
        const st = l && l.status();
        if (!st || st.state !== "member") return;
        if (what === "devices" || what === "all") await lookDevices(l, st);
        if (what === "chapters" || what === "all") await lookChapters(st);
        if (what === "all") {
          await lookPrs(l, st);
          await lookWatches(l, st);
          await lookFollowed();
        }
      } finally {
        busy = false;
      }
    }
    let soon = null;
    return {
      look,
      // chapters were saved here (they come in batches): looked at a little later
      soonChapters() {
        if (!soon) soon = setTimeout(() => { soon = null; look("chapters").catch(() => {}); }, 30 * 1000);
      },
      setSettings(s) {
        if (!s || typeof s !== "object") return settings;
        settings = { on: s.on !== false, until: Number(s.until) || 0, kinds: Object.assign({}, s.kinds), libs: Object.assign({}, s.libs), ext: s.ext !== false };
        save("noticeSettings", settings);
        return settings;
      },
      settings: () => settings,
      // those shown (the site's bell takes them in when it opens)
      list: () => list
    };
  }

  const NoticeHost = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = NoticeHost;
  root.NoticeHost = NoticeHost;

  // In the extension: next to the library (library-host.js) and the libraries you follow (follow-host.js).
  if (typeof module === "undefined" && typeof LibraryHost !== "undefined") {
    const ext = typeof browser !== "undefined" ? browser : chrome;
    const ls = (() => { try { return localStorage; } catch (e) { return null; } })();
    const mem = {};
    const host = create({
      lib: () => LibraryHost.ready,
      follows: typeof FollowHost !== "undefined" ? FollowHost._store : null,
      chapters: () => LibraryHost.chapters || null,
      novelsOf: typeof ShareLists !== "undefined" ? ShareLists.novelsOf : null,
      // Firefox: this is the background page, which shows it; Chrome: the service worker does (an offscreen page cannot)
      show: (item) => (typeof NoticeBg !== "undefined" ? NoticeBg.show(item) : ext.runtime.sendMessage({ type: "notice:show", item }).then((r) => !!(r && r.shown))),
      storage: { get: (k) => (ls ? JSON.parse(ls.getItem(k) || "null") : mem[k]), set: (k, v) => (ls ? ls.setItem(k, JSON.stringify(v)) : (mem[k] = v)) }
    });
    root.NoticeHost.host = host;
    setTimeout(() => host.look("all").catch(() => {}), 20 * 1000);
    setInterval(() => host.look("devices").catch(() => {}), 15 * 1000);
    setInterval(() => host.look("all").catch(() => {}), 2 * 60 * 1000);
  }
})(typeof self !== "undefined" ? self : this);
