// The prompts sent to Gemini can be changed (gemini.js GEMINI_PROMPTS; the library's setting geminiPrompts, in Settings › Translation): a changed one is what is
// sent, with its {placeholders} filled in and what goes with it added whatever it says; blank is the default. No network: fetch is stood in for.
// Run: node test/gemini-prompts.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

async function sentWith(prompts) {
  const sent = [];
  const ctx = vm.createContext({
    chrome: { storage: { local: { get: async () => ({ geminiApiKey: "test-key" }) } } },
    GlossaryServer: { promptSettings: async () => ({ sets: {}, legacy: prompts || {} }) },
    fetch: async (u, o) => {
      sent.push(JSON.parse(o.body).contents[0].parts[0].text);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }) };
    },
    setTimeout, Date, Promise, JSON, console
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8") + ";globalThis.t = { translateText, geminiDetectBook, geminiTermNotes, GEMINI_PROMPTS };", ctx);
  const notes = { chapter: 7, items: [{ term: "道", english: "Dao", note: "" }] };
  await ctx.t.translateText("文本 道", [{ terms: ["道"], translation: "Dao" }], "m", notes);
  await ctx.t.geminiDetectBook([{ id: "a", kind: "text" }], { host: "x.com", title: "Book" });
  await ctx.t.geminiTermNotes("text", notes, "m");
  return { sent, defaults: ctx.t.GEMINI_PROMPTS };
}

