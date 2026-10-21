// A book's details through Gemini (meaning, not pinyin), with a stand-in for Gemini. Run: node test/gemini-book.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let reply = null; // what the stand-in answers with
let sent = null;
let stored = { geminiApiKey: "test-key" };
const ctx = {
  console, JSON, Array, String,
  chrome: { storage: { local: { get: async () => stored } } },
  fetch: async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return reply instanceof Error ? Promise.reject(reply) : { ok: reply.ok !== false, json: async () => reply.json };
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8") + "\n;Object.assign(globalThis, { geminiTranslateBook, GEMINI_NO_KEY, GEMINI_MODELS_FALLBACK });", ctx);
const book = ctx.geminiTranslateBook;
const answer = (list) => ({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ translated: list }) }] } }] } });

(async () => {
  const texts = ["仙工开物", "蛊真人", "修真武侠", "火山中，先贤大能遗留的机关仙宫。"];
  reply = answer(["Immortal Creation", " Gu Zhenren ", "Xiuzhen Wuxia", "In a volcano, a sage's mechanism palace."]);
  assert.deepStrictEqual(Array.from(await book(texts)), ["Immortal Creation", "Gu Zhenren", "Xiuzhen Wuxia", "In a volcano, a sage's mechanism palace."], "the same number of strings, trimmed");
  const prompt = sent.body.contents[0].parts[0].text;
  assert.ok(prompt.includes(JSON.stringify(texts)), "the texts go in as a JSON array");
  assert.ok(/says what it means|never pinyin/i.test(prompt) && /pinyin/.test(prompt), "the title is asked for as its meaning, the author as a name");

  reply = answer(["one", "two"]);
  assert.strictEqual(await book(texts), null, "a different number of items is never guessed at");
  reply = answer(["a", "", "c", "d"]);
  assert.strictEqual(await book(texts), null, "an empty item is not an answer");
  reply = { ok: false, json: {} };
  assert.strictEqual(await book(texts), null, "Gemini refusing");
  reply = new Error("offline");
  assert.strictEqual(await book(texts), null, "no network");
  reply = { json: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } };
  assert.strictEqual(await book(texts), null, "an answer that is not JSON");
  assert.strictEqual(await book([]), null, "nothing to translate");

  // no key is built in: without the person's own, nothing is sent and the caller is told why
  stored = {};
  sent = null;
  assert.strictEqual(await book(texts), null, "no key: the details fall back");
  assert.deepStrictEqual({ ...(await ctx.translateText("你好", [], null, null, "en")) }, { error: ctx.GEMINI_NO_KEY }, "no key: a chapter is refused with the reason");
  assert.deepStrictEqual(Array.from(await ctx.listGeminiModels()), Array.from(ctx.GEMINI_MODELS_FALLBACK), "no key: the model list is the built-in one");
  assert.strictEqual(sent, null, "no key: nothing goes to Gemini");

  console.log("OK — gemini book checks passed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
