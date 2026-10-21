// "Tell me about new chapters" run by the extension (share-rooms.js editionWatch): another library's edition of a novel you own has chapters
// past your last one: yours are fetched from your own source and translated, once; one your lists do not have makes them be read again.
// Run: node test/editions.test.js
const assert = require("assert");
const Library = require("../src/shared/library.js");
const Share = require("../src/shared/share-rooms.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(30);
  }
  throw new Error("timed out waiting for: " + what);
}
const clone = (m) => JSON.parse(JSON.stringify(m));

(async () => {
  const X = "69shuba.com/txt/5";
  const url = (n) => "https://www.69shuba.com/txt/5/" + n;
  // ---- Ana's edition: chapters 1 to 4 ----
  const ana = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Ana" });
  await ana.create();
  await ana.put("sbook:" + X, { title: "Novel", chapters: [1, 2, 3, 4].map((n) => [n, "Chapter " + n, "translation:" + url(n), 1000 + n]) });
  const share = await ana.share();
  const bookKey = await Library.bookKeyOf(share.readKey, X);
  const anaRooms = Share.createRooms({ log: () => {} });
  const anaRoom = anaRooms.join(await Library.bookRoomOf(share.libId, bookKey), Share.publisher({ lib: ana, scope: "book", bookId: X, getChapter: async () => null, listChapters: async () => new Map() }), { network: false });

  // ---- Dev owns the novel: his source's list has chapters 1 to 3, he has chapter 1 ----
  const dev = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Dev" });
  await dev.create();
  await dev.api("PUT", "/api/chapter-index", { key: X, source: "69shuba", url: "https://www.69shuba.com/book/5.htm", chapters: [1, 2, 3].map((n) => [n, "Chapter " + n, url(n)]) });
  await dev.put("edition:" + X, { modes: { [share.libId]: "notify" }, keys: { [share.libId]: bookKey }, asked: {} });
  const fetched = [];
  const listsRead = [];
  const devRooms = Share.createRooms({ log: () => {} });
  const watch = Share.editionWatch({
    lib: dev, rooms: devRooms, store: Share.followStore(Share.memoryAdapter()),
    listChapters: async () => new Map([["translation:" + url(1), 1]]),
    fetchChapter: async (key, meta) => { fetched.push([key, meta.translate, meta.pageTitle]); },
    readList: async (u) => { listsRead.push(u); }
  });
  assert.deepStrictEqual(await watch.check(), [], "Ana's list has not come yet: nothing asked");
  // the extension is now in the edition's room, as a reader; Ana's device is there
  const devRoom = devRooms.rooms()[0];
  assert.ok(devRoom, "it joined the edition's room");
  const h = {};
  h.a = devRoom.link((m) => setImmediate(() => h.b && h.b.receive(clone(m))));
  h.b = anaRoom.link((m) => setImmediate(() => h.a && h.a.receive(clone(m))));
  await waitFor(async () => (await watch.check()).length > 0, "the edition's list, and chapters asked for");
  assert.deepStrictEqual(fetched, [["translation:" + url(2) + "#original", true, "Chapter 2"], ["translation:" + url(3) + "#original", true, "Chapter 3"]], "chapters 2 and 3, from Dev's own source, translated");
  assert.deepStrictEqual(listsRead, ["https://www.69shuba.com/book/5.htm"], "chapter 4 is not in Dev's list yet: the list is read again");
  assert.deepStrictEqual(Object.keys(dev.editions()[X].asked).sort(), ["2", "3", "list"], "what was asked is kept in the library (every device of Dev's knows)");
  assert.deepStrictEqual(await watch.check(), [], "and not asked again so soon");
  assert.strictEqual(fetched.length, 2);
  // an edition switched to "use their chapters" (or off) is not watched
  await dev.put("edition:" + X, Object.assign({}, dev.editions()[X], { modes: { [share.libId]: "use" }, asked: {} }));
  assert.deepStrictEqual(await watch.check(), []);
  console.log("OK — edition checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
