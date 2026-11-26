importScripts("pay.js", "p2p-core.js", "term-match.js", "google-chapter.js", "gemini.js", "site-matches.js", "site-access.js", "referer.js", "image-chapter.js", "picture-limit.js", "access-offer.js", "fish-speech.js", "glossary-server.js", "wtr-terms.js", "base-glossary.js", "term-pool.js", "pool-hints.js", "pool-share.js", "raw-sources.js", "user-rules.js", "term-notes.js", "profile-model.js", "profile-translate.js", "lang-detect.js", "original-translate.js", "watcher.js", "book-visit.js", "notice-bg.js", "translate-ahead.js");
UserRules.start(chrome); // the rules the person added: read from storage here, handed to the offscreen document below

const RAW_TEXT_VAR_CANDIDATES = ["txt_content"];

function hostnameOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

// Note: with a default_popup set, action.onClicked never fires — the popup owns the click.
// The popup's "Translate this page" button sends {type:"translateTab", tabId} instead. opts: { keepNothing, pay } (a chapter's page: docs/ADD-BOOK.md),
// ahead: { count, auto } (Translate ahead: translate-ahead.js)
async function translateTab(tabId, opts = {}) {
  const tab = await chrome.tabs.get(tabId);
  const hostname = hostnameOf(tab.url);
  const { contentSelectors, novelSelectors, novelOverrides } = await chrome.storage.local.get([
    "contentSelectors",
    "novelSelectors",
    "novelOverrides"
  ]);
  const contentSelector = (contentSelectors || {})[hostname] || null;
  const novelSelector = (novelSelectors || {})[hostname] || null;
  const novelNameOverride = (novelOverrides || {})[hostname] || null;

  const { userRules } = await chrome.storage.local.get(UserRules.KEY);
  const [{ result: rawText } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (candidates) => {
      for (const name of candidates) {
        if (typeof window[name] === "string" && window[name].trim().length > 0) {
          return window[name];
        }
      }
      return null;
    },
    args: [RAW_TEXT_VAR_CANDIDATES]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text, contentSel, novelSel, novelName, rules, keepNothing, pay, ahead) => {
      window.__P2PREAD_KEEP_NOTHING__ = keepNothing;
      if (keepNothing) window.__P2PREAD_COMIC_URLS__ = null; // (the page's pill, comic-page.js, for a text chapter: content.js tells it how it goes)
      window.__P2PREAD_PAY__ = pay;
      window.__P2PREAD_AHEAD__ = ahead;
      window.__USER_RULES__ = rules;
      window.__GEMINI_PRECOLLECTED_TEXT__ = text;
      window.__GEMINI_CONTENT_SELECTOR_OVERRIDE__ = contentSel;
      window.__GEMINI_NOVEL_SELECTOR_OVERRIDE__ = novelSel;
      window.__GEMINI_NOVEL_NAME_OVERRIDE__ = novelName;
    },
    args: [rawText, contentSelector, novelSelector, novelNameOverride, userRules || {}, !!opts.keepNothing, ["tickets", "openrouter", "rules"].includes(opts.pay) ? opts.pay : "key", opts.ahead ? { count: Number(opts.ahead.count) || 0, auto: !!opts.ahead.auto } : null]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [...(opts.keepNothing ? ["comic-page.js"] : []), "site-selectors.js", "default-glossary.js", "wtr-terms.js", "raw-sources.js", "user-rules.js", "next-page.js", "terms.js", "content.js"]
  });
}

// A chapter's text translated as the popup's Translate asks (nothing kept), paid with the Gemini key ("key"), the OpenRouter key, or tickets
function translatePageText(m, keepNothing) {
  // (by the Translation rule's rows, Settings › Model rules: the popup no longer picks who pays)
  if (m.pay === "rules") return GlossaryServer.targetLanguage().catch(() => "en").then((lang) => ProfileTranslate.pageByRules(m.text, m.glossary, lang, m.url));
  if (m.pay === "tickets" || m.pay === "openrouter") {
    return GlossaryServer.targetLanguage().catch(() => "en").then((lang) => ProfileTranslate[m.pay === "tickets" ? "pageWithTickets" : "pageWithKey"](m.text, m.glossary, lang));
  }
  return chrome.storage.local.get("selectedModel").then(({ selectedModel }) =>
    TermNotes.translate({ text: m.text, glossary: m.glossary, model: selectedModel, url: m.url, title: m.title, novelName: m.novelName, keepNothing: !!keepNothing }));
}

