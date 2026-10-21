// Chapters on demand (p2p-core.js, getConfig().fetch === "open"): a phone with a big library learns of every chapter (the index) but fetches
// only the ones asked for (request(), as the reader and its read-ahead do), and newer versions of the ones it holds; a device fetching "all"
// gets every one, as before. No network: the devices are linked directly and send chapters over that link.
// Run: node test/fetch-on-demand.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const testLibrary = require("./test-library.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(40);
  }
  throw new Error("timed out waiting for: " + what);
}
function memAdapter(fetch, chapters = {}) {
  let index = {};
  const store = new Map(Object.entries(chapters));
  return {
    store,
    getConfig: async () => ({ enabled: true, passphrase: "on demand test", trackers: ["ws://127.0.0.1:1"], fetch }),
    getIndex: async () => index,
    setIndex: async (i) => { index = i; },
    getTranslation: async (k) => store.get(k),
    setTranslation: async (k, e) => { store.set(k, e); },
    listTranslations: async () => [...store.entries()].map(([k, e]) => [k, { savedAt: e.savedAt, translated: !!e.translated }])
  };
}
const url = (n) => "translation:https://example.com/novel/chapter-" + n;
const chapter = (n, savedAt = 1000 + n) => ({ translated: "Text of chapter " + n, savedAt, model: "test", pageTitle: "Chapter " + n, novelName: "Novel" });

(async () => {
  const common = { WebTorrent, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {}, library: testLibrary() }; // (one library: protocol 10 talks chapters only between its devices)
  const clone = (m) => JSON.parse(JSON.stringify(m));
  function link(x, y) {
    const h = {};
    h.x = x.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) });
    h.y = y.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) });
    return h;
  }

  const laptopA = memAdapter("all", { [url(1)]: chapter(1), [url(2)]: chapter(2), [url(3)]: chapter(3) });
  const laptop = createP2P({ ...common, adapter: laptopA, role: "extension" });
  // the phone already holds an old copy of chapter 3
  const phoneA = memAdapter("open", { [url(3)]: chapter(3, 500) });
  const phone = createP2P({ ...common, adapter: phoneA, role: "site" });
  const desk = memAdapter("all");
  const desktop = createP2P({ ...common, adapter: desk, role: "site" });
  await laptop.start();
  await phone.start();
  await desktop.start();
  await waitFor(() => Object.keys(laptop.getIndex()).length === 3, "the laptop to index its chapters");
  link(laptop, phone);
  link(laptop, desktop);

  await waitFor(() => Object.keys(phone.getIndex()).length === 3, "the phone to learn of every chapter");
  assert.strictEqual(phone.status().fetch, "open");
  // the newer version of the chapter it holds comes; the others do not
  await waitFor(async () => (await phoneA.getTranslation(url(3))).savedAt === 1003, "the newer chapter 3");
  await sleep(600);
  assert.ok(!phoneA.store.has(url(1)) && !phoneA.store.has(url(2)), "nothing it did not ask for");

  // the reader opens chapter 1
  phone.request(url(1));
  await waitFor(() => phoneA.store.has(url(1)), "chapter 1, asked for");
  await sleep(400);
  assert.ok(!phoneA.store.has(url(2)), "still not chapter 2");

  // a device fetching all of them gets all of them
  await waitFor(() => desk.store.size === 3, "every chapter on the desktop");

  // switched to "all" without restarting: the rest comes
  phone.setFetch("all");
  await waitFor(() => phoneA.store.has(url(2)), "chapter 2 after switching to all");

  // ---- a version nobody connected has (the device with it went offline): it is not shown as on its way, and is asked for less and less often ----
  assert.deepStrictEqual([1, 2, 3, 4, 10].map(globalThis.P2PCore.reaskAfter), [5000, 120000, 240000, 480000, 3600000], "5 s, then 2 minutes, doubling, at most an hour");
  const holderA = memAdapter("all", { [url(20)]: chapter(20) });
  const holder = createP2P({ ...common, adapter: holderA, role: "extension" });
  const readerA = memAdapter("open");
  const reader = createP2P({ ...common, adapter: readerA, role: "site" });
  await holder.start();
  await reader.start();
  await waitFor(() => !!holder.getIndex()[url(20)], "the holder indexes its chapter");
  const hl = link(holder, reader);
  await waitFor(() => !!reader.getIndex()[url(20)], "the reader learns of it");
  hl.x.close(); // the device that has it goes away
  hl.y.close();
  const gets = [];
  const h2 = {};
  h2.x = reader.addLocalPeer({ send: (m) => { if (m.t === "get") gets.push(m.k); setImmediate(() => h2.y && h2.y.receive(clone(m))); } });
  h2.y = laptop.addLocalPeer({ send: (m) => setImmediate(() => h2.x && h2.x.receive(clone(m))) }); // (the laptop is still here, without chapter 20)
  await sleep(300);
  reader.request(url(20)); // opened by a person: asked for at once
  await waitFor(() => gets.includes(url(20)), "the reader asks the devices connected");
  await sleep(600);
  assert.deepStrictEqual(reader.activity().rows.map((r) => r.key), [], "nobody answered: nothing is shown as on its way");
  assert.ok(!readerA.store.has(url(20)));
  for (const c of [holder, reader]) c.stop();

  for (const c of [laptop, phone, desktop]) c.stop();
  console.log("OK — chapters on demand");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
