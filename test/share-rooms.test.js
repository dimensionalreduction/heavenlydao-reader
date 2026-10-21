// Sharing a library with readers (src/shared/share-rooms.js): what readers fetch, from whom, and what they cannot read.
//   a reader with the library's link sees its list of novels without fetching any chapter; opening a novel fetches only that novel; a second
//   reader gets a chapter from the first with the owner offline; a book link opens that book and no other; after "a new link" the old link's
//   reader cannot read what is published. Then the same over real WebTorrent connections on localhost.
// Run: node test/share-rooms.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
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
// Two rooms (the same room on two devices) linked directly, as if connected.
function link(a, b) {
  const h = {};
  h.a = a.link((m) => setImmediate(() => h.b && h.b.receive(clone(m))));
  h.b = b.link((m) => setImmediate(() => h.a && h.a.receive(clone(m))));
  return () => { h.a.close(); h.b.close(); h.a = null; h.b = null; };
}

(async () => {
  // ---- the owner: a library with two novels shared, and the chapters this device holds ----
  const owner = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  await owner.create();
  await owner.put("profile", { name: "Supun's novels" });
  const X = "wtr-lab:8053";
  const Y = "69shuba.com/txt/1";
  const url = (b, n) => (b === X ? "https://wtr-lab.com/en/novel/8053/w/chapter-" + n : "https://www.69shuba.com/txt/1/" + n);
  const chapters = new Map();
  for (const b of [X, Y]) for (let n = 1; n <= 3; n++) chapters.set("translation:" + url(b, n), { translated: "Text of " + b + " #" + n, pageTitle: "Chapter " + n, novelName: b, savedAt: 1000 + n, model: "m" });
  const sbook = (b, title) => ({ title, author: "Someone", coverId: b === X ? X : "", chapters: [1, 2, 3].map((n) => [n, "Chapter " + n, "translation:" + url(b, n), 1000 + n]) });
  await owner.put("sbook:" + X, Object.assign(sbook(X, "Synthesis Wizard"), { keys: [X] }));
  await owner.api("PUT", "/api/my-terms/term1", { from: ["Corey"], to: "Kory", keys: [X], novel: "Synthesis Wizard" });
  await owner.api("PUT", "/api/my-terms/term2", { from: ["Lord"], to: "Liege" }); // (for every novel)
  await owner.api("PUT", "/api/my-terms/term3", { from: ["Elsewhere"], to: "Other", keys: ["69shuba.com/txt/9"] }); // (another novel's)
  await owner.api("POST", "/api/glossaries/" + encodeURIComponent(X) + "/import", { name: "wizard", site: "wtr-lab", rawId: "8053", slug: "w", terms: [["科雷", "Corey"], ["道", "Dao", { o: "shared:Cultivation" }]] });
  await owner.api("POST", "/api/glossaries/" + encodeURIComponent(X + "@es") + "/add", { name: "wizard (es)", terms: [["科雷", "Corey"]] });
  await owner.put("sbook:" + Y, sbook(Y, "Another Novel"));
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const getChapter = async (k) => chapters.get(k) || null;
  const getCover = async (id) => (id === X ? { type: "image/png", bytes: PNG, at: 50 } : null);
  let share = await owner.share();
  const roomsOf = async (s) => ({ lib: s.libRoom, [X]: await Library.bookRoomOf(s.libId, await Library.bookKeyOf(s.readKey, X)), [Y]: await Library.bookRoomOf(s.libId, await Library.bookKeyOf(s.readKey, Y)) });
  let R = await roomsOf(share);
  const sentLog = []; // (what the owner sent readers: [key, bytes, book])
  const ownerRooms = Share.createRooms({ log: () => {}, onSent: (roomId, key, bytes, bookId) => sentLog.push([key, bytes, bookId]) });
  const listChapters = async () => new Map([...chapters.entries()].map(([k, e]) => [k, e.savedAt]));
  const pub = (scope, bookId) => Share.publisher({ lib: owner, scope, bookId, getChapter, listChapters, getCover });
  const oLib = ownerRooms.join(R.lib, pub("lib"), { network: false });
  const oX = ownerRooms.join(R[X], pub("book", X), { network: false });

  // ---- reader 1 follows the whole library ----
  const s1 = Share.followStore(Share.memoryAdapter());
  const libLink = Library.parseLink(Library.libraryLink("https://site.dev/", share.libId, share.readKey));
  await s1.addLink(libLink);
  const r1 = Share.createRooms({ log: () => {} });
  const f1Lib = r1.join(R.lib, Share.follower({ store: s1, libId: share.libId, scope: "lib" }), { network: false });
  const cut1 = link(oLib, f1Lib);
  await waitFor(async () => (await s1.list(share.libId, "entry:")).length === 2 && !!(await s1.get(share.libId, "head")) && (await s1.follow(share.libId)).name, "the list of novels");
  assert.deepStrictEqual((await s1.body(share.libId, "head")).books[X].n, 3);
  assert.strictEqual((await s1.body(share.libId, "entry:" + X)).title, "Synthesis Wizard");
  assert.strictEqual((await s1.follow(share.libId)).name, "Supun's novels", "the follow is named after the library");
  assert.strictEqual((await s1.list(share.libId, "chapter:")).length, 0, "no chapter fetched for the list");
  assert.strictEqual(await s1.get(share.libId, "cover:" + X), null, "nor a cover, until it is shown");
  const cover = await f1Lib.fetch("cover:" + X);
  assert.ok(cover && (await s1.body(share.libId, "cover:" + X)).type === "image/png", "a cover when it is asked for");

  // ---- reader 1 opens one novel: only that novel comes ----
  const f1X = r1.join(R[X], Share.follower({ store: s1, libId: share.libId, scope: "book", bookId: X }), { network: false });
  const cut1x = link(oX, f1X);
  await waitFor(async () => !!(await s1.get(share.libId, "bhead:" + X)), "the novel's list of chapters");
  assert.strictEqual((await s1.list(share.libId, "chapter:")).length, 0, "opening the novel fetches its list, no chapter yet");
  await waitFor(async () => !!(await s1.get(share.libId, "terms:" + X)), "the owner's terms for the novel");
  assert.deepStrictEqual((await s1.body(share.libId, "terms:" + X)).terms.map((t) => t.to).sort(), ["Kory", "Liege"], "this novel's terms and those for every novel, not another novel's");
  // and the novel's glossary, in each language it has one, each term with its list: what a reader who copies the novel is given
  const sentGlossary = (await s1.body(share.libId, "terms:" + X)).glossary;
  assert.strictEqual(sentGlossary.v, 1, "with a version, for a reader that may meet a newer one");
  assert.deepStrictEqual(Object.keys(sentGlossary.langs).sort(), ["en", "es"]);
  assert.deepStrictEqual(sentGlossary.langs.en.slice().sort(), [["科雷", "Corey", "novel"], ["道", "Dao", "shared:Cultivation"]].sort());
  const ch1 = await f1X.fetch("chapter:" + url(X, 1));
  assert.ok(ch1);
  assert.strictEqual((await s1.body(share.libId, "chapter:" + url(X, 1))).translated, "Text of " + X + " #1", "a chapter when it is read");
  assert.strictEqual(await s1.get(share.libId, "bhead:" + Y), null, "nothing of the other novel");
  assert.ok(await f1X.fetch("bcover:" + X), "the novel's cover from its own room (for a reader with only its link)");
  assert.strictEqual((await s1.body(share.libId, "bcover:" + X)).type, "image/png");
  // what was sent is counted, with its novel; and the reader is one of the novel's peers (in its own room, and in the library's)
  const sentCh = sentLog.find(([k]) => k === "chapter:" + url(X, 1));
  assert.ok(sentCh && sentCh[1] > 0 && sentCh[2] === X, "a chapter sent is counted, as its novel's");
  assert.ok(sentLog.some(([k, , b]) => k === "head" && b === ""), "the library's list, as the library's");
  assert.deepStrictEqual(oX.peerBooks().map((d) => d.books), [[X]], "the novel's room: its reader, as that novel's peer");
  assert.strictEqual(oLib.peerBooks().length, 1, "and in the library room, as the library's peer");
  // what is held, by size: read once, then kept as records are put and deleted
  const sz = await s1.sizesOf(share.libId);
  assert.ok(sz.get("chapter:" + url(X, 1)) > 0 && sz.has("bhead:" + X), "the sizes of what is held");
  await s1.put(share.libId, "chapter:extra", { r: { key: "chapter:extra", ver: [1, 0, ""] }, body: { translated: "x" } });
  assert.ok((await s1.sizesOf(share.libId)).get("chapter:extra") > 0, "a record put is counted");
  await s1.del(share.libId, "chapter:extra");
  assert.ok(!(await s1.sizesOf(share.libId)).has("chapter:extra"), "and one deleted no longer");
  const t = Share.sentTally({ load: () => null, save: () => {} });
  t.add("L", X, 100); t.add("L", "", 20); t.add("L", X, 5);
  assert.deepStrictEqual({ total: t.get("L").total, books: t.get("L").books }, { total: 125, books: { [X]: 105 } }, "the tally: in all, and by novel");
  assert.strictEqual(t.todayOf("L"), 125, "and today");

  // ---- the owner goes offline; reader 2, with a link to novel X only, gets chapter 1 from reader 1 ----
  cut1();
  cut1x();
  const s2 = Share.followStore(Share.memoryAdapter());
  const bookKey = await Library.bookKeyOf(share.readKey, X);
  await s2.addLink(Library.parseLink(Library.bookLink("https://site.dev/", share.libId, X, bookKey)));
  assert.strictEqual(await s2.catalogKey(share.libId), null, "a book link gives no catalog key");
  assert.strictEqual(await s2.bookKey(share.libId, Y), null, "nor another novel's key");
  const r2 = Share.createRooms({ log: () => {} });
  const f2X = r2.join(R[X], Share.follower({ store: s2, libId: share.libId, scope: "book", bookId: X }), { network: false });
  link(f1X, f2X);
  await waitFor(async () => !!(await s2.get(share.libId, "bhead:" + X)), "the list, from reader 1");
  await waitFor(async () => !!(await f2X.fetch("chapter:" + url(X, 1))), "chapter 1 from reader 1, the owner offline");
  assert.strictEqual((await s2.body(share.libId, "chapter:" + url(X, 1))).translated, "Text of " + X + " #1");
  assert.strictEqual(await f2X.fetch("chapter:" + url(X, 2)), null, "chapter 2: nobody online has it");
  // a book link's reader holds nothing of the catalog even if a catalog record reaches it
  const strayEntry = await owner.makePublished("entry:" + Y, [9, 0, ""], { title: "Another Novel" }, share.catalogKey);
  assert.strictEqual((await f2X.holder.receive(strayEntry)).why, "not of this room");

  // ---- the owner is back, then makes a new link: what is published can no longer be read with the old one ----
  link(oX, f1X);
  await waitFor(async () => !!(await f1X.fetch("chapter:" + url(X, 2))), "chapter 2 from the owner");
  share = await owner.share(true);
  const R2 = await roomsOf(share);
  assert.notStrictEqual(R2.lib, R.lib, "a new link: new rooms");
  assert.notStrictEqual(R2[X], R[X]);
  // (the owner's devices leave the old rooms; even a record made with the new keys and given in the old room cannot be read with the old link)
  await owner.put("sbook:" + X, Object.assign(sbook(X, "Synthesis Wizard (new title)")));
  const newEntry = await oLib.holder.get("entry:" + X);
  assert.strictEqual((await f1Lib.holder.receive(newEntry)).why, "cannot be read", "the old link's reader cannot read it");
  assert.strictEqual((await s1.body(share.libId, "entry:" + X)).title, "Synthesis Wizard", "and keeps what it had");

  // ---- the owner's device publishing: the rooms it is in follow what is shared ----
  const pubRooms = Share.createRooms({ log: () => {} });
  const publishing = Share.publishing({ lib: owner, rooms: pubRooms, getChapter, listChapters, getCover, maxBookRooms: 1, rotateMs: 60000 });
  await publishing.update();
  const shown = () => publishing.rooms().map((r) => r.scope + (r.bookId ? ":" + r.bookId : "")).sort();
  assert.deepStrictEqual(shown(), ["book:" + Y, "lib"], "the library room, and one novel's room (at most 1 here; the first by id)");
  await owner.put("sbook:" + Y, null);
  await waitFor(() => shown().join() === ["book:" + X, "lib"].join(), "a novel no longer shared: its room is left, the other's joined");
  await owner.put("sbook:" + Y, sbook(Y, "Another Novel"));
  await publishing.update();
  publishing.stop();
  assert.deepStrictEqual(publishing.rooms(), []);

  // ---- over real WebTorrent connections (localhost, no trackers) ----
  const clients = [];
  class TrackedClient extends WebTorrent {
    constructor(o) { super(o); clients.push(this); }
    add(...args) {
      const t = super.add(...args);
      setTimeout(() => { if (!t.destroyed) for (const c of clients) if (c !== this && c.torrentPort) t.addPeer("127.0.0.1:" + c.torrentPort); }, 300);
      return t;
    }
  }
  const real = { WebTorrent: TrackedClient, trackers: ["ws://127.0.0.1:1"], makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {} };
  const wOwner = Share.createRooms(real);
  const wReader = Share.createRooms(real);
  const s3 = Share.followStore(Share.memoryAdapter());
  await s3.addLink({ libId: share.libId, readKey: share.readKey });
  wOwner.join(R2.lib, pub("lib"));
  wOwner.join(R2[X], pub("book", X));
  const w3Lib = wReader.join(R2.lib, Share.follower({ store: s3, libId: share.libId, scope: "lib" }));
  const w3X = wReader.join(R2[X], Share.follower({ store: s3, libId: share.libId, scope: "book", bookId: X }));
  await waitFor(async () => (await s3.list(share.libId, "entry:")).length === 2, "the list of novels over a real connection", 30000);
  assert.strictEqual((await s3.body(share.libId, "entry:" + X)).title, "Synthesis Wizard (new title)");
  await waitFor(async () => !!(await s3.get(share.libId, "bhead:" + X)), "the novel's list over a real connection", 30000);
  await waitFor(async () => !!(await w3X.fetch("chapter:" + url(X, 3))), "a chapter over a real connection", 30000);
  assert.ok(w3Lib.peers().length >= 1);
  wOwner.stop();
  wReader.stop();

  console.log("OK — share rooms checks passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