// Translate ahead (translate-ahead.js): the next pages translated before they are opened, the tab followed to them
TranslateAhead.start({
  translateTab,
  translateText: (job) => translatePageText(job, true),
  run: (tabId, func) => chrome.scripting.executeScript({ target: { tabId }, func }).then(([r] = []) => r && r.result),
  files: (tabId, files) => chrome.scripting.executeScript({ target: { tabId }, files }),
  // (the comic host is the offscreen page)
  comic: async (op, msg) => { await ensureOffscreen(); return chrome.runtime.sendMessage(Object.assign({ target: "comic", op }, msg)); }
});

const bookAdds = new Map(); // tab -> the answer to the popup's Import to library, when the page says it has recorded the book
// a page of this extension (the popup, also when it is opened in a tab of its own), never a site's page
const ownPage = (sender) => !sender || !sender.tab || String(sender.url || "").startsWith(chrome.runtime.getURL(""));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => handleMessage(message, sender, sendResponse));

function handleMessage(message, sender, sendResponse) {
  if (!message) return;
  // the offscreen page (which fetches the sites) has no permissions or storage API: it asks here whether a site is allowed, and tells what it needs
  const access = SiteAccess.answerMessage(message);
  if (access) {
    access.then(sendResponse, () => sendResponse(null));
    return true;
  }
  // the offscreen page has no storage of its own: it asks here how much of the pictures to keep (picture-limit.js)
  if (message.type === "pictures:settings") {
    chrome.storage.local.get([PictureLimit.MAX_KEY]).then((s) => sendResponse({ maxGB: s[PictureLimit.MAX_KEY] }), () => sendResponse(null));
    return true;
  }
  // the offscreen page cannot set a request header: it asks here for the Referer a chapter's pictures are fetched with (referer.js)
  const referer = Referer.answerMessage(message);
  if (referer) {
    referer.then(sendResponse);
    return true;
  }
  // the Allow card in the library site's tab (access-offer.js)
  const offer = AccessOffer.answerMessage(message, sender);
  if (offer) {
    offer.then(sendResponse, () => sendResponse(null));
    return true;
  }
  // the library site's Listen tab, with Fish Audio and the person's own key (fish-speech.js)
  const fish = FishSpeech.answer(message, sender);
  if (fish) {
    fish.then(sendResponse);
    return true;
  }
  if (message.type === "bookcapture:run") {
    // after the person picked a part of a book's page: the script that records the book runs once more in that tab (it is already there from the page load)
    if (!sender || !sender.tab) return;
    chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ["book-capture.js"] }).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  // A comic's chapter translated in its page (comic-host.js in the offscreen page, which has no tabs): its progress and pictures passed on to the tab; the pill's Stop back
  if (message.type === "comic:toTab" && !(sender && sender.tab) && Number.isInteger(message.tabId)) {
    chrome.tabs.sendMessage(message.tabId, message.msg).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  // a line to read aloud with an AI voice (comic-page.js asks; the offscreen page makes the call with the key or sign-in the popup gave it)
  if (message.type === "listen:speech" && sender && sender.tab) {
    chrome.runtime.sendMessage({ target: "comic", op: "speech", tabId: sender.tab.id, text: String(message.text || ""), voice: message.voice }).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "comic:stop" && sender && sender.tab) {
    chrome.runtime.sendMessage({ target: "comic", op: "stop", tabId: sender.tab.id }).catch(() => {});
    return;
  }
  // Import to library (the popup, docs/ADD-BOOK.md): the book on that tab is recorded now -> { saved, reason?, info? }
  if (message.type === "bookcapture:add" && ownPage(sender)) {
    const tabId = Number(message.tabId);
    bookAdds.get(tabId)?.({ saved: false, reason: "asked again" });
    new Promise((resolve) => {
      bookAdds.set(tabId, resolve);
      setTimeout(() => resolve({ saved: false, reason: "the page did not answer" }), 120000);
      chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__p2preadAdd = true; } })
        .then(() => chrome.scripting.executeScript({ target: { tabId }, files: ["book-rules.js", "user-rules.js", "book-capture.js"] }))
        .catch((e) => resolve({ saved: false, reason: e.message }));
    }).then((r) => { bookAdds.delete(tabId); sendResponse(r); });
    return true;
  }
  if (message.type === "bookcapture:done" && message.added && sender && sender.tab && bookAdds.has(sender.tab.id)) {
    bookAdds.get(sender.tab.id)(message);
    return;
  }
  // Translate ahead (translate-ahead.js): the popup's switch, the pages' requests
  const ahead = TranslateAhead.answer(message, sender);
  if (ahead) {
    ahead.then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "translate") {
    // (keepNothing, pay: the popup's Translate on a chapter's page: nothing kept, paid with the Gemini key or tickets as picked there)
    translatePageText(message, !!message.keepNothing).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "original:notes") {
    TermNotes.notesOnly(message.job).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "original:translate") {
    OriginalTranslate.run(message.job).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "wtr:rawhost") {
    OriginalTranslate.rawSourceOf(message.rawId, message.lang, message.slug).then(sendResponse, () => sendResponse({ host: "", first: "" }));
    return true;
  }
  if (message.type === "wtr:bindsource") {
    OriginalTranslate.bindSource(message.url, message.rawId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  // the model chosen in the popup's list is the library's setting too
  if (message.type === "model:set") {
    GlossaryServer.setGeminiModel(String(message.model || "")).then(sendResponse);
    return true;
  }
  // the language chapters are translated into (the library's setting), for a page that needs to know which version of a chapter it asks for
  if (message.type === "target:language") {
    GlossaryServer.targetLanguage().then((lang) => sendResponse({ lang }), () => sendResponse({ lang: "en" }));
    return true;
  }
  if (message.type === "glossary:pull") {
    GlossaryServer.pull().then(sendResponse);
    return true;
  }
  if (message.type === "wtr:myterms") {
    GlossaryServer.syncPersonalReplacements(message.rawId, message.novel, message.terms).then(sendResponse);
    return true;
  }
  if (message.type === "glossary:import") {
    GlossaryServer.importSnapshot(message.record).then(sendResponse);
    return true;
  }
  // titles, and a book's title, author, genre and synopsis: as the library's setting says (Google Translate, Gemini, or both: translateByMode)
  if (message.type === "translateTitles") {
    translateByMode(message.texts, "titles").then((texts) => sendResponse({ texts }));
    return true;
  }
  if (message.type === "translateBook") {
    translateByMode(message.texts, "book").then((texts) => sendResponse({ texts }));
    return true;
  }
  if (message.type === "list:apply") {
    // a source's chapter list read once on request: kept as the novel's list the way a watch's first look keeps it (see Watcher.apply)
    Watcher.apply(watchDeps, message.watch, message.found, Date.now()).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }
  if (message.type === "chapterindex:save") {
    GlossaryServer.saveChapterIndex(message.record).then(sendResponse);
    return true;
  }
  if (message.type === "startDetect") {
    // the popup's "Detect with AI": the script that asks Gemini is injected into the tab
    // (message.local: no Gemini, the page itself says where the chapter list is)
    // (message.book: the popup shows the page as a book's, Import to library runs from there: its many covers are not a comic's chapter)
    chrome.scripting.executeScript({ target: { tabId: message.tabId }, func: (local, book) => { window.__P2PREAD_DETECT_LOCAL = !!local; window.__P2PREAD_DETECT_BOOK = !!book; }, args: [!!message.local, !!message.book] })
      .then(() => chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ["user-rules.js", "book-detect.js"] })).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "book:detect") {
    geminiDetectBook(message.candidates, message.page).then(sendResponse);
    return true;
  }
  if (message.type === "site:pass") {
    // a source site answered 403: the browser may have passed its check already, with the pass kept where the extension's requests do not see it
    BookVisit.bringPass(message.url).then(sendResponse);
    return true;
  }
  if (message.type === "site:fetch") {
    // a source site answered the extension's own request with 403 (its bot check): the page is asked for from inside a tab of the site
    BookVisit.fetchIn(message.url).then(sendResponse);
    return true;
  }
  if (message.type === "book:visit") {
    // "Refresh details" was refused by the site: open the page in a background tab and let the recording script record it
    BookVisit.visit(message.url).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "pictures:relearn" && ownPage(sender)) {
    // a comic's chapter whose site rule no longer finds the list its script draws the pictures from: the chapter is opened in a background tab to find it again
    BookVisit.relearnPictures(message.url, message.had).then(sendResponse);
    return true;
  }
  if (message.type === "cover:enabled") {
    GlossaryServer.copyCoversOn().then((on) => sendResponse({ on }));
    return true;
  }
  if (message.type === "cover:copy") {
    GlossaryServer.copyCover(message.id, message.url, null, { force: !!message.force }).then(sendResponse);
    return true;
  }
  if (message.type === "cover:save") { // a picture the page fetched itself (a data: address)
    fetch(message.dataUrl).then((r) => r.blob()).then((blob) => GlossaryServer.copyCover(message.id, "", blob, { force: !!message.force })).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.type === "novel:get") {
    GlossaryServer.getNovel(message.id).then((novel) => sendResponse({ novel }));
    return true;
  }
  if (message.type === "novel:save") {
    GlossaryServer.saveNovel(message.info).then(sendResponse);
    return true;
  }
  if (message.type === "glossary:votes") {
    GlossaryServer.sendVotes(message.id, message.votes).then(sendResponse);
    return true;
  }
  if (message.type === "glossary:bind") {
    GlossaryServer.setBinding(message.key, message.ids).then(sendResponse);
    return true;
  }
  if (message.type === "translateTitle") {
    translateByMode([message.text], "titles").then(([text]) => sendResponse({ text: text || message.text }));
    return true;
  }
  if (message.type === "translateTab") {
    // (ahead: the popup's Translate ahead switch is on: the tab is followed from here, translate-ahead.js)
    const pay = message.pay;
    const begun = message.ahead && ownPage(sender)
      ? chrome.tabs.get(message.tabId).then((tab) => TranslateAhead.begin(message.tabId, { kind: "text", pay, url: tab.url })).then(() => true, () => false)
      : Promise.resolve(false);
    begun.then((on) => translateTab(message.tabId, { keepNothing: !!message.keepNothing, pay, ahead: on ? { count: TranslateAhead.COUNT, auto: false } : null }))
      .then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "listModels") {
    listGeminiModels().then((models) => sendResponse({ models }));
    return true;
  }
  if (message.type === "startPicker") {
    chrome.storage.local
      .set({ __pickerField: message.field || "title" })
      .then(() => chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ["picker.js"] }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
}

