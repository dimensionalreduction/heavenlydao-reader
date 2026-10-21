// The lists of the novels a library shares with its readers (`sbook:<book id>` in the library: a novel's details, and [number, title, chapter
// key, when it was saved] for each chapter its devices hold), made from what a device holds. The same code in the library site (its copy in
// site/vendor, by sync-vendor.js) and in the extension (library-host.js), so the lists stay current with or without a page of the site open.
// Uses Chapters (the site's chapters.js; the extension's build copies it).
//
//   ShareLists.novelsOf({ index, have, chapterIndex })       the novels, from the sync's index and the chapters held (Chapters.buildNovels)
//   ShareLists.infoFor(novel, records, chapterIndex)         the library's record of a novel (its title, author, cover...), or null
//   ShareLists.manifest(novel, records, chapterIndex)        what its readers get
//   ShareLists.write({ novels, books, rule, records, chapterIndex, put })   the lists brought up to date: each written together with the one the
//     library has (Chapters.mergeShareList: nothing taken away), and, with every novel shared, the novels with chapters not shared yet added;
//     only what changed is written. put(id, list). Answers how many were written.
(function (root) {
  const C = () => root.Chapters;
  const listAddr = (u) => String(u || "").replace(/^https:\/\/www\./, "https://").replace(/\/+$/, "");
  const hostOfUrl = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  };
  // Is this list the one of that book? Its address is the same, or (a book's info page and its list page differ: /book/74649.htm, /book/74649/)
  // it is on the same site and names the same book number.
  function sameBookUrl(a, b) {
    if (listAddr(a) === listAddr(b)) return true;
    const part = (u) => { try { const x = new URL(u); return [x.hostname.replace(/^www\./, ""), (/\d{3,}/.exec(x.pathname) || [])[0]]; } catch (e) { return [null, null]; } };
    const [ha, na] = part(a);
    const [hb, nb] = part(b);
    return !!ha && ha === hb && !!na && na === nb;
  }
  const indexKeysForUrl = (chapterIndex, url) => Object.entries(chapterIndex || {}).filter(([, v]) => v && v.url && sameBookUrl(v.url, url)).map(([k]) => k);
  // the address a recorded book's chapter list is read from: its list page, or (older records) the book's own page
  const listUrlOf = (n) => (n && (n.listUrl || n.url)) || "";

  function bookIdOf(novel) {
    if (novel.book) return novel.book; // (a novel is one source's book)
    const wtr = [...(novel.wtrIds || [])].sort()[0];
    if (wtr) return wtr;
    const v = C().allVersions(novel).find((x) => !C().isWtr(x.key));
    return (v && C().bindingKeyOfChapter(v.key)) || "name:" + novel.name;
  }

  function infoFor(novel, records, chapterIndex) {
    const list = records || [];
    if (C().isUploadNovel(novel)) return list.find((n) => "record:" + n.id === novel.book) || null; // an uploaded EPUB's own record
    if (novel.wtrIds && novel.wtrIds.size) return list.find((n) => novel.wtrIds.has(n.id)) || null;
    const site = (n) => n && n.source && n.source !== "wtr-lab";
    const hosts = new Set(C().allVersions(novel).map((v) => v.host));
    return list.find((n) => site(n) && "record:" + n.id === novel.book)
      || list.find((n) => site(n) && listUrlOf(n) && indexKeysForUrl(chapterIndex, listUrlOf(n)).includes(novel.book))
      // (its chapter list not read yet: the record of its site with its title)
      || list.find((n) => site(n) && n.title === (novel.baseName || novel.name) && hosts.has(hostOfUrl(listUrlOf(n) || n.url || ""))) || null;
  }

  // the keys a novel's terms are kept under: its the site ids, and the binding key of each source it is read from
  function termKeys(novel) {
    const keys = new Set(novel.wtrIds);
    for (const v of C().allVersions(novel)) {
      if (C().isWtr(v.key)) continue;
      const k = C().bindingKeyOfChapter(v.key);
      if (k) keys.add(k);
    }
    return [...keys];
  }

  // What readers of a novel get: its details, and the chapters held of its main list.
  function manifest(novel, records, chapterIndex) {
    const info = infoFor(novel, records, chapterIndex) || {};
    const chapters = novel.chapters.filter((r) => r.have).map((r) => {
      const v = r.versions.find((x) => x.key === r.key && x.have) || r.versions.find((x) => x.have);
      return [r.num, r.title, v.key, v.savedAt || 0];
    });
    return {
      title: info.title || novel.name, author: info.author || "", authorRaw: info.authorRaw || "", rawTitle: info.rawTitle || "", names: (info.names || []).slice(0, 10),
      synopsis: String(info.synopsis || "").slice(0, 3000), cover: info.cover || "", genres: (info.genres || []).slice(0, 12), tags: (info.tags || []).slice(0, 20),
      status: info.status || "", rawStatus: info.rawStatus || "", rating: info.rating || 0, views: info.views || 0, source: info.source || "", url: info.url || "",
      sources: (novel.sources || []).slice(0, 10), keys: termKeys(novel), coverId: info.coverCopy ? info.id : "", chapters
    };
  }

  function novelsOf({ index, have, chapterIndex }) {
    return C().buildNovels({ index: index || {}, have: have || new Set(), chapterIndex: chapterIndex || {}, extraNovels: [] });
  }

  async function write({ novels, books, rule, records, chapterIndex, put, stable }) {
    const { all, off } = rule || {};
    if (!all && !Object.keys(books || {}).length) return 0;
    const same = stable || ((a, b) => JSON.stringify(a) === JSON.stringify(b));
    const stopped = new Set(off || []);
    let written = 0;
    for (const n of novels.values()) {
      const id = bookIdOf(n);
      if (books[id] && books[id].layer) continue; // (your version of someone's novel is kept by its own page: shareVersion)
      if (!books[id] && !(all && !stopped.has(id) && n.chapters.some((r) => r.have))) continue;
      const m = C().mergeShareList(manifest(n, records, chapterIndex), books[id] || null);
      if (!same(m, books[id] || null)) {
        try {
          await put(id, m);
          written++;
        } catch (e) {
          // (not written now: with the next change)
        }
      }
    }
    return written;
  }

  const api = { listAddr, hostOfUrl, sameBookUrl, indexKeysForUrl, listUrlOf, bookIdOf, infoFor, termKeys, manifest, novelsOf, write };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ShareLists = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
