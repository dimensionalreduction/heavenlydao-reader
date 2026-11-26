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
  const MAX_CANDIDATES = 130; // (what is sent to the AI)
  const MAX_LOCAL = 600; // (what is looked through with no AI, Import to library: nothing is sent, so a long page's synopsis, after a sidebar of 150 texts, is reached)
  const SNIPPET = 160;
  const SKIP = "nav, footer, form, script, style, noscript, template, select, svg, iframe";
  const MORE = /更多|查看全部|全部章|全部目|more chapters|all chapters|view all|show all|see all|full list|complete list|目录|目錄|catalog/i; // a link at the end of a list that leads to the whole of it
  const MOVE = /next|prev|older|newer|上一|下一|前一|后一|後一|上頁|下頁|上页|下页|←|→|‹|›|«|»/i; // wording, rel, id or class of a link that moves between pages

  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const escapeCss = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, "\\$&"));
  const pathOf = (href) => String(href || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 80);

  // Classes that name what an element is (and will be there on another book's page too), not generated ones (a number in them, or a framework's: svelte-iec8wt,
  // css-x7k2, which change when the site is built again).
  const stableClasses = (el) => [...(el.classList || [])].filter((c) => /^[a-zA-Z][\w-]{1,30}$/.test(c) && !/\d{3,}/.test(c) && !/^(svelte|css|jsx|sc|emotion|astro)-/.test(c)).slice(0, 3);

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
  function collect(doc, url, max = MAX_CANDIDATES) {
    const candidates = [];
    const selectors = {};
    const seen = new Set();
    const add = (c, selector) => {
      if (!selector || candidates.length >= max) return;
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
        // (a book's first page shows page 2 or 3 in its bar; two chapter links of another book, /manga/x/chapter-115/ and /chapter-114/ in a box of popular books
        // beside it, are one number changing too, but they are chapters: mangaread.org's sidebar was taken for 115 pages of the list)
        if (b.found.min > 3 || /(chapter|chap|ch|episode|ep)[-_/.]?\{n\}/i.test(b.found.template)) continue;
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
      if (candidates.length >= max || parent.closest(SKIP) || hidden(parent)) continue;
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
      if (candidates.length >= max || parent.closest(SKIP) || hidden(parent)) continue;
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
    // (an h1 and what is in it first: the book's title is the h1's, though a breadcrumb above it says the same words first (Home > Action > the title, on the
    // many manga sites built on one WordPress theme: mangaread.org, yaoiscan.com), and on a long page the h1 would come after the last candidate there is room for)
    const heads = [...body.querySelectorAll("h1")].flatMap((h) => [h, ...h.querySelectorAll("*")]);
    for (const el of new Set([...heads, ...body.querySelectorAll("*")])) {
      if (candidates.length >= max) break;
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

  // The book's own parts on a book's page whose metadata does not say them (a comic site with an h1 and no og:novel tags: wfwf532.com has no title the popup can read, and
  // Import to library waits for one): the title is the h1 that the page's own title carries (or, when the h1 is dressed up with a circle and a language,
  // "[Circle] Title [English]" on nhentai.net, the part of it that the page's title carries), the cover the picture named after it, the synopsis a long text in an element
  // called summary, the genres a group of links called genre or tag. Nothing is guessed where the page's metadata names the book. `listed`: the page has a chapter list; with
  // none, a title alone is not enough to tell a book's page from a chapter's (its h1 is the chapter's): it takes a cover, a synopsis or genres with it. -> picks as Gemini's
  function guessBookPicks(candidates, selectors, doc, listed) {
    const picks = {};
    if (!doc || (doc.querySelector && doc.querySelector('meta[property="og:novel:book_name"]'))) return picks;
    const said = saidOf(doc);
    const carried = (c) => c.kind === "text" && c.text.length >= 2 && said.includes(c.text.toLowerCase());
    const elOf = (c) => {
      try {
        return doc.querySelector(selectors[c.id]);
      } catch (e) {
        return null;
      }
    };
    const inH1 = (c) => { const el = elOf(c); return !!(el && el.closest && el.closest("h1")); };
    const head = candidates.find((c) => c.tag === "h1" && c.text.length <= 100 && carried(c))
      || candidates.filter((c) => c.text && c.text.length >= 8 && carried(c) && inH1(c)).sort((a, b) => b.text.length - a.text.length)[0]
      // (an h1 with a badge in it, "A Dream Escape END" on toonily.com: its words without the badge are what the page's title carries; the badge is left out
      // when it is read, bookTitleDropFor)
      || candidates.find((c) => c.tag === "h1" && c.text.length <= 100 && !!bookTitleDropFor(elOf(c), said));
    if (!head) return picks;
    picks.title = head.id;
    const t = titleWithout(elOf(head), bookTitleDropFor(elOf(head), said)).toLowerCase() || head.text.toLowerCase(); // (the title without its badge)
    const cover = candidates.find((c) => c.kind === "img" && c.alt && (c.alt.toLowerCase() === t || (c.alt.length >= 8 && (c.alt.toLowerCase().includes(t) || t.includes(c.alt.toLowerCase())))));
    if (cover) picks.cover = cover.id;
    const named = (c, re) => re.test(selectors[c.id] || "");
    // (a name that says synopsis or description before one that says summary, which on many manga sites is every box of the book's details: div.summary_content,
    // its rating and its title, beside div.description-summary. Such a box opens with the title, or holds the labels of its rows, Rating, Status, Genre(s):
    // three short texts or more inside it (yaoiscan.com's "4.6 Your Rating Rating 19 Days Average…"); a synopsis is sentences)
    const SAYS = /synopsis|descr|blurb|intro/i;
    const wrapNamed = (c) => { // (its own name, or a box around it: div.description-summary > div.summary__content > p)
      for (let n = elOf(c), i = 0; n && i < 4; n = n.parentElement, i++) if (SAYS.test((typeof n.className === "string" ? n.className : "") + " " + (n.id || ""))) return true;
      return false;
    };
    const strength = (c) => (named(c, SAYS) || wrapNamed(c) ? 2 : 1);
    const shortEls = candidates.filter((c) => c.kind === "text" && c.text.length < 25).map(elOf).filter(Boolean);
    // (... and a row's value beside its label, "Alternative" and the book's other names, is not one either, unless the label says it is the synopsis;
    // yaoiscan.com's synopsis opens with the title, "19 Days manga summary: …", and is named description: only a box named summary is judged by its start)
    const box = (c) => {
      if (strength(c) === 1 && c.text.toLowerCase().startsWith(t)) return true;
      const el = elOf(c);
      if (!el) return false;
      if (shortEls.filter((e) => e !== el && el.contains(e)).length >= 3) return true;
      const label = el.previousElementSibling ? clean(el.previousElementSibling.textContent) : "";
      return !!label && label.length < 25 && !/summary|synopsis|descri|plot|story|about|简介|簡介|内容/i.test(label);
    };
    const summary = candidates.filter((c) => c.kind === "text" && (c.longer || c.text.length) >= 40 && named(c, /summary|synopsis|descr|intro|blurb/i) && !box(c))
      .sort((a, b) => strength(b) - strength(a))[0];
    if (summary) picks.description = summary.id;
    const genres = candidates.find((c) => c.kind === "group" && named(c, /genre|categor|tag/i));
    if (genres) picks.genre = genres.id;
    return listed || picks.cover || picks.description || picks.genre ? picks : {};
  }

  // What the page's own title and its og:title say, in small letters: the book's title is in it (or in one of them) on almost every book's page.
  function saidOf(doc) {
    const og = doc && doc.querySelector && doc.querySelector('meta[property="og:title"]');
    return clean((doc ? doc.title : "") + " " + (og ? og.getAttribute("content") : "")).toLowerCase();
  }

  // The parts of the book's title element that are not its title: a badge in the h1 ("A Dream Escape <span class="manga-title-badges">END</span>",
  // HOT, NEW on many manga sites), where the page's title (`said`, saidOf) carries the element's words without them and not with them. Selectors for those
  // parts, inside the title element (the rule's book.titleDrop), or "" when the whole is the title or the rest is not carried either.
  function bookTitleDropFor(el, said) {
    if (!el || !el.children || !el.children.length) return "";
    const whole = clean(el.textContent).toLowerCase();
    if (!whole || said.includes(whole)) return "";
    const said1 = " " + said.replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
    const drop = [];
    for (const kid of el.children) {
      const t = clean(kid.textContent).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (!t || said1.includes(" " + t + " ")) continue; // (a word of the title in its own element is kept)
      const sel = kid.tagName.toLowerCase() + stableClasses(kid).map((c) => "." + escapeCss(c)).join("");
      if (!drop.includes(sel)) drop.push(sel);
    }
    if (!drop.length) return "";
    const rest = titleWithout(el, drop.join(", ")).toLowerCase();
    return rest.length >= 2 && said.includes(rest) ? drop.join(", ") : "";
  }
  // An element's text without the parts `drop` names ("" when the element is missing or the selector is bad).
  function titleWithout(el, drop) {
    if (!el) return "";
    if (!drop) return clean(el.textContent);
    const copy = el.cloneNode(true);
    try {
      copy.querySelectorAll(drop).forEach((n) => n.remove());
    } catch (e) {
      return "";
    }
    return clean(copy.textContent);
  }

  // What the page says on its own when Gemini cannot be asked (no key, no answer) or is not wanted (Import to library): the chapter list is the list of links with the most
  // entries whose texts have numbers in them, not cut short ("latest chapters"), and the pagination bar that gives the most pages; on a page with such a list, the book's
  // own parts too (guessBookPicks), since the popup cannot read them from a page with no metadata. -> picks as Gemini's: { chapterList: id, pager: id, title: id, ... }
  // opts.gallery: the page links to the book's own pages, a picture each (galleryOf): a book's page with no list, whose details are read as with one.
  function guessPicks(candidates, selectors, doc, opts) {
    const score = (c) => c.count + (c.first && c.first.some((t) => /\d/.test(t)) ? 100000 : 0) + (c.hrefs && /\d/.test(c.hrefs[0] || "") ? 50000 : 0);
    // (a list whose links lead to tags and people, /parody/original/ and /users/3476506/, is never the chapters)
    const section = (h) => (/^\/([^/?#]*)/.exec(String(h || "")) || [])[1] || "";
    const TAXONOMY = /^(tags?|genres?|categor(y|ies)|users?|authors?|artists?|parod(y|ies)|characters?|groups?|languages?|search|series|labels?)$/i;
    // (... or a genre picked in the query, /browse?genres=Comedy, /novels/?genre=Fantasy: woopread.com's and wuxiaworld.com's genre lists were taken for the chapters)
    const TAXONOMY_QUERY = /[?&](tags?|genres?|categor(y|ies)|sort|order|status|type)=/i;
    const scattered = (c) => !!c.hrefs && c.hrefs.some((h) => TAXONOMY.test(section(h)) || TAXONOMY_QUERY.test(h));
    // (links that go nowhere a fetch can follow, javascript:void(0) or #: novelhi.com's list opens its chapters by script)
    const nowhere = (c) => !!c.hrefs && c.hrefs.every((h) => /^\s*(javascript:|#|$)/i.test(h));
    // (a list of chapters says a number somewhere, in its entries or their addresses; a list of genres or sort tabs says none)
    const numbered = (c) => (c.first || []).concat(c.last || []).some((t) => /\d/.test(t)) || (c.hrefs || []).some((h) => /\d/.test(h));
    const lists = candidates.filter((c) => c.kind === "list" && c.count >= 5 && !c.partial && !scattered(c) && !nowhere(c) && numbered(c)).sort((a, b) => score(b) - score(a));
    const pagers = candidates.filter((c) => c.kind === "pager").sort((a, b) => b.pages - a.pages);
    const picks = {};
    if (lists[0]) picks.chapterList = lists[0].id;
    if (lists[0] && pagers[0]) picks.pager = pagers[0].id;
    Object.assign(picks, guessBookPicks(candidates, selectors, doc, !!lists[0] || !!(opts && opts.gallery)));
    // the links in the list's box include others (a sort tab, "first episode"): when most of them share a class, only those are the chapters (div.list-sec a -> a.ep-item)
    if (lists[0] && selectors && doc && selectors[lists[0].id]) {
      try {
        const base = selectors[lists[0].id];
        const els = [...doc.querySelectorAll(base)];
        const tally = new Map();
        for (const a of els) { const k = stableClasses(a).join("."); tally.set(k, (tally.get(k) || 0) + 1); }
        const [cls, n] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0] || ["", 0];
        if (cls && n >= 8 && n < els.length && n >= els.length * 0.7) {
          const refined = base + "." + cls.split(".").map(escapeCss).join(".");
          if (present("chapterList", refined, doc)) selectors[lists[0].id] = refined;
        }
      } catch (e) {
        // the list as it was
      }
    }
    return picks;
  }

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
  // the first few entries: a child element with a short text that looks like a date or an age ("Aug 7, 2025", "3 days ago") and is not all of the link's text;
  // or the entry's number in an element of its own when the rest of the text says it too (novelfire.net: <span class="chapter-no">1</span> before
  // "Chapter 1: The Black Hole", which came out "1Chapter 1: The Black Hole"; a title with no number keeps it)
  const DATEY = /\b\d{4}\b|\bago\b|\d+\s*(?:day|hour|minute|min|week|month|year)s?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|天前|小时前|分钟前|前$/i;
  const numberSaidAgain = (t, whole) => {
    const n = /^(\d{1,5})\.?$/.exec(t);
    return !!n && new RegExp("(^|\\D)0*" + Number(n[1]) + "(\\D|$)").test(whole.replace(t, " "));
  };
  function titleDropFor(entries) {
    const parts = new Set();
    for (const a of entries.slice(0, 5)) {
      const whole = clean(a.textContent);
      for (const e of a.querySelectorAll("*")) {
        const t = clean(e.textContent);
        if (!t || t.length > 30 || t === whole || !(DATEY.test(t) || numberSaidAgain(t, whole))) continue;
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
    if (book.title && extras && extras.bookTitleDrop) book.titleDrop = extras.bookTitleDrop; // (a badge inside the title, left out of it)
    if (Object.keys(book).length) parts.book = book;
    if (found.chapterList) {
      parts.toc = { list: found.chapterList, ...(order === "desc" ? { reverse: true } : order === "asc" ? { reverse: false } : {}), pages: found.pager ? { kind: "numbered", selector: found.pager } : null, titleDrop: (extras && extras.titleDrop) || null };
      if (extras && "listUrl" in extras) parts.toc.listUrl = extras.listUrl || null; // (tried and none: an older one is dropped)
      if (extras && extras.post && parts.toc.listUrl) parts.toc.post = true; // (its address asked with a POST, as the page's script asks it)
    }
    const nav = {};
    if (found.next) nav.next = found.next;
    if (found.prev) nav.prev = found.prev;
    if (Object.keys(nav).length) parts.nav = nav;
    // read from the site's data (a page a script fills in): the list, and the chapter's text
    if (extras && extras.dataList) parts.toc = { json: extras.dataList.json, listUrl: extras.dataList.listUrl, reverse: !!extras.dataList.reverse };
    // a book of one chapter whose pictures are each on a page of their own: the links to its pages (and the picture's place on them, below as `images`)
    if (extras && extras.gallery) parts.toc = { gallery: extras.gallery.selector, listUrl: extras.gallery.listUrl || null };
    if (extras && extras.dataText) parts.json = extras.dataText;
    // where a chapter's text is (a site that sends its pages whole)
    if (extras && extras.textSelector) parts.selector = extras.textSelector;
    // where a comic's pictures are (a site whose chapters are pictures)
    if (extras && extras.images) parts.images = extras.images;
    // ... or the list of them in a chapter page's script (a page whose script draws them)
    if (extras && extras.scriptPictures) parts.scriptPictures = extras.scriptPictures;
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
  const PAGE = /^(page|p|pg|page_?(no|num|number|index)|pageindex|pagenum|[a-z]+_page)$/i; // (chapter_page: manhuatop.org's "Load more chapters"; never per_page, a size)
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
      if (pairs.length < Math.min(3, items.length)) {
        // ... or by its address, where a field holds the chapter's own (its path or the whole address): a title the page runs into its date, "Chapter 2152 days
        // ago" (manhuatop.org: "Chapter 215" and "2 days ago" in two elements of the link), pairs with nothing; its title is then the field each entry starts with
        const keyOf = (u) => String(u).split("#")[0].replace(/\/+$/, "");
        const byUrl = new Map(entries.map((e) => [keyOf(e.url), e]));
        for (const [f, v] of fieldsOf(items[0])) {
          if (typeof v !== "string" || !/^(https?:\/\/|\/)/.test(v)) continue;
          const got = [];
          for (const item of items) {
            let u = "";
            try {
              u = new URL(String(Rules.jsonAt(item, f)), dataUrl).href;
            } catch (e) {
              continue;
            }
            const e = byUrl.get(keyOf(u));
            if (e) got.push({ item, entry: e });
          }
          if (got.length > pairs.length) pairs = got;
        }
        if (pairs.length < Math.min(3, items.length)) continue;
        titleField = "";
        for (const [f] of fieldsOf(pairs[0].item)) {
          const ok = pairs.filter((p) => {
            const t = norm(Rules.jsonAt(p.item, f));
            return t.length >= 2 && !/^[\d.]+$/.test(t) && norm(p.entry.text).startsWith(t);
          }).length;
          if (ok >= pairs.length * 0.8) {
            titleField = f;
            break;
          }
        }
        if (!titleField) continue;
      }
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
      const page = keys.find((k) => OFFSET.test(k)) || keys.find((k) => PAGE.test(k) && !LIMIT.test(k)) || "";
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
      // (part of a list whose address names no page, though the data says it is page 1 of more, "page": 1 beside its "total": 221 (manhuatop.org): that name, as the
      // address's page, is tried by listFromLoaded before it is believed)
      const pageField = !page && parent && typeof parent === "object" ? Object.keys(parent).find((k) => PAGE.test(k) && !LIMIT.test(k) && Number(parent[k]) === 1) : "";
      if (partial && pageField && (totals.count || totals.pages)) got.pageGuess = { name: pageField, count: totals.count, pages: totals.pages, dataUrl: dataAt.href, first: String(Rules.jsonAt(items[0], titleField) || "") };
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

  // A comic's chapter: the pictures one under another in a box (wfwf528.com: div#vimg-area, each <img data-src=...> with a placeholder in src). On each of two chapters' pages as the
  // site sends them: the pictures (the real address in a lazy-loading attribute, else src) that share a host and a folder, the most of them (a page's banners come from elsewhere),
  // at least 3; the box that holds them is selectorFor's, and the selector is kept when it finds those pictures on both pages. { selector, counts: [pictures on each] } or null.
  // The pictures of a page that share a host and a folder, the most of them (the chapter's own: a page's banners come from elsewhere). [<img>]
  function pictureGroup(doc, baseUrl, keep) {
    const groups = new Map();
    for (const img of doc.querySelectorAll("img")) {
      if (keep && !keep(img)) continue;
      const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      let u;
      try { u = new URL(raw, baseUrl); } catch (e) { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      const key = u.host + u.pathname.replace(/[^/]*$/, "");
      (groups.get(key) || groups.set(key, []).get(key)).push(img);
    }
    return [...groups.values()].sort((x, y) => y.length - x.length)[0] || [];
  }
  function imagesSelectorFor(docA, docB, baseUrl) {
    const addressOf = (img) => {
      const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      try {
        const u = new URL(raw.trim(), baseUrl);
        return /^https?:$/.test(u.protocol) ? u : null;
      } catch (e) {
        return null;
      }
    };
    // (a picture on both chapters is the site's, not a chapter's: its logo, the covers in a sidebar of popular books, which on mangaread.org outnumber a short
    // chapter's pages in one folder)
    const both = new Set(docB ? [...docB.querySelectorAll("img")].map((i) => (addressOf(i) || {}).href).filter(Boolean) : []);
    const groupsOf = (doc, skip) => {
      const groups = new Map();
      for (const img of doc.querySelectorAll("img")) {
        const u = addressOf(img);
        if (!u || skip.has(u.href)) continue;
        const key = u.host + u.pathname.replace(/[^/]*$/, "");
        (groups.get(key) || groups.set(key, []).get(key)).push(img);
      }
      return [...groups.values()].sort((x, y) => y.length - x.length);
    };
    const boxOf = (imgs) => {
      let box = imgs[0].parentElement;
      while (box && !imgs.every((i) => box.contains(i))) box = box.parentElement;
      return box;
    };
    // the biggest group of pictures from one folder that sits in a box of its own (not the whole page); with the pictures both chapters have left out, then, when
    // that leaves none, with them (chapters that show the same pictures)
    for (const skip of [both, new Set()]) {
      for (const group of groupsOf(docA, skip).slice(0, 3)) {
        if (group.length < 3) break;
        const box = boxOf(group);
        if (!box || box === docA.body || box === docA.documentElement) continue;
        for (const base of [selectorFor(box, docA), selectorFor(box, docA, true)]) {
          if (!base || base === "body") continue;
          const sel = base + " img";
          const on = (doc) => { try { return [...doc.querySelectorAll(sel)].length; } catch (e) { return 0; } };
          const a = on(docA), b = docB ? on(docB) : 0;
          if (a >= 3 && a <= group.length * 1.3 && (!docB || (b >= 3))) return { selector: sel, counts: [a, b] };
        }
      }
    }
    return null;
  }

  // ---------- a book of one chapter, a picture on each of its pages (a gallery) ----------
  // A doujin's page (nhentai.net/g/<id>/) has no chapter list: the book is one chapter, and its thumbnails link to its pages, one picture each, at this page's own
  // address with a number after it (/g/<id>/1/ ... /26/). Those links (a picture in each, no text), the numbers running 1, 2, 3... (at least 3; a cover may link to
  // page 1 again, outside the grid), and the deepest box that holds a link to each of them: a selector for the links in that box, kept when it finds those pages and
  // nothing else. { selector, count, urls } (urls: each page's address, in order) or null.
  function galleryOf(doc, url) {
    let here = null;
    try {
      here = new URL(url);
    } catch (e) {
      return null;
    }
    const root = here.pathname.replace(/\/+$/, "") + "/";
    const pageOf = (a) => {
      let u = null;
      try {
        u = new URL(a.getAttribute("href"), url);
      } catch (e) {
        return null;
      }
      if (u.origin !== here.origin || !u.pathname.startsWith(root)) return null;
      const m = /^(\d{1,4})\/?$/.exec(u.pathname.slice(root.length));
      return m && Number(m[1]) > 0 ? { n: Number(m[1]), href: u.href.split("#")[0] } : null;
    };
    const links = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      const t = clean(a.textContent); // (none, or the page's number under its thumbnail: "3", "Page 3")
      if (hidden(a) || (t && !/^\D{0,8}\d{1,4}$/.test(t)) || !a.querySelector("img")) continue;
      const p = pageOf(a);
      if (p) links.push({ a, ...p });
    }
    const numbers = new Set(links.map((l) => l.n));
    let count = 0;
    while (numbers.has(count + 1)) count++;
    if (count < 3) return null;
    const holdsAll = (el) => {
      const inside = new Set(links.filter((l) => el.contains(l.a)).map((l) => l.n));
      for (let n = 1; n <= count; n++) if (!inside.has(n)) return false;
      return true;
    };
    let box = links.find((l) => l.n === count).a.parentElement;
    while (box && box !== doc.body && !holdsAll(box)) box = box.parentElement;
    if (!box || box === doc.body || box === doc.documentElement) return null;
    for (const base of [selectorFor(box, doc), selectorFor(box, doc, true)]) {
      if (!base || base === "body") continue;
      const sel = base + " a[href]";
      let found = [];
      try {
        found = [...doc.querySelectorAll(sel)];
      } catch (e) {
        continue;
      }
      const pages = found.map(pageOf);
      if (pages.some((p) => !p || p.n > count) || new Set(pages.map((p) => p.n)).size !== count) continue;
      const urls = [];
      for (let n = 1; n <= count; n++) urls.push(pages.find((p) => p.n === n).href);
      return { selector: sel, count, urls };
    }
    return null;
  }

  // Where a gallery's page has its picture, from two of its pages as the site sends them: the <img> whose address is not on the other page, found by a selector
  // that finds exactly one picture on each page, a different one on each (the site's logo and banners are the same on both). { selector, urls: [on A, on B] } or null.
  function pagePictureFor(docA, docB, urlA, urlB) {
    const srcOf = (img, base) => {
      const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      try {
        const u = new URL(raw, base);
        return /^https?:$/.test(u.protocol) && !/\.svg(\?|$)/i.test(u.pathname) ? u.href : "";
      } catch (e) {
        return "";
      }
    };
    const onB = new Set([...docB.querySelectorAll("img")].map((i) => srcOf(i, urlB)));
    for (const img of docA.querySelectorAll("img")) {
      const a = srcOf(img, urlA);
      if (!a || onB.has(a)) continue;
      for (const sel of [selectorFor(img, docA), selectorFor(img, docA, true)]) {
        if (!sel) continue;
        let inA = [];
        let inB = [];
        try {
          inA = [...docA.querySelectorAll(sel)];
          inB = [...docB.querySelectorAll(sel)];
        } catch (e) {
          continue;
        }
        const b = inB.length === 1 && inB[0].tagName === "IMG" ? srcOf(inB[0], urlB) : "";
        if (inA.length === 1 && b && b !== a) return { selector: sel, urls: [a, b] };
      }
    }
    return null;
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

  // (a comic whose pictures a script draws: the list in the page that names them, user-rules.js scriptLists / scriptPicturesFor)
  const scriptLists = (html) => Rules.scriptLists(html);
  const scriptPicturesFor = (html, shown, pageUrl) => Rules.scriptPicturesFor(html, shown, pageUrl);

  if (isNode) module.exports = { guessPicks, collect, MAX_LOCAL, selectorIn, bookTitleDropFor, saidOf, selectorFor, interpret, asRuleParts, orderOf, titleDropFor, stableClasses, KINDS, MAX_CANDIDATES, listFromData, textInData, dataUrlRule, nextFromData, textBoxOf, textSelectorFor, imagesSelectorFor, pictureGroup, galleryOf, pagePictureFor, scriptLists, scriptPicturesFor };
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
  // (window.__P2PREAD_DETECT_DRY, set by e2e/live-sites.test.js before it starts Detect: what was found is put on the bar as data, bar.dataset.result, and nothing
  // is saved or recorded: the sites everythingmoe.com lists are checked in the dev browser without changing its rules)
  const dry = window.__P2PREAD_DETECT_DRY === true;
  async function save(parts) {
    const before = (await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {};
    if (dry) {
      bar.dataset.result = JSON.stringify(parts);
      return before;
    }
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
    const links = [...there.querySelectorAll(found.chapterList)].map((a) => { try { return new URL(a.getAttribute("href"), url).href; } catch (e) { return ""; } }).filter((u) => /^https?:/.test(u));
    return { found: { chapterList: found.chapterList, ...(found.pager ? { pager: found.pager } : {}) }, order, tried, url, links };
  }

  // A list the page's script asked for as a page of its own, not as data: the Madara theme's POST to <book>/ajax/chapters/, which answers with the list's
  // elements (mangasushi.org, mangagg.com, manhwanex.com). Each address the page asked by script is asked again, with a GET and, where that does not hold
  // the list, a POST as the script did; the one whose answer holds the list's links (`selector` on this page) is the list's address, kept when it comes back
  // out of the book's address and a chapter's (dataUrlRule). -> as listFromListPage: { found, order, tried (with listUrl and post), url }, or null.
  async function listFromAsked(selector) {
    const want = new Set([...document.querySelectorAll(selector)].map((a) => a.href.split("#")[0]).filter((h) => /^https?:/.test(h)));
    if (want.size < 5) return null;
    const asked = [...new Set(performance.getEntriesByType("resource").filter((e) => e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest").map((e) => String(e.name).split("#")[0]))]
      .filter((u) => Rules.sameSite(u, host)).reverse().slice(0, 12);
    const timeout = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {});
    for (const url of asked) {
      for (const post of [false, true]) {
        const res = await fetch(url, { credentials: "include", ...(post ? { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } } : {}), ...timeout() }).catch(() => null);
        const text = res && res.ok ? await res.text().catch(() => "") : "";
        if (!text || /^\s*[[{]/.test(text)) continue; // (data is listFromLoaded's)
        const there = new DOMParser().parseFromString(text.replace(/<script[\s\S]*?<\/script>/gi, ""), "text/html");
        const sel = selectorIn(there, url, selector, want);
        if (!sel) continue;
        const listUrl = dataUrlRule(location.href, url);
        if (!listUrl) continue;
        const rule = Rules.toRule({ host, selector: "p", toc: { list: sel, listUrl, ...(post ? { post: true } : {}) } }, null);
        if (!rule.toc.url || rule.toc.url(location.href) !== url || rule.toc.url([...want][0]) !== url) continue; // (Import starts from the book, a watch from a chapter)
        const found = { chapterList: sel };
        const order = orderOf([...there.querySelectorAll(sel)].map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href") })));
        const tried = tryListRule(found, order, there, url);
        tried.listUrl = listUrl;
        tried.post = post;
        tried.summary += ", asked for at " + url.replace(/^https?:\/\/[^/]+/, "") + (post ? " with a POST, as the page's script asks for it" : "");
        const links = [...there.querySelectorAll(sel)].map((a) => { try { return new URL(a.getAttribute("href"), url).href; } catch (e) { return ""; } }).filter((u) => /^https?:/.test(u));
        return { found, order, tried, url, links };
      }
    }
    return null;
  }

  // The list's selector as it reads a part of a page asked for on its own (the list's elements without the page around them, `doc`, at `base`): the page's
  // selector, else the end of it (div.c-page-content > #manga-chapters-holder ul.main a -> ul.main a), the longest that finds the list's links (`want`) there.
  // "" when none does.
  function selectorIn(doc, base, selector, want) {
    const tokens = [];
    let cur = "";
    let depth = 0;
    for (const ch of String(selector)) {
      if (ch === "[" || ch === "(") depth++;
      else if (ch === "]" || ch === ")") depth--;
      if (!depth && (ch === " " || ch === ">")) {
        if (cur) tokens.push(cur);
        cur = "";
        if (ch === ">") tokens.push(">");
        continue;
      }
      cur += ch;
    }
    if (cur) tokens.push(cur);
    if (selector.includes(",")) return ""; // (a list of selectors: the page's own, not cut)
    const parts = tokens.filter((x) => x !== ">").length;
    for (let i = 0, kept = parts; i < tokens.length; i++) {
      if (tokens[i] === ">") continue;
      if (kept-- < 2 && parts >= 2) break; // (cut down to the link alone, "a", it would find any link: two parts at least)
      const sel = tokens.slice(i).join(" ");
      let links = [];
      try {
        links = [...doc.querySelectorAll(sel)];
      } catch (e) {
        continue;
      }
      const hrefs = links.map((a) => {
        try {
          return new URL(a.getAttribute("href") || "", base).href.split("#")[0];
        } catch (e) {
          return "";
        }
      });
      const hit = hrefs.filter((h) => want.has(h)).length;
      if (hit >= want.size * 0.8 && links.length <= want.size * 20) return sel;
    }
    return "";
  }

  // This page as the site sends it, before any script has run (what the extension will fetch): a document without its scripts, or null when it cannot be had.
  let sentHtml = ""; // (this page as sent, its scripts in it: where a comic's script keeps the list of its pictures)
  async function pageAsSent() {
    const res = await fetch(location.href, { credentials: "include" }).catch(() => null);
    if (!res || !res.ok) return null;
    sentHtml = await res.text().catch(() => "");
    const html = sentHtml.replace(/<script[\s\S]*?<\/script>/gi, "");
    return new DOMParser().parseFromString(html, "text/html");
  }

  // The pictures a page shows once its script has run: their addresses as the browser has them (src, the address it loaded, a lazy loader's attribute).
  const shownIn = (doc, base) => {
    const out = [];
    for (const img of doc.querySelectorAll("img")) {
      for (const raw of [img.currentSrc, img.src, ...["data-src", "data-original", "data-lazy-src", "src"].map((n) => img.getAttribute(n))]) {
        try {
          if (raw && !/^data:/i.test(raw)) out.push(new URL(raw, base).href);
        } catch (e) {
          // not an address
        }
      }
    }
    return out;
  };
  // A chapter whose pictures its script draws (a page as sent with a list of pictures in its script, `html`): the rule that reads that list (scriptPicturesFor), from
  // the pictures the page shows: this page's own, or another chapter's page opened in a hidden frame of this one (same site: its script runs there as it does in a
  // tab; sandboxed, so it cannot move this tab or open windows), waited for until its pictures are there (20 s at most). { scriptPictures, count } or null.
  async function scriptPicturesOn(html, url) {
    if (!scriptLists(html).length) return null; // (no list of pictures in its script: nothing to open)
    if (url.split("#")[0] === location.href.split("#")[0]) return scriptPicturesFor(html, shownIn(document, location.href), url);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-12000px;top:0;width:1000px;height:1400px;border:0;visibility:hidden;pointer-events:none";
    frame.src = url;
    document.documentElement.appendChild(frame);
    try {
      for (let t = 0; t < 40; t++) {
        await new Promise((r) => setTimeout(r, 500));
        let doc = null;
        try {
          doc = frame.contentDocument;
        } catch (e) {
          return null; // (another site after all: not readable)
        }
        if (!doc || !doc.body || doc.location.href === "about:blank") continue;
        const found = scriptPicturesFor(html, shownIn(doc, url), url);
        if (found) return found;
      }
      return null;
    } finally {
      frame.remove();
    }
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
    // part of the list, whose data says its page (pageGuess): that page's name in the address is tried, page 2, and believed when it brings other chapters
    if (best.partial && best.pageGuess) {
      const g = best.pageGuess;
      try {
        const u = new URL(g.dataUrl);
        u.searchParams.set(g.name, "2");
        const res = await fetch(u.href, { credentials: "include" }).catch(() => null);
        const next = res && res.ok ? JSON.parse(await res.text()) : null;
        const items = next ? Rules.jsonAt(next, best.json.items || "") : null;
        const first = Array.isArray(items) && items.length ? String(Rules.jsonAt(items[0], best.json.title) || "") : "";
        if (first && first !== g.first) {
          best.json = { ...best.json, page: g.name, ...(g.count ? { count: g.count } : { pages: g.pages }) };
          best.partial = false;
        }
      } catch (e) {
        // no second page by that name: the list stays part of it
      }
    }
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
  async function chapterTextRule(sent, found, neighbour, thisOnly, listLinks) {
    const raws = new Map(); // a chapter's address -> its page as sent, scripts and all
    const fetchDoc = async (url) => {
      const res = await fetch(url, { credentials: "include" }).catch(() => null);
      if (!res || !res.ok) return null;
      const raw = await res.text().catch(() => "");
      raws.set(url, raw);
      return new DOMParser().parseFromString(raw.replace(/<script[\s\S]*?<\/script>/gi, ""), "text/html");
    };
    let docA = null;
    let docB = null;
    let urlA = "";
    let urlB = "";
    let where = "";
    if (thisOnly) {
      docA = sent;
      urlA = location.href;
      where = "this chapter";
    } else if (found.next || found.prev) {
      docA = sent;
      urlA = location.href;
      urlB = neighbour || "";
      docB = neighbour ? await fetchDoc(neighbour) : null;
      where = "this chapter and the " + (found.next ? "next" : "previous") + " one";
    } else if (found.chapterList) {
      // (the list's links here, or where the list was found: its own page, or what the page's script asked for, mangasushi.org's POST)
      const links = [...new Set(listLinks && listLinks.length ? listLinks : [...document.querySelectorAll(found.chapterList)].map((a) => a.href).filter((u) => /^https?:/.test(u)))];
      if (links.length < 2) return null;
      // (two from the middle of the list: the newest chapters may be the odd ones, with their pictures put in by a script and only the banners in the page as sent)
      const at = links.length >= 6 ? Math.floor(links.length / 2) : 0;
      urlA = links[at];
      urlB = links[at + 1];
      docA = await fetchDoc(urlA);
      docB = await fetchDoc(urlB);
      where = at ? "two chapters from the middle of its list" : "its first two chapters";
    }
    if (urlA === location.href) raws.set(urlA, sentHtml);
    if (!docA || (!docB && !thisOnly)) return null;
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
    // (no chapter text, or a short one beside a run of pictures, a comic's notes or disclaimer (rawkuma.net: 974 characters beside 10 and 29 pictures): a comic,
    // whose chapters are pictures)
    const pics = imagesSelectorFor(docA, docB, location.href);
    const comic = pics && Math.min(...pics.counts.filter((n, i) => i === 0 || docB)) >= 5 && (!got || Math.max(...got.sizes) < 1500);
    if (!pics && (!got || Math.max(...got.sizes) < 1500)) {
      // no pictures in the pages as sent, and little or no text: a comic whose script draws its pictures from a list in the page (the rule is kept when the other
      // chapter's page has such a list too)
      const scripted = await scriptPicturesOn(raws.get(urlA) || "", urlA).catch(() => null);
      const there = scripted && docB ? Rules.picturesInScript(raws.get(urlB) || "", scripted.scriptPictures, urlB).length : 0;
      if (scripted && (!docB || there >= 3)) {
        const sp = scripted.scriptPictures;
        return { scriptPictures: sp, summary: "the list in the page's script, " + sp.name + (sp.base64 ? " (base64)" : "") + (sp.prefix ? " on " + sp.prefix.replace(/^https:\/\//, "") : "") + ", " + scripted.count + (docB ? " and " + there : "") + " pictures on " + where };
      }
    }
    if (got && !comic) return { selector: got.selector, summary: got.selector + ", " + got.sizes[0] + " and " + got.sizes[1] + " characters on " + where };
    return pics ? { images: pics.selector, summary: pics.selector + ", " + pics.counts[0] + " and " + pics.counts[1] + " pictures on " + where } : null;
  }

  // A page as the site sends it (its scripts out), or null.
  async function fetchDocAsSent(url) {
    const res = await fetch(url, { credentials: "include" }).catch(() => null);
    if (!res || !res.ok) return null;
    return new DOMParser().parseFromString((await res.text().catch(() => "")).replace(/<script[\s\S]*?<\/script>/gi, ""), "text/html");
  }

  // A book of one chapter, a picture on each of its pages (galleryOf found the links to them here): kept when the links are in the page as the site sends it (what
  // Refresh chapters and the chapter's download read) and its first two pages show one picture each in the same place (pagePictureFor). { selector, count, images,
  // listUrl } (listUrl: how to reach this page from a page's address, when that holds up) or null.
  async function confirmGallery(gallery) {
    const sent = await pageAsSent().catch(() => null);
    let listed = 0;
    try {
      listed = sent ? sent.querySelectorAll(gallery.selector).length : 0;
    } catch (e) {
      listed = 0;
    }
    if (!listed) return null;
    const [a, b] = await Promise.all([fetchDocAsSent(gallery.urls[0]), fetchDocAsSent(gallery.urls[1])]);
    const picture = a && b ? pagePictureFor(a, b, gallery.urls[0], gallery.urls[1]) : null;
    if (!picture) return null;
    const pageUrl = location.href.split("#")[0];
    let listUrl = null;
    const wanted = Rules.listUrlRule(pageUrl, gallery.urls[0]);
    if (wanted) {
      const rule = Rules.toRule({ host, selector: "p", toc: { gallery: gallery.selector, listUrl: wanted } }, null);
      const back = rule.toc.url ? rule.toc.url(gallery.urls[0]) : null;
      if (back && back.split(/[?#]/)[0] === pageUrl.split(/[?#]/)[0]) listUrl = wanted;
    }
    return { selector: gallery.selector, count: gallery.count, images: picture.selector, listUrl };
  }

  (async () => {
    say("Looking at the page…");
    const { candidates, selectors } = collect(document, location.href, window.__P2PREAD_DETECT_LOCAL ? MAX_LOCAL : MAX_CANDIDATES);
    if (!candidates.length) return say("Nothing on this page looks like a book's details or a chapter. Open the book's page or a chapter and try again.", "#ff9d8f");
    // (a book of one chapter whose pictures are each on a page of their own: found on the page itself, never asked of the AI)
    const gallery = galleryOf(document, location.href);
    let reply;
    let chapterPage = false;
    if (window.__P2PREAD_DETECT_LOCAL) { // (no Gemini: Import to library, or no key)
      // a comic's chapter page (many pictures one under another): its strip of neighbouring episodes is not the book's chapter list, so none is guessed from it; only where its
      // pictures are is found (from this page as sent)
      // (pictures that are big, loaded or waiting to be by a lazy loader: a list page's banners are small and not lazy)
      const lazy = (im) => ["data-src", "data-lazy-src", "data-original"].some((n) => im.hasAttribute(n));
      const big = (im) => (im.naturalWidth >= 300 && im.naturalHeight >= 300) || (lazy(im) && im.naturalWidth < 300 && im.getBoundingClientRect().width >= 200);
      // (not on a page the popup shows as a book's, Import to library's: a book's page with a grid of big covers, recommended books, is not a chapter: zinmanga.net, mangadot.net)
      chapterPage = !window.__P2PREAD_DETECT_BOOK && !gallery && pictureGroup(document, location.href, big).length >= 6;
      say(chapterPage ? "This is a comic's chapter: looking for where its pictures are…" : "Looking for the chapter list and the book's details on the page (" + candidates.length + " elements)…");
      reply = { picks: chapterPage ? {} : guessPicks(candidates, selectors, document, { gallery: !!gallery }) };
    } else {
      say("Asking the AI which parts of this page are the book's details, its chapter list and the chapter links (" + candidates.length + " elements)…");
      reply = await ext.runtime.sendMessage({ type: "book:detect", candidates, page: { host, title: document.title } }).catch((e) => ({ error: e.message }));
      if (!reply || reply.error) {
        const why = (reply && reply.error) || "no answer";
        reply = { picks: guessPicks(candidates, selectors, document, { gallery: !!gallery }) };
        if (!reply.picks.chapterList && !reply.picks.title && !gallery) return say("The AI could not tell: " + why + ", and no list of chapters could be found on this page.", "#ff9d8f");
        say("The AI could not tell (" + why + "): the chapter list was found by looking at the page.");
      }
    }
    if (!reply.picks.chapterList && !reply.picks.title && window.__P2PREAD_DETECT_LOCAL && !chapterPage && !gallery) return say("No list of chapters could be found on this page. Detect with AI may do better.", "#ff9d8f");
    const { found, skipped } = interpret(reply.picks, candidates, selectors);
    // each selector is checked on the page once more, as the extension will use it
    for (const field of Object.keys(found)) if (!present(field, found[field])) delete found[field];
    // a "synopsis" that holds the title is the box of all the book's details (nhentai.net's: the title, the tags and their counts), not a synopsis
    if (found.description && found.title) {
      try {
        const d = document.querySelector(found.description);
        const t = document.querySelector(found.title);
        if (d && t && d.contains(t)) delete found.description;
      } catch (e) {
        // a selector the browser cannot use: present() has dropped it already
      }
    }
    // a badge in the title's element is left out of the title (bookTitleDropFor: "A Dream Escape END")
    let bookTitleDrop = "";
    if (found.title) {
      try {
        bookTitleDrop = bookTitleDropFor(document.querySelector(found.title), saidOf(document));
      } catch (e) {
        bookTitleDrop = "";
      }
    }
    // a book of one chapter, a picture on each of its pages: no chapter list or chapter links (a list here would be other books: related ones, tags)
    let galleryFound = null;
    let galleryNote = "";
    if (gallery) {
      say("This book is one chapter of " + gallery.count + " pages: looking for where a page's picture is…");
      galleryFound = await confirmGallery(gallery).catch(() => null);
      if (galleryFound) for (const f of ["chapterList", "pager", "next", "prev"]) delete found[f];
      else galleryNote = " The links to its " + gallery.count + " pages were found, but not one picture in the same place on its first two pages.";
    }
    let fromListPage = null;
    if (!found.chapterList && !galleryFound) {
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
    const sent = (found.chapterList && !fromListPage) || found.next || found.prev || chapterPage ? await pageAsSent().catch(() => null) : null;
    if (sent && found.chapterList && !fromListPage && !present("chapterList", found.chapterList, sent)) {
      say("The chapter list is filled in by the page's script. Looking for it in the data the page loaded…");
      const got = await listFromLoaded(found.chapterList).catch(() => null);
      // (... or in a page of its own the script asked for, the list's elements: the Madara theme's POST to <book>/ajax/chapters/)
      let asked = null;
      if (!(got && got.dataList)) {
        say("The chapter list is filled in by the page's script. Looking for it in what the script asked the site for…");
        asked = await listFromAsked(found.chapterList).catch(() => null);
      }
      delete found.chapterList;
      delete found.pager;
      if (asked) {
        fromListPage = asked;
        Object.assign(found, asked.found);
      } else if (got && got.dataList) fromData = got;
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
    if (!textData && !fromData && (found.next || found.prev || chapterPage || found.chapterList)) {
      say("Looking for where a chapter's text is…");
      textSel = await chapterTextRule(sent, found, linkOf(found.next) || linkOf(found.prev), chapterPage, fromListPage && fromListPage.links).catch(() => null);
    }
    const names = Object.keys(found);
    if (!names.length && !fromData && !textData && !textSel && !galleryFound) return say("The AI found none of the details, the chapter list or the chapter links on this page." + dataNote + galleryNote, "#ff9d8f");
    // the list's order is read from its own numbers when they say; Gemini's guess is only for lists whose entries carry none. Read on the page as the site
    // sends it (what Refresh chapters reads): a page's script may turn the list round on screen (69shuba sends it newest first and shows it oldest first)
    let order = fromListPage ? fromListPage.order : reply.picks && reply.picks.listOrder;
    if (found.chapterList && !fromListPage) order = orderOf([...(sent || document).querySelectorAll(found.chapterList)].map((a) => ({ text: clean(a.textContent), href: a.getAttribute("href") }))) || order;
    if (!found.chapterList) delete found.pager; // (a pagination bar is only the list's pages)
    const tried = fromListPage ? fromListPage.tried : found.chapterList ? tryListRule(found, order) : null;
    if (tried) {
      if (!tried.pagesOk) delete found.pager;
    }
    const before = await save(asRuleParts(found, order, { bookTitleDrop, ...(tried ? { listUrl: tried.listUrl, titleDrop: tried.titleDrop, post: !!tried.post } : {}), dataList: fromData && fromData.dataList, dataText: textData && textData.dataText, textSelector: textSel && textSel.selector, images: (textSel && textSel.images) || (galleryFound && galleryFound.images), scriptPictures: textSel && textSel.scriptPictures, gallery: galleryFound }));
    const missing = Object.keys(KINDS).filter((f) => !found[f] && !((fromData || dataNote) && (f === "chapterList" || f === "pager")) && !(galleryFound && ["chapterList", "pager", "next", "prev"].includes(f))).map((f) => LABEL[f]);
    const partial = !fromListPage && skipped.chapterList && /^only the latest/.test(skipped.chapterList) ? " The chapter list was left out: " + skipped.chapterList + "." : "";
    const saved = Object.keys(found).map((f) => LABEL[f]).concat(galleryFound ? ["one chapter of " + galleryFound.count + " pages, a picture each"] : [], fromData ? ["chapter list (from the site's data)"] : [], textData ? ["chapter text (from the site's data)"] : [], textSel ? [textSel.images || textSel.scriptPictures ? "chapter pictures" : "chapter text"] : []);
    say((dry ? "Found (a dry run: nothing saved) for " : "Found and saved for ") + host + ": " + saved.join(", ") + "." + (galleryFound ? " A page's picture: " + galleryFound.images + (galleryFound.listUrl ? "; this page is found from a page's address" : "") + "." : "") + (tried ? " Chapter list tried on " + (fromListPage ? "its own page" : "this page") + ": " + tried.summary + "." : "") + (fromData ? " Chapter list tried on the site's data: " + fromData.summary + "." : "") + (textData ? " Chapter text: " + textData.summary + "." : "") + (textSel ? (textSel.images || textSel.scriptPictures ? " Chapter pictures: " : " Chapter text: ") + textSel.summary + "." : "") + dataNote + galleryNote + (missing.length ? " Not on this page: " + missing.join(", ") + ". (The details and the chapter list are on a book's page; the next and previous links are on a chapter's page: run it there too.)" : "") + partial + (dry ? "" : " The book is being recorded again."), "#7ed17e");
    action.textContent = "Undo";
    action.hidden = dry; // (nothing to undo)
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
