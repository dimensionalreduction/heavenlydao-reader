// The popup once this extension is a device of your library (popup-lock.js shows only the passphrase and Join before): a header with the
// novel and chapter of the page in front of you (and "Library copy": whether the novels you open are recorded in your library), and two tabs:
//   Novel    where this site keeps each part of a novel (title, chapter list, cover...), whether it is found on this page, the picker, AI detection
//   Library  your library (popup-library.js: its devices, letting one in), its numbers, the passphrase
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

  // ---------- library copy ----------
  // On (the default): the novels you open are recorded in your library: their details, cover and chapter list (book-capture.js, wtr-capture.js,
  // chapter-index.js read this). Off: this extension records nothing there.
  {
    const box = $("libraryCopy");
    box.checked = (await ext.storage.local.get("libraryCopy")).libraryCopy !== false;
    box.onchange = () => ext.storage.local.set({ libraryCopy: box.checked });
  }

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
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
        await SiteAccess.request([pattern], ext);
        renderAccess();
      };
      row.append(name, allow);
      accessBar.append(row);
    }
  }
  await renderAccess();

  ext.runtime.sendMessage({ type: "glossary:pull" }).catch(() => {}); // (brought up to date whenever the popup opens)

  // ---------- Library: its numbers, the passphrase (the devices and letting one in: popup-library.js) ----------
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
    let sent = null;
    lib("seeded").then((s) => { sent = s; draw(); }, () => {});
    let followed = null;
    lib("followStatus").then((s) => { followed = s; draw(); }, () => {});
    async function draw() {
      const st = await lib("status").catch(() => null);
      const p = await Promise.resolve(ext.runtime.sendMessage({ type: "p2p:status" })).catch(() => null);
      const rows = [];
      if (st && st.devices) rows.push(row("Your devices", st.devices.length + (st.main ? " (this one is the main device)" : "")));
      if (p && p.running) rows.push(row("Online now", p.network ? p.peers + " of your devices" + (p.others ? " · " + p.others + " other in the room" : "") : "no passphrase: only this browser's library tab"));
      if (novels) rows.push(row("Novels", String(novels.length)));
      if (p) rows.push(row("Chapters here", String(p.indexed || 0) + (p.queued ? " · " + p.queued + " downloading" : "")));
      if (used !== null) rows.push(row("Stored here", size(used)));
      if (sent) rows.push(row("Sent to readers", size(sent.total || 0)));
      if (followed && followed.follows) rows.push(row("Libraries you follow", followed.follows + (followed.kept ? " · " + followed.kept + " kept available by this extension" : "") + (followed.held ? " · " + size(followed.held) : "")));
      statsEl.replaceChildren(...rows);
      if (!rows.length) statsEl.textContent = "Not reachable just now.";
    }
    draw();
    setInterval(draw, 3000);

    const pass = $("p2pPassphrase");
    pass.value = (await ext.storage.local.get("p2pPassphrase")).p2pPassphrase || "";
    pass.onchange = async () => {
      await ext.storage.local.set({ p2pPassphrase: pass.value.trim(), p2pEnabled: true }); // (the room starts again with it)
      $("p2pStatus").textContent = pass.value.trim() ? "Saved. Your devices with this passphrase find this one." : "No passphrase: only the library tab in this browser reaches this extension.";
    };
    $("p2pStatus").textContent = "The one your library's site shows (Settings › Library). Your devices find each other with it; keep it to yourself.";
    // Chromium browsers can keep running with every window closed, and with them this extension's library and sync: your phone and readers
    // still reach it. Firefox closes with its last window.
    const bg = $("p2pBackground");
    if (typeof browser === "undefined") {
      const where = /Edg\//.test(navigator.userAgent)
        ? "Edge's Settings → System and performance → “Continue running background extensions and apps when Microsoft Edge is closed”"
        : navigator.brave ? "Brave's Settings → System → “Continue running background apps when Brave is closed”"
          : "Chrome's Settings → System → “Continue running background apps when Google Chrome is closed”";
      bg.textContent = "To keep your library reachable with every window closed (while this computer is on), turn on " + where + ".";
      bg.hidden = false;
    }
  }

  // ---------- the page: nothing more without one ----------
  const novelNameEl = $("novelName");
  const pageTitleEl = $("pageTitle");
  if (!onPage) {
    pageTitleEl.textContent = "Not a page of a site";
    for (const id of ["novelPickBtn", "novelEditBtn", "novelDefaultBtn", "pickTitleBtn", "titleEditBtn", "titleDefaultBtn", "detectBtn", "siteRuleBtn", "detailsBtn"]) $(id).disabled = true;
    $("detList").textContent = "Open a novel's page or one of its chapters.";
    return;
  }

  // The page where the person adds a rule of their own for this site (it opens with the site's address filled in).
  $("siteRuleBtn").onclick = () => {
    ext.tabs.create({ url: ext.runtime.getURL("rules.html") + "?url=" + encodeURIComponent(tab.url) });
    window.close();
  };
  // Detect with AI asks Gemini with the key the library's page handed over (profileKeys, by Google's address), or one typed here before the popup had no place for it
  const hasGeminiKey = async () => {
    const { profileKeys, geminiApiKey } = await ext.storage.local.get(["profileKeys", "geminiApiKey"]);
    return !!((profileKeys && profileKeys[GEMINI_KEY_BASE]) || geminiApiKey);
  };
  let keyHere = false; // (known before a click: the browser's question below has to come first in it)
  const showKeyNote = async () => { keyHere = await hasGeminiKey(); $("geminiNote").hidden = keyHere; };
  showKeyNote();
  ext.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.profileKeys || changes.geminiApiKey)) showKeyNote(); });
  $("detectBtn").onclick = async () => {
    if (!keyHere) { $("geminiNote").hidden = false; return; }
    // what is found is saved as this site's rule, and a rule does nothing until the browser lets the extension read the site. Asked first, before anything
    // is waited for: Firefox asks only straight from the click (after an await it refuses, even a site already allowed).
    const granted = await ext.permissions.request({ origins: ["https://*." + hostname + "/*"] }).catch(() => false);
    if (!granted) {
      $("detInfo").textContent = "Not run: the browser did not give permission to read " + hostname + ", and what is found there would not be used.";
      return;
    }
    await ext.runtime.sendMessage({ type: "startDetect", tabId: tab.id });
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
  $("novelPickBtn").onclick = picker("novel");
  $("novelEditBtn").onclick = makeEditable(novelNameEl, (value) => setInBucket("novelOverrides", hostname, value));
  $("novelDefaultBtn").onclick = async () => {
    await setInBucket("novelOverrides", hostname, null);
    await setInBucket("novelSelectors", hostname, null);
    location.reload();
  };

  // ---------- header: the chapter's title ----------
  const pageInfo = await runInTab(null, () => ({
    title: document.title,
    ogSiteName: document.querySelector('meta[property="og:site_name"]')?.content || null,
    hostname: location.hostname.replace(/^www\./, "")
  })).catch(() => null);
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
    googleTranslate(pageTitleRaw).then((t) => { pageTitleEl.textContent = t; });
  }
  $("pickTitleBtn").onclick = picker("title");
  $("titleEditBtn").onclick = makeEditable(pageTitleEl, (value) => setInBucket("titleOverrides", tab.url, value));
  $("titleDefaultBtn").onclick = async () => {
    await setInBucket("titleOverrides", tab.url, null);
    await setInBucket("titleSelectors", hostname, null);
    location.reload();
  };

  // ---------- Novel: where each part is, and whether it is on this page ----------
  {
    const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
    // (a site with only the book's parts saved, from "Detect with AI" on its book's page, has no chapter rule: its saved parts are shown the same)
    const saved = Object.values((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {}).find((e) => e && e.enabled !== false && e.spec && UserRules.cleanHost(e.spec.host) === hostname);
    const partsRule = rule || (saved && (saved.spec.book || saved.spec.toc) ? { book: saved.spec.book, toc: saved.spec.toc } : null);
    const book = (partsRule && partsRule.book) || {};
    const toc = (partsRule && partsRule.toc) || {};
    const contentSelectors = await getBucket("contentSelectors");
    const sel = {
      title: str(book.title), author: str(book.author), description: str(book.description), cover: str(book.cover),
      list: str(toc.list), listBuiltIn: !!(toc.list || toc.boxes || toc.parse) && !str(toc.list),
      chapterTitle: str(titleSelectors[hostname]), content: str(contentSelectors[hostname]) || str(rule && rule.selector)
    };
    // Run in the page: for each part, what is there (the rule's selector, else the standard novel metadata many sites carry).
    const probe = (s, generic, minLen) => {
      const pick = (q) => { try { return q ? document.querySelector(q) : null; } catch (e) { return null; } };
      const text = (n) => (n ? (n.innerText || n.textContent || "").trim().replace(/\s+/g, " ") : "");
      const meta = (p) => (document.querySelector('meta[property="' + p + '"]') || {}).content || "";
      const part = (q, metaName) => {
        const n = pick(q);
        if (n) return { found: true, how: "rule", text: text(n).slice(0, 120) };
        const m = metaName && meta(metaName);
        if (m) return { found: true, how: "metadata", text: m.trim().slice(0, 120) };
        return { found: false, how: q ? "rule" : "" };
      };
      const coverNode = pick(s.cover);
      const cover = coverNode
        ? { found: true, how: "rule", text: (coverNode.getAttribute("src") || coverNode.getAttribute("data-src") || (coverNode.querySelector("img") || {}).src || "").slice(0, 120) }
        : meta("og:image") ? { found: true, how: "metadata", text: meta("og:image").slice(0, 120) } : { found: false, how: s.cover ? "rule" : "" };
      let list = { found: false, how: s.list ? "rule" : "" };
      if (s.list) { try { const n = document.querySelectorAll(s.list).length; if (n) list = { found: true, how: "rule", text: n + " chapter links" }; } catch (e) { /* a bad selector */ } }
      const titleNode = pick(s.chapterTitle);
      const chapterTitle = titleNode ? { found: true, how: "picked", text: text(titleNode).slice(0, 120) } : { found: !!document.title, how: "page title", text: document.title.slice(0, 120) };
      let content = { found: false, how: "" };
      const c = pick(s.content);
      if (c && text(c).length >= minLen) content = { found: true, how: "rule", text: s.content + " · " + text(c).length + " characters" };
      else {
        const mapped = (window.SITE_CONTENT_SELECTORS || {})[location.hostname.replace(/^www\./, "")];
        for (const q of [mapped].concat(generic)) {
          const n = pick(q);
          if (n && text(n).length >= minLen) { content = { found: true, how: "guess", text: q + " · " + text(n).length + " characters" }; break; }
        }
      }
      // a link to the novel's own page (its details and list), from a chapter's page
      let bookLink = "";
      for (const a of document.querySelectorAll("a[href]")) {
        if (/^(返回书页|返回書頁|书页|書頁|目录|目錄|章节目录|章節目錄|Table of Contents|Index|Novel Info|Book Info)$/i.test(text(a))) { bookLink = a.href; break; }
      }
      return {
        title: part(s.title, "og:novel:book_name"), author: part(s.author, "og:novel:author"), description: part(s.description, "og:description"), cover, list, chapterTitle, content, bookLink,
        readUrl: meta("og:novel:read_url")
      };
    };
    const found = await runInTab(["site-selectors.js"], probe, [sel, GENERIC_SELECTORS, MIN_CONTENT_LENGTH]).catch(() => null);
    const rawVar = await detectRawVarPresent().catch(() => false);
    const listEl = $("detList");
    const info = $("detInfo");
    if (!found) {
      listEl.textContent = "This page can't be looked at (the browser keeps the extension out of it).";
    } else {
      if (rawVar) found.content = { found: true, how: "page data", text: "the page's own txt_content (more reliable than its elements)" };
      if (!found.list.found && sel.listBuiltIn) found.list = { found: true, how: "rule", text: "read by the site's built-in rule" };
      if (!found.list.found && found.readUrl) found.list = { found: false, how: "", text: "on the list page", link: found.readUrl };
      const rows = [
        ["Title", found.title, "booktitle"], ["Chapter list", found.list, "toclist"], ["Cover", found.cover, "bookcover"], ["Author", found.author, "bookauthor"],
        ["Synopsis", found.description, "bookdescription"], ["Chapter name", found.chapterTitle, "title"], ["Content location", found.content, "content"]
      ];
      listEl.replaceChildren();
      for (const [label, r, field] of rows) {
        const d = document.createElement("div");
        d.className = "det";
        const mark = Object.assign(document.createElement("span"), { className: "mark " + (r.found ? "ok" : "no"), textContent: r.found ? "✓" : "✗" });
        const name = Object.assign(document.createElement("span"), { textContent: label });
        const val = Object.assign(document.createElement("span"), { className: "val", textContent: r.found ? (r.how === "metadata" ? "from the page's metadata: " : "") + (r.text || "") : r.text || "not on this page", title: r.text || "" });
        // the book's parts are saved in this site's rule: only a site the extension may read (one with a rule) can have them
        const needsRule = field !== "title" && field !== "content";
        const pick = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: "⌖", title: "Click the " + label.toLowerCase() + " on the page", disabled: needsRule && !partsRule });
        pick.onclick = picker(field);
        d.append(mark, name, val, pick);
        listEl.appendChild(d);
      }
      const isChapter = found.content.found;
      const bookParts = [found.title, found.cover, found.author, found.description].filter((x) => x.found).length;
      const where = found.bookLink || found.readUrl;
      info.replaceChildren();
      if (!partsRule) info.append("This site has no rule yet: press “Site rule…” (or “Detect with AI”) first, then the book's parts can be picked.");
      else if (!rule) info.append("Saved for this site: " + (Object.keys(book).join(", ") || "no book parts") + (toc.list ? ", chapter list" : "") + ". The extension reads this book's details from them; it reads no chapters here until the site has a chapter rule (Site rule…).");
      else if (isChapter && bookParts < 2) {
        info.append("This is a chapter's page: the novel's title, cover, author and synopsis are read on the novel's own page. ");
        if (where) {
          const a = Object.assign(document.createElement("a"), { href: where, textContent: "Open the novel's page" });
          a.onclick = (e) => { e.preventDefault(); ext.tabs.update(tab.id, { url: where }); window.close(); };
          info.append(a, " to record them.");
        } else info.append("Open it to record them.");
      } else if (bookParts >= 2) info.append("This is the novel's page" + (found.list.found ? "" : ": pick its chapter list if it is here") + ". Pick any part that is missing or wrong: it is saved for this site and the novel is recorded again.");

      // "Refresh details": the novel's page is read again and the result kept in the library (what the library site's button of the same name asks this
      // extension to do). The page is: a site novel's own page, this page when it is the novel's, else the link to it from a chapter's page.
      const wtrNovel = /^https:\/\/wtr-lab\.com\/[a-z-]+\/novel\/\d+\/[^/?#]+/.exec(tab.url);
      const bookUrl = wtrNovel ? wtrNovel[0] : isChapter ? where || "" : bookParts >= 2 ? tab.url.split("#")[0] : "";
      const detailsBtn = $("detailsBtn");
      const detailsNote = $("detailsNote");
      detailsBtn.disabled = !bookUrl || (!rule && !partsRule && !wtrNovel);
      if (!bookUrl) detailsNote.textContent = "Open the novel's page (not a chapter's) to read its details again.";
      detailsBtn.onclick = async () => {
        detailsBtn.disabled = true;
        detailsNote.textContent = "Asking for access to " + new URL(bookUrl).hostname + "…";
        const asked = SiteAccess.request([SiteAccess.patternOf(bookUrl)], ext); // (straight from the click, before anything is waited for: Firefox asks only then)
        try {
          if (!(await asked) && !(await SiteAccess.has(bookUrl, ext))) throw new Error(new URL(bookUrl).hostname + " is not allowed");
          detailsNote.textContent = "Reading the novel's page…";
          await host("work", { key: "translation:" + bookUrl + "#details", meta: { novelName: novelNameEl.textContent || novelNameRaw || "" } });
          detailsNote.textContent = "Details refreshed. They are in your library.";
        } catch (e) {
          detailsNote.textContent = "Could not refresh: " + e.message;
        }
        detailsBtn.disabled = false;
      };
    }
  }
})();