// ---------- the novel sites, and the sites the person added ----------
// This build asks for no novel site at install (site-access.js): what runs on a novel site's pages (the book recorder, the site's scripts, 69shuba's chapter index:
// SITE_SCRIPTS, made by build.js) is added here once the browser has let the extension read the site (the popup asks). A site of the person's own, with a book part in its
// rule, gets the book recorder the same way. A build that has the sites in its manifest (the dev build) has no SITE_SCRIPTS: only the person's sites are added.
const SITE_GROUPS = (typeof SITE_SCRIPTS !== "undefined" ? SITE_SCRIPTS : []).map((g, i) => ({ id: "site-" + i, matches: g.matches, js: g.js, runAt: g.runAt }));
const SITE_SCRIPT_IDS = new Set(["user-book-capture", ...SITE_GROUPS.map((g) => g.id)]);
async function syncSiteScripts(stored) {
  const granted = ((await chrome.permissions.getAll().catch(() => null)) || {}).origins || [];
  const groups = [];
  for (const g of SITE_GROUPS) {
    const matches = g.matches.filter((m) => SiteAccess.covered(granted, m));
    if (matches.length) groups.push({ id: g.id, matches, js: g.js, runAt: g.runAt, persistAcrossSessions: true });
  }
  // (the book recorder is not among them any more: Import to library runs it in the tab, docs/ADD-BOOK.md; "user-book-capture" stays in the ids, so one an older
  // version registered is taken away)
  const have = (await chrome.scripting.getRegisteredContentScripts().catch(() => [])).filter((s) => SITE_SCRIPT_IDS.has(s.id)).map((s) => s.id);
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have }).catch(() => {});
  if (groups.length) await chrome.scripting.registerContentScripts(groups).catch((e) => console.warn("site scripts not added:", e && e.message));
}
const resyncSiteScripts = () => chrome.storage.local.get(UserRules.KEY).then((r) => syncSiteScripts(r[UserRules.KEY] || {})).catch(() => {});
resyncSiteScripts();
chrome.permissions.onAdded.addListener(resyncSiteScripts);
chrome.permissions.onRemoved.addListener(resyncSiteScripts);

