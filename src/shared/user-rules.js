// Site rules the person adds themselves, like a userscript manager's own scripts: the built-in rules (sources/) are the approved set, and anything the
// person saves here is added to it, for any site they choose.
//
// A rule is DATA, never code: selectors, an encoding, how a list is laid out. Nothing the person (or a file they import) writes is ever run, and a rule can
// only make the extension fetch pages of its own site. Saved rules live in the extension's storage under "userRules" and can be changed only from the
// extension's own pages (rules.html), never by a website or another device.
//
//   userRules = { "example.com": { spec, enabled, updatedAt } }
//   A rule for a site the extension already knows (a built-in one) sits on top of it: whatever the rule leaves out is the built-in rule's, and the book's
//   selectors are merged field by field. So fixing one thing, like the cover, is a rule with only that: { host, book: { cover: "..." } }.
//   spec = {
//     host      "example.com"                    one site, no "www.", no path
//     name      a label (optional)
//     selector  the element that holds a chapter's text (needed unless the site is a built-in one)
//     junk      elements inside it to drop (optional; script, style, ins and iframe always go)
//     charset   only when the site does not say its encoding ("gbk", "big5"...)
//     toc       { list: "ul.chapters a" | boxes: "div.lists", pick: "first"|"last"|"2", reverse: true,
//                 pages: { kind: "options"|"links"|"numbered", selector: "#pages option", attr: "value" },   the list runs over several pages
//                        (numbered: the selector finds the page links of a pagination bar, ?page=2 ... ?page=76, and every page up to the highest number is read)
//                 titleDrop: ".small, time",                                  parts of a chapter link that are not its title (the date)
//                 gap: 2000,                                                                       ms between those pages
//                 listUrl: { match: "^https://example\\.com/book/(\\d+)", to: "https://example.com/list/$1" } }   the list page from any address of the novel
//     book      { title, author, description, cover, genre }      where a book's page says what the book is (selectors)
//     nav       { next, prev }                                    the links to the next and previous chapter on a chapter's page (selectors)
//   }
(function (root) {
  const KEY = "userRules";
  const JUNK = "script, style, ins, iframe";
  const BOOK_FIELDS = ["title", "author", "description", "cover", "genre"];
  const CHARSETS = ["utf-8", "gbk", "gb18030", "big5", "shift_jis", "euc-jp", "euc-kr", "windows-1251", "windows-1252", "iso-8859-1"];
  const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  const MAX_SELECTOR = 500;

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
  // else null.
  function listUrlRule(listPage, chapterHref) {
    let page = null;
    let chapter = null;
    try {
      page = new URL(listPage);
      chapter = new URL(chapterHref, listPage);
    } catch (e) {
      return null;
    }
    const bare = (h) => h.replace(/^www\./, "");
    if (page.protocol !== "https:" || bare(chapter.hostname) !== bare(page.hostname)) return null;
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
      const to = page.origin + "/" + pageParts.slice(0, ti).concat("$1", pageParts.slice(ti + 1)).join("/") + (page.pathname.endsWith("/") ? "/" : "");
      let back = "";
      try {
        const m = new RegExp(match).exec(chapter.href);
        back = m ? expand(to, m, chapter.href) : "";
      } catch (e) {
        back = "";
      }
      if (back && back.split(/[?#]/)[0] === page.origin + page.pathname) return { match, to };
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

    const selector = selectorField("selector", raw.selector, !base);
    if (selector) spec.selector = selector;
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
      const list = selectorField("toc.list", t.list, false);
      const boxes = selectorField("toc.boxes", t.boxes, false);
      if (list) toc.list = list;
      else if (boxes) {
        toc.boxes = boxes;
        const pick = str(t.pick).toLowerCase() || "first";
        if (pick === "first" || pick === "last" || /^\d{1,3}$/.test(pick)) toc.pick = pick;
        else bad("toc.pick", 'Use "first", "last" or a number.');
      } else if (str(t.list) === "" && str(t.boxes) === "") bad("toc.list", "The chapter list needs the links' selector, like ul.chapters a.");
      if (t.reverse) toc.reverse = true;
      const titleDrop = selectorField("toc.titleDrop", t.titleDrop, false);
      if (titleDrop) toc.titleDrop = titleDrop;
      if (t.pages && typeof t.pages === "object" && str(t.pages.selector)) {
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
      if (Object.keys(toc).length) spec.toc = toc;
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

  // A validated spec -> the rule the engine runs (raw-sources.js). Everything it can make the extension fetch stays on the rule's site. `base`: the
  // site's built-in rule: what the spec leaves out is kept, its junk is added to, and its book selectors are merged with the spec's.
  function toRule(spec, base) {
    const host = spec.host;
    const own = {};
    if (spec.selector) own.selector = spec.selector;
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
      if (t.boxes) {
        toc.boxes = t.boxes;
        toc.pick = t.pick || "first";
      }
      if (typeof t.reverse === "boolean") toc.reverse = t.reverse;
      if (t.gap) toc.gap = t.gap;
      if (t.pages) {
        const { kind, selector, attr } = t.pages;
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
      }
      own.toc = toc;
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
    const spec = { ...entry.spec, host };
    if (Object.keys(book).length) spec.book = book; // (no empty book part is made when nothing about the book was found)
    next[host] = { ...entry, spec, enabled: true, updatedAt: now || Date.now() };
    return next;
  }

  // The saved rules with what was found on a page set for `host`: { book: { title, ... }, toc: { list, reverse }, nav: { next, prev } } (any part may be missing).
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
    if (f.toc && typeof f.toc.list === "string" && f.toc.list.trim()) {
      const toc = { ...(spec.toc || {}) };
      delete toc.boxes; // (a list found by its links replaces a list read from a box)
      delete toc.pick;
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
      spec.toc = toc;
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

  const api = { KEY, JUNK, BOOK_FIELDS, CHARSETS, cleanHost, baseFor, pagerOf, listUrlRule, validate, toRule, compile, bookTable, withBookSelectors, withDetected, apply, current: () => lastStored, start, sameSite, expand, ready: Promise.resolve() };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.UserRules = api;
  if (root.__USER_RULES__) apply(root.__USER_RULES__); // a script injected into a tab is handed the rules before it runs
})(typeof globalThis !== "undefined" ? globalThis : this);
