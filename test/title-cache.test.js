// Titles are put into the library's language once (gemini.js translateByMode, kind "titles": titlesOnce): each answer is kept in storage.local's titleCache,
// so the popup, the chapters saved from a page, the book recorded from it, its chapter list and a watch never ask for the same title again. A title in another
// script that came back as it was (Google refusing) is not kept; a title being asked for is not asked again while its answer is on its way. Book details
// (kind "book") are not kept. No network: Google Translate is stood in for.
// Run: node test/title-cache.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load({ lang = "en", google = "ok" } = {}) {
  const data = {};
  const asked = []; // each request to Google: its lines
  const state = { google };
  const ctx = vm.createContext({
    chrome: { storage: { local: {
      get: async (k) => (typeof k === "string" ? { [k]: data[k] } : Object.fromEntries((k || []).map((x) => [x, data[x]]))),
      set: async (o) => { Object.assign(data, JSON.parse(JSON.stringify(o))); }
    } } },
    GlossaryServer: { titleMode: async () => "google", targetLanguage: async () => lang },
    fetch: async (u, o) => {
      const lines = decodeURIComponent(String(o.body).slice(2)).split("\n");
      asked.push(lines);
      await new Promise((r) => setTimeout(r, 20));
      if (state.google !== "ok") return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, json: async () => [[[lines.map((l) => (/[一-鿿]/.test(l) ? "EN " + l.length : l)).join("\n"), ""]]] };
    },
    setTimeout, Date, Promise, JSON, console, encodeURIComponent, decodeURIComponent, Set, Map, Object, String, Array
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8") + ";globalThis.t = { translateByMode };", ctx);
  return { t: ctx.t, data, asked, state };
}

(async () => {
  // asked once, and the same title twice in a batch is one line
  const a = load();
  assert.deepStrictEqual(await a.t.translateByMode(["仙工开物", "仙工开物", "Chapter 1"], "titles"), ["EN 4", "EN 4", "Chapter 1"]);
  assert.strictEqual(a.asked.length, 1);
  assert.deepStrictEqual(a.asked[0], ["仙工开物", "Chapter 1"], "each distinct title once");
  assert.strictEqual(a.data.titleCache["仙工开物"], "EN 4", "kept in storage.local");
  // asked again: nothing is sent
  assert.deepStrictEqual(await a.t.translateByMode(["Chapter 1", "仙工开物"], "titles"), ["Chapter 1", "EN 4"]);
  assert.strictEqual(a.asked.length, 1, "a title seen before is not asked for again (nor one in Latin letters that came back as it was)");
  // two at once, the same new title: one request
  const [x, y] = await Promise.all([a.t.translateByMode(["咒术转盘"], "titles"), a.t.translateByMode(["咒术转盘", "仙工开物"], "titles")]);
  assert.deepStrictEqual([x, y], [["EN 4"], ["EN 4", "EN 4"]]);
  assert.strictEqual(a.asked.length, 2, "a title being asked for is not asked again while its answer is on its way");
  // a background started again reads what was kept
  const b = load();
  Object.assign(b.data, a.data);
  assert.deepStrictEqual(await b.t.translateByMode(["仙工开物"], "titles"), ["EN 4"]);
  assert.strictEqual(b.asked.length, 0, "kept across a restart");

  // Google refusing: nothing is kept, so it is asked another time
  const c = load({ google: "refused" });
  assert.deepStrictEqual(await c.t.translateByMode(["仙工开物", "Chapter 2"], "titles"), ["仙工开物", "Chapter 2"]);
  assert.ok(!c.data.titleCache || (!("仙工开物" in c.data.titleCache) && !("Chapter 2" in c.data.titleCache)), "a refusal is not kept as the title's translation");

  // a word in another language than English is kept under its language
  const d = load({ lang: "es" });
  await d.t.translateByMode(["仙工开物"], "titles");
  assert.ok(d.data.titleCache["es\u0000仙工开物"] && !d.data.titleCache["仙工开物"], "the language is part of the key");

  // a book's details are not kept (their title is: book-capture.js asks for it as a title)
  const e = load();
  await e.t.translateByMode(["仙工开物", "作者", "玄幻"], "book");
  assert.ok(!e.data.titleCache, "book details are not kept");

  console.log("title-cache: ok");
})().catch((e) => { console.error(e); process.exit(1); });
