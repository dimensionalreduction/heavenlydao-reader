// The popup once this extension is a device of your library (popup-lock.js shows only Detect library before): a header with the
// novel and chapter of the page in front of you, and two tabs (docs/ADD-BOOK.md, the design's PopupScreen):
//   Novel    a book's page: what was read from it (cover, title, author, chapters, text or pictures), Import to library or Detect with AI; one in your library: Open in
//            library, Refresh details, Refresh chapters. A chapter's page: Translate and Listen in the page, nothing kept (a comic's: its pictures made again, comic-host.js)
//   Library  your library: its numbers, leaving it (popup-library.js), the pictures kept
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
  const hasGeminiKey = async () => {
    const { profileKeys, geminiApiKey } = await ext.storage.local.get(["profileKeys", "geminiApiKey"]);
    return !!((profileKeys && profileKeys[GEMINI_KEY_BASE]) || geminiApiKey);
  };
  let keyHere = false; // (known before a click: the browser's question below has to come first in it)
  const showKeyNote = async () => { keyHere = await hasGeminiKey(); $("geminiNote").hidden = keyHere; };
  showKeyNote();
  ext.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.profileKeys || changes.geminiApiKey)) showKeyNote(); });
  // Detect with AI (a book's page, new or already in the library). With no Gemini key it is not refused: the chapter list is found by looking at the page (book-detect.js
  // guessPicks), which is what a book that was imported with no list needs.
  const detectNow = async () => {
    const local = !keyHere; // (known already: nothing is waited for before the browser's question below)
    $("detInfo").textContent = local ? "Detecting without Gemini: looking for the chapter list…" : "Detecting…";
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

  // ---------- Library: its numbers (leaving it: popup-library.js) ----------
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
      const st = await lib("status").catch(() => null);
      const p = await Promise.resolve(ext.runtime.sendMessage({ type: "p2p:status" })).catch(() => null);
      const rows = [];
      if (st && st.devices) rows.push(row("Devices", st.devices.length + (st.main ? " (this one is the main device)" : "")));
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
  const comicSite = !!(rule && (rule.images || rule.pictures));
  const sel = {
    title: str(book.title), author: str(book.author), description: str(book.description), cover: str(book.cover),
    list: str(toc.list) || str(saved && saved.spec.toc && saved.spec.toc.list), listBuiltIn: !!(toc.list || toc.boxes || toc.parse) && !str(toc.list) && !(saved && saved.spec.toc && str(saved.spec.toc.list)),
    content: str(contentSelectors[hostname]) || str(rule && rule.selector), images: str(rule && rule.images)
  };
  // Run in the page: each part of a book (the rule's selector, else the standard novel metadata many sites carry), the chapter's text, and its pictures
  // (the rule's, else the page's own list of them, else large pictures one under another: a comic's chapter)
  const probe = (s, generic, minLen) => {
    const pick = (q) => { try { return q ? document.querySelector(q) : null; } catch (e) { return null; } };
    const text = (n) => (n ? (n.innerText || n.textContent || "").trim().replace(/\s+/g, " ") : "");
    const meta = (p) => (document.querySelector('meta[property="' + p + '"]') || {}).content || "";
    const part = (q, metaName) => {
      const n = pick(q);
      if (n) return { found: true, text: text(n).slice(0, 160) };
      const m = metaName && meta(metaName);
      return m ? { found: true, text: m.trim().slice(0, 160) } : { found: false };
    };
    const coverNode = pick(s.cover);
    const coverImg = coverNode && (coverNode.tagName === "IMG" ? coverNode : coverNode.querySelector("img"));
    const coverUrl = coverImg ? coverImg.currentSrc || coverImg.getAttribute("data-src") || coverImg.src : meta("og:image");
    let list = 0;
    if (s.list) { try { list = document.querySelectorAll(s.list).length; } catch (e) { /* a bad selector */ } }
    let content = "";
    const c = pick(s.content);
    if (c && text(c).length >= minLen) content = text(c);
    else {
      const mapped = (window.SITE_CONTENT_SELECTORS || {})[location.hostname.replace(/^www\./, "")];
      for (const q of [mapped].concat(generic)) { const n = pick(q); if (n && text(n).length >= minLen) { content = text(n); break; } }
    }
    let pictures = [];
    try {
      // a chapter this extension has translated in its page: its pictures are the ones made now (blob: addresses, the lazy-loading attributes taken off), so the addresses
      // it was given are the chapter's pictures
      const given = window.__p2preadComicPage && window.__P2PREAD_COMIC_URLS__;
      if (Array.isArray(given) && given.length) pictures = given.slice();
      else if (s.images) pictures = ImageChapter.urlsOf(document, s.images, location.href);
      if (!pictures.length) pictures = ImageChapter.urlsFromProps(document, location.href);
      if (!pictures.length) {
        // a picture of the chapter: a big one that is loaded, or one a lazy loader has not loaded yet (the real address in data-src, a placeholder in src: it is as wide
        // as the page lays it out, whatever the placeholder is). Of those, the ones that share the nearest container with the most of them (not the page's banners or thumbnails).
        const lazyUrl = (im) => ImageChapter.imgUrl(im, location.href);
        const wide = (im) => im.getBoundingClientRect().width >= 200;
        const isBig = (im) => (im.naturalWidth >= 300 && im.naturalHeight >= 300 && wide(im)) || (!!im.getAttribute("data-src") || !!im.getAttribute("data-lazy-src") || !!im.getAttribute("data-original")) && wide(im) && im.naturalWidth < 300 && !!lazyUrl(im);
        const cand = [...document.images].filter(isBig);
        let best = cand, most = 0;
        for (const im of cand) {
          let up = im.parentElement;
          for (let d = 0; up && d < 3; d++, up = up.parentElement) {
            const inside = cand.filter((x) => up.contains(x));
            if (inside.length > most) { most = inside.length; best = inside; }
          }
        }
        if (best.length >= 3 && content.length < 2000) pictures = best.map((im) => lazyUrl(im) || ImageChapter.imgUrl(im, location.href) || (im.currentSrc && /^https:/.test(im.currentSrc) ? im.currentSrc : "")).filter(Boolean);
      }
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
      title: part(s.title, "og:novel:book_name"), author: part(s.author, "og:novel:author"), description: part(s.description, "og:description").found ? part(s.description, "og:description") : ((d) => (d.length >= 30 ? { found: true, text: d.slice(0, 160) } : { found: false }))(((document.querySelector('meta[name="description"]') || {}).content || "").trim()),
      cover: coverUrl ? { found: true, url: coverUrl } : { found: false }, list, contentChars: content.length, words: cjk > content.length / 3 ? cjk : content.split(/\s+/).filter(Boolean).length,
      pictures, bookLink, readUrl: meta("og:novel:read_url"), listPages
    };
  };
  const found = await runInTab(["site-selectors.js", "image-chapter.js"], probe, [sel, GENERIC_SELECTORS, MIN_CONTENT_LENGTH]).catch(() => null);
  const rawVar = await detectRawVarPresent().catch(() => false);
  if (!found) {
    pageNote.textContent = "This page can't be looked at (the browser keeps the extension out of it).";
    return;
  }
  if (rawVar) found.contentChars = Math.max(found.contentChars, MIN_CONTENT_LENGTH);
  const listFound = found.list > 0 || sel.listBuiltIn || !!found.readUrl;
  const bookParts = [found.title, found.cover, found.author, found.description].filter((x) => x.found).length;
  const comic = comicSite || found.pictures.length >= 3;
  // the person can say otherwise (foot of the tab): what the page looks like only picks which view opens first
  const looksChapter = (found.contentChars >= MIN_CONTENT_LENGTH || found.pictures.length >= 3 || (comicSite && found.pictures.length > 0)) && !(listFound && bookParts >= 2) && bookParts < 3;
  const asOther = $("asOther");
  const showView = (chapter) => {
    pageNote.hidden = true;
    $("bookView").hidden = chapter;
    $("importView").hidden = true;
    $("chapterView").hidden = !chapter;
    asOther.hidden = false;
    asOther.textContent = chapter ? "This is the book's page" : "This is a chapter";
    asOther.onclick = () => showView(!chapter);
    if (chapter) drawChapter(); else drawBook();
  };

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
  const bookIdOf = (url) => { const u = new URL(url); return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\.[a-z]+$/i, "").replace(/\/+$/, ""); }; // (as book-capture.js names it)
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
    const chapters = found.list ? { found: true, text: found.list.toLocaleString() + (found.listPages > 1 ? " · page 1 of " + found.listPages : "") } : sel.listBuiltIn ? { found: true, text: "Read by the site's rule" } : found.readUrl ? { found: true, text: "On the list page" } : { found: false };
    parts.replaceChildren(row("Title", found.title, true), row("Author", found.author), row("Chapters", chapters), row("Chapters are", { found: !!partsRule || comic, text: comic ? "Pictures" : "Text" }));
    // a title that is not in English, put into English beside it (Google Translate, as the library's page does)
    const titleV = parts.querySelector(".v.big");
    if (titleV && found.title.found && /[぀-ヿ㐀-鿿가-힯]/.test(found.title.text)) {
      fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" + encodeURIComponent(found.title.text))
        .then((r) => r.json()).then((j) => { const en = ((j && j[0]) || []).map((x) => x[0]).join("").trim(); if (en && en !== found.title.text) titleV.append(Object.assign(document.createElement("small"), { className: "muted", textContent: "  " + en })); })
        .catch(() => {});
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
    asOther.hidden = true;
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
        const started = await ext.runtime.sendMessage({ type: "startDetect", tabId: tab.id, local: true }).catch((e) => ({ error: e.message }));
        const ruleSaved = async () => Object.values((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {}).some((e) => e && e.enabled !== false && e.spec && UserRules.cleanHost(e.spec.host) === hostname && e.spec.toc && (e.spec.toc.list || e.spec.toc.json));
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
  const TICKET_USD = 0.0005, COMIC_USD_A_PICTURE = 0.012;
  const mk = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; };
  async function drawChapter() {
    chTitleEl.textContent = pageTitleEl.textContent;
    $("chWhat").textContent = comic ? "🖼 " + found.pictures.length + " pictures" : "≡ Text · " + found.words.toLocaleString() + " words";
    const bookUrl = found.bookLink || found.readUrl;
    const chBook = $("chBook");
    chBook.hidden = !bookUrl;
    if (bookUrl) {
      chBook.replaceChildren(mk("span", { textContent: "📖 " + novelNameEl.textContent }), mk("span", { textContent: "›" }));
      chBook.onclick = (e) => { e.preventDefault(); ext.tabs.update(tab.id, { url: bookUrl }); window.close(); };
    }
    // who can pay: the keys and the sign-in the library's page in this browser handed over (profile-translate.js keeps them)
    const { profileKeys, playgroundToken, popupPay, listenVoice } = await ext.storage.local.get(["profileKeys", "playgroundToken", "popupPay", "listenVoice"]);
    let voiceIs = listenVoice === "ai" ? "ai" : "browser";
    const inLibraryNow = !!(await ext.storage.local.get("libraryOn")).libraryOn;
    let savedAs = ""; // (the key it was kept under, once Save to library has done it)
    let saveError = "";
    const keys = profileKeys || {};
    const token = String(playgroundToken || "");
    const keyOk = comic ? !!keys[OPENROUTER] : !!keys[GEMINI_KEY_BASE];
    const ways = [["tickets", !!token], ["key", keyOk]].filter(([, ok]) => ok).map(([w]) => w);
    let pay = ways.includes(popupPay) ? popupPay : ways[0] || "";
    let left = null;
    if (token) fetch(PLAYGROUND + "/api/me", { headers: { Authorization: "Bearer " + token, "X-Playground": "1" } }).then((r) => r.json()).then((j) => { left = j && j.tickets ? j.tickets.left : null; paint(); }, () => {});
    const tr = $("trBody"), ls = $("lsBody");
    const about = () => {
      const usd = comic ? found.pictures.length * COMIC_USD_A_PICTURE : null;
      if (pay === "tickets") return "about " + Math.max(1, Math.round(comic ? usd / TICKET_USD : (found.words * 5.5 + 500) * 0.0012)).toLocaleString() + " tickets";
      return comic ? "about $" + usd.toFixed(2) : "Gemini key";
    };
    const payRows = () => {
      const seg = mk("span", { className: "seg" }, ...[["tickets", "Tickets"], ["key", "Key"]].map(([w, label]) => {
        const b = mk("button", { textContent: label, disabled: !ways.includes(w) });
        b.setAttribute("aria-pressed", String(pay === w));
        b.onclick = () => { pay = w; ext.storage.local.set({ popupPay: w }); paint(); };
        return b;
      }));
      const who = pay === "tickets" ? "Tickets" + (left != null ? " · " + Math.floor(left).toLocaleString() + " left" : "") : comic ? "OpenRouter key · …" + String(keys[OPENROUTER]).slice(-4) : "Gemini key · …" + String(keys[GEMINI_KEY_BASE]).slice(-4);
      return [mk("div", { className: "row" }, mk("span", { className: "k", textContent: "Pay with" }), seg), mk("div", { className: "row" }, mk("span", { className: "k muted", textContent: who }), mk("b", { className: "r", textContent: about() }))];
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
      tr.replaceChildren(mk("div", { className: "box" }, mk("div", { className: "row" }, mk("div", { className: "k" }, "Tickets", mk("small", { textContent: token ? "Signed in" : "Not signed in" })), signIn), add));
    };
    // a comic's progress, as comic-host.js tells it (and the pill in the page)
    let comicState = null; // { step, done, of, error } while it runs or after
    const STEPS = [["finding", "Finding text"], ["reading", "Reading"], ["drawing", "Drawing"]];
    const ORDER = ["loading", "finding", "reading", "drawing", "done"];
    const progressBox = () => {
      const at = ORDER.indexOf(comicState.step);
      const rows = STEPS.map(([s, label]) => {
        const i = ORDER.indexOf(s);
        const state = at > i ? "ok" : at === i ? "run" : "wait";
        const lead = state === "run" ? mk("span", { className: "spin" }) : mk("span", { className: "mk " + (state === "ok" ? "ok" : ""), textContent: state === "ok" ? "✓" : "·" });
        return mk("div", { className: "row" }, mk("span", { className: "k" }, lead, label), mk("span", { className: "muted", textContent: s === "finding" && state === "ok" ? found.pictures.length + " pictures" : state === "run" && comicState.of ? comicState.done + " of " + comicState.of : "" }));
      });
      const bar = mk("div", { className: "bar" }, mk("i"));
      bar.firstChild.style.width = Math.round(((Math.max(0, at - 1) + (comicState.of ? comicState.done / comicState.of : 0)) / 3) * 100) + "%";
      const stop = mk("button", { textContent: "Stop" });
      stop.onclick = () => ext.runtime.sendMessage({ target: "comic", op: "stop", tabId: tab.id }).catch(() => {});
      return mk("div", { className: "box" }, ...rows, mk("div", { className: "row" }, bar, stop));
    };
    function paint() {
      $("trHead").classList.remove("warn");
      $("trHead").textContent = "Translate";
      $("trSide").replaceChildren();
      if (!ways.length) noPay();
      else if (comicState && !/^(done|stopped|failed)$/.test(comicState.step)) {
        $("trHead").textContent = "Translating";
        $("trSide").replaceChildren(mk("span", { className: "muted", textContent: about() }));
        tr.replaceChildren(progressBox());
      } else if (comicState && comicState.step === "done") {
        $("trSide").replaceChildren(mk("span", { className: "pill ok", textContent: "Translated" }));
        const orig = mk("button", { textContent: "Show original" });
        orig.onclick = () => ext.tabs.sendMessage(tab.id, { type: "comic:toggle" }).catch(() => {});
        const again = mk("button", { textContent: "Translate again" });
        again.onclick = () => translate();
        const acts = mk("div", { className: "acts" }, orig, again);
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
        // Save to library: the pictures and the English kept as a chapter of the library (the extension has to be in one)
        if (inLibraryNow) {
          const save = mk("button", { textContent: savedAs ? "Saved to library ✓" : "Save to library", disabled: !!savedAs });
          save.onclick = async () => {
            save.disabled = true;
            save.textContent = "Saving…";
            // (the book it belongs to: the library's own book for the chapter's link to it, else the name the page gives)
            let book = novelNameEl.textContent.trim();
            const link = found.bookLink || found.readUrl;
            if (link) { const n = await inLibrary(link).catch(() => null); if (n && n.title) book = n.title; }
            const r = await ext.runtime.sendMessage({ target: "comic", op: "save", tabId: tab.id, url: tab.url.split("#")[0], novelName: book, pageTitle: chTitleEl.textContent.trim() }).catch((e) => ({ error: e.message }));
            if (r && r.ok) { savedAs = r.key; saveError = ""; } else saveError = (r && r.error) || "the extension did not answer";
            paint();
          };
          acts.append(save);
        }
        tr.replaceChildren(acts, ...(saveError ? [mk("div", { className: "subtitle", textContent: "Couldn't save: " + saveError })] : []));
      } else {
        const go = mk("button", { className: "btn-primary wide", textContent: "文A  Translate" });
        go.onclick = () => translate();
        const err = comicState && comicState.error ? mk("div", { className: "subtitle", textContent: "Couldn't translate: " + comicState.error }) : "";
        tr.replaceChildren(mk("div", { className: "box" }, ...payRows(), mk("div", {}, go)), err);
      }
      // Listen: the browser's own voices (free); or an AI voice, paid with tickets or the OpenRouter key. A comic has none.
      $("lsHead").hidden = ls.hidden = !!comic;
      if (comic) return;
      const aiPay = pay === "tickets" && token ? "tickets" : keys[OPENROUTER] ? "key" : "";
      if (!aiPay && voiceIs === "ai") voiceIs = "browser";
      const seg = mk("span", { className: "seg" }, ...[["browser", "Browser"], ["ai", "AI voice"]].map(([w, label]) => {
        const b = mk("button", { textContent: label, disabled: w === "ai" && !aiPay });
        b.setAttribute("aria-pressed", String(voiceIs === w));
        b.onclick = () => { voiceIs = w; ext.storage.local.set({ listenVoice: w }); paint(); };
        return b;
      }));
      const voice = mk("div", { className: "row" }, mk("span", { className: "k", textContent: "Voice" }), seg);
      const who = voiceIs === "ai" ? mk("div", { className: "row" }, mk("span", { className: "muted", textContent: aiPay === "tickets" ? "Tickets" : "OpenRouter key · …" + String(keys[OPENROUTER]).slice(-4) }), mk("span", { className: "muted", textContent: comic ? "Each speaker" : "" })) : "";
      const listen = mk("button", { className: (comicState && comicState.step === "done") || !comic ? "btn-primary wide" : "wide", textContent: "▶  Listen" });
      listen.onclick = async () => {
        // (the page's part is put in only once: put in again it forgets the lines and puts the site's pictures back)
        if (!(await runInTab(null, () => !!window.__p2preadComicPage).catch(() => false))) await pageScript();
        if (voiceIs === "ai") {
          await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that makes the call)
          const { devOpenRouter } = await ext.storage.local.get("devOpenRouter"); // (the e2e tests' stand-in: a dev build only, comic-host.js)
          await ext.runtime.sendMessage({ target: "comic", op: "listen", tabId: tab.id, pay: aiPay, keys, token, openrouter: devOpenRouter || undefined }).catch(() => {});
        }
        await ext.tabs.sendMessage(tab.id, { type: "page:listen", voice: voiceIs }).catch(() => {});
        window.close();
      };
      ls.replaceChildren(mk("div", { className: "box" }, voice, who), listen);
    }
    // the page's part (comic-page.js): its pictures swapped, the pill, Listen
    async function pageScript(urls) {
      await runInTab(null, (u) => { window.__P2PREAD_COMIC_URLS__ = u; }, [urls || []]).catch(() => {});
      await runInTab(["comic-page.js"], () => true).catch(() => {});
    }
    async function translate() {
      if (!comic) {
        // the page's own translator (content.js), keeping nothing; its bar in the page has Show original and Re-translate
        await ext.runtime.sendMessage({ type: "translateTab", tabId: tab.id, keepNothing: true, pay }).catch(() => {});
        window.close();
        return;
      }
      // The pictures are often kept on another host than the page (a picture server): the browser has to let the extension read each one. Asked first, while the
      // press still counts (one question for all of them; hosts already allowed are not asked about).
      const wanted = [...new Set(found.pictures.filter((u) => { try { return !SiteAccess.ALWAYS.test(new URL(u).hostname); } catch (e) { return false; } }).map((u) => SiteAccess.patternOf(u)).filter(Boolean))];
      if (wanted.length && !(await SiteAccess.request(wanted, ext))) {
        comicState = { step: "failed", error: "Allow " + wanted.map(SiteAccess.hostOfPattern).join(", ") + " to load the pictures" };
        paint();
        return;
      }
      await pageScript(found.pictures);
      await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that does it)
      comicState = { step: "loading", done: 0, of: found.pictures.length };
      paint();
      const { devOpenRouter } = await ext.storage.local.get("devOpenRouter"); // (the e2e tests' stand-in: a dev build only, comic-host.js)
      const r = await ext.runtime.sendMessage({ target: "comic", op: "translate", tabId: tab.id, urls: found.pictures, referer: tab.url, pay, keys, token, into: "English", openrouter: devOpenRouter || undefined }).catch((e) => ({ error: e.message }));
      if (!r || r.error) { comicState = { step: "failed", error: (r && r.error) || "the extension did not answer" }; paint(); }
    }
    ext.runtime.onMessage.addListener((m) => {
      if (!m || m.type !== "comic:status" || m.tabId !== tab.id) return;
      comicState = m;
      paint();
    });
    // opened again while it runs, or after: what the page has
    const before = comic ? await runInTab(null, () => (window.__p2preadComicPage ? window.__p2preadComicPage.info() : null)).catch(() => null) : null;
    if (before && before.made) comicState = { step: "done" };
    else if (before && before.running) comicState = { step: "loading", done: 0, of: 0 };
    paint();
  }

  showView(looksChapter);
})();
