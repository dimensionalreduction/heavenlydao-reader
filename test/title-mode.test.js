// Titles and details put into English as the library's setting says (gemini.js translateByMode): Google Translate, Google Translate alone, Gemini,
// Gemini else Google, or not at all, with stand-ins for both. Run: node test/title-mode.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let mode = "google";
let rules = null; // (the library's titleRules: a model of its own among the rows)
const modelAsked = [];
let modelUp = true;
let geminiUp = true;
let googleUp = true;
const calls = { google: 0, gemini: 0 };
const ctx = {
  console, JSON, Array, String, URLSearchParams, decodeURIComponent, encodeURIComponent, setTimeout,
  chrome: { storage: { local: { get: async () => ({ geminiApiKey: "test-key", profileKeys: { "https://openrouter.ai/api/v1": "sk-or" }, playgroundToken: "tok" }), set: async () => {} } } },
  GlossaryServer: { titleMode: async () => mode, titleRules: async () => rules, geminiRate: async () => 1000 },
  Pay: { BASE: { openrouter: "https://openrouter.ai/api/v1", gemini: "https://generativelanguage.googleapis.com/v1beta/openai", fish: "https://api.fish.audio" }, idFor: (kind, model) => (kind === "gemini" ? model.replace(/^google\//, "") : model) },
  // a model of its own: "R:" before each title, its JSON after a few words of its own
  ProfileModel: { runModel: async (o) => {
    modelAsked.push({ model: o.model, key: o.key, patron: o.patron, token: o.token });
    if (!modelUp) throw Object.assign(new Error("HTTP 402"), { status: 402 });
    const list = JSON.parse(o.prompt.split("\n\n").pop());
    return { text: "Here they are: " + JSON.stringify({ translated: list.map((t) => "R:" + t) }) };
  } },
  fetch: async (url, opts) => {
    if (/translate\.googleapis/.test(url)) { // Google: "G:" before each line
      calls.google++;
      if (!googleUp) throw new Error("NetworkError"); // (its "unusual traffic" page: a redirect the browser does not follow)
      const lines = decodeURIComponent(String(opts.body).replace(/^q=/, "")).split("\n");
      return { ok: true, json: async () => [[[lines.map((l) => "G:" + l).join("\n"), ""]]] };
    }
    calls.gemini++;
    if (!geminiUp) return { ok: false, json: async () => ({}) };
    const list = JSON.parse(JSON.parse(opts.body).contents[0].parts[0].text.split("\n\n").pop());
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ translated: list.map((t) => "M:" + t) }) }] } }] }) };
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8") + "\n;globalThis.translateByMode = translateByMode;", ctx);
// (each call with no titles kept: the modes are what is checked here; keeping each title once is test/title-cache.test.js)
const tr = (texts, kind) => { vm.runInContext("titleStore = null", ctx); return ctx.translateByMode(texts, kind).then((x) => Array.from(x)); };
const reset = () => { calls.google = 0; calls.gemini = 0; };

