function hostnameOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

// Note: with a default_popup set, browserAction.onClicked never fires — the popup owns the click.
// The popup's "Translate this page" button sends {type:"translateTab", tabId} instead. opts: { keepNothing, pay } (a chapter's page: docs/ADD-BOOK.md),
// ahead: { count, auto } (Translate ahead: translate-ahead.js)
async function translateTab(tabId, opts = {}) {
  const tab = await browser.tabs.get(tabId);
  const hostname = hostnameOf(tab.url);
  const { contentSelectors, novelSelectors, novelOverrides } = await browser.storage.local.get([
    "contentSelectors",
    "novelSelectors",
    "novelOverrides"
  ]);
  const contentSelector = (contentSelectors || {})[hostname] || null;
  const novelSelector = (novelSelectors || {})[hostname] || null;
  const novelNameOverride = (novelOverrides || {})[hostname] || null;
  const { userRules } = await browser.storage.local.get("userRules");

  await browser.tabs.executeScript(tabId, {
    code:
      "window.__GEMINI_CONTENT_SELECTOR_OVERRIDE__ = " + JSON.stringify(contentSelector) + ";" +
      "window.__GEMINI_NOVEL_SELECTOR_OVERRIDE__ = " + JSON.stringify(novelSelector) + ";" +
      "window.__GEMINI_NOVEL_NAME_OVERRIDE__ = " + JSON.stringify(novelNameOverride) + ";" +
      "window.__USER_RULES__ = " + JSON.stringify(userRules || {}) + ";" +
      "window.__P2PREAD_KEEP_NOTHING__ = " + JSON.stringify(!!opts.keepNothing) + ";" +
      (opts.keepNothing ? "window.__P2PREAD_COMIC_URLS__ = null;" : "") + // (the page's pill, comic-page.js, for a text chapter: content.js tells it how it goes)
      "window.__P2PREAD_PAY__ = " + JSON.stringify(["tickets", "openrouter", "rules"].includes(opts.pay) ? opts.pay : "key") + ";" +
      "window.__P2PREAD_AHEAD__ = " + JSON.stringify(opts.ahead ? { count: Number(opts.ahead.count) || 0, auto: !!opts.ahead.auto } : null) + ";"
  });

  if (opts.keepNothing) await browser.tabs.executeScript(tabId, { file: "comic-page.js" });
  await browser.tabs.executeScript(tabId, { file: "site-selectors.js" });
  await browser.tabs.executeScript(tabId, { file: "default-glossary.js" });
  await browser.tabs.executeScript(tabId, { file: "wtr-terms.js" });
  await browser.tabs.executeScript(tabId, { file: "raw-sources.js" });
  await browser.tabs.executeScript(tabId, { file: "user-rules.js" });
  await browser.tabs.executeScript(tabId, { file: "next-page.js" });
  await browser.tabs.executeScript(tabId, { file: "terms.js" }); // (the terms found as the library's reader finds them)
  await browser.tabs.executeScript(tabId, { file: "content.js" });
}

// A chapter's text translated as the popup's Translate asks (nothing kept), paid with the Gemini key ("key"), the OpenRouter key, or tickets
function translatePageText(m, keepNothing) {
  // (by the Translation rule's rows, Settings › Model rules: the popup no longer picks who pays)
  if (m.pay === "rules") return GlossaryServer.targetLanguage().catch(() => "en").then((lang) => ProfileTranslate.pageByRules(m.text, m.glossary, lang, m.url));
  if (m.pay === "tickets" || m.pay === "openrouter") return GlossaryServer.targetLanguage().catch(() => "en").then((lang) => ProfileTranslate[m.pay === "tickets" ? "pageWithTickets" : "pageWithKey"](m.text, m.glossary, lang));
  return browser.storage.local.get("selectedModel").then(({ selectedModel }) => TermNotes.translate({ text: m.text, glossary: m.glossary, model: selectedModel, url: m.url, title: m.title, novelName: m.novelName, keepNothing: !!keepNothing }));
}

