// Run: node test/term-notes.test.js
const assert = require("assert");

// what the background script has around the module: storage, the library, wtr-terms and Gemini (all stand-ins)
const stored = { glossaryBindings: { "69shuba.com/txt/90001": { ids: ["wtr-lab:5045"] } } };
global.chrome = { storage: { local: { get: async () => stored, set: async (o) => Object.assign(stored, o) } } };
global.WtrTerms = require("../src/shared/wtr-terms.js");
global.TermMatch = require("../src/shared/term-match.js");
const calls = [];
let settings = { termNotesAi: true };
let serverNotes = [{ source: "神光宗", ai: "- a sect on Canglan Realm (ch1)", text: "my own note" }];
global.GlossaryServer = {
  api: async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/api/settings") return settings;
    if (path.startsWith("/api/term-notes")) return method === "GET" ? { notes: serverNotes } : { results: [] };
    if (path.startsWith("/api/chapter-index")) return { indexes: [{ chapters: [[7, "第七章", "https://www.69shuba.com/txt/90001/7.html"]] }] };
    throw new Error("unexpected " + path);
  }
};
let geminiGot = null;
let geminiNotesGot = null;
let geminiNotesSays = { notes: [] };
let geminiNotesCalls = 0;
let geminiNotesPrompt = null;
global.geminiTermNotes = async (text, notes, model, prompt) => { geminiNotesCalls++; geminiNotesGot = notes; geminiNotesPrompt = prompt; return geminiNotesSays; };
let geminiSays = null;
let languageGot = null;
let extraGot = null;
global.translateText = async (text, glossary, model, notes, language, extra) => {
  geminiGot = notes;
  extraGot = extra;
  languageGot = { glossary, language };
  return Object.assign({ translated: "EN", suggestions: [], model: "m" }, geminiSays);
};
const TermNotes = require("../src/shared/term-notes.js");

const glossary = [
  { terms: ["神光宗"], translation: "Divine Radiance Sect" },
  { terms: ["齐原"], translation: "Qi Yuan" },
  { terms: ["不在"], translation: "Absent" },
  { terms: ["morning bell"], translation: "dawn bell", source: "replace" }
];
const job = { text: "齐原在神光宗 morning bell", glossary, model: "m", url: "https://www.69shuba.com/txt/90001/1.html", title: "第1章 齐原", novelName: "Golden Elixir" };

