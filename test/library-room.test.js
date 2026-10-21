// A library's room carries all of it (src/shared/share-rooms.js): a reader with the library's link reads every novel there, with no novel's
// own room: a novel's details when it is opened, its chapters when they are read; another reader gets them from the first with the owner
// offline; nothing of a novel not opened is fetched. Run: node test/library-room.test.js
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
  // ---- the owner: two novels shared, the chapters this device holds ----
  const owner = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  await owner.create();
  await owner.put("profile", { name: "Supun's novels" });
  const X = "wtr-lab:8053";
  const Y = "69shuba.com/txt/1";
  const url = (b, n) => (b === X ? "https://wtr-lab.com/en/novel/8053/w/chapter-" + n : "https://www.69shuba.com/txt/1/" + n);
  const chapters = new Map();
  for (const b of [X, Y]) for (let n = 1; n <= 3; n++) chapters.set("translation:" + url(b, n), { translated: "Text of " + b + " #" + n, pageTitle: "Chapter " + n, novelName: b, savedAt: 1000 + n, model: "m" });
  const sbook = (b, title) => ({ title, author: "Someone", coverId: "", chapters: [1, 2, 3].map((n) => [n, "Chapter " + n, "translation:" + url(b, n), 1000 + n]) });
  await owner.put("sbook:" + X, Object.assign(sbook(X, "Synthesis Wizard"), { keys: [X] }));
  await owner.put("sbook:" + Y, sbook(Y, "Another Novel"));
  await owner.api("PUT", "/api/my-terms/term1", { from: ["Corey"], to: "Kory", keys: [X], novel: "Synthesis Wizard" });
  const share = await owner.share();
  const listChapters = async () => new Map([...chapters.entries()].map(([k, e]) => [k, e.savedAt]));
  const ownerRooms = Share.createRooms({ log: () => {} });
  const oLib = ownerRooms.join(share.libRoom, Share.publisher({ lib: owner, scope: "lib", getChapter: async (k) => chapters.get(k) || null, listChapters, getCover: async () => null }), { network: false });

  // what the owner's library room says it has: the catalog, and each novel's details
  const said = new Map(await oLib.holder.versions());
  for (const k of ["head", "entry:" + X, "book:" + X, "bhead:" + X, "terms:" + X, "book:" + Y, "bhead:" + Y]) assert.ok(said.has(k), "the library room has " + k);
  assert.ok(!said.has("bcover:" + X), "(the catalog's cover is the cover there)");
  const lists = await oLib.holder.chapterLists();
  assert.deepStrictEqual(lists.map((c) => c.bookId).sort(), [X, Y].sort(), "chapter bits for every novel shared");

  // ---- reader 1: the library's link, the library room only ----
  const s1 = Share.followStore(Share.memoryAdapter());
  await s1.addLink(Library.parseLink(Library.libraryLink("https://site.dev/", share.libId, share.readKey)));
  const r1 = Share.createRooms({ log: () => {} });
  const f1 = r1.join(share.libRoom, Share.follower({ store: s1, libId: share.libId, scope: "lib" }), { network: false });
  const cut1 = link(oLib, f1);
  await waitFor(async () => (await s1.list(share.libId, "entry:")).length === 2 && !!(await s1.get(share.libId, "head")), "the list of novels");
  await sleep(200);
  assert.strictEqual(await s1.get(share.libId, "bhead:" + X), null, "following fetches no novel's details");
  assert.strictEqual((await s1.list(share.libId, "chapter:")).length, 0, "nor a chapter");

  // opening novel X: its details come, in the same room
  await f1.open(X);
  await waitFor(async () => !!(await s1.get(share.libId, "bhead:" + X)) && !!(await s1.get(share.libId, "terms:" + X)) && !!(await s1.get(share.libId, "book:" + X)), "novel X's details");
  assert.strictEqual((await s1.body(share.libId, "book:" + X)).title, "Synthesis Wizard");
  assert.deepStrictEqual((await s1.body(share.libId, "terms:" + X)).terms.map((t) => t.to), ["Kory"]);
  assert.strictEqual(await s1.get(share.libId, "bhead:" + Y), null, "the novel not opened is not fetched");
  assert.strictEqual((await s1.list(share.libId, "chapter:")).length, 0, "opening a novel fetches no chapter");

  // reading chapter 2 of X: from the owner, over the library room
  const k2 = "chapter:" + url(X, 2);
  await waitFor(async () => (await f1.holdersOf(k2)) === 1, "the owner listed as holding chapter 2");
  const got = await f1.fetch(k2);
  assert.ok(got, "chapter 2 came");
  assert.strictEqual((await s1.body(share.libId, k2)).translated, "Text of " + X + " #2");
  assert.strictEqual((await s1.list(share.libId, "chapter:")).length, 1, "only the chapter read");

  // a chapter of a novel not opened cannot be taken (its list is not here to check it against)
  assert.strictEqual(await f1.fetch("chapter:" + url(Y, 1)), null);

  // ---- the owner goes offline; reader 2 gets novel X and its chapter 2 from reader 1 ----
  cut1();
  const s2 = Share.followStore(Share.memoryAdapter());
  await s2.addLink(Library.parseLink(Library.libraryLink("https://site.dev/", share.libId, share.readKey)));
  const r2 = Share.createRooms({ log: () => {} });
  const f2 = r2.join(share.libRoom, Share.follower({ store: s2, libId: share.libId, scope: "lib" }), { network: false });
  const f1again = r1.get(share.libRoom);
  link(f1again, f2);
  await waitFor(async () => !!(await s2.get(share.libId, "head")), "reader 2's list, from reader 1");
  await f2.open(X);
  await waitFor(async () => !!(await s2.get(share.libId, "bhead:" + X)), "novel X's list, from reader 1");
  await waitFor(async () => (await f2.holdersOf(k2)) === 1, "reader 1 listed as holding chapter 2");
  assert.strictEqual(await f2.holdersOf("chapter:" + url(X, 3)), 0, "and not chapter 3, which reader 1 never read");
  assert.ok(await f2.fetch(k2), "chapter 2 from reader 1, the owner offline");
  assert.strictEqual((await s2.body(share.libId, k2)).translated, "Text of " + X + " #2", "unchanged: it is the owner's, signed");

  // ---- reader 1 removes novel X from its device: its chapter and details go, reader 2 no longer counts it as holding them ----
  assert.strictEqual(await f2.holdersOf(k2), 1);
  const removed = await s1.removeBook(share.libId, X);
  await f1again.forget(X);
  assert.strictEqual(removed, 1, "the one chapter kept");
  assert.strictEqual(await s1.get(share.libId, k2), null);
  assert.strictEqual(await s1.get(share.libId, "bhead:" + X), null);
  assert.ok(await s1.get(share.libId, "entry:" + X), "the library's list of novels stays");
  await waitFor(async () => (await f2.holdersOf(k2)) === 0, "reader 2 told reader 1 holds it no more");

  // ---- pull-through: reader C is connected only to reader D, D to the owner; D never opened novel Y. C opens Y and reads its chapter 1:
  // D fetches Y's list and the chapter from the owner for C, keeps them, and passes them on ----
  const sC = Share.followStore(Share.memoryAdapter());
  const sD = Share.followStore(Share.memoryAdapter());
  for (const st of [sC, sD]) await st.addLink(Library.parseLink(Library.libraryLink("https://site.dev/", share.libId, share.readKey)));
  const rC = Share.createRooms({ log: () => {} });
  const rD = Share.createRooms({ log: () => {} });
  const fC = rC.join(share.libRoom, Share.follower({ store: sC, libId: share.libId, scope: "lib" }), { network: false });
  const fD = rD.join(share.libRoom, Share.follower({ store: sD, libId: share.libId, scope: "lib" }), { network: false });
  link(oLib, fD);
  link(fD, fC);
  await waitFor(async () => !!(await sC.get(share.libId, "devices")) && !!(await sC.get(share.libId, "head")), "C's list, through D");
  assert.strictEqual(await sD.get(share.libId, "bhead:" + Y), null, "D never opened novel Y");
  await fC.open(Y);
  await waitFor(async () => !!(await sC.get(share.libId, "bhead:" + Y)), "novel Y's list reaching C through D", 20000);
  assert.ok(await sD.get(share.libId, "bhead:" + Y), "D kept a copy on the way");
  const y1 = "chapter:" + url(Y, 1);
  assert.strictEqual(await fC.holdersOf(y1), 0, "nobody C is connected to holds Y's chapter 1");
  const pulled = await fC.fetch(y1);
  assert.ok(pulled, "C got Y's chapter 1 all the same: D fetched it from the owner");
  assert.strictEqual((await sC.body(share.libId, y1)).translated, "Text of " + Y + " #1");
  assert.ok(await sD.get(share.libId, y1), "and D holds it now too");
  assert.strictEqual(await fC.fetch("chapter:" + url(Y, 9)), null, "a chapter that is in no list is not chased");
  rC.stop(); rD.stop();

  // ---- a reader with only novel X's link still uses its own room (and cannot read the library's) ----
  const s3 = Share.followStore(Share.memoryAdapter());
  const xKey = await Library.bookKeyOf(share.readKey, X);
  await s3.addLink({ libId: share.libId, bookId: X, bookKey: xKey });
  assert.strictEqual(await s3.catalogKey(share.libId), null, "a novel's link gives no key to the library's room");

  // ---- a version made by making another library one's own carries that library's read key, for its readers ----
  const Z = "wtr-lab:9999";
  const upstream = { lib: "upstream-lib-id", bookKey: "k-book", book: Z, readKey: "k-read" };
  await owner.put("sbook:" + Z, Object.assign(sbook(X, "A Version"), { layer: upstream }));
  const vers = new Map(await oLib.holder.versions());
  assert.ok(vers.has("book:" + Z) && vers.has("entry:" + Z), "the version is published: its details, and in the catalog");
  // as a reader reads it: the layer keeps the read key
  const sReader = Share.followStore(Share.memoryAdapter());
  await sReader.addLink(Library.parseLink(Library.libraryLink("https://site.dev/", share.libId, share.readKey)));
  const rR = Share.createRooms({ log: () => {} });
  const fR = rR.join(share.libRoom, Share.follower({ store: sReader, libId: share.libId, scope: "lib" }), { network: false });
  link(oLib, fR);
  await waitFor(async () => !!(await sReader.get(share.libId, "entry:" + Z)), "the version in the catalog");
  assert.deepStrictEqual((await sReader.body(share.libId, "entry:" + Z)).layer, upstream, "its layer carries the upstream library's read key");
  await fR.open(Z);
  await waitFor(async () => !!(await sReader.get(share.libId, "book:" + Z)), "the version's details");
  assert.deepStrictEqual((await sReader.body(share.libId, "book:" + Z)).layer, upstream);
  rR.stop();

  ownerRooms.stop(); r1.stop(); r2.stop();
  console.log("OK — a library's room carries all of it");
})().catch((e) => { console.error(e); process.exit(1); });
