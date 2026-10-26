// "Detect with AI": finds the parts of a page the way the picker would, but by asking Gemini: on a book's page its title, author, synopsis, cover, genres and a
// complete CHAPTER LIST RULE (the links, the pagination bar that gives the other pages, which way the list runs, and how to reach the list page from a chapter's
// address: the same rule "Refresh chapters" runs, tried on the page before it is kept); on a chapter's page the links to the next and previous chapter. Injected into the tab from the popup, together with user-rules.js.
//
// The page is reduced to a short list of CANDIDATES (elements with a snippet of their text, pictures, groups of links, lists of chapter links, links that say
// next or previous), each with an id. Gemini only says which id is which; the selectors are made here, from the elements themselves, and each one is checked on
// the page before it is kept. So nothing Gemini says can become anything but a selector that finds the element it named. What is sent is the candidates (about
// 100 snippets of at most 160 characters, picture and link addresses), not the page. The answer is saved like a picked part is (a rule on top of the site's own),
// the book is recorded again, and the bar that says what was found offers Undo.
// The list (and a chapter's text) is then looked for in the page as the site sends it, which is what the extension will fetch: on a site whose pages a script
// fills in from its own data (JSON), it is not there, and the rule is made to read that data instead (listFromData, textInData; nothing is sent to Gemini for it).
// On a site that sends its pages whole, where a chapter's text is comes from two chapters' pages as sent (textSelectorFor: on a book's page, its first two chapters).
(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const Rules = typeof UserRules !== "undefined" ? UserRules : isNode ? require("./user-rules.js") : null; // (injected before this script; pagerOf and listUrlRule are in it)
  const MAX_CANDIDATES = 130;
  const SNIPPET = 160;
  const SKIP = "nav, footer, form, script, style, noscript, template, select, svg, iframe";
  const MORE = /更多|查看全部|全部章|全部目|more chapters|all chapters|view all|show all|see all|full list|complete list|目录|目錄|catalog/i; // a link at the end of a list that leads to the whole of it
  const MOVE = /next|prev|older|newer|上一|下一|前一|后一|後一|上頁|下頁|上页|下页|←|→|‹|›|«|»/i; // wording, rel, id or class of a link that moves between pages

  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const escapeCss = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, "\\$&"));
  const pathOf = (href) => String(href || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 80);

  // Classes that name what an element is (and will be there on another book's page too), not generated ones.
  const stableClasses = (el) => [...(el.classList || [])].filter((c) => /^[a-zA-Z][\w-]{1,30}$/.test(c) && !/\d{3,}/.test(c)).slice(0, 3);

  function segment(el, withPosition) {
    let s = el.tagName.toLowerCase();
    const classes = stableClasses(el);
    if (classes.length) s += "." + classes.map(escapeCss).join(".");
    if (withPosition && el.parentElement) {
      const same = [...el.parentElement.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
    }
    return s;
  }

  // A selector that finds exactly this element on the page: its id, or its tag and classes, or the path from an ancestor; "" when none does.
  // `noIds`: without ids (a site may number them per chapter, id="chapter-1234").
  function selectorFor(el, doc, noIds) {
    const unique = (sel) => {
      try {
        const found = doc.querySelectorAll(sel);
        return found.length === 1 && found[0] === el;
      } catch (e) {
        return false;
      }
    };
    if (!noIds && el.id && unique("#" + escapeCss(el.id))) return "#" + escapeCss(el.id);
    let bare = ""; // a bare tag that happens to be unique here ("img"): kept only if nothing more specific is
    for (const withPosition of [false, true]) {
      const parts = [segment(el, withPosition)];
      if (unique(parts[0])) {
        if (/[.#:]/.test(parts[0])) return parts[0];
        bare = bare || parts[0];
      }
      let node = el.parentElement;
      for (let depth = 0; node && node !== doc.documentElement && depth < 6; depth++, node = node.parentElement) {
        if (!noIds && node.id && node.id.length < 40) {
          const withId = ["#" + escapeCss(node.id), ...parts].join(" > ");
          if (unique(withId)) return withId;
        }
        parts.unshift(segment(node, withPosition));
        const sel = parts.join(" > ");
        if (unique(sel)) return sel;
      }
    }
    return bare;
  }

  // An element inside a run of look-alike rows (20 chapter rows, a page of comments): only the first two rows are offered, so the rows do not use up the
  // candidates that the details further down need.
  const repeated = (el, body) => {
    for (let n = el, depth = 0; n && n !== body && n.parentElement && depth < 8; n = n.parentElement, depth++) {
      const kin = [...n.parentElement.children].filter((c) => c.tagName === n.tagName && c.className === n.className);
      if (kin.length >= 6 && kin.indexOf(n) >= 2) return true;
    }
    return false;
  };

  // A menu or a list of links (a sidebar, a footer's links, a list of commenters): most of its text is link text. Its words are not details of the book.
  // `listed`: the links of the long lists on the page (a chapter list), left out of the count: a book's page whose details sit beside its chapter list, in one
  // box (a page a script draws, as chikari.moe's), is not a menu.
  const linkHeavy = (el, cache, listed) => {
    if (!cache.has(el)) {
      let n = 0;
      let linked = 0;
      let skipped = 0;
      for (const a of el.querySelectorAll("a[href]")) {
        const len = clean(a.textContent).length;
        if (listed && listed.has(a)) skipped += len;
        else {
          n++;
          linked += len;
        }
      }
      cache.set(el, n >= 6 && linked >= (clean(el.textContent).length - skipped) * 0.7);
    }
    return cache.get(el);
  };

  const hidden = (el) => !!(el.hidden || (el.getAttribute && /display:\s*none/i.test(el.getAttribute("style") || "")));

  // [{ id, kind, ... }] and { id: selector } for the page. kind "text": an element and the start of its text; "img" / "meta": a picture; "group": a set of
  // short links (genres, tags); "list": a container of many links (a chapter list), with its first and last entries; "link": a link that says next or previous.
  function collect(doc, url) {
    const candidates = [];
    const selectors = {};
    const seen = new Set();
    const add = (c, selector) => {
      if (!selector || candidates.length >= MAX_CANDIDATES) return;
      c.id = "c" + (candidates.length + 1);
      candidates.push(c);
      selectors[c.id] = selector;
    };
    const body = doc.body || doc.documentElement;

    // links that move between chapters (and <link rel> in the head)
    let moves = 0;
    for (const a of doc.querySelectorAll('link[rel="next"], link[rel="prev"], a[href]')) {
      if (moves >= 10 || hidden(a)) continue;
      const rel = a.getAttribute("rel") || "";
      const hint = [a.textContent, rel, a.id, typeof a.className === "string" ? a.className : "", a.getAttribute("title"), a.getAttribute("aria-label")].join(" ");
      const href = a.getAttribute("href") || "";
      if (!MOVE.test(hint) || !href || /^\s*(javascript|#)/i.test(href)) continue;
      const selector = a.tagName === "LINK" ? 'link[rel="' + rel + '"]' : selectorFor(a, doc);
      moves++;
      add({ kind: "link", tag: a.tagName.toLowerCase(), text: clean(a.textContent).slice(0, 40) || undefined, rel: rel || undefined, href: pathOf(href), classes: stableClasses(a).join(" ") || undefined }, selector);
    }

    // links to a neighbouring chapter that say nothing (an arrow icon): the address is this page's own with one number changed (.../4 and .../6 on chapter 5);
    // "delta" is how much the number changed. Icon classes (fa-chevron-left) are passed on as a hint.
    if (url) {
      const numbers = (path) => (String(path).match(/\d+/g) || []).map(Number);
      const shape = (path) => String(path).replace(/\d+/g, "#");
      let here = null;
      try {
        here = new URL(url);
      } catch (e) {
        here = null;
      }
      const hrefs = new Set(candidates.filter((c) => c.kind === "link").map((c) => c.href));
      let near = 0;
      for (const a of here ? doc.querySelectorAll("a[href]") : []) {
        if (near >= 6 || hidden(a)) continue;
        let there = null;
        try {
          there = new URL(a.getAttribute("href"), url);
        } catch (e) {
          continue;
        }
        if (there.hostname !== here.hostname || shape(there.pathname) !== shape(here.pathname) || hrefs.has(pathOf(there.href))) continue;
        const mine = numbers(here.pathname);
        const theirs = numbers(there.pathname);
        const differing = mine.map((n, i) => i).filter((i) => mine[i] !== theirs[i]);
        if (differing.length !== 1) continue; // (the same page, or another book)
        hrefs.add(pathOf(there.href));
        near++;
        const icon = [...a.querySelectorAll("i, svg, span")].map((e) => (typeof e.className === "string" ? e.className : (e.className && e.className.baseVal) || "")).join(" ").match(/[\w-]*(?:arrow|angle|chevron|caret|left|right|prev|next|back|forward)[\w-]*/i);
        add({ kind: "link", tag: "a", text: clean(a.textContent).slice(0, 40) || undefined, href: pathOf(there.href), delta: theirs[differing[0]] - mine[differing[0]], icon: icon ? icon[0] : undefined, classes: stableClasses(a).join(" ") || undefined }, selectorFor(a, doc));
      }
    }

    // chapter lists: the deepest containers that hold many links (a container whose child holds most of them is left to the child)
    const counts = new Map();
    for (const a of body.querySelectorAll("a[href]")) {
      const t = clean(a.textContent);
      if (!t || t.length > 120 || hidden(a)) continue;
      let depth = 0;
      for (let n = a.parentElement; n && n !== body && n !== doc.documentElement && depth < 8; n = n.parentElement, depth++) counts.set(n, (counts.get(n) || 0) + 1);
    }
    const lists = [];
    for (const [el, n] of counts) {
      if (n < 8 || el.closest(SKIP)) continue;
      if ([...el.children].some((c) => (counts.get(c) || 0) >= n * 0.6)) continue;
      lists.push([el, n]);
    }
    lists.sort((x, y) => y[1] - x[1]);
    for (const [el] of lists.slice(0, 5)) {
      const base = selectorFor(el, doc);
      if (!base) continue;
      const sel = base + " a";
      let found = [];
      try {
        found = [...doc.querySelectorAll(sel)].filter((a) => clean(a.textContent));
      } catch (e) {
        continue;
      }
      if (found.length < 8) continue;
      const text = (a) => clean(a.textContent).slice(0, 60);
      const ends = [...found.slice(0, 2), ...found.slice(-2)].map((a) => clean(a.textContent));
      add({ kind: "list", tag: el.tagName.toLowerCase(), count: found.length, partial: ends.some((t) => MORE.test(t)) || undefined, first: found.slice(0, 3).map(text), last: found.slice(-2).map(text), hrefs: [pathOf(found[0].getAttribute("href")), pathOf(found[found.length - 1].getAttribute("href"))] }, sel);
    }

    // pagination bars: links whose addresses are one address with one number changed (?page=2 ... ?page=76); the deepest container that holds them
    if (url && Rules) {
      const bars = [];
      for (const el of body.querySelectorAll("ul, ol, nav, div, p, span, td")) {
        if (hidden(el)) continue;
        const anchors = [...el.querySelectorAll("a[href]")].filter((a) => !hidden(a));
        if (anchors.length < 2 || anchors.length > 40) continue;
        const found = Rules.pagerOf(anchors.map((a) => a.getAttribute("href")), url);
        if (found) bars.push({ el, anchors, found });
      }
      const deepest = bars.filter((b) => !bars.some((o) => o !== b && b.el.contains(o.el) && o.found.max === b.found.max));
      for (const b of deepest.slice(0, 3)) {
        const base = selectorFor(b.el, doc);
        if (!base) continue;
        let again = null;
        try {
          again = Rules.pagerOf([...doc.querySelectorAll(base + " a")].map((a) => a.getAttribute("href")), url);
        } catch (e) {
          again = null;
        }
        if (!again || again.max !== b.found.max) continue;
        add({ kind: "pager", tag: b.el.tagName.toLowerCase(), pages: b.found.max, texts: b.anchors.slice(0, 8).map((a) => clean(a.textContent).slice(0, 12)), hrefs: [pathOf(b.anchors[0].getAttribute("href")), pathOf(b.anchors[b.anchors.length - 1].getAttribute("href"))] }, base + " a");
      }
    }

    // pictures: <img> (its lazy-load address first), and the page's own idea of its picture (og:image)
    const meta = doc.querySelector('meta[property="og:image"]');
    if (meta && /^(https?:)?\/\//.test(meta.getAttribute("content") || "")) add({ kind: "meta", tag: "meta", src: meta.getAttribute("content").slice(0, 200) }, 'meta[property="og:image"]');
    let images = 0;
    for (const img of body.querySelectorAll("img")) {
      if (images >= 12 || img.closest("nav, footer, form") || hidden(img) || repeated(img, body)) continue;
      const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      if (!src || /^data:|\.svg(\?|$)/i.test(src)) continue;
      const w = img.naturalWidth || Number(img.getAttribute("width")) || 0;
      const h = img.naturalHeight || Number(img.getAttribute("height")) || 0;
      if (w && h && (w < 60 || h < 80)) continue; // an icon, not a cover
      images++;
      add({ kind: "img", tag: "img", src: src.slice(0, 200), w: w || undefined, h: h || undefined, alt: clean(img.getAttribute("alt")).slice(0, 80) || undefined }, selectorFor(img, doc));
    }

    // groups of short links: genres, categories, tags
    const groups = new Set();
    for (const parent of body.querySelectorAll("*")) {
      if (candidates.length >= MAX_CANDIDATES || parent.closest(SKIP) || hidden(parent)) continue;
      const kids = [...parent.children];
      const direct = kids.filter((c) => c.tagName === "A" && clean(c.textContent).length >= 2 && clean(c.textContent).length <= 30);
      const viaItems = /^(UL|OL)$/.test(parent.tagName) ? kids.filter((li) => li.tagName === "LI" && li.children.length === 1 && li.children[0].tagName === "A" && clean(li.textContent).length >= 2 && clean(li.textContent).length <= 30) : [];
      const links = direct.length >= 2 ? direct : viaItems.length >= 2 ? viaItems.map((li) => li.children[0]) : [];
      if (links.length < 2 || links.length > 15) continue;
      const base = selectorFor(parent, doc);
      if (!base) continue;
      const sel = base + (direct.length >= 2 ? " > a" : " > li > a");
      let found = [];
      try {
        found = [...doc.querySelectorAll(sel)];
      } catch (e) {
        continue;
      }
      const key = found.map((a) => clean(a.textContent)).join("|");
      if (found.length < 2 || groups.has(key)) continue;
      groups.add(key);
      add({ kind: "group", tag: parent.tagName.toLowerCase(), texts: found.slice(0, 8).map((a) => clean(a.textContent)) }, sel);
    }

    // groups of labels that are not links (genre badges in a list): the list's items, each short
    for (const parent of body.querySelectorAll("ul, ol")) {
      if (candidates.length >= MAX_CANDIDATES || parent.closest(SKIP) || hidden(parent)) continue;
      const items = [...parent.children].filter((li) => li.tagName === "LI" && clean(li.textContent).length >= 2 && clean(li.textContent).length <= 30 && !li.querySelector("a[href]"));
      if (items.length < 2 || items.length > 15 || items.length !== parent.children.length) continue;
      const base = selectorFor(parent, doc);
      if (!base) continue;
      const sel = base + " > li";
      let found = [];
      try {
        found = [...doc.querySelectorAll(sel)];
      } catch (e) {
        continue;
      }
      const key = found.map((li) => clean(li.textContent)).join("|");
      if (found.length < 2 || groups.has(key)) continue;
      groups.add(key);
      add({ kind: "group", tag: parent.tagName.toLowerCase(), texts: found.slice(0, 8).map((li) => clean(li.textContent)) }, sel);
    }

    // text: an element that is a field, not a wrapper (a wrapper of one child is left to the child) and not a whole section of the page
    const heavy = new Map();
    const listed = new Set(); // (the links of the chapter-list candidates above)
    for (const [el] of lists.slice(0, 5)) for (const a of el.querySelectorAll("a[href]")) listed.add(a);
    for (const el of body.querySelectorAll("*")) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (el.closest(SKIP) || hidden(el) || (/^(IMG|BR|HR|SCRIPT|STYLE)$/.test(el.tagName))) continue;
      const text = clean(el.textContent);
      if (text.length < 2 || text.length > 1500 || seen.has(text)) continue;
      if (repeated(el, body)) continue;
      let menu = false;
      for (let n = el; n && n !== body && !menu; n = n.parentElement) menu = linkHeavy(n, heavy, listed);
      if (menu) continue;
      const kids = [...el.children].filter((c) => clean(c.textContent));
      if (kids.length > 8 || (kids.length === 1 && clean(kids[0].textContent) === text)) continue;
      seen.add(text);
      const c = { kind: "text", tag: el.tagName.toLowerCase(), text: text.slice(0, SNIPPET), longer: text.length > SNIPPET ? text.length : undefined };
      if (el.tagName === "A") c.href = pathOf(el.getAttribute("href"));
      add(c, selectorFor(el, doc));
    }
    return { candidates, selectors };
  }

  // What each part may be: a title, an author or a synopsis is text; a cover is a picture; genres are a group of links (or one element's text); the chapter
  // list is a list of links; next and previous are links.
  const KINDS = { title: ["text"], author: ["text"], description: ["text"], cover: ["img", "meta"], genre: ["group", "text"], chapterList: ["list"], pager: ["pager"], next: ["link"], prev: ["link"] };

  // Gemini's { title: "c3", ... } -> { found: { title: selector, ... }, skipped: { field: why } }: only an id that is a candidate of a kind the part can be.
  function interpret(picks, candidates, selectors) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const found = {};
    const skipped = {};
    for (const field of Object.keys(KINDS)) {
      const id = picks && picks[field];
      if (!id) { skipped[field] = "not found on the page"; continue; }
      const c = byId.get(id);
      if (!c || !selectors[id]) skipped[field] = "no such element";
      else if (!KINDS[field].includes(c.kind)) skipped[field] = "not the kind of element a " + field + " is";
      else if (field === "description" && (c.longer || (c.text || "").length) < 20) skipped[field] = "too short to be a synopsis";
      else if (field === "chapterList" && !(c.count >= 5)) skipped[field] = "too few links to be a chapter list";
      else if (field === "chapterList" && c.partial) skipped[field] = "only the latest chapters are listed here (the whole list is on another page: open it and run this there)";
      else found[field] = selectors[id];
    }
    return { found, skipped };
  }

  // Which way a list runs, from the chapter numbers in its entries (the first number in the text, else in the address): "asc" (the first chapter first),
  // "desc" (the newest first) or null when the numbers do not say. [{ text, href }] in the list's order.
  function orderOf(entries) {
    const first = (e) => {
      const m = /\d+/.exec(String(e.text || "")) || /\d+(?!.*\d)/.exec(String(e.href || ""));
      return m ? Number(m[0]) : null;
    };
    const nums = entries.map(first).filter((n) => n !== null);
    if (nums.length < 4) return null;
    const k = Math.min(3, Math.floor(nums.length / 2)); // the two ends never overlap
    const head = nums.slice(0, k);
    const tail = nums.slice(-k);
    if (Math.max(...head) < Math.min(...tail)) return "asc";
    if (Math.min(...head) > Math.max(...tail)) return "desc";
    return null;
  }

  // The parts of a chapter link that are not its title (the date, in a small element or a time): selectors for them, or "" when there are none. Looked for in
  // the first few entries: a child element with a short text that looks like a date or an age ("Aug 7, 2025", "3 days ago") and is not all of the link's text.
  const DATEY = /\b\d{4}\b|\bago\b|\d+\s*(?:day|hour|minute|min|week|month|year)s?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|天前|小时前|分钟前|前$/i;
  function titleDropFor(entries) {
    const parts = new Set();
    for (const a of entries.slice(0, 5)) {
      const whole = clean(a.textContent);
      for (const e of a.querySelectorAll("*")) {
        const t = clean(e.textContent);
        if (!t || t.length > 30 || t === whole || !DATEY.test(t)) continue;
        const name = e.tagName.toLowerCase() + stableClasses(e).map((c) => "." + escapeCss(c)).join("");
        if (/^(i|svg|span|div|b|strong|em)$/.test(name)) continue; // (a bare tag could take the title with it)
        parts.add(name);
      }
    }
    return parts.size >= 1 && parts.size <= 3 ? [...parts].join(", ") : "";
  }

  // What was found, as the parts of a rule: { book: { title, ... }, toc: { list, reverse? }, nav: { next, prev } } (a part with nothing found is left out).
  // `order` is what Gemini said of the list: "asc" (oldest first), "desc" (newest first), or null.
  // extras: { listUrl: { match, to } } when the list page can be reached from a chapter's address.
  function asRuleParts(found, order, extras) {
    const parts = {};
    const book = {};
    for (const f of ["title", "author", "description", "cover", "genre"]) if (found[f]) book[f] = found[f];
    if (Object.keys(book).length) parts.book = book;
    if (found.chapterList) {
      parts.toc = { list: found.chapterList, ...(order === "desc" ? { reverse: true } : order === "asc" ? { reverse: false } : {}), pages: found.pager ? { kind: "numbered", selector: found.pager } : null, titleDrop: (extras && extras.titleDrop) || null };
      if (extras && extras.listUrl) parts.toc.listUrl = extras.listUrl;
    }
    const nav = {};
    if (found.next) nav.next = found.next;
    if (found.prev) nav.prev = found.prev;
    if (Object.keys(nav).length) parts.nav = nav;
    // read from the site's data (a page a script fills in): the list, and the chapter's text
    if (extras && extras.dataList) parts.toc = { json: extras.dataList.json, listUrl: extras.dataList.listUrl, reverse: !!extras.dataList.reverse };
    if (extras && extras.dataText) parts.json = extras.dataText;
    // where a chapter's text is (a site that sends its pages whole)
    if (extras && extras.textSelector) parts.selector = extras.textSelector;
    return parts;
  }

  // ---------- pages a script fills in ----------
  // Some sites send an empty frame and fill it in with a script, from their own data (JSON from /api/...): the list and the text the person sees are not in the
  // page the extension fetches, so a selector found here would find nothing there. The data the page loaded is looked through for what the page shows, and the
  // rule is made to read that data. As with the selectors, nothing is made up: each part is found in the data, matched with the page, and tried before it is kept.
  const norm = (t) => clean(t).toLowerCase();
  const KEY = /^[\w$@-]+$/; // (a field a rule can name)
  const decode = (t) => {
    try {
      return decodeURIComponent(t);
    } catch (e) {
      return t;
    }
  };
  // An address's query, [[name, value]] in order. (Not [...u.searchParams]: in a Firefox content script the page's objects come wrapped, and that hides their
  // iterator: "is not iterable". forEach goes through.)
  const paramsOf = (u) => {
    const out = [];
    u.searchParams.forEach((v, k) => out.push([k, v]));
    return out;
  };

  // The arrays of objects in a piece of data: [{ path, items, parent, parentPath }] (path as a rule names it: "data.chapters", "" for the data itself; parent:
  // the object that holds the array).
  function arraysIn(data, path = "", parent = null, parentPath = "", depth = 0, out = []) {
    if (Array.isArray(data)) {
      const objects = data.filter((x) => x && typeof x === "object" && !Array.isArray(x)).length;
      if (data.length >= 2 && objects >= data.length * 0.9) out.push({ path, items: data, parent, parentPath });
      return out;
    }
    if (data && typeof data === "object" && depth < 5) {
      for (const [k, v] of Object.entries(data)) if (v && typeof v === "object" && KEY.test(k)) arraysIn(v, path ? path + "." + k : k, data, path, depth + 1, out);
    }
    return out;
  }

  // An object's fields that hold a string or a number, one level of objects down too: [[path, text]].
  function fieldsOf(item) {
    const out = [];
    for (const [k, v] of Object.entries(item && typeof item === "object" ? item : {})) {
      if (!KEY.test(k)) continue;
      if (typeof v === "string" || typeof v === "number") out.push([k, String(v)]);
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (KEY.test(k2) && (typeof v2 === "string" || typeof v2 === "number")) out.push([k + "." + k2, String(v2)]);
      }
    }
    return out;
  }

  // The numbers beside a list in its data (and in an object beside it, like meta.total): how many chapters there are, or how many parts. { count, pages } (paths).
  function totalsNear(parent, parentPath, items) {
    const found = [];
    const at = (p) => (parentPath ? parentPath + "." + p : p);
    for (const [k, v] of Object.entries(parent && typeof parent === "object" ? parent : {})) {
      if (!KEY.test(k)) continue;
      if (typeof v === "number") found.push([at(k), k, v]);
      else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (KEY.test(k2) && typeof v2 === "number") found.push([at(k + "." + k2), k2, v2]);
    }
    const counts = found.filter(([, k, v]) => /total|count/i.test(k) && !/page/i.test(k) && v >= items.length);
    counts.sort((x, y) => Number(/chapter/i.test(y[1])) - Number(/chapter/i.test(x[1])) || Number(/^(total|count|total_?count|total_?items)$/i.test(y[1])) - Number(/^(total|count|total_?count|total_?items)$/i.test(x[1])));
    const pages = found.find(([, k, v]) => /page/i.test(k) && /total|count|last|max|pages/i.test(k) && v >= 1);
    return { count: counts.length ? counts[0][0] : "", countValue: counts.length ? counts[0][2] : 0, pages: pages ? pages[0] : "", pagesValue: pages ? pages[2] : 0 };
  }

  const OFFSET = /^(offset|skip|start|from)$/i;
  const PAGE = /^(page|p|pg|page_?(no|num|number|index)|pageindex|pagenum)$/i;
  const LIMIT = /^(limit|size|per_?page|page_?size|count|take|max)$/i;
  const sameAddress = (a, b) => String(a).split("#")[0].replace(/\/+$/, "") === String(b).split("#")[0].replace(/\/+$/, "");

  // The chapter list in a piece of data the page loaded, matched with the list the page shows (entries: [{ url, text }], absolute addresses).
  // { json, listUrl, reverse, shown, count, partial, pairs } or null. json is the rule's toc.json; shown: the chapters in this part of the data; count: how many
  // the data says there are; partial: the data holds only some of them and does not say how to ask for the rest.
  function listFromData(data, dataUrl, entries) {
    if (!Rules || !entries || !entries.length) return null;
    const byText = new Map(entries.map((e) => [norm(e.text), e]));
    const texts = entries.map((e) => [norm(e.text), e]);
    // the entry the page shows for a title: the one that is the title, or that starts with it (a date may follow)
    const entryFor = (t) => byText.get(t) || (texts.find(([x]) => x.startsWith(t) && !/[\p{L}\p{N}]/u.test(x.charAt(t.length))) || [])[1];
    let best = null;
    for (const { path, items, parent, parentPath } of arraysIn(data)) {
      // each chapter in the data paired with the entry the page shows for it, by its title
      let pairs = [];
      let titleField = "";
      for (const [f] of fieldsOf(items[0])) {
        const got = [];
        for (const item of items) {
          const t = norm(Rules.jsonAt(item, f));
          if (t.length < 2 || /^[\d.]+$/.test(t)) continue; // (a bare number is not a title)
          const e = entryFor(t);
          if (e) got.push({ item, entry: e });
        }
        if (got.length > pairs.length) {
          pairs = got;
          titleField = f;
        }
      }
      if (pairs.length < Math.min(3, items.length)) continue;
      // each part of the entries' addresses that is a field of their chapter (the same field for nearly all of them) becomes {field}
      let first = null;
      try {
        first = new URL(pairs[0].entry.url);
      } catch (e) {
        continue;
      }
      const urls = pairs.map((p) => new URL(p.entry.url));
      const fieldFor = (valueOf) => {
        const v0 = valueOf(first);
        for (const [f, v] of fieldsOf(pairs[0].item)) {
          if (!v || v !== v0) continue;
          const same = pairs.filter((p, i) => valueOf(urls[i]) === String(Rules.jsonAt(p.item, f))).length;
          if (same >= pairs.length * 0.8) return f;
        }
        return "";
      };
      const segs = first.pathname.split("/").map((s, i) => {
        const f = s ? fieldFor((u) => decode(u.pathname.split("/")[i] || "")) : "";
        return f ? "{" + f + "}" : s;
      });
      const query = paramsOf(first).map(([k]) => {
        const f = fieldFor((u) => u.searchParams.get(k) || "");
        return encodeURIComponent(k) + "=" + (f ? "{" + f + "}" : encodeURIComponent(first.searchParams.get(k)));
      });
      if (!segs.some((s) => /^\{.+\}$/.test(s)) && !query.some((q) => /=\{.+\}$/.test(q))) continue; // (no part of the addresses comes from the data)
      // the data's first part (offset 0, page 1), and how to get to it from a chapter's address (or the book's): the part of it they hold too, the book's slug or id
      let dataAt = null;
      try {
        dataAt = new URL(dataUrl);
      } catch (e) {
        continue;
      }
      const keys = paramsOf(dataAt).map(([k]) => k);
      const page = keys.find((k) => OFFSET.test(k)) || keys.find((k) => PAGE.test(k)) || "";
      if (page && OFFSET.test(page)) dataAt.searchParams.set(page, "0");
      else if (page && Number(dataAt.searchParams.get(page)) > 1) dataAt.searchParams.set(page, "1");
      const listUrl = Rules.listUrlRule(dataAt.href, first.href, true);
      if (!listUrl) continue;
      const book = new RegExp(listUrl.match).exec(first.href);
      const bookPart = book ? book[1] : "";
      // (the book's part of a chapter's address, when the data does not hold it, is the same part of the book's address: $1)
      const link = first.origin + segs.map((s) => (bookPart && s === bookPart ? "$1" : s)).join("/") + (query.length ? "?" + query.join("&") : "");
      const groups = Rules.groupsOf(listUrl.to, dataAt.href);
      const fits = pairs.filter((p) => sameAddress(Rules.fillLink(link, groups, p.item, dataAt.href), p.entry.url)).length;
      if (fits < pairs.length * 0.8) continue;
      // how many there are, and how to ask for the rest
      const totals = totalsNear(parent, parentPath, items);
      const json = { ...(path ? { items: path } : {}), title: titleField, link };
      if (page && (totals.count || totals.pages)) {
        json.page = page;
        if (totals.count) json.count = totals.count;
        else json.pages = totals.pages;
      }
      const limit = keys.find((k) => LIMIT.test(k) && k !== page);
      const partial = !json.page && ((totals.countValue > items.length) || totals.pagesValue > 1 || (!!limit && Number(dataAt.searchParams.get(limit)) === items.length));
      const order = orderOf(items.map((item) => ({ text: String(Rules.jsonAt(item, titleField) || ""), href: Rules.fillLink(link, groups, item, dataAt.href) })));
      const got = { json, listUrl, reverse: order === "desc", shown: items.length, count: totals.countValue || 0, partial, pairs: pairs.length };
      if (!best || (best.partial && !got.partial) || (best.partial === got.partial && got.pairs > best.pairs)) best = got;
    }
    return best;
  }

  // The chapter's text in a piece of data the page loaded: the longest text in it whose start, middle and end are all in what the page shows. { field, length } or null.
  function textInData(data, shownText) {
    const shown = norm(shownText);
    let best = null;
    const walk = (v, path, depth) => {
      if (typeof v === "string") {
        if (v.length < 300) return;
        const plain = norm(v.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
        if (plain.length < 300) return;
        const bits = [0.15, 0.5, 0.85].map((at) => plain.slice(Math.floor(plain.length * at), Math.floor(plain.length * at) + 30).trim());
        if (bits.every((b) => shown.includes(b)) && (!best || plain.length > best.length)) best = { field: path, length: plain.length, bits };
      } else if (v && typeof v === "object" && !Array.isArray(v) && depth < 6) {
        for (const [k, x] of Object.entries(v)) if (KEY.test(k)) walk(x, path ? path + "." + k : k, depth + 1);
      }
    };
    walk(data, "", 0);
    return best;
  }

  // How to get a chapter's data address from the chapter's own: the parts of the chapter's address that are a slug or an id (a hyphen or a digit in them) and are
  // in the data's address too become $1, $2... { match, to } or null when the data's address is not made from the chapter's (it must come back out of it).
  function dataUrlRule(pageUrl, dataUrl) {
    let page = null;
    let data = null;
    try {
      page = new URL(pageUrl);
      data = new URL(dataUrl);
    } catch (e) {
      return null;
    }
    const bare = (h) => h.replace(/^www\./, "");
    if (page.protocol !== "https:" || !Rules.sameSite(data.href, bare(page.hostname))) return null;
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const dataSegs = data.pathname.split("/");
    const query = paramsOf(data);
    const used = new Set();
    const usedQ = new Set();
    const parts = [];
    let n = 0;
    for (const s of page.pathname.split("/").filter(Boolean)) {
      const value = decode(s);
      const i = n < 9 && /\d|-/.test(s) ? dataSegs.findIndex((d, k) => !used.has(k) && decode(d) === value) : -1;
      const q = n < 9 && /\d|-/.test(s) && i < 0 ? query.findIndex(([, v], k) => !usedQ.has(k) && v === value) : -1;
      if (i < 0 && q < 0) {
        parts.push(esc(s));
        continue;
      }
      n++;
      parts.push("([^/?#]+)");
      if (i >= 0) {
        dataSegs[i] = "$" + n;
        used.add(i);
      } else {
        query[q] = [query[q][0], "$" + n];
        usedQ.add(q);
      }
    }
    if (!n) return null;
    const match = "^https://(?:www\\.)?" + esc(bare(page.hostname)) + "/" + parts.join("/") + "(?:[/?#]|$)";
    const to = data.origin + dataSegs.join("/") + (query.length ? "?" + query.map(([k, v]) => encodeURIComponent(k) + "=" + (/^\$\d$/.test(v) ? v : encodeURIComponent(v))).join("&") : "");
    const m = new RegExp(match).exec(page.href);
    const back = m ? Rules.expand(to, m, page.href) : "";
    return back && sameAddress(new URL(back).href, data.href) ? { match, to } : null;
  }

  // The next chapter's address from a chapter's data, given the address the page links to as the next one: the one part of it that differs from this chapter's
  // address is a field of the data (next_number: 6), the parts the data's address was made from are $1, $2... "" when no field of the data holds it.
  function nextFromData(data, dataUrl, rule, pageUrl, nextUrl) {
    let page = null;
    let next = null;
    try {
      page = new URL(pageUrl);
      next = new URL(nextUrl);
    } catch (e) {
      return "";
    }
    const mine = page.pathname.split("/");
    const theirs = next.pathname.split("/");
    if (mine.length !== theirs.length || page.host !== next.host) return "";
    const differ = mine.map((s, i) => i).filter((i) => mine[i] !== theirs[i]);
    if (differ.length !== 1) return "";
    const wanted = decode(theirs[differ[0]]);
    const holding = fieldsOf(data).filter(([, v]) => v === wanted).map(([f]) => f);
    const field = holding.find((f) => /next/i.test(f)) || holding[0]; // (a field named next wins over one that only happens to hold the same number)
    if (!field) return "";
    const groups = Rules.groupsOf(rule.to, dataUrl);
    const segs = mine.map((s, i) => {
      if (i === differ[0]) return "{" + field + "}";
      const g = groups.findIndex((v, k) => k > 0 && v === decode(s));
      return g > 0 ? "$" + g : s;
    });
    const template = page.origin + segs.join("/");
    return sameAddress(Rules.fillLink(template, groups, data, dataUrl), next.href) ? template : "";
  }

  // ---------- where a chapter's text is ----------
  // A site that sends its pages whole: the element that holds a chapter's text, on a chapter's page as the site sends it. The deepest box that still holds most
  // (80%) of the page's paragraphs; or, for text set straight in a box with <br> between the lines (many Chinese sites), the box with the most text of its own.
  // null when the page has no chapter's worth of text (500 characters).
  function textBoxOf(doc) {
    const body = doc && doc.body;
    if (!body) return null;
    const pText = (el) => {
      let n = 0;
      for (const p of el.querySelectorAll("p")) {
        if (p.closest(SKIP) || hidden(p)) continue;
        const len = clean(p.textContent).length;
        if (len >= 15) n += len;
      }
      return n;
    };
    let lined = null;
    let linedLen = 0;
    for (const el of body.querySelectorAll("div, td, article, section, pre")) {
      if (el.closest(SKIP) || hidden(el)) continue;
      let len = 0;
      for (const n of el.childNodes) if (n.nodeType === 3) len += clean(n.textContent).length;
      if (len > linedLen) {
        lined = el;
        linedLen = len;
      }
    }
    const total = pText(body);
    if (linedLen >= 500 && linedLen > total) return lined;
    if (total < 500) return null;
    let box = body;
    for (;;) {
      const next = [...box.children].find((c) => !c.closest(SKIP) && pText(c) >= total * 0.8);
      if (!next) break;
      box = next;
    }
    return box === body ? null : box;
  }

  // A selector for a chapter's text that finds it on two chapters' pages as the site sends them (docA, docB: documents of two chapters): made from the box
  // textBoxOf finds on the first (with its id first; without, when the id is the chapter's own and not on the other page), and kept only if it finds one
  // element with a chapter's worth of text (300 characters) on both. A page where the selector finds something is taken for a chapter by the book-recording
  // script (book-capture.js), so it must find nothing on the book's page (`bookPage`, when known); without that page to try it on, only a selector that names
  // the box (an id or a class) is kept, not a bare path. { selector, sizes: [characters on each] } or null.
  function textSelectorFor(docA, docB, bookPage) {
    const box = textBoxOf(docA);
    if (!box) return null;
    const textOn = (sel, doc) => {
      try {
        const found = doc.querySelectorAll(sel);
        return found.length === 1 ? clean(found[0].textContent).length : 0;
      } catch (e) {
        return 0;
      }
    };
    for (const sel of [selectorFor(box, docA), selectorFor(box, docA, true)]) {
      if (!sel || sel === "body") continue;
      if (bookPage ? !!bookPage.querySelector(sel) : !/[#.]/.test(sel)) continue;
      const sizes = [textOn(sel, docA), docB ? textOn(sel, docB) : 0];
      if (sizes[0] >= 300 && (!docB || sizes[1] >= 300)) return { selector: sel, sizes };
    }
    return null;
  }

  if (isNode) module.exports = { collect, selectorFor, interpret, asRuleParts, orderOf, titleDropFor, stableClasses, KINDS, MAX_CANDIDATES, listFromData, textInData, dataUrlRule, nextFromData, textBoxOf, textSelectorFor };
  if (typeof document === "undefined" || typeof location === "undefined") return; // loaded by a test, not injected into a page
  if (!/^https?:$/.test(location.protocol)) return;
  // A bar still on the page: a run in progress is left alone; one that has finished (its answer is only showing) is replaced by this run.
  const old = document.getElementById("gemini-detect-bar");
  if (old && old.dataset.running) return;
  if (old) old.remove();

  const ext = typeof browser !== "undefined" ? browser : chrome;
  const host = location.hostname.replace(/^www\./, "");
  const LABEL = { title: "title", author: "author", description: "synopsis", cover: "cover", genre: "genres", chapterList: "chapter list", pager: "chapter-list pages", next: "next-chapter link", prev: "previous-chapter link" };

  // The bar at the bottom of the page: what is going on, then what was found (text only: nothing from the page is put in as markup).
  const bar = document.createElement("div");
  bar.id = "gemini-detect-bar";
  bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#1c2026;color:#fff;font:12.5px 'Segoe UI',ui-sans-serif,system-ui,sans-serif;padding:10px 14px;display:flex;align-items:center;gap:12px;box-shadow:0 -4px 14px rgba(0,0,0,.3);";
  const note = document.createElement("span");
  note.style.cssText = "flex:1;line-height:1.5;";
  const action = document.createElement("button");
  action.style.cssText = "background:transparent;color:#9ec1ff;border:1px solid #4a5a73;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;";
  action.hidden = true;
  const close = document.createElement("button");
  close.textContent = "Close";
  close.style.cssText = action.style.cssText;
  close.onclick = () => bar.remove();
  bar.append(note, action, close);
  bar.dataset.running = "1"; // (until the run is over)
  document.body.appendChild(bar);
  let fade = 0;
  let good = false;
  const say = (text, color) => {
    good = color === "#7ed17e";
    note.textContent = text;
    note.style.color = color || "#fff";
  };
  // The answer goes away by itself (a failure sooner; a success later, as it carries Undo); pointing at it keeps it.
  const leaveSoon = (ms) => {
    clearTimeout(fade);
    fade = setTimeout(() => bar.remove(), ms);
    bar.onmouseenter = () => clearTimeout(fade);
    bar.onmouseleave = () => { fade = setTimeout(() => bar.remove(), ms); };
  };

  // Saving goes through user-rules.js (the page that injected this also injected it), then the book is recorded again from the page as it is.
  async function save(parts) {
    const before = (await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {};
    await ext.storage.local.set({ [UserRules.KEY]: UserRules.withDetected(before, host, parts) });
    await rerecord();
    return before;
  }
  async function rerecord() {
    const stamps = (await ext.storage.local.get("bookCapturedAt")).bookCapturedAt || {};
    for (const k of Object.keys(stamps)) if (k.startsWith(host + "/")) delete stamps[k];
    await ext.storage.local.set({ bookCapturedAt: stamps });
    ext.runtime.sendMessage({ type: "bookcapture:run" }).catch(() => {});
  }

  // Is this selector, as the extension will use it, really there on this page?
  function present(field, selector, doc = document, url = location.href) {
    try {
      const els = [...doc.querySelectorAll(selector)];
      if (field === "chapterList") return els.length >= 5 && els.every((e) => e.tagName === "A");
      if (field === "pager") return els.length >= 2 && !!Rules.pagerOf(els.map((e) => e.getAttribute("href")), url);
      if (field === "next" || field === "prev") return els.length > 0 && !!els[0].getAttribute("href");
      return els.length > 0 && els.some((e) => clean(e.textContent) || e.tagName === "IMG" || e.tagName === "META" || e.querySelector("img"));
    } catch (e) {
      return false;
    }
  }

  // The chapter-list rule as it would be saved, tried on this page the way "Refresh chapters" will use it: the links, the pages the bar gives, and whether the list
  // page can be reached from a chapter's address. { summary, pagesOk, listUrl }. What does not hold up is left out (a bar that gives no pages, an address rule that does
  // not lead back here).
  function tryListRule(found, order, doc = document, url = location.href) {
    const entries = [...doc.querySelectorAll(found.chapterList)];
    const bits = [entries.length + " chapter links here"];
    // the list's own page: this address without the page number (the bar says which part of it is the number)
    let pageUrl = url.split("#")[0];
    let pagesOk = false;
    if (found.pager) {
      const bar = Rules.pagerOf([...doc.querySelectorAll(found.pager)].map((a) => a.getAttribute("href")), url);
      if (bar) {
        pagesOk = true;
        bits.push(bar.urls.length + " more pages (" + bar.urls[0].replace(/^https?:\/\/[^/]+/, "") + " ... " + bar.urls[bar.urls.length - 1].replace(/^https?:\/\/[^/]+/, "") + ")");
        if (bar.param) {
          const u = new URL(pageUrl);
          u.searchParams.delete(bar.param);
          pageUrl = u.href;
        }
      }
    }
    if (order) bits.push(order === "desc" ? "newest first" : "oldest first");
    let titleDrop = titleDropFor(entries);
    if (titleDrop) {
      const rule = Rules.toRule({ host, selector: "p", toc: { list: found.chapterList, titleDrop } }, null);
      const titles = rule.toc.list(doc, url).slice(0, 5).map((c) => c.title);
      if (titles.length && titles.every((t) => t && t.length >= 2)) bits.push('titles without "' + titleDrop + '" (' + titles[0] + ")");
      else titleDrop = "";
    }
    let listUrl = null;
    const first = entries[0] && entries[0].getAttribute("href");
    const wanted = Rules.listUrlRule(pageUrl, first);
    if (wanted) {
      const rule = Rules.toRule({ host, selector: "p", toc: { list: found.chapterList, listUrl: wanted } }, null);
      const back = rule.toc.url ? rule.toc.url(new URL(first, url).href) : null;
      if (back && back.split(/[?#]/)[0] === pageUrl.split(/[?#]/)[0]) {
        listUrl = wanted;
        bits.push("the list page is found from a chapter's address");
      }
    }
    return { summary: bits.join(", "), pagesOk, listUrl, titleDrop };
  }

  // A book's page that has no list of its own but a link to the page that has (a "Chapters" or "Table of contents" link under the book's address, or a link
  // that says all chapters): that page's address, else null.
  const LIST_LINK = /chapter\s*list|table of contents|all chapters|目录|目錄|章节列表|章節列表|^\s*(?:chapters?|contents|toc|catalog(?:ue)?)\s*(?:\(?\d+\)?)?\s*$/i;
  function listPageLink() {
    const here = location.pathname.replace(/\/+$/, "");
    let best = null;
    for (const a of document.querySelectorAll("a[href]")) {
      let u = null;
      try {
        u = new URL(a.getAttribute("href"), location.href);
      } catch (e) {
        continue;
      }
      const text = clean(a.textContent);
      if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host || u.pathname.replace(/\/+$/, "") === here || u.href.split("#")[0] === location.href.split("#")[0]) continue;
      const under = u.pathname.startsWith(here + "/");
      if (!(LIST_LINK.test(text) || MORE.test(text) || (under && /\/(?:chapters?|toc|contents|catalog(?:ue)?)\/?$/i.test(u.pathname)))) continue;
      if (!best || (under && !best.under)) best = { href: u.href, under };
    }
    return best && best.href;
  }

  // The list page of a book whose own page has none: fetched, read the way a page is (the same candidates, the same question to Gemini), only the list's parts are
  // taken from it. { found, order, tried, url } or null.
  async function listFromListPage(url) {
    const res = await fetch(url, { credentials: "include" }).catch(() => null);
    if (!res || !res.ok) return null;
    const there = new DOMParser().parseFromString(await res.text(), "text/html");
    const { candidates, selectors } = collect(there, url);
    if (!candidates.some((c) => c.kind === "list")) return null;
    const reply = await ext.runtime.sendMessage({ type: "book:detect", candidates, page: { host, title: there.title } }).catch((e) => ({ error: e.message }));
    if (!reply || reply.error) return null;
    const { found } = interpret(reply.picks, candidates, selectors);
    if (!found.chapterList || !present("chapterList", found.chapterList, there, url)) return null;
    if (found.pager && !present("pager", found.pager, there, url)) delete found.pager;
    const order = orderOf([...there.querySelectorAll(found.chapterList)].map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href") }))) || reply.picks.listOrder;
    const tried = tryListRule(found, order, there, url);
    if (!tried.pagesOk) delete found.pager;
    return { found: { chapterList: found.chapterList, ...(found.pager ? { pager: found.pager } : {}) }, order, tried, url };
  }

  // This page as the site sends it, before any script has run (what the extension will fetch): a document without its scripts, or null when it cannot be had.
  async function pageAsSent() {
    const res = await fetch(location.href, { credentials: "include" }).catch(() => null);
    if (!res || !res.ok) return null;
    const html = (await res.text().catch(() => "")).replace(/<script[\s\S]*?<\/script>/gi, "");
    return new DOMParser().parseFromString(html, "text/html");
  }

  // The data (JSON) this page loaded from its own site, fetched again: [{ url, data }], the latest first (what was opened last, like the whole list). At most 20.
  let loadedCache = null;
  async function loadedData() {
    if (loadedCache) return loadedCache;
    const out = [];
    const seen = new Set();
    const asked = performance.getEntriesByType("resource").filter((e) => e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest").reverse();
    for (const e of asked) {
      const url = String(e.name).split("#")[0];
      if (out.length >= 20 || seen.has(url) || !Rules.sameSite(url, host)) continue;
      seen.add(url);
      const res = await fetch(url, { credentials: "include", ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {}) }).catch(() => null);
      const text = res && res.ok ? await res.text().catch(() => "") : "";
      if (!/^\s*[[{]/.test(text)) continue;
      try {
        out.push({ url: res.url || url, data: JSON.parse(text) });
      } catch (err) {
        // not JSON after all
      }
    }
    loadedCache = out;
    return out;
  }

  // The chapter list in the data this page loaded, for the list the page shows (its links: `selector`), tried the way "Refresh chapters" will run it.
  // { dataList, summary } when it can be read, { partial } when the data holds only part of it, or null.
  async function listFromLoaded(selector) {
    const entries = [...document.querySelectorAll(selector)].map((a) => ({ url: a.href, text: clean(a.textContent) })).filter((e) => /^https?:/.test(e.url));
    let best = null;
    for (const { url, data } of await loadedData()) {
      const got = listFromData(data, url, entries);
      if (got && (!best || (best.partial && !got.partial) || (best.partial === got.partial && got.pairs > best.pairs))) best = got;
    }
    if (!best) return null;
    if (best.partial) return { partial: best };
    const spec = { host, toc: { json: best.json, listUrl: best.listUrl, ...(best.reverse ? { reverse: true } : {}) } };
    const v = Rules.validate(spec, null);
    if (!v.ok) return null;
    const rule = Rules.toRule(v.spec, null);
    const fromBook = rule.toc.url(location.href);
    const address = fromBook || rule.toc.url(entries[0].url);
    const res = address ? await fetch(address, { credentials: "include" }).catch(() => null) : null;
    if (!res || !res.ok) return null;
    const text = await res.text().catch(() => "");
    const chapters = rule.toc.list(null, res.url || address, text);
    const more = rule.toc.pages(null, res.url || address, text);
    if (chapters.length < Math.min(5, best.shown)) return null;
    const bits = [(best.count || chapters.length) + " chapters" + (more.length ? " in " + (more.length + 1) + " parts" : ""), best.reverse ? "newest first" : "oldest first"];
    if (fromBook) bits.push("found from the book's address");
    return { dataList: best, summary: bits.join(", ") };
  }

  // The chapter's text in the data this page loaded, when the page as the site sends it does not have it: { dataText, summary } or null. Tried on the chapter
  // next to this one (`neighbour`: its address, from the page's next or previous link) before it is kept: its data must hold its text in the same place.
  async function textFromLoaded(sent, next, prev) {
    const shown = document.body ? document.body.innerText : "";
    if (norm(sent.body ? sent.body.textContent : "").length >= norm(shown).length * 0.5) return null; // (the page as sent has its text: no script fills it in)
    let best = null;
    for (const { url, data } of await loadedData()) {
      const got = textInData(data, shown);
      if (got && (!best || got.length > best.length)) best = { ...got, url, data };
    }
    if (!best) return null;
    const sentText = norm(sent.body ? sent.body.textContent : "");
    if (best.bits.every((b) => sentText.includes(b))) return null; // the text is in the page as sent: no data needed
    const rule = dataUrlRule(location.href, best.url);
    if (!rule) return null;
    const dataText = { match: rule.match, to: rule.to, text: best.field };
    const nextLink = next ? nextFromData(best.data, best.url, rule, location.href, next) : "";
    if (nextLink) dataText.next = nextLink;
    const v = Rules.validate({ host, json: dataText }, null);
    if (!v.ok) return null;
    const engine = Rules.toRule(v.spec, null);
    const neighbour = next || prev;
    const there = neighbour ? engine.textUrl(neighbour) : null;
    const res = there ? await fetch(there, { credentials: "include" }).catch(() => null) : null;
    const read = res && res.ok ? await engine.fromHtml(await res.text().catch(() => ""), res.url || there) : null;
    if (!read || read.text.length < 200) return null;
    return { dataText: v.spec.json, summary: best.url.replace(/^https?:\/\/[^/]+/, "") + " (" + best.field + ")" + (nextLink ? ", with the next chapter's address" : "") };
  }

  // Where a chapter's text is, for a site that sends its pages whole (what the add-on downloads chapters with): on a chapter's page, from this page as sent
  // (`sent`) and the chapter next to it (`neighbour`); on a book's page, from the first two chapters of its list. { selector, summary } or null; nothing when
  // the site's saved rule already finds the text (a selector the person set is kept).
  async function chapterTextRule(sent, found, neighbour) {
    const fetchDoc = async (url) => {
      const res = await fetch(url, { credentials: "include" }).catch(() => null);
      if (!res || !res.ok) return null;
      return new DOMParser().parseFromString((await res.text().catch(() => "")).replace(/<script[\s\S]*?<\/script>/gi, ""), "text/html");
    };
    let docA = null;
    let docB = null;
    let where = "";
    if (found.next || found.prev) {
      docA = sent;
      docB = neighbour ? await fetchDoc(neighbour) : null;
      where = "this chapter and the " + (found.next ? "next" : "previous") + " one";
    } else if (found.chapterList) {
      const links = [...new Set([...document.querySelectorAll(found.chapterList)].map((a) => a.href).filter((u) => /^https?:/.test(u)))];
      if (links.length < 2) return null;
      docA = await fetchDoc(links[0]);
      docB = await fetchDoc(links[1]);
      where = "its first two chapters";
    }
    if (!docA || !docB) return null;
    const mine = ((((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {})[host] || {}).spec || {}).selector;
    if (mine) {
      try {
        const e = docA.querySelector(mine);
        if (e && clean(e.textContent).length >= 300) return null;
      } catch (err) {
        // a selector the browser cannot use: replaced
      }
    }
    // (on a book's page, the selector must find nothing here: the book-recording script takes a page where it finds something for a chapter)
    const got = textSelectorFor(docA, docB, found.next || found.prev ? null : document);
    return got ? { selector: got.selector, summary: got.selector + ", " + got.sizes[0] + " and " + got.sizes[1] + " characters on " + where } : null;
  }

  (async () => {
    say("Looking at the page…");
    const { candidates, selectors } = collect(document, location.href);
    if (!candidates.length) return say("Nothing on this page looks like a book's details or a chapter. Open the book's page or a chapter and try again.", "#ff9d8f");
    say("Asking Gemini which parts of this page are the book's details, its chapter list and the chapter links (" + candidates.length + " elements)…");
    const reply = await ext.runtime.sendMessage({ type: "book:detect", candidates, page: { host, title: document.title } }).catch((e) => ({ error: e.message }));
    if (!reply || reply.error) return say("Gemini could not tell: " + ((reply && reply.error) || "no answer") + ".", "#ff9d8f");
    const { found, skipped } = interpret(reply.picks, candidates, selectors);
    // each selector is checked on the page once more, as the extension will use it
    for (const field of Object.keys(found)) if (!present(field, found[field])) delete found[field];
    let fromListPage = null;
    if (!found.chapterList) {
      const there = listPageLink();
      if (there) {
        say("This page has no chapter list, only a link to the page that does. Reading " + there.replace(/^https?:\/\/[^/]+/, "") + "…");
        fromListPage = await listFromListPage(there).catch(() => null);
        if (fromListPage) Object.assign(found, fromListPage.found);
      }
    }
    // A page a script fills in: the list and the text found on it are not in the page the site sends (what the extension fetches), so the site's data is read instead.
    let fromData = null;
    let textData = null;
    let dataNote = "";
    const sent = (found.chapterList && !fromListPage) || found.next || found.prev ? await pageAsSent().catch(() => null) : null;
    if (sent && found.chapterList && !fromListPage && !present("chapterList", found.chapterList, sent)) {
      say("The chapter list is filled in by the page's script. Looking for it in the data the page loaded…");
      const got = await listFromLoaded(found.chapterList).catch(() => null);
      delete found.chapterList;
      delete found.pager;
      if (got && got.dataList) fromData = got;
      else if (got && got.partial) dataNote = " The chapter list was left out: the data this page loaded holds only " + got.partial.shown + (got.partial.count ? " of its " + got.partial.count : "") + " chapters. Show the whole list on the page, then run this again.";
      else dataNote = " The chapter list was left out: the page's script fills it in, and it was not found in the data the page loaded.";
    }
    const linkOf = (sel) => {
      try {
        const a = sel ? document.querySelector(sel) : null;
        return a && a.getAttribute("href") ? new URL(a.getAttribute("href"), location.href).href : null;
      } catch (e) {
        return null;
      }
    };
    if (sent && (found.next || found.prev)) textData = await textFromLoaded(sent, linkOf(found.next), linkOf(found.prev)).catch(() => null);
    // where a chapter's text is, for a site that sends its pages whole (one whose text comes from its data has it above)
    let textSel = null;
    if (!textData && !fromData && (found.next || found.prev || (found.chapterList && !fromListPage))) {
      say("Looking for where a chapter's text is…");
      textSel = await chapterTextRule(sent, found, linkOf(found.next) || linkOf(found.prev)).catch(() => null);
    }
    const names = Object.keys(found);
    if (!names.length && !fromData && !textData && !textSel) return say("Gemini found none of the details, the chapter list or the chapter links on this page." + dataNote, "#ff9d8f");
    // the list's order is read from its own numbers when they say; Gemini's guess is only for lists whose entries carry none
    let order = fromListPage ? fromListPage.order : reply.picks && reply.picks.listOrder;
    if (found.chapterList && !fromListPage) order = orderOf([...document.querySelectorAll(found.chapterList)].map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href") }))) || order;
    if (!found.chapterList) delete found.pager; // (a pagination bar is only the list's pages)
    const tried = fromListPage ? fromListPage.tried : found.chapterList ? tryListRule(found, order) : null;
    if (tried) {
      if (!tried.pagesOk) delete found.pager;
    }
    const before = await save(asRuleParts(found, order, { ...(tried ? { listUrl: tried.listUrl, titleDrop: tried.titleDrop } : {}), dataList: fromData && fromData.dataList, dataText: textData && textData.dataText, textSelector: textSel && textSel.selector }));
    const missing = Object.keys(KINDS).filter((f) => !found[f] && !((fromData || dataNote) && (f === "chapterList" || f === "pager"))).map((f) => LABEL[f]);
    const partial = !fromListPage && skipped.chapterList && /^only the latest/.test(skipped.chapterList) ? " The chapter list was left out: " + skipped.chapterList + "." : "";
    const saved = Object.keys(found).map((f) => LABEL[f]).concat(fromData ? ["chapter list (from the site's data)"] : [], textData ? ["chapter text (from the site's data)"] : [], textSel ? ["chapter text"] : []);
    say("Found and saved for " + host + ": " + saved.join(", ") + "." + (tried ? " Chapter list tried on " + (fromListPage ? "its own page" : "this page") + ": " + tried.summary + "." : "") + (fromData ? " Chapter list tried on the site's data: " + fromData.summary + "." : "") + (textData ? " Chapter text: " + textData.summary + "." : "") + (textSel ? " Chapter text: " + textSel.summary + "." : "") + dataNote + (missing.length ? " Not on this page: " + missing.join(", ") + ". (The details and the chapter list are on a book's page; the next and previous links are on a chapter's page: run it there too.)" : "") + partial + " The book is being recorded again.", "#7ed17e");
    action.textContent = "Undo";
    action.hidden = false;
    action.onclick = async () => {
      action.disabled = true;
      await ext.storage.local.set({ [UserRules.KEY]: before });
      await rerecord();
      action.hidden = true;
      say("Undone: the rule is as it was.");
    };
  })().catch((e) => say("Something went wrong: " + ((e && e.message) || e), "#ff9d8f")).then(() => {
    delete bar.dataset.running;
    leaveSoon(good ? 60000 : 15000);
  });
})();
