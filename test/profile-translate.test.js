// A watch's chapters translated with their novel's translation profile (profile-translate.js, docs/PROFILES.md), in the background: which profile a chapter's
// novel has, the call (an own key straight to the provider, tickets through the playground with the sign-in the library's page handed over), why one cannot be
// made, what the library's page hands over (only from its own tabs), and OriginalTranslate.run using it for a watch's chapter only.
// Run: node test/profile-translate.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { profileModelText } = require("../tools/profile-model");

const shared = path.join(__dirname, "..", "src", "shared");
const storage = {};
const calls = []; // what reached a model: { url, headers, credentials, body }
let answer = () => ({ status: 200, sse: ["The ", "translation."] });
const geminiAsked = [];
let turns = 0;
let settings = {};
const listeners = [];
const sseBody = (chunks) => (async function* () { for (const c of chunks) yield c; })();

const ctx = {
  console, URL, setTimeout, Promise, JSON, Object, Number, String, Array, Map, Set, TextDecoder, TextEncoder, Date, Math,
  SITE_BRIDGE_MATCHES: ["https://heavenlydao.com/*", "https://www.heavenlydao.com/*"],
  fetch: async (url, opts = {}) => {
    const body = JSON.parse(opts.body || "{}");
    calls.push({ url: String(url), headers: opts.headers || {}, credentials: opts.credentials, body });
    const a = answer(String(url), body);
    if (a.status !== 200) return { ok: false, status: a.status, json: async () => ({ error: { message: a.message || "no" } }), clone() { return this; } };
    const patron = /\/api\/translate$/.test(url);
    const events = patron
      ? a.sse.map((t) => "data: " + JSON.stringify({ t }) + "\n\n").concat("data: " + JSON.stringify({ done: 1, usage: { promptTokens: 9, completionTokens: 4, costUsd: 0.001, tickets: 2.5 }, leftTickets: 97.5 }) + "\n\n")
      : a.sse.map((t) => "data: " + JSON.stringify({ choices: [{ delta: { content: t } }] }) + "\n\n").concat("data: [DONE]\n\n");
    return { ok: true, status: 200, body: sseBody(events) };
  },
  chrome: {
    storage: { local: {
      get: async (k) => (typeof k === "string" ? { [k]: storage[k] } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, storage[x]])) : {}),
      set: async (o) => Object.assign(storage, JSON.parse(JSON.stringify(o)))
    } },
    runtime: { onMessage: { addListener: (f) => listeners.push(f) } }
  },
  GlossaryServer: {
    pull: async () => null,
    targetLanguage: async () => "en",
    profileSettings: async () => settings,
    api: async (method, p) => {
      if (p === "/api/glossaries/" + encodeURIComponent("my-glossary@es")) return { terms: [["林动", "Lin Dong (es)"]] };
      throw new Error("not found");
    }
  },
  TermNotes: { translate: async (o) => { geminiAsked.push(o); return { translated: "Gemini's text", suggestions: [], model: "gemini-x" }; }, chapterNumber: () => null },
  geminiLanguageName: (code) => ({ en: "English", es: "Spanish" })[code] || code,
  geminiTurn: async () => { turns++; }
};
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
const load = (file) => vm.runInContext(fs.readFileSync(path.join(shared, file), "utf8"), ctx, { filename: file });
load("wtr-terms.js");
load("term-match.js");
vm.runInContext(profileModelText(), ctx, { filename: "profile-model.js" }); // (the playground's translate.js, as build.js ships it)
load("profile-translate.js");
load("lang-detect.js");
load("original-translate.js");
const PT = vm.runInContext("ProfileTranslate", ctx);
const OT = vm.runInContext("OriginalTranslate", ctx);
PT._waitScale(0.001);

