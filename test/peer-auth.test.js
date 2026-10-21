// Who may do what in the passphrase room (p2p-core.js, protocol 10): only the library's own devices talk chapters with each other: what they
// hold, entries, texts, and setting each other fetching and translating ("raw"). A device with only the passphrase, or of another library,
// learns nothing and sets nothing working; a device in no library takes nothing from anyone. A chapter's text is taken only when it is the
// one its index entry names, and a device passing a member's messages on cannot add its own or send them again.
// No network: the devices are linked directly. Run: node test/peer-auth.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const Library = require("../src/shared/library.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(40);
  }
  throw new Error("timed out waiting for: " + what);
}
function memAdapter(chapters = {}, fetch = "all") {
  let index = {};
  const store = new Map(Object.entries(chapters));
  return {
    store,
    getConfig: async () => ({ enabled: true, passphrase: "peer auth test", trackers: ["ws://127.0.0.1:1"], fetch }),
    getIndex: async () => index,
    setIndex: async (i) => { index = i; },
    getTranslation: async (k) => store.get(k),
    setTranslation: async (k, e) => { store.set(k, e); },
    listTranslations: async () => [...store.entries()].map(([k, e]) => [k, { savedAt: e.savedAt, translated: !!e.translated }])
  };
}
const url = (n) => "translation:https://example.com/novel/chapter-" + n;
const chapter = (n, text = "Text of chapter " + n, savedAt = 1000 + n) => ({ translated: text, savedAt, model: "test", pageTitle: "Chapter " + n, novelName: "Novel" });
const clone = (m) => JSON.parse(JSON.stringify(m));