(async () => {
  // the defaults
  const { sent: plain, defaults } = await sentWith(undefined);
  const english = (p) => p.split("{language}").join("English"); // ({language} is filled in: the language chapters are translated into)
  assert.ok(plain[0].startsWith(english(defaults.translate) + "\n\n"), "the default translation prompt, then the glossary and the chapter");
  assert.ok(plain[0].includes("道 = Dao") && plain[0].endsWith("文本 道"));
  assert.ok(plain[1].includes("(x.com, titled \"Book\")") && plain[1].endsWith('[{"id":"a","kind":"text"}]'), "detection: the page filled in, its elements after");
  assert.ok(plain[2].startsWith("This text is chapter 7 of a novel, already in English. "), "notes alone: the chapter's number and that it is in English");

  // changed ones
  const { sent } = await sentWith({ translate: "Make it sound like Shakespeare.", notes: "Chapter {chapter}{how}keep notes.", detect: "Page of {host}: {title}?" });
  assert.ok(sent[0].startsWith("Make it sound like Shakespeare.\n\n"), "the changed translation prompt is sent");
  assert.ok(sent[0].includes("道 = Dao") && sent[0].endsWith("文本 道"), "with the glossary and the chapter still");
  assert.ok(sent[0].includes("Chapter 7. Beside translating it, keep notes.\n[{\"term\":\"道\""), "the changed notes prompt beside a translation, the terms added though it has no {terms}");
  assert.ok(sent[1].startsWith("Page of x.com: Book?\n\n") && sent[1].endsWith('[{"id":"a","kind":"text"}]'), "the changed detection prompt, filled in, the elements after");
  assert.ok(sent[2].startsWith("Chapter 7, already in English. keep notes."), "the changed notes prompt alone");

  // blank: the default
  const { sent: blank } = await sentWith({ translate: "   " });
  assert.ok(blank[0].startsWith(english(defaults.translate)), "a blank prompt is the default");

  // another language: the prompt says which, a term that has a rendering there is given, a term that has none is asked for and kept in the suggestions
  // (a term that had a rendering is not)
  const load = (own, answer) => {
    const sentTo = [];
    const c = vm.createContext({
      chrome: { storage: { local: { get: async () => ({ geminiApiKey: "test-key" }) } } }, GlossaryServer: { promptSettings: async () => (own && own.sets ? own : { sets: {}, legacy: own || {} }) },
      fetch: async (u, o) => { sentTo.push(JSON.parse(o.body).contents[0].parts[0].text); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] } }] }) }; },
      setTimeout, Date, Promise, JSON, console
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8") + ";globalThis.t = { translateText, geminiTermNotes, geminiLanguageName, GEMINI_PROMPT_PRESETS };", c);
    return { sentTo, t: c.t };
  };
  const es = load({}, JSON.stringify({ translated: "x", suggestions: [{ term: "科雷", translation: "Corey" }, { term: "道", translation: "Camino" }] }));
  const r = await es.t.translateText("道 科雷 文本", [{ terms: ["道"], translation: "Camino" }, { terms: ["科雷"], translation: "" }, { terms: ["不在"], translation: "" }], "m", null, "es");
  assert.ok(es.sentTo[0].startsWith("Translate the following text to Spanish,") && es.sentTo[0].includes("suggest a Spanish translation"), "into the language asked for");
  assert.ok(es.sentTo[0].includes("道 = Camino") && !es.sentTo[0].includes("不在"), "a rendering is given, only for the terms in the text");
  assert.ok(es.sentTo[0].includes("no Spanish translation yet") && es.sentTo[0].includes("科雷\n\n"), "a term with none is asked for");
  assert.deepStrictEqual(r.suggestions.map((s) => s.term), ["科雷"], "its translation is kept as a suggestion; the one that already had a rendering is not");
  assert.strictEqual(es.t.geminiLanguageName("pt"), "Portuguese");
  assert.strictEqual(es.t.geminiLanguageName("xx"), "xx");
  // a prompt of the person's own that does not say {language} is told after it
  const ru = load({ translate: "Translate it." }, "{}");
  await ru.t.translateText("文本", [], "m", null, "ru");
  assert.ok(ru.sentTo[0].startsWith("Translate it. Write the translation in Russian.\n\n"));
  // the reader's Custom prompt: the one chosen for this request is sent in place of the one in use, 
  const cu = load({ translate: "The one in use." }, "{}");
  await cu.t.translateText("文本 道", [{ terms: ["道"], translation: "Dao" }], "m", null, "en", { prompt: "Try this in {language}." });
  assert.strictEqual(cu.sentTo[0], "Try this in English." + String.fromCharCode(10, 10) + "Use these exact translations whenever these terms appear, for consistency:" + String.fromCharCode(10) + "道 = Dao" + String.fromCharCode(10, 10) + "文本 道");
  await cu.t.translateText("文本", [], "m", null, "en");
  assert.ok(cu.sentTo[1].startsWith("The one in use."), "without one: the prompt in use");
  await cu.t.geminiTermNotes("The text.", { chapter: 4, items: [{ term: "道", english: "Dao", note: "", yours: "" }] }, "m", "Chapter {chapter}{how}Notes please: {terms}");
  assert.ok(cu.sentTo[2].startsWith("Chapter 4, already in English. Notes please: [{"), "a notes prompt chosen for the request");
  // saved prompts (the library's promptSets): the one in use is sent, a built-in one by its id, one of the person's own by its id; one that is gone, or none: the default
  const presets = es.t.GEMINI_PROMPT_PRESETS;
  assert.strictEqual(presets.translate.map((p) => p.id).join(), "default,every-term,one-name,no-everyday");
  assert.ok(presets.translate.every((p) => p.name && p.text && p.text.includes("{language}")), "each is told the language");
  assert.ok(["notes", "detect"].every((k) => presets[k].length === 1 && presets[k][0].id === "default"));
  assert.strictEqual(presets.translate[0].text, defaults.translate, "the first is the default");
  const sets = (translate) => ({ sets: { translate }, legacy: {} });
  const built = load(sets({ active: "every-term", mine: [] }), "{}");
  await built.t.translateText("文本", [], "m", null, "en");
  assert.ok(built.sentTo[0].startsWith(english(presets.translate[1].text) + "\n\n"), "a built-in prompt, by its id");
  const mine = load(sets({ active: "p1", mine: [{ id: "p1", name: "Mine", text: "Say it in {language} please." }, { id: "p2", name: "Other", text: "No." }] }), "{}");
  await mine.t.translateText("文本", [], "m", null, "es");
  assert.ok(mine.sentTo[0].startsWith("Say it in Spanish please.\n\n"), "one of the person's own, by its id, with {language} filled in");
  for (const gone of [sets({ active: "p9", mine: [] }), sets({ active: "", mine: [] }), sets({ active: "p3", mine: [{ id: "p3", name: "Empty", text: "  " }] }), { sets: {}, legacy: {} }]) {
    const d = load(gone, "{}");
    await d.t.translateText("文本", [], "m", null, "en");
    assert.ok(d.sentTo[0].startsWith(english(defaults.translate) + "\n\n"), "a prompt that is gone or blank is the default");
  }
  const older = load({ sets: {}, legacy: { translate: "From before." } }, "{}");
  await older.t.translateText("文本", [], "m", null, "en");
  assert.ok(older.sentTo[0].startsWith("From before.\n\n"), "a prompt from before there were sets is still sent");
  console.log("OK — prompts");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