// Translate ahead (translate-ahead.js): the next pages translated before they are opened, the tab followed to them. The comic host is this page (comic-host.js): called directly.
TranslateAhead.start({
  translateTab,
  translateText: (job) => translatePageText(job, true),
  run: (tabId, func) => browser.tabs.executeScript(tabId, { code: "(" + func.toString() + ")()" }).then((r) => r && r[0]),
  files: async (tabId, files) => { for (const file of files) await browser.tabs.executeScript(tabId, { file }); },
  comic: async (op, msg) => {
    if (typeof ComicHost === "undefined") throw new Error("the comic translator is not loaded");
    return op === "translate" ? ComicHost.translate(msg) : op === "ahead" ? (ComicHost.ahead(msg), { ok: true }) : (ComicHost.drop(msg.tabId), { ok: true });
  }
});

const bookAdds = new Map(); // tab -> the answer to the popup's Import to library, when the page says it has recorded the book
// a page of this extension (the popup, also when it is opened in a tab of its own), never a site's page
const ownPage = (sender) => !sender || !sender.tab || String(sender.url || "").startsWith(browser.runtime.getURL(""));
browser.runtime.onMessage.addListener((message, sender) => handleMessage(message, sender));

function handleMessage(message, sender) {
  if (!message) return;
  // the Allow card in the library site's tab (access-offer.js)
  const offer = AccessOffer.answerMessage(message, sender);
  if (offer) return offer;
  // the library site's Listen tab, with Fish Audio and the person's own key (fish-speech.js)
  const fish = FishSpeech.answer(message, sender);
  if (fish) return fish;
  if (message.type === "bookcapture:run") {
    // after the person picked a part of a book's page: the script that records the book runs once more in that tab (it is already there from the page load)
    if (!sender || !sender.tab) return;
    return browser.tabs.executeScript(sender.tab.id, { file: "book-capture.js" }).then(() => ({ ok: true }), (e) => ({ error: e.message }));
  }
  // the pill's Stop on a comic's chapter being translated in its page (comic-host.js, in this page)
  // a line to read aloud with an AI voice (comic-page.js asks; comic-host.js, in this page, makes the call)
  if (message.type === "listen:speech" && sender && sender.tab && typeof ComicHost !== "undefined") {
    return ComicHost.speech(sender.tab.id, String(message.text || ""), message.voice);
  }
  if (message.type === "comic:stop" && sender && sender.tab) {
    if (typeof ComicHost !== "undefined") ComicHost.stop(sender.tab.id);
    return;
  }
  // Import to library (the popup, docs/ADD-BOOK.md): the book on that tab is recorded now -> { saved, reason?, info? }
  if (message.type === "bookcapture:add" && ownPage(sender)) {
    const tabId = Number(message.tabId);
    if (bookAdds.has(tabId)) bookAdds.get(tabId)({ saved: false, reason: "asked again" });
    return new Promise((resolve) => {
      bookAdds.set(tabId, resolve);
      setTimeout(() => resolve({ saved: false, reason: "the page did not answer" }), 120000);
      browser.tabs.executeScript(tabId, { code: "window.__p2preadAdd = true;" })
        .then(() => browser.tabs.executeScript(tabId, { file: "book-rules.js" }))
        .then(() => browser.tabs.executeScript(tabId, { file: "user-rules.js" }))
        .then(() => browser.tabs.executeScript(tabId, { file: "book-capture.js" }))
        .catch((e) => resolve({ saved: false, reason: e.message }));
    }).then((r) => { bookAdds.delete(tabId); return r; });
  }
  if (message.type === "bookcapture:done" && message.added && sender && sender.tab && bookAdds.has(sender.tab.id)) {
    bookAdds.get(sender.tab.id)(message);
    return;
  }
  // Translate ahead (translate-ahead.js): the popup's switch, the pages' requests
  const ahead = TranslateAhead.answer(message, sender);
  if (ahead) return ahead.catch((e) => ({ error: e.message }));
  if (message.type === "translate") {
    // (keepNothing, pay: the popup's Translate on a chapter's page: nothing kept, paid with the Gemini key or tickets as picked there)
    return translatePageText(message, !!message.keepNothing).catch((e) => ({ error: e.message }));
  }
  if (message.type === "original:translate") return OriginalTranslate.run(message.job).catch((e) => ({ error: e.message }));
  if (message.type === "original:notes") return TermNotes.notesOnly(message.job).catch((e) => ({ error: e.message }));
  if (message.type === "wtr:rawhost") return OriginalTranslate.rawSourceOf(message.rawId, message.lang, message.slug).then((r) => r, () => ({ host: "", first: "" }));
  if (message.type === "wtr:bindsource") return OriginalTranslate.bindSource(message.url, message.rawId).then(() => ({ ok: true }), (e) => ({ error: e.message }));
  if (message.type === "model:set") return GlossaryServer.setGeminiModel(String(message.model || ""));
  if (message.type === "target:language") return GlossaryServer.targetLanguage().then((lang) => ({ lang }), () => ({ lang: "en" }));
  if (message.type === "glossary:pull") return GlossaryServer.pull();
  if (message.type === "wtr:myterms") return GlossaryServer.syncPersonalReplacements(message.rawId, message.novel, message.terms);
  if (message.type === "glossary:import") return GlossaryServer.importSnapshot(message.record);
  // titles, and a book's details: as the library's setting says (Google Translate, Gemini, or both: translateByMode)
  if (message.type === "translateBook") return translateByMode(message.texts, "book").then((texts) => ({ texts }));
  if (message.type === "translateTitles") return translateByMode(message.texts, "titles").then((texts) => ({ texts }));
  if (message.type === "chapterindex:save") return GlossaryServer.saveChapterIndex(message.record);
  if (message.type === "novel:save") return GlossaryServer.saveNovel(message.info);
  if (message.type === "startDetect") return browser.tabs.executeScript(message.tabId, { code: "window.__P2PREAD_DETECT_LOCAL = " + (message.local ? "true" : "false") + "; window.__P2PREAD_DETECT_BOOK = " + (message.book ? "true" : "false") + ";" }).then(() => browser.tabs.executeScript(message.tabId, { file: "user-rules.js" })).then(() => browser.tabs.executeScript(message.tabId, { file: "book-detect.js" })).then(() => ({ ok: true }), (e) => ({ error: e.message }));
  if (message.type === "book:detect") return geminiDetectBook(message.candidates, message.page);
  if (message.type === "site:pass") return BookVisit.bringPass(message.url);
  if (message.type === "site:fetch") return BookVisit.fetchIn(message.url);
  if (message.type === "book:visit") return BookVisit.visit(message.url).then((r) => r, (e) => ({ error: e.message }));
  if (message.type === "cover:enabled") return GlossaryServer.copyCoversOn().then((on) => ({ on }));
  if (message.type === "cover:copy") return GlossaryServer.copyCover(message.id, message.url, null, { force: !!message.force });
  if (message.type === "cover:save") return fetch(message.dataUrl).then((r) => r.blob()).then((blob) => GlossaryServer.copyCover(message.id, "", blob, { force: !!message.force })).catch((e) => ({ ok: false, error: e.message }));
  if (message.type === "novel:get") return GlossaryServer.getNovel(message.id).then((novel) => ({ novel }));
  if (message.type === "glossary:votes") return GlossaryServer.sendVotes(message.id, message.votes);
  if (message.type === "glossary:bind") return GlossaryServer.setBinding(message.key, message.ids);
  if (message.type === "translateTitle") {
    return translateByMode([message.text], "titles").then(([text]) => ({ text: text || message.text }));
  }
  if (message.type === "translateTab") {
    // (ahead: the popup's Translate ahead switch is on: the tab is followed from here, translate-ahead.js)
    const begun = message.ahead && ownPage(sender)
      ? browser.tabs.get(message.tabId).then((tab) => TranslateAhead.begin(message.tabId, { kind: "text", pay: message.pay, url: tab.url })).then(() => true, () => false)
      : Promise.resolve(false);
    return begun.then((on) => translateTab(message.tabId, { keepNothing: !!message.keepNothing, pay: message.pay, ahead: on ? { count: TranslateAhead.COUNT, auto: false } : null }))
      .then(() => ({ ok: true }), (e) => ({ error: e.message }));
  }
  if (message.type === "listModels") {
    return listGeminiModels().then((models) => ({ models }));
  }
  if (message.type === "startPicker") {
    return browser.storage.local
      .set({ __pickerField: message.field || "title" })
      .then(() => browser.tabs.executeScript(message.tabId, { file: "picker.js" }))
      .then(() => ({ ok: true }));
  }
}

