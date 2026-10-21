// The libraries you follow, looked after by the extension with no page open (src/shared/follow-host.js): told which by the site's tab, it is in
// a kept library's room, fetches its novels whole and passes them on; a library's limit stops it; one no longer followed is left.
// No network: the rooms are linked directly. Run: node test/follow-host.test.js
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
function link(a, b) {
  const h = {};
  h.a = a.link((m) => setImmediate(() => h.b && h.b.receive(clone(m))));
  h.b = b.link((m) => setImmediate(() => h.a && h.a.receive(clone(m))));
  return () => { h.a.close(); h.b.close(); h.a = null; h.b = null; };
}

(async () => {
  // the extension's page, as far as follow-host.js needs it (its store in memory, not IndexedDB)
  globalThis.self = globalThis;
  globalThis.Library = Library;
  globalThis.ShareRooms = Object.assign({}, Share, { idbAdapter: () => Share.memoryAdapter() });
  require("../src/shared/follow-host.js");
  const FollowHost = globalThis.FollowHost;

  // ---- someone's library: two novels of three chapters ----
  const owner = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Their laptop" });
  await owner.create();
  const X = "wtr-lab:8053";
  const Y = "69shuba.com/txt/1";
  const url = (b, n) => (b === X ? "https://wtr-lab.com/en/novel/8053/w/chapter-" + n : "https://www.69shuba.com/txt/1/" + n);
  const chapters = new Map();
  for (const b of [X, Y]) for (let n = 1; n <= 3; n++) chapters.set("translation:" + url(b, n), { translated: "Text of " + b + " #" + n + " " + "x".repeat(400), pageTitle: "Chapter " + n, novelName: b, savedAt: 1000 + n, model: "m" });
  const sbook = (b, title) => ({ title, author: "Someone", coverId: "", chapters: [1, 2, 3].map((n) => [n, "Chapter " + n, "translation:" + url(b, n), 1000 + n]) });
  await owner.put("sbook:" + X, Object.assign(sbook(X, "Synthesis Wizard"), { keys: [X] }));
  await owner.put("sbook:" + Y, sbook(Y, "Another Novel"));
  const share = await owner.share();
  const listChapters = async () => new Map([...chapters.entries()].map(([k, e]) => [k, e.savedAt]));
  const ownerRooms = Share.createRooms({ log: () => {} });
  const oLib = ownerRooms.join(share.libRoom, Share.publisher({ lib: owner, scope: "lib", getChapter: async (k) => chapters.get(k) || null, listChapters, getCover: async () => null }), { network: false });

  // ---- the extension: its rooms, told by the site's tab that this library is followed and kept available ----
  const rooms = Share.createRooms({ log: () => {} });
  const tally = Share.sentTally({ load: () => null, save: () => {} });
  FollowHost.attach(rooms, tally);
  const follow = { libId: share.libId, readKey: share.readKey, books: {}, name: "Theirs", at: Date.now(), followed: true, keep: { on: true, books: null } };
  assert.deepStrictEqual(await FollowHost.set([follow], {}), { follows: 1 });
  await waitFor(() => !!rooms.get(share.libRoom), "the library's room joined");
  link(oLib, rooms.get(share.libRoom));
  const store = FollowHost._store;
  await waitFor(async () => !!(await store.get(share.libId, "head")), "the library's list");
  await FollowHost.look(); // (now that its list is here: as it would shortly by itself)
  await waitFor(async () => (await store.list(share.libId, "chapter:")).length === 6, "every chapter of both novels, kept here");
  assert.ok((await store.body(share.libId, "chapter:" + url(Y, 3))).translated.startsWith("Text of " + Y + " #3"), "the owner's text");
  assert.ok(FollowHost.libOf(share.libRoom) === share.libId, "its room is known as the library's (its readers' daily limit)");
  const st = await FollowHost.status();
  assert.deepStrictEqual([st.follows, st.kept, st.rooms], [1, 1, 1]);
  assert.ok(st.held > 6 * 400, "what it keeps here");
  const sch = await FollowHost.schedule();
  assert.ok(sch.at > 0 && sch.next === sch.at + 5 * 60 * 1000 && sch.every === 5 * 60 * 1000, "its schedule: the last look, and the next 5 minutes after it");
  assert.deepStrictEqual(sch.kept, [{ libId: share.libId, name: "Theirs", books: null }], "and the libraries kept, for the Activity page's Upcoming");
  assert.strictEqual(await FollowHost.canSend(share.libId, 1000), true, "under its daily limit");
  tally.add(share.libId, X, 50 * 1024 ** 3);
  assert.strictEqual(await FollowHost.canSend(share.libId, 1000), false, "past it: nothing more to its readers today");

  // ---- a library with a limit it is at: no chapters ----
  const capped = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Another" });
  await capped.create();
  await capped.put("sbook:" + X, Object.assign(sbook(X, "Synthesis Wizard"), { keys: [X] }));
  const share2 = await capped.share();
  const cRooms = Share.createRooms({ log: () => {} });
  const cLib = cRooms.join(share2.libRoom, Share.publisher({ lib: capped, scope: "lib", getChapter: async (k) => chapters.get(k) || null, listChapters, getCover: async () => null }), { network: false });
  await FollowHost.set([follow, { libId: share2.libId, readKey: share2.readKey, books: {}, at: Date.now(), followed: true, keep: { on: true, books: null }, caps: { store: 1 } }], {});
  await waitFor(() => !!rooms.get(share2.libRoom), "the second library's room");
  link(cLib, rooms.get(share2.libRoom));
  await waitFor(async () => !!(await store.get(share2.libId, "head")), "its list (lists come at the limit)");
  await FollowHost.look();
  await sleep(800);
  assert.strictEqual((await store.list(share2.libId, "chapter:")).length, 0, "at its limit: no chapter");

  // ---- no longer followed: its room is left ----
  await FollowHost.set([follow], {});
  await waitFor(() => !rooms.get(share2.libRoom), "the unfollowed library's room left");
  assert.strictEqual((await FollowHost.status()).follows, 1);

  console.log("OK — follow host passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