(async () => {
  assert.strictEqual(TermNotes.chapterNumber("第12章 齐原"), 12);
  assert.strictEqual(TermNotes.chapterNumber("Chapter 3: Qi Yuan"), 3);
  assert.strictEqual(TermNotes.chapterNumber("后记"), null);

  // on: the notes of the terms in the chapter go along, the ones with notes first; terms not in it, and replacements, do not
  const ctx = await TermNotes.context(job);
  assert.deepStrictEqual(ctx, {
    chapter: 1,
    keys: ["69shuba.com/txt/90001", "wtr-lab:5045"],
    items: [
      { term: "神光宗", english: "Divine Radiance Sect", note: "- a sect on Canglan Realm (ch1)", yours: "my own note" },
      { term: "齐原", english: "Qi Yuan", note: "", yours: "" }
    ]
  });
  assert.ok(calls.some(([m, p]) => m === "GET" && p === "/api/term-notes?key=" + encodeURIComponent("69shuba.com/txt/90001,wtr-lab:5045")), "the novel's notes, by its keys");
  // the terms are found the way they are chosen for a translation: 白 in 明白 is not a term of the chapter
  assert.strictEqual(await TermNotes.context(Object.assign({}, job, { text: "他终于明白了，墙是白色的。", glossary: [{ terms: ["白"], translation: "Bai" }] })), null, "no term in it: no notes");

  // a title without a number: the chapter list says which one it is
  assert.strictEqual((await TermNotes.context(Object.assign({}, job, { url: "https://www.69shuba.com/txt/90001/7.html", title: "后记" }))).chapter, 7);

  // Gemini's changed notes are saved as its own (only real changes, only for terms it was given); yours are never sent back
  calls.length = 0;
  geminiSays = { notes: [
    { term: "神光宗", note: "- a sect on Canglan Realm (ch1)\n- Qi Yuan is its only disciple (ch1)" },
    { term: "齐原", note: "- disciple of the Divine Radiance Sect (ch1)" },
    { term: "不在", note: "- made up" },
    { term: "神光宗", note: "" }
  ] };
  const res = await TermNotes.translate(job);
  assert.deepStrictEqual(res, { translated: "EN", suggestions: [], model: "m", language: "en" }, "the translation, without the notes, and the language it is in");
  assert.strictEqual(geminiGot.items.length, 2);
  const put = calls.find(([m, p]) => m === "PUT" && p === "/api/term-notes");
  assert.deepStrictEqual(put[2].notes.map((n) => [n.source, n.ai, n.chapter, n.novel, n.text]), [
    ["神光宗", "- a sect on Canglan Realm (ch1)\n- Qi Yuan is its only disciple (ch1)", "1", "Golden Elixir", undefined],
    ["齐原", "- disciple of the Divine Radiance Sect (ch1)", "1", "Golden Elixir", undefined]
  ]);

  // the library's reader asked for no notes for this chapter (beyond its "notes for the next N chapters")
  geminiGot = "untouched";
  await TermNotes.translate(Object.assign({}, job, { notes: 0 }));
  assert.strictEqual(geminiGot, null, "notes: 0 sends none");
  assert.ok((await TermNotes.context(Object.assign({}, job, { notes: 2 }))).items.length, "notes: 2 sends them");

  // a chapter whose notes are made (with its translation) is not sent again alone
  assert.ok(await TermNotes.isDone(job.url), "translated with notes: done");
  geminiNotesCalls = 0;
  assert.deepStrictEqual(await TermNotes.notesOnly({ url: job.url, title: job.title, text: "Qi Yuan of the Divine Radiance Sect", novelName: "x" }), { ok: true, skipped: "done before" });
  assert.strictEqual(geminiNotesCalls, 0);

  // only the notes, for a chapter already in English (the site's): its terms found by their English, the novel's glossary by its the site id
  stored.glossaryLibrary = { "wtr-lab:5045": { terms: [["神光宗", "Divine Radiance Sect"], ["齐原", "Qi Yuan"], ["钥", "Key"], ["无", "Nowhere"]] } };
  calls.length = 0;
  geminiSays = null;
  geminiNotesSays = { notes: [{ term: "齐原", note: "- the only disciple of the Divine Radiance Sect (ch2)" }] };
  const wtrUrl = "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-2";
  const only = await TermNotes.notesOnly({ url: wtrUrl, title: "Jiang Lingsu", text: "Qi Yuan bowed. The Divine Radiance Sect was quiet. A key turned.", novelName: "Golden Elixir" });
  assert.deepStrictEqual(only, { ok: true, saved: 1 });
  assert.deepStrictEqual(geminiNotesGot.items.map((i) => i.term), ["神光宗", "齐原"], "the terms in the English text (\"key\" is not the name Key; Nowhere is not in it)");
  assert.strictEqual(geminiNotesGot.chapter, 2, "the chapter's number from its address");
  const putOnly = calls.find(([m, p]) => m === "PUT" && p === "/api/term-notes");
  assert.deepStrictEqual(putOnly[2].notes.map((n) => [n.source, n.chapter, n.keys.includes("wtr-lab:5045")]), [["齐原", "2", true]]);
  assert.ok(await TermNotes.isDone(wtrUrl));
  assert.deepStrictEqual(await TermNotes.notesOnly({ url: wtrUrl, title: "x", text: "Qi Yuan", notes: 3 }), { ok: true, skipped: "done before" });
  geminiNotesCalls = 0;
  await TermNotes.notesOnly({ url: wtrUrl, title: "x", text: "Qi Yuan", force: true });
  assert.strictEqual(geminiNotesCalls, 1, "asked for again on purpose");
  assert.deepStrictEqual(await TermNotes.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-3", title: "x", text: "nothing known here", force: true }),
    { ok: true, skipped: "none of the novel's glossary terms is in it" }, "why nothing was sent");
  assert.deepStrictEqual(await TermNotes.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/", title: "Afterword", text: "Qi Yuan", force: true }),
    { ok: true, skipped: "the chapter's number is not known (its title has none, and the novel's chapter list does not have it)" });

  // an unchanged note is not written again
  calls.length = 0;
  geminiSays = { notes: [{ term: "神光宗", note: "- a sect on Canglan Realm (ch1)" }] };
  await TermNotes.translate(job);
  assert.ok(!calls.some(([m]) => m === "PUT"));

  // off (the default): nothing is sent, nothing asked of the server's notes
  settings = {};
  calls.length = 0;
  await new Promise((r) => setTimeout(r, 0));
  // (the switch is read at most once a minute: start a fresh copy of the module to see it off)
  delete require.cache[require.resolve("../src/shared/term-notes.js")];
  const Fresh = require("../src/shared/term-notes.js");
  geminiGot = "untouched";
  await Fresh.translate(job);
  assert.strictEqual(geminiGot, null, "no notes go to Gemini");
  assert.ok(!calls.some(([, p]) => p.startsWith("/api/term-notes")));
  assert.deepStrictEqual(await Fresh.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-9", title: "x", text: "Qi Yuan" }), { ok: true, skipped: "notes are off" }, "off: not by itself");
  geminiNotesCalls = 0;
  assert.deepStrictEqual(await Fresh.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-9", title: "x", text: "Qi Yuan", force: true }), { ok: true, saved: 1 }, "but the reader's button is asking");
  assert.strictEqual(geminiNotesCalls, 1);
  const oldApi = GlossaryServer.api;
  GlossaryServer.api = async (m, path) => { if (path.startsWith("/api/term-notes")) throw new Error("server error 404"); return oldApi(m, path); };
  assert.deepStrictEqual(await Fresh.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-10", title: "x", text: "Qi Yuan", force: true }), { error: "the notes could not be read from the library (server error 404)" }, "a server without notes says so");
  GlossaryServer.api = oldApi;

  // ---- another language: the bound glossary (the site's, English) is only the list of terms; its renderings in the language are the ones made before ----
  settings = {};
  const made = new Map(); // glossary id -> [[source, translation]]
  const added = [];
  GlossaryServer.targetLanguage = async () => "es";
  GlossaryServer.api = async (method, path, body) => {
    const m = /^\/api\/glossaries\/([^/]+?)(\/add)?$/.exec(path);
    if (m && method === "GET" && made.has(decodeURIComponent(m[1]))) return { terms: made.get(decodeURIComponent(m[1])).map(([s, e]) => [s, e, "gemini", { o: "gemini" }]) };
    if (m && method === "GET") throw new Error("no such glossary");
    if (m && m[2] && method === "POST") { added.push([decodeURIComponent(m[1]), body]); return { added: body.terms.length }; }
    return oldApi(method, path, body);
  };
  const bound = [
    { terms: ["神光宗"], translation: "Divine Radiance Sect", source: "wtr" }, { terms: ["齐原"], translation: "Qi Yuan", source: "wtr" },
    { terms: ["自己"], translation: "mine", scope: "global", source: "manual" }
  ];
  stored.glossaryLibrary = { "wtr-lab:5045": { id: "wtr-lab:5045", name: "golden-elixir[wtr-lab]", site: "wtr-lab", rawId: "5045", slug: "golden-elixir", terms: [] } };
  geminiSays = { suggestions: [{ term: "神光宗", translation: "Secta del Resplandor Divino" }, { term: "新词", translation: "Palabra nueva" }] };
  await Fresh.translate({ text: "齐原在神光宗 自己", glossary: bound, model: "m", url: "https://www.69shuba.com/txt/90001/1.html", title: "x", novelName: "n" });
  assert.strictEqual(languageGot.language, "es");
  assert.deepStrictEqual(languageGot.glossary.map((e) => [e.terms[0], e.translation]), [["神光宗", ""], ["齐原", ""], ["自己", "mine"]], "no English goes to Gemini: the terms of the novel are asked for; the person's own are as they are");
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0][0], "wtr-lab:5045@es", "kept as the novel's glossary in that language");
  assert.deepStrictEqual(added[0][1].terms, [["神光宗", "Secta del Resplandor Divino"], ["新词", "Palabra nueva"]], "what Gemini answered, its terms and the new ones");
  assert.strictEqual(added[0][1].name, "golden-elixir[wtr-lab] (es)");
  made.set("wtr-lab:5045@es", [["神光宗", "Secta del Resplandor Divino"], ["新词", "Palabra nueva"]]);
  added.length = 0;
  geminiSays = { suggestions: [{ term: "神光宗", translation: "Otra" }, { term: "齐原", translation: "Qi Yuan" }] };
  await Fresh.translate({ text: "齐原在神光宗 新词", glossary: bound, model: "m", url: "https://www.69shuba.com/txt/90001/2.html", title: "x", novelName: "n" });
  assert.deepStrictEqual(languageGot.glossary.map((e) => [e.terms[0], e.translation]), [["神光宗", "Secta del Resplandor Divino"], ["齐原", ""], ["自己", "mine"], ["新词", "Palabra nueva"]], "made before: given; not yet: asked for; found by Gemini before: given too");
  assert.deepStrictEqual(added[0][1].terms, [["齐原", "Qi Yuan"]], "only what is new is kept: the first rendering of a term stays");
  // a novel with no bound glossary: nothing to keep it in
  added.length = 0;
  await Fresh.translate({ text: "齐原", glossary: bound, model: "m", url: "https://www.69shuba.com/txt/99999/1.html", title: "x", novelName: "n" });
  assert.strictEqual(added.length, 0);
  // The site's own English text of a chapter (its source could not be read): the bound glossary's English renderings found in it are the terms, kept under their source
  stored.glossaryLibrary["wtr-lab:5045"].terms = [["神光宗", "Divine Radiance Sect", { o: "novel" }], ["齐原", "Qi Yuan", { o: "novel" }], ["不在", "Absent One", { o: "novel" }]];
  made.clear();
  added.length = 0;
  geminiSays = { suggestions: [{ term: "Qi Yuan", translation: "Qi Yuan" }, { term: "Divine Radiance Sect", translation: "Secta del Resplandor" }, { term: "Other Place", translation: "Otro lugar" }] };
  await Fresh.translate({ text: "Qi Yuan went to the Divine Radiance Sect.", glossary: [], model: "m", url: "https://wtr-lab.com/en/novel/5045/golden/chapter-9", title: "x", novelName: "n", english: true });
  assert.deepStrictEqual(languageGot.glossary.map((e) => [e.terms[0], e.translation]), [["Divine Radiance Sect", ""], ["Qi Yuan", ""]], "the glossary's English found in the text, asked for; the one not in it is not");
  assert.strictEqual(added[0][0], "wtr-lab:5045@es", "a wtr-lab chapter's own glossary needs no binding");
  assert.deepStrictEqual(added[0][1].terms, [["齐原", "Qi Yuan"], ["神光宗", "Secta del Resplandor"], ["Other Place", "Otro lugar"]], "kept under the source terms; a term the glossary has no source for, under its own words");
  made.set("wtr-lab:5045@es", [["神光宗", "Secta del Resplandor"]]);
  made.clear();
  made.set("wtr-lab:5045@es", [["神光宗", "Secta del Resplandor"]]);
  added.length = 0;
  await Fresh.translate({ text: "Qi Yuan went to the Divine Radiance Sect.", glossary: [], model: "m", url: "https://wtr-lab.com/en/novel/5045/golden/chapter-10", title: "x", novelName: "n", english: true });
  assert.deepStrictEqual(languageGot.glossary.filter((e) => /[A-Za-z]/.test(e.terms[0])).map((e) => [e.terms[0], e.translation]), [["Divine Radiance Sect", "Secta del Resplandor"], ["Qi Yuan", ""]], "one made before is given by its English too");
  made.clear();
  GlossaryServer.targetLanguage = async () => "en";
  languageGot = null;
  await Fresh.translate(job);
  assert.strictEqual(languageGot.language, "en");
  assert.strictEqual(languageGot.glossary, glossary, "English: the glossary as it is");

  // ---- the reader's Custom prompt: this request's prompt, and what goes with it as chosen (the switch is off here) ----
  geminiGot = "untouched";
  await Fresh.translate(job);
  assert.strictEqual(extraGot, undefined, "no custom prompt: nothing added");
  await Fresh.translate({ ...job, custom: { prompt: "Mine.", notes: false, glossary: true } });
  assert.strictEqual(extraGot.prompt, "Mine.", "the prompt chosen");
  assert.strictEqual(geminiGot, null, "no notes when they are not ticked");
  assert.strictEqual(languageGot.glossary, glossary, "the glossary when it is ticked");
  await Fresh.translate({ ...job, custom: { prompt: "Mine.", notes: true, glossary: false } });
  assert.deepStrictEqual(geminiGot.items.map((i) => i.term), ["神光宗", "齐原"], "the notes when ticked, though the switch is off");
  assert.deepStrictEqual(languageGot.glossary, [], "and no glossary when it is not ticked");
  geminiNotesPrompt = "untouched";
  await Fresh.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-11", title: "x", text: "Qi Yuan", force: true });
  assert.strictEqual(geminiNotesPrompt, undefined, "notes alone: the prompt in use");
  await Fresh.notesOnly({ url: "https://wtr-lab.com/en/novel/5045/golden-elixir/chapter-11", title: "x", text: "Qi Yuan", force: true, custom: { prompt: "Notes mine." } });
  assert.strictEqual(geminiNotesPrompt, "Notes mine.", "or the one chosen");

  console.log("OK — term-notes checks passed");
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
