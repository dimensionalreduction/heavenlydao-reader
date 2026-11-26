// A watch's chapters translated with their novel's translation profile (profile-translate.js, docs/PROFILES.md), in the background: which profile a chapter's
// novel has (a name and a prompt), the model from Settings › Model rules' Translation card (an own key straight to the provider, tickets through the playground with the
// sign-in the library's page handed over), the next row when one fails for who pays, why none can be made and when asking again helps (stop only after every row failed),
// what the library's page hands over (only from its own tabs), and OriginalTranslate.run using it for a watch's chapter only.
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
const googleAsked = [];
let googleAnswer = (lines) => lines.map((l) => "EN " + l);
let turns = 0;
let settings = {};
const listeners = [];
const sseBody = (chunks) => (async function* () { for (const c of chunks) yield c; })();

const ctx = {
  console, URL, setTimeout, Promise, JSON, Object, Number, String, Array, Map, Set, TextDecoder, TextEncoder, Date, Math,
  SITE_BRIDGE_MATCHES: ["https://heavenlydao.com/*", "https://www.heavenlydao.com/*"],
  fetch: async (url, opts = {}) => {
    if (/^https:\/\/translate\.googleapis\.com\//.test(String(url))) { // (Google Translate: the paragraphs a line each, answered a line each)
      const q = decodeURIComponent(String(opts.body).replace(/^q=/, "")), lines = q.split("\n");
      googleAsked.push({ url: String(url), lines });
      const out = googleAnswer(lines);
      return typeof out === "number" ? { ok: false, status: out, json: async () => ({}) } : { ok: true, status: 200, json: async () => [[[out.join("\n"), q]]] };
    }
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
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "vendor", "pay.js"), "utf8"), ctx, { filename: "pay.js" }); // (the library site's own code: the rules)
load("wtr-terms.js");
load("term-match.js");
load("google-chapter.js");
vm.runInContext(profileModelText(), ctx, { filename: "profile-model.js" }); // (the playground's translate.js, as build.js ships it)
load("profile-translate.js");
load("lang-detect.js");
load("original-translate.js");
const PT = vm.runInContext("ProfileTranslate", ctx);
const OT = vm.runInContext("OriginalTranslate", ctx);
PT._waitScale(0.001);

