// Translate ahead: the popup's switch on a chapter's Translate card (text and pictures). Off until Translate is pressed with it on; from then on the tab is followed:
// the next pages (whatever is behind the page's Next link: a chapter of text, a chapter of pictures, one picture of a reader as nhentai.net/g/<id>/21/ -> 22, 23) are
// translated before they are opened, and each page of the site the tab goes on to (loaded, or shown in place by the site's script) is shown translated, made ahead or
// made then, with the ones after it made ahead in turn. Nothing goes into the library: the text is kept for the session (storage.session), the pictures in the comic host.
// It ends when the switch is turned off, the pill's ✕ is pressed, the tab goes to another site, or it is closed.
//   pictures: comic-host.js makes them (op "translate": the page shown; op "ahead": the next ones), comic-page.js in the tab finds the pages ahead and their pictures
//   text: content.js finds the next pages and their text; the translations are made here (deps.translateText) and kept by address
// Runs in the background (Chrome's service worker, Firefox's background page), started with what the browser's own does differently:
//   TranslateAhead.start({ translateTab(tabId, opts), translateText(job), run(tabId, func), files(tabId, files), comic(op, msg) })
//   TranslateAhead.answer(message, sender) -> a promise of the answer, or undefined when the message is not one of these
var TranslateAhead = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const COUNT = 2; // pages ahead
  const SESSIONS = "aheadSessions", TEXTS = "aheadTexts";
  const MAX_TEXTS = 16;
  const sessions = new Map(); // tab -> { kind: "text" | "pictures", pay, host, images (the site's rule's pictures selector), where (where the pictures are), at }
  const texts = new Map(); // a page's address -> { promise } while it is translated, then { result, at }
  const timers = new Map(); // tab -> the wait before going on to the page it is on now (a page shown in place is drawn a moment after its address changes)
  let deps = null;
  const store = () => (ext.storage && ext.storage.session) || null; // (Chrome's service worker sleeps: what it knows is kept there while the browser is open)
  const bare = (u) => String(u || "").split("#")[0].replace(/\/+$/, "");
  const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ""; } };

  let loaded = null;
  function load() {
    return loaded || (loaded = (async () => {
      const s = store();
      if (!s) return;
      const got = await s.get([SESSIONS, TEXTS]).catch(() => ({}));
      for (const [id, v] of Object.entries(got[SESSIONS] || {})) if (!sessions.has(Number(id))) sessions.set(Number(id), v);
      for (const [u, r] of Object.entries(got[TEXTS] || {})) if (!texts.has(u)) texts.set(u, { result: r, at: r.at || 0 });
    })());
  }
  const saveSessions = () => { const s = store(); if (s) s.set({ [SESSIONS]: Object.fromEntries(sessions) }).catch(() => {}); };
  function saveTexts() {
    const done = [...texts].filter(([, t]) => t.result).sort((a, b) => b[1].at - a[1].at);
    for (const [u] of done.slice(MAX_TEXTS)) texts.delete(u);
    const s = store();
    if (s) s.set({ [TEXTS]: Object.fromEntries(done.slice(0, MAX_TEXTS).map(([u, t]) => [u, Object.assign({}, t.result, { at: t.at })])) }).catch(() => {});
  }

  async function begin(tabId, o) {
    await load();
    const had = sessions.get(tabId);
    const kind = o.kind === "pictures" ? "pictures" : "text";
    const host = hostOf(o.url);
    sessions.set(tabId, { kind, pay: String(o.pay || "key"), host, images: String(o.images || ""), where: (had && had.kind === kind && had.host === host && had.where) || "", at: bare(o.url) });
    saveSessions();
  }
  async function end(tabId) {
    await load();
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
    const s = sessions.get(tabId);
    if (!s) return;
    sessions.delete(tabId);
    saveSessions();
    if (s.kind === "pictures" && deps) deps.comic("drop", { tabId }).catch(() => {});
  }

  // who pays for the pictures, as the library's page handed it over (profile-translate.js keeps it), the way the popup asks
  async function payment(s) {
    const st = await ext.storage.local.get(["profileKeys", "playgroundToken", "modelRules", "comicPrompts", "devOpenRouter"]);
    return { pay: s.pay === "tickets" || s.pay === "rules" ? s.pay : "key", keys: st.profileKeys || {}, token: String(st.playgroundToken || ""), rules: st.modelRules || {}, prompts: st.comicPrompts || {}, into: "English", openrouter: st.devOpenRouter || undefined };
  }

  // A page's text, translated once (asked again while it is being made: the same answer)
  function textOf(url, job, pay, fresh) {
    const key = bare(url);
    const have = texts.get(key);
    if (have && fresh && have.result) texts.delete(key);
    else if (have) return have.result ? Promise.resolve(have.result) : have.promise;
    const promise = Promise.resolve(deps.translateText({ text: String(job.text || "").slice(0, 20000), glossary: Array.isArray(job.glossary) ? job.glossary : [], url, title: String(job.title || ""), pay }))
      .then((r) => {
        if (!r || r.error || !r.translated) { if (texts.get(key) && texts.get(key).promise === promise) texts.delete(key); return { error: (r && r.error) || "the translator gave nothing" }; }
        const result = { translated: r.translated, suggestions: r.suggestions || [], language: r.language || "", model: r.model || null, tickets: r.tickets || 0 };
        texts.set(key, { result, at: Date.now() });
        saveTexts();
        return result;
      }, (e) => { texts.delete(key); return { error: String((e && e.message) || e) }; });
    texts.set(key, { promise, at: Date.now() });
    return promise;
  }

  // The tab, on a page of the site: its scripts put in (what is not there yet), then told to show this page and look ahead (only: just look ahead, this page is done)
  async function goOn(tabId, s, only) {
    if (s.kind === "text") return deps.translateTab(tabId, { keepNothing: true, pay: s.pay, ahead: { count: COUNT, auto: !only } });
    const has = await deps.run(tabId, () => ({ page: !!window.__p2preadComicPage, next: typeof NextPage !== "undefined", pics: typeof ImageChapter !== "undefined" })).catch(() => null);
    if (!has) return;
    const files = [];
    if (!has.pics) files.push("image-chapter.js");
    if (!has.next) files.push("next-page.js");
    if (!has.page) {
      await deps.run(tabId, () => { window.__P2PREAD_COMIC_URLS__ = null; }); // (comic-page.js finds this page's pictures itself)
      files.push("comic-page.js");
    }
    if (files.length) await deps.files(tabId, files);
    await ext.tabs.sendMessage(tabId, { type: only ? "comic:ahead" : "comic:continue", count: COUNT, where: s.where || "", images: s.images || "" }).catch(() => {});
  }

  // A tab with Translate ahead on went to another address (or finished loading one): another site ends it; a page of the same site is gone on to once it is there
  function onUpdated(tabId, info, tab) {
    if (!info || (!info.url && info.status !== "complete")) return;
    load().then(() => {
      const s = sessions.get(tabId);
      if (!s) return;
      const url = (tab && tab.url) || info.url || "";
      if (url && hostOf(url) !== s.host) return void end(tabId);
      clearTimeout(timers.get(tabId));
      timers.set(tabId, setTimeout(async () => {
        timers.delete(tabId);
        const now = sessions.get(tabId);
        const t = await ext.tabs.get(tabId).catch(() => null);
        if (!now || !t || t.status !== "complete" || hostOf(t.url) !== now.host) return; // (still loading: its "complete" comes)
        now.at = bare(t.url);
        saveSessions();
        goOn(tabId, now, false).catch(() => {});
      }, 700));
    });
  }

  function answer(message, sender) {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("ahead:")) return;
    const fromTab = !!(sender && sender.tab && !String(sender.url || "").startsWith(ext.runtime.getURL("")));
    const tabId = fromTab ? sender.tab.id : Number(message.tabId);
    return load().then(async () => {
      // the popup: Translate pressed with the switch on (a comic: the page is being made, the pages ahead are looked for now; a text chapter starts with translateTab)
      if (message.type === "ahead:start" && !fromTab && Number.isInteger(tabId)) {
        const tab = await ext.tabs.get(tabId).catch(() => null);
        if (!tab) return { error: "no such tab" };
        await begin(tabId, { kind: message.kind, pay: message.pay, url: tab.url, images: message.images });
        await goOn(tabId, sessions.get(tabId), true).catch(() => {});
        return { ok: true };
      }
      // the switch turned off (every tab), or the pill's ✕ (its own)
      if (message.type === "ahead:stop") {
        if (fromTab) await end(tabId);
        else for (const id of [...sessions.keys()]) await end(id);
        return { ok: true };
      }
      if (message.type === "ahead:on" && !fromTab) return { on: sessions.has(tabId) };
      const s = fromTab ? sessions.get(tabId) : null;
      // a page's text made ahead, or being made: { translated, ... } when there is one (peek: not waited for: { state: "running" })
      if (message.type === "ahead:textGet" && fromTab) {
        const have = texts.get(bare(message.url));
        if (!have) return { state: "none" };
        if (have.result) return have.result;
        return message.peek ? { state: "running" } : have.promise;
      }
      if (!s) return { error: "Translate ahead is off in this tab" };
      // a text page to translate (this one, or one ahead): its translation, when wait
      if (message.type === "ahead:text" && s.kind === "text") {
        const p = textOf(String(message.url || ""), message, s.pay, !!message.fresh);
        return message.wait ? p : { ok: true };
      }
      if (message.type === "ahead:show" && s.kind === "pictures" && Array.isArray(message.urls)) {
        return deps.comic("translate", Object.assign({ tabId, urls: message.urls.slice(0, 400), referer: String(message.referer || sender.tab.url || "") }, await payment(s)));
      }
      if (message.type === "ahead:pictures" && s.kind === "pictures" && Array.isArray(message.pages)) {
        if (message.where && typeof message.where === "string" && message.where.length < 300) { s.where = message.where; saveSessions(); }
        return deps.comic("ahead", Object.assign({ tabId, pages: message.pages.slice(0, 5) }, await payment(s)));
      }
      return { error: "not understood" };
    });
  }

  function start(d) {
    deps = d;
    ext.tabs.onUpdated.addListener(onUpdated);
    ext.tabs.onRemoved.addListener((tabId) => { load().then(() => end(tabId)); });
    load();
  }

  return { start, answer, begin, end, COUNT };
})();
