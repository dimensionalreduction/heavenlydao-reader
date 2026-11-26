// Site rules the person adds themselves, like a userscript manager's own scripts: the built-in rules (sources/) are the approved set, and anything the
// person saves here is added to it, for any site they choose.
//
// A rule is DATA, never code: selectors, an encoding, how a list is laid out. Nothing the person (or a file they import) writes is ever run, and a rule can
// only make the extension fetch pages of its own site. Saved rules live in the extension's storage under "userRules" and can be changed only from the
// extension's own pages (rules.html), never by a website.
//
//   userRules = { "example.com": { spec, enabled, updatedAt } }
//   A rule for a site the extension already knows (a built-in one) sits on top of it: whatever the rule leaves out is the built-in rule's, and the book's
//   selectors are merged field by field. So fixing one thing, like the cover, is a rule with only that: { host, book: { cover: "..." } }.
//   spec = {
//     host      "example.com"                    one site, no "www.", no path
//     name      a label (optional)
//     selector  the element that holds a chapter's text (needed unless the site is a built-in one)
//     slugSuffix  true when a book's address ends in a part the site changes (…/comics/some-book-11fe7da3/…): chapter addresses are kept without it
//               (the site sends the short form on to the right page), so a chapter keeps its key when the site changes it
//     illustrations  true to keep the pictures between a text chapter's paragraphs (they are fetched with the chapter and shown where they are)
//     images    for a site whose chapters are pictures (a comic): the pictures' <img> elements, or the box that holds them. A chapter is then kept as
//               its pictures (image-chapter.js) and `selector` is not needed
//     scriptPictures  { name: "chapterImages", base64: true, prefix: "https://img.example.com" }   for a comic whose chapter page has no <img> for its pictures
//               until a script draws them from a list in the page itself (a Chinese comic CMS's qTcms_S_m_murl_e): the script variable that holds the list
//               (a string, or a [...] / {...}), whether that string is base64, and what goes before an address in it that starts with "/" (the picture server
//               the site's script puts there; left out: the page's own site). Read as `images` is, and with it `selector` is not needed
//     junk      elements inside it to drop (optional; script, style, ins and iframe always go)
//     charset   only when the site does not say its encoding ("gbk", "big5"...)
//     toc       { list: "ul.chapters a" | boxes: "div.lists", pick: "first"|"last"|"2", reverse: true,
//                 pages: { kind: "options"|"links"|"numbered", selector: "#pages option", attr: "value" },   the list runs over several pages
//                        (numbered: the selector finds the page links of a pagination bar, ?page=2 ... ?page=76, and every page up to the highest number is read)
//                 titleDrop: ".small, time",                                  parts of a chapter link that are not its title (the date)
//                 gap: 2000,                                                                       ms between those pages
//                 listUrl: { match: "^https://example\\.com/book/(\\d+)", to: "https://example.com/list/$1" },  the list page from any address of the novel
//                 post: true,                                                                     that address is asked with a POST (a list a page's script asks for so:
//                        the Madara theme's <book>/ajax/chapters/); only with listUrl
//                 json: { items: "items", title: "title", link: "https://example.com/novel/$1/{number}", page: "offset", count: "total" | pages: "last_page" } }
//                        the list is the site's data (JSON) at listUrl, not a page: where the chapters are in it ("" or left out: the data is the list), each one's
//                        title and address ($1 as in listUrl.to, {field} a field of the chapter), the address part that moves through the list (offset, skip,
//                        start, from: by the chapters one part holds; any other, like page: by one) and the field that says how many chapters (count) or parts
//                        (pages) there are
//                 gallery: "#thumbnail-container a"     a book that is one chapter of pictures, each on a page of its own (a doujin gallery, nhentai.net/g/<id>/ and
//                        its pages /g/<id>/1/ ... /26/): the links on the book's page to its pages, in order. The list is then that one chapter, the book's page
//                        itself, and its pictures are the picture on each page (`images` says where it is on them); list, boxes and json are not used
//     json      { match: "^https://example\\.com/novel/([^/?#]+)/(\\d+)", to: "https://example.com/api/novel/$1/chapters/$2", text: "body", next: "https://example.com/novel/$1/{next_number}" }
//               a chapter's text from the site's data (JSON) instead of its page, for a site whose pages a script fills in: the data's address from the chapter's,
//               where the text is in it, and (optional) the next chapter's address ($1 as in match, {field} a field of the data)
//     book      { title, author, description, cover, genre }      where a book's page says what the book is (selectors); titleDrop: parts inside the
//               title to leave out of it (a badge: "span.manga-title-badges")
//     nav       { next, prev }                                    the links to the next and previous chapter on a chapter's page (selectors)
//   }
(function (root) {
  const KEY = "userRules";
  const JUNK = "script, style, ins, iframe";
  const BOOK_FIELDS = ["title", "author", "description", "cover", "genre"];
  const CHARSETS = ["utf-8", "gbk", "gb18030", "big5", "shift_jis", "euc-jp", "euc-kr", "windows-1251", "windows-1252", "iso-8859-1"];
  const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  const MAX_SELECTOR = 500;
  // "some-book-11fe7da3" -> "some-book": a last part of 8 letters and digits with a digit in it, in any part of the path
  const SLUG_TAIL = /-(?=[a-z]*\d)[a-z0-9]{8}$/;
  function dropSlugSuffix(url) {
    try {
      const u = new URL(String(url));
      u.pathname = u.pathname.split("/").map((part) => part.replace(SLUG_TAIL, "")).join("/");
      return u.href;
    } catch (e) {
      return url;
    }
  }

  const str = (v) => (typeof v === "string" ? v.trim() : "");

  // "https://www.Example.com/book/1" or "www.example.com" -> "example.com"; "" when it is not one site.
  function cleanHost(input) {
    let t = str(input).toLowerCase();
    if (!t) return "";
    try {
      t = new URL(t.includes("://") ? t : "https://" + t).hostname;
    } catch (e) {
      return "";
    }
    t = t.replace(/^www\./, "");
    return HOST.test(t) ? t : "";
  }

  // Is this a selector the browser can use? (Without a document, as in the service worker, it cannot be told: the engine copes with a bad one.)
  function selectorOk(sel) {
    if (typeof document === "undefined") return true;
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch (e) {
      return false;
    }
  }

  // The address is https and on the rule's own site (or one of its subdomains).
  function sameSite(url, host) {
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, "");
      return u.protocol === "https:" && (h === host || h.endsWith("." + host));
    } catch (e) {
      return false;
    }
  }

  // The built-in rule of a site (as it was written), or null: the rule a person's own sits on top of.
  function baseFor(host) {
    return host && typeof RawSources !== "undefined" && RawSources.rawRule ? RawSources.rawRule(host) : null;
  }

  // The page numbers of a pagination bar: the links (their addresses) that are one address with one number changed (...?page=2, ...?page=3, ...?page=76).
  // Answers { max, min, template, param, urls }: the highest and lowest number, the address with {n} where the number goes (the query parameter's name when it is
  // one), and the address of every page from 2 to the highest number. null when the links are not page numbers (no group of two or more that differ in one number).
  function pagerOf(hrefs, base) {
    const items = [];
    for (const h of hrefs || []) {
      let u = null;
      try {
        u = new URL(h, base);
      } catch (e) {
        continue;
      }
      if (u.protocol !== "https:") continue;
      const tail = u.pathname + u.search;
      items.push({ u, tail, nums: (tail.match(/\d+/g) || []).map(Number) });
    }
    const groups = new Map();
    for (const it of items) {
      const key = it.u.origin + it.tail.replace(/\d+/g, "#");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    let best = null;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const varying = [];
      for (let i = 0; i < members[0].nums.length; i++) if (new Set(members.map((m) => m.nums[i])).size > 1) varying.push(i);
      if (varying.length !== 1) continue; // (not one number that changes)
      if (!best || members.length > best.members.length) best = { members, at: varying[0] };
    }
    if (!best) return null;
    const numbers = best.members.map((m) => m.nums[best.at]);
    const max = Math.max(...numbers);
    const min = Math.min(...numbers);
    if (!(max >= 2) || max > 1000) return null;
    const top = best.members[numbers.indexOf(max)];
    let seen = -1;
    const tail = top.tail.replace(/\d+/g, (d) => (++seen === best.at ? "{n}" : d));
    const template = top.u.origin + tail;
    const param = (/[?&]([^=&#]+)=\{n\}/.exec(tail) || [])[1] || "";
    const urls = [];
    for (let n = 2; n <= max; n++) urls.push(template.replace("{n}", String(n)));
    return { max, min, template, param, urls };
  }

  // How to get a novel's list page from any address of it (toc.listUrl: { match, to }), from one list page and the address of one chapter on it: the list page's
  // last path part is the book (its slug or id), and the chapter's address holds it too. The pair is tried on the chapter and must give back the list page,
  // else null. `withQuery`: the list is the site's data (/api/...?offset=0&limit=100), whose query is part of the address kept (a page's is its page number);
  // it may be on a part of the site of its own (api.example.com).
  function listUrlRule(listPage, chapterHref, withQuery) {
    let page = null;
    let chapter = null;
    try {
      page = new URL(listPage);
      chapter = new URL(chapterHref, listPage);
    } catch (e) {
      return null;
    }
    const bare = (h) => h.replace(/^www\./, "");
    if (page.protocol !== "https:" || (bare(chapter.hostname) !== bare(page.hostname) && !(withQuery && sameSite(page.href, bare(chapter.hostname))))) return null;
    // a site that names the book in the query (/list?toon=4132, /view?toon=4132&num=7) has no address rule: it cannot say the query, and the first path part is not the book
    if (!withQuery && [...page.searchParams].some(([k, v]) => v.length >= 2 && chapter.searchParams.get(k) === v)) return null;
    const pageParts = page.pathname.split("/").filter(Boolean);
    const chapterParts = chapter.pathname.split("/").filter(Boolean);
    const esc = (t) => t.replace(/[.*+?^$(){}|[\]\\/]/g, "\\$&");
    // The part of the list page's address that is the book: one the chapter's address holds too. The last part usually is (/book/390935), but a list can sit
    // under the book (/novels/<slug>/chapters), then the book is the part that looks like a slug or an id (it has a digit or a hyphen), tried first.
    const sluglike = (t) => /\d|-/.test(t);
    const spots = pageParts.map((t, i) => i).filter((i) => chapterParts.includes(pageParts[i])).reverse();
    spots.sort((x, y) => Number(sluglike(pageParts[y])) - Number(sluglike(pageParts[x])));
    for (const ti of spots) {
      const at = chapterParts.indexOf(pageParts[ti]);
      const match = "^https://(?:www\\.)?" + esc(bare(page.hostname)) + "/" + chapterParts.slice(0, at).map((x) => esc(x) + "/").join("") + "([^/?#]+)(?:[/?#]|$)";
      const to = page.origin + "/" + pageParts.slice(0, ti).concat("$1", pageParts.slice(ti + 1)).join("/") + (page.pathname.endsWith("/") ? "/" : "") + (withQuery ? page.search : "");
      let back = "";
      try {
        const m = new RegExp(match).exec(chapter.href);
        back = m ? expand(to, m, chapter.href) : "";
      } catch (e) {
        back = "";
      }
      if (back && back.split(/[?#]/)[0] === page.origin + page.pathname) return { match, to };
    }
    // ... or, for the site's data (withQuery), the book is inside a query value that is a path of the site: /api/reader?resource=chapters&path=%2Fmanhua%2F<book>%2F
    // (manhuatop.org); the same book's part of the chapter's address, a slug or an id, becomes $1 there
    if (withQuery) {
      const sameQuery = (a, b) => [...a.searchParams].length === [...b.searchParams].length && [...a.searchParams].every(([k, v]) => b.searchParams.get(k) === v);
      for (const [k, v] of page.searchParams) {
        const inside = v.split(/[/?#&=]/);
        for (const part of chapterParts.filter(sluglike)) {
          if (!inside.includes(part)) continue;
          const at = chapterParts.indexOf(part);
          const match = "^https://(?:www\\.)?" + esc(bare(page.hostname)) + "/" + chapterParts.slice(0, at).map((x) => esc(x) + "/").join("") + "([^/?#]+)(?:[/?#]|$)";
          const u = new URL(page.href);
          u.searchParams.set(k, v.split("/" + part + "/").join("/\u0000/").split("/" + part + "?").join("/\u0000?").replace(new RegExp("/" + esc(part) + "$"), "/\u0000"));
          const to = u.href.split("%00").join("$1");
          if (!to.includes("$1")) continue;
          try {
            const m = new RegExp(match).exec(chapter.href);
            const back = m ? new URL(expand(to, m, chapter.href)) : null;
            if (back && back.origin + back.pathname === page.origin + page.pathname && sameQuery(back, page)) return { match, to };
          } catch (e) {
            // not this part
          }
        }
      }
    }
    return null;
  }

  // spec (anything) -> { ok, errors: [{ field, message }], spec: the cleaned copy }. Unknown fields are dropped. `base`: the built-in rule of the site, if
  // it has one (then the chapter selector may be left out, the built-in one is kept).
  function validate(input, base) {
    const errors = [];
    const bad = (field, message) => errors.push({ field, message });
    const raw = input && typeof input === "object" ? input : {};
    const spec = {};

    const host = cleanHost(raw.host);
    if (!host) bad("host", "Give one site, like example.com (no path, no wildcard).");
    else spec.host = host;
    if (str(raw.name)) spec.name = str(raw.name).slice(0, 80);

    const selectorField = (field, value, required) => {
      const v = str(value);
      if (!v) {
        if (required) bad(field, "This is needed: a CSS selector, like div.content.");
        return "";
      }
      if (v.length > MAX_SELECTOR) bad(field, "Too long for a selector.");
      else if (!selectorOk(v)) bad(field, "The browser cannot use this selector.");
      else return v;
      return "";
    };

    // A field of the site's data: a name, or names joined by dots (data.chapters, items.0.title).
    const pathField = (field, value, required, example) => {
      const v = str(value);
      if (!v) {
        if (required) bad(field, "This is needed: a field of the data, like " + example + ".");
        return "";
      }
      if (v.length > 100 || !/^[\w$@-]+(\.[\w$@-]+)*$/.test(v)) bad(field, "A field's name, or names joined by dots, like " + example + ".");
      else return v;
      return "";
    };
    // An address made from parts ($1, {field}): on the rule's own site whatever the parts are.
    const templateField = (field, value, required) => {
      const v = str(value);
      if (!v) {
        if (required) bad(field, "This is needed: an address, like https://" + (host || "example.com") + "/novel/$1/{number}.");
        return "";
      }
      if (v.length > 300) bad(field, "Too long for an address.");
      else if (host && !sameSite(expand(v.replace(/\{[^{}]*\}/g, "x"), ["", "x", "x", "x", "x", "x", "x", "x", "x", "x"], "https://" + host + "/"), host)) bad(field, "The address must be on " + host + ".");
      else return v;
      return "";
    };
    const regexField = (field, value) => {
      const v = str(value);
      try {
        if (v) new RegExp(v);
        else throw new Error("empty");
      } catch (e) {
        bad(field, "The pattern is not a valid regular expression.");
        return "";
      }
      return v;
    };

    // (the chapter text selector is needed for a site with nothing built in, unless the spec is for the chapter list: "Detect with AI" on a book's page saves the
    // list before any chapter's page has been looked at, and the list must work without waiting for the text selector; or the text is read from the site's data)
    const hasJson = raw.json && typeof raw.json === "object" && !!(str(raw.json.match) || str(raw.json.to) || str(raw.json.text));
    const sp = raw.scriptPictures && typeof raw.scriptPictures === "object" && (str(raw.scriptPictures.name) || str(raw.scriptPictures.prefix)) ? raw.scriptPictures : null;
    const selector = selectorField("selector", raw.selector, !base && !(raw.toc && typeof raw.toc === "object") && !hasJson && !str(raw.images) && !sp);
    if (selector) spec.selector = selector;
    const images = selectorField("images", raw.images, false);
    if (images) spec.images = images;
    if (sp) {
      // the chapter's pictures from a list in the page's script: a variable's name (never run: the page's text is only looked through for it), and the server
      // its addresses are on
      const name = str(sp.name);
      const scriptPictures = {};
      if (/^[A-Za-z_$][\w$]{0,79}$/.test(name)) scriptPictures.name = name;
      else bad("scriptPictures.name", "The name of a variable in the page's script, like chapterImages.");
      if (sp.base64 === true) scriptPictures.base64 = true;
      const prefix = str(sp.prefix).replace(/\/+$/, "");
      if (prefix) {
        let ok = false;
        try {
          const u = new URL(prefix);
          ok = u.protocol === "https:" && !u.search && !u.hash && !u.username && !u.password && prefix.length <= 200;
        } catch (e) {
          ok = false;
        }
        if (ok) scriptPictures.prefix = prefix;
        else bad("scriptPictures.prefix", "An https address with no ? or #, like https://img.example.com.");
      }
      if (scriptPictures.name) spec.scriptPictures = scriptPictures;
    }
    if (raw.slugSuffix === true) spec.slugSuffix = true;
    if (raw.illustrations === true) spec.illustrations = true;
    const junk = selectorField("junk", raw.junk, false);
    if (junk) spec.junk = junk;

    const charset = str(raw.charset).toLowerCase();
    if (charset) {
      let known = true;
      try {
        new TextDecoder(charset);
      } catch (e) {
        known = false;
      }
      if (known) spec.charset = charset;
      else bad("charset", "The browser does not know this encoding.");
    }

    if (raw.toc && typeof raw.toc === "object") {
      const t = raw.toc;
      const toc = {};
      const j = t.json && typeof t.json === "object" && (str(t.json.link) || str(t.json.title) || str(t.json.items)) ? t.json : null;
      const gallery = j ? "" : selectorField("toc.gallery", t.gallery, false);
      const list = j || gallery ? "" : selectorField("toc.list", t.list, false);
      const boxes = j || gallery ? "" : selectorField("toc.boxes", t.boxes, false);
      if (gallery) toc.gallery = gallery; // (one chapter, the book's page: no list of links, no order, no pages of the list)
      else if (j) {
        // the list is the site's data
        const json = {};
        const items = pathField("toc.json.items", j.items, false, "data.chapters");
        if (items) json.items = items;
        const title = pathField("toc.json.title", j.title, true, "title");
        if (title) json.title = title;
        const link = templateField("toc.json.link", j.link, true);
        if (link) json.link = link;
        const page = str(j.page);
        if (page && /^[\w.[\]-]{1,40}$/.test(page)) json.page = page;
        else if (page) bad("toc.json.page", "The name of a part of the address, like offset or page.");
        const count = pathField("toc.json.count", j.count, false, "total");
        if (count) json.count = count;
        const pages = pathField("toc.json.pages", j.pages, false, "last_page");
        if (pages && !count) json.pages = pages;
        if (!(t.listUrl && str(t.listUrl.to))) bad("toc.listUrl", "Say where the list's data is: the list's address.");
        toc.json = json;
      } else if (list) toc.list = list;
      else if (boxes) {
        toc.boxes = boxes;
        const pick = str(t.pick).toLowerCase() || "first";
        if (pick === "first" || pick === "last" || /^\d{1,3}$/.test(pick)) toc.pick = pick;
        else bad("toc.pick", 'Use "first", "last" or a number.');
      } else if (str(t.list) === "" && str(t.boxes) === "" && str(t.gallery) === "") bad("toc.list", "The chapter list needs the links' selector, like ul.chapters a.");
      if (t.reverse && !gallery) toc.reverse = true;
      const titleDrop = j || gallery ? "" : selectorField("toc.titleDrop", t.titleDrop, false); // (the parts of a page's links; data has none)
      if (titleDrop) toc.titleDrop = titleDrop;
      if (!j && !gallery && t.pages && typeof t.pages === "object" && str(t.pages.selector)) {
        const selector2 = selectorField("toc.pages", t.pages.selector, false);
        const kind = t.pages.kind === "options" ? "options" : t.pages.kind === "numbered" ? "numbered" : "links";
        if (selector2) toc.pages = { kind, selector: selector2, ...(kind === "options" ? { attr: str(t.pages.attr) || "value" } : {}) };
      }
      if (t.gap !== undefined && t.gap !== "" && t.gap !== null) {
        const gap = Number(t.gap);
        if (Number.isFinite(gap) && gap >= 500 && gap <= 30000) toc.gap = Math.round(gap);
        else bad("toc.gap", "Between 500 and 30000 milliseconds.");
      }
      if (t.listUrl && typeof t.listUrl === "object" && (str(t.listUrl.match) || str(t.listUrl.to))) {
        const match = str(t.listUrl.match);
        const to = str(t.listUrl.to);
        let regexOk = !!match;
        try {
          if (match) new RegExp(match);
        } catch (e) {
          regexOk = false;
        }
        if (!match || !regexOk) bad("toc.listUrl", "The pattern is not a valid regular expression.");
        else if (!to) bad("toc.listUrl", "Say what the list's address is, like https://example.com/list/$1.");
        else if (host && !sameSite(expand(to, [], "https://" + host + "/"), host)) bad("toc.listUrl", "The list must be on " + host + ".");
        else toc.listUrl = { match, to };
      }
      // (the list's address is asked with a POST, as the page's own script asks it: the Madara theme's <book>/ajax/chapters/)
      if (t.post === true && toc.listUrl && !toc.json && !gallery) toc.post = true;
      if (Object.keys(toc).length) spec.toc = toc;
    }

    if (hasJson) {
      // the chapter's text from the site's data
      const j = raw.json;
      const json = {};
      const match = regexField("json.match", j.match);
      if (match) json.match = match;
      const to = templateField("json.to", j.to, true);
      if (to) json.to = to;
      const text = pathField("json.text", j.text, true, "body");
      if (text) json.text = text;
      const next = templateField("json.next", j.next, false);
      if (next) json.next = next;
      spec.json = json;
    }

    if (raw.nav && typeof raw.nav === "object") {
      const nav = {};
      for (const f of ["next", "prev"]) {
        const v = selectorField("nav." + f, raw.nav[f], false);
        if (v) nav[f] = v;
      }
      if (Object.keys(nav).length) spec.nav = nav;
    }

    if (raw.book && typeof raw.book === "object") {
      const book = {};
      for (const f of BOOK_FIELDS) {
        const v = selectorField("book." + f, raw.book[f], false);
        if (v) book[f] = v;
      }
      const drop = selectorField("book.titleDrop", raw.book.titleDrop, false); // (parts inside the title to leave out of it: a badge)
      if (drop && book.title) book.titleDrop = drop;
      if (Object.keys(book).length) spec.book = book;
    }
    return { ok: errors.length === 0, errors, spec };
  }

  // "https://x/list/$1" with the groups of a match filled in; a relative result is made absolute against `base`. "" when it is not an address.
  function expand(template, groups, base) {
    try {
      return new URL(String(template).replace(/\$(\d)/g, (_, i) => encodeURIComponent((groups && groups[Number(i)]) || "")), base).href;
    } catch (e) {
      return "";
    }
  }

  // A gallery's pages (toc.gallery): the addresses the links lead to, in the page's order, each once, on the rule's own site; at most 400 (a chapter's pictures).
  function galleryPages(doc, base, selector, host) {
    let links = [];
    try {
      links = [...doc.querySelectorAll(selector)];
    } catch (e) {
      return [];
    }
    const out = [];
    for (const a of links) {
      const u = expand(a.getAttribute("href") || "", [], base).split("#")[0];
      if (u && u !== String(base).split("#")[0] && sameSite(u, host) && !out.includes(u)) out.push(u);
      if (out.length >= 400) break;
    }
    return out;
  }

  // ---------- a comic's pictures listed in the page's script (scriptPictures) ----------
  // What a script variable is set to in a page's text: `name = "…"`, `name: '…'`, `"name": "…"`, or a [...] / {...} after it; its first value that is not empty, with the
  // script's escapes read (\/ é \x41). "" when the page has none. Only looked through: nothing of the page is run.
  function scriptValue(html, name) {
    const text = String(html || "");
    if (!/^[A-Za-z_$][\w$]{0,79}$/.test(String(name || ""))) return "";
    const re = new RegExp("(?:^|[^\\w$.])[\"']?" + name.replace(/\$/g, "\\$") + "[\"']?\\s*[:=](?!=)\\s*", "g");
    const unescape = (s) => s.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_, u, x, c) => (u || x ? String.fromCharCode(parseInt(u || x, 16)) : c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
    let m;
    while ((m = re.exec(text))) {
      const at = m.index + m[0].length;
      const c = text[at];
      let end = -1;
      if (c === '"' || c === "'" || c === "`") {
        for (let i = at + 1; i < text.length && i < at + 2000000; i++) {
          if (text[i] === "\\") i++;
          else if (text[i] === c) { end = i; break; }
        }
        if (end > at + 1) return unescape(text.slice(at + 1, end));
      } else if (c === "[" || c === "{") {
        let depth = 0;
        let quote = "";
        for (let i = at; i < text.length && i < at + 2000000; i++) {
          const d = text[i];
          if (quote) {
            if (d === "\\") i++;
            else if (d === quote) quote = "";
          } else if (d === '"' || d === "'" || d === "`") quote = d;
          else if (d === "[" || d === "{") depth++;
          else if ((d === "]" || d === "}") && --depth === 0) { end = i; break; }
        }
        if (end > at + 1) return unescape(text.slice(at, end + 1));
      }
    }
    return "";
  }
  // A base64 text as UTF-8 ("" when it is not base64).
  function fromBase64(s) {
    const t = String(s || "").replace(/\s+/g, "");
    if (!t || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return "";
    try {
      const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      return "";
    }
  }
  // The pictures' addresses in a text, as written, in order: whole ones (https://…, //…) and ones from the site's root (/…), each ending in a picture's extension (a query
  // after it is kept). Not one that starts inside a word ("img/1.jpg" is no address from the root). Whatever separates them ($qingtiandy$, commas, quotes) is not part of them.
  const PICTURE_ADDRESS = /(?<![\w.%~-])(?:https?:)?\/[^\s"'<>\\|,;()[\]{}]*?\.(?:jpe?g|png|webp|gif|avif|bmp)(?![\w])(?:\?[^\s"'<>\\|,;()[\]{}$]*)?/gi;
  function pictureAddressesIn(text) {
    return String(text || "").match(PICTURE_ADDRESS) || [];
  }
  // A chapter's pictures from the list in its page's script (rule.scriptPictures: { name, base64, prefix }): absolute https addresses, in order, each once; at most 400.
  // An address from the site's root goes on the prefix's server (the one the site's script puts it on), else on the page's own.
  function picturesInScript(html, sp, base) {
    if (!sp || !sp.name) return [];
    let value = scriptValue(html, sp.name);
    if (sp.base64) value = fromBase64(value).replace(/\\\//g, "/");
    const out = [];
    for (const raw of pictureAddressesIn(value)) {
      let a = raw;
      if (a.startsWith("//")) a = "https:" + a;
      else if (a.startsWith("/") && sp.prefix) a = sp.prefix + a;
      let u;
      try {
        u = new URL(a, base);
      } catch (e) {
        continue;
      }
      if (u.protocol !== "https:" || out.includes(u.href)) continue;
      out.push(u.href);
      if (out.length >= 400) break;
    }
    return out;
  }

  // Finding such a list (Detect, and the popup over a chapter's page)
  // A chapter's page with no <img> for its pictures until its script draws them, from a list in the page itself (a Chinese comic CMS keeps it, base64, in
  // qTcms_S_m_murl_e: addresses from the site's root, put by its script on a picture server it picks). The variables a page's own scripts set to a string or a
  // [...] / {...} whose text (as it is, or read as base64) lists 3 pictures or more: [{ name, base64, addresses }].
  function scriptLists(html) {
    const scripts = [...String(html || "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2]);
    const names = [];
    for (const s of scripts) for (const m of s.matchAll(/(?:^|[^\w$.])["']?([A-Za-z_$][\w$]{0,79})["']?\s*[:=](?!=)\s*["'`[{]/g)) if (!names.includes(m[1]) && names.length < 300) names.push(m[1]);
    const out = [];
    for (const name of names) {
      const value = scriptValue(html, name);
      if (!value) continue;
      for (const base64 of [false, true]) {
        const addresses = pictureAddressesIn(base64 ? fromBase64(value).replace(/\\\//g, "/") : value);
        if (addresses.length >= 3) out.push({ name, base64, addresses });
      }
    }
    return out;
  }
  // From the page as sent (`html`, its scripts in it) and the pictures it shows once its script has run (`shown`: their addresses, as the browser has them): the list
  // that names them, and the server they are shown from when its addresses are from the site's root. Nothing is guessed: a rule is kept only when it gives back
  // pictures the page shows; of several lists, the longest (a chapter's pages, not a few banners). -> { scriptPictures: { name, base64?, prefix? }, count } or null.
  function scriptPicturesFor(html, shown, pageUrl) {
    const seen = new Set();
    for (const s of shown || []) {
      try {
        const u = new URL(s, pageUrl);
        if (u.protocol === "https:") seen.add(u.href);
      } catch (e) {
        // not an address
      }
    }
    if (!seen.size) return null;
    const origins = [...new Set([...seen].map((h) => new URL(h).origin))];
    let page;
    try {
      page = new URL(pageUrl);
    } catch (e) {
      return null;
    }
    let best = null;
    for (const list of scriptLists(html)) {
      const servers = new Map(); // where the list's addresses from the root are shown from: how many
      for (const a of list.addresses) {
        if (/^(https?:)?\/\//i.test(a)) continue;
        for (const o of origins) {
          let href = "";
          try {
            href = new URL(a, o).href;
          } catch (e) {
            continue;
          }
          if (seen.has(href)) servers.set(o, (servers.get(o) || 0) + 1);
        }
      }
      const server = [...servers.entries()].sort((x, y) => y[1] - x[1])[0];
      const prefix = server && server[0] !== page.origin ? server[0] : "";
      const spec = { name: list.name, ...(list.base64 ? { base64: true } : {}), ...(prefix ? { prefix } : {}) };
      const urls = picturesInScript(html, spec, pageUrl);
      const back = urls.filter((u) => seen.has(u)).length;
      if (urls.length >= 3 && back >= 1 && (!best || urls.length > best.count || (urls.length === best.count && back > best.back))) best = { scriptPictures: spec, count: urls.length, back };
    }
    return best ? { scriptPictures: best.scriptPictures, count: best.count } : null;
  }

  // ---------- the site's data (JSON) ----------
  // A field of the data by its path ("data.chapters", "items.0.title"; "" is the data itself), or undefined.
  function jsonAt(data, path) {
    let v = data;
    for (const k of String(path || "").split(".").filter(Boolean)) {
      if (v == null || typeof v !== "object") return undefined;
      v = v[k];
    }
    return v;
  }

  // The parts of `url` that the $1, $2... of `template` stand for, when the address was made from it: [, "the-slug", "5"] (empty where it was not).
  function groupsOf(template, url) {
    const out = [];
    let u = null;
    try {
      u = new URL(url);
    } catch (e) {
      return out;
    }
    const [path, query] = String(template).split("#")[0].split("?");
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const fit = (pattern, text) => {
      const nums = [];
      const m = new RegExp("^" + esc(pattern).replace(/\\\$(\d)/g, (_, n) => (nums.push(Number(n)), "([^/?#&]*)")) + "$").exec(text);
      if (m) nums.forEach((n, i) => {
        try {
          out[n] = decodeURIComponent(m[i + 1]);
        } catch (e) {
          out[n] = m[i + 1];
        }
      });
    };
    fit(path.replace(/^https?:\/\/[^/]+/, ""), u.pathname);
    // (forEach, not for...of: a Firefox content script, where Detect with AI runs this, cannot iterate the page's URLSearchParams)
    new URLSearchParams(query || "").forEach((v, k) => {
      if (/\$\d/.test(v)) fit(v, u.searchParams.get(k) || "");
    });
    return out;
  }

  // An address made from a template: $1, $2... from `groups`, {field} from the data `item`. A template that is one field ("{url}") takes it as it is; inside
  // an address a field is one part of it. "" when a field is missing.
  function fillLink(template, groups, item, base) {
    const whole = /^\{([^{}]+)\}$/.exec(template);
    if (whole) {
      const v = jsonAt(item, whole[1]);
      return typeof v === "string" && v ? expand(v, [], base) : "";
    }
    let missing = false;
    const t = String(template).replace(/\{([^{}]+)\}/g, (_, f) => {
      const v = jsonAt(item, f);
      if ((typeof v !== "string" && typeof v !== "number") || v === "") missing = true;
      return encodeURIComponent(String(v));
    });
    return missing ? "" : expand(t, groups, base);
  }

  // A chapter's text as the data holds it -> one paragraph per line. Text with markup (<p>, <br>, <em>) is read the way a page's text is; a "<" that does not
  // start one of those tags is the story's own ("<System>", "<Skill: Fireball>") and stays.
  const TAGS = "p|br|div|span|em|i|b|strong|u|s|a|h[1-6]|li|ul|ol|blockquote|hr|img|sup|sub|small|font|center|table|tbody|thead|tr|td|th|section|article|ruby|rt|rp";
  const MARKUP = new RegExp("<\\/?(?:" + TAGS + ")(?:\\s[^<>]*)?\\/?>", "i");
  const NOT_A_TAG = new RegExp("<(?!\\/?(?:" + TAGS + "|script|style|iframe|ins)[\\s/>])", "gi");
  function linesOf(value) {
    if (typeof value !== "string") return "";
    let text = value;
    if (MARKUP.test(value)) {
      const html = value.replace(NOT_A_TAG, "&lt;");
      if (typeof DOMParser !== "undefined") {
        const box = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html").body;
        box.querySelectorAll(JUNK).forEach((n) => n.remove());
        box.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
        box.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr, section").forEach((el) => el.append("\n"));
        text = box.textContent || "";
      } else {
        text = html.replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|li|h\d|blockquote|tr|section|article)>/gi, "\n").replace(new RegExp(MARKUP.source, "gi"), "")
          .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      }
    }
    return text.split(/\n+/).map((l) => l.replace(/　/g, " ").trim()).filter(Boolean).join("\n");
  }

  // One part of a list that is the site's data -> [{ title, url }] (`json`: the rule's toc.json; `to`: the list's address template, for $1).
  function dataChapters(text, base, json, to, host) {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return [];
    }
    const items = jsonAt(data, json.items);
    if (!Array.isArray(items)) return [];
    const groups = groupsOf(to, base);
    const out = [];
    const seen = new Set();
    for (const item of items) {
      const url = item && typeof item === "object" ? fillLink(json.link, groups, item, base) : "";
      if (!url || seen.has(url) || !sameSite(url, host)) continue;
      seen.add(url);
      const title = jsonAt(item, json.title);
      out.push({ title: typeof title === "string" || typeof title === "number" ? String(title).replace(/\s+/g, " ").trim() : "", url });
    }
    return out;
  }

  // The other parts of such a list, named by the first: its address with the moving part (json.page) set for each of them, up to the count the data gives.
  // An offset (offset, skip, start, from) moves by the chapters the first part holds, anything else (page) by one.
  function dataPages(text, base, json, host) {
    if (!json.page || !(json.count || json.pages)) return [];
    let data = null;
    let u = null;
    try {
      data = JSON.parse(text);
      u = new URL(base);
    } catch (e) {
      return [];
    }
    const items = jsonAt(data, json.items);
    const size = Array.isArray(items) ? items.length : 0;
    if (!size) return [];
    const byItems = /offset|skip|start|from/i.test(json.page);
    const given = u.searchParams.has(json.page) ? Number(u.searchParams.get(json.page)) : NaN;
    const first = Number.isFinite(given) ? given : byItems ? 0 : 1;
    const count = Number(jsonAt(data, json.count));
    const parts = Number(jsonAt(data, json.pages));
    const out = [];
    const at = (n) => {
      u.searchParams.set(json.page, String(n));
      if (sameSite(u.href, host)) out.push(u.href);
    };
    if (byItems) {
      const total = json.count ? count : parts * size;
      for (let n = first + size; Number.isFinite(total) && n < total && out.length < 1000; n += size) at(n);
    } else {
      const last = (json.pages ? parts : Math.ceil(count / size)) + first - 1;
      for (let n = first + 1; Number.isFinite(last) && n <= last && out.length < 1000; n++) at(n);
    }
    return out;
  }

  // A validated spec -> the rule the engine runs (raw-sources.js). Everything it can make the extension fetch stays on the rule's site. `base`: the
  // site's built-in rule: what the spec leaves out is kept, its junk is added to, and its book selectors are merged with the spec's.
  function toRule(spec, base) {
    const host = spec.host;
    const own = {};
    if (spec.selector) own.selector = spec.selector;
    if (spec.images) own.images = spec.images;
    if (spec.scriptPictures) {
      // (the chapter's pictures from the list in its page's script: p2p-host.js readChapter hands it the page's text, scripts and all)
      const sp = spec.scriptPictures;
      own.scriptPictures = sp;
      own.picturesFromHtml = (html, url) => picturesInScript(html, sp, url);
    }
    if (spec.slugSuffix) own.canonical = dropSlugSuffix;
    if (spec.illustrations) own.illustrations = true;
    if (spec.junk || !base) own.junk = (base && base.junk ? base.junk : JUNK) + (spec.junk ? ", " + spec.junk : "");
    if (spec.charset) own.charset = spec.charset;
    if (spec.toc) {
      const t = spec.toc;
      const toc = {};
      if (t.list && t.titleDrop) {
        // the links of the list, each title without the parts that are not it (the date in a small element)
        const { list: selector, titleDrop } = t;
        toc.list = (doc, base2) => {
          const out = [];
          const seen = new Set();
          let links = [];
          try {
            links = [...doc.querySelectorAll(selector)];
          } catch (e) {
            return [];
          }
          for (const a of links) {
            const url = expand(a.getAttribute("href") || "", [], base2);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            const copy = a.cloneNode(true);
            try {
              copy.querySelectorAll(titleDrop).forEach((n) => n.remove());
            } catch (e) {
              // a selector the browser cannot use: the whole text is the title
            }
            out.push({ title: String(copy.textContent || "").replace(/\s+/g, " ").trim(), url });
          }
          return out;
        };
      } else if (t.list) toc.list = t.list;
      if (t.gallery) {
        // one chapter, the book's page itself (named for the book), when the page has its links to its pages; the chapter's pictures are read from those pages
        // (p2p-host.js readChapter, through galleryPages)
        const selector = t.gallery;
        const titleSel = spec.book && spec.book.title;
        toc.gallery = selector;
        toc.galleryPages = (doc, base2) => galleryPages(doc, base2, selector, host);
        toc.list = (doc, base2) => {
          if (!galleryPages(doc, base2, selector, host).length) return [];
          const text = (sel) => {
            try {
              const e = sel && doc.querySelector(sel);
              return e ? String(e.textContent || "").replace(/\s+/g, " ").trim() : "";
            } catch (e) {
              return "";
            }
          };
          const title = text(titleSel) || text("h1") || String(doc.title || "").trim() || "Chapter 1";
          return [{ title: title.slice(0, 200), url: String(base2).split("#")[0] }];
        };
      }
      if (t.json) {
        // the list is the site's data: read from the response's text (the engine hands it over as the last argument), its other parts named by the first
        const json = t.json;
        const to = t.listUrl ? t.listUrl.to : "";
        toc.list = (doc, base2, text) => dataChapters(text, base2, json, to, host);
        toc.pages = (doc, base2, text) => dataPages(text, base2, json, host);
        toc.data = true;
      }
      if (t.boxes) {
        toc.boxes = t.boxes;
        toc.pick = t.pick || "first";
      }
      if (typeof t.reverse === "boolean") toc.reverse = t.reverse;
      if (t.gap) toc.gap = t.gap;
      if (t.pages && !t.json) {
        const { kind, selector, attr } = t.pages;
        toc.windowed = kind === "numbered"; // (a bar of page links may show a window of the pages: the list's reader follows it to the end, p2p-host.js)
        toc.pages = (doc, base2) => {
          let els = [];
          try {
            els = [...doc.querySelectorAll(selector)];
          } catch (e) {
            return [];
          }
          if (kind === "numbered") {
            const found = pagerOf(els.map((e) => e.getAttribute("href")), base2);
            return found ? found.urls.filter((u) => u !== base2 && sameSite(u, host)) : [];
          }
          const out = [];
          for (const e of els) {
            const value = kind === "options" ? e.getAttribute(attr || "value") : e.getAttribute("href");
            const u = value ? expand(value, [], base2) : "";
            if (u && u !== base2 && sameSite(u, host) && !out.includes(u)) out.push(u);
          }
          return out;
        };
      }
      if (t.listUrl) {
        let re = null;
        try {
          re = new RegExp(t.listUrl.match);
        } catch (e) {
          re = null;
        }
        toc.url = (address) => {
          const m = re && re.exec(String(address));
          if (!m) return null;
          const url = expand(t.listUrl.to, m, address);
          return sameSite(url, host) ? url : null;
        };
        // a list asked with a POST: post(list address, the address it was found from) says whether this one is (one this rule's own address makes; a
        // built-in rule's address under it, where this one does not fit, is asked as usual)
        if (t.post) {
          const mine = toc.url;
          toc.post = (listAddress, from) => !!listAddress && mine(from) === listAddress;
        }
      }
      own.toc = toc;
    }
    if (spec.json) {
      // the chapter's text from the site's data: the engine fetches textUrl(the chapter's address) instead of the page, and fromHtml reads the text out of it
      const { match, to, text: field, next } = spec.json;
      let re = null;
      try {
        re = new RegExp(match);
      } catch (e) {
        re = null;
      }
      own.textUrl = (address) => {
        const m = re && re.exec(String(address));
        if (!m) return null;
        const url = expand(to, m, address);
        return sameSite(url, host) ? url : null;
      };
      own.fromHtml = async (body, url) => {
        let data = null;
        try {
          data = JSON.parse(body);
        } catch (e) {
          return null;
        }
        const text = linesOf(jsonAt(data, field));
        if (!text) return null;
        const after = next && data && typeof data === "object" ? fillLink(next, groupsOf(to, url), data, url) : "";
        return { text, next: after && sameSite(after, host) ? after : null };
      };
    }
    if (spec.book) own.book = spec.book;
    if (spec.nav) own.nav = spec.nav;
    if (!base) return { ...own, user: true, from: "added by you" };
    const merged = { ...base, ...own, user: true, from: "added by you, on top of the built-in rule" };
    if (base.toc && own.toc) {
      // the person's list settings go on top of the built-in ones: a list of their own replaces the built-in way of reading the links (and its order),
      // but the rest stays (where the list page is, its other pages, the pause), unless they set it too
      const kept = { ...base.toc };
      if (own.toc.list || own.toc.boxes) for (const k of ["list", "boxes", "pick", "parse", "read", "reverse"]) delete kept[k];
      merged.toc = { ...kept, ...own.toc };
      // a list address of their own is tried first, and the built-in one where theirs does not fit (Detect with AI makes one from a chapter's address,
      // which says nothing of the book's own page: the address a recorded book asks for its list with)
      if (own.toc.url && kept.url) {
        const mine = own.toc.url;
        const builtin = kept.url;
        merged.toc.url = (address) => mine(address) || builtin(address);
      }
    }
    if (base.book || own.book) merged.book = { ...(base.book || {}), ...(own.book || {}) };
    if (base.nav || own.nav) merged.nav = { ...(base.nav || {}), ...(own.nav || {}) };
    return merged;
  }

  // userRules (as stored) -> { rules: { host: rule }, problems: [text] } for the rules that are switched on and valid.
  function compile(stored) {
    const rules = {};
    const problems = [];
    for (const [key, entry] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
      if (!entry || entry.enabled === false) continue;
      const base = baseFor(cleanHost(entry.spec && entry.spec.host) || key);
      const v = validate(entry.spec, base);
      if (!v.ok) problems.push(key + ": " + v.errors.map((e) => e.message).join(" "));
      else rules[v.spec.host] = toRule(v.spec, base);
    }
    return { rules, problems };
  }

  // What the book-recording script needs: for each rule that has book selectors, the person's own selectors (and the chapter selector, if they gave one).
  // The script merges them with the built-in table, field by field, where a site has a built-in rule.
  function bookTable(stored) {
    const table = {};
    for (const [key, entry] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
      if (!entry || entry.enabled === false) continue;
      const v = validate(entry.spec, {}); // (the chapter selector may be missing: it is the built-in rule's)
      if (v.ok && v.spec.book) table[v.spec.host] = { book: v.spec.book, ...(v.spec.selector ? { selector: v.spec.selector } : {}) };
    }
    return table;
  }

  // The saved rules with book selectors set for `host` (picks: { cover: "...", title: "..." }; blank ones are left as they were). A rule for the site is made
  // if it has none, on top of the built-in one. Pure: the map it is given is not changed.
  function withBookSelectors(stored, host, picks, now) {
    const next = { ...(stored && typeof stored === "object" ? stored : {}) };
    const entry = next[host] || { spec: { host }, enabled: true };
    const book = { ...((entry.spec && entry.spec.book) || {}) };
    for (const f of BOOK_FIELDS) if (picks && typeof picks[f] === "string" && picks[f].trim()) book[f] = picks[f].trim();
    // (what to leave out of the title, a badge in it, goes with the title: a title set without it drops the one the old title had)
    if (picks && typeof picks.title === "string" && picks.title.trim()) {
      if (typeof picks.titleDrop === "string" && picks.titleDrop.trim()) book.titleDrop = picks.titleDrop.trim();
      else delete book.titleDrop;
    }
    const spec = { ...entry.spec, host };
    if (Object.keys(book).length) spec.book = book; // (no empty book part is made when nothing about the book was found)
    next[host] = { ...entry, spec, enabled: true, updatedAt: now || Date.now() };
    return next;
  }

  // The saved rules with what was found on a page set for `host`: { book: { title, ... }, toc: { list, reverse }, nav: { next, prev }, selector, json } (any part may
  // be missing).
  // The book selectors and the nav links are set field by field; a found chapter list replaces the rule's list selector and keeps its other list settings
  // (pages, pause, the list's address). A rule is made if the site has none, on top of the built-in one. Pure: the map it is given is not changed.
  function withDetected(stored, host, found, now) {
    const f = found || {};
    const next = withBookSelectors(stored, host, f.book, now);
    const entry = next[host];
    const spec = { ...entry.spec };
    if (f.nav) {
      const nav = { ...(spec.nav || {}) };
      for (const k of ["next", "prev"]) if (typeof f.nav[k] === "string" && f.nav[k].trim()) nav[k] = f.nav[k].trim();
      if (Object.keys(nav).length) spec.nav = nav;
    }
    if (f.toc && typeof f.toc.gallery === "string" && f.toc.gallery.trim()) {
      // a book of one chapter whose pictures are each on a page of their own: its links to its pages replace any list (only the pause stays)
      const toc = { ...(spec.toc || {}) };
      for (const k of ["list", "boxes", "pick", "pages", "titleDrop", "json", "reverse", "post"]) delete toc[k];
      toc.gallery = f.toc.gallery.trim();
      if (f.toc.listUrl && f.toc.listUrl.match && f.toc.listUrl.to) toc.listUrl = { match: f.toc.listUrl.match, to: f.toc.listUrl.to };
      else if ("listUrl" in f.toc) delete toc.listUrl;
      spec.toc = toc;
    } else if (f.toc && f.toc.json && typeof f.toc.json === "object" && f.toc.listUrl && f.toc.listUrl.match && f.toc.listUrl.to) {
      // a list that is the site's data replaces a list read from a page, whatever it was (only the pause stays)
      const toc = { ...(spec.toc || {}) };
      for (const k of ["list", "boxes", "pick", "pages", "titleDrop", "gallery", "post"]) delete toc[k];
      toc.json = { ...f.toc.json };
      toc.listUrl = { match: f.toc.listUrl.match, to: f.toc.listUrl.to };
      if (f.toc.reverse === true) toc.reverse = true;
      else delete toc.reverse;
      spec.toc = toc;
    } else if (f.toc && typeof f.toc.list === "string" && f.toc.list.trim()) {
      const toc = { ...(spec.toc || {}) };
      delete toc.boxes; // (a list found by its links replaces a list read from a box)
      delete toc.pick;
      delete toc.json; // (and one read from the site's data)
      delete toc.gallery; // (and a book's pages)
      toc.list = f.toc.list.trim();
      if (f.toc.reverse === true) toc.reverse = true;
      else if (f.toc.reverse === false) delete toc.reverse;
      // the list's other pages: a found pagination bar replaces what was there; a list found with none is on one page here (a pause set by hand stays)
      if ("pages" in f.toc) {
        if (f.toc.pages && typeof f.toc.pages.selector === "string" && f.toc.pages.selector.trim()) toc.pages = { kind: f.toc.pages.kind || "numbered", selector: f.toc.pages.selector.trim() };
        else delete toc.pages;
      }
      if ("titleDrop" in f.toc) {
        if (typeof f.toc.titleDrop === "string" && f.toc.titleDrop.trim()) toc.titleDrop = f.toc.titleDrop.trim();
        else delete toc.titleDrop;
      }
      // how to reach the list page from a chapter's address
      if (f.toc.listUrl && f.toc.listUrl.match && f.toc.listUrl.to) toc.listUrl = { match: f.toc.listUrl.match, to: f.toc.listUrl.to };
      else if ("listUrl" in f.toc) delete toc.listUrl; // (the list was tried and no address rule holds up: one saved by an earlier run, that does not, goes)
      // asked with a POST (the list found in what the page's script asked for that way): only with the address it was found at
      if (f.toc.post === true && toc.listUrl) toc.post = true;
      else delete toc.post;
      spec.toc = toc;
    }
    // the chapter's text from the site's data
    if (f.json && f.json.match && f.json.to && f.json.text) spec.json = { match: f.json.match, to: f.json.to, text: f.json.text, ...(f.json.next ? { next: f.json.next } : {}) };
    // where a chapter's text is on its page (found on two chapters as the site sends them)
    if (typeof f.selector === "string" && f.selector.trim()) spec.selector = f.selector.trim();
    // where a comic's pictures are: a site whose chapters are pictures has them kept, not their text
    if (typeof f.images === "string" && f.images.trim()) spec.images = f.images.trim();
    // ... or the list of them in its page's script, and the server they are on
    if (f.scriptPictures && typeof f.scriptPictures.name === "string" && f.scriptPictures.name.trim()) {
      spec.scriptPictures = { name: f.scriptPictures.name.trim(), ...(f.scriptPictures.base64 === true ? { base64: true } : {}), ...(typeof f.scriptPictures.prefix === "string" && f.scriptPictures.prefix.trim() ? { prefix: f.scriptPictures.prefix.trim() } : {}) };
    }
    next[host] = { ...entry, spec };
    return next;
  }

  // Puts the rules into the engine (replacing the ones it had). Returns the problems found.
  let lastStored = {}; // the saved rules as they were last applied (current())
  function apply(stored) {
    lastStored = stored && typeof stored === "object" ? stored : {};
    const { rules, problems } = compile(stored);
    if (typeof RawSources !== "undefined" && RawSources.setUserRules) RawSources.setUserRules(rules);
    for (const p of problems) console.debug("[user rules] not used:", p);
    return { count: Object.keys(rules).length, problems };
  }

  // Keeps the engine's user rules in step with what is saved. Where the extension's storage can be read (the service worker, Firefox's background page,
  // the extension's own pages) it reads it and follows changes; the offscreen document of Chrome has no storage, so the service worker answers
  // { target: "p2p-bg", op: "getUserRules" } and sends { target: "user-rules", stored } whenever the rules change.
  // A page that was handed the rules (window.__USER_RULES__, for a script injected into a tab) just uses them.
  function start(ext) {
    if (root.__USER_RULES__) apply(root.__USER_RULES__);
    const hasStorage = !!(ext && ext.storage && ext.storage.local);
    let ready;
    if (hasStorage) {
      ready = ext.storage.local.get(KEY).then((r) => apply(r[KEY] || {}));
      ext.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[KEY]) apply(changes[KEY].newValue || {});
      });
    } else if (ext && ext.runtime && ext.runtime.sendMessage) {
      ready = Promise.resolve(ext.runtime.sendMessage({ target: "p2p-bg", op: "getUserRules" }))
        .then((reply) => apply((reply && reply.result) || {}))
        .catch(() => {});
      ext.runtime.onMessage.addListener((msg) => {
        if (msg && msg.target === "user-rules" && msg.stored) apply(msg.stored);
      });
    } else ready = Promise.resolve();
    api.ready = ready;
    return ready;
  }

  const api = { KEY, JUNK, dropSlugSuffix, BOOK_FIELDS, CHARSETS, cleanHost, baseFor, pagerOf, listUrlRule, validate, toRule, compile, bookTable, withBookSelectors, withDetected, apply, current: () => lastStored, start, sameSite, expand, jsonAt, groupsOf, fillLink, linesOf, scriptValue, fromBase64, pictureAddressesIn, picturesInScript, scriptLists, scriptPicturesFor, ready: Promise.resolve() };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.UserRules = api;
  if (root.__USER_RULES__) apply(root.__USER_RULES__); // a script injected into a tab is handed the rules before it runs
})(typeof globalThis !== "undefined" ? globalThis : this);
