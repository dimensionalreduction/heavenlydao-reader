// The popup: a header with the novel and chapter of the page in front of you, and two tabs (docs/ADD-BOOK.md, the design's PopupScreen):
//   Novel    a book's page: what was read from it (cover, title, author, chapters, text or pictures), Import to library or Detect with AI; one in your library: Open in
//            library, Refresh details, Refresh chapters. A chapter's page: Translate and Listen in the page, nothing kept (a comic's: its pictures made again, comic-host.js)
//   Library  your library: its numbers, the pictures kept
// Fetching, translating and the notes on terms are done on the library site (its reader and novel pages), and so are the Gemini key, model and prompts
// (Settings › Translation): the key is handed to this extension by the library's page in this browser (site-bridge.js "access").
(async function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  const GENERIC_SELECTORS = ["article", "main", "#content", ".content", ".chapter-content", ".read-content", ".readcontent", "#chaptercontent"];
  const RAW_TEXT_VAR_CANDIDATES = ["txt_content"];
  const MIN_CONTENT_LENGTH = 200;
  const $ = (id) => document.getElementById(id);

  // ---------- tabs (the one last open is opened again) ----------
  const tabButtons = [...document.querySelectorAll(".tabs button")];
  function showPane(name) {
    for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.pane === name));
    for (const p of document.querySelectorAll(".pane")) p.hidden = p.id !== "pane-" + name;
    try { localStorage.setItem("popupPane", name); } catch (e) { /* (a private window) */ }
  }
  for (const b of tabButtons) b.onclick = () => showPane(b.dataset.pane);
  try { const last = localStorage.getItem("popupPane"); if (last && $("pane-" + last)) showPane(last); } catch (e) { /* (none kept) */ }

  // the page in front of you; popup.html?tab=<id> names another (the tests open the popup as a tab of its own, over a book's or a chapter's page)
  const named = Number(new URLSearchParams(location.search).get("tab"));
  const [tab] = named ? [await ext.tabs.get(named).catch(() => null)] : await ext.tabs.query({ active: true, currentWindow: true });
  const onPage = !!(tab && /^https?:/.test(tab.url || ""));

  // ---------- helpers ----------
  // A title the page or the site gives (often in the source language, not English), in English as the library's setting says (Google Translate,
  // Gemini, or both: the background's translateByMode). Best-effort only: falls back to the original text on any error.
  async function googleTranslate(text) {
    if (!text) return text;
    try {
      const r = await ext.runtime.sendMessage({ type: "translateTitle", text });
      return (r && r.text) || text;
    } catch (e) {
      return text;
    }
  }
  async function runInTab(files, func, args) {
    if (ext.scripting) {
      if (files) await ext.scripting.executeScript({ target: { tabId: tab.id }, files });
      const [{ result }] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func, args: args || [] });
      return result;
    }
    if (files) for (const f of files) await ext.tabs.executeScript(tab.id, { file: f });
    const results = await ext.tabs.executeScript(tab.id, { code: "(" + func.toString() + ")(" + (args || []).map((a) => JSON.stringify(a)).join(",") + ")" });
    return results[0];
  }
  async function detectRawVarPresent() {
    if (ext.scripting) {
      const [{ result }] = await ext.scripting.executeScript({
        target: { tabId: tab.id }, world: "MAIN",
        func: (candidates) => candidates.some((n) => typeof window[n] === "string" && window[n].trim().length > 0),
        args: [RAW_TEXT_VAR_CANDIDATES]
      });
      return result;
    }
    // Firefox: content scripts can't see page-added globals via plain `window` (Xray vision), so wrappedJSObject reaches the page's real global.
    const results = await ext.tabs.executeScript(tab.id, {
      code: "(() => { const w = window.wrappedJSObject; if (!w) return false; const candidates = " + JSON.stringify(RAW_TEXT_VAR_CANDIDATES) +
        "; return candidates.some((n) => { try { return typeof w[n] === 'string' && w[n].trim().length > 0; } catch (e) { return false; } }); })()"
    });
    return results[0];
  }
  async function getBucket(key) {
    return (await ext.storage.local.get(key))[key] || {};
  }
  async function setInBucket(key, entryKey, value) {
    const updated = { ...(await getBucket(key)) };
    if (value) updated[entryKey] = value;
    else delete updated[entryKey];
    await ext.storage.local.set({ [key]: updated });
  }
  function makeEditable(displayEl, onSave) {
    return () => {
      const input = Object.assign(document.createElement("input"), { className: "edit-input", value: displayEl.textContent });
      displayEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        if (commit) {
          const value = input.value.trim();
          displayEl.textContent = value || displayEl.textContent;
          await onSave(value);
        }
        input.replaceWith(displayEl);
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
    };
  }
  const picker = (field) => async () => {
    await ext.runtime.sendMessage({ type: "startPicker", tabId: tab.id, field });
    window.close();
  };
  // The page that runs the sync and the library (Chrome: an offscreen document, woken first; Firefox: the background page).
  async function host(type, data) {
    await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {});
    const r = await ext.runtime.sendMessage({ target: "p2p-host", type, ...data });
    if (!r) throw new Error("the extension did not answer");
    if (r.error) throw new Error(r.error);
    return r;
  }

  // The rules (built-in, and the person's own on top) as the engine sees them, for the Novel tab.
  UserRules.apply((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {});
  const rule = onPage ? RawSources.ruleFor(tab.url) : null;
  const hostname = onPage ? new URL(tab.url).hostname.replace(/^www\./, "") : "";
  // (set up before the slower parts below: a click is answered as soon as the popup is there)
  // Detect with AI asks Gemini with the key the library's page handed over (profileKeys, by Google's address), or one typed here before the popup had no place for it
  // ... or the OpenRouter key, or the tickets, the same page handed over (profile-translate.js ask)
  const hasGeminiKey = async () => {
    const { profileKeys, geminiApiKey, playgroundToken } = await ext.storage.local.get(["profileKeys", "geminiApiKey", "playgroundToken"]);
    return !!((profileKeys && (profileKeys[GEMINI_KEY_BASE] || profileKeys["https://openrouter.ai/api/v1"])) || geminiApiKey || playgroundToken);
  };
  let keyHere = false; // (known before a click: the browser's question below has to come first in it)
  const showKeyNote = async () => { keyHere = await hasGeminiKey(); $("geminiNote").hidden = keyHere; };
  showKeyNote();
  ext.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.profileKeys || changes.geminiApiKey || changes.playgroundToken)) showKeyNote(); });
  // Detect with AI (a book's page, new or already in the library). With no Gemini key it is not refused: the chapter list is found by looking at the page (book-detect.js
  // guessPicks), which is what a book that was imported with no list needs.
  const detectNow = async () => {
    const local = !keyHere; // (known already: nothing is waited for before the browser's question below)
    $("detInfo").textContent = local ? "Detecting with no key or tickets: looking for the chapter list and the details…" : "Detecting…";
    $("detectBtn").disabled = true;
    $("detectHaveBtn").disabled = true;
    // what is found is saved as this site's rule, and a rule does nothing until the browser lets the extension read the site. Asked first, before anything
    // is waited for: Firefox asks only straight from the click (after an await it refuses, even a site already allowed).
    const granted = SiteAccess.ALWAYS.test(hostname) ? true : await ext.permissions.request({ origins: ["https://*." + hostname + "/*"] }).catch(() => false); // (this computer's sites need no question)
    if (!granted) {
      $("detInfo").textContent = "Not run: the browser did not give permission to read " + hostname + ", and what is found there would not be used.";
      $("detectBtn").disabled = false;
      $("detectHaveBtn").disabled = false;
      return;
    }
    const r = await ext.runtime.sendMessage({ type: "startDetect", tabId: tab.id, local }).catch((err) => ({ error: err.message }));
    if (r && r.error) {
      $("detInfo").textContent = "Not run: " + r.error;
      $("detectBtn").disabled = false;
      $("detectHaveBtn").disabled = false;
      return;
    }
    window.close();
  };
  $("detectBtn").onclick = detectNow;
  $("detectHaveBtn").onclick = detectNow;

  // ---------- sites to allow ----------
  // No novel site is allowed at install: the browser's own question is asked here, by a click, the first time a site is needed (site-access.js). The bar lists the page's
  // site, when it is one the extension reads and is not allowed yet, and the sites something already asked for (a watch, the library site).
  const accessBar = $("accessBar");
  async function renderAccess() {
    const wanted = new Map(); // permission pattern -> host
    for (const p of await SiteAccess.pending(ext)) wanted.set(p.pattern, p.host);
    if (onPage && (rule || hostname === "wtr-lab.com") && !(await SiteAccess.has(tab.url, ext))) {
      wanted.set(SiteAccess.patternOf(tab.url), hostname.toLowerCase());
    }
    accessBar.replaceChildren();
    accessBar.hidden = !wanted.size;
    for (const [pattern, host] of wanted) {
      const row = document.createElement("div");
      row.className = "label-row";
      row.style.margin = "4px 0";
      const name = Object.assign(document.createElement("span"), { className: "title", textContent: host });
      const allow = Object.assign(document.createElement("button"), { className: "btn-primary", textContent: "Allow" });
      allow.onclick = async () => {
        allow.disabled = true;
        const given = await SiteAccess.request([pattern], ext);
        // allowed: the page is loaded again, so the extension's part of it runs there (the page was opened, and the popup read it, without it); the popup closes with it
        if (given && onPage) { await ext.tabs.reload(tab.id).catch(() => {}); window.close(); return; }
        renderAccess();
        allow.disabled = false;
      };
      row.append(name, allow);
      accessBar.append(row);
    }
  }
  await renderAccess();

  ext.runtime.sendMessage({ type: "glossary:pull" }).catch(() => {}); // (brought up to date whenever the popup opens)

  // ---------- Library: its numbers ----------
  {
    const statsEl = $("libStats");
    const row = (k, v) => { const r = document.createElement("div"); r.className = "stat"; r.append(Object.assign(document.createElement("span"), { textContent: k }), Object.assign(document.createElement("b"), { textContent: v })); return r; };
    const size = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + " GB" : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");
    const lib = async (op, ...args) => {
      await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {});
      const r = await ext.runtime.sendMessage({ target: "lib", op, args });
      if (!r || r.error) throw new Error((r && r.error) || "no answer");
      return r.result;
    };
    let novels = null;
    lib("api", "GET", "/api/novels?fields=card").then((r) => { novels = (r && r.novels) || []; draw(); }, () => { novels = []; draw(); });
    let used = null;
    if (ext.storage.local.getBytesInUse) Promise.resolve(ext.storage.local.getBytesInUse(null)).then((n) => { used = n; draw(); }, () => {});
    async function draw() {
      const p = await Promise.resolve(ext.runtime.sendMessage({ type: "p2p:status" })).catch(() => null);
      const rows = [];
      if (novels) rows.push(row("Novels", String(novels.length)));
      if (p) rows.push(row("Chapters here", String(p.indexed || 0) + (p.queued ? " · " + p.queued + " downloading" : "")));
      if (used !== null) rows.push(row("Stored here", size(used)));
      statsEl.replaceChildren(...rows);
      if (!rows.length) statsEl.textContent = "Not reachable just now.";
    }
    draw();
    setInterval(draw, 3000);
  }

  // ---------- the page: nothing more without one ----------
  const novelNameEl = $("novelName");
  const pageTitleEl = $("pageTitle");
  const pageNote = $("pageNote");
  const chTitleEl = $("chTitle");
  if (!onPage) {
    novelNameEl.textContent = pageTitleEl.textContent = "Not read";
    pageNote.textContent = "Open a novel's page or one of its chapters.";
    $("siteRuleBtn").hidden = true;
    return;
  }

  // The page where the person adds a rule of their own for this site (it opens with the site's address filled in).
  $("siteRuleBtn").onclick = () => {
    ext.tabs.create({ url: ext.runtime.getURL("rules.html") + "?url=" + encodeURIComponent(tab.url) });
    window.close();
  };
  // ---------- header: the novel's name ----------
  // Mirrors content.js's resolveNovelName() fallback chain (an element picked for the site first).
  function novelNameProber(selector) {
    if (selector) {
      try {
        const node = document.querySelector(selector);
        if (node && node.innerText.trim()) return node.innerText.trim();
      } catch (e) {
        // a stale or invalid selector: the usual places
      }
    }
    const og = document.querySelector('meta[property="og:novel:book_name"]')?.content || document.querySelector('meta[property="og:title"]')?.content;
    if (og && og.trim()) return og.trim();
    const h1 = document.querySelector("h1");
    if (h1 && h1.innerText.trim()) return h1.innerText.trim();
    return document.title.replace(/[-–—:|]?\s*(chapter|ch\.?|第)\s*\d+[^-–—|]*$/i, "").trim() || location.hostname.replace(/^www\./, "");
  }
  const novelOverrides = await getBucket("novelOverrides");
  const novelSelectors = await getBucket("novelSelectors");
  let novelNameRaw;
  if (novelOverrides[hostname]) {
    novelNameRaw = novelOverrides[hostname];
    novelNameEl.textContent = novelNameRaw; // typed by the person: shown as it is
  } else {
    novelNameRaw = await runInTab(null, novelNameProber, [novelSelectors[hostname] || null]).catch(() => hostname);
    novelNameEl.textContent = novelNameRaw;
    googleTranslate(novelNameRaw).then((t) => { novelNameEl.textContent = t; });
  }

  // ---------- header: the chapter's title ----------
  const pageInfo = await runInTab(null, () => ({ title: document.title })).catch(() => null);
  const titleOverrides = await getBucket("titleOverrides");
  const titleSelectors = await getBucket("titleSelectors");
  let pageTitleRaw = pageInfo ? pageInfo.title : "(untitled)";
  if (titleOverrides[tab.url]) {
    pageTitleRaw = titleOverrides[tab.url];
    pageTitleEl.textContent = pageTitleRaw;
  } else {
    if (titleSelectors[hostname]) {
      const custom = await runInTab(null, (sel) => { const node = document.querySelector(sel); return node ? node.innerText.trim() : null; }, [titleSelectors[hostname]]).catch(() => null);
      if (custom) pageTitleRaw = custom;
    }
    pageTitleEl.textContent = pageTitleRaw || "(untitled)";
    googleTranslate(pageTitleRaw).then((t) => { pageTitleEl.textContent = t; chTitleEl.textContent = t; });
  }

  // ---------- Novel: what the page is ----------
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  // (a site with only the book's parts saved, from "Detect with AI" on its book's page, has no chapter rule: its saved parts are used the same)
  const saved = Object.values((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {}).find((e) => e && e.enabled !== false && e.spec && UserRules.cleanHost(e.spec.host) === hostname);
  const partsRule = rule || (saved && (saved.spec.book || saved.spec.toc) ? { book: saved.spec.book, toc: saved.spec.toc } : null);
  const book = (partsRule && partsRule.book) || {};
  const toc = (partsRule && partsRule.toc) || {};
  const contentSelectors = await getBucket("contentSelectors");
  const comicSite = !!(rule && (rule.images || rule.pictures || rule.scriptPictures));
  const sel = {
    title: str(book.title), titleDrop: str(book.titleDrop), author: str(book.author), description: str(book.description), cover: str(book.cover),
    list: str(toc.list) || str(saved && saved.spec.toc && saved.spec.toc.list), listBuiltIn: !!(toc.list || toc.boxes || toc.parse) && !str(toc.list) && !(saved && saved.spec.toc && str(saved.spec.toc.list)) && !str(toc.gallery),
    gallery: str(toc.gallery) || str(saved && saved.spec.toc && saved.spec.toc.gallery), // (a book of one chapter, a picture on each of its pages: the links to them)
    content: str(contentSelectors[hostname]) || str(rule && rule.selector), images: str(rule && rule.images)
  };
  // Run in the page: each part of a book (the rule's selector, else the standard novel metadata many sites carry), the chapter's text, and its pictures
  // (the rule's, else the page's own list of them, else large pictures one under another: a comic's chapter)
  const probe = (s, generic, minLen) => {
    const pick = (q) => { try { return q ? document.querySelector(q) : null; } catch (e) { return null; } };
    const text = (n) => (n ? (n.innerText || n.textContent || "").trim().replace(/\s+/g, " ") : "");
    const meta = (p) => (document.querySelector('meta[property="' + p + '"]') || {}).content || "";
    const part = (q, metaName, drop) => {
      let n = pick(q);
      if (n && drop) { try { n = n.cloneNode(true); n.querySelectorAll(drop).forEach((x) => x.remove()); } catch (e) { /* a bad selector: the whole */ } } // (a badge in the title)
      if (n) return { found: true, text: text(n).slice(0, 160) };
      const m = metaName && meta(metaName);
      return m ? { found: true, text: m.trim().slice(0, 160) } : { found: false };
    };
    const coverNode = pick(s.cover);
    const coverImg = coverNode && (coverNode.tagName === "IMG" ? coverNode : coverNode.querySelector("img"));
    // what the page says of its book in the web's standard data (a schema.org Book in its JSON-LD, og:type book: book-capture.js standardBook), where the rule
    // and the og:novel tags say nothing (a site's selector out of date, as novelfull.net's title; a site with no rule)
    const standard = window.BookCapture && window.BookCapture.standardBook ? window.BookCapture.standardBook(document) : null;
    const orStandard = (r, key) => (r.found || !standard || !standard[key] ? r : { found: true, text: String(standard[key]).replace(/\s+/g, " ").trim().slice(0, 160) });
    const coverUrl = coverImg ? coverImg.currentSrc || coverImg.getAttribute("data-src") || coverImg.src : meta("og:image") || (standard && standard.cover) || "";
    let list = 0;
    if (s.list) { try { list = document.querySelectorAll(s.list).length; } catch (e) { /* a bad selector */ } }
    let gallery = 0; // (the pages of a book of one chapter: each address once)
    if (s.gallery) { try { gallery = new Set([...document.querySelectorAll(s.gallery)].map((a) => a.href.split("#")[0])).size; } catch (e) { /* a bad selector */ } }
    // links that hold a picture and lead to this page's own address with a number after it, 1, 2, 3...: a book of one chapter (a gallery) whose pages they are, not a
    // page of a reader with one picture on it (its cover); what book-detect.js galleryOf finds
    let galleryHere = 0;
    try {
      const root = location.pathname.replace(/\/+$/, "") + "/";
      const nums = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        if (!a.querySelector("img")) continue;
        const u = new URL(a.href, location.href);
        const m = u.origin === location.origin && u.pathname.startsWith(root) ? /^(\d{1,4})\/?$/.exec(u.pathname.slice(root.length)) : null;
        if (m) nums.add(Number(m[1]));
      }
      while (nums.has(galleryHere + 1)) galleryHere++;
      if (galleryHere < 3) galleryHere = 0;
    } catch (e) { /* none */ }
    let content = "";
    // a box's text when it can be a chapter's: long enough, and not mostly the text of links (a book's page with its list, a menu: a site with no rule, its
    // book's page in a <main>, was taken for a chapter, and Detect was not shown)
    const prose = (n) => {
      const t = n ? text(n) : "";
      if (t.length < minLen) return "";
      const inLinks = [...n.querySelectorAll("a")].reduce((sum, a) => sum + text(a).length, 0);
      return inLinks > t.length / 2 ? "" : t;
    };
    const ruleText = !!prose(pick(s.content)); // (the site's own rule finds a chapter's text here)
    if (ruleText) content = prose(pick(s.content));
    else {
      const mapped = (window.SITE_CONTENT_SELECTORS || {})[location.hostname.replace(/^www\./, "")];
      for (const q of [mapped].concat(generic)) { const t = prose(pick(q)); if (t) { content = t; break; } }
    }
    let pictures = [];
    let lone = [];
    try {
      // a chapter this extension has translated in its page: its pictures are the ones made now (blob: addresses, the lazy-loading attributes taken off), so the addresses
      // it was given are the chapter's pictures
      // (the rule's selector, the page's own list, else large pictures one under another: ImageChapter.livePictures)
      const given = window.__p2preadComicPage && (window.__p2preadComicPage.urlsHere ? window.__p2preadComicPage.urlsHere() : window.__P2PREAD_COMIC_URLS__);
      if (Array.isArray(given) && given.length) { pictures = given.slice(); if (pictures.length < 3) lone = given.slice(); } // (one or two: a page of a reader, as found the first time)
      else ({ pictures, lone } = ImageChapter.livePictures(document, s.images, location.href, content.length));
    } catch (e) { /* none */ }
    // a link to the novel's own page (its details and list), from a chapter's page
    let bookLink = "";
    for (const a of document.querySelectorAll("a[href]")) {
      if (/^(返回书页|返回書頁|书页|書頁|目录|目錄|章节目录|章節目錄|Table of Contents|Index|Novel Info|Book Info|Series|All chapters)$/i.test(text(a))) { bookLink = a.href; break; }
    }
    const cjk = (content.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    // the list runs over more pages than this one: links to this same page with a page number (?pg=2 ... ?pg=22): the highest number there is
    let listPages = 0;
    try {
      for (const a of document.querySelectorAll("a[href]")) {
        const u = new URL(a.href, location.href);
        if (u.origin !== location.origin || u.pathname !== location.pathname) continue;
        for (const k of ["pg", "page", "paged", "p"]) { const v = u.searchParams.get(k); if (v && /^\d{1,4}$/.test(v)) listPages = Math.max(listPages, Number(v)); }
      }
    } catch (e) { /* none */ }
    return {
      title: orStandard(part(s.title, "og:novel:book_name", s.titleDrop), "title"), heading: window.BookCapture && window.BookCapture.headingTitle ? window.BookCapture.headingTitle(document).slice(0, 160) : "", author: orStandard(part(s.author, "og:novel:author"), "author"), description: part(s.description, "og:description").found ? part(s.description, "og:description") : orStandard(((d) => (d.length >= 30 ? { found: true, text: d.slice(0, 160) } : { found: false }))(((document.querySelector('meta[name="description"]') || {}).content || "").trim()), "description"),
      cover: coverUrl ? { found: true, url: coverUrl } : { found: false }, list, gallery, galleryHere, contentChars: content.length, words: cjk > content.length / 3 ? cjk : content.split(/\s+/).filter(Boolean).length,
      pictures, lone, bookLink, readUrl: meta("og:novel:read_url"), listPages, ruleText
    };
  };
  const found = await runInTab(["site-selectors.js", "image-chapter.js", "book-capture.js"], probe, [sel, GENERIC_SELECTORS, MIN_CONTENT_LENGTH]).catch(() => null);
  const rawVar = await detectRawVarPresent().catch(() => false);
  if (!found) {
    pageNote.textContent = "This page can't be looked at (the browser keeps the extension out of it).";
    return;
  }
  if (rawVar) found.contentChars = Math.max(found.contentChars, MIN_CONTENT_LENGTH);
  // A site novel's own page (wtr-lab.com/<lang>/novel/<id>/<slug>) has no rule: what it is comes from the page's own data, as the site's capture reads it (wtr-capture.js),
  // and Import to library reads its details and its list through the site's data (p2p-host.js wtrDetails, wtrChapterList)
  const wtrNovel = hostname === "wtr-lab.com" && /^https:\/\/wtr-lab\.com\/[a-z-]+\/novel\/\d+\/[^/?#]+\/?(?:[?#]|$)/.test(tab.url) ? WtrTerms.parseWtrUrl(tab.url) : null;
  if (wtrNovel) {
    const data = await runInTab(null, async (rawId) => {
      const pick = (j) => {
        const s = j && j.pageProps && j.pageProps.serie && j.pageProps.serie.serie_data;
        return s && s.data && String(s.raw_id) === rawId ? { title: s.data.title, author: s.data.author, cover: s.data.image, description: s.data.description, count: s.chapter_count } : null;
      };
      let next = null;
      try { next = JSON.parse(document.getElementById("__NEXT_DATA__").textContent); } catch (e) { return null; }
      const here = pick(next.props);
      if (here) return here;
      // (a page reached inside the site, with no reload, keeps the data of the first one: this page's is the site's data file for it)
      try {
        const [, lang, id, slug] = /^\/([^/]+)\/novel\/(\d+)\/([^/?#]+)/.exec(location.pathname);
        // (the whole address: Firefox's injected scripts fetch as the extension, where a bare "/_next/..." is not a valid URL)
        const res = await fetch(location.origin + "/_next/data/" + next.buildId + "/" + lang + "/novel/" + id + "/" + slug + ".json?locale=" + lang + "&raw_id=" + id + "&serie_slug=" + slug, { credentials: "same-origin" });
        return pick(await res.json());
      } catch (e) { return null; }
    }, [wtrNovel.rawId]).catch(() => null);
    if (data && data.title) {
      const plain = (t) => WtrTerms.cleanDescription(t).replace(/\s+/g, " ").trim().slice(0, 160);
      found.title = { found: true, text: plain(data.title) };
      found.author = data.author ? { found: true, text: plain(data.author) } : { found: false };
      found.description = data.description ? { found: true, text: plain(data.description) } : found.description;
      if (data.cover) found.cover = { found: true, url: data.cover };
      found.list = Number(data.count) || 0;
      found.contentChars = 0;
      found.pictures = [];
      found.lone = [];
    }
  }
  // A comic whose script draws its pictures from a list in the page, a few at a time as the strip is scrolled (mh160mh.com): the whole list, from the page's own scripts,
  // when it names the pictures shown (UserRules.scriptPicturesFor), on the server this page shows them from (the site's script picks one each time)
  const shownNow = found.pictures.length ? found.pictures : found.lone;
  if (shownNow.length && !found.galleryHere) {
    const scripts = await runInTab(null, () => [...document.scripts].filter((s) => !s.src).map((s) => "<script>" + s.textContent + "</script>").join("\n").slice(0, 4000000), []).catch(() => "");
    const listed = scripts ? UserRules.scriptPicturesFor(scripts, shownNow, tab.url) : null;
    if (listed && listed.count > shownNow.length) found.pictures = UserRules.picturesInScript(scripts, listed.scriptPictures, tab.url);
  }
  // the chapters a site's rule reads in code (a list a script of the page holds as data: royalroad.com's window.chapters), counted on this page as it is now; 0 when the
  // list is on another page (the rule reads it there)
  if (sel.listBuiltIn && !found.list) {
    const listRule = RawSources.tocFor(tab.url);
    if (listRule && typeof listRule.rule.toc.list === "function" && typeof listRule.rule.toc.parse !== "function") {
      const html = await runInTab(null, () => document.documentElement.outerHTML).catch(() => "");
      try {
        if (html) found.list = RawSources.tocChapters(new DOMParser().parseFromString(RawSources.stripScripts(html), "text/html"), { rule: listRule.rule, url: tab.url }, html).length;
      } catch (e) { /* the page is not the list */ }
    }
  }
  // the list a rule reads is on a page of its own (novelfire.net's <book>/chapters): none of its chapters are on this page, and that is not a list missing
  const listElsewhere = (() => {
    const at = (sel.list || sel.listBuiltIn) && RawSources.tocFor(tab.url);
    if (!at || !at.url) return false;
    const page = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); } catch (e) { return u; } };
    return page(at.url) !== page(tab.url);
  })();
  // (what the page is goes by what is on it: a rule that can read the site's list says nothing of this page, whose chapters are not here; and a chapter's page may name
  // its book's author, cover and a description too (royalroad.com's): where the site's rule finds a chapter's text and not the book's title, it is a chapter)
  const listHere = found.list > 0 || found.gallery > 0 || !!found.readUrl;
  const bookParts = [found.title, found.cover, found.author, found.description].filter((x) => x.found).length;
  const bookPage = (listHere && bookParts >= 2) || (bookParts >= 3 && (found.title.found || !found.ruleText));
  // a book's page whose title nothing names (no title selector, no metadata: the built-in Madara-theme sites, wuxiaworld.site): its h1, as the page's own title carries
  // it (BookCapture.headingTitle; only once the page is a book's by its other parts: a chapter's h1 is carried by its page's title too)
  if (bookPage && !found.title.found && found.heading) found.title = { found: true, text: found.heading };
  // a page of one big picture and no text is a picture chapter too (the translator reads that one picture); on a book's page that picture is its cover
  const lonePage = !found.galleryHere && !bookPage && found.pictures.length < 3 && found.contentChars < MIN_CONTENT_LENGTH && found.lone.length >= 1;
  if (lonePage) found.pictures = found.lone;
  let comic = comicSite || found.pictures.length >= 3 || lonePage;
  // the person can say otherwise (foot of the tab): what the page looks like only picks which view opens first
  const looksChapter = !found.galleryHere && (found.contentChars >= MIN_CONTENT_LENGTH || found.pictures.length >= 3 || lonePage || (comicSite && found.pictures.length > 0)) && !bookPage;
  // What the page is, as the person says (the switch at the top: Details, Text, Pictures); what it looks like only picks the one that opens first
  const kindSeg = $("kindSeg");
  // The pictures on a page that none were found on by the page's own list or its large pictures one under another: every picture laid out wide enough to be a page of a comic
  let loosePictures = null;
  const findPictures = async () => {
    if (found.pictures.length) return;
    if (!loosePictures) {
      loosePictures = await runInTab(["image-chapter.js"], () => {
        const urls = [];
        for (const im of document.images) {
          const r = im.getBoundingClientRect();
          if (r.width < 200 || r.height < 120 || im.closest("header, nav, footer")) continue;
          const u = ImageChapter.imgUrl(im, location.href) || (im.currentSrc && /^https:/.test(im.currentSrc) ? im.currentSrc : "");
          if (u && !urls.includes(u)) urls.push(u);
        }
        return urls.slice(0, 300);
      }).catch(() => []);
    }
    found.pictures = loosePictures || [];
  };
  const showKind = async (kind) => {
    pageNote.hidden = true;
    kindSeg.hidden = false;
    for (const b of kindSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    if (kind === "pictures") await findPictures();
    if (kind !== "book") comic = kind === "pictures";
    $("bookView").hidden = kind !== "book";
    $("importView").hidden = true;
    $("chapterView").hidden = kind === "book";
    if (kind === "book") drawBook(); else drawChapter();
  };
  for (const b of kindSeg.querySelectorAll("button")) b.onclick = () => showKind(b.dataset.kind);

  // ---------- the library: is the book in it, and where ----------
  const libCall = async (op, ...args) => {
    await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {});
    const r = await ext.runtime.sendMessage({ target: "lib", op, args });
    if (!r || r.error) throw new Error((r && r.error) || "no answer");
    return r.result;
  };
  // the library site (where site-bridge.js runs): Open in library searches it for the book
  const siteBase = (((ext.runtime.getManifest().content_scripts || []).find((c) => (c.js || []).includes("site-bridge.js")) || { matches: [] }).matches
    .map((m) => m.replace(/\*$/, "")).find((m) => m.startsWith("https://heavenlydao.com/")) || "https://heavenlydao.com/");
  const openInLibrary = (title) => { ext.tabs.create({ url: siteBase + "#/search/" + encodeURIComponent(title || "") }); window.close(); };
  const pageUrl = tab.url.split("#")[0];
  // (as book-capture.js names it: its site and path, and the query's book number when the path has none; a site novel by its id, as its capture saves it)
  const bookIdOf = (url) => { const w = new URL(url).hostname === "wtr-lab.com" && WtrTerms.parseWtrUrl(url); return w ? "wtr-lab:" + w.rawId : BookCapture.bookIdOf(url); };
  // The browser's question for a site, asked straight from the click (Firefox asks only then); a site allowed already goes on at once, whatever the question does
  const allowedNow = (url) => {
    const asked = SiteAccess.request([SiteAccess.patternOf(url)], ext);
    return Promise.race([asked, SiteAccess.has(url, ext).then((h) => h || asked)]).catch(() => false);
  };
  const inLibrary = async (url) => { const r = await libCall("api", "GET", "/api/novels?fields=card&ids=" + encodeURIComponent(bookIdOf(url))).catch(() => null); return ((r && r.novels) || [])[0] || null; };

  // ---------- a book's page ----------
  async function drawBook() {
    const parts = $("bkParts");
    const row = (label, r, big) => {
      const d = document.createElement("div");
      const k = Object.assign(document.createElement("span"), { className: "part-k" });
      k.append(Object.assign(document.createElement("span"), { className: "mk " + (r.found ? "ok" : "no"), textContent: r.found ? "✓" : "✗" }), label);
      d.append(k, Object.assign(document.createElement("span"), { className: "v" + (r.found ? (big ? " big" : "") : " no"), textContent: r.found ? r.text : "Not found" }));
      return d;
    };
    const chapters = found.gallery ? { found: true, text: "1 · " + found.gallery.toLocaleString() + " pictures" } : found.list ? { found: true, text: found.list.toLocaleString() + (found.listPages > 1 ? " · page 1 of " + found.listPages : "") } : listElsewhere || found.readUrl ? { found: true, text: "On the list page" } : sel.listBuiltIn ? { found: true, text: "Read by the site's rule" } : { found: false };
    const pictureBook = comic || found.gallery > 0 || found.galleryHere > 0;
    parts.replaceChildren(row("Title", found.title, true), row("Author", found.author), row("Chapters", chapters), row("Chapters are", { found: !!partsRule || pictureBook || !!wtrNovel, text: pictureBook ? "Pictures" : "Text" }));
    // a title that is not in English, put into English beside it: the name Import to library saves it under (each title is translated once and kept: the
    // background's translateTitle; book-capture.js asks the same for the book's title)
    const titleV = parts.querySelector(".v.big");
    if (titleV && found.title.found && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Devanagari}]/u.test(found.title.text)) {
      googleTranslate(found.title.text).then((en) => { if (en && en !== found.title.text) titleV.append(Object.assign(document.createElement("small"), { className: "muted", textContent: "  " + en })); });
    }
    const cover = $("bkCover");
    if (found.cover.found) { cover.style.backgroundImage = "url(" + JSON.stringify(found.cover.url) + ")"; cover.classList.add("has"); }
    $("bkCoverMark").textContent = (found.cover.found ? "✓ " : "✗ ") + "Cover";
    // (a list over several pages is not read whole from this page: Detect with AI finds its pagination, and reads every page)
    const low = !found.title.found || bookParts < 2 || found.listPages > 1;
    $("importBtn").className = low ? "" : "btn-primary";
    $("detectBtn").className = low ? "btn-primary" : "";
    $("importBtn").disabled = !found.title.found;
    $("importBtn").onclick = () => importBook();
    const have = await inLibrary(pageUrl);
    $("bkInLib").hidden = $("bkHave").hidden = !have;
    $("bkNew").hidden = !!have;
    if (have) {
      $("openLibBtn").onclick = () => openInLibrary(have.title);
      $("detailsBtn").onclick = () => refresh("details", pageUrl, have.title);
      $("chaptersBtn").onclick = () => refresh("list", have.listUrl || pageUrl, have.title);
    }
  }
  // Refresh details (the book's page read again) or Refresh chapters (its list read again), as the library's own buttons ask
  async function refresh(kind, url, title) {
    const btn = $(kind === "details" ? "detailsBtn" : "chaptersBtn"), note = $("detInfo");
    btn.disabled = true;
    const asked = allowedNow(url);
    try {
      if (!(await asked)) throw new Error(new URL(url).hostname + " is not allowed");
      note.textContent = kind === "details" ? "Reading the book's page…" : "Reading the chapter list…";
      await host("work", { key: "translation:" + url + "#" + kind, meta: { novelName: title || "" } });
      note.textContent = "Done";
    } catch (e) {
      note.textContent = "Couldn't refresh: " + e.message;
    }
    btn.disabled = false;
  }
  // Import to library: the book recorded from this tab (book-capture.js, the person said it is a book's page), then its chapter list read into the library
  async function importBook() {
    const asked = allowedNow(tab.url);
    $("bookView").hidden = true;
    kindSeg.hidden = true;
    $("importView").hidden = false;
    $("imTitle").textContent = found.title.text || novelNameEl.textContent;
    $("imAuthor").textContent = found.author.found ? found.author.text : "";
    if (found.cover.found) { $("imCover").style.backgroundImage = "url(" + JSON.stringify(found.cover.url) + ")"; $("imCover").classList.add("has"); }
    const steps = $("imSteps");
    const step = (label) => {
      const d = document.createElement("div");
      const top = Object.assign(document.createElement("div"), { className: "row" });
      const name = document.createElement("span"), side = Object.assign(document.createElement("span"), { className: "muted" });
      const bar = Object.assign(document.createElement("div"), { className: "bar" });
      bar.append(document.createElement("i"));
      top.append(name, side);
      d.append(top, bar);
      bar.style.marginTop = "6px";
      steps.append(d);
      const set = (state, note, part) => {
        name.replaceChildren(state === "run" ? Object.assign(document.createElement("span"), { className: "spin" }) : Object.assign(document.createElement("span"), { className: "mk " + (state === "ok" ? "ok" : "no"), textContent: state === "ok" ? "✓" : "✗" }), label);
        side.textContent = note || "";
        bar.firstChild.style.width = state === "run" ? Math.round((part || 0.15) * 100) + "%" : "100%";
        bar.classList.toggle("done", state === "ok");
      };
      set("wait");
      name.replaceChildren(label);
      return set;
    };
    steps.replaceChildren();
    const details = step("Details"), chapters = step("Chapters");
    try {
      if (!(await asked)) throw Object.assign(new Error(hostname + " is not allowed"), { at: details });
      details("run");
      if (wtrNovel) { // (the site's data: its details, then its whole list in one request)
        const meta = { novelName: found.title.text };
        await host("work", { key: "translation:" + pageUrl + "#details", meta }).catch((e) => { throw Object.assign(e, { at: details }); });
        details("ok", "Done");
        chapters("run", "Reading the list", 0.3);
        await host("work", { key: "translation:" + pageUrl + "#list", meta }).catch((e) => { throw Object.assign(e, { at: chapters }); });
        chapters("ok", "Done");
        $("imHead").textContent = "Imported";
        $("imInLib").hidden = false;
        $("imOpen").hidden = false;
        $("imOpen").onclick = () => openInLibrary(found.title.text);
        return;
      }
      const r = await ext.runtime.sendMessage({ type: "bookcapture:add", tabId: tab.id }).catch((e) => ({ saved: false, reason: e.message }));
      if (!r || !r.saved) throw Object.assign(new Error((r && r.reason) || "not recorded"), { at: details });
      details("ok", "Done");
      const info = r.info || {};
      $("imTitle").textContent = info.title || $("imTitle").textContent;
      const listUrl = info.listUrl || pageUrl;
      let hasRule = !!RawSources.tocFor(listUrl);
      // No rule for this site's list: it is found from the page itself (no Gemini: book-detect.js guessPicks) when the list is on this page, and saved as the site's rule
      if (!hasRule && listUrl.split("#")[0] === pageUrl) {
        chapters("run", "Finding the chapter list", 0.15);
        const started = await ext.runtime.sendMessage({ type: "startDetect", tabId: tab.id, local: true, book: true }).catch((e) => ({ error: e.message }));
        const ruleSaved = async () => Object.values((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {}).some((e) => e && e.enabled !== false && e.spec && UserRules.cleanHost(e.spec.host) === hostname && e.spec.toc && (e.spec.toc.list || e.spec.toc.json || e.spec.toc.gallery));
        for (let i = 0; started && !started.error && !hasRule && i < 60; i++) {
          await new Promise((ok) => setTimeout(ok, 750));
          hasRule = await ruleSaved();
        }
      }
      if (!hasRule) { chapters("no", "No chapter list found: Detect with AI"); }
      else {
        chapters("run", "Reading the list", 0.3);
        await host("work", { key: "translation:" + listUrl + "#list", meta: { novelName: info.title || "" } }).catch((e) => { throw Object.assign(e, { at: chapters }); });
        chapters("ok", "Done");
      }
      $("imHead").textContent = "Imported";
      $("imInLib").hidden = false;
      $("imOpen").hidden = false;
      $("imOpen").onclick = () => openInLibrary(info.title);
    } catch (e) {
      (e.at || details)("no", e.message);
    }
  }

  // ---------- a chapter's page: Translate and Listen, nothing kept ----------
  const PLAYGROUND = "https://playground.heavenlydao.com";
  const OPENROUTER = "https://openrouter.ai/api/v1";
  const TICKET_USD = 0.0005, COMIC_USD_A_PICTURE = 0.012, COMIC_READ_USD_A_PICTURE = 0.003; // (the second: reading alone, when no model draws: Lettered here first)
  const mk = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; };
  let chapterStatus = null;
  async function drawChapter() {
    chTitleEl.textContent = pageTitleEl.textContent;
    $("chWhat").textContent = comic ? "🖼 " + found.pictures.length + (found.pictures.length === 1 ? " picture" : " pictures") : "≡ Text · " + found.words.toLocaleString() + (found.words === 1 ? " word" : " words");
    const bookUrl = found.bookLink || found.readUrl;
    const chBook = $("chBook");
    chBook.hidden = !bookUrl;
    if (bookUrl) {
      chBook.replaceChildren(mk("span", { textContent: "📖 " + novelNameEl.textContent }), mk("span", { textContent: "›" }));
      chBook.onclick = (e) => { e.preventDefault(); ext.tabs.update(tab.id, { url: bookUrl }); window.close(); };
    }
    // who can pay: the keys and the sign-in the library's page in this browser handed over (profile-translate.js keeps them)
    const { profileKeys, playgroundToken, popupPay, listenVoice, modelRules, comicPrompts, translateAhead } = await ext.storage.local.get(["profileKeys", "playgroundToken", "popupPay", "listenVoice", "modelRules", "comicPrompts", "translateAhead"]);
    let aheadOn = translateAhead === true; // (Translate ahead: the next pages translated before they are opened, from the first Translate on: translate-ahead.js)
    Pay.useRules(modelRules || {}); // (the models the person's rules give: Settings › Model rules, handed over by the library's page)
    let voiceIs = listenVoice === "ai" ? "ai" : "browser";
    // how the page's Listen goes (comic-page.js "listen:status"): { state: "loading" | "playing" | "", error }
    let listenNow = { state: "", error: "" };
    const LISTEN_LABEL = { "": "▶  Listen", loading: "■  Stop · Loading…", playing: "■  Stop" };
    let savedAs = ""; // (the key it was kept under, once Save to library has done it)
    let saveError = "";
    let showLog = false; // (the errors of the last translation, under it)
    const keys = profileKeys || {};
    const token = String(playgroundToken || "");
    const has = { patron: !!token, ticketsLeft: null, keys: Object.keys(keys) };
    const hostOf = (a) => { try { return new URL(a).host; } catch (e) { return String(a); } };
    const payLabel = (c) => ({ tickets: "Tickets", device: "This device", free: "Free", openrouter: "OpenRouter key", gemini: "Gemini key", fish: "Fish Audio key" })[c.kind] || hostOf(c.pay);
    // a model's name from its id: google/gemini-3.5-flash-lite -> Gemini 3.5 Flash Lite, openai/gpt-image-2.5-flare -> GPT Image 2.5 Flare, hexgrad/kokoro-82m -> Kokoro 82M
    const nameOf = (id) => ({ "device/paddleocr-det": "Text finder", "device/lettering": "Lettered here", "google/translate": "Google Translate" })[id] || String(id).replace(/^[^/]*\//, "").replace(/:free$/, "").split("-")
      .map((w) => (/^(gpt|glm|flux|tts|ai|s\d[\d.]*)$/i.test(w) || /^\d+[a-z]$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
    // Who pays is the rules' (Settings › Model rules in the library, handed over by its page): for each job this page asks for, the first row that can be paid for; the
    // translators follow the same rows ("rules"). Each job with its model, who pays and about what it costs: this device's steps are free, a key's in dollars, tickets in tickets.
    // (Who speaks is not asked here: the library asks it with a chapter's translation.)
    const pay = "rules";
    const JOB_NAME = { translate: "Translation", comicFind: "Find text", comicRead: "Read", comicDraw: "Draw" };
    const USD_A_PICTURE = { comicFind: 0.002, comicRead: COMIC_READ_USD_A_PICTURE, comicDraw: COMIC_USD_A_PICTURE - COMIC_READ_USD_A_PICTURE }; // (a step on one picture, about)
    const noDevice = (c) => c.kind === "device";
    const jobs = () => {
      if (!comic) return [{ item: "translate", pair: Pay.best("translate", has, noDevice), usd: Math.max(1, (found.words * 5.5 + 500) * 0.0012) * TICKET_USD }];
      const n = found.pictures.length;
      return [
        { item: "comicFind", pair: Pay.best("comicFind", has), usd: n * USD_A_PICTURE.comicFind },
        { item: "comicRead", pair: Pay.best("comicRead", has, noDevice), usd: n * USD_A_PICTURE.comicRead },
        // (a model draws only when the rules put one before Lettered here)
        { item: "comicDraw", pair: Pay.drawMode().models ? Pay.best("comicDraw", has, noDevice) : Pay.best("comicDraw", has), usd: n * USD_A_PICTURE.comicDraw }
      ];
    };
    const free = (c) => c.kind === "device" || c.kind === "free" || /:free$/.test(c.rule || c.model || "");
    const priceOf = (j) => (!j.pair ? "" : free(j.pair) ? "Free" : j.pair.kind === "tickets" ? "about " + Math.max(1, Math.round(j.usd / TICKET_USD)).toLocaleString() + " tickets" : "about $" + (j.usd < 0.01 ? j.usd.toFixed(3) : j.usd.toFixed(2)));
    // what can be translated: a text chapter needs its translation paid for; a comic its reading (a drawing that cannot be paid for leaves its parts lettered here or listed)
    const payable = () => !!jobs().find((j) => j.item === (comic ? "comicRead" : "translate")).pair;
    let left = null;
    let signedSay = token ? "Signed in" : "Not signed in";
    // the sign-in kept here, as the playground sees it: one it no longer takes (signed out, expired) is forgotten, and an account with no tickets cannot pay with them
    const noTickets = (say) => {
      has.patron = false;
      signedSay = say;
    };
    if (token) fetch(PLAYGROUND + "/api/me", { headers: { Authorization: "Bearer " + token, "X-Playground": "1" } }).then((r) => r.json()).then((j) => {
      if (j && j.signedIn === false) { ext.storage.local.set({ playgroundToken: "" }); noTickets("Not signed in"); }
      else if (j && j.signedIn && !j.patron) { left = 0; noTickets("No tickets"); }
      else left = j && j.tickets ? j.tickets.left : null;
      paint();
    }, () => {});
    const tr = $("trBody"), ls = $("lsBody");
    // the whole of it, about: the tickets and the dollars added up
    const about = () => {
      const all = jobs().filter((j) => j.pair && !free(j.pair));
      const t = all.filter((j) => j.pair.kind === "tickets").reduce((n, j) => n + Math.max(1, Math.round(j.usd / TICKET_USD)), 0);
      const usd = all.filter((j) => j.pair.kind !== "tickets").reduce((n, j) => n + j.usd, 0);
      return [t ? t.toLocaleString() + " tickets" : "", usd ? "$" + (usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)) : ""].filter(Boolean).join(" + ").replace(/^(?=.)/, "about ") || "Free";
    };
    // each job of the rules this page asks for, with its model and who pays, and its price in front of it (Settings › Model rules in the library changes them)
    const payRows = () => {
      const rows = jobs().map((j) => mk("div", { className: "row job-row" },
        mk("span", { className: "k" }, JOB_NAME[j.item], mk("small", { textContent: j.pair ? nameOf(j.pair.rule || j.pair.model) + " · " + payLabel(j.pair) : "Nothing to pay with" })),
        mk("b", { className: "r", textContent: priceOf(j) })));
      if (jobs().some((j) => j.pair && j.pair.kind === "tickets") && left != null) rows.push(mk("div", { className: "row" }, mk("span", { className: "k muted", textContent: "Tickets · " + Math.floor(left).toLocaleString() + " left" })));
      return rows;
    };
    // Translate ahead: the switch (text and pictures). On, it starts with the first Translate (or now, when this page is translated already); off, it stops in every tab
    const textPay = () => pay;
    const startAhead = () => ext.runtime.sendMessage(comic ? { type: "ahead:start", tabId: tab.id, kind: "pictures", pay, images: sel.images } : { type: "ahead:start", tabId: tab.id, kind: "text", pay: textPay() }).catch(() => {});
    const pagePattern = () => (SiteAccess.ALWAYS.test(hostname) ? "" : SiteAccess.patternOf(tab.url)); // (the next pages are this site's: the tab is followed to them)
    const aheadRow = () => {
      const box = mk("input", { type: "checkbox", id: "aheadBox", checked: aheadOn });
      box.onchange = async () => {
        aheadOn = box.checked;
        // (asked first, from the click itself: Firefox asks only then)
        const asked = aheadOn && pagePattern() ? SiteAccess.request([pagePattern()], ext).catch(() => false) : null;
        ext.storage.local.set({ translateAhead: aheadOn });
        if (!aheadOn) { ext.runtime.sendMessage({ type: "ahead:stop" }).catch(() => {}); return; }
        await asked;
        const translated = comic ? !!(comicState && comicState.step === "done") : await runInTab(null, () => !!window.__P2PREAD_TRANSLATED__).catch(() => false);
        if (translated) startAhead();
      };
      box.style.cssText = "width:auto;margin:0;accent-color:var(--accent)";
      const row = mk("label", { className: "row" }, mk("span", { className: "k" }, "Translate ahead", mk("small", { textContent: "Next 2 pages" })), box);
      row.style.cursor = "pointer";
      return row;
    };
    const noPay = () => {
      $("trHead").textContent = "No way to pay";
      $("trHead").classList.add("warn");
      const signIn = mk("button", { className: "btn-primary", textContent: "Sign in" });
      signIn.onclick = () => { ext.tabs.create({ url: siteBase + "#/settings/translation" }); window.close(); };
      const add = mk("a", { href: "#" }, mk("div", { className: "k" }, "Add a key", mk("small", { textContent: "Settings › Translation › Paid by" })), mk("span", { textContent: "↗" }));
      add.className = "row";
      add.style.textDecoration = "none";
      add.style.color = "inherit";
      add.onclick = (e) => { e.preventDefault(); ext.tabs.create({ url: siteBase + "#/settings/translation" }); window.close(); };
      tr.replaceChildren(mk("div", { className: "box" }, mk("div", { className: "row" }, mk("div", { className: "k" }, "Tickets", mk("small", { textContent: signedSay })), signIn), add));
    };
    // The errors of the translation: what failed, which model, who paid, what it said (pay.js logText), to read and to copy
    const logBox = () => {
      const log = (comicState && comicState.log) || [];
      if (!log.length) return "";
      const btn = mk("button", { textContent: (showLog ? "Hide log · " : "Show log · ") + log.length });
      btn.onclick = () => { showLog = !showLog; paint(); };
      if (!showLog) return mk("div", { className: "acts" }, btn);
      const copy = mk("button", { textContent: "Copy" });
      copy.onclick = async () => { try { await navigator.clipboard.writeText(log.map(Pay.logText).join("\n")); copy.textContent = "Copied"; } catch (e) { copy.textContent = "Not copied"; } setTimeout(() => { copy.textContent = "Copy"; }, 1500); };
      const rows = log.slice().reverse().map((e) => mk("div", { className: "subtitle log-line", textContent: Pay.logText(e), style: "white-space:pre-wrap;overflow-wrap:anywhere;text-align:left" }));
      return mk("div", {}, mk("div", { className: "acts" }, btn, copy), mk("div", { className: "box log-box", style: "padding:8px 10px;max-height:220px;overflow-y:auto" }, ...rows));
    };
    // a text chapter's translation, as the page's translator (content.js) tells it ("text:status"; the same pill in the page as a comic's): { step ("finding" | "translating" |
    // "done" | "failed" | "stopped"), status, error, words, showing ("made" | "original") }
    let textState = null;
    const textProgress = () => {
      const finding = textState.step === "finding", job = jobs()[0], words = textState.words || found.words;
      const row = (label, state, note) => mk("div", { className: "row" }, mk("span", { className: "k" }, state === "run" ? mk("span", { className: "spin" }) : mk("span", { className: "mk " + (state === "ok" ? "ok" : ""), textContent: state === "ok" ? "✓" : "·" }), label),
        mk("span", { className: "muted", textContent: note || "" }));
      const bar = mk("div", { className: "bar" }, mk("i"));
      bar.firstChild.style.width = (finding ? 10 : 55) + "%";
      const stop = mk("button", { textContent: "Stop" });
      stop.onclick = () => ext.tabs.sendMessage(tab.id, { type: "text:stop" }).catch(() => {});
      return mk("div", { className: "box" }, row("Finding text", finding ? "run" : "ok", finding ? "" : words.toLocaleString() + (words === 1 ? " word" : " words")),
        row("Translating", finding ? "wait" : "run", job && job.pair ? nameOf(job.pair.rule || job.pair.model) : ""), mk("div", { className: "row" }, bar, stop));
    };
    // the book a chapter kept in the library goes in: the library's own for the chapter's link to it, else the name the page gives
    const bookName = async () => {
      let book = novelNameEl.textContent.trim();
      const link = found.bookLink || found.readUrl;
      if (link) { const n = await inLibrary(link).catch(() => null); if (n && n.title) book = n.title; }
      return book;
    };
    // a comic's progress, as comic-host.js tells it (and the pill in the page)
    let comicState = null; // { step, done, of, error } while it runs or after
    const STEPS = [["finding", "Finding text"], ["reading", "Reading"], ["drawing", "Drawing"]];
    const ORDER = ["loading", "finding", "reading", "drawing", "done"];
    const progressBox = () => {
      const at = ORDER.indexOf(comicState.step);
      // (the steps run at once down the strip, each with its own count: comic-host.js passes the engine's counts; without them, one step after another)
      const c = comicState.counts;
      const first = c ? STEPS.findIndex(([s]) => !(c[s] && c[s].of && c[s].done >= c[s].of)) : -1;
      const rows = STEPS.map(([s, label], k) => {
        const i = ORDER.indexOf(s);
        const n = c && c[s];
        const state = n ? (n.of && n.done >= n.of ? "ok" : n.done > 0 || k === first ? "run" : "wait") : at > i ? "ok" : at === i ? "run" : "wait";
        const lead = state === "run" ? mk("span", { className: "spin" }) : mk("span", { className: "mk " + (state === "ok" ? "ok" : ""), textContent: state === "ok" ? "✓" : "·" });
        const note = s === "finding" && state === "ok" ? found.pictures.length + " pictures" : n ? (state === "run" && n.of ? n.done + " of " + n.of : "") : state === "run" && comicState.of ? comicState.done + " of " + comicState.of : "";
        return mk("div", { className: "row" }, mk("span", { className: "k" }, lead, label), mk("span", { className: "muted", textContent: note }));
      });
      const bar = mk("div", { className: "bar" }, mk("i"));
      const pics = c && c.pictures;
      bar.firstChild.style.width = (pics && pics.of ? Math.round((pics.done / pics.of) * 100) : Math.round(((Math.max(0, at - 1) + (comicState.of ? comicState.done / comicState.of : 0)) / 3) * 100)) + "%";
      const stop = mk("button", { textContent: "Stop" });
      stop.onclick = () => ext.runtime.sendMessage({ target: "comic", op: "stop", tabId: tab.id }).catch(() => {});
      const done = pics && pics.done ? [mk("div", { className: "row" }, mk("span", { className: "k", textContent: "Pictures" }), mk("span", { className: "muted", textContent: pics.done + " of " + pics.of }))] : [];
      return mk("div", { className: "box" }, ...rows, ...done, mk("div", { className: "row" }, bar, stop));
    };
    function paint() {
      $("trHead").classList.remove("warn");
      $("trHead").textContent = "Translate";
      $("trSide").replaceChildren();
      if (!payable()) noPay();
      else if (!comic && textState && /^(finding|translating)$/.test(textState.step)) {
        $("trHead").textContent = "Translating";
        $("trSide").replaceChildren(mk("span", { className: "muted", textContent: about() }));
        tr.replaceChildren(textProgress(), mk("div", { className: "box", style: "margin-top:8px" }, aheadRow()));
      } else if (!comic && textState && textState.step === "done") {
        $("trSide").replaceChildren(mk("span", { className: "pill ok", textContent: "Translated" }));
        const orig = mk("button", { textContent: textState.showing === "original" ? "Show translated" : "Show original" });
        orig.onclick = () => ext.tabs.sendMessage(tab.id, { type: "text:toggle" }).catch(() => {});
        const again = mk("button", { textContent: "Translate again" });
        again.onclick = () => translate(true);
        // Save to library: the page's text and its translation kept as a chapter of the library (as a comic's pictures are)
        const save = mk("button", { textContent: savedAs ? "Saved to library ✓" : "Save to library", disabled: !!savedAs });
        save.onclick = async () => {
          save.disabled = true;
          save.textContent = "Saving…";
          const book = await bookName();
          const page = await runInTab(null, () => (window.__p2preadText ? window.__p2preadText.saved() : null)).catch(() => null);
          if (!page || !page.translated) { saveError = "nothing translated to save: translate it first"; paint(); return; }
          await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that keeps it)
          const r = await ext.runtime.sendMessage({ target: "comic", op: "saveText", url: tab.url.split("#")[0], novelName: book, pageTitle: chTitleEl.textContent.trim(), ...page }).catch((e) => ({ error: e.message }));
          if (r && r.ok) { savedAs = r.key; saveError = ""; } else saveError = (r && r.error) || "the extension did not answer";
          paint();
        };
        const said = textState.status && textState.status !== "Translated" ? [mk("div", { className: "subtitle", textContent: textState.status })] : []; // ("Translated ahead · Next 2: ready", the tickets it cost)
        tr.replaceChildren(...said, mk("div", { className: "acts" }, orig, again, save), mk("div", { className: "box", style: "margin-top:10px" }, aheadRow()),
          ...(saveError ? [mk("div", { className: "subtitle", textContent: "Couldn't save: " + saveError })] : []));
      } else if (comicState && !/^(done|stopped|failed)$/.test(comicState.step)) {
        $("trHead").textContent = "Translating";
        $("trSide").replaceChildren(mk("span", { className: "muted", textContent: about() }));
        tr.replaceChildren(progressBox(), mk("div", { className: "box", style: "margin-top:8px" }, aheadRow()));
      } else if (comicState && comicState.step === "done") {
        // (pictures whose reading failed even in parts: their text is still the site's, so it is not called done)
        $("trSide").replaceChildren(mk("span", { className: comicState.unread ? "pill warn" : "pill ok", textContent: comicState.unread ? "Partly translated" : "Translated" }));
        const orig = mk("button", { textContent: "Show original" });
        orig.onclick = () => ext.tabs.sendMessage(tab.id, { type: "comic:toggle" }).catch(() => {});
        const again = mk("button", { textContent: "Translate again" });
        again.onclick = () => translate(true);
        // Model output: what the image model drew, as it drew it (no masks, none of the lettering done here), in the page in place of the translation; Show translated brings it back
        // (always there once it is translated: with nothing to show it is dimmed and says why, not left out)
        const rawWhy = comicState.rawKept ? "" : found.pictures.length > 40 ? "Not kept for a chapter of more than 40 pictures" : "The image model returned no picture for this chapter: every drawing was refused or failed (see the log)";
        const raw = mk("button", { textContent: "Model output", disabled: !comicState.rawKept, title: rawWhy });
        raw.onclick = async () => {
          const r = await ext.runtime.sendMessage({ target: "comic", op: "raw", tabId: tab.id }).catch((e) => ({ error: e.message }));
          if (r && r.error) { saveError = r.error; paint(); }
        };
        const acts = mk("div", { className: "acts" }, orig, raw, again);
        // Download zip: the translated pictures in order (and the English lines), as one file
        const zip = mk("button", { textContent: "Download zip" });
        zip.onclick = async () => {
          zip.disabled = true;
          zip.textContent = "Making the zip…";
          const r = await ext.runtime.sendMessage({ target: "comic", op: "zip", tabId: tab.id }).catch((e) => ({ error: e.message }));
          if (r && r.ok) {
            const name = (chTitleEl.textContent.trim() || "chapter").replace(/[\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) + " (translated).zip";
            const a = Object.assign(document.createElement("a"), { href: r.url, download: name });
            document.body.append(a);
            a.click();
            a.remove();
            zip.textContent = "Download zip";
            zip.disabled = false;
          } else { zip.textContent = "Download zip"; zip.disabled = false; saveError = (r && r.error) || "the extension did not answer"; paint(); }
        };
        acts.append(zip);
        // Save to library: the pictures and the English kept as a chapter of the library
        {
          const save = mk("button", { textContent: savedAs ? "Saved to library ✓" : "Save to library", disabled: !!savedAs });
          save.onclick = async () => {
            save.disabled = true;
            save.textContent = "Saving…";
            const book = await bookName();
            const r = await ext.runtime.sendMessage({ target: "comic", op: "save", tabId: tab.id, url: tab.url.split("#")[0], novelName: book, pageTitle: chTitleEl.textContent.trim() }).catch((e) => ({ error: e.message }));
            if (r && r.ok) { savedAs = r.key; saveError = ""; } else saveError = (r && r.error) || "the extension did not answer";
            paint();
          };
          acts.append(save);
        }
        const unread = comicState.unread ? [mk("div", { className: "subtitle warn-text", textContent: "Not read: picture" + (/[,–]/.test(comicState.unread) ? "s " : " ") + comicState.unread })] : [];
        tr.replaceChildren(...unread, acts, mk("div", { className: "box", style: "margin-top:10px" }, aheadRow()), ...(rawWhy ? [mk("div", { className: "subtitle", textContent: "Model output: " + rawWhy.charAt(0).toLowerCase() + rawWhy.slice(1) })] : []), ...(saveError ? [mk("div", { className: "subtitle", textContent: "Couldn't save: " + saveError })] : []), logBox());
      } else {
        const go = mk("button", { className: "btn-primary wide", textContent: "文A  Translate", disabled: comic && !found.pictures.length });
        go.onclick = () => translate(false);
        const st = comic ? comicState : textState;
        const err = st && st.error ? mk("div", { className: "subtitle", textContent: "Couldn't translate: " + st.error }) : st && st.step === "stopped" && !comic ? mk("div", { className: "subtitle", textContent: "Stopped" }) : "";
        tr.replaceChildren(mk("div", { className: "box" }, ...payRows(), aheadRow(), mk("div", {}, go)), err, logBox());
      }
      // Listen: the browser's own voices (free); or an AI voice, paid with tickets or the OpenRouter key. A comic has none.
      $("lsHead").hidden = ls.hidden = !!comic;
      if (comic) return;
      // (the rules' first voice the extension can ask for: tickets, the OpenRouter key or an address of the person's own; a Gemini or Fish Audio voice is the library page's)
      const voiceKey = Pay.choices("voice", has).find((c) => ["tickets", "openrouter", "other"].includes(c.kind));
      const aiPay = voiceKey ? pay : "";
      if (!aiPay && voiceIs === "ai") voiceIs = "browser";
      const seg = mk("span", { className: "seg" }, ...[["browser", "Browser"], ["ai", "AI voice"]].map(([w, label]) => {
        const b = mk("button", { textContent: label, disabled: w === "ai" && !aiPay });
        b.setAttribute("aria-pressed", String(voiceIs === w));
        b.onclick = () => { voiceIs = w; ext.storage.local.set({ listenVoice: w }); paint(); };
        return b;
      }));
      const voice = mk("div", { className: "row" }, mk("span", { className: "k", textContent: "Voice" }), seg);
      const who = voiceIs === "ai" ? mk("div", { className: "row" }, mk("span", { className: "muted", textContent: nameOf(voiceKey.rule || voiceKey.model) + " · " + payLabel(voiceKey) }), mk("span", { className: "muted", textContent: comic ? "Each speaker" : "" })) : "";
      // (the popup stays: the button says how the page's Listen goes, Stop · Loading… until its first line is heard, then Stop; a press then stops it)
      const listen = mk("button", { className: (comicState && comicState.step === "done") || !comic ? "btn-primary wide" : "wide", textContent: LISTEN_LABEL[listenNow.state] || LISTEN_LABEL[""] });
      listen.onclick = async () => {
        if (listenNow.state) {
          listenNow = { state: "", error: "" };
          paint();
          await ext.tabs.sendMessage(tab.id, { type: "page:listen", stop: true }).catch(() => {});
          return;
        }
        listenNow = { state: "loading", error: "" };
        paint();
        // (the page's part is put in only once: put in again it forgets the lines and puts the site's pictures back)
        if (!(await runInTab(null, () => !!window.__p2preadComicPage).catch(() => false))) await pageScript(null);
        if (voiceIs === "ai") {
          await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that makes the call)
          const { devOpenRouter } = await ext.storage.local.get("devOpenRouter"); // (the e2e tests' stand-in: a dev build only, comic-host.js)
          await ext.runtime.sendMessage({ target: "comic", op: "listen", tabId: tab.id, pay: aiPay, keys, token, rules: modelRules || {}, openrouter: devOpenRouter || undefined }).catch(() => {});
        }
        // (Stop pressed while this was being set up: nothing is started)
        if (listenNow.state !== "loading") return;
        await ext.tabs.sendMessage(tab.id, { type: "page:listen", voice: voiceIs, start: true }).catch(() => {});
      };
      const listenErr = listenNow.error ? mk("div", { className: "subtitle", textContent: "Couldn't read aloud: " + listenNow.error }) : "";
      ls.replaceChildren(mk("div", { className: "box" }, voice, who), listen, listenErr);
    }
    // the page's part (comic-page.js): its pictures swapped, the pill, Listen (urls null: a text chapter's page, whose translator tells the pill how it goes)
    async function pageScript(urls) {
      await runInTab(null, (u) => { window.__P2PREAD_COMIC_URLS__ = u; }, [urls === null ? null : urls || []]).catch(() => {});
      await runInTab(["comic-page.js"], () => true).catch(() => {});
    }
    // fresh: Translate again (the pictures made again, not the ones made ahead or before)
    async function translate(fresh) {
      if (!comic) {
        // (Translate ahead: the browser is asked for this site first, while the press still counts: the tab is followed to its next pages)
        if (aheadOn && pagePattern()) await SiteAccess.request([pagePattern()], ext).catch(() => false);
        // the page's own translator (content.js), keeping nothing, with the same pill in the page as a comic's (comic-page.js, put in first); the popup stays and follows it
        await pageScript(null);
        textState = { step: "finding", words: found.words };
        savedAs = "";
        saveError = "";
        paint();
        const here = fresh && (await runInTab(null, () => !!(window.__p2preadText && window.__p2preadTextAt === location.href)).catch(() => false));
        if (here) await ext.tabs.sendMessage(tab.id, { type: "text:again" }).catch(() => {});
        else {
          const r = await ext.runtime.sendMessage({ type: "translateTab", tabId: tab.id, keepNothing: true, pay: textPay(), ahead: aheadOn }).catch((e) => ({ error: e.message }));
          if (r && r.error) { textState = { step: "failed", error: r.error }; paint(); }
        }
        return;
      }
      // The pictures are often kept on another host than the page (a picture server): the browser has to let the extension read each one. Asked first, while the
      // press still counts (one question for all of them; hosts already allowed are not asked about). Translate ahead: this site's too.
      const wanted = [...new Set(found.pictures.filter((u) => { try { return !SiteAccess.ALWAYS.test(new URL(u).hostname); } catch (e) { return false; } }).map((u) => SiteAccess.patternOf(u)).filter(Boolean))];
      const asking = aheadOn && pagePattern() && !wanted.includes(pagePattern()) ? wanted.concat(pagePattern()) : wanted;
      if (asking.length && !(await SiteAccess.request(asking, ext))) {
        // (refused: the pictures may be allowed from before all the same)
        const allowed = (await Promise.all(found.pictures.map((u) => SiteAccess.has(u, ext)))).every(Boolean);
        if (!allowed) {
          comicState = { step: "failed", error: "Allow " + wanted.map(SiteAccess.hostOfPattern).join(", ") + " to load the pictures" };
          paint();
          return;
        }
      }
      await pageScript(found.pictures);
      await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that does it)
      comicState = { step: "loading", done: 0, of: found.pictures.length };
      paint();
      const { devOpenRouter } = await ext.storage.local.get("devOpenRouter"); // (the e2e tests' stand-in: a dev build only, comic-host.js)
      const r = await ext.runtime.sendMessage({ target: "comic", op: "translate", tabId: tab.id, urls: found.pictures, referer: tab.url, pay, keys, token, rules: modelRules || {}, prompts: comicPrompts || {}, into: "English", openrouter: devOpenRouter || undefined, fresh: !!fresh }).catch((e) => ({ error: e.message }));
      if (!r || r.error) { comicState = { step: "failed", error: (r && r.error) || "the extension did not answer" }; paint(); return; }
      if (aheadOn) startAhead(); // (the next pages are looked for now, and made one after another once this one is)
    }
    // (the view is drawn again when the person switches Details, Text, Pictures: only the last one listens)
    if (chapterStatus) ext.runtime.onMessage.removeListener(chapterStatus);
    chapterStatus = (m, sender) => {
      if (m && m.type === "text:status" && !comic && sender && sender.tab && sender.tab.id === tab.id) { textState = m; paint(); return; }
      if (m && m.type === "listen:status" && !comic && sender && sender.tab && sender.tab.id === tab.id) { listenNow = { state: m.state || "", error: m.error || "" }; paint(); return; }
      if (!m || m.type !== "comic:status" || m.tabId !== tab.id) return;
      comicState = m;
      paint();
    };
    ext.runtime.onMessage.addListener(chapterStatus);
    // opened again while it runs, or after: what the page has
    // (the pictures this page has now are given: a translation of other pictures, the site's next page shown in place, is not this page's)
    const before = comic ? await runInTab(null, (u) => (window.__p2preadComicPage ? window.__p2preadComicPage.info(u) : null), [found.pictures]).catch(() => null) : null;
    if (before && before.made) {
      comicState = { step: "done" };
      const kept = (await ext.runtime.sendMessage({ target: "comic", op: "log", tabId: tab.id }).catch(() => null)) || {}; // (the errors of that translation, and whether the model's own pictures, kept by the host)
      comicState.log = kept.log || [];
      comicState.rawKept = !!kept.rawKept;
      comicState.unread = kept.unread || "";
    }
    else if (before && before.running) comicState = { step: "loading", done: 0, of: 0 };
    if (!comic) textState = (await runInTab(null, () => (window.__p2preadText && window.__p2preadTextAt === location.href ? window.__p2preadText.state() : null)).catch(() => null)) || null;
    // (Listen still going in the page: its Stop)
    if (!comic) listenNow = (await runInTab(null, () => (window.__p2preadComicPage && window.__p2preadComicPage.listening ? window.__p2preadComicPage.listening() : null)).catch(() => null)) || listenNow;
    paint();
  }

  showKind(looksChapter ? (comic ? "pictures" : "text") : "book");
})();
