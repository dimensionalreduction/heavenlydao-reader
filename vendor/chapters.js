// Turns the flat list of cached chapters (from every source) into novels with one row per chapter number.
//
// A chapter is cached under its own URL, so the same chapter read from two sources is two entries:
//   translation:https://www.69shuba.com/txt/77582/38804613     your Gemini translation of the raw chapter
//   translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-1     the site's own English
// Novels are first grouped by the name stored with each chapter, then groups that belong to the same the site novel are merged:
// a site chapter says which novel it is (/novel/8053/), and a 69shuba chapter says so through the glossary you bound to it
// (binding "69shuba.com/txt/77582" -> "wtr-lab:8053"). Chapters of a merged novel are matched by chapter number, which is
// right when the sources number their chapters the same way (true for this novel); chapters without a number stay on their own.
(function (root) {
  const ORIGINAL = "#original";
  // A chapter in another language than English is its own entry beside the chapter's, "<chapter key>#lang=<code>" (the chapter key holds the English one): a
  // version of the same chapter, listed with it, not a chapter of its own (the same as P2PCore.langKey in the extension).
  const LANG_KEY = /#lang=([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/;
  const langOf = (key) => { const m = LANG_KEY.exec(String(key || "")); return m ? m[1] : ""; };
  const baseKeyOf = (key) => String(key || "").replace(LANG_KEY, "");
  const isBad = (s) => !s || s.includes("�");
  const cleanName = (s) => (isBad(s) ? "Unknown novel" : s);
  function cleanTitle(s, key) {
    if (!isBad(s)) return s;
    const last = key.split("/").pop().replace(/\.\w+$/, "");
    return "Chapter " + last;
  }

  // Page titles come from a reader site's <title>: "Novel Name-Chapter 6 Some Title-69 Book Bar". Reduce that to the chapter's own
  // title in the same form the site uses ("Chapter 6: Some Title") so every source reads alike in the list.
  function tidyTitle(title, novelName) {
    let t = String(title).trim();
    if (novelName) {
      const esc = String(novelName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // match the name literally
      t = t.replace(new RegExp("^" + esc + "\\s*[-–—:|]\\s*", "i"), "");
    }
    t = t.replace(/\s*[-–—|]\s*(69\s*book\s*bar|69\s*shuba|69书吧)\s*$/i, "");
    // Some sites put everything in the page title, joined with "_" or "|": "<novel>_Chapter 1 <name>_Free novel reading_<site>" (uuread).
    // Keep the part that is the chapter ("Chapter N ..."), and drop a trailing part marker like "(1 / 2)".
    const startsWithChapter = /^(chapter|ch\.?|episode|ep\.?)\s*\d+/i;
    const parts = t.split(/\s*[_|]\s*/);
    if (parts.length > 1 && !startsWithChapter.test(t)) {
      const chapter = parts.find((p) => startsWithChapter.test(p.trim()));
      if (chapter) t = chapter.trim();
    }
    t = t.replace(/\s*[（(]\s*\d+\s*\/\s*\d+\s*[）)]\s*$/, "");
    t = t.replace(/^(Chapter\s*\d+)\s+(?![:：])(.+)$/i, "$1: $2");
    return t || String(title);
  }

  // Pulls a chapter number out of titles like "第4章 …", "Chapter 12: …", "Ch. 7".
  function chapterNumber(title) {
    const m = /第\s*(\d+)\s*[章节回]/.exec(title) || /(?:chapter|ch\.?|ep(?:isode)?\.?)\s*(\d+)/i.exec(title);
    return m ? Number(m[1]) : null;
  }

  // A chapter of an uploaded EPUB: "<its page's address>#up=<upload id>.<its place in the book>", or, for a book that doesn't say where its
  // chapters come from, an address that is never fetched ("https://<upload id>.epub.invalid/ch/<n>"). An upload is a copy of its own: its keys
  // are never a site's, so it never mixes with the same novel read from the site (an older copy may have other chapters, or another source).
  const UPLOAD = /#up=([0-9a-f]{8,64})\.(\d+)$/;
  function uploadOf(key) {
    const m = UPLOAD.exec(String(key || ""));
    return m ? { id: m[1], n: Number(m[2]) } : null;
  }
  function uploadKey(id, n, pageUrl) {
    const url = /^https?:\/\/[^\s#]+/.exec(String(pageUrl || ""));
    return "translation:" + (url && url[0].length < 1500 ? url[0] : "https://" + id + ".epub.invalid/ch/" + n) + "#up=" + id + "." + n;
  }
  const UPLOAD_LABEL = "Local upload";

  const hostOf = (key) => {
    try {
      return new URL(key.replace(/^translation:/, "")).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  };
  const LABELS = { "wtr-lab.com": "wtr-lab", "69shuba.com": "69shuba" };
  const sourceLabel = (key) => (uploadOf(key) ? UPLOAD_LABEL : LABELS[hostOf(key)] || hostOf(key));
  const isWtr = (key) => hostOf(key) === "wtr-lab.com" && !uploadOf(key);

  // "wtr-lab:8053" for a site chapter URL, else null.
  function wtrIdOf(key) {
    if (uploadOf(key)) return null;
    const m = /^translation:https:\/\/wtr-lab\.com\/[^/]+\/novel\/(\d+)\//.exec(key);
    return m ? "wtr-lab:" + m[1] : null;
  }

  // "69shuba.com/txt/77582" for a chapter key: the same site + URL-directory key the extension uses to bind a glossary to a novel.
  function bindingKeyOfChapter(key) {
    const up = uploadOf(key);
    if (up) return "upload:" + up.id;
    try {
      const u = new URL(key.replace(/^translation:/, ""));
      return u.hostname.replace(/^www\./, "") + (u.pathname.replace(/\/[^/]*$/, "") || "/");
    } catch (e) {
      return null;
    }
  }

  // Which source to read from first: the one you picked for this novel, then the site, then the rest alphabetically.
  const sourceRank = (label, pref) => (pref && pref !== "auto" && label === pref ? 0 : label === "wtr-lab" ? 1 : 2);
  // A title like "Chapter 3: Name" reads better than a translated page title ("... - 69 Book Bar").
  const titleScore = (t) => (/^Chapter\s*\d+\s*[:：.\-–]/i.test(t) ? 1 : 0);

  function makeRow(num, versions, pref, originals) {
    const vs = versions.slice().sort((a, b) => sourceRank(a.source, pref) - sourceRank(b.source, pref) || a.source.localeCompare(b.source) || b.savedAt - a.savedAt);
    const pick = vs.find((v) => v.have) || vs.find((v) => !v.indexedOnly) || vs[0];
    const titled = vs.slice().sort((a, b) => titleScore(b.title) - titleScore(a.title))[0];
    return {
      id: num != null ? "n" + num : "k:" + vs[0].key,
      num,
      title: titled.title,
      versions: vs,
      have: vs.some((v) => v.have),
      indexedOnly: vs.every((v) => v.indexedOnly), // known from a site's chapter list, but nobody has translated it yet
      key: pick.key, // what opens when the row is clicked: the preferred source's copy, or any copy you have
      source: pick.source,
      haveRaw: !!originals && vs.every((v) => v.indexedOnly) && originals.has(vs[0].key + ORIGINAL),
      rawKey: vs.every((v) => v.indexedOnly) ? vs[0].key + ORIGINAL : null, // where this chapter's original text lives, if nobody translated it
      savedAt: Math.max(0, ...vs.map((v) => v.savedAt))
    };
  }

  // A novel is one source's book: a site novel ("wtr-lab:8053"), or a site's book (its site + directory, "69shuba.com/txt/77582"). The
  // same story on two sites is two novels, each with its own chapters, numbering and id; nothing is joined. A novel's id is a number made from
  // its book (the same on every device, with nothing to agree on).
  //   input: { index: { [key]: {novelName, pageTitle, savedAt, model} }, have: Set of keys with text, getPref(name) (unused: one source),
  //            chapterIndex: { [book]: { chapters: [[num, title, url, raw], ...] } }   (a source's full chapter list),
  //            extraNovels: [{ name, wtrIds, listKeys }]   (novels known from their page, with no chapter here yet) }
  //   returns Map<name, { id, book, name, wtrIds: Set, sources, labels, lists: [{ id, label, rows }], chapters: row[], listId, parts }>
  //   (sources: where chapters really exist; labels: also a source only known from its chapter list; lists: its one list; parts: [itself])
  function bookOfChapter(key, novelName) {
    const up = uploadOf(key);
    if (up) return "record:up-" + up.id; // its library record is "up-<upload id>" (see libraryInfoFor)
    return wtrIdOf(key) || bindingKeyOfChapter(key) || "name:" + novelName + "@" + hostOf(key);
  }
  // A number for a book: 10 digits, from a 53-bit hash of it (cyrb53).
  // A shared novel's list (what its readers get: its details, and [number, title, chapter key, when saved] for each chapter), as this device
  // makes it, put together with the one the library has: a device adds what it knows and never takes away what only the stored list has.
  // Each chapter is the newer of the two (by when it was saved; as new: the stored one), the stored list's chapters this device does not have stay, and a detail
  // this device does not know (a device that never read the novels' details: an empty author, no cover) keeps the stored one.
  function mergeShareList(mine, stored) {
    if (!stored) return mine;
    const out = Object.assign({}, stored, mine);
    for (const [k, v] of Object.entries(mine)) {
      if (k === "chapters") continue;
      const empty = v == null || v === "" || v === 0 || (Array.isArray(v) && !v.length);
      if (empty && stored[k] != null) out[k] = stored[k];
    }
    const byKey = new Map();
    for (const c of stored.chapters || []) byKey.set(c[2], c);
    for (const c of mine.chapters || []) { const was = byKey.get(c[2]); if (!was || (c[3] || 0) > (was[3] || 0)) byKey.set(c[2], c); }
    const mineKeys = new Set((mine.chapters || []).map((c) => c[2]));
    const extra = (stored.chapters || []).some((c) => !mineKeys.has(c[2]));
    const chapters = [...byKey.values()];
    // (in this device's order when it has every chapter; else by number, those with none last, as they came)
    if (extra) chapters.sort((a, b) => (a[0] == null) - (b[0] == null) || (a[0] || 0) - (b[0] || 0));
    else chapters.sort((a, b) => (mine.chapters || []).findIndex((c) => c[2] === a[2]) - (mine.chapters || []).findIndex((c) => c[2] === b[2]));
    out.chapters = chapters;
    return out;
  }

  function numIdOf(book) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < book.length; i++) {
      const c = book.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return String(1000000000 + (n % 9000000000));
  }
  function buildNovels({ index, have, getPref, chapterIndex, extraNovels }) {
    const books = new Map(); // book -> { book, names: Map<name, count>, versions, wtrIds, listKeys }
    const langs = new Map(); // chapter key -> Map<language, { key, savedAt, model, have }>: its versions in other languages
    const originals = new Set(); // chapters whose original text is saved ("<chapter key>#original"); not translations, so no row of their own
    const bookOf = (book) => books.get(book) || books.set(book, { book, names: new Map(), versions: [], wtrIds: new Set(), listKeys: new Set() }).get(book);
    for (const key of new Set([...Object.keys(index), ...have])) {
      if (!key.startsWith("translation:")) continue; // glossaries and bindings may share the store
      if (key.endsWith(ORIGINAL)) {
        if (have.has(key)) originals.add(key);
        continue;
      }
      const lang = langOf(key);
      if (lang) {
        const base = baseKeyOf(key);
        const lm = index[key] || {};
        (langs.get(base) || langs.set(base, new Map()).get(base)).set(lang, { key, lang, savedAt: lm.savedAt || 0, model: lm.model || "", have: have.has(key), pageTitle: lm.pageTitle, novelName: lm.novelName });
        continue;
      }
      const m = index[key] || {};
      const title = tidyTitle(cleanTitle(m.pageTitle, key), m.novelName);
      // A chapter saved without a usable title gets a stand-in ("Chapter <id from the URL>"); those digits are not a chapter number.
      // (an uploaded book's chapters are numbered by their place in it: its own order, whatever their titles say)
      const up = uploadOf(key);
      const v = { key, source: sourceLabel(key), host: hostOf(key), title, savedAt: m.savedAt || 0, model: m.model || "", have: have.has(key), num: up ? up.n : isBad(m.pageTitle) ? null : chapterNumber(title) };
      const name = cleanName(m.novelName);
      const b = bookOf(bookOfChapter(key, name));
      b.versions.push(v);
      b.names.set(name, (b.names.get(name) || 0) + 1);
      const wtr = wtrIdOf(key);
      if (wtr) b.wtrIds.add(wtr);
    }
    // A chapter that has only versions in other languages has a version of its own all the same (its key opens them), made from the first of them.
    const baseKeys = new Set([...books.values()].flatMap((b) => b.versions.map((v) => v.key)));
    for (const [base, per] of langs) {
      if (baseKeys.has(base)) continue;
      const first = [...per.values()].sort((x, y) => y.savedAt - x.savedAt)[0];
      const title = tidyTitle(cleanTitle(first.pageTitle, base), first.novelName);
      const up = uploadOf(base);
      const name = cleanName(first.novelName);
      const b = bookOf(bookOfChapter(base, name));
      b.versions.push({ key: base, source: sourceLabel(base), host: hostOf(base), title, savedAt: first.savedAt, model: "", have: false, num: up ? up.n : isBad(first.pageTitle) ? null : chapterNumber(title) });
      b.names.set(name, (b.names.get(name) || 0) + 1);
      const wtr = wtrIdOf(base);
      if (wtr) b.wtrIds.add(wtr);
    }
    // each chapter's versions in other languages ({ es: { key, savedAt, model, have } }); one that has only those still has text to open
    for (const b of books.values()) {
      for (const v of b.versions) {
        const per = langs.get(v.key);
        if (!per) continue;
        v.langs = Object.fromEntries(per);
        if (!v.have) { v.have = true; v.langOnly = true; }
      }
    }
    // Novels with no chapter here yet, known from their page: a site novel by its id, a site's book by the keys its chapter list is kept under.
    for (const x of extraNovels || []) {
      const listKeys = (x.listKeys || []).filter(Boolean);
      const wtr = (x.wtrIds || [])[0];
      const book = wtr || listKeys.find((k) => books.has(k)) || listKeys[0] || x.book;
      if (!book) continue;
      const b = bookOf(book);
      if (wtr) b.wtrIds.add(wtr);
      for (const k of listKeys) b.listKeys.add(k);
      if (!b.names.size) b.names.set(x.name, 1);
      if (x.source) b.source = x.source; // (what it is called when no chapter of it says)
    }

    const out = [];
    for (const b of books.values()) {
      // its name: the one most of its chapters were saved with
      const name = [...b.names.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
      const versions = b.versions;
      // chapters its source lists but nobody has translated yet, from that source's chapter list (kept under its book, or its page's keys)
      const known = new Map(versions.map((v) => [v.key, v]));
      for (const listKey of new Set([b.book, ...b.listKeys])) {
        const ix = chapterIndex && chapterIndex[listKey];
        if (!ix) continue;
        for (const [num, title, url] of ix.chapters) {
          const ck = "translation:" + url;
          const existing = known.get(ck);
          if (existing) {
            existing.num = num; // the site's own numbering is authoritative, even for a chapter whose title has no number
            // A chapter saved with its raw Chinese page title, or a garbled one ("Chapter 38804615", from the URL), or with no name at all
            // ("Chapter 13": the site gave it none), takes the list's English title.
            if (/[㐀-鿿]/.test(existing.title) || /^Chapter \d{6,}$/.test(existing.title) || /^Chapter\s+\d+$/i.test(existing.title)) existing.title = tidyTitle(title, name);
            // A source's chapter takes its index in that source's list as its number, followed by its name.
            else if (!isWtr(existing.key)) {
              const body = String(existing.title).replace(/^Chapter\s*\d+\s*[:：.\-–]?\s*/i, "").replace(/^\d{1,5}(?:[.．、]\s*|\s+)/, "").trim();
              existing.title = "Chapter " + num + (body ? ": " + body : "");
            }
            continue;
          }
          const v = { key: ck, source: sourceLabel(ck), host: hostOf(ck), title: tidyTitle(title, name), savedAt: 0, model: "", have: false, num, indexedOnly: true };
          versions.push(v);
          known.set(ck, v);
        }
      }
      // one row per chapter: numbered ones in order, then any without a number by when they were saved
      const byNum = new Map();
      const loose = [];
      for (const v of versions) {
        if (v.num == null) loose.push([v]);
        else (byNum.get(v.num) || byNum.set(v.num, []).get(v.num)).push(v);
      }
      const rows = [...byNum.entries()].map(([num, group]) => makeRow(num, group, "auto", originals)).concat(loose.map((group) => makeRow(null, group, "auto", originals)));
      rows.sort((a, b2) => (a.num != null && b2.num != null ? a.num - b2.num : a.num != null ? -1 : b2.num != null ? 1 : a.savedAt - b2.savedAt));
      const listId = "book:" + b.book;
      for (const r of rows) r.list = listId;
      const labels = versions.length ? [...new Set(versions.map((v) => v.source))] : [b.wtrIds.size ? "wtr-lab" : b.source || b.book.split("/")[0]];
      const keys = b.wtrIds.size ? [] : [b.book, ...b.listKeys].filter((k) => !k.startsWith("name:"));
      out.push({
        id: numIdOf(b.book),
        book: b.book,
        name,
        wtrIds: b.wtrIds,
        sources: [...new Set(versions.filter((v) => !v.indexedOnly).map((v) => v.source))],
        labels,
        lists: [{ id: listId, label: labels.join(" + "), sources: labels, rows }],
        chapters: rows,
        listId,
        parts: [{ names: [...b.names.keys()], wtrIds: [...b.wtrIds], keys, refs: [...b.wtrIds, ...keys, "name:" + name], hidden: false }]
      });
    }
    // Two books with one name (the same story on two sites): each says its source after it, "Name [wtr-lab]", "Name [69shuba]".
    // (baseName: the name before that)
    const count = new Map();
    for (const n of out) count.set(n.name, (count.get(n.name) || 0) + 1);
    const novels = new Map();
    for (const n of out.sort((a, b) => a.book.localeCompare(b.book))) {
      n.baseName = n.name;
      let name = count.get(n.name) > 1 ? n.name + " [" + (n.labels[0] || n.book.split("/")[0]) + "]" : n.name;
      while (novels.has(name)) name += " ·";
      n.name = name;
      novels.set(name, n);
    }
    return novels;
  }

  const rowKeys = (row) => row.versions.map((v) => v.key);
  const rowHasKey = (row, key) => !!key && row.versions.some((v) => v.key === key);

  // The novel as seen through one of its lists: the same novel, with that list's rows as `chapters`. (The same view each time, so it can be compared.)
  const views = new WeakMap();
  function listView(novel, listId) {
    const list = (novel.lists || []).find((l) => l.id === listId);
    if (!list || list.id === novel.listId) return novel;
    if (!views.has(novel)) views.set(novel, new Map());
    const m = views.get(novel);
    if (!m.has(list.id)) m.set(list.id, Object.assign({}, novel, { chapters: list.rows, listId: list.id }));
    return m.get(list.id);
  }
  // Every row of a novel, whatever list it is in; every version of them.
  const allRows = (novel) => (novel.lists ? novel.lists.flatMap((l) => l.rows) : novel.chapters);
  const allVersions = (novel) => allRows(novel).flatMap((r) => r.versions);

  // The novel (seen through the list the chapter is in) and row a chapter key belongs to.
  function findByKey(novels, key) {
    for (const novel of novels.values()) {
      for (const list of novel.lists || []) {
        for (const row of list.rows) {
          const version = row.versions.find((v) => v.key === key);
          if (version) return { novel: listView(novel, list.id), row, version };
        }
      }
    }
    return null;
  }

  // The key to open for a row when you are already reading from `source`: that source's copy if it has one, else the row's pick.
  const keyForSource = (row, source) => (row.versions.find((v) => v.source === source && v.have) || {}).key || row.key;

  const isUploadNovel = (novel) => !!novel && String(novel.book || "").startsWith("record:up-");
  const api = { ORIGINAL, langOf, baseKeyOf, UPLOAD_LABEL, uploadOf, uploadKey, isUploadNovel, cleanName, cleanTitle, tidyTitle, chapterNumber, hostOf, sourceLabel, isWtr, wtrIdOf, bindingKeyOfChapter, buildNovels, mergeShareList, numIdOf, bookOfChapter, listView, allRows, allVersions, rowKeys, rowHasKey, findByKey, keyForSource };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Chapters = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
