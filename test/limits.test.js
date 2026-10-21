// A library's limits on a device (share-rooms.js): what was sent its readers today (sentTally.todayOf), what its records take here
// (followStore.heldBytes, kept as records are put and deleted), and a reader's holder at its limit (follower full): no more chapters or
// covers, its list and a novel's details still. Run: node test/limits.test.js
const assert = require("assert");
const Share = require("../src/shared/share-rooms.js");

(async () => {
  // ---- what was sent today ----
  let saved = null;
  const tally = Share.sentTally({ load: () => saved, save: (d) => { saved = d; } });
  tally.add("lib1", "book1", 1000);
  tally.add("lib1", "", 500);
  tally.add("lib2", "book9", 7);
  assert.strictEqual(tally.todayOf("lib1"), 1500);
  assert.strictEqual(tally.todayOf("lib2"), 7);
  assert.strictEqual(tally.todayOf("nobody"), 0);
  assert.strictEqual(tally.get("lib1").total, 1500, "and in all");
  // a day later the count starts again (the total stays)
  const realDate = global.Date;
  global.Date = class extends realDate { constructor(...a) { super(...(a.length ? a : [realDate.now() + 26 * 3600 * 1000])); } static now() { return realDate.now() + 26 * 3600 * 1000; } };
  assert.strictEqual(tally.todayOf("lib1"), 0, "tomorrow, nothing sent yet");
  tally.add("lib1", "book1", 10);
  assert.strictEqual(tally.todayOf("lib1"), 10);
  assert.strictEqual(tally.get("lib1").total, 1510);
  global.Date = realDate;

  // ---- what a library's records take here, kept ----
  const store = Share.followStore(Share.memoryAdapter());
  const row = (key, n) => ({ r: { key, ver: [1, 0, ""] }, body: { text: "x".repeat(n) } });
  await store.put("lib1", "chapter:a", row("chapter:a", 1000));
  const one = await store.heldBytes("lib1");
  assert.ok(one > 1000, "a chapter's size, and its record's");
  await store.put("lib1", "chapter:b", row("chapter:b", 3000));
  const two = await store.heldBytes("lib1");
  assert.ok(two > one + 3000, "two");
  await store.put("lib1", "chapter:b", row("chapter:b", 100)); // (a newer, smaller copy)
  assert.ok((await store.heldBytes("lib1")) < two - 2800, "a record replaced counts once");
  await store.del("lib1", "chapter:b");
  assert.strictEqual(await store.heldBytes("lib1"), one, "and a record deleted no more");
  assert.strictEqual(await store.heldBytes("lib2"), 0);
  // read back from the records the first time it is asked (a new page)
  const again = Share.followStore(store.adapter);
  assert.strictEqual(await again.heldBytes("lib1"), one);
  // a library's own limits, kept with its follow
  await store.addLink({ libId: "lib1", readKey: "k".repeat(43) });
  await store.setCaps("lib1", { store: 123, out: 456 });
  assert.deepStrictEqual((await store.follow("lib1")).caps, { store: 123, out: 456 });

  // ---- a reader at its limits (as the site asks: chapters and covers at the library's limit, its lists and details a little past it) ----
  let held = 0;
  const limit = 1000;
  const over = 100;
  const bulk = (key) => /^(chapter|cover|bcover):/.test(key);
  const h = Share.follower({ store, libId: "lib1", scope: "lib", full: async (key) => held >= limit + (bulk(key) ? 0 : over) });
  assert.strictEqual(await h.wants("chapter:c", [1, 0, ""], true), true, "a chapter asked for, under the limit");
  held = limit;
  assert.strictEqual(await h.wants("chapter:c", [1, 0, ""], true), false, "at the limit: no new chapter");
  assert.strictEqual(await h.wants("cover:book1", [1, 0, ""], true), false, "nor a cover");
  assert.strictEqual(await h.wants("head", [2, 0, ""], false), true, "the library's list still");
  assert.strictEqual(await h.wants("book:book1", [1, 0, ""], true), true, "and a novel's details");
  held = limit + over;
  assert.strictEqual(await h.wants("head", [2, 0, ""], false), false, "past it by the allowance: not its list either");
  assert.strictEqual(await h.wants("entry:book2", [1, 0, ""], false), false, "nor a novel's entry (a library of huge details fills nothing)");
  assert.strictEqual(await h.wants("chapter:a", [2, 0, ""], true), false, "nor a newer copy of a chapter held (it could be bigger)");
  assert.strictEqual(await h.wants("devices", [2, 0, ""], false), true, "the list of devices always (records are checked with it)");
  held = 0;
  assert.strictEqual(await h.wants("chapter:a", [2, 0, ""], true), true, "a limit raised: brought up to date again");

  console.log("OK — limits passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