(async () => {
  const titles = ["第一章", "Chapter 2", "第三章"];
  mode = "google";
  assert.deepStrictEqual(await tr(titles, "titles"), ["G:第一章", "G:Chapter 2", "G:第三章"], "Google Translate (the default)");

  reset();
  mode = "gemini";
  assert.deepStrictEqual(await tr(titles, "titles"), ["M:第一章", "Chapter 2", "M:第三章"], "Gemini: only the titles not in English are sent");
  assert.deepStrictEqual([calls.gemini, calls.google], [1, 0], "one request to Gemini, none to Google");
  geminiUp = false;
  assert.deepStrictEqual(await tr(titles, "titles"), titles, "Gemini alone, and it can't: left as they are");

  reset();
  mode = "gemini-google";
  assert.deepStrictEqual(await tr(titles, "titles"), ["G:第一章", "Chapter 2", "G:第三章"], "Gemini else Google: Google does what Gemini could not");
  geminiUp = true;
  assert.deepStrictEqual(await tr(titles, "titles"), ["M:第一章", "Chapter 2", "M:第三章"], "and Gemini when it can");

  // a book's details: Gemini's book prompt, or Google
  const book = ["仙工开物", "某人", "修真", "简介。"];
  assert.deepStrictEqual(await tr(book, "book"), book.map((t) => "M:" + t), "a book by Gemini");
  geminiUp = false;
  assert.deepStrictEqual(await tr(book, "book"), book.map((t) => "G:" + t), "else Google");
  mode = "gemini";
  assert.deepStrictEqual(await tr(book, "book"), book, "Gemini alone: as it was");

  // Google refusing: Gemini with the key does it, in the default mode too; no more is asked of Google for a while
  reset();
  mode = "google";
  geminiUp = true;
  googleUp = false;
  assert.deepStrictEqual(await tr(titles, "titles"), ["M:第一章", "Chapter 2", "M:第三章"], "Google refusing: Gemini instead");
  assert.deepStrictEqual(await tr(book, "book"), book.map((t) => "M:" + t), "a book too");
  assert.strictEqual(calls.google, 1, "Google asked once, then left alone");
  googleUp = true;
  vm.runInContext("googlePausedUntil = 0", ctx); // (the pause over)
  assert.deepStrictEqual(await tr(titles, "titles"), ["G:第一章", "G:Chapter 2", "G:第三章"], "Google again when it answers");

  // Google alone (Settings › Model rules › Titles and details with no Gemini row): Google refusing leaves them as they are, Gemini is not asked
  reset();
  mode = "google-only";
  googleUp = false;
  assert.deepStrictEqual(await tr(titles, "titles"), titles, "Google alone, refusing: left as they are");
  assert.deepStrictEqual(await tr(book, "book"), book, "a book too");
  assert.strictEqual(calls.gemini, 0, "Gemini not asked");
  googleUp = true;
  vm.runInContext("googlePausedUntil = 0", ctx);
  assert.deepStrictEqual(await tr(titles, "titles"), ["G:第一章", "G:Chapter 2", "G:第三章"], "and Google when it answers");

  reset();
  mode = "off";
  assert.deepStrictEqual(await tr(titles, "titles"), titles, "no translation");
  assert.deepStrictEqual([calls.gemini, calls.google], [0, 0], "nothing asked");
  assert.deepStrictEqual(await tr([], "titles"), [], "nothing to translate");

  // the library's titleRules (Settings › Model rules › Titles and details with a model of its own): the rows in order, each asked for what the ones before it left
  reset();
  mode = "google";
  rules = [{ model: "anthropic/claude-haiku-5.5", kind: "openrouter" }, { model: "google/translate", kind: "free" }];
  assert.deepStrictEqual(await tr(titles, "titles"), ["R:第一章", "Chapter 2", "R:第三章"], "a model of its own first: only the titles not in English are sent to it");
  assert.deepStrictEqual(modelAsked.map((m) => [m.model, m.key && m.key.key, m.patron]), [["anthropic/claude-haiku-5.5", "sk-or", false]], "paid by the OpenRouter key the library's page handed over");
  assert.deepStrictEqual([calls.google, calls.gemini], [0, 0], "Google not asked: nothing was left");
  modelUp = false;
  assert.deepStrictEqual(await tr(titles, "titles"), ["G:第一章", "Chapter 2", "G:第三章"], "the model failing: the next row, Google, does what it left (only what is still in another script)");
  modelUp = true;
  modelAsked.length = 0;
  rules = [{ model: "google/translate", kind: "free" }, { model: "z-ai/glm-5.3-flash", kind: "tickets" }];
  googleUp = false;
  assert.deepStrictEqual(await tr(titles, "titles"), ["R:第一章", "Chapter 2", "R:第三章"], "Google first, refusing: the model on tickets after it");
  assert.deepStrictEqual(modelAsked.map((m) => [m.model, m.patron, m.token]), [["z-ai/glm-5.3-flash", true, "tok"]], "tickets: the sign-in the library's page handed over");
  assert.deepStrictEqual(await tr(book, "book"), book.map((t) => "R:" + t), "a book's details too");
  googleUp = true;
  vm.runInContext("googlePausedUntil = 0", ctx);
  rules = [{ model: "google/gemini-3.5-pro", kind: "gemini" }];
  geminiUp = true;
  assert.deepStrictEqual(await tr(titles, "titles"), ["M:第一章", "Chapter 2", "M:第三章"], "a Gemini row is the extension's own Gemini");
  rules = null;

  console.log("OK — title mode checks passed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
