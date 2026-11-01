// What the library knows of a novel, put together from what a device holds: the novels (from the sync's index and the chapters held), a novel's
// record in the library, the keys its terms are kept under. The same code in the library site (its copy in site/vendor, by sync-vendor.js) and in
// the extension (the notifications). Uses Chapters (the site's chapters.js; the extension's build copies it).
//
//   ShareLists.novelsOf({ index, have, chapterIndex })       the novels, from the sync's index and the chapters held (Chapters.buildNovels)
//   ShareLists.infoFor(novel, records, chapterIndex)         the library's record of a novel (its title, author, cover...), or null
//   ShareLists.termKeys(novel)                               the keys its terms are kept under
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

  function novelsOf({ index, have, chapterIndex }) {
    return C().buildNovels({ index: index || {}, have: have || new Set(), chapterIndex: chapterIndex || {}, extraNovels: [] });
  }

  const api = { listAddr, hostOfUrl, sameBookUrl, indexKeysForUrl, listUrlOf, bookIdOf, infoFor, termKeys, novelsOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ShareLists = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