// A "!" on the icon while something asked for a site that is not allowed yet: the popup says which, with an Allow button.
async function showAccessBadge() {
  const n = (await SiteAccess.pending().catch(() => [])).length;
  await chrome.action.setBadgeText({ text: n ? "!" : "" }).catch(() => {});
  if (n) await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" }).catch(() => {});
}
showAccessBadge();
chrome.permissions.onAdded.addListener(showAccessBadge);
chrome.tabs.onActivated.addListener(() => AccessOffer.offer()); // (a tab of the library site comes to the front while a site waits to be allowed)
chrome.permissions.onRemoved.addListener(showAccessBadge);

// ---------- the sync with the library site's tab, and the fetching (in an offscreen document, which has a DOM; see p2p-host.js) ----------
const P2P_PREFIX = "translation:";
const P2P_INDEX_KEY = "p2pIndex";
// (in parts: a change saves its part, not the whole index; the offscreen page's sync asks for it here)
const p2pIndex = P2PCore.bucketedIndex({ get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o), remove: (k) => chrome.storage.local.remove(k), base: P2P_INDEX_KEY });

// The offscreen page reads the novel sites' pages (DOMParser), runs the sync with the library site's tab and keeps your library (library-host.js).
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Reads the chapters of the novel sites the person allowed, and keeps their library"
  });
}