// This build asks for no novel site at install (site-access.js): what runs on a novel site's pages (the book recorder, the site's scripts, 69shuba's chapter index:
// SITE_SCRIPTS, made by build.js) is added here once the browser has let the extension read the site (the popup asks). A site of the person's own, with a book part in
// its rule, gets the book recorder the same way. A build that has the sites in its manifest (the dev build) has no SITE_SCRIPTS: only the person's sites are added.
// (Firefox forgets such scripts when it closes: they are added again at start.)
const SITE_GROUPS = (typeof SITE_SCRIPTS !== "undefined" ? SITE_SCRIPTS : []).map((g) => ({ matches: g.matches, js: g.js.map((file) => ({ file })), runAt: g.runAt }));
let siteScripts = [];
async function syncSiteScripts(stored) {
  const granted = ((await browser.permissions.getAll().catch(() => null)) || {}).origins || [];
  const groups = [];
  for (const g of SITE_GROUPS) {
    const matches = g.matches.filter((m) => SiteAccess.covered(granted, m));
    if (matches.length) groups.push({ matches, js: g.js, runAt: g.runAt });
  }
  // (the book recorder is not among them any more: Import to library runs it in the tab: docs/ADD-BOOK.md)
  for (const old of siteScripts) await old.unregister().catch(() => {});
  siteScripts = [];
  for (const g of groups) {
    const added = await browser.contentScripts.register(g).catch((e) => { console.warn("site scripts not added:", e && e.message); return null; });
    if (added) siteScripts.push(added);
  }
}
const resyncSiteScripts = () => browser.storage.local.get("userRules").then((r) => syncSiteScripts(r.userRules || {})).catch(() => {});
resyncSiteScripts();
browser.permissions.onAdded.addListener(resyncSiteScripts);
browser.permissions.onRemoved.addListener(resyncSiteScripts);

