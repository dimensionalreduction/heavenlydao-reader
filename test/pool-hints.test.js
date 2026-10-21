// The pool's terms a chapter is sent with, and kept in the novel once used (pool-hints.js), through a translation (term-notes.js translate). Stand-ins for storage,
// the library and Gemini; the rest is the extension's own code.
// Run: node test/pool-hints.test.js
const assert = require("assert");

const stored = {
  glossaryRev: 1,
  glossaryBindings: {},
  glossaryLibrary: {
    "wtr-lab:1": { terms: [["散修", "Loose Cultivator", { o: "novel" }], ["金丹", "Golden Core", { o: "novel" }]] },
    "wtr-lab:2": { terms: [["散修", "Loose Cultivator", { o: "ai" }], ["御兽", "Beast Taming", { o: "novel" }]] },
    "wtr-lab:3": { terms: [["御兽", "Beast Taming", { o: "novel" }], ["青云宗", "Azure Cloud Sect", { o: "novel" }]] },
    "wtr-lab:2@es": { terms: [["散修", "Cultivador suelto"]] },
    "copy:abc": { terms: [["散修", "Wandering Cultivator"], ["青云宗", "Blue Cloud Sect"]] }
  }
};
global.chrome = { storage: { local: { get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, stored[x]])) : { [k]: stored[k] }), set: async (o) => Object.assign(stored, o) } } };
global.WtrTerms = require("../src/shared/wtr-terms.js");
global.TermMatch = require("../src/shared/term-match.js");
global.TermPool = require("../src/shared/term-pool.js");
global.BASE_GLOSSARY = require("../src/shared/base-glossary.js");
const calls = [];
const bound = [];
let settings = {};
global.GlossaryServer = {
  api: async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/api/settings") return settings;
    if (/\/add$/.test(path)) return { added: (body.terms || []).length };
    throw new Error("unexpected " + path);
  },
  setBinding: async (key, ids) => { bound.push([key, ids]); stored.glossaryBindings[key] = { ids }; }
};
const PoolHints = require("../src/shared/pool-hints.js");
global.PoolHints = PoolHints;
let sent = null;
let says = []; // what Gemini suggests
global.translateText = async (text, glossary) => { sent = glossary; return { translated: "EN", suggestions: says, model: "m" }; };
global.geminiTermNotes = async () => ({ notes: [] });
const TermNotes = require("../src/shared/term-notes.js");