const OWN = { id: "own-mini", name: "Own mini", prompt: "Translate into {language}, plainly." };
const TICKETS = { id: "haiku", name: "Haiku", prompt: "" };
const GEMINI = { id: "gem", name: "Gemini · Translation only", prompt: "To {language}." };
const BY_EXT = { id: "by-ext", name: "By the extension", model: "gemini", prompt: "Translate, keeping every name.", pay: "extension", base: "" }; // (a profile from before: the extension no longer pays)
const OR = "https://openrouter.ai/api/v1", GEM = "https://generativelanguage.googleapis.com/v1beta/openai";
// the Translation card, as the library's page hands it over (kept as modelRules): [model, who pays] a row each, best first
const rules = (...rows) => { storage.modelRules = { v: 3, translate: rows.map(([model, kind]) => ({ model, kind })) }; };
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

  // ---- the rules the person set (Settings › Model rules): kept per job, what is not a plausible row dropped, only from the library's tab
  hand({ rules: { comicDraw: [{ model: "x", kind: "openrouter" }] } }, "https://evil.example/");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(storage.modelRules, undefined, "another site sets no rules");
  hand({ rules: {
    comicDraw: [{ model: "black-forest-labs/flux-3-image-klein", kind: "openrouter" }, { model: "m", kind: "nonsense" }, { model: "", kind: "tickets" }, null, 5],
    comicRead: [{ model: "qwen2.5vl:7b", kind: "other", base: "http://localhost:11434/v1" }, { model: "no-address", kind: "other" }, { model: "bad-address", kind: "other", base: "javascript:alert(1)" }],
    "not a job!": [{ model: "x", kind: "tickets" }], voice: "no"
  } }, "https://heavenlydao.com/#/settings");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(storage.modelRules, {
    comicDraw: [{ model: "black-forest-labs/flux-3-image-klein", kind: "openrouter" }],
    comicRead: [{ model: "qwen2.5vl:7b", kind: "other", base: "http://localhost:11434/v1" }]
  }, "the rows that make sense, per job; a row of an address with no usable address is dropped, and so is what is not a job");
  hand({ rules: {} }, "https://heavenlydao.com/");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(storage.modelRules, {}, "rules said empty: the person's changes are gone, the defaults are back");
  hand({ keys: { "https://openrouter.ai/api/v1": "sk-or-own" } }, "https://heavenlydao.com/");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(storage.modelRules, {}, "no rules said: left as they were");

  // ---- an own key: straight to the provider, the prompt as the playground builds it (the chapter's glossary terms, the language); the model is the Translation rule's
  const glossary = [{ terms: ["林动"], translation: "Lin Dong" }, { terms: ["武祖"], translation: "Martial Ancestor" }];
  rules(["openai/gpt-5-mini", "openrouter"]);
  let r = await PT.translate({ text: "林动走进了大厅。", url: CHAPTER }, OWN, glossary, "en");
  assert.strictEqual(r.text, "The translation.");
  assert.strictEqual(r.used.rule, "openai/gpt-5-mini", "the row that translated it");
  let c = calls.pop();
  assert.strictEqual(c.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.strictEqual(c.headers.Authorization, "Bearer sk-or-own", "the key kept for that address");
  assert.strictEqual(c.body.model, "openai/gpt-5-mini");
  assert.deepStrictEqual(c.body.reasoning, { effort: "none" }, "no thinking at OpenRouter, as in the playground");
  const prompt = c.body.messages[0].content;
  assert.ok(prompt.startsWith("Translate into English, plainly."), "the profile's prompt, with the language: " + prompt);
  assert.ok(prompt.includes("林动 = Lin Dong") && !prompt.includes("武祖"), "the glossary's terms found in the chapter, only");
  assert.ok(prompt.endsWith("林动走进了大厅。"), "then the chapter");
  // (a profile from before has a model, a way of paying: none of it is read)
  r = await PT.translate({ text: "x", url: CHAPTER }, Object.assign({}, OWN, { model: "ignored/model", pay: "tickets" }), [], "en");
  assert.strictEqual(calls.pop().body.model, "openai/gpt-5-mini", "the model of a profile from before is not the one asked");

  // ---- no rules kept: the card as it comes (Gemini 3.5 Flash Lite, by a Gemini key, an OpenRouter key or tickets; this browser has an OpenRouter key and a sign-in)
  delete storage.modelRules;
  r = await PT.translate({ text: "x", url: CHAPTER }, OWN, [], "en");
  c = calls.pop();
  assert.deepStrictEqual([c.url, c.body.model], ["https://openrouter.ai/api/v1/chat/completions", "google/gemini-3.5-flash-lite"], "the default: Gemini 3.5 Flash Lite through the OpenRouter key");

  // ---- tickets: the playground's server, with the extension's sign-in (no cookie)
  rules(["anthropic/claude-haiku-5.5", "tickets"]);
  r = await PT.translate({ text: "林动走进了大厅。", url: CHAPTER }, TICKETS, [], "es");
  assert.deepStrictEqual([r.text, r.tickets], ["The translation.", 2.5]);
  c = calls.pop();
  assert.strictEqual(c.url, "https://playground.heavenlydao.com/api/translate");
  assert.strictEqual(c.headers.Authorization, "Bearer tok.123.sig");
  assert.strictEqual(c.headers["X-Playground"], "1");
  assert.strictEqual(c.credentials, "omit", "the token, not the cookie");
  assert.strictEqual(c.body.model, "anthropic/claude-haiku-5.5");
  assert.ok(c.body.prompt.startsWith("Translate the following text to Spanish,"), "the default prompt, into the library's language: " + c.body.prompt);
  assert.strictEqual(c.body.chars, 7, "the chapter's size, for its price");

  // ---- the next row when one fails for who pays or has nothing to say (comic-host.js asker's way); the chapter fails only when every row has
  const urlsAsked = () => calls.splice(0).map((x) => (/openrouter/.test(x.url) ? "openrouter" : /playground/.test(x.url) ? "tickets" : x.url));
  const A_KEY = "https://www.69shuba.com/txt/1/1", B_KEY = "https://www.69shuba.com/txt/1/2";
  rules(["openai/gpt-5-mini", "openrouter"], ["anthropic/claude-haiku-5.5", "tickets"]);
  calls.length = 0;
  answer = (url) => (/openrouter/.test(url) ? { status: 500, message: "upstream is down" } : { status: 200, sse: ["Second row."] });
  r = await PT.translate({ text: "x", url: A_KEY }, OWN, [], "en");
  assert.deepStrictEqual([r.text, r.used.pay, urlsAsked().join()], ["Second row.", "tickets", "openrouter,tickets"], "a provider that is down: the next row translated it");
  r = await PT.translate({ text: "x", url: B_KEY }, OWN, [], "en");
  assert.strictEqual(urlsAsked().join(), "openrouter,tickets", "a busy provider is out for that chapter only: the next chapter asks it again");
  answer = (url) => (/openrouter/.test(url) ? { status: 200, sse: [] } : { status: 200, sse: ["After an empty answer."] });
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/3" }, OWN, [], "en");
  assert.deepStrictEqual([r.text, urlsAsked().join()], ["After an empty answer.", "openrouter,tickets"], "an answer with nothing is a refusal: the next row");
  // every row failed, one of them for the text's sake: asking again later may help
  answer = (url) => (/openrouter/.test(url) ? { status: 500, message: "upstream is down" } : { status: 401 });
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/4" }, OWN, [], "en");
  assert.ok(r.error && !r.stop, "a row down and a row refused: not stopped, asked again later: " + r.error);
  assert.ok(/gpt-5-mini \(openrouter\.ai key\): upstream is down/.test(r.error) && /claude-haiku-5\.5 \(tickets\): The playground did not take this browser's sign-in/.test(r.error), "and each row says why: " + r.error);
  assert.strictEqual(urlsAsked().join(), "openrouter,tickets");
  // (the tickets row was refused just now: out for the visit, until the library's page hands something over)
  hand({ keys: { "https://openrouter.ai/api/v1": "sk-or-own" } }, "https://heavenlydao.com/");
  await new Promise((x) => setTimeout(x, 5));
  // every row refused for who pays: only a change here can help
  answer =(url) => (/openrouter/.test(url) ? { status: 401 } : { status: 402, message: "not enough tickets left for this" });
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/5" }, OWN, [], "en");
  assert.ok(r.stop, "every row refused for who pays: stopped until something is changed: " + r.error);
  assert.ok(/Your key for openrouter\.ai was refused/.test(r.error) && /not enough tickets left for this/.test(r.error), r.error);
  assert.strictEqual(urlsAsked().join(), "openrouter,tickets");
  // (a key refused and tickets run out are out for the visit: the next chapter asks neither, and says so)
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/6" }, OWN, [], "en");
  assert.strictEqual(urlsAsked().length, 0, "refused for the visit: not asked again");
  assert.ok(r.stop && /refused earlier/.test(r.error), "told why: " + r.error);
  hand({ keys: { "https://openrouter.ai/api/v1": "sk-or-own" } }, "https://heavenlydao.com/");
  await new Promise((x) => setTimeout(x, 5));
  answer = () => ({ status: 200, sse: ["The ", "translation."] });
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/7" }, OWN, [], "en");
  assert.deepStrictEqual([r.text, urlsAsked().join()], ["The translation.", "openrouter"], "what the library's page hands over clears what failed: asked again, and it works");
  // a failure that is the text's, not the payer's (a request the model rejects): the next row would fail as well
  answer = (url) => (/openrouter/.test(url) ? { status: 400, message: "this text is not allowed" } : { status: 200, sse: ["No."] });
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/8" }, OWN, [], "en");
  assert.deepStrictEqual([r.stop, r.error, urlsAsked().join()], [false, "this text is not allowed", "openrouter"], "no other row is asked");
  // nothing to pay with at all
  answer = () => ({ status: 200, sse: ["The ", "translation."] });
  const savedKeys = storage.profileKeys, savedToken = storage.playgroundToken;
  storage.profileKeys = {};
  storage.playgroundToken = "";
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/9" }, OWN, [], "en");
  assert.ok(r.stop && /Nothing to pay for the Translation rule/.test(r.error), "no key and no sign-in: " + r.error);
  assert.strictEqual(calls.length, 0, "and nothing is asked");
  // only tickets are in the rule and the sign-in is gone
  rules(["anthropic/claude-haiku-5.5", "tickets"]);
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/1/10" }, TICKETS, [], "en");
  assert.ok(r.stop && /Nothing to pay/.test(r.error), "signed out: " + r.error);
  // ---- nothing to pay with, and the card as it comes (Google Translate its last row): the chapter goes to Google, free; the glossary's names kept as names, put back after
  delete storage.modelRules;
  googleAsked.length = 0;
  r = await PT.translate({ text: "林动走进了大厅。\n\n他坐下了。", url: "https://www.69shuba.com/txt/1/11" }, OWN, glossary, "es");
  assert.strictEqual(calls.length, 0, "no model is asked");
  assert.deepStrictEqual([r.used.kind, r.used.rule, r.tickets], ["free", "google/translate", 0], "Google Translate translated it, for nothing");
  assert.deepStrictEqual(googleAsked.map((g) => [/[?&]tl=es(&|$)/.test(g.url), g.lines]), [[true, ["TermAA走进了大厅。", "他坐下了。"]]], "into the library's language, the paragraphs one a line, the name as a made-up one");
  assert.strictEqual(r.text, "EN Lin Dong 走进了大厅。\n\nEN 他坐下了。", "the name put back, the paragraphs a blank line apart: " + JSON.stringify(r.text));
  // Google answering what it cannot do (a 400: not asked again, no other row): the chapter fails for now (not stopped: asking again later can help)
  googleAnswer = () => 400;
  r = await PT.translate({ text: "林动", url: "https://www.69shuba.com/txt/1/12" }, OWN, [], "en");
  assert.ok(r.error && !r.stop && /Google Translate said 400/.test(r.error), "Google refused it: failed for now: " + r.error);
  googleAnswer = (lines) => lines.map((l) => "EN " + l);
  storage.profileKeys = savedKeys;
  storage.playgroundToken = savedToken;

  // ---- the popup's Translate on a text chapter with only an OpenRouter key (no Gemini key): straight to OpenRouter, in the shape the page's translator reads
  answer = () => ({ status: 200, sse: ["Lin ", "Dong."] });
  r = await PT.pageWithKey("林动", [], "en");
  assert.deepStrictEqual({ ...r, suggestions: [...r.suggestions] }, { translated: "Lin Dong.", suggestions: [], language: "en", model: "google/gemini-3.5-flash-lite", tickets: 0 });
  c = calls.pop();
  assert.deepStrictEqual([c.url, c.headers.Authorization], ["https://openrouter.ai/api/v1/chat/completions", "Bearer sk-or-own"], "with the key kept for OpenRouter");
  const kept0 = storage.profileKeys;
  storage.profileKeys = {};
  assert.ok(/No key for openrouter.ai/.test((await PT.pageWithKey("林动", [], "en")).error), "no key: it says so");
  storage.profileKeys = kept0;
  answer = () => ({ status: 200, sse: ["The ", "translation."] });

  // ---- a question of the extension's own (Detect with AI): the OpenRouter key first, else tickets, else nothing
  assert.strictEqual(await PT.payer(), "key", "an OpenRouter key was handed over");
  answer = () => ({ status: 200, sse: ['{"title":', '"c2"}'] });
  r = await PT.ask("Which is the title?", 1500);
  assert.deepStrictEqual({ ...r }, { text: '{"title":"c2"}', tickets: null }, "the model's words");
  c = calls.pop();
  assert.deepStrictEqual([c.url, c.headers.Authorization, c.body.model, c.body.max_tokens], ["https://openrouter.ai/api/v1/chat/completions", "Bearer sk-or-own", "google/gemini-3.5-flash-lite", 1500], "straight to OpenRouter with the key, the model tickets use");
  const keptKeys = storage.profileKeys;
  storage.profileKeys = {};
  assert.strictEqual(await PT.payer(), "tickets", "no key: the sign-in");
  r = await PT.ask("Which is the title?");
  assert.strictEqual(r.tickets, 2.5);
  c = calls.pop();
  assert.deepStrictEqual([c.url, c.headers.Authorization, c.credentials], ["https://playground.heavenlydao.com/api/translate", "Bearer tok.123.sig", "omit"], "through the playground with the extension's sign-in");
  answer = () => ({ status: 402, message: "No tickets left" });
  assert.deepStrictEqual({ ...(await PT.ask("x")) }, { error: "No tickets left" }, "why it could not be paid");
  const tokenKept = storage.playgroundToken;
  storage.playgroundToken = "";
  assert.strictEqual(await PT.payer(), "", "neither");
  assert.ok(/No key or tickets/.test((await PT.ask("x")).error), "and it says what to add");
  storage.profileKeys = keptKeys;
  storage.playgroundToken = tokenKept;
  answer = () => ({ status: 200, sse: ["The ", "translation."] });

  // ---- an own Gemini key: within the library's Gemini requests a minute, and a 429 waited out (twice at most)
  storage.profileKeys[GEM] = "AIza-own";
  rules(["google/gemini-2.5-flash", "gemini"]);
  let tries = 0;
  answer = () => (++tries < 3 ? { status: 429 } : { status: 200, sse: ["Gemini answered."] });
  turns = 0;
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/2/1" }, GEMINI, [], "en");
  assert.strictEqual(r.text, "Gemini answered.", "asked again after a 429");
  assert.strictEqual(turns, 3, "each try waits its turn");
  assert.strictEqual(calls.pop().body.model, "gemini-2.5-flash", "Gemini's own name for the model");
  tries = -10;
  answer = () => ({ status: 429 });
  r = await PT.translate({ text: "x", url: "https://www.69shuba.com/txt/2/2" }, GEMINI, [], "en");
  assert.ok(r.error && !r.stop, "three 429s: failed, for now");
  calls.length = 0;

  // ---- OriginalTranslate.run: a watch's chapter with its novel's profile, saved as the chapter's translation
  answer = () => ({ status: 200, sse: ["Chapter one, by a profile."] });
  rules(["openai/gpt-5-mini", "openrouter"]);
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
  // a profile that was paid by the extension, from before the rules: its prompt is used with the rules' model, and the extension's Gemini is not asked
  settings.novelProfiles = { [BOOK]: "by-ext" };
  calls.length = 0;
  r = await OT.run({ url: CHAPTER.replace("612", "616"), text: "林动走进了大厅。", watched: true });
  assert.deepStrictEqual([r.ok, r.profile, geminiAsked.length], [true, "By the extension", 2], "the rule's model, not the extension's Gemini");
  assert.ok(calls.pop().body.messages[0].content.startsWith("Translate, keeping every name."), "with the profile's prompt");
  assert.strictEqual(storage["translation:" + CHAPTER.replace("612", "616")].model, "openai/gpt-5-mini (By the extension)", "and saved with the model that translated it");
  // a profile that cannot be used here (the rule names only tickets and there is no sign-in): not translated, and why
  settings.novelProfiles = { [BOOK]: "haiku" };
  rules(["anthropic/claude-haiku-5.5", "tickets"]);
  storage.playgroundToken = "";
  r = await OT.run({ url: CHAPTER.replace("612", "617"), text: "林动走进了大厅。", watched: true });
  assert.ok(r.error && r.stop, "told why: " + r.error);
  assert.strictEqual(storage["translation:" + CHAPTER.replace("612", "617")], undefined, "nothing saved");
  // into another language: the novel's glossary in that language
  storage.playgroundToken = savedToken;
  rules(["anthropic/claude-haiku-5.5", "tickets"]);
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
