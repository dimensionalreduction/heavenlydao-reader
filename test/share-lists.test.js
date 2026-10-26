// The lists of the novels a library shares (share-lists.js), made from what a device holds, as the extension keeps them with no page of the site
// open. Run: node test/share-lists.test.js
const assert = require("assert");
const path = require("path");
globalThis.Chapters = require(path.join(__dirname, "..", "vendor", "chapters.js"));
const L = require(path.join(__dirname, "..", "src", "shared", "share-lists.js"));

(async () => {
  const W = (n) => "translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-" + n;
  const S = (n) => "translation:https://www.69shuba.com/txt/1/" + (100 + n);
  const meta = (name, title, at) => ({ novelName: name, pageTitle: title, savedAt: at });
  const index = { [W(1)]: meta("Synthesis Wizard", "Chapter 1: Cube", 10), [W(2)]: meta("Synthesis Wizard", "Chapter 2: Legend", 20), [S(1)]: meta("仙工开物", "第1章 开始", 30) };
  const novels = L.novelsOf({ index, have: new Set(Object.keys(index)) });
  assert.strictEqual(novels.size, 2, "the novels, from the sync's index and the chapters held");
  const wtr = [...novels.values()].find((n) => n.wtrIds.size);
  const site = [...novels.values()].find((n) => !n.wtrIds.size);
  assert.strictEqual(L.bookIdOf(wtr), "wtr-lab:8053");

  // its record: the library's details of it
  const records = [{ id: "wtr-lab:8053", title: "Synthesis Wizard", author: "Someone", cover: "c.jpg", source: "wtr-lab" }];
  const m = L.manifest(wtr, records, {});
  assert.deepStrictEqual([m.title, m.author, m.cover], ["Synthesis Wizard", "Someone", "c.jpg"]);
  assert.deepStrictEqual(m.chapters.map((c) => [c[0], c[2], c[3]]), [[1, W(1), 10], [2, W(2), 20]], "the chapters held: number, key, when saved");

  // a chapter its source lists that nobody has translated is in the list too (saved at 0), for a reader to translate with its own extension
  const listed = L.novelsOf({ index, have: new Set(Object.keys(index)), chapterIndex: { "wtr-lab:8053": { chapters: [[1, "Chapter 1: Cube", W(1).slice(12)], [2, "Chapter 2: Legend", W(2).slice(12)], [3, "Chapter 3: Elsewhere", W(3).slice(12)]] } } });
  const full = L.manifest([...listed.values()].find((n) => n.wtrIds.size), records, {});
  assert.deepStrictEqual(full.chapters.map((c) => [c[0], c[2], c[3]]), [[1, W(1), 10], [2, W(2), 20], [3, W(3), 0]], "the chapter nobody has translated: number, key, saved at 0");

  // written: a list the library has, together with it (what only it has stays); with every novel shared, a novel not shared yet is added
  const stored = { title: "Synthesis Wizard", author: "Someone", cover: "c.jpg", chapters: [[1, "Chapter 1: Cube", W(1), 10], [3, "Chapter 3: Elsewhere", W(3), 5]] };
  const puts = {};
  const put = async (id, list) => { puts[id] = list; };
  let n = await L.write({ novels, books: { "wtr-lab:8053": stored }, rule: { all: true, off: [] }, records: [], chapterIndex: {}, put });
  assert.strictEqual(n, 2, "both written: one brought up to date, one added");
  assert.deepStrictEqual(puts["wtr-lab:8053"].chapters.map((c) => c[2]), [W(1), W(2), W(3)], "its new chapter added, the one only the library has kept");
  assert.strictEqual(puts["wtr-lab:8053"].author, "Someone", "no record here: the stored details stay");
  assert.ok(puts[L.bookIdOf(site)] && puts[L.bookIdOf(site)].chapters.length === 1, "the novel not shared yet, added");

  // nothing changed: nothing written; your version of someone's novel: left to its own page; only novels shared one by one: only those
  const again = {};
  n = await L.write({ novels, books: { ...puts }, rule: { all: true, off: [] }, records: [], chapterIndex: {}, put: async (id, l) => { again[id] = l; } });
  assert.strictEqual(n, 0, "the same lists again: nothing written");
  n = await L.write({ novels, books: { "wtr-lab:8053": { layer: true, chapters: [] } }, rule: { all: false, off: [] }, records: [], chapterIndex: {}, put: async (id) => { throw new Error("must not write " + id); } });
  assert.strictEqual(n, 0, "a version of yours, and a novel not shared one by one: not written");
  n = await L.write({ novels, books: {}, rule: { all: true, off: [L.bookIdOf(site), "wtr-lab:8053"] }, records: [], chapterIndex: {}, put: async (id) => { throw new Error("must not write " + id); } });
  assert.strictEqual(n, 0, "a novel stopped one by one is not shared again");

  console.log("OK — share lists checks passed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
