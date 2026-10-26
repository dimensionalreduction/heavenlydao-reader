// The background's two helpers for reading a site novel from its source site: finding the source host, and binding the novel's
// glossary to it. Run: node test/original-translate.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shared = path.join(__dirname, "..", "src", "shared");
const storage = {};
const bound = [];
const fetched = [];
let goToRawUrl = "https://www.69shuba.com/txt/77582/38804612";
let goToRawBody = ""; // the page the Raw link lands on (read only to find a mirror)
let lookupChapter = { id: 8885200 };
let bodyCancelled = 0;

const ctx = {
  console, URL, setTimeout, Promise, JSON, Object, Number, String,
  fetch: async (url, opts) => {
    fetched.push(String(url));
    if (/api\/reader\/get/.test(url)) {
      const body = JSON.parse(opts.body);
      fetched.push("chapter_no=" + body.chapter_no);
      return { ok: !!lookupChapter, json: async () => ({ success: true, chapter: lookupChapter }) };
    }
    return { ok: true, url: goToRawUrl, text: async () => goToRawBody, body: { cancel: async () => void bodyCancelled++ } };
  },
  chrome: { storage: { local: { get: async (k) => (typeof k === "string" ? { [k]: storage[k] } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, storage[x]])) : {}), set: async (o) => Object.assign(storage, o) } } },
  GlossaryServer: { pull: async () => null, setBinding: async (key, ids) => void bound.push([key, ids]) },
  translateText: async () => ({ error: "not used here" })
};
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(shared, "wtr-terms.js"), "utf8"), ctx, { filename: "wtr-terms.js" });
vm.runInContext(fs.readFileSync(path.join(shared, "term-match.js"), "utf8"), ctx, { filename: "term-match.js" }); // (the novel's index of mentions)
vm.runInContext(require("../tools/sources").bundleText(), ctx, { filename: "raw-sources.js" }); // the engine and every site's rules, as shipped
vm.runInContext(fs.readFileSync(path.join(shared, "term-notes.js"), "utf8"), ctx, { filename: "term-notes.js" }); // (notes on terms: off here, the server stand-in has no settings)
vm.runInContext(fs.readFileSync(path.join(shared, "original-translate.js"), "utf8"), ctx, { filename: "original-translate.js" });
const OT = vm.runInContext("OriginalTranslate", ctx);

