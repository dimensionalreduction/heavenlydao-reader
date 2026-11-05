// Where a site's book page says what the book is comes from its rule (src/shared/sources/, WebToEpub's extractTitle / extractAuthor / ...), as the table
// BookRules that the build puts in book-rules.js; a page with the standard novel metadata needs no rule.
// Run in a book's page when the person asks (docs/ADD-BOOK.md: Import to library in the popup, or Refresh details), never on its own: it reads the book (the
// standard novel metadata, <meta property="og:novel:book_name"> and its neighbours, else the site's rule; the person said it is a book's page, so a chapter-text
// selector that also matches does not stop it) and records it in the library: title, author, cover, synopsis, category and status, so the novel gets a page of its
// own (its chapter list is read next). Titles are put into English in one batch (the background does it).
(function () {
  const isNode = typeof module !== "undefined" && module.exports;

  // 连载 -> Ongoing ...; anything else is not guessed at
  function statusOf(text) {
    const t = String(text || "").trim();
    if (/完结|完本|已完|finished|completed/i.test(t)) return "Completed";
    if (/连载|連載|ongoing|serializing/i.test(t)) return "Ongoing";
    return "";
  }

  // The meta tags of a page as { "og:novel:author": "..." }.
  function metas(doc) {
    const out = {};
    for (const m of doc.querySelectorAll('meta[property^="og:"]')) out[m.getAttribute("property")] = String(m.getAttribute("content") || "").trim();
    return out;
  }

  // A book whose page keeps its details in an Astro island's props (asurascans.com): rule.book.astro = { component, title, author, description, cover, genre, status }, each
  // the name of a prop ("genre": "genres.name" is the `name` of every item of the list `genres`). The props are wrapped ([0, value], [1, list]); unwrapAstro is the same as
  // RawSources.helpers.astroProps' (this script is loaded without the site rules).
  function unwrapAstro(v) {
    if (Array.isArray(v)) {
      if (!v.length) return null;
      if (v.length === 2 && Number.isInteger(v[0])) return unwrapAstro(v[1]);
      if (v.length === 1 && Number.isInteger(v[0])) return null;
      return v.map(unwrapAstro);
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrapAstro(x)]));
    return v;
  }
  function fromAstro(doc, spec) {
    let island = null;
    try {
      island = [...doc.querySelectorAll("astro-island")].find((i) => String(i.getAttribute("component-url") || "").includes(spec.component));
    } catch (e) {
      return null;
    }
    let props = null;
    try {
      props = island && unwrapAstro(JSON.parse(island.getAttribute("props")));
    } catch (e) {
      return null;
    }
    if (!props) return null;
    const get = (value, parts) => (!parts.length ? value : Array.isArray(value) ? value.map((x) => get(x, parts)) : get(value && value[parts[0]], parts.slice(1)));
    const at = (path) => (path ? get(props, String(path).split(".")) : null);
    const text = (v) => (typeof v === "string" ? v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
    const cover = at(spec.cover);
    const genres = at(spec.genre);
    return {
      title: text(at(spec.title)),
      author: text(at(spec.author)),
      description: paragraphs(typeof at(spec.description) === "string" ? at(spec.description).replace(/<\/p>/gi, "\n") : ""),
      cover: typeof cover === "string" && /^https:\/\//.test(cover) ? cover : "",
      genres: Array.isArray(genres) ? genres.filter((g) => typeof g === "string" && g.trim() && g.length <= 40).map((g) => g.trim()) : [],
      status: statusOf(at(spec.status))
    };
  }

  // The synopsis as paragraphs: the description may carry <br /> tags.
  const paragraphs = (text) => String(text || "").split(/<br\s*\/?>|\n+/i).map((l) => l.replace(/<[^>]*>/g, "").trim()).filter(Boolean);

  // What the page says about its book (nothing translated yet), or null if it is not a book's page.
  function readBook(doc, href) {
    const m = metas(doc);
    const title = m["og:novel:book_name"] || "";
    if (!title || !(m["og:novel:author"] || m["og:novel:category"])) return null;
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    let list = m["og:novel:read_url"] || "";
    if (!list) {
      for (const a of doc.querySelectorAll("a")) {
        const text = (a.textContent || "").trim();
        if (/^(完整目录|目录|目錄|全部章节|章节目录|開始閱讀|开始阅读)$/.test(text) && a.getAttribute("href")) { list = a.getAttribute("href"); break; }
      }
    }
    try {
      list = list ? new URL(list, href).href : "";
    } catch (e) {
      list = "";
    }
    const https = (u) => (/^https:\/\//.test(u || "") ? u : "");
    // (an address that starts with // or / is the page's own site: 69shuba.tw says og:image as //p.69shuba.tw/.../cover.jpg)
    const absolute = (u) => {
      try {
        return u ? new URL(u, href).href : "";
      } catch (e) {
        return "";
      }
    };
    return {
      id: host + url.pathname.replace(/\.[a-z]+$/i, "").replace(/\/+$/, ""), // "69shuba.com/book/74649"
      source: host,
      url: href.split("#")[0],
      rawTitle: title,
      authorRaw: m["og:novel:author"] || "",
      synopsis: paragraphs(m["og:description"]),
      category: m["og:novel:category"] || "",
      status: statusOf(m["og:novel:status"]),
      cover: https(absolute(m["og:image"])),
      listUrl: https(list)
    };
  }

  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  // `drop`: parts of the element that are not the text wanted (ranobes.top's title carries the original names in a subtitle)
  const firstText = (doc, sel, drop) => {
    try {
      let e = sel && doc.querySelector(sel);
      if (e && drop) {
        e = e.cloneNode(true);
        e.querySelectorAll(drop).forEach((n) => n.remove());
      }
      return e ? clean(e.textContent) : "";
    } catch (err) {
      return ""; // a selector the browser cannot use
    }
  };
  // The cover: an <img> (its lazy-load attribute first) or a <meta> holding the address, or the first <img> inside the element.
  function coverOf(doc, sel, href) {
    let e = null;
    try {
      e = sel && doc.querySelector(sel);
    } catch (err) {
      return "";
    }
    if (!e) return "";
    const tag = String(e.tagName || "").toLowerCase();
    const img = tag === "img" ? e : tag === "meta" ? null : e.querySelector && e.querySelector("img");
    const raw = tag === "meta" ? e.getAttribute("content") : img ? img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src") : "";
    try {
      const u = raw ? new URL(raw, href).href : "";
      return /^https:\/\//.test(u) ? u : "";
    } catch (err) {
      return "";
    }
  }
  const authorOf = (doc, sel) => firstText(doc, sel).replace(/^\s*(作者|author|by)\s*[:：]?\s*/i, "");
  function descriptionOf(doc, sel) {
    try {
      const e = sel && doc.querySelector(sel);
      return e ? String(e.textContent || "").split(/\n+/).map(clean).filter(Boolean) : [];
    } catch (err) {
      return [];
    }
  }
  function genresOf(doc, sel) {
    const genres = [];
    try {
      for (const e of sel ? doc.querySelectorAll(sel) : []) {
        const g = clean(e.textContent);
        if (g && g.length <= 40 && !genres.includes(g)) genres.push(g);
      }
    } catch (err) {
      // no genres
    }
    return genres.slice(0, 8);
  }

  // A book read from the page's standard metadata, completed through the site's selectors: what the metadata leaves empty is read with the built-in
  // selectors (`builtin`), and what the person picked themselves (`mine`) wins over the page's metadata. Each is { title, author, ... } (any may be missing).
  function fillGaps(book, doc, href, builtin, mine) {
    if (!book) return book;
    const read = {
      title: (sel) => firstText(doc, sel),
      author: (sel) => authorOf(doc, sel),
      cover: (sel) => coverOf(doc, sel, href),
      description: (sel) => descriptionOf(doc, sel),
      genre: (sel) => genresOf(doc, sel).join(" / ")
    };
    const field = { title: "rawTitle", author: "authorRaw", cover: "cover", description: "synopsis", genre: "category" };
    const empty = (v) => !v || (Array.isArray(v) && !v.length);
    for (const key of Object.keys(field)) {
      const mineValue = mine && mine[key] ? read[key](mine[key]) : "";
      if (!empty(mineValue)) book[field[key]] = mineValue;
      else if (empty(book[field[key]]) && builtin && builtin[key]) {
        const v = read[key](builtin[key]);
        if (!empty(v)) book[field[key]] = v;
      }
    }
    return book;
  }

  // A book's page read through its site's rule (`rule`: { book, selector, fallback }); null if the page is a chapter, or says too little to be a book.
  // `fallback`: the site's built-in book selectors, when `book` has the person's own on top of them: a selector of theirs that finds nothing on this page
  // (it was picked on another book's page, where the author was the third line and not the second) gives way to the built-in one for that field.
  // opts.asBook: the person said this is a book's page (Import to library, Refresh details): a chapter-text selector that also finds something here does not make it a
  // chapter (generic ones, ".entry-content", match a third of the sites' book pages: docs/ADD-BOOK.md)
  function readBookByRule(doc, href, rule, opts = {}) {
    if (!rule || !rule.book) return null;
    try {
      if (!opts.asBook && rule.selector && doc.querySelector(rule.selector)) return null; // the chapter's text is here: this is a chapter, not a book
    } catch (err) {
      return null;
    }
    const b = rule.book;
    const f = rule.fallback || {};
    const read = (key, how) => {
      const v = how(b[key], b);
      return (!v || !v.length) && f[key] && f[key] !== b[key] ? how(f[key], f) : v;
    };
    const astro = b.astro && b.astro.component ? fromAstro(doc, b.astro) : null; // (the page's own data, when the rule says where: it is believed first)
    const title = (astro && astro.title) || read("title", (sel, from) => firstText(doc, sel, from.titleDrop));
    const author = (astro && astro.author) || read("author", (sel) => authorOf(doc, sel));
    let description = astro && astro.description.length ? astro.description : read("description", (sel) => descriptionOf(doc, sel));
    // (a site whose synopsis is only in the page's description tag: wfwf528.com, a comic site)
    if (!description.length) {
      const md = doc.querySelector('meta[property="og:description"], meta[name="description"]');
      const said = md ? String(md.getAttribute("content") || "").trim() : "";
      if (said.length >= 30) description = paragraphs(said);
    }
    const cover = (astro && astro.cover) || read("cover", (sel) => coverOf(doc, sel, href));
    if (!title || !(author || cover || description.length)) return null;
    const genres = astro && astro.genres.length ? astro.genres : read("genre", (sel) => genresOf(doc, sel));
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    return {
      id: host + url.pathname.replace(/\.[a-z]+$/i, "").replace(/\/+$/, ""),
      source: host,
      url: href.split("#")[0],
      rawTitle: title,
      authorRaw: author,
      synopsis: description,
      category: genres.slice(0, 8).join(" / "),
      status: (astro && astro.status) || "",
      cover,
      listUrl: href.split("#")[0] // the book's page is usually its list too; the extension finds the list from it with the site's rule
    };
  }

  // The record the library keeps, given the titles in English (`english`: the same order as textsOf).
  const textsOf = (b) => [b.rawTitle, b.authorRaw, b.category, ...b.synopsis];
  function toNovelInfo(b, english) {
    const en = (i) => (english && english[i] ? String(english[i]).trim() : "") || textsOf(b)[i];
    return {
      id: b.id,
      source: b.source,
      rawId: "",
      slug: "",
      url: b.url,
      title: en(0),
      rawTitle: b.rawTitle,
      author: en(1),
      authorRaw: b.authorRaw,
      genres: b.category ? en(2).split(/\s*[\/、,，]\s*/).filter(Boolean).slice(0, 8) : [],
      synopsis: b.synopsis.map((_, i) => en(3 + i)).join("\n\n"),
      status: b.status,
      cover: b.cover,
      listUrl: b.listUrl,
      tags: []
    };
  }

  if (isNode) module.exports = { readBook, readBookByRule, fillGaps, toNovelInfo, textsOf, statusOf };
  else if (typeof window !== "undefined") window.BookCapture = { readBook, readBookByRule, fillGaps, toNovelInfo, textsOf }; // (the extension's own pages use these: the rules page, and the sync page when a book's details are read again)
  if (typeof document === "undefined" || typeof location === "undefined") return; // loaded by a test, not injected into a page
  if (!/^https?:$/.test(location.protocol)) return; // an extension page that loaded this only for the functions above: nothing to record here

  const ext = typeof browser !== "undefined" ? browser : chrome;
  async function run() {
    // the built-in site's book selectors, and the person's own (they win, field by field; a site of theirs has no built-in entry)
    const host = location.hostname.replace(/^www\./, "");
    const builtin = (typeof BookRules !== "undefined" && BookRules[host]) || null;
    let mine = null;
    if (typeof UserRules !== "undefined") {
      const saved = (await ext.storage.local.get(UserRules.KEY).catch(() => ({})))[UserRules.KEY];
      mine = UserRules.bookTable(saved || {})[host] || null;
    }
    const rule = builtin || mine ? { selector: (mine && mine.selector) || (builtin && builtin.selector), book: { ...((builtin && builtin.book) || {}), ...((mine && mine.book) || {}) }, fallback: (builtin && builtin.book) || null } : null;
    // a page with the standard metadata, completed (and corrected) through the selectors; or a page read through the selectors alone
    const book = fillGaps(readBook(document, location.href), document, location.href, builtin && builtin.book, mine && mine.book) || readBookByRule(document, location.href, rule, { asBook: true });
    if (!book) return { saved: false, reason: "Too little was read from this page: a title, and an author, a cover or a synopsis" };
    const texts = textsOf(book);
    const ok = (r) => r && Array.isArray(r.texts) && r.texts.length === texts.length;
    // Gemini says what a title means; a build without it answers nothing, and the batch translator (Google) does it instead
    let reply = await ext.runtime.sendMessage({ type: "translateBook", texts }).catch(() => null);
    if (!ok(reply)) reply = await ext.runtime.sendMessage({ type: "translateTitles", texts }).catch(() => null);
    const english = ok(reply) ? reply.texts : texts;
    const info = toNovelInfo(book, english);
    const saved = await ext.runtime.sendMessage({ type: "novel:save", info }).catch(() => null);
    if (saved && saved.ok) {
      // (Import to library is answered once the book is saved; its cover is copied after. A Refresh details visit waits for it: the visit's tab closes when told)
      const cover = added ? (copyCover(info).catch(() => null), null) : await copyCover(info);
      return { saved: true, cover, info: { id: info.id, title: info.title, author: info.author, url: info.url, listUrl: info.listUrl } };
    }
    return { saved: false, reason: "the library did not take the book" + (saved && saved.error ? " (" + saved.error + ")" : "") };
  }

  // The cover is copied to the library too, so it shows in the library even where the source site refuses to serve it to other sites (unless the person
  // switched that off in the library's settings). From this page when the picture is on this page's own site (it is then fetched the way the site expects,
  // with its cookies); otherwise, or if that fails, by the extension.
  // A visit made for "Refresh details" (visited, below) copies it whatever the setting says. -> how it went ({ ok, error?, skipped? }), or null: no cover
  const visited = location.hash === "#p2pread-visit"; // (a visit made by book-visit.js: "Refresh details")
  async function copyCover(info) {
    if (!info.cover) return null;
    const force = visited;
    if (!force) {
      const on = await ext.runtime.sendMessage({ type: "cover:enabled" }).catch(() => null);
      if (!on || !on.on) return { ok: false, skipped: "off" };
    }
    try {
      if (new URL(info.cover).origin === location.origin) {
        const res = await fetch(info.cover, { credentials: "include" });
        if (res.ok) {
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const sent = await ext.runtime.sendMessage({ type: "cover:save", id: info.id, dataUrl, force });
          if (sent && sent.ok) return sent;
        }
      }
    } catch (e) {
      // the extension tries below
    }
    return (await ext.runtime.sendMessage({ type: "cover:copy", id: info.id, url: info.cover, force }).catch((e) => ({ ok: false, error: e.message }))) || { ok: false, error: "no answer" };
  }
  // A book is recorded only when the person asks (docs/ADD-BOOK.md): Import to library in the popup (the background sets window.__p2preadAdd and runs this in the tab),
  // or Refresh details (a visit made by book-visit.js: its address ends in the marker). Either is told when the recording has finished, and how it went.
  const added = window.__p2preadAdd === true;
  window.__p2preadAdd = false;
  if (!visited && !added) return;
  Promise.resolve().then(run)
    .catch((e) => ({ saved: false, reason: String((e && e.message) || e) }))
    .then((result) => ext.runtime.sendMessage({ type: "bookcapture:done", added, ...(result || { saved: false, reason: "nothing was recorded" }) }).catch(() => {}));
})();
