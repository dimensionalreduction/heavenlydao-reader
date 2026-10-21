// The popup once this extension is a device of your library (popup-lock.js shows only the passphrase and Join before): a header with the
// novel and chapter of the page in front of you (and "Library copy": whether the novels you open are recorded in your library), and five tabs:
//   Read     what the chapter footer does on the library site: fetch the next chapters' text, translate the next ones, Gemini's notes
//   Novel    where this site keeps each part of a novel (title, chapter list, cover...), whether it is found on this page, the picker, AI detection
//   Gemini   the API key, the model, the prompts
//   Terms    the saved glossaries (one can be used for this novel) and the terms you made in the library's reader
//   Library  your library (popup-library.js: its devices, letting one in), its numbers, the passphrase
(async function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  const GENERIC_SELECTORS = ["article", "main", "#content", ".content", ".chapter-content", ".read-content", ".readcontent", "#chaptercontent"];
  const RAW_TEXT_VAR_CANDIDATES = ["txt_content"];
  const MIN_CONTENT_LENGTH = 200;
  const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.5-pro"];
  const $ = (id) => document.getElementById(id);

  // ---------- tabs (the one last open is opened again) ----------
  const tabButtons = [...document.querySelectorAll(".tabs button")];
  function showPane(name) {
    for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.pane === name));
    for (const p of document.querySelectorAll(".pane")) p.hidden = p.id !== "pane-" + name;
    try { localStorage.setItem("popupPane", name); } catch (e) { /* (a private window) */ }
  }
  for (const b of tabButtons) b.onclick = () => showPane(b.dataset.pane);
  for (const b of document.querySelectorAll("[data-goto]")) {
    b.onclick = () => {
      showPane(b.dataset.goto);
      const d = b.dataset.prompt && $("prompt-" + b.dataset.prompt); // a ⚙ opens its own prompt
      if (d) { d.open = true; d.scrollIntoView({ block: "nearest" }); }
    };
  }
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

  // The rules (built-in, and the person's own on top) as the engine sees them, for the Novel tab and for what the Read tab can fetch.
  UserRules.apply((await ext.storage.local.get(UserRules.KEY))[UserRules.KEY] || {});
  const rule = onPage ? RawSources.ruleFor(tab.url) : null;
  const hostname = onPage ? new URL(tab.url).hostname.replace(/^www\./, "") : "";

  // ---------- sites to allow ----------
  // No novel site is allowed at install: the browser's own question is asked here, by a click, the first time a site is needed (site-access.js). The bar lists the page's
  // site, when it is one the extension reads and is not allowed yet, and the sites something already asked for (a watch, the library site).
  const accessBar = $("accessBar");
  let pageAllowed = true; // (whether the page's site is allowed or needs no permission: a click on Fetch asks first when not)
  async function renderAccess() {
    const wanted = new Map(); // permission pattern -> host
    for (const p of await SiteAccess.pending(ext)) wanted.set(p.pattern, p.host);
    pageAllowed = true;
    if (onPage && (rule || hostname === "wtr-lab.com") && !(await SiteAccess.has(tab.url, ext))) {
      pageAllowed = false;
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
  const chapterKey = onPage ? "translation:" + new URL(tab.url).origin + new URL(tab.url).pathname : ""; // (content.js keeps a page's translation under this)

  // ---------- Gemini: key, model, prompts (no page needed) ----------
  const modelSelect = $("modelSelect");
  (async () => {
    let models = [];
    try {
      const res = await ext.runtime.sendMessage({ type: "listModels" });
      models = (res && res.models) || [];
    } catch (e) {
      models = [];
    }
    if (!models.length) models = FALLBACK_MODELS;
    const { selectedModel } = await ext.storage.local.get("selectedModel");
    modelSelect.replaceChildren(...models.map((m) => Object.assign(document.createElement("option"), { value: m, textContent: m })));
    // (none chosen: the extension's own default is what is used, so that is what is shown; nothing is saved until one is picked)
    modelSelect.value = selectedModel && models.includes(selectedModel) ? selectedModel : models.includes(GEMINI_MODEL) ? GEMINI_MODEL : models[0];
    modelSelect.onchange = () => { ext.storage.local.set({ selectedModel: modelSelect.value }); Promise.resolve(ext.runtime.sendMessage({ type: "model:set", model: modelSelect.value })).catch(() => {}); }; // (also the library's setting: every device and the site use it)
  })();

  const apiKeyBtn = $("apiKeyBtn");
  async function refreshApiKeyBtn() {
    const { geminiApiKey } = await ext.storage.local.get("geminiApiKey");
    apiKeyBtn.textContent = geminiApiKey ? "🔑 API key ✓" : "🔑 Add API key";
    apiKeyBtn.title = geminiApiKey ? "Change or clear your Gemini API key" : "Add your Gemini API key";
  }
  await refreshApiKeyBtn();
  apiKeyBtn.onclick = () => {
    const input = Object.assign(document.createElement("input"), { type: "password", className: "edit-input", placeholder: "Gemini API key" });
    apiKeyBtn.replaceWith(input);
    ext.storage.local.get("geminiApiKey").then(({ geminiApiKey }) => { input.value = geminiApiKey || ""; });
    input.focus();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const value = input.value.trim();
        if (value) await ext.storage.local.set({ geminiApiKey: value });
        else await ext.storage.local.remove("geminiApiKey");
        await refreshApiKeyBtn();
      }
      input.replaceWith(apiKeyBtn);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
  };

  // The prompts (gemini.js GEMINI_PROMPT_PRESETS and the ones saved in the library's Settings › Translation › Gemini prompts; the extension keeps a copy of what the
  // library has in "geminiPromptSets", and "geminiPrompts" from before there were sets): listed here, the one in use marked, each shown as it is when its name is clicked.
  // They are changed and picked in the library's settings, not here.
  {
    const LABELS = { translate: "Translation", notes: "Gemini notes", detect: "Detect with AI" };
    const box = $("prompts");
    const open = new Set(); // (kept open when the list is drawn again)
    const drawPrompts = async () => {
      const kept = await ext.storage.local.get(["geminiPromptSets", "geminiPrompts"]);
      const sets = kept.geminiPromptSets || {};
      const legacy = kept.geminiPrompts || {};
      box.replaceChildren(...Object.entries(LABELS).map(([name, label]) => {
        const entry = sets[name];
        const all = GEMINI_PROMPT_PRESETS[name].concat((entry && Array.isArray(entry.mine) ? entry.mine : []).map((p) => ({ id: p.id, name: p.name, text: p.text, mine: true })));
        const active = entry && all.find((p) => p.id === entry.active);
        const inUse = active || (typeof legacy[name] === "string" && legacy[name].trim() ? { id: "", name: "Yours", text: legacy[name], mine: true } : all[0]);
        const state = Object.assign(document.createElement("span"), { className: "subtitle", textContent: inUse.name });
        const summary = document.createElement("summary");
        summary.append(Object.assign(document.createElement("span"), { textContent: label }), state);
        const area = Object.assign(document.createElement("textarea"), { className: "edit-input", readOnly: true, spellcheck: false, value: inUse.text });
        const list = document.createElement("div");
        list.className = "prompt-list";
        const rows = inUse.id || all.includes(inUse) ? all : all.concat([inUse]); // (one from before there were sets has no id: listed as "Yours")
        list.append(...rows.map((p) => {
          const row = Object.assign(document.createElement("button"), { type: "button", className: "icon-btn", textContent: p.name + (p === inUse ? " ✓" : ""), title: p.about || "" });
          row.onclick = () => { area.value = p.text; };
          return row;
        }));
        const d = Object.assign(document.createElement("details"), { className: "prompt", id: "prompt-" + name });
        d.open = open.has(name);
        d.ontoggle = () => { if (d.open) open.add(name); else open.delete(name); };
        d.append(summary, list, area);
        return d;
      }));
    };
    drawPrompts();
    ext.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.geminiPromptSets || changes.geminiPrompts)) drawPrompts(); });
  }

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

  // ---------- Terms: glossaries (one can be used for this novel), and the terms you made ----------
  {
    const bindKey = onPage ? WtrTerms.bindingKey(tab.url) : "";
    const searchEl = $("libSearch");
    const resultsEl = $("libResults");
    const appliesEl = $("libApplies");
    appliesEl.textContent = bindKey ? "“Use here” applies to: " + bindKey : "Open a novel's page to use a glossary for it.";
    async function renderLibrary() {
      const { glossaryLibrary = {}, glossaryBindings = {} } = await ext.storage.local.get(["glossaryLibrary", "glossaryBindings"]);
      const bound = new Set(bindKey ? WtrTerms.bindingIds(glossaryBindings[bindKey]) : []);
      const query = searchEl.value.trim();
      const hits = WtrTerms.search(glossaryLibrary, query).slice(0, 8);
      resultsEl.textContent = "";
      if (!Object.keys(glossaryLibrary).length) return (resultsEl.textContent = "Nothing saved yet. Open a novel on the site and its glossary is saved automatically.");
      if (!hits.length) return (resultsEl.textContent = 'No saved glossary matches "' + query + '".');
      for (const g of hits) {
        const r = document.createElement("div");
        r.className = "row";
        const left = Object.assign(document.createElement("div"), { textContent: g.name + " (" + g.terms.length + ")", title: g.name + ": " + g.terms.length + " terms, saved " + new Date(g.updatedAt).toLocaleString() });
        left.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px;";
        const isBound = bound.has(g.id);
        const btn = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: isBound ? "✓ Using · Remove" : "Use here", disabled: !bindKey,
          title: isBound ? "Stop using this glossary for this novel" : "Use this glossary when translating this novel" });
        btn.onclick = async () => {
          const { glossaryBindings: current = {} } = await ext.storage.local.get("glossaryBindings");
          const ids = new Set(WtrTerms.bindingIds(current[bindKey]));
          if (isBound) ids.delete(g.id);
          else ids.add(g.id);
          btn.disabled = true;
          const reply = await ext.runtime.sendMessage({ type: "glossary:bind", key: bindKey, ids: [...ids] });
          if (!reply || !reply.ok) appliesEl.textContent = "Couldn't save: " + ((reply && reply.error) || "no answer from the extension");
          renderLibrary();
        };
        r.append(left, btn);
        resultsEl.appendChild(r);
      }
    }
    searchEl.oninput = renderLibrary;
    renderLibrary();

    const termsEl = $("myTermsList");
    async function renderMyTerms() {
      const { myTerms = [], glossaryBindings = {} } = await ext.storage.local.get(["myTerms", "glossaryBindings"]);
      const here = onPage ? WtrTerms.myTermEntries(myTerms, tab.url, glossaryBindings) : [];
      const all = Array.isArray(myTerms) ? myTerms.length : 0;
      termsEl.replaceChildren();
      if (!all) return (termsEl.textContent = "None yet. In the library's reader, select text and press “+ Add Term”.");
      for (const t of here.slice(0, 30)) {
        const r = document.createElement("div");
        r.className = "term";
        r.append(Object.assign(document.createElement("span"), { textContent: t.terms.join(" / ") }), Object.assign(document.createElement("span"), { className: "to", textContent: t.translation }));
        termsEl.appendChild(r);
      }
      termsEl.appendChild(Object.assign(document.createElement("div"), { className: "subtitle",
        textContent: (onPage ? here.length + " for this novel (and every novel's) · " : "") + all + " in all. Add or change them in the library's reader." }));
    }
    renderMyTerms();
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.glossaryLibrary || changes.glossaryBindings) renderLibrary();
      if (changes.myTerms || changes.glossaryBindings) renderMyTerms();
    });
  }

  // ---------- the page: nothing more without one ----------
  const novelNameEl = $("novelName");
  const pageTitleEl = $("pageTitle");
  const readNote = $("readNote");
  if (!onPage) {
    pageTitleEl.textContent = "Not a page of a site";
    for (const id of ["novelPickBtn", "novelEditBtn", "novelDefaultBtn", "pickTitleBtn", "titleEditBtn", "titleDefaultBtn", "showOriginalBtn", "fetchBtn", "translateBtn", "notesBtn", "detectBtn", "siteRuleBtn"]) $(id).disabled = true;
    $("detList").textContent = "Open a novel's page or one of its chapters.";
    return;
  }

  // The page where the person adds a rule of their own for this site (it opens with the site's address filled in).
  $("siteRuleBtn").onclick = () => {
    ext.tabs.create({ url: ext.runtime.getURL("rules.html") + "?url=" + encodeURIComponent(tab.url) });
    window.close();
  };
  $("detectBtn").onclick = async () => {
    // what is found is saved as this site's rule, and a rule does nothing until the browser lets the extension read the site (asked first: it needs this click)
    const granted = await ext.permissions.request({ origins: ["https://*." + hostname + "/*"] }).catch(() => false);
    if (!granted) {
      $("detInfo").textContent = "Not run: the browser did not give permission to read " + hostname + ", and what is found there would not be used.";
      return;
    }
    await ext.runtime.sendMessage({ type: "startDetect", tabId: tab.id });
    window.close();
  };
  // A plain reload is simpler and more reliable than messaging content.js to undo its in-place edit: it always gives the true original page.
  $("showOriginalBtn").onclick = async () => {
    await ext.tabs.reload(tab.id);
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

  // ---------- Read: fetch, translate, notes (how many after this chapter: remembered) ----------
  {
    const saved = await ext.storage.local.get(["fetchAhead", "prefetchAhead", "notesAhead"]);
    const nums = { fetchN: ["fetchAhead", 5, 50], translateN: ["prefetchAhead", 0, 20], notesN: ["notesAhead", 0, 10] };
    for (const [id, [key, dflt, max]] of Object.entries(nums)) {
      const input = $(id);
      input.value = Number.isFinite(saved[key]) ? saved[key] : dflt;
      input.onchange = () => {
        const n = Math.max(0, Math.min(max, parseInt(input.value, 10) || 0));
        input.value = n;
        ext.storage.local.set({ [key]: n });
      };
    }
    const count = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
    const meta = () => ({ novelName: novelNameEl.textContent || novelNameRaw || "", pageTitle: pageTitleEl.textContent || pageTitleRaw || "" });
    const fetchBtn = $("fetchBtn");
    if (!rule) {
      fetchBtn.disabled = true;
      fetchBtn.title = "This site has no rule, so the extension cannot read its chapters by itself: add one on the Novel tab";
    }
    fetchBtn.onclick = async () => {
      const n = count("fetchN");
      fetchBtn.disabled = true;
      if (!pageAllowed && !(await SiteAccess.request([SiteAccess.patternOf(tab.url)], ext))) { // (the browser asks: this click is what it needs)
        readNote.textContent = "Not fetched: " + hostname + " is not allowed";
        fetchBtn.disabled = false;
        return;
      }
      pageAllowed = true;
      renderAccess();
      readNote.textContent = "Fetching this chapter…";
      try {
        await host("work", { key: chapterKey + "#original", meta: { ...meta(), ahead: n } });
        readNote.textContent = "This chapter's text is in your library" + (n ? "; the next " + n + " are being fetched (the site's Activity page shows them)." : ".");
      } catch (e) {
        readNote.textContent = "Not fetched: " + e.message;
      }
      fetchBtn.disabled = false;
    };
    $("translateBtn").onclick = async () => {
      await ext.storage.local.set({ prefetchAhead: count("translateN") }); // (content.js translates that many after this one)
      $("translateBtn").disabled = true;
      $("translateBtn").textContent = "Translating…";
      await ext.runtime.sendMessage({ type: "translateTab", tabId: tab.id });
      window.close();
    };
    const notesBtn = $("notesBtn");
    notesBtn.onclick = async () => {
      notesBtn.disabled = true;
      readNote.textContent = "Asking Gemini for this chapter's notes…";
      try {
        await host("work", { key: chapterKey + "#notes", meta: { ...meta(), notes: 1, force: true, ahead: count("notesN") } });
        readNote.textContent = "Gemini's notes are being written" + (count("notesN") ? ", for this chapter and the next " + count("notesN") + " translated ones" : "") + ". They show on the library site.";
      } catch (e) {
        readNote.textContent = "No notes: " + e.message + (/English text/.test(e.message) ? ". Translate it first." : "");
      }
      notesBtn.disabled = false;
    };
  }

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
    }
  }
})();