function p2pStorageOp(op, args) {
  switch (op) {
    case "getUserRules":
      return chrome.storage.local.get(UserRules.KEY).then((r) => r[UserRules.KEY] || {});
    case "getIndex":
      return p2pIndex.getIndex();
    case "setIndex":
      return p2pIndex.setIndex(args[0]);
    case "putIndex":
      return p2pIndex.putIndex(args[0] || {});
    case "getTranslation":
      return chrome.storage.local.get(args[0]).then((r) => r[args[0]]);
    case "setTranslation":
      return chrome.storage.local.set({ [args[0]]: args[1] });
    case "listTranslations":
      return chrome.storage.local.get(null).then((all) =>
        Object.keys(all)
          .filter((k) => k.startsWith(P2P_PREFIX))
          .map((k) => [k, { savedAt: all[k].savedAt || 0, translated: !!all[k].translated, ...(all[k].model === "images" ? { images: true } : {}) }])
      );
    default:
      return Promise.reject(new Error("unknown p2p op " + op));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "p2p-bg") return;
  // (it reads and writes any stored key: only this extension's own pages ask, never a content script, which runs inside a site's page)
  if (!sender || sender.id !== chrome.runtime.id || (sender.tab && !(typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL("")))))
    return void sendResponse({ error: "not this extension's own page" });
  p2pStorageOp(message.op, message.args || [])
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: e.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (UserRules.KEY in changes) {
    chrome.runtime.sendMessage({ target: "user-rules", stored: changes[UserRules.KEY].newValue || {} }).catch(() => {});
    syncSiteScripts(changes[UserRules.KEY].newValue || {});
  }
  if (SiteAccess.KEY in changes) { showAccessBadge(); AccessOffer.offer(); }
  for (const key of Object.keys(changes)) {
    if (key.startsWith(P2P_PREFIX) && changes[key].newValue) {
      chrome.runtime
        .sendMessage({ target: "p2p-host", type: "changed", key, entry: changes[key].newValue })
        .catch(() => {});
    }
  }
});

GlossaryServer.wake = ensureOffscreen; // the glossary calls go to the library in the offscreen page once there is one
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "lib:wake") return;
  ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message })); // (the popup, before it asks the library)
  return true;
});
chrome.runtime.onStartup.addListener(() => ensureOffscreen().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => ensureOffscreen().catch(() => {}));
ensureOffscreen().catch(() => {});

// The service worker sleeps when idle and Chrome can close the offscreen document (a crash, a browser restart). Nothing else wakes the
// worker up, so the sync would stay off until you opened the popup. A once-a-minute alarm brings the offscreen document back.
chrome.alarms.create("p2p-keepalive", { periodInMinutes: 1 });
// The same alarm drives the "New chapters" watches: nothing happens unless the person switched one on (it asks the library).
const watchDeps = {
  listWatches: () => GlossaryServer.listWatches(),
  saveWatch: (w) => GlossaryServer.saveWatch(w),
  addNotice: (n) => GlossaryServer.addNotice(n),
  saveChapterIndex: (r) => GlossaryServer.putChapterIndex(r),
  bindingKey: (url) => WtrTerms.bindingKey(url), // the site + directory key chapter lists and glossary bindings share
  translateTitles: (texts) => translateByMode(texts, "titles"), // (each title once: gemini.js titlesOnce)
  // the page that can reach the source sites does the looking
  check: async (w) => {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({ target: "p2p-host", type: "watch:check", watch: w });
    if (!reply || reply.error) throw new Error((reply && reply.error) || "the extension's page did not answer");
    return reply.found;
  },
  // and fetches what it found, or the chapters of its list not here, for a watch set to (then: "fetch", "all")
  fetchChapters: async (items, w, opts) => {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({ target: "p2p-host", type: "watch:fetch", items, watch: w, opts });
    if (!reply || reply.error) throw new Error((reply && reply.error) || "the extension's page did not answer");
    return reply;
  },
  chapterList: async (key) => ((await GlossaryServer.api("GET", "/api/chapter-index?key=" + encodeURIComponent(key))).indexes || []).flatMap((ix) => ix.chapters || [])
};
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "p2p-keepalive") return;
  ensureOffscreen().catch(() => {});
  Watcher.tick(watchDeps).catch(() => {});
});