(async () => {
  const text = "他是一名散修，正在练御兽，有一颗金丹，金丹期的师兄来自青云宗。"; // (金丹期 is the base layer's: the longer term has 金丹 inside it, which is also found alone)
  const own = [{ terms: ["金丹"], translation: "Golden Core" }];

  // what two novels agree on, and the base layer's, for what the glossary has none of
  let got = await PoolHints.entriesFor(text, own);
  const by = new Map(got.map((e) => [e.terms[0], e]));
  assert.strictEqual(by.get("散修").translation, "Loose Cultivator", "two novels have it (the copy and the other language are not novels)");
  assert.strictEqual(by.get("御兽").translation, "Beast Taming");
  assert.strictEqual(by.get("师兄").translation, "Senior Martial Brother", "the base layer's, with no novel having it");
  assert.strictEqual(by.get("师兄").gender, "male");
  assert.ok(!by.has("金丹"), "a source the glossary has is never the pool's");
  assert.ok(!by.has("青云宗"), "a term of one novel is not in the pool (the copy's other rendering is no vote)");
  assert.ok(got.every((e) => e.source === "pool" && e.scope === "global"));
  assert.strictEqual((await PoolHints.entriesFor("没有这些词", own)).length, 0);

  // a translation: the pool's terms go with the glossary, and are kept in the novel
  const job = { text, glossary: own, model: "m", url: "https://www.69shuba.com/txt/90001/7.html", title: "第7章", novelName: "N", notes: 0 };
  await TermNotes.translate(job);
  const poolSent = sent.filter((e) => e.source === "pool").map((e) => e.terms[0]).sort();
  assert.deepStrictEqual(poolSent, ["师兄", "散修", "御兽", "金丹期"].sort(), "sent with the glossary");
  assert.strictEqual(sent.find((e) => e.terms[0] === "金丹").translation, "Golden Core", "the glossary's own is as it was");
  const add = calls.find(([m, p]) => m === "POST" && /adopted/.test(p));
  assert.ok(add, "the terms used are kept in the novel's own glossary");
  assert.strictEqual(decodeURIComponent(add[1]), "/api/glossaries/adopted:69shuba.com/txt/90001/add");
  assert.strictEqual(add[2].from, "pool");
  assert.deepStrictEqual(add[2].terms.map((t) => t[0]).sort(), ["师兄", "散修", "御兽", "金丹期"].sort());
  assert.deepStrictEqual(bound, [["69shuba.com/txt/90001", ["adopted:69shuba.com/txt/90001"]]], "and bound to it");

  // the terms Gemini suggested, kept in the novel too: those in the text that are a term and the glossary has none of
  const kept = calls.filter(([m, p, b]) => m === "POST" && /adopted/.test(p) && b.from === "gemini");
  assert.strictEqual(kept.length, 0, "nothing suggested, nothing kept");
  calls.length = 0;
  says = [{ term: "青云宗", translation: "Azure Cloud Sect", kind: "organization" }, { term: "道", translation: "Dao" }, { term: "不在文本里", translation: "Nope" }, { term: "金丹", translation: "Other Core" },
    { term: "散修", translation: "Rogue" }, { term: "他是一名散修正在练御兽有一颗", translation: "He is" }, { term: "师姐", translation: "A sentence. Two." }];
  await TermNotes.translate(job);
  const gem = calls.filter(([m, p, b]) => m === "POST" && /adopted/.test(p) && b.from === "gemini");
  assert.strictEqual(gem.length, 1, "kept in the novel's glossary");
  assert.deepStrictEqual(gem[0][2].terms, [["青云宗", "Azure Cloud Sect"]], "only what is in the text, is a term, and the glossary (and the pool's) has no rendering of");
  assert.strictEqual(bound.length, 1, "bound once");
  says = [];

  // the next chapter: what was kept is the glossary's now (bound entries), so the pool does not give it again
  const keptEntries = add[2].terms.map(([s, t]) => ({ terms: [s], translation: t, source: "wtr" }));
  got = await PoolHints.entriesFor(text, own.concat(keptEntries));
  assert.deepStrictEqual(got.map((e) => e.terms[0]), [], "a term the novel has kept is not the pool's again");

  // not in a Gemini request that is not a translation of the original: a custom prompt with no glossary, an English text, another language
  calls.length = 0;
  await TermNotes.translate(Object.assign({}, job, { custom: { prompt: "p", glossary: false } }));
  assert.deepStrictEqual(sent, [], "no glossary asked for: none sent");
  await TermNotes.translate(Object.assign({}, job, { english: true }));
  assert.ok(!sent.some((e) => e.source === "pool"), "a text already in English has nothing of the source's to look for");
  assert.ok(!calls.some(([, p]) => /adopted/.test(p)), "and nothing is kept");

  // a pin (the glossary "pool") is the pool's rendering whatever the novels say, and is not a novel's vote
  stored.glossaryLibrary.pool = { terms: [["散修", "Wandering Cultivator"], ["青云宗", "Azure Cloud Sect"]] };
  stored.glossaryRev = 2;
  const pinned = new Map((await PoolHints.entriesFor(text, own)).map((e) => [e.terms[0], e.translation]));
  assert.strictEqual(pinned.get("散修"), "Wandering Cultivator", "pinned over what two novels use");
  assert.strictEqual(pinned.get("青云宗"), "Azure Cloud Sect", "pinned: a term one novel has");

  // another language: the pool of the glossaries Gemini made in it; given for the terms asked for and the terms the glossary has no entry for; kept in the novel in that language
  stored.glossaryLibrary["wtr-lab:1@es"] = { terms: [["散修", "Cultivador suelto"]] };
  stored.glossaryLibrary["wtr-lab:2@es"] = { terms: [["散修", "Cultivador suelto"], ["御兽", "Domar bestias"]] };
  stored.glossaryLibrary["wtr-lab:3@es"] = { terms: [["御兽", "Domar bestias"], ["青云宗", "Secta Nube Azul"]] };
  stored.glossaryRev = 3;
  calls.length = 0;
  await TermNotes.translate({ text, glossary: [{ terms: ["御兽"], translation: "Beast Taming", source: "wtr" }], model: "m", url: job.url, title: "第7章", novelName: "N", notes: 0, lang: "es" });
  const es = new Map(sent.map((e) => [e.terms[0], e.translation]));
  assert.strictEqual(es.get("御兽"), "Domar bestias", "a term asked for in Spanish is given the pool's, not wtr-lab's English");
  assert.strictEqual(es.get("散修"), "Cultivador suelto", "and a term the glossary has no entry for");
  const keptEs = calls.find(([m, p2, b]) => m === "POST" && /@es\/add$/.test(decodeURIComponent(p2)) && b.from === "pool");
  assert.ok(keptEs, "kept in the novel in Spanish");
  assert.strictEqual(decodeURIComponent(keptEs[1]), "/api/glossaries/adopted:69shuba.com/txt/90001@es/add");
  assert.deepStrictEqual(keptEs[2].terms.slice().sort(), [["御兽", "Domar bestias", "pool"], ["散修", "Cultivador suelto", "pool"]].sort());
  // English is not touched by it: the English pool does not have the Spanish glossaries' terms
  assert.ok(!(await PoolHints.entriesFor("青云宗", [])).some((e) => e.translation === "Secta Nube Azul"));

  // the library's switch: off, the pool gives nothing (a fresh module: the setting is read at most once a minute)
  settings = { poolHints: false };
  delete require.cache[require.resolve("../src/shared/pool-hints.js")];
  assert.deepStrictEqual(await require("../src/shared/pool-hints.js").entriesFor(text, own), [], "poolHints off");

  // the library's switch for it
  settings = { keepTerms: false };
  delete require.cache[require.resolve("../src/shared/pool-hints.js")];
  calls.length = 0;
  assert.strictEqual(await require("../src/shared/pool-hints.js").keepSuggestions(job.url, text, [{ term: "青云宗", translation: "Azure Cloud Sect" }], []), 0);
  assert.ok(!calls.some(([m]) => m === "POST"), "keepTerms off: none kept");

  console.log("pool-hints: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
