// How to read the original text of a chapter, and where a novel's chapters are listed, for each source site. Used by p2p-host.js (in an
// extension page that can fetch from these sites with the person's own cookies, so their Cloudflare checks are already passed), by the
// in-page translator (content.js) and by the "New chapters" watcher.
//
// THIS FILE IS THE ENGINE. The sites are data, one small description per site like WebToEpub's one parser per site, in sources/:
//   sources/_generated.js   every site WebToEpub has a parser for, extracted from its parsers by tools/gen-sources.js (do not edit by hand)
//   sources/<site>.js       a site that needed more than a selector (or that was checked by hand); these win over the generated ones
// The build (extension/build.js) joins this file and all of sources/ into the single raw-sources.js the extension loads, and gives the
// extension permission to read every site listed there. To add a site, add a file: see sources/README.md.
//
// A rule is facts about one site (WebToEpub: https://github.com/dteviot/WebToEpub, GPL-3.0; only the CSS selectors, encodings and page
// layouts are reused, not its code):
//   selector  the element that holds the chapter text (a CSS selector; a list means "the first of these found")
//   junk      elements inside it that are not story (ads, titles, notices); a CSS selector list
//   charset   only when the site does not say what its pages are encoded in (69shuba, for one, serves GBK without saying so)
//   clean     extra clean-up that a selector cannot express: clean(box)
//   next      the address of the next page of the SAME chapter, for sites that split a chapter into parts (null at the last part)
//   toc       where the site lists a novel's chapters:
//               list     the chapters on the list page: a CSS selector for the links, or list(doc, base) -> [{ title, url }]
//               pages    the list runs over several pages: where the others are named, { options: "<selector>", attr: "data-url" } (elements whose
//                        attribute holds each page's address, a page selector) or { links: "<selector>" } (the links to them), or pages(doc, base) -> [url]
//               boxes    instead of list: a CSS selector for the elements that hold the links; `pick` says which one ("first", "last" or an
//                        index) and the links are the ones under it (a page with several lists, or a list inside the content box)
//               reverse  the list is newest first (true), so it is turned round
//               url      url(address) -> the list page, from any address of the novel (a chapter's, or its book page). Without it the
//                        page is found from a chapter's own link to it ("目录", "Table of Contents"...), see tocLinkOf
//   book      where a book's page says what the book is: { title, author, description, cover, genre }, each a CSS selector (WebToEpub's extractTitle,
//             extractAuthor, ...); titleDrop: elements inside the title to leave out of it. Used by the script that records a book when its page is open (book-capture.js).
//   fromHtml  fromHtml(html, url) -> Promise<{ text, next? } | null>, for a site whose chapter text is not in the page's elements (it is encrypted
//             or built by a script): it gets the page's HTML before scripts are removed, and gives the text itself. `selector` is then unused.
//   textUrl   textUrl(address) -> where a chapter's text is fetched from instead of its page (the site's data, for a site whose pages a script fills in);
//             fromHtml then reads that response (a rule the person made from the site's data: user-rules.js)
//   toc.parse parse(text, listUrl) -> [{ title, url }]: for a list that is JSON, not a page (with toc.url giving where it is)
//   parser    the WebToEpub parser class the rule was made from (the generator adds it), so a file of rules for one family of sites can find them
//             all: hostsOf("NovelfullParser")
//   toc.gap   milliseconds between requests for the list pages (default 1000); a site that answers 429 gets longer, and is waited for
//   toc.list, toc.pages as functions also get the page's raw text as a last argument: list(doc, base, html), pages(doc, base, html). The page's
//             scripts are removed before it is parsed, so a list that a script holds as data (ranobes.top's window.__DATA__) is read from `html`.
//   nav       { next, prev }: CSS selectors of the links to the next and the previous chapter on a chapter's page (rules the person added; the usual places are
//             tried when it finds nothing, or when a site has no nav)
//   user      (set by user-rules.js) the rule was added by the person, not built in
//   from      where the rule came from (a WebToEpub parser's file name), for whoever has to fix it
//
// Not here, on purpose: fanqienovel.com draws its text with a scrambled font (the HTML is gibberish), and tadu.com, qimao.com and
// book.qq.com build their pages with JavaScript and need a login, so a plain fetch cannot read a chapter from them.
(function (root) {
  const JUNK = "script, style, ins, iframe";
  const chapterId = (url) => (/\/(\d+)(?:_\d+)?\.html/.exec(url) || [])[1] || null;
  const absolute = (href, base) => {
    try {
      return new URL(href, base).href;
    } catch (e) {
      return null;
    }
  };
  // The link to a further part of this chapter, never to the next chapter.
  const samePart = (href, url) => {
    const next = absolute(href, url);
    return next && next !== url && chapterId(next) && chapterId(next) === chapterId(url) ? next : null;
  };

  // [{ title, url }] for the links under `selector`, absolute, in page order, each address once.
  function linksUnder(doc, selector, base, keep) {
    const out = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll(selector)) {
      const url = absolute(a.getAttribute("href") || "", base);
      if (!url || seen.has(url) || (keep && !keep(url))) continue;
      seen.add(url);
      out.push({ title: String(a.textContent || "").replace(/\s+/g, " ").trim(), url });
    }
    return out;
  }

  // ---------- the registry ----------
  const SOURCES = {};
  const RAW = {}; // each site's rule as it was written (SOURCES holds it prepared for use), for extend()
  // The rules the person added themselves (user-rules.js builds them from what they saved in the extension): prepared like the others, and they win over a
  // built-in rule for the same site. Replaced as a whole whenever the saved rules change.
  let USER = {};
  function setUserRules(table) {
    const next = {};
    for (const [h, rule] of Object.entries(table || {})) next[String(h).replace(/^www\./, "").toLowerCase()] = normalize(rule);
    USER = next;
  }

  // A rule as written -> a rule as used: a list given as a selector becomes a function, and `reverse` is applied.
  function normalize(rule) {
    const r = { ...rule };
    if (r.toc) {
      const t = { ...r.toc };
      const selector = t.list; // (kept before t.list is replaced below)
      let read = typeof selector === "string" ? (doc, base) => linksUnder(doc, selector, base) : selector;
      if (typeof t.boxes === "string") {
        const { boxes, pick } = t;
        read = (doc, base) => {
          let all = [];
          try {
            all = [...doc.querySelectorAll(boxes)];
          } catch (e) {
            return []; // a selector the browser cannot use finds nothing rather than failing
          }
          const box = pick === "last" ? all[all.length - 1] : pick === "first" ? all[0] : all[Number(pick)];
          return box ? linksUnder(box, "a", base) : [];
        };
      }
      if (typeof read === "function") {
        t.read = read; // one page's links as the page has them (several pages are joined first and reversed once)
        t.list = t.reverse ? (doc, base, html) => read(doc, base, html).reverse() : read;
      }
      if (t.pages && typeof t.pages === "object") {
        const { options, links, attr } = t.pages;
        const sel = options || links;
        t.pages = (doc, base) => {
          let els = [];
          try {
            els = sel ? [...doc.querySelectorAll(sel)] : [];
          } catch (e) {
            return [];
          }
          const out = [];
          for (const e of els) {
            const raw = options ? e.getAttribute(attr) : e.getAttribute("href");
            const u = raw ? absolute(raw, base) : null;
            if (u && u !== base && !out.includes(u)) out.push(u);
          }
          return out;
        };
      }
      r.toc = t;
    }
    return r;
  }

  // register("example.com", rule) or register(["example.com", "m.example.com"], rule). A later registration of the same site replaces the
  // earlier one (that is how a hand-written file overrides the generated one). "www." is not part of the name.
  function register(hosts, rule) {
    for (const h of [].concat(hosts)) {
      const name = String(h).replace(/^www\./, "").toLowerCase();
      const next = normalize(rule);
      if (!next.book && SOURCES[name] && SOURCES[name].book) next.book = SOURCES[name].book; // a hand-written rule keeps what the generated one knew of the book's page
      if (next.wait == null && SOURCES[name] && SOURCES[name].wait) next.wait = SOURCES[name].wait; // (and how long the site wants between chapters)
      SOURCES[name] = next;
      RAW[name] = !rule.book && next.book ? { ...rule, book: next.book } : rule;
    }
  }
  // extend(hosts, patch): add to the rules the sites already have (the generated ones) instead of replacing them: a family of sites that share a
  // layout gets its chapter list this way and keeps the text selector, junk and book details the generator read. A site with no rule is skipped.
  function extend(hosts, patch) {
    for (const h of [].concat(hosts)) {
      const name = String(h).replace(/^www\./, "").toLowerCase();
      if (RAW[name]) register(name, { ...RAW[name], ...patch });
    }
  }
  // The registered sites whose rule was made from one of these WebToEpub parser classes (names, or a list of them).
  function hostsOf(parsers) {
    const want = [].concat(parsers);
    return Object.keys(RAW).filter((h) => want.includes(RAW[h].parser));
  }
  // A site that cannot be read itself but has a mirror that can: mirror("fanqienovel.com", (url, html) => the mirror's address of that chapter, or
  // null). The site's Raw link for such a novel lands on the original site, whose page says which book the chapter is in.
  const MIRRORS = {};
  const registerMirror = (host, fn) => void (MIRRORS[String(host).replace(/^www\./, "").toLowerCase()] = fn);
  // The mirror's address for a response that landed on a mirrored site (reads its page), or null when the site has no mirror.
  async function mirrorUrl(res) {
    const host = hostOf(res.url);
    const fn = host && Object.prototype.hasOwnProperty.call(MIRRORS, host) ? MIRRORS[host] : null;
    if (!fn) return null;
    const target = fn(res.url, await res.text());
    if (!target) throw new Error("could not tell which book this chapter is in on " + host);
    return target;
  }
  function registerAll(table) {
    for (const [h, r] of Object.entries(table)) register(h, r);
  }
  // How long to wait between two of a site's chapters fetched one after another (ms): its rule's `wait`; the site (read through its own API, not
  // a rule) 12 seconds; else 0. The default for a novel from it; the person's own settings come first (p2p-host.js fetchFound).
  const OWN_API_WAITS = { "wtr-lab.com": 12000 };
  const waitFor = (host) => {
    const h = String(host || "").replace(/^www\./, "").toLowerCase();
    return (SOURCES[h] && SOURCES[h].wait) || OWN_API_WAITS[h] || 0;
  };

  const hostOf = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : null;
    } catch (e) {
      return null;
    }
  };

  // The site names a novel's raw source in its page data (serie.raws[].slug): a domain ("biquge.tw") or a short name ("69shu", "fanqienovel").
  // The registered site it stands for, or "" if it is not one of ours (fanqienovel is not readable, so it is not here).
  const SLUG_ALIASES = { "69shu": "69shuba.com", fanqienovel: "tomatomtl.com" }; // (fanqienovel itself cannot be read; its mirror can)
  function hostForSlug(slug) {
    const s = String(slug || "").toLowerCase().trim().replace(/^www\./, "");
    if (!s) return "";
    const has = (h) => Object.prototype.hasOwnProperty.call(SOURCES, h) || Object.prototype.hasOwnProperty.call(USER, h);
    if (has(s)) return s;
    if (SLUG_ALIASES[s] && has(SLUG_ALIASES[s])) return SLUG_ALIASES[s];
    const named = Object.keys(SOURCES).filter((h) => h.split(".")[0] === s);
    return named.length ? named.sort((a, b) => (/\.com$/.test(b) ? 1 : 0) - (/\.com$/.test(a) ? 1 : 0) || a.length - b.length)[0] : "";
  }

  // The rule for a chapter address, or null for a site that is not supported.
  function ruleFor(url) {
    const host = hostOf(url);
    if (host && Object.prototype.hasOwnProperty.call(USER, host)) return USER[host];
    return (host && Object.prototype.hasOwnProperty.call(SOURCES, host) && SOURCES[host]) || null;
  }

  // Page bytes -> text, in the encoding charsetOf says.
  function decode(bytes, contentType, rule) {
    try {
      return new TextDecoder(charsetOf(bytes, contentType, rule)).decode(bytes);
    } catch (e) {
      return new TextDecoder("utf-8").decode(bytes); // an unknown charset label
    }
  }

  // The encoding a page is read in. A rule's encoding (the one WebToEpub's parser hard-codes for a site that says none, or says it wrong) comes first, unless the
  // page says UTF-8 and is: a site that has moved to UTF-8 since (69shuba.tw, 230book.net), or a page of the site the rule's encoding was not for
  // (marxists.org's English pages: it is for the Chinese ones). Then what the page says (its header, its <meta>). A page that says none is read as what its bytes
  // read best in, as a browser does: UTF-8 when they read as UTF-8; else the Chinese encoding they read cleanly in with more of the most common characters
  // (GB18030, which covers GBK and GB2312, or Big5: GBK read as Big5 gives real but rare characters, so it is the common ones that tell); else windows-1252 (an
  // old western page). So a Chinese site that does not say is read right without a rule (a site added with Detect with AI has none); tools/check-encodings.js
  // tries this on the sites WebToEpub hard-codes an encoding for. A page that says UTF-8 and plainly is not (a template some Chinese sites share) is read in the
  // Chinese encoding when one reads it cleanly.
  const COMMON_HAN = new Set("的一是不了人我在有他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日這個們來為國說時會對發後過裡經學現當沒動開從實");
  const brokenIn = (t) => (t.match(/\uFFFD/g) || []).length;
  // (at most a broken character here and there: GBK read as UTF-8 breaks nearly every one)
  const readsAsUtf8 = (utf8) => brokenIn(utf8) <= (utf8.match(/[^\x00-\x7f]/g) || []).length * 0.1;
  function charsetOf(bytes, contentType, rule) {
    let said = (/charset=["']?([\w-]+)/i.exec(contentType || "") || [])[1];
    if (!said) said = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 4096))) || [])[1];
    const saysUtf8 = !!said && /^utf-?8$/i.test(said);
    if (rule && rule.charset) return saysUtf8 && !/^utf-?8$/i.test(rule.charset) && readsAsUtf8(new TextDecoder("utf-8").decode(bytes)) ? "utf-8" : rule.charset;
    if (said && !saysUtf8) return said;
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    if (readsAsUtf8(utf8)) return "utf-8";
    let best = null;
    for (const cs of ["gb18030", "big5"]) {
      let t = "";
      try {
        t = new TextDecoder(cs).decode(bytes);
      } catch (e) {
        continue; // (a browser without it)
      }
      const han = t.match(/[\u4e00-\u9fff]/g) || [];
      if (han.length < 20 || brokenIn(t) > han.length * 0.02) continue;
      let common = 0;
      for (const c of han) if (COMMON_HAN.has(c)) common++;
      if (!best || common / han.length > best.score) best = { cs, score: common / han.length };
    }
    if (best) return best.cs;
    return saysUtf8 ? "utf-8" : "windows-1252"; // (one that said UTF-8 stays UTF-8 when no Chinese encoding reads it)
  }

  // The chapter text on one page: one paragraph per line, "" when the page has no chapter text (a Cloudflare page, a changed layout).
  function textOf(doc, rule) {
    let box = null;
    if (!rule.selector) return ""; // (a site with only its chapter list saved: no text selector yet)
    try {
      box = doc.querySelector(rule.selector);
    } catch (e) {
      return ""; // a selector the browser cannot use (a rule written wrong) finds nothing rather than failing the chapter
    }
    if (!box) return "";
    try {
      box.querySelectorAll(rule.junk || JUNK).forEach((n) => n.remove());
    } catch (e) {
      // an unusable junk selector: the junk stays, the story is still there
    }
    if (rule.clean) rule.clean(box);
    box.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    // textContent runs block elements together: a line break after each paragraph (or heading, list item...) keeps them apart
    box.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr, section").forEach((el) => el.append("\n"));
    return String(box.textContent || "").split(/\n+/).map((l) => l.replace(/　/g, " ").trim()).filter(Boolean).join("\n");
  }

  const nextPart = (doc, url, rule) => (rule.next ? rule.next(doc, url) : null);

  // ---------- chapter lists ----------
  // The chapter-list page for a novel, from any address of it: { rule, url } or null for a site with no list reader. `url` is null when the
  // rule can read the list but cannot tell where it is from an address: the page itself then has to be asked (tocLinkOf).
  function tocFor(url) {
    const rule = ruleFor(url);
    if (!rule || !rule.toc) return null;
    return { rule, url: rule.toc.url ? rule.toc.url(url) || null : null };
  }

  // A chapter's own link to the novel's list ("目录", "Table of Contents", ...): the address of the list page, or null.
  const TOC_SELECTORS = ['a[rel="index"]', "a#toc", "a.toc", ".toc a", "a.catalog", "a.mulu", "a.index", ".bottom a.index", ".chapter-nav a.index"];
  const TOC_TEXT = /^[\s<‹«←\[\(]*(目录|目錄|目录页|章节目录|章節目錄|返回目录|返回目錄|返回书页|返回書頁|章节列表|章節列表|全部章节|全部章節|chapter list|chapters|table of contents|contents|toc|index|novel page|back to novel|book page)[\s>›»→\]\)]*$/i;
  function tocLinkOf(doc, url) {
    const host = hostOf(url);
    const usable = (href) => {
      if (!href || /^\s*(javascript|#)/i.test(href)) return null;
      const u = absolute(href, url);
      return u && u !== url && hostOf(u) === host ? u : null;
    };
    for (const sel of TOC_SELECTORS) {
      const el = doc.querySelector(sel);
      const u = el && usable(el.getAttribute("href"));
      if (u) return u;
    }
    for (const a of doc.querySelectorAll("a")) {
      const text = String(a.textContent || "").trim();
      const u = text && text.length <= 24 && TOC_TEXT.test(text) ? usable(a.getAttribute("href")) : null;
      if (u) return u;
    }
    return null;
  }

  // The chapters on a fetched list page: [{ num, title, url }] in the site's order. The number is the chapter's place in the list (1, 2, 3...),
  // whatever the title says: titles repeat numbers (a chapter in parts, "第12章 (2/3)") and some have none, while the place in the list is one
  // number per entry, in order. It is the chapter's index in the library, and what long lists are grouped by.
  function tocChapters(doc, toc, html) {
    return toc.rule.toc.list(doc, toc.url, html).map((c, i) => ({ num: i + 1, title: c.title, url: c.url }));
  }

  // The other pages a list runs over, named by the first page: [address] (none for a one-page list).
  function tocPageUrls(doc, toc, html) {
    return typeof toc.rule.toc.pages === "function" ? toc.rule.toc.pages(doc, toc.url, html) : [];
  }
  // Pages of links joined in order (each address once), reversed once if the site lists newest first, then numbered by place: like tocChapters.
  function tocJoin(pagesOfLinks, toc) {
    const seen = new Set();
    let all = [];
    for (const links of pagesOfLinks) for (const c of links) if (!seen.has(c.url)) { seen.add(c.url); all.push(c); }
    if (toc.rule.toc.reverse) all = all.reverse();
    return all.map((c, i) => ({ num: i + 1, title: c.title, url: c.url }));
  }

  // The same for a list that is JSON (toc.parse): [{ num, title, url }].
  function tocChaptersFromText(text, toc) {
    return toc.rule.toc.parse(text, toc.url).map((c, i) => ({ num: i + 1, title: c.title, url: c.url }));
  }

  // ---------- the next chapter ----------
  // The address of the next CHAPTER, the way a reader follows it: the page's own "next chapter" link (WebToEpub and the in-page
  // translator do the same where a site has no chapter list to walk). Call it on the last part of a chapter. It never returns a
  // further part of the same chapter, another site, or the page itself.
  const NEXT_SELECTORS = ['link[rel="next"]', 'a[rel="next"]', "a.next-chapter", "a.next_chapter", "a.nextchap", "#next_chapter a", ".next-chap a", ".nav-next a", "a#next", "a#next_url", "a.next"];
  const NEXT_TEXT = /下一[章节節回]|next chapter|^next\s*[›»→>]*$|^[›»→>]+\s*next$/i; // "下一頁" (next page) is a part of this chapter, not the next one
  const PREV_SELECTORS = ['link[rel="prev"]', 'a[rel="prev"]', "a.prev-chapter", "a.prev_chapter", "a.prevchap", "#prev_chapter a", ".prev-chap a", ".nav-previous a", "a#prev", "a#prev_url", "a.prev"];
  const PREV_TEXT = /上一[章节節回]|prev(?:ious)? chapter|^prev(?:ious)?\s*[‹«←<]*$|^[‹«←<]+\s*prev(?:ious)?$/i;

  // The link to the next or the previous chapter, the way a reader follows it. A rule that says where its pages keep them (nav: { next, prev }, CSS selectors:
  // set by the person, or found with the AI button) is believed first; then the usual places and wordings. It never returns another site, the page itself, or
  // a further part of the same chapter. (Call it on the last part of a chapter.)
  function chapterLink(doc, url, which, selectors, wording) {
    const here = chapterId(url);
    const host = hostOf(url);
    const usable = (href) => {
      if (!href || /^\s*(javascript|#)/i.test(href)) return null;
      const found = absolute(href, url);
      if (!found || found === url || hostOf(found) !== host) return null;
      return here && chapterId(found) === here ? null : found;
    };
    const named = (ruleFor(url) || {}).nav;
    if (named && named[which]) {
      try {
        const el = doc.querySelector(named[which]);
        const found = el && usable(el.getAttribute("href"));
        if (found) return found;
      } catch (e) {
        // a selector the browser cannot use: the usual places are tried
      }
    }
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const found = el && usable(el.getAttribute("href"));
      if (found) return found;
    }
    for (const a of doc.querySelectorAll("a")) {
      const text = String(a.textContent || "").trim();
      const found = text && text.length <= 20 && wording.test(text) ? usable(a.getAttribute("href")) : null;
      if (found) return found;
    }
    return null;
  }
  const nextChapter = (doc, url) => chapterLink(doc, url, "next", NEXT_SELECTORS, NEXT_TEXT);
  const prevChapter = (doc, url) => chapterLink(doc, url, "prev", PREV_SELECTORS, PREV_TEXT);

  // The page's own scripts and inline handlers are not wanted (and would only be logged as CSP violations); the text needs neither.
  const stripScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");

  const api = {
    SOURCES, MIRRORS, register, registerAll, extend, hostsOf, waitFor, setUserRules, userHosts: () => Object.keys(USER), rawRule: (host) => RAW[String(host).replace(/^www\./, "").toLowerCase()] || null, registerMirror, mirrorUrl, ruleFor, hostOf, hostForSlug, decode, charsetOf, textOf, nextPart, nextChapter, prevChapter, tocFor, tocLinkOf, tocChapters, tocPageUrls, tocJoin, tocChaptersFromText, stripScripts,
    // for the rules in sources/ that need more than a selector
    helpers: { JUNK, chapterId, absolute, samePart, linksUnder }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RawSources = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