(async () => {
  // ---- which site a novel's raw link leads to ----
  assert.strictEqual(await OT.rawHostOf("8053", "en"), "69shuba.com");
  const src = await OT.rawSourceOf("8053", "en");
  assert.strictEqual(JSON.stringify(src), JSON.stringify({ host: "69shuba.com", first: "https://www.69shuba.com/txt/77582/38804612" }), "the host and chapter 1's own address");
  assert.deepStrictEqual(fetched.slice(0, 3), ["https://wtr-lab.com/api/reader/get", "chapter_no=1", "https://wtr-lab.com/api/serie/go-to-raw?id=8885200"], "chapter 1's id, then its raw link");
  assert.ok(bodyCancelled >= 1, "only the address is wanted: the page body is not downloaded");

  goToRawUrl = "https://www.uuread.tw/chapter/1878627/2213453.html";
  assert.strictEqual(await OT.rawHostOf("93016", "en"), "uuread.tw");
  goToRawUrl = "https://fanqienovel.com/reader/1";
  assert.strictEqual(await OT.rawHostOf("1", "en"), "", "a site this extension cannot read is not offered");
  assert.strictEqual((await OT.rawSourceOf("1", "en")).first, "", "and neither is its first chapter");
  lookupChapter = null;
  assert.strictEqual(await OT.rawHostOf("1", "en"), "", "no chapter id means no answer");
  lookupChapter = { id: 8885200 };
  const before = fetched.length;
  assert.strictEqual(await OT.rawHostOf("8053; drop", "en"), "", "a bad id is refused");
  assert.strictEqual(await OT.rawHostOf("8053", "../x"), "", "a bad language is refused");
  assert.strictEqual(fetched.length, before, "without any request");

  // ---- the source named in the novel's own page data (serie.raws[].slug) ----
  fetched.length = 0;
  // fanqienovel cannot be read, but tomatomtl.com mirrors it: the Raw link lands on the fanqie chapter, whose page names the book
  goToRawUrl = "https://fanqienovel.com/reader/7690957211404599870";
  goToRawBody = String.raw`x,\"bookId\":\"\",y,\"bookId\":\"7553857878021377086\",z`; // (inside a JSON string, so the quotes are escaped)
  assert.strictEqual(JSON.stringify(await OT.rawSourceOf("106122", "en", "fanqienovel")), JSON.stringify({ host: "tomatomtl.com", first: "https://tomatomtl.com/book/7553857878021377086/7690957211404599870" }), "a fanqienovel novel is read from its mirror: its address there, from the Raw link and the page it lands on");
  goToRawBody = "";
  assert.strictEqual(JSON.stringify(await OT.rawSourceOf("106122", "en", "fanqienovel")), JSON.stringify({ host: "tomatomtl.com", first: "" }), "if the page does not say which book, the mirror is still the site, with no address");
  assert.strictEqual(JSON.stringify(await OT.rawSourceOf("1", "en", "some-unknown-site")), JSON.stringify({ host: "", first: "" }), "a source slug that is not one of ours is answered at once");
  fetched.length = 0;
  await OT.rawSourceOf("1", "en", "some-unknown-site");
  assert.strictEqual(fetched.length, 0, "without a single request");
  goToRawUrl = "https://www.biquge.tw/book/201675/73322728.html";
  assert.strictEqual(JSON.stringify(await OT.rawSourceOf("102833", "en", "biquge.tw")), JSON.stringify({ host: "biquge.tw", first: goToRawUrl }), "a readable one: the host from the slug, chapter 1's address from the lookup");
  lookupChapter = null; // the lookup fails (a check, a bad answer): the site is still known
  assert.strictEqual(JSON.stringify(await OT.rawSourceOf("105662", "en", "69shu")), JSON.stringify({ host: "69shuba.com", first: "" }), "'69shu' is 69shuba.com, and it stays known without the address");
  lookupChapter = { id: 8885200 };
  const RS = vm.runInContext("RawSources", ctx);
  assert.deepStrictEqual(["uuread", "twkan.com", "69shu", "nope", "", "fanqienovel"].map((x) => RS.hostForSlug(x)), ["uuread.tw", "twkan.com", "69shuba.com", "", "", "tomatomtl.com"], "slugs as a name, a domain or an alias");

  // ---- a chapter that is already English is not translated ----
  const english = ("The old master looked at the boy and said that he had not come to the mountain for the sword. " +
    "It was not the first time that he had seen a young man with such fire in his eyes, and it would not be the last. ").repeat(5);
  const chinese = "这是一个很长的故事。老师傅看着那个男孩，说他上山不是为了剑。".repeat(20);
  const spanish = ("El viejo maestro miró al muchacho y le dijo que no había venido a la montaña por la espada. Era una historia muy larga y muy antigua. ").repeat(5);
  assert.deepStrictEqual([english, chinese, spanish, "short English text", "", null].map((t) => OT.isEnglish(t)), [true, false, false, false, false, false], "English prose is told from other scripts, other Latin-script languages, and text too short to judge");
  assert.strictEqual(OT.isEnglish(english.slice(0, 120) + chinese.slice(0, 200)), false, "a page with a good deal of another script is not English");
  assert.deepStrictEqual([[spanish, "es"], [spanish, "pt-BR"], [english, "es"], [english, "en"], [chinese, "zh"], [chinese, "ja"], [chinese, "es"], [spanish, "en"]].map(([t, l]) => OT.isLanguage(t, l)), [true, false, false, true, true, false, false, false], "text already in the language to translate into is told from other languages");
  const translated = []; // what reaches the translator
  ctx.translateText = async (text) => { translated.push(text.slice(0, 20)); return { translated: "T:" + text.slice(0, 10), suggestions: [], model: "gemini" }; };
  Object.keys(storage).forEach((k) => delete storage[k]);
  const resultEn = await OT.run({ url: "https://novgo.net/book/chapter-206.html", text: english, novelName: "Sword God", pageTitle: "Chapter 206", next: "https://novgo.net/book/chapter-207.html" });
  assert.strictEqual(resultEn.ok, true);
  assert.deepStrictEqual(translated, [], "an English chapter never reaches the translator");
  const keptEn = storage["translation:https://novgo.net/book/chapter-206.html"];
  assert.deepStrictEqual([keptEn.translated === english, keptEn.model, keptEn.pageTitle, keptEn.novelName, keptEn.next], [true, "english source", "Chapter 206", "Sword God", "https://novgo.net/book/chapter-207.html"], "its text is kept as it is, as the chapter's own copy");
  await OT.run({ url: "https://example.com/ch/1", text: chinese, novelName: "N", pageTitle: "T" });
  assert.strictEqual(translated.length, 1, "a Chinese chapter is translated");
  // a re-fetch (force) replaces the saved copy with the fresh text, still untranslated
  const fresh = english + " A new paragraph added by the site.";
  await OT.run({ url: "https://novgo.net/book/chapter-206.html", text: fresh, force: true, novelName: "Sword God", pageTitle: "Chapter 206" });
  assert.strictEqual(translated.length, 1, "re-fetching an English chapter does not translate it");
  assert.strictEqual(storage["translation:https://novgo.net/book/chapter-206.html"].translated, fresh, "it replaces the saved copy with the fresh text");
  // only an asked-for re-translate sends it to the translator
  await OT.run({ url: "https://novgo.net/book/chapter-206.html", text: english, force: true, retranslate: true, novelName: "Sword God", pageTitle: "Chapter 206" });
  assert.strictEqual(translated.length, 2, "re-translate on purpose goes to the translator");

  // ---- binding the novel's glossary to its new source ----
  await OT.bindSource("https://www.uuread.tw/chapter/1878627/2213453.html", "93016");
  assert.strictEqual(JSON.stringify(bound), JSON.stringify([["uuread.tw/chapter/1878627", ["wtr-lab:93016"]]]), "bound under the site + directory key every glossary binding uses");
  storage.glossaryBindings = { "uuread.tw/chapter/1878627": { ids: ["wtr-lab:93016"] } };
  await OT.bindSource("https://www.uuread.tw/chapter/1878627/2213454.html", "93016");
  assert.strictEqual(bound.length, 1, "a novel that already has a binding keeps it");
  storage.glossaryBindings = { "uuread.tw/chapter/1878627": { ids: ["wtr-lab:1"] } };
  await OT.bindSource("https://www.uuread.tw/chapter/1878627/2213455.html", "93016");
  assert.strictEqual(bound.length, 1, "and one the user chose is never overwritten");
  await OT.bindSource("https://www.uuread.tw/chapter/1878627/2213453.html", "not-a-number");
  assert.strictEqual(bound.length, 1, "a bad id binds nothing");

  // ---- run(): an existing translation is kept unless the job is forced ----
  const key = "translation:https://www.uuread.tw/chapter/1/10.html";
  storage[key] = { translated: "old English", model: "gemini", savedAt: 1 };
  ctx.translateText = async () => ({ translated: "new English", suggestions: [], model: "gemini" });
  assert.strictEqual((await OT.run({ url: "https://www.uuread.tw/chapter/1/10.html", text: "原文", pageTitle: "Chapter 1", novelName: "N" })).skipped, true, "not replaced by default");
  assert.strictEqual(storage[key].translated, "old English");
  await OT.run({ url: "https://www.uuread.tw/chapter/1/10.html", text: "原文", pageTitle: "Chapter 1", novelName: "N", next: "https://www.uuread.tw/chapter/1/11.html", force: true });
  assert.strictEqual(storage[key].translated, "new English", "a forced job replaces it");
  // the novel's index of mentions: the terms of the glossary found in a chapter, and Gemini's suggestions found in it, by the chapter's number
  storage.glossary = [{ terms: ["傅心汉"], translation: "Fu Xinhan", scope: "global", source: "manual" }];
  ctx.translateText = async () => ({ translated: "x", suggestions: [{ term: "天道", translation: "Heavenly Dao", kind: "other" }], model: "gemini" });
  await OT.run({ url: "https://www.uuread.tw/chapter/1/20.html", text: "傅心汉说天道无情", pageTitle: "Chapter 7", novelName: "N", force: true });
  await OT.run({ url: "https://www.uuread.tw/chapter/1/21.html", text: "傅心汉来了", pageTitle: "Chapter 8", novelName: "N", force: true });
  const mentions = storage.termMentions["uuread.tw/chapter/1"];
  assert.strictEqual(JSON.stringify(mentions && mentions.terms), JSON.stringify({ "傅心汉": "7-8", "天道": "7" }), "kept per novel, by chapter number");
  delete storage.glossary;
  ctx.translateText = async () => ({ translated: "new English", suggestions: [], model: "gemini" });
  // the reader's Custom prompt: with English glossary ticked, your English fixes are done on the answer (none of it is sent), in English only
  const k12 = "translation:https://www.uuread.tw/chapter/1/12.html";
  storage.glossary = [{ terms: ["Xia kingdom"], translation: "China", scope: "global", source: "replace" }, { terms: ["Elsewhere"], translation: "Here", scope: "site", hostname: "other.example", source: "replace" }];
  storage.myTerms = [{ id: "a", from: ["Qi Yuan"], to: "Chi Yuan", cs: false, keys: [] }];
  let promptGot = null;
  ctx.translateText = async (text, g, m, n, l, extra) => { promptGot = extra && extra.prompt; return { translated: "The Xia kingdom sent Qi Yuan. Elsewhere, no.", suggestions: [], model: "gemini" }; };
  const custom = { prompt: "My prompt.", notes: false, glossary: true, replace: true };
  await OT.run({ url: "https://www.uuread.tw/chapter/1/12.html", text: "原文", force: true, retranslate: true, custom });
  assert.strictEqual(promptGot, "My prompt.", "the prompt chosen goes to the translator");
  assert.strictEqual(storage[k12].translated, "The China sent Chi Yuan. Elsewhere, no.", "your fixes are done on the answer: your own for every site, your terms; not another site's");
  await OT.run({ url: "https://www.uuread.tw/chapter/1/12.html", text: "原文", force: true, retranslate: true, custom: { ...custom, replace: false } });
  assert.strictEqual(storage[k12].translated, "The Xia kingdom sent Qi Yuan. Elsewhere, no.", "not ticked: the answer as it is");
  await OT.run({ url: "https://www.uuread.tw/chapter/1/12.html", text: "原文", force: true, retranslate: true, lang: "es", custom });
  assert.strictEqual(storage[k12 + "#lang=es"].translated, "The Xia kingdom sent Qi Yuan. Elsewhere, no.", "into another language: they are English fixes, not done");
  delete storage.glossary;
  delete storage.myTerms;
  assert.strictEqual(storage[key].next, "https://www.uuread.tw/chapter/1/11.html", "and keeps the link to the next chapter");
  assert.ok(storage[key].savedAt > 1, "as a newer version");

  // ---- another language: a version of the same chapter, an entry of its own beside the English one ----
  const url10 = "https://www.uuread.tw/chapter/1/10.html";
  let asked = null;
  ctx.translateText = async (text, glossary, model, notes, language) => { asked = language; return { translated: "Hola", suggestions: [], model: "gemini" }; };
  const made = await OT.run({ url: url10, text: "原文", pageTitle: "Capítulo 1", novelName: "N", lang: "es" });
  assert.strictEqual(made.lang, "es");
  assert.strictEqual(asked, "es", "into the language the job says");
  assert.strictEqual(storage[key + "#lang=es"].translated, "Hola", "kept under its own key");
  assert.strictEqual(storage[key].translated, "new English", "the English one is as it was");
  assert.strictEqual(storage[key + "#lang=es"].pageTitle, "Capítulo 1");
  asked = null;
  assert.strictEqual((await OT.run({ url: url10, text: "原文", lang: "es" })).skipped, true, "a version already there is not made again");
  assert.strictEqual(asked, null);
  ctx.GlossaryServer.targetLanguage = async () => "fr";
  await OT.run({ url: url10, text: "原文", pageTitle: "Chapitre 1", novelName: "N" });
  assert.strictEqual(asked, "fr", "no language said: the library's");
  assert.ok(storage[key + "#lang=fr"], "its own entry too");
  await OT.run({ url: url10, text: "原文", pageTitle: "Chapter 1", novelName: "N", lang: "en", force: true });
  assert.strictEqual(asked, "en", "English asked for on purpose, whatever the library says");
  // a chapter that is English already is kept as it is for English, and translated for another language
  const englishText = "The wizard walked into the old tower and looked at the glowing stones, and he was sure that this was what he had been looking for all those years. ".repeat(6);
  const url11 = "https://www.uuread.tw/chapter/1/11.html";
  asked = null;
  await OT.run({ url: url11, text: englishText, lang: "en" });
  assert.strictEqual(storage["translation:" + url11].model, "english source");
  assert.strictEqual(asked, null, "not sent to the translator");
  await OT.run({ url: url11, text: englishText, lang: "es" });
  assert.strictEqual(asked, "es", "into another language: translated like any other");
  assert.strictEqual(storage["translation:" + url11 + "#lang=es"].translated, "Hola");
  delete ctx.GlossaryServer.targetLanguage;
  // saveUrl: a site chapter translated from its source's original is kept as a version of the site chapter itself
  const wtrUrl = "https://wtr-lab.com/en/novel/5045/golden/chapter-117";
  asked = null;
  const viaSource = await OT.run({ url: "https://www.69shuba.com/txt/1/117", saveUrl: wtrUrl, text: "原文", pageTitle: "Chapter 117", novelName: "N", lang: "si" });
  assert.strictEqual(viaSource.lang, "si");
  assert.strictEqual(storage["translation:" + wtrUrl + "#lang=si"].translated, "Hola", "under the wtr-lab chapter's own key");
  assert.ok(!storage["translation:https://www.69shuba.com/txt/1/117#lang=si"] && !storage["translation:https://www.69shuba.com/txt/1/117"], "and not under the source's");
  asked = null;
  assert.strictEqual((await OT.run({ url: "https://www.69shuba.com/txt/1/117", saveUrl: wtrUrl, text: "原文", lang: "si" })).skipped, true, "a version there is not made again");
  assert.strictEqual(asked, null);

  console.log("OK — original-translate checks passed");
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