const OWN = { id: "own-mini", name: "Own mini", model: "openai/gpt-5-mini", prompt: "Translate into {language}, plainly.", pay: "key", base: "https://openrouter.ai/api/v1" };
const TICKETS = { id: "haiku", name: "Haiku", model: "anthropic/claude-haiku-5.5", prompt: "", pay: "tickets", base: "" };
const GEMINI = { id: "gem", name: "Gemini · Translation only", model: "gemini-2.5-flash", prompt: "To {language}.", pay: "key", base: "https://generativelanguage.googleapis.com/v1beta/openai" };
const BY_EXT = { id: "by-ext", name: "By the extension", model: "gemini", prompt: "Translate, keeping every name.", pay: "extension", base: "" };
const CHAPTER = "https://www.69shuba.com/txt/77582/38804612";
const BOOK = "69shuba.com/txt/77582";

(async () => {
  // ---- which profile: the novel's own, else the library's default; "gemini" or none is the extension's Gemini
  const s = { translateProfiles: [OWN, TICKETS], translateProfile: "own-mini", novelProfiles: { [BOOK]: "haiku", "uuread.tw/chapter/1878627": "gemini" } };
  assert.deepStrictEqual([...PT.booksOf(CHAPTER)], [BOOK], "a source site's chapter: its site and folder, as the library names the novel");
  assert.deepStrictEqual([...PT.booksOf("https://wtr-lab.com/en/novel/8053/some-slug/chapter-3")], ["wtr-lab:8053"], "a site novel's chapter: its id");
  assert.strictEqual(PT.profileOf(s, [BOOK]).id, "haiku", "the novel's own choice");
  assert.strictEqual(PT.profileOf(s, ["biquge.tw/book/1"]).id, "own-mini", "else the library's default");
  assert.strictEqual(PT.profileOf(s, ["uuread.tw/chapter/1878627"]), null, "a novel set to the extension's Gemini");
  assert.strictEqual(PT.profileOf({ translateProfiles: [OWN] }, [BOOK]), null, "no default: the extension's Gemini, as before profiles");
  assert.strictEqual(PT.profileOf({ translateProfiles: [OWN], translateProfile: "gone" }, [BOOK]), null, "a default that is not a profile any more");
  assert.strictEqual(PT.profileOf(null, [BOOK]), null, "the library could not be read");

  // ---- what the library's page hands over: only from a tab of the library site
  const hand = (msg, url) => listeners.forEach((f) => f(Object.assign({ type: "profile:access" }, msg), { tab: { id: 1 }, url }));
  hand({ keys: { "https://openrouter.ai/api/v1": "sk-or-own" }, token: "tok.123.sig" }, "https://evil.example/");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(storage.profileKeys, undefined, "another site hands nothing over");
  listeners.forEach((f) => f({ type: "profile:access", keys: { "https://openrouter.ai/api/v1": "sk-or-own" } }, { id: "x", url: "https://heavenlydao.com/" }));
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(storage.profileKeys, undefined, "nor something that is not a tab");
  hand({ keys: { "https://openrouter.ai/api/v1": "sk-or-own", "javascript:alert(1)": "x", "https://api.example.com/v1": 5 }, token: "tok.123.sig" }, "https://heavenlydao.com/#/settings");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(storage.profileKeys, { "https://openrouter.ai/api/v1": "sk-or-own" }, "the keys, by the provider's address (nothing that is not one)");
  assert.strictEqual(storage.playgroundToken, "tok.123.sig", "and the sign-in");
  hand({ keys: { "https://openrouter.ai/api/v1": "sk-or-own" } }, "https://heavenlydao.com/");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(storage.playgroundToken, "tok.123.sig", "no token said: the one kept stays");

  // ---- an own key: straight to the provider, the prompt as the playground builds it (the chapter's glossary terms, the language)
  const glossary = [{ terms: ["林动"], translation: "Lin Dong" }, { terms: ["武祖"], translation: "Martial Ancestor" }];
  let r = await PT.translate({ text: "林动走进了大厅。" }, OWN, glossary, "en");
  assert.strictEqual(r.text, "The translation.");
  let c = calls.pop();
  assert.strictEqual(c.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.strictEqual(c.headers.Authorization, "Bearer sk-or-own", "the key kept for that address");
  assert.strictEqual(c.body.model, "openai/gpt-5-mini");
  assert.deepStrictEqual(c.body.reasoning, { effort: "none" }, "no thinking at OpenRouter, as in the playground");
  const prompt = c.body.messages[0].content;
  assert.ok(prompt.startsWith("Translate into English, plainly."), "the profile's prompt, with the language: " + prompt);
  assert.ok(prompt.includes("林动 = Lin Dong") && !prompt.includes("武祖"), "the glossary's terms found in the chapter, only");
  assert.ok(prompt.endsWith("林动走进了大厅。"), "then the chapter");

  // ---- tickets: the playground's server, with the extension's sign-in (no cookie)
  r = await PT.translate({ text: "林动走进了大厅。" }, TICKETS, [], "es");
  assert.deepStrictEqual([r.text, r.tickets], ["The translation.", 2.5]);
  c = calls.pop();
  assert.strictEqual(c.url, "https://playground.heavenlydao.com/api/translate");
  assert.strictEqual(c.headers.Authorization, "Bearer tok.123.sig");
  assert.strictEqual(c.headers["X-Playground"], "1");
  assert.strictEqual(c.credentials, "omit", "the token, not the cookie");
  assert.ok(c.body.prompt.startsWith("Translate the following text to Spanish,"), "the default prompt, into the library's language: " + c.body.prompt);
  assert.strictEqual(c.body.chars, 7, "the chapter's size, for its price");

  // ---- why one cannot be made: told, and whether asking again helps
  answer = () => ({ status: 401 });
  r = await PT.translate({ text: "x" }, TICKETS, [], "en");
  assert.ok(r.stop && /sign-in/.test(r.error), "a sign-in the playground does not take: " + r.error);
  answer = () => ({ status: 402, message: "not enough tickets left for this" });
  r = await PT.translate({ text: "x" }, TICKETS, [], "en");
  assert.deepStrictEqual([r.stop, r.error], [true, "not enough tickets left for this"], "no tickets left");
  answer = () => ({ status: 500, message: "upstream is down" });
  r = await PT.translate({ text: "x" }, OWN, [], "en");
  assert.deepStrictEqual([r.stop, r.error], [false, "upstream is down"], "a model that failed: asked again later");
  answer = () => ({ status: 200, sse: [] });
  r = await PT.translate({ text: "x" }, OWN, [], "en");
  assert.ok(!r.stop && /nothing/.test(r.error), "an empty answer is no translation");
  const n = calls.length;
  r = await PT.translate({ text: "x" }, Object.assign({}, OWN, { base: "https://generativelanguage.googleapis.com/v1beta/openai" }), [], "en");
  assert.ok(r.stop && /No key for Own mini in this browser/.test(r.error), "no key kept for that address: " + r.error);
  assert.strictEqual(calls.length, n, "and nothing is asked");
  const tok = storage.playgroundToken;
  storage.playgroundToken = "";
  r = await PT.translate({ text: "x" }, TICKETS, [], "en");
  assert.ok(r.stop && /No sign-in for tickets/.test(r.error), "signed out: " + r.error);
  storage.playgroundToken = tok;

  // ---- an own Gemini key: within the library's Gemini requests a minute, and a 429 waited out (twice at most)
  storage.profileKeys[GEMINI.base] = "AIza-own";
  let tries = 0;
  answer = () => (++tries < 3 ? { status: 429 } : { status: 200, sse: ["Gemini answered."] });
  turns = 0;
  r = await PT.translate({ text: "x" }, GEMINI, [], "en");
  assert.strictEqual(r.text, "Gemini answered.", "asked again after a 429");
  assert.strictEqual(turns, 3, "each try waits its turn");
  assert.strictEqual(calls.pop().body.model, "gemini-2.5-flash");
  tries = -10;
  answer = () => ({ status: 429 });
  r = await PT.translate({ text: "x" }, GEMINI, [], "en");
  assert.ok(r.error && !r.stop, "three 429s: failed, for now");

  // ---- OriginalTranslate.run: a watch's chapter with its novel's profile, saved as the chapter's translation
  answer = () => ({ status: 200, sse: ["Chapter one, by a profile."] });
  settings = { translateProfiles: [OWN, TICKETS, BY_EXT], translateProfile: "own-mini", novelProfiles: {} };
  storage.glossary = [{ term: "林动", translation: "Lin Dong", scope: "global" }];
  r = await OT.run({ url: CHAPTER, text: "林动走进了大厅。", pageTitle: "Chapter 1", novelName: "Martial Universe", next: CHAPTER.replace("612", "613"), watched: true });
  assert.deepStrictEqual([r.ok, r.profile], [true, "Own mini"]);
  const saved = storage["translation:" + CHAPTER];
  assert.deepStrictEqual([saved.translated, saved.model, saved.novelName, saved.pageTitle, saved.next], ["Chapter one, by a profile.", "openai/gpt-5-mini (Own mini)", "Martial Universe", "Chapter 1", CHAPTER.replace("612", "613")], "saved as the library's page saves one");
  assert.ok(calls.pop().body.messages[0].content.includes("林动 = Lin Dong"), "with the terms the extension would send Gemini");
  assert.strictEqual(geminiAsked.length, 0, "and Gemini is not asked");

  // a chapter not fetched by a watch (the reader asked the extension to translate it) stays with the extension's Gemini
  r = await OT.run({ url: CHAPTER.replace("612", "614"), text: "林动走进了大厅。", pageTitle: "Chapter 3", novelName: "Martial Universe" });
  assert.strictEqual(storage["translation:" + CHAPTER.replace("612", "614")].translated, "Gemini's text");
  assert.strictEqual(geminiAsked.length, 1);
  // a novel set to the extension's Gemini
  settings.novelProfiles = { [BOOK]: "gemini" };
  await OT.run({ url: CHAPTER.replace("612", "615"), text: "林动走进了大厅。", watched: true });
  assert.ok(geminiAsked.length === 2 && !geminiAsked[1].custom, "the extension's Gemini, its own prompt");
  // a profile paid by the extension: its Gemini, with the profile's prompt (as a Custom prompt)
  settings.novelProfiles = { [BOOK]: "by-ext" };
  await OT.run({ url: CHAPTER.replace("612", "616"), text: "林动走进了大厅。", watched: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(geminiAsked[2].custom)), { prompt: "Translate, keeping every name.", notes: false, glossary: true });
  // a profile that cannot be used here: not translated, and why
  settings.novelProfiles = { [BOOK]: "haiku" };
  storage.playgroundToken = "";
  r = await OT.run({ url: CHAPTER.replace("612", "617"), text: "林动走进了大厅。", watched: true });
  assert.ok(r.error && r.stop, "told why: " + r.error);
  assert.strictEqual(storage["translation:" + CHAPTER.replace("612", "617")], undefined, "nothing saved");
  // into another language: the novel's glossary in that language
  storage.playgroundToken = tok;
  storage.glossaryBindings = { [BOOK]: ["my-glossary"] };
  storage.glossaryLibrary = { "my-glossary": { name: "Mine", terms: [["林动", "Lin Dong", "copied", { o: "novel" }]] } }; // (its English rows: which terms are its own)
  ctx.GlossaryServer.targetLanguage = async () => "es";
  r = await OT.run({ url: CHAPTER.replace("612", "618"), text: "林动走进了大厅。", watched: true });
  assert.strictEqual(r.lang, "es");
  assert.ok(storage["translation:" + CHAPTER.replace("612", "618") + "#lang=es"], "kept as the chapter's Spanish version");
  assert.ok(calls.pop().body.prompt.includes("林动 = Lin Dong (es)"), "with the Spanish glossary's rendering");

  console.log("profile-translate: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
