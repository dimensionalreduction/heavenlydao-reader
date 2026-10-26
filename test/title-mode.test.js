// Titles and details put into English as the library's setting says (gemini.js translateByMode): Google Translate, Gemini, Gemini else Google,
// or not at all, with stand-ins for both. Run: node test/title-mode.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let mode = "google";
let geminiUp = true;
let googleUp = true;
const calls = { google: 0, gemini: 0 };
const ctx = {
  console, JSON, Array, String, URLSearchParams, decodeURIComponent, encodeURIComponent, setTimeout,
  chrome: { storage: { local: { get: async () => ({ geminiApiKey: "test-key" }) } } },
  GlossaryServer: { titleMode: async () => mode, geminiRate: async () => 1000 },
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
const tr = (texts, kind) => ctx.translateByMode(texts, kind).then((x) => Array.from(x));
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

  reset();
  mode = "off";
  assert.deepStrictEqual(await tr(titles, "titles"), titles, "no translation");
  assert.deepStrictEqual([calls.gemini, calls.google], [0, 0], "nothing asked");
  assert.deepStrictEqual(await tr([], "titles"), [], "nothing to translate");

  console.log("OK — title mode checks passed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
