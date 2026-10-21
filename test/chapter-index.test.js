// Chapter-index capture: pure parsing, batch title translation, and the content script end to end into a library (library-stand-in.js).
// Run: node test/chapter-index.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { libraryStandIn } = require("./library-stand-in.js");
const CI = require("../src/shared/chapter-index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error("timed out waiting for: " + what);
}

// ================= pure parsing =================
assert.deepStrictEqual(CI.splitTitle("第3章 次级龙血药剂"), { prefixed: true, body: "次级龙血药剂" });
assert.deepStrictEqual(CI.splitTitle("10.第10章 这就是巫师吗"), { prefixed: true, body: "这就是巫师吗" }, "a leading '10.' is dropped");
assert.deepStrictEqual(CI.splitTitle("189.第189章"), { prefixed: true, body: "" }, "a chapter with no title after the number");
assert.deepStrictEqual(CI.splitTitle("后记"), { prefixed: false, body: "后记" }, "extras are not chapters");

const items = CI.parseItems([
  { num: 7, text: "第7章 巫师学徒的战斗力", href: "/txt/77582/38804618" }, // the page's first entry repeats the latest chapter
  { num: 1, text: "第1章 合成魔方", href: "https://www.69shuba.com/txt/77582/38804612" },
  { num: 7, text: "第7章 巫师学徒的战斗力", href: "https://www.69shuba.com/txt/77582/38804618" }, // the real entry: same URL
  { num: 333, text: "后记", href: "/txt/77582/39634519" },
  { num: "x", text: "bad number", href: "/txt/77582/1" }, null, { num: 9, text: "no link", href: "" }
], "https://www.69shuba.com/book/77582/");
assert.deepStrictEqual(items.map((i) => [i.num, i.url]), [
  [1, "https://www.69shuba.com/txt/77582/38804612"], [7, "https://www.69shuba.com/txt/77582/38804618"], [333, "https://www.69shuba.com/txt/77582/39634519"]
], "relative links resolved, duplicates dropped, bad entries ignored, sorted by number");
assert.strictEqual(CI.composeTitle(items[0], "Synthetic Cube"), "Chapter 1: Synthetic Cube");
assert.strictEqual(CI.composeTitle({ ...items[0], body: "" }, ""), "Chapter 1", "no title text: just the number");
assert.strictEqual(CI.composeTitle(items[2], "Postscript"), "Postscript", "extras keep their own translated title");
assert.strictEqual(CI.composeTitle(items[2], ""), "后记", "...or their raw title if translation failed");