(async () => {
  const common = { WebTorrent, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {} };
  // A device: its chapters, its library (none: it only has the passphrase) and the "raw" requests it was asked to do.
  async function device(name, chapters, { library = true, fetch } = {}) {
    const adapter = memAdapter(chapters, fetch);
    const lib = library ? await Library.open({ adapter: Library.memoryAdapter(), deviceName: name }) : null;
    const raws = [];
    const core = createP2P({ ...common, adapter, role: "device", library: lib ? Library.roomLink(lib) : undefined, onRawRequest: async (k) => { raws.push(k); } });
    if (lib) lib.on("records", (rs) => core.announceRecords(rs));
    await core.start();
    return { name, adapter, lib, core, raws };
  }
  // x <-> y; what y sends x passes `tap` first (a device in between: it sees it, and may hold it back), and inject() sends x anything.
  function link(x, y, tap = () => true) {
    const h = {};
    h.x = x.core.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) });
    h.y = y.core.addLocalPeer({ send: (m) => setImmediate(() => h.x && tap(m) && h.x.receive(clone(m))) });
    h.inject = (m) => h.x.receive(clone(m));
    return h;
  }

  // ---- the laptop (the main device) and the phone, let in ----
  const laptop = await device("Laptop", { [url(1)]: chapter(1) });
  const phone = await device("Phone", { [url(2)]: chapter(2) });
  await laptop.lib.create();
  const fromPhone = [];
  const relay = link(laptop, phone, (m) => { fromPhone.push(clone(m)); return true; });
  phone.lib.joinRequest();
  phone.core.askToJoin();
  await waitFor(() => laptop.lib.status().joins.length === 1, "the phone's request");
  laptop.core.sendKeys((await laptop.lib.allow(laptop.lib.status().joins[0].id)).keys);
  await waitFor(() => phone.lib.status().state === "member", "the phone to be in the library");

  // a device of the library sends chapters, and sets the laptop to work
  await waitFor(() => laptop.adapter.store.has(url(2)), "the phone's chapter on the laptop, once it is a device of the library");
  await waitFor(() => phone.adapter.store.has(url(1)), "the laptop's chapter on the phone");
  phone.core.requestRaw(url(5), { translate: true });
  await waitFor(() => laptop.raws.includes(url(5)), "the phone's request to fetch chapter 5");
  assert.ok(fromPhone.some((m) => m.t === "pf"), "the phone proved it is a device of the library");
  assert.ok(fromPhone.filter((m) => m.t === "ent" || m.t === "raw").every((m) => typeof m.m === "string" && Number.isInteger(m.q)), "and signed what only a device of it may send");

  // ---- whoever is in between cannot send the laptop anything of its own, nor send it the phone's again ----
  const raw = fromPhone.filter((m) => m.t === "raw").pop();
  relay.inject(raw); // the same message again
  relay.inject(Object.assign(clone(raw), { k: url(6), q: raw.q + 1 })); // another chapter, under the phone's signature
  relay.inject({ t: "raw", k: url(7), tr: true }); // unsigned
  const ent = fromPhone.filter((m) => m.t === "ent").pop();
  const forgedEntry = Object.assign(clone(ent.e[0]), { key: url(8), savedAt: 9e12 });
  relay.inject(Object.assign(clone(ent), { e: [forgedEntry], q: ent.q + 100 }));
  relay.inject({ t: "ent", e: [forgedEntry] });
  await sleep(500);
  assert.deepStrictEqual(laptop.raws, [url(5)], "only the phone's own request, once");
  assert.ok(!laptop.core.getIndex()[url(8)], "no chapter entry from the device in between");
  phone.core.requestRaw(url(9));
  await waitFor(() => laptop.raws.includes(url(9)), "the phone's next request still taken");

  // ---- a device with only the passphrase: learns nothing, sends nothing in, sets nothing working ----
  const stranger = await device("Stranger", { [url(3)]: chapter(3, "Not yours", 5000) }, { library: false });
  const toStranger = [];
  const hs = link(stranger, laptop, (m) => { toStranger.push(m.t); return true; });
  await sleep(1200);
  assert.strictEqual(stranger.core.requestRaw(url(10), { translate: true, retranslate: true }), 0, "the stranger has nobody to ask");

  for (const k of [url(1), url(2)]) laptop.core.request(k);
  stranger.core.request(url(1));


  await sleep(800);
  assert.ok(!stranger.adapter.store.has(url(1)) && !stranger.adapter.store.has(url(2)), "the stranger reads none of the laptop's chapters");
  assert.deepStrictEqual(Object.keys(stranger.core.getIndex()).filter((k) => k !== url(3)), [], "nor learns which chapters it has");
  assert.ok(!toStranger.some((t) => ["ver", "ent", "blob", "ar"].includes(t)), "the laptop sent it nothing of its chapters");
  assert.ok(!laptop.adapter.store.has(url(3)) && !laptop.core.getIndex()[url(3)], "the stranger's chapter is not taken");
  assert.ok(!laptop.raws.includes(url(10)), "nor its request to fetch and translate");
  assert.deepStrictEqual([laptop.core.status().peers, laptop.core.status().others], [1, 1], "the laptop counts its library's devices only: the phone (the stranger is in the room, not one of them)");
  // ...and a stranger that makes its own library is no better
  const other = await device("Other", { [url(4)]: chapter(4, "Not yours either", 5000) });
  await other.lib.create();
  link(laptop, other);
  await sleep(800);
  other.core.requestRaw(url(11));
  await sleep(800);
  assert.ok(!laptop.adapter.store.has(url(4)) && !laptop.raws.includes(url(11)), "a device of another library sends nothing in");

  // ---- a chapter's text is the one its entry names: a device answering "get" with another text is not listened to ----
  const reader = await device("Reader", {}, { fetch: "open" });
  const liar = reader.core.addLocalPeer({
    send: (m) => {
      if (m.t !== "get") return;
      const bytes = Buffer.from(JSON.stringify({ v: 1, key: m.k, entry: chapter(1, "Forged text", 9e12) }));
      setImmediate(() => liar.receive({ t: "blob", k: m.k, s: 9e12, i: 0, n: 1, d: bytes.toString("base64") }));
    }
  }, { trusted: true }); // (even one this device trusts: the text must be the one named)
  link(reader, laptop);
  reader.lib.joinRequest();
  reader.core.askToJoin();
  await waitFor(() => laptop.lib.status().joins.some((j) => j.name === "Reader"), "the reader's request");
  laptop.core.sendKeys((await laptop.lib.allow(laptop.lib.status().joins.find((j) => j.name === "Reader").id)).keys);
  await waitFor(() => reader.lib.status().state === "member", "the reader to be in the library");
  await waitFor(() => !!reader.core.getIndex()[url(1)], "the reader to learn of chapter 1");
  reader.core.request(url(1));
  await waitFor(() => reader.adapter.store.has(url(1)), "chapter 1 on the reader");
  await sleep(300);
  assert.strictEqual(reader.adapter.store.get(url(1)).translated, "Text of chapter 1", "the laptop's text, not the forged one");

  // ---- the site's tab and a new extension in one browser: the site is the library (its main device); the extension does nothing until it
  // joins, over the link between them, and then they trust each other (as app.js and p2p-host.js set the link up) ----
  const site = await device("Site", { [url(20)]: chapter(20) });
  await site.lib.create();
  const extn = await device("Extension", { [url(21)]: chapter(21) });
  const hl = {};
  hl.s = site.core.addLocalPeer({ send: (m) => setImmediate(() => hl.e && hl.e.receive(clone(m))) }, { trusted: () => extn.lib.status().state === "member" }); // (app.js: libraryVia "extension")
  hl.e = extn.core.addLocalPeer({ send: (m) => setImmediate(() => hl.s && hl.s.receive(clone(m))) }, { trusted: () => extn.lib.status().state === "member" }); // (p2p-host.js: LibraryHost.isMember)
  await sleep(1000);
  assert.ok(!extn.adapter.store.has(url(20)) && !site.adapter.store.has(url(21)), "before it joins, nothing passes either way");
  assert.strictEqual(extn.core.requestRaw(url(22)), 0, "and it is asked nothing");
  extn.lib.joinRequest();
  extn.core.askToJoin();
  await waitFor(() => site.lib.status().joins.some((j) => j.name === "Extension"), "the extension's request, on the site");
  site.core.sendKeys((await site.lib.allow(site.lib.status().joins.find((j) => j.name === "Extension").id)).keys);
  await waitFor(() => extn.lib.status().state === "member", "the extension to be in the library");
  hl.s.refresh();
  hl.e.refresh();
  await waitFor(() => extn.adapter.store.has(url(20)) && site.adapter.store.has(url(21)), "chapters both ways once it is in");
  site.core.requestRaw(url(23), { translate: true });
  await waitFor(() => extn.raws.includes(url(23)), "the site setting the extension to work");

  for (const d of [laptop, phone, stranger, other, reader, site, extn]) d.core.stop();
  console.log("OK — peer auth passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
