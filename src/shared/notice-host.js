// Notifications from the extension, with no page of the library site open (the site has its own, bell.js, for a browser without the
// extension: this does the same here). It runs where the library is kept (Chrome's offscreen page, Firefox's background page) and looks for:
// your novels' chapters past the last one they had, and new chapters a "New chapters" watch found on a source site. Each is told once; what was there the first time a library is looked at is not news.
// What is told goes to show(): notice-bg.js, which shows it as a system notification only while no page of the site is open in this browser
// (an open page tells you itself). Those shown are kept (the last Notify.MAX), and the site's bell takes them in when it opens.
// The site's Settings › Notifications says what to tell (library-host.js op "noticeSettings"): each kind on or off, and whether the extension
// tells you at all.
//
//   NoticeHost.create({ lib, chapters, novelsOf, show, storage, now }) -> { look(what), soonChapters(), setSettings(s), list() }
//     lib()        the library (library.js) or null
//     chapters()   { getIndex(), listTranslations() } of this device, or null; novelsOf({ index, have }) -> Map of novels (ShareLists.novelsOf)
//     show(item)   -> whether it was shown; storage: { get(key), set(key, value) }; now() -> ms
(function (root) {
  const N = () => root.Notify || Notify; // (notify.js, loaded before)
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const SETTLE_MS = 60 * 1000; // what comes the first minute after a library is first looked at here is noted, not told

  function create({ lib, chapters, novelsOf, show, storage, now = () => Date.now() }) {
    const load = (k, d) => { try { const v = storage.get(k); return v == null ? d : v; } catch (e) { return d; } };
    const save = (k, v) => { try { storage.set(k, v); } catch (e) { /* kept for this run only */ } };
    let settings = load("noticeSettings", { on: true, until: 0, kinds: {}, ext: true });
    const seen = new Set(load("noticeSeen", []));
    let list = load("noticeList", []);
    // (what is known of your novels is kept under OWN: a library's id, when a library had one)
    const OWN = "library";
    const ownKnown = load("noticeOwn", {}); // OWN -> { at, last: { novel: its last chapter's number } }
    const based = new Set(load("noticeBased", [])); // what was looked at once: "wn:" + OWN

    async function tell(n, quiet) {
      if (n.key && seen.has(n.key)) return null;
      if (n.key) { seen.add(n.key); save("noticeSeen", [...seen].slice(-1000)); }
      if (quiet || settings.ext === false || !N().allowed(settings, n.kind, now())) return null;
      const item = { id: n.key, kind: n.kind, lib: n.lib || "", title: n.title, text: n.text || "", href: n.href || "", at: now(), read: false };
      let shown = false;
      try { shown = !!(await show(item)); } catch (e) { shown = false; }
      if (!shown) return null; // (a page of the site is open: it told you itself)
      list = N().add(list, item);
      save("noticeList", list);
      return item;
    }
    const base = (what) => { if (based.has(what)) return false; based.add(what); save("noticeBased", [...based]); return true; };

    // ----- what a "New chapters" watch found on a source site -----
    async function lookWatches(l) {
      const notices = ((await l.api("GET", "/api/notices").catch(() => null)) || {}).notices || [];
      const first = base("wn:" + OWN);
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
    async function lookChapters() {
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
      const was = ownKnown[OWN];
      const news = was && now() - was.at > SETTLE_MS ? N().newChapters(was.last, next) : [];
      const last = Object.assign({}, was && was.last);
      for (const [name, n] of Object.entries(next)) last[name] = Math.max(last[name] || 0, n);
      ownKnown[OWN] = { at: was ? was.at : now(), last };
      save("noticeOwn", ownKnown);
      for (const e of news.slice(0, 5)) {
        const nv = novels.get(e.name);
        const added = nv ? nv.chapters.filter((r) => !r.indexedOnly && r.num > e.from && r.num <= e.to).length : e.to - e.from;
        await tell({ key: "ch:" + OWN + ":" + e.name + ":" + e.to, kind: "chapters", lib: N().OWN, title: e.name + ": " + plural(added || 1, "new chapter"), text: "Up to chapter " + e.to + ".", href: "#/n/" + encodeURIComponent(e.name) });
      }
      if (news.length > 5) await tell({ key: "ch:" + OWN + ":more:" + now(), kind: "chapters", lib: N().OWN, title: "New chapters in " + (news.length - 5) + " more novels", text: "The Latest tab of your library lists them.", href: "#/" });
    }

    // what: "all" (every few minutes), "chapters" (after chapters were saved here)
    let busy = false;
    async function look(what = "all") {
      if (busy) return;
      busy = true;
      try {
        const l = await lib();
        if (!l) return;
        if (what === "chapters" || what === "all") await lookChapters();
        if (what === "all") await lookWatches(l);
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
        settings = { on: s.on !== false, until: Number(s.until) || 0, kinds: Object.assign({}, s.kinds), ext: s.ext !== false };
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

  // In the extension: next to the library (library-host.js).
  if (typeof module === "undefined" && typeof LibraryHost !== "undefined") {
    const ext = typeof browser !== "undefined" ? browser : chrome;
    const ls = (() => { try { return localStorage; } catch (e) { return null; } })();
    const mem = {};
    const host = create({
      lib: () => LibraryHost.ready,
      chapters: () => LibraryHost.chapters || null,
      novelsOf: typeof ShareLists !== "undefined" ? ShareLists.novelsOf : null,
      // Firefox: this is the background page, which shows it; Chrome: the service worker does (an offscreen page cannot)
      show: (item) => (typeof NoticeBg !== "undefined" ? NoticeBg.show(item) : ext.runtime.sendMessage({ type: "notice:show", item }).then((r) => !!(r && r.shown))),
      storage: { get: (k) => (ls ? JSON.parse(ls.getItem(k) || "null") : mem[k]), set: (k, v) => (ls ? ls.setItem(k, JSON.stringify(v)) : (mem[k] = v)) }
    });
    root.NoticeHost.host = host;
    setTimeout(() => host.look("all").catch(() => {}), 20 * 1000);
    setInterval(() => host.look("all").catch(() => {}), 2 * 60 * 1000);
  }
})(typeof self !== "undefined" ? self : this);
