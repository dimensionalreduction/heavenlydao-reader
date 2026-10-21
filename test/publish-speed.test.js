// An owner's device serving a whole library to a reader (share-rooms.js publisher): with every novel shared, each chapter asked for must not
// copy every shared novel's list of chapters (lib.sharedBooks), nor make the room's other records again. It did, and a library with big
// lists sent its chapters a few a second. Run: node test/publish-speed.test.js
const assert = require("assert");
const Library = require("../src/shared/library.js");
const Share = require("../src/shared/share-rooms.js");

(async () => {
  const owner = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  await owner.create();
  await owner.share();
  // 20 novels of 2,000 chapters, every one shared; this device holds the first novel's chapters
  const url = (b, n) => "translation:https://example.com/novel" + b + "/" + n + ".html";
  const held = new Map();
  for (let b = 0; b < 20; b++) {
    const chapters = Array.from({ length: 2000 }, (_, i) => [i + 1, "Chapter " + (i + 1), url(b, i + 1), 1000 + i]);
    await owner.put("sbook:novel" + b, { title: "Novel " + b, chapters, keys: [] });
  }
  for (let i = 0; i < 2000; i++) held.set(url(0, i + 1), { translated: "Text " + (i + 1), savedAt: 1000 + i, pageTitle: "Chapter " + (i + 1) });
  const getChapter = async (k) => held.get(k) || null;
  const listChapters = async () => new Map([...held].map(([k, e]) => [k, e.savedAt]));

  let copies = 0;
  const real = owner.sharedBooks;
  const lib = Object.assign(Object.create(owner), owner, { sharedBooks: () => { copies++; return real(); } });
  const pub = Share.publisher({ lib, scope: "lib", getChapter, listChapters, getCover: async () => null });

  await pub.versions(); // (the room's records, made once)
  copies = 0;
  const t0 = Date.now();
  for (let i = 1; i <= 200; i++) {
    const r = await pub.get("chapter:" + url(0, i).replace(/^translation:/, ""));
    assert.ok(r && r.key.startsWith("chapter:"), "chapter " + i + " made");
  }
  await pub.get("head");
  await pub.versions();
  const ms = Date.now() - t0;
  assert.strictEqual(copies, 0, "no copy of every novel's list for a chapter, nor for the room's records made again");
  assert.strictEqual(await pub.bookOf("chapter:" + url(3, 7).replace(/^translation:/, "")), "novel3", "a chapter's novel, from the index");
  const lists = await pub.chapterLists();
  assert.strictEqual(lists.length, 20);
  assert.strictEqual(lists[0].keys, (await pub.chapterLists())[0].keys, "a novel's keys are made once per version of its list");
  console.log("OK — publish speed passed (200 chapters made in " + ms + " ms)");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