// A "!" on the icon while something asked for a site that is not allowed yet: the popup says which, with an Allow button.
async function showAccessBadge() {
  const n = (await SiteAccess.pending().catch(() => [])).length;
  await browser.browserAction.setBadgeText({ text: n ? "!" : "" }).catch(() => {});
  if (n) await browser.browserAction.setBadgeBackgroundColor({ color: "#b3261e" }).catch(() => {});
}
showAccessBadge();
browser.permissions.onAdded.addListener(showAccessBadge);
browser.tabs.onActivated.addListener(() => AccessOffer.offer()); // (a tab of the library site comes to the front while a site waits to be allowed)
browser.permissions.onRemoved.addListener(showAccessBadge);
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.userRules) syncSiteScripts(changes.userRules.newValue || {});
  if (changes[SiteAccess.KEY]) { showAccessBadge(); AccessOffer.offer(); }
});

// "New chapters" watches: nothing happens unless the person switched one on (it asks the library). The page that does the looking
// is this same background page (p2p-host.js), so it is called directly.
const watchDeps = {
  listWatches: () => GlossaryServer.listWatches(),
  saveWatch: (w) => GlossaryServer.saveWatch(w),
  addNotice: (n) => GlossaryServer.addNotice(n),
  saveChapterIndex: (r) => GlossaryServer.putChapterIndex(r),
  bindingKey: (url) => WtrTerms.bindingKey(url),
  translateTitles: (texts) => translateByMode(texts, "titles"), // (each title once: gemini.js titlesOnce)
  check: (w) => self.__checkWatch(w),
  fetchChapters: (items, w, opts) => self.__fetchFound(items, w, opts), // (a watch set to fetch what it found, or every chapter not here)
  chapterList: async (key) => ((await GlossaryServer.api("GET", "/api/chapter-index?key=" + encodeURIComponent(key))).indexes || []).flatMap((ix) => ix.chapters || [])
};
setInterval(() => Watcher.tick(watchDeps).catch(() => {}), 60 * 1000);
