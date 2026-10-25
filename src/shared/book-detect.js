// "Detect with AI": finds the parts of a page the way the picker would, but by asking Gemini: on a book's page its title, author, synopsis, cover, genres and a
// complete CHAPTER LIST RULE (the links, the pagination bar that gives the other pages, which way the list runs, and how to reach the list page from a chapter's
// address: the same rule "Refresh chapters" runs, tried on the page before it is kept); on a chapter's page the links to the next and previous chapter. Injected into the tab from the popup, together with user-rules.js.
//
// The page is reduced to a short list of CANDIDATES (elements with a snippet of their text, pictures, groups of links, lists of chapter links, links that say
// next or previous), each with an id. Gemini only says which id is which; the selectors are made here, from the elements themselves, and each one is checked on
// the page before it is kept. So nothing Gemini says can become anything but a selector that finds the element it named. What is sent is the candidates (about
// 100 snippets of at most 160 characters, picture and link addresses), not the page. The answer is saved like a picked part is (a rule on top of the site's own),
// the book is recorded again, and the bar that says what was found offers Undo.
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
  function selectorFor(el, doc) {
    const unique = (sel) => {
      try {
        const found = doc.querySelectorAll(sel);
        return found.length === 1 && found[0] === el;
      } catch (e) {
        return false;
      }
    };
    if (el.id && unique("#" + escapeCss(el.id))) return "#" + escapeCss(el.id);
    let bare = ""; // a bare tag that happens to be unique here ("img"): kept only if nothing more specific is
    for (const withPosition of [false, true]) {
      const parts = [segment(el, withPosition)];
      if (unique(parts[0])) {
        if (/[.#:]/.test(parts[0])) return parts[0];
        bare = bare || parts[0];
      }
      let node = el.parentElement;
      for (let depth = 0; node && node !== doc.documentElement && depth < 6; depth++, node = node.parentElement) {
        if (node.id && node.id.length < 40) {
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
  const linkHeavy = (el, cache) => {
    if (!cache.has(el)) {
      const links = el.querySelectorAll("a[href]");
      let linked = 0;
      if (links.length >= 6) for (const a of links) linked += clean(a.textContent).length;
      cache.set(el, links.length >= 6 && linked >= clean(el.textContent).length * 0.7);
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
    for (const el of body.querySelectorAll("*")) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (el.closest(SKIP) || hidden(el) || (/^(IMG|BR|HR|SCRIPT|STYLE)$/.test(el.tagName))) continue;
      const text = clean(el.textContent);
      if (text.length < 2 || text.length > 1500 || seen.has(text)) continue;
      if (repeated(el, body)) continue;
      let menu = false;
      for (let n = el; n && n !== body && !menu; n = n.parentElement) menu = linkHeavy(n, heavy);
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
    return parts;
  }

  if (isNode) module.exports = { collect, selectorFor, interpret, asRuleParts, orderOf, titleDropFor, stableClasses, KINDS, MAX_CANDIDATES };
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
    const names = Object.keys(found);
    if (!names.length) return say("Gemini found none of the details, the chapter list or the chapter links on this page.", "#ff9d8f");
    // the list's order is read from its own numbers when they say; Gemini's guess is only for lists whose entries carry none
    let order = fromListPage ? fromListPage.order : reply.picks && reply.picks.listOrder;
    if (found.chapterList && !fromListPage) order = orderOf([...document.querySelectorAll(found.chapterList)].map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href") }))) || order;
    if (!found.chapterList) delete found.pager; // (a pagination bar is only the list's pages)
    const tried = fromListPage ? fromListPage.tried : found.chapterList ? tryListRule(found, order) : null;
    if (tried) {
      if (!tried.pagesOk) delete found.pager;
    }
    const before = await save(asRuleParts(found, order, tried ? { listUrl: tried.listUrl, titleDrop: tried.titleDrop } : null));
    const missing = Object.keys(KINDS).filter((f) => !found[f]).map((f) => LABEL[f]);
    const partial = !fromListPage && skipped.chapterList && /^only the latest/.test(skipped.chapterList) ? " The chapter list was left out: " + skipped.chapterList + "." : "";
    say("Found and saved for " + host + ": " + Object.keys(found).map((f) => LABEL[f]).join(", ") + "." + (tried ? " Chapter list tried on " + (fromListPage ? "its own page" : "this page") + ": " + tried.summary + "." : "") + (missing.length ? " Not on this page: " + missing.join(", ") + ". (The details and the chapter list are on a book's page; the next and previous links are on a chapter's page: run it there too.)" : "") + partial + " The book is being recorded again.", "#7ed17e");
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
