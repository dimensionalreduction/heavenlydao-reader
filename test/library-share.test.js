// Sharing a library (src/shared/library.js, docs/SHARED-LIBRARIES.md step 2): the read key and what comes from it, links, records for readers
// and how a reader checks them, the novels shared, and removing a device (a new owner key that the removed device never gets).
// Run: node test/library-share.test.js
const assert = require("assert");
const Library = require("../src/shared/library.js");

(async () => {
  // ---- three devices of one library ----
  const A = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  const B = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Phone" });
  const C = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Old tablet" });
  await A.create();
  const all = [A, B, C];
  const outbox = new Map(all.map((d) => [d, []]));
  for (const d of all) d.on("records", (rs) => outbox.get(d).push(...rs));
  // everything written goes to every other device (twice over, as a room would, so what was refused for now is taken later)
  async function settle() {
    for (let round = 0; round < 4; round++) {
      const sent = all.map((d) => [d, outbox.get(d).splice(0)]);
      for (const [from, rs] of sent) for (const to of all) if (to !== from) for (const r of rs) await to.receive(r);
      for (const d of all) for (const to of all) if (to !== d) for (const [k] of d.versions()) { const r = d.get(k); if (to.wants(k, r.ver)) await to.receive(r); }
    }
  }
  for (const X of [B, C]) {
    A.joinAsked(X.joinRequest());
    const { keys } = await A.allow(X.status().device.id);
    await X.receiveKeys(keys);
  }
  await settle();
  assert.ok(all.every((d) => d.status().state === "member"));
  assert.ok(A.get("dh:" + B.status().device.id) && A.get("dh:" + C.status().device.id), "every device said its X25519 key");

  // ---- the owner's own records outside the API: the profile, the novels shared ----
  assert.deepStrictEqual(await A.put("profile", { name: "Supun's novels" }), { changed: true });
  assert.deepStrictEqual(await A.put("profile", { name: "Supun's novels" }), { changed: false }, "the same again changes nothing");
  const book = { title: "Synthesis Wizard", author: "Someone", chapters: [[1, "Chapter 1", "translation:https://wtr-lab.com/en/novel/8053/w/chapter-1", 1000], [2, "Chapter 2", "translation:https://wtr-lab.com/en/novel/8053/w/chapter-2", 2000]] };
  await B.put("sbook:wtr-lab:8053", book);
  await assert.rejects(B.put("settings", {}), /not something to put/);
  await settle();
  assert.strictEqual(A.profile().name, "Supun's novels");
  assert.strictEqual(C.status().name, "Supun's novels");
  assert.deepStrictEqual(Object.keys(A.sharedBooks()), ["wtr-lab:8053"], "a novel shared on one device is shared on all");
  assert.ok(Array.isArray(A.sharedBook("wtr-lab:8053").ver), "with the version it was written at");
  // your version of someone's novel, and how you use another library's edition: on every device too
  await B.put("layer:wtr-lab:5045", { lib: "x".repeat(43), bookKey: "k".repeat(43), book: "wtr-lab:5045", title: "Theirs", chapters: { "https://a/1": "translation:https://b/1" } });
  await A.put("edition:wtr-lab:8053", { modes: { ["y".repeat(43)]: "notify" }, asked: {} });
  await settle();
  assert.strictEqual(A.layers()["wtr-lab:5045"].chapters["https://a/1"], "translation:https://b/1");
  assert.strictEqual(C.editions()["wtr-lab:8053"].modes["y".repeat(43)], "notify");

  // ---- the read key, the keys and rooms that come from it, links ----
  const share = await A.share();
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(share.readKey) && /^[0-9a-f]{64}$/.test(share.libRoom));
  await settle();
  assert.strictEqual(B.shareNow().readKey, share.readKey, "every device has the same read key");
  const bookKey = await Library.bookKeyOf(share.readKey, "wtr-lab:8053");
  assert.notStrictEqual(bookKey, await Library.bookKeyOf(share.readKey, "wtr-lab:1"), "each book has its own key");
  assert.notStrictEqual(await Library.bookRoomOf(share.libId, bookKey), share.libRoom);
  const link = Library.libraryLink("https://p2p-library.pages.dev/#/settings", share.libId, share.readKey);
  assert.strictEqual(link, "https://p2p-library.pages.dev/#/f/" + share.libId + "/" + share.readKey);
  assert.deepStrictEqual(Library.parseLink(link), { libId: share.libId, readKey: share.readKey });
  const blink = Library.bookLink("https://x.dev/", share.libId, "wtr-lab:8053", bookKey);
  assert.deepStrictEqual(Library.parseLink(blink), { libId: share.libId, bookId: "wtr-lab:8053", bookKey });
  assert.strictEqual(Library.parseLink("https://x.dev/#/f/short/key"), null);
  // a book link may end with its title as words, only to read: it opens the same book with them, without them, or with other words
  const titled = Library.bookLink("https://x.dev/", share.libId, "wtr-lab:8053", bookKey, "Synthesis Wizard: The Rise!");
  assert.ok(titled.endsWith("/b/wtr-lab:8053/" + bookKey + "/synthesis-wizard-the-rise"), titled);
  assert.deepStrictEqual(Library.parseLink(titled), { libId: share.libId, bookId: "wtr-lab:8053", bookKey });
  assert.deepStrictEqual(Library.parseLink(titled.replace(/[a-z-]+$/, "other-words")), { libId: share.libId, bookId: "wtr-lab:8053", bookKey });
  assert.deepStrictEqual(Library.parseLink("https://x.dev/#/f/" + share.libId + "/b/wtr-lab%3A8053/" + bookKey), { libId: share.libId, bookId: "wtr-lab:8053", bookKey }, "a link from before (the id encoded)");
  assert.ok(!/\/$/.test(Library.bookLink("https://x.dev/", share.libId, "x", bookKey, "金丹是恒星")), "a title with no Latin words adds nothing");

  // ---- records for readers, as a reader checks them ----
  const devicesRecord = A.get("devices");
  const { catalogKey } = share;
  const entry = await B.makePublished("entry:wtr-lab:8053", [5, 0, ""], { title: "Synthesis Wizard" }, catalogKey);
  const chapter = await B.makePublished("chapter:https://wtr-lab.com/en/novel/8053/w/chapter-1", [1000, 0, ""], { translated: "Text one" }, bookKey);
  const profile = await A.makePublished("profile", [1, 0, ""], { name: "Supun's novels" });
  assert.ok(!/Synthesis|Text one/.test(entry.body + chapter.body), "encrypted");
  const dev = await Library.readPublished(devicesRecord, { lib: share.libId });
  assert.ok(Array.isArray(dev.body), "the list of devices, signed with the library's root key");
  const reader = { lib: share.libId, devices: dev.body, keyOf: (k) => (k.startsWith("chapter:") || k.startsWith("book") ? bookKey : catalogKey) };
  assert.deepStrictEqual((await Library.readPublished(entry, reader)).body, { title: "Synthesis Wizard" });
  assert.deepStrictEqual((await Library.readPublished(chapter, reader)).body, { translated: "Text one" });
  assert.deepStrictEqual((await Library.readPublished(profile, reader)).body, { name: "Supun's novels" }, "the profile is plain");
  // a reader with only the book's key (a book link) reads the chapter and not the catalog
  const bookOnly = { lib: share.libId, devices: dev.body, keyOf: (k) => (k.startsWith("chapter:") || k.startsWith("book") ? bookKey : null) };
  assert.strictEqual((await Library.readPublished(entry, bookOnly)).why, "no key");
  assert.ok((await Library.readPublished(chapter, bookOnly)).body);
  // what must be refused
  assert.strictEqual((await Library.readPublished(Object.assign({}, chapter, { ver: [1001, 0, ""] }), reader)).why, "bad signature");
  assert.strictEqual((await Library.readPublished(Object.assign({}, chapter, { lib: "other" }), reader)).why, "malformed");
  assert.strictEqual((await Library.readPublished(await B.makePublished("settings", [1, 0, ""], {}, catalogKey), reader)).why, "unknown kind");
  const stranger = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Stranger" });
  await stranger.create();
  const forged = Object.assign({}, await stranger.makePublished("chapter:x", [1, 0, ""], { translated: "fake" }, bookKey), { lib: share.libId });
  assert.strictEqual((await Library.readPublished(forged, reader)).why, "not a device of this library");

  // ---- removing a device: a new owner key, which it never gets ----
  const cId = C.status().device.id;
  await assert.rejects(B.removeDevice(cId), /only the main device/);
  const removed = await A.removeDevice(cId, { newLink: true });
  assert.deepStrictEqual(removed.missed, [], "every remaining device was sent the new key");
  await A.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:8053"), { title: "Written after the removal" });
  await settle();
  assert.strictEqual(B.status().state, "member");
  assert.strictEqual(C.status().state, "removed");
  assert.deepStrictEqual((await B.api("GET", "/api/novels")).novels.map((n) => n.title), ["Written after the removal"], "B reads what is written with the new key");
  assert.notStrictEqual(B.shareNow().readKey, share.readKey, "and has the new read key: the old links get nothing new");
  await assert.rejects(C.api("GET", "/api/novels"), /removed/);
  // C cannot read a record written with the new key
  const newRecord = A.get("novel:wtr-lab:8053");
  assert.ok(newRecord.kg >= 1);
  // B writes with the new key too, and A takes it
  await B.api("PUT", "/api/term-notes", { source: "科雷", keys: ["wtr-lab:8053"], text: "after" });
  await settle();
  assert.strictEqual((await A.api("GET", "/api/term-notes")).notes[0].text, "after");
  // what C writes now is refused by the others
  const cWrites = await C.makePublished("chapter:y", [1, 0, ""], { translated: "x" }, bookKey);
  const devNow = await Library.readPublished(A.get("devices"), { lib: share.libId });
  assert.strictEqual((await Library.readPublished(cWrites, { lib: share.libId, devices: devNow.body, keyOf: () => bookKey })).why, "not a device of this library", "readers refuse what the removed device publishes");

  // the removed device asks again (its old library goes), the main device lets it in, and it reads the library as a new member
  await C.abandon();
  assert.strictEqual(C.status().state, "joining");
  assert.strictEqual(C.status().libId, "", "it holds nothing of the old library");
  A.joinAsked(C.joinRequest());
  await C.receiveKeys((await A.allow(cId)).keys);
  await settle();
  assert.strictEqual(C.status().state, "member", "removed, asked again, let in");
  assert.deepStrictEqual((await C.api("GET", "/api/novels")).novels.map((n) => n.title), ["Written after the removal"]);

  // a device let in after the removal gets every key generation, so it reads the old records too
  const D = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "New phone" });
  all.push(D);
  outbox.set(D, []);
  D.on("records", (rs) => outbox.get(D).push(...rs));
  A.joinAsked(D.joinRequest());
  await D.receiveKeys((await A.allow(D.status().device.id)).keys);
  await settle();
  assert.strictEqual(D.status().state, "member");
  assert.deepStrictEqual((await D.api("GET", "/api/novels")).novels.map((n) => n.title), ["Written after the removal"]);
  assert.strictEqual(D.profile().name, "Supun's novels");

  // a refused device is listed with its name and not shown when it asks again, until it is taken off the list
  const E = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Tablet" });
  all.push(E);
  const eId = E.status().device.id;
  assert.strictEqual(A.joinAsked(E.joinRequest()), true);
  await A.refuse(eId);
  assert.deepStrictEqual(A.status().refused, [{ id: eId, name: "Tablet" }]);
  assert.deepStrictEqual(B.status().refused, [], "only the main device has the list");
  assert.strictEqual(A.joinAsked(E.joinRequest()), false, "refused: not shown again");
  assert.deepStrictEqual(A.status().joins, []);
  await A.unrefuse(eId);
  assert.deepStrictEqual(A.status().refused, []);
  assert.strictEqual(A.joinAsked(E.joinRequest()), true, "off the list: it is shown again");
  assert.deepStrictEqual(A.status().joins.map((j) => j.name), ["Tablet"]);

  console.log("OK — library sharing checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
