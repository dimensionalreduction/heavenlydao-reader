function hostnameOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

// Note: with a default_popup set, browserAction.onClicked never fires — the popup owns the click.
// The popup's "Translate this page" button sends {type:"translateTab", tabId} instead.
async function translateTab(tabId) {
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
      "window.__USER_RULES__ = " + JSON.stringify(userRules || {}) + ";"
  });

  await browser.tabs.executeScript(tabId, { file: "site-selectors.js" });
  await browser.tabs.executeScript(tabId, { file: "default-glossary.js" });
  await browser.tabs.executeScript(tabId, { file: "wtr-terms.js" });
  await browser.tabs.executeScript(tabId, { file: "raw-sources.js" });
  await browser.tabs.executeScript(tabId, { file: "user-rules.js" });
  await browser.tabs.executeScript(tabId, { file: "content.js" });
}

// Until this extension is a device of a library it does nothing for anyone: its popup shows only the passphrase and Join, and every request
// here is refused (the library's own calls, with a target, and the popup's status questions pass). libraryOn: set by library-host.js.
const LOCKED = "this extension is not in a library yet: open its popup, enter your library's passphrase and press Join";
const LOCK_EXEMPT = new Set(["p2p:status", "bookcapture:done"]);
let unlocked = null;
const lockRead = browser.storage.local.get("libraryOn").then((r) => { unlocked = !!r.libraryOn; }, () => { unlocked = false; });
browser.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.libraryOn) unlocked = !!changes.libraryOn.newValue; });
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.target || LOCK_EXEMPT.has(message.type)) return handleMessage(message, sender);
  if (unlocked === true) return handleMessage(message, sender);
  return lockRead.then(() => (unlocked ? handleMessage(message, sender) : { error: LOCKED }));
});

function handleMessage(message, sender) {
  if (!message) return;
  // the library site's Listen tab, with Fish Audio and the person's own key (fish-speech.js)
  const fish = FishSpeech.answer(message, sender);
  if (fish) return fish;
  if (message.type === "bookcapture:run") {
    // after the person picked a part of a book's page: the script that records the book runs once more in that tab (it is already there from the page load)
    if (!sender || !sender.tab) return;
    return browser.tabs.executeScript(sender.tab.id, { file: "book-capture.js" }).then(() => ({ ok: true }), (e) => ({ error: e.message }));
  }
  if (message.type === "translate") {
    return browser.storage.local
      .get("selectedModel")
      .then(({ selectedModel }) => TermNotes.translate({ text: message.text, glossary: message.glossary, model: selectedModel, url: message.url, title: message.title, novelName: message.novelName }));
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
  if (message.type === "startDetect") return browser.tabs.executeScript(message.tabId, { file: "user-rules.js" }).then(() => browser.tabs.executeScript(message.tabId, { file: "book-detect.js" })).then(() => ({ ok: true }), (e) => ({ error: e.message }));
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
    return translateTab(message.tabId).then(() => ({ ok: true }));
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
  const mine = [];
  for (const [host, entry] of Object.entries(stored || {})) {
    if (!entry || entry.enabled === false || !entry.spec || !entry.spec.book || RawSources.SOURCES[host]) continue;
    const match = "https://*." + host + "/*";
    if (SiteAccess.covered(granted, match)) mine.push(match);
  }
  if (mine.length) groups.push({ matches: mine, js: [{ file: "book-rules.js" }, { file: "user-rules.js" }, { file: "book-capture.js" }], runAt: "document_idle" });
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
browser.permissions.onRemoved.addListener(showAccessBadge);
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.userRules) syncSiteScripts(changes.userRules.newValue || {});
  if (changes[SiteAccess.KEY]) showAccessBadge();
});

// "New chapters" watches: nothing happens unless the person switched one on (it asks the library). The page that does the looking
// is this same background page (p2p-host.js), so it is called directly.
const watchDeps = {
  listWatches: () => GlossaryServer.listWatches(),
  saveWatch: (w) => GlossaryServer.saveWatch(w),
  addNotice: (n) => GlossaryServer.addNotice(n),
  saveChapterIndex: (r) => GlossaryServer.putChapterIndex(r),
  bindingKey: (url) => WtrTerms.bindingKey(url),
  translateTitles: (texts) => Watcher.cachedTitles(browser.storage.local, (t) => translateByMode(t, "titles"), texts),
  check: (w) => self.__checkWatch(w),
  fetchChapters: (items, w, opts) => self.__fetchFound(items, w, opts), // (a watch set to fetch what it found, or every chapter not here)
  chapterList: async (key) => ((await GlossaryServer.api("GET", "/api/chapter-index?key=" + encodeURIComponent(key))).indexes || []).flatMap((ix) => ix.chapters || []),
  settings: () => GlossaryServer.api("GET", "/api/settings"), // (whether this extension does the triggers: Watcher.mayRun)
  me: () => LibraryHost.call("status")
};
setInterval(() => { if (unlocked) Watcher.tick(watchDeps).catch(() => {}); }, 60 * 1000); // (nothing before it is in a library)
