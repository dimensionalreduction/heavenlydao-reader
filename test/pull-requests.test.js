// Pull requests (docs/SHARED-LIBRARIES.md step 4): a reader's changes to one novel, sealed for the library's owner, passed on by the readers in
// the room while the owner is offline, taken into the owner's inbox, and answered; who may send them; what is refused.
// Run: node test/pull-requests.test.js
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
  // ---- Ana shares a novel ----
  const ana = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Ana's laptop" });
  await ana.create();
  await ana.put("profile", { name: "Ana" });
  const X = "69shuba.com/txt/1";
  const url = (n) => "https://www.69shuba.com/txt/1/" + n;
  await ana.put("sbook:" + X, { title: "Novel", keys: [X], chapters: [1, 2].map((n) => [n, "Chapter " + n, "translation:" + url(n), 1000 + n]) });
  const share = await ana.share();
  assert.ok(share.sealPub && share.sealPriv, "the share key comes with a seal key");
  const bookKey = await Library.bookKeyOf(share.readKey, X);
  const roomId = await Library.bookRoomOf(share.libId, bookKey);
  const anaRooms = Share.createRooms({ log: () => {} });
  const chapters = new Map([1, 2].map((n) => ["translation:" + url(n), { translated: "Ana's chapter " + n, savedAt: 1000 + n }]));
  const publishing = Share.publishing({ lib: ana, rooms: anaRooms, getChapter: async (k) => chapters.get(k) || null, listChapters: async () => new Map([...chapters].map(([k, e]) => [k, e.savedAt])), getCover: async () => null });
  await publishing.update();
  const anaRoom = anaRooms.get(roomId);
  assert.ok(anaRoom, "Ana publishes the novel's room");

  // ---- Ben (a library of his own) and Rae (a reader, no library) read it ----
  const ben = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Ben's phone" });
  await ben.create();
  const reader = async (who) => {
    const store = Share.followStore(Share.memoryAdapter());
    await store.addLink({ libId: share.libId, bookId: X, bookKey });
    const room = Share.createRooms({ log: () => {} }).join(roomId, Share.follower({ store, libId: share.libId, scope: "book", bookId: X }), { network: false });
    return { who, store, room };
  };
  const B = await reader("Ben");
  const R = await reader("Rae");
  let cutBA = link(B.room, anaRoom);
  await waitFor(async () => !!(await B.store.get(share.libId, "profile")), "Ana's profile");
  const prof = await B.store.body(share.libId, "profile");
  assert.deepStrictEqual([prof.name, prof.prs, prof.sealKey], ["Ana", "anyone", share.sealPub], "the profile says whom Ana takes pull requests from, and the key to seal them with");
  cutBA();

  // ---- Ben sends a pull request with Ana offline; Rae holds it and passes it on ----
  const body = { name: "Ben", message: "Two fixes", items: [{ kind: "term", from: ["Fang Yuan"], to: "Fang Yuan!" }, { kind: "chapter", num: 2, title: "Chapter 2", url: url(2), entry: { translated: "Ben's chapter 2" } }] };
  const pr = await ben.makePr({ to: share.libId, book: X, sealKey: prof.sealKey, body });
  assert.ok(!/Two fixes|Ben's chapter/.test(JSON.stringify(pr)), "what it says is sealed");
  await B.room.holder.keepMine(pr);
  const cutBR = link(B.room, R.room);
  await waitFor(async () => !!(await R.room.holder.getPr(pr.id)), "Rae to hold Ben's pull request");
  cutBR();
  // Ana comes online; Rae is there, Ben is not
  const cutRA = link(R.room, anaRoom);
  await waitFor(async () => (await ana.inbox()).length === 1, "the pull request to reach Ana's inbox through Rae");
  const [inbox] = await ana.inbox();
  assert.deepStrictEqual([inbox.from, inbox.book, inbox.body.message, inbox.body.items.length, inbox.done], [ben.status().libId, X, "Two fixes", 2, null], "Ana opens it");

  // ---- Ana answers: the term taken, the chapter not; Rae stops passing it on; Ben learns the answer ----
  await ana.put("prdone:" + pr.id, { state: "partly", accepted: [0], at: Date.now(), from: inbox.from, book: X });
  await waitFor(async () => !!(await R.store.get(share.libId, "pr:" + pr.id)), "the answer to reach Rae");
  assert.deepStrictEqual(await R.room.holder.prs(), [], "an answered pull request is no longer passed on");
  cutRA();
  link(B.room, R.room);
  await waitFor(async () => !!(await B.store.get(share.libId, "pr:" + pr.id)), "the answer to reach Ben, from Rae");
  assert.deepStrictEqual((await B.store.body(share.libId, "pr:" + pr.id)).accepted, [0]);

  // ---- what is refused ----
  const policy = { prs: "anyone", approved: [], sealKey: share.sealPub };
  assert.strictEqual(await Library.checkPr(pr, { to: share.libId, policy }), "", "the real one");
  assert.strictEqual(await Library.checkPr(Object.assign({}, pr, { book: "another" }), { to: share.libId, policy }), "bad signature", "changed on the way");
  const stranger = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Stranger" });
  await stranger.create();
  assert.strictEqual(await Library.checkPr(Object.assign({}, pr, { devices: stranger.get("devices") }), { to: share.libId, policy }), "bad sender", "someone else's devices");
  assert.strictEqual(await Library.checkPr(pr, { to: share.libId, policy: Object.assign({}, policy, { prs: "off" }) }), "not taken");
  assert.strictEqual(await Library.checkPr(pr, { to: share.libId, policy: Object.assign({}, policy, { prs: "approved" }) }), "not approved");
  assert.strictEqual(await Library.checkPr(pr, { to: share.libId, policy: Object.assign({}, policy, { prs: "approved", approved: [ben.status().libId] }) }), "", "an approved sender");
  assert.strictEqual(await Library.checkPr(pr, { to: share.libId, policy, now: pr.expires + 1 }), "expired");
  assert.strictEqual(await Library.checkPr(pr, { to: "x".repeat(43), policy }), "malformed", "for another library");
  // a reader holds at most 3 open from one sender
  for (let i = 0; i < 3; i++) await R.room.holder.receivePr(await ben.makePr({ to: share.libId, book: X, sealKey: prof.sealKey, body: { items: [] } }));
  assert.strictEqual((await R.room.holder.receivePr(await ben.makePr({ to: share.libId, book: X, sealKey: prof.sealKey, body: { items: [] } }))).why, "too many from this sender");

  // ---- Ana takes pull requests only from people she approved: an unapproved one is not passed on ----
  await ana.put("profile", { name: "Ana", prs: "approved", approved: [] });
  const cut2 = link(R.room, anaRoom);
  await waitFor(async () => ((await R.store.body(share.libId, "profile")) || {}).prs === "approved", "the new rule to reach Rae");
  cut2();
  const later = await ben.makePr({ to: share.libId, book: X, sealKey: prof.sealKey, body: { items: [] } });
  const fresh = await reader("Zoe");
  await fresh.store.put(share.libId, "profile", await R.store.get(share.libId, "profile"));
  assert.strictEqual((await fresh.room.holder.receivePr(later)).why, "not approved", "a reader does not pass on what Ana would not take");

  publishing.stop();
  console.log("OK — pull request checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