// ================= batch translation =================
const gemini = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8");
vm.runInThisContext(gemini + "\n;globalThis.googleTranslateMany = googleTranslateMany;");
const DICT = { "合成魔方": "Synthetic Cube", "虚无缥缈的传说": "Illusory Legend", "次级龙血药剂": "Lesser Dragon Blood Potion", "后记": "Postscript" };
let requests = [];
let behaviour = "good";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const lines = decodeURIComponent((opts.body || "").replace(/^q=/, "")).split("\n");
  requests.push(lines.length);
  let out = lines.map((l) => DICT[l] || "T:" + l);
  if (behaviour === "merge" && lines.length > 1) out = [out.join(" ")]; // the translator joins everything onto one line
  if (behaviour === "down") throw new Error("network down");
  return { json: async () => [out.map((t, i) => [t + (i < out.length - 1 ? "\n" : ""), lines[i]])] };
};
(async () => {
  let r = await googleTranslateMany(["合成魔方", "虚无缥缈的传说", "", "次级龙血药剂"]);
  assert.deepStrictEqual(r, ["Synthetic Cube", "Illusory Legend", "", "Lesser Dragon Blood Potion"], "same length, order kept, blanks skipped");
  assert.strictEqual(requests.length, 1, "three titles go in one request");

  requests = [];
  const many = Array.from({ length: 400 }, (_, i) => "章节" + i);
  r = await googleTranslateMany(many);
  assert.strictEqual(r.length, 400);
  assert.strictEqual(r[0], "T:章节0");
  assert.strictEqual(r[399], "T:章节399");
  assert.ok(requests.length >= 2 && requests.length <= 12, "400 titles take a handful of requests, not 400 (" + requests.length + ")");

  behaviour = "merge"; // line count never matches: it must split down instead of guessing
  r = await googleTranslateMany(["合成魔方", "虚无缥缈的传说", "次级龙血药剂"]);
  assert.deepStrictEqual(r, ["Synthetic Cube", "Illusory Legend", "Lesser Dragon Blood Potion"], "falls back to smaller chunks until each string is translated alone");

  behaviour = "down";
  r = await googleTranslateMany(["合成魔方", "后记"]);
  assert.deepStrictEqual(r, ["合成魔方", "后记"], "when the network is down the originals are kept");
  behaviour = "good";
  globalThis.fetch = realFetch; // the stub was only for the translation tests

  // ================= the content script, end to end =================
  const lib = libraryStandIn();

  function fakeStorage() {
    const data = {};
    return { data, get: async (k) => (typeof k === "string" ? (k in data ? { [k]: JSON.parse(JSON.stringify(data[k])) } : {}) : {}), set: async (o) => Object.assign(data, JSON.parse(JSON.stringify(o))) };
  }
  const storage = fakeStorage();
  globalThis.chrome = { storage: { local: storage } };
  globalThis.LibraryHost = lib.host;
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "glossary-server.js"), "utf8") + "\n;globalThis.GlossaryServer = GlossaryServer;");

  const li = (num, text, href) => ({ getAttribute: (n) => (n === "data-num" ? String(num) : null), querySelector: () => ({ textContent: text, getAttribute: () => href }) });
  const page = (url, lis) => ({ url, doc: { querySelectorAll: (sel) => (sel === "li[data-num]" ? lis : []) } });
  const calls = { translate: [], save: 0 };
  async function visit(p, translateOk = true) {
    const handler = async (m) => {
      if (m.type === "translateTitles") { calls.translate.push(m.texts); return translateOk ? { texts: m.texts.map((t) => (t ? DICT[t] || "T:" + t : t)) } : null; } // blanks stay blank, like the real translator
      if (m.type === "chapterindex:save") { calls.save++; return globalThis.GlossaryServer.saveChapterIndex(m.record); }
      return null;
    };
    const ctx = { document: p.doc, location: { href: p.url }, chrome: { storage: { local: { ...storage, get: (k) => (Array.isArray(k) && k.includes("libraryOn") ? Promise.resolve({ libraryOn: { libId: "test" } }) : storage.get(k)), set: (o) => storage.set(o) } }, runtime: { sendMessage: handler } }, URL, Date, Number, Math, Promise, JSON, console, Object, Array, String };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "chapter-index.js"), "utf8"), ctx);
    await sleep(120);
  }
  const lis = [
    li(7, "第7章 巫师学徒的战斗力", "/txt/77582/38804618"), // first entry repeats the latest chapter
    li(1, "第1章 合成魔方", "/txt/77582/38804612"), li(2, "第2章 虚无缥缈的传说", "/txt/77582/38804613"), li(3, "10.第3章 次级龙血药剂", "/txt/77582/38804614"),
    li(7, "第7章 巫师学徒的战斗力", "/txt/77582/38804618"), li(189, "189.第189章", "/txt/77582/39000000"), li(333, "后记", "/txt/77582/39634519")
  ];
  const stored = async () => (await lib.api("GET", "/api/chapter-index")).indexes;

  // pages that are not an index page do nothing (the info page only lists the latest few chapters)
  await visit(page("https://www.69shuba.com/book/77582.htm", lis));
  await visit(page("https://www.69shuba.com/txt/77582/38804612", lis));
  await visit(page("https://example.com/book/77582/", lis));
  assert.strictEqual((await stored()).length, 0, "only the real index page is captured");

  await visit(page("https://www.69shuba.com/book/77582/", lis));
  await until(async () => (await stored()).length === 1, "the index to reach the library");
  const ix = (await stored())[0];
  assert.strictEqual(ix.key, "69shuba.com/txt/77582", "same key a glossary binding uses for this novel");
  assert.strictEqual(ix.source, "69shuba");
  assert.deepStrictEqual(ix.chapters.map((c) => [c[0], c[1]]), [
    [1, "Chapter 1: Synthetic Cube"], [2, "Chapter 2: Illusory Legend"], [3, "Chapter 3: Lesser Dragon Blood Potion"],
    [7, "Chapter 7: T:巫师学徒的战斗力"], [189, "Chapter 189"], [333, "Postscript"]
  ]);
  assert.strictEqual(ix.chapters[0][2], "https://www.69shuba.com/txt/77582/38804612", "the chapter's URL, which is also its cache key");
  assert.strictEqual(ix.chapters[2][3], "10.第3章 次级龙血药剂", "the original title is kept for reference");
  assert.deepStrictEqual([...calls.translate[0]], ["合成魔方", "虚无缥缈的传说", "次级龙血药剂", "巫师学徒的战斗力", "", "后记"], "one batch, in chapter order, with only the title text (not the 第N章 marker)");
  assert.strictEqual(calls.translate.length, 1);

  // the same index again soon after is not sent again (and not translated again)
  await visit(page("https://www.69shuba.com/book/77582/", lis));
  assert.strictEqual(calls.save, 1, "an index captured within the last hours is not re-sent");
  assert.strictEqual(calls.translate.length, 1);

  // if translating fails the list is still complete, with the original text
  delete storage.data.chapterIndexAt;
  const lis2 = [li(1, "第1章 合成魔方", "/txt/9/1"), li(2, "第2章 虚无缥缈的传说", "/txt/9/2")];
  await visit(page("https://www.69shuba.com/book/9/", lis2), false);
  await until(async () => (await stored()).length === 2, "the untranslated index to reach the library");
  const ix2 = (await stored()).find((i) => i.key === "69shuba.com/txt/9");
  assert.deepStrictEqual(ix2.chapters.map((c) => c[1]), ["Chapter 1: 合成魔方", "Chapter 2: 虚无缥缈的传说"], "raw titles are kept when translation is unavailable");

  // a library that does not answer is tried again on the next visit (the capture is not remembered)
  delete storage.data.chapterIndexAt;
  lib.down = true;
  await visit(page("https://www.69shuba.com/book/77582/", lis));
  assert.ok(!storage.data.chapterIndexAt, "a failed hand-off is not remembered, so the next visit tries again");
  console.log("OK — chapter-index checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
