// Two-peer integration test for p2p-core.js over localhost (no trackers, no internet).
// Run: node test/p2p-core.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const testLibrary = require("./test-library.js");

const clients = [];
// Stand-in for the tracker: every torrent a client creates or adds gets all other clients as peers.
class TrackedClient extends WebTorrent {
  constructor(o) {
    super(o);
    clients.push(this);
  }
  add(...args) {
    const t = super.add(...args);
    this._introduce(t);
    return t;
  }
  _introduce(t) {
    setTimeout(() => {
      if (t.destroyed) return;
      for (const c of clients) if (c !== this && c.torrentPort) t.addPeer("127.0.0.1:" + c.torrentPort);
    }, 200);
  }
}

function memoryAdapter(config, seedRows = []) {
  const store = new Map(seedRows);
  let index = {};
  return {
    store,
    getConfig: async () => config,
    getIndex: async () => index,
    setIndex: async (i) => {
      index = i;
    },
    getTranslation: async (k) => store.get(k),
    setTranslation: async (k, e) => void store.set(k, e),
    listTranslations: async () => [...store.entries()].map(([k, e]) => [k, { savedAt: e.savedAt, translated: true }])
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for: " + what);
}

(async () => {
  const cfg = { enabled: true, passphrase: "correct horse battery staple", trackers: ["ws://127.0.0.1:1"] };
  const key1 = "translation:https://example.com/book/1.html";
  const key2 = "translation:https://example.com/book/2.html";
  const e1 = { translated: "Chapter one — 第一章 text", suggestions: [], savedAt: 1000, model: "m", pageTitle: "Ch 1", novelName: "Book" };
  const e2 = { translated: "Chapter two text", suggestions: [], savedAt: 2000, model: "m", pageTitle: "Ch 2", novelName: "Book" };

  const common = { WebTorrent: TrackedClient, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), library: testLibrary() }; // (one library: protocol 10 talks chapters only between its devices)
  const adA = memoryAdapter(cfg, [[key1, e1]]);
  const adB = memoryAdapter(cfg);
  const A = createP2P({ ...common, adapter: adA, log: () => {} });
  const B = createP2P({ ...common, adapter: adB, log: () => {} });

  await A.start();
  await B.start();
  const [cA, cB] = clients;
  assert.strictEqual(cA.torrents[0].infoHash, cB.torrents[0].infoHash, "room infohash must match for equal passphrase");
  assert.ok(cA.torrents[0].discovery.tracker.__offersFitted, "the room's trackers carry offers only when needed (offerOnlyWhenNeeded)");

  // A different passphrase must land in a different room.
  const adC = memoryAdapter({ ...cfg, passphrase: "another" });
  const C = createP2P({ ...common, adapter: adC, log: () => {} });
  await C.start();
  assert.notStrictEqual(clients[2].torrents[0].infoHash, cA.torrents[0].infoHash, "different passphrase, different room");
  C.stop();

  // Stand-in for tracker discovery: tell B's room torrent where A listens.
  cB.torrents[0].addPeer("127.0.0.1:" + cA.torrentPort);

  await waitFor(() => A.status().peers === 1 && B.status().peers === 1, "extension handshake");
  await waitFor(async () => adB.store.has(key1), "B to pull chapter 1 from A");
  assert.strictEqual(adB.store.get(key1).translated, e1.translated);
  assert.strictEqual(adB.store.get(key1).pageTitle, "Ch 1");

  // Live update: a new chapter saved on A shows up on B without any restart.
  adA.store.set(key2, e2);
  await A.onLocalSave(key2, e2);
  await waitFor(async () => adB.store.has(key2), "B to pull live-published chapter 2");
  assert.strictEqual(adB.store.get(key2).translated, e2.translated);

  // Devices introduce themselves, so each side can tell what it is connected to
  const devs = A.status().devices;
  assert.ok(devs.length >= 1 && devs.every((d) => d.role === "device"), "a device that did not name itself is a plain 'device'");
  assert.ok(devs.every((d) => d.v >= 5) && A.status().protocol >= 5, "and says which protocol it speaks");

  // Same chapter, same bytes, same id: the index entries on both sides agree, in the form devices from before accept (40 hex digits).
  assert.strictEqual(A.getIndex()[key1].infohash, B.getIndex()[key1].infohash);
  assert.match(A.getIndex()[key1].infohash, /^[0-9a-f]{40}$/);
  assert.ok(clients.every((c) => c.torrents.length <= 1), "no torrent of its own for a chapter: only the room's");

  // A re-translation (newer savedAt) replaces the older copy on the other peer.
  const e1b = { ...e1, translated: "Chapter one, retranslated", savedAt: 3000 };
  adA.store.set(key1, e1b);
  await A.onLocalSave(key1, e1b);
  await waitFor(async () => adB.store.get(key1).savedAt === 3000, "B to receive the newer translation");
  assert.strictEqual(adB.store.get(key1).translated, "Chapter one, retranslated");

  // Restart A with its index forgotten: it must make the same id again for unchanged chapters.
  const before = A.getIndex()[key2].infohash;
  A.stop();
  const adA2 = memoryAdapter(cfg, [...adA.store]);
  const A2 = createP2P({ ...common, adapter: adA2, log: () => {} });
  await A2.start();
  await waitFor(() => A2.getIndex()[key2], "A2 to index its chapters again");
  assert.strictEqual(A2.getIndex()[key2].infohash, before, "id stable across restart");

  // A chapter several pieces long arrives intact over the room connection.
  const key3 = "translation:https://example.com/book/3.html";
  const long = Array.from({ length: 4000 }, (_, i) => "第" + i + "行 line of a long chapter, with 中文 mixed in.").join("\n");
  const e3 = { translated: long, suggestions: [], savedAt: 4000, model: "m", pageTitle: "Ch 3", novelName: "Book" };
  const adD = memoryAdapter({ ...cfg, passphrase: "direct room" }, [[key3, e3]]);
  const adE = memoryAdapter({ ...cfg, passphrase: "direct room" });
  const D = createP2P({ ...common, adapter: adD, log: () => {} });
  const E = createP2P({ ...common, adapter: adE, log: () => {} });
  await D.start();
  await E.start();
  const [cD, cE] = clients.slice(-2);
  cE.torrents[0].addPeer("127.0.0.1:" + cD.torrentPort);
  await waitFor(async () => adE.store.has(key3), "E to receive chapter 3 directly");
  assert.strictEqual(adE.store.get(key3).translated, long, "a multi-piece chapter arrives intact");
  assert.ok(E.status().stats.direct >= 1, "it came over the direct path");
  assert.ok(Array.isArray(E.activity().rows), "activity view works");
  D.stop();
  E.stop();

  // A tracker connection waiting out its long reconnect delay is reconnected by hand while there are no peers.
  // (In node the WebRTC trackers are not active, so stand-in tracker connections with the same fields are used.)
  const adF = memoryAdapter({ ...cfg, passphrase: "kick room" });
  const F = createP2P({ ...common, adapter: adF, log: () => {}, kickMs: 100 });
  await F.start();
  const room = clients[clients.length - 1].torrents[0];
  const fake = (reconnecting) => ({ reconnecting, retries: 6, reconnectTimer: setTimeout(() => {}, 60000), opened: 0, _openSocket() { this.opened++; } });
  const waiting = fake(true);
  const connected = fake(false);
  let updates = 0;
  room.discovery = { tracker: { _trackers: [waiting, connected], update: () => void updates++ } };
  F._kick();
  assert.strictEqual(waiting.opened, 1, "a connection waiting to reconnect is reconnected now");
  assert.strictEqual(waiting.retries, 0, "and its doubling delay starts over");
  assert.strictEqual(connected.opened, 0, "a connection that is up is left alone");
  assert.strictEqual(F.status().stats.kicks, 1);
  waiting.reconnecting = true;
  F._kick();
  assert.strictEqual(waiting.opened, 1, "one tracker is not hammered: not again within three ticks");
  await sleep(450);
  F._kick();
  assert.strictEqual(waiting.opened, 2, "but again after that, if it is still down");
  connected.reconnecting = false;
  waiting.reconnecting = false;
  await sleep(900);
  F._kick();
  assert.ok(updates >= 1, "all connected and still alone: the room is announced again");
  F.stop();
  clearTimeout(waiting.reconnectTimer);
  clearTimeout(connected.reconnectTimer);

  // ---- a link between two devices in the same browser: the whole protocol over it, with no network between them ----
  const keyL = "translation:https://example.com/local/1.html";
  const eL = { translated: "Local chapter text", suggestions: [], savedAt: 7000, model: "m", pageTitle: "Local 1", novelName: "Book" };
  const adX = memoryAdapter({ ...cfg, passphrase: "room x" }, [[keyL, eL]]); // different rooms: they cannot find each other over the network
  const adY = memoryAdapter({ ...cfg, passphrase: "room y" });
  const X = createP2P({ ...common, adapter: adX, log: () => {}, role: "extension" });
  const Y = createP2P({ ...common, adapter: adY, log: () => {}, role: "site" });
  await X.start();
  await Y.start();
  const clone = (m) => JSON.parse(JSON.stringify(m)); // what a message becomes crossing the bridge
  const handles = {};
  handles.x = X.addLocalPeer({ send: (m) => setImmediate(() => handles.y && handles.y.receive(clone(m))) });
  handles.y = Y.addLocalPeer({ send: (m) => setImmediate(() => handles.x && handles.x.receive(clone(m))) });
  await waitFor(async () => adY.store.has(keyL), "the chapter to cross the local link");
  assert.strictEqual(adY.store.get(keyL).translated, "Local chapter text", "the chapter arrived intact, over the local link only");
  assert.ok(Y.status().stats.direct >= 1, "by the direct request");
  assert.deepStrictEqual(Y.status().devices.map((d) => [d.role, d.via]), [["extension", "local"]], "and the site sees one device: an extension, reached locally");
  assert.strictEqual(Y.status().peers, 1);
  assert.ok(Y.status().devices[0].id && Y.status().devices[0].id === X.id, "which names itself, so it can be told apart from the same device reached over the network");

  // a request for an original text goes to it too, and its progress comes back
  const states = [];
  const urls = [];
  const notes = [];
  const Z = createP2P({ ...common, adapter: memoryAdapter({ ...cfg, passphrase: "room z" }), log: () => {}, role: "site", onRawStatus: (k, st, info) => { states.push(st); if (info.url) urls.push(info.url); if (info.note) notes.push(info.note); } });
  let asked = null;
  const customs = [];
  let stopAsked = null;
  const W2 = createP2P({ ...common, adapter: memoryAdapter({ ...cfg, passphrase: "room w" }), log: () => {}, role: "extension", onRawRequest: (k, meta) => { asked = [k, meta.translate]; customs.push(meta.custom); }, onRawStop: (k) => { stopAsked = k; } });
  await Z.start();
  await W2.start();
  const hz = {};
  hz.z = Z.addLocalPeer({ send: (m) => setImmediate(() => hz.w && hz.w.receive(clone(m))) });
  hz.w = W2.addLocalPeer({ send: (m) => setImmediate(() => hz.z && hz.z.receive(clone(m))) });
  await waitFor(() => Z.status().peers === 1, "the link to come up");
  assert.strictEqual(Z.requestRaw("translation:https://example.com/x#original", { translate: true }), 1, "a request goes to the device on the other end of the link");
  await waitFor(() => asked, "the request to arrive");
  assert.deepStrictEqual(asked, ["translation:https://example.com/x#original", true]);
  // the reader's Custom prompt rides with the request, cleaned: the prompt is cut, a choice that is not a boolean is read as one
  assert.deepStrictEqual(customs, [undefined], "a plain request has none");
  Z.requestRaw("translation:https://example.com/x#original", { translate: true, retranslate: true, custom: { prompt: "Try this.", notes: true, glossary: false, replace: true } });
  Z.requestRaw("translation:https://example.com/x#original", { translate: true, custom: { prompt: "y".repeat(9000) } });
  Z.requestRaw("translation:https://example.com/x#original", { translate: true, custom: { prompt: "   " } });
  await waitFor(() => customs.length === 4, "the custom requests to arrive");
  assert.deepStrictEqual(customs[1], { prompt: "Try this.", notes: true, glossary: false, replace: true }, "the prompt and what goes with it");
  assert.strictEqual(customs[2].prompt.length, 8000, "a prompt is cut at 8000 characters");
  assert.deepStrictEqual([customs[2].notes, customs[2].glossary, customs[2].replace], [false, true, false], "what is not said: no notes, the glossary, no English fixes");
  assert.strictEqual(customs[3], undefined, "a blank prompt is no custom prompt");
  W2.announceRaw("translation:https://example.com/x#original", "translating", { pageTitle: "T" });
  await waitFor(() => states.includes("translating"), "its progress to come back");
  W2.announceRaw("translation:https://example.com/x#original", "done", { pageTitle: "T", url: "https://www.biquge.tw/book/1/2.html" });
  W2.announceRaw("translation:https://example.com/x#original", "downloading", { pageTitle: "T", note: "list page 3 of 80 · 150 chapters" });
  W2.announceRaw("translation:https://example.com/x#original", "done", { pageTitle: "T", url: "javascript:alert(1)" });
  await waitFor(() => urls.length >= 1 && states.filter((x) => x === "done").length >= 2, "the finished reports to come back");
  assert.deepStrictEqual(urls, ["https://www.biquge.tw/book/1/2.html"], "a finished report carries where the chapter was saved, and only an https address");
  assert.deepStrictEqual(notes, ["list page 3 of 80 · 150 chapters"], "a status can carry a short note on how far along it is");
  // and the device that asked can say it no longer wants it
  assert.strictEqual(Z.stopRaw("translation:https://example.com/x#list"), 1, "a stop goes to the device on the other end of the link");
  await waitFor(() => stopAsked, "the stop to arrive");
  assert.strictEqual(stopAsked, "translation:https://example.com/x#list");

  // closing the link ends it; a restart of the network side keeps a link that is still open
  Z.stop();
  await Z.start();
  await waitFor(() => Z.status().peers === 1, "the link to survive a restart");
  hz.z.close();
  assert.strictEqual(Z.status().peers, 0, "a closed link is gone");

  // ---- an extension with no passphrase: not on the network, but the library tab in its browser still reaches it ----
  const keyN = "translation:https://example.com/local/2.html";
  const adN = memoryAdapter({ ...cfg, passphrase: "" }, [[keyN, { ...eL, translated: "No passphrase text", savedAt: 7100 }]]);
  const N = createP2P({ ...common, adapter: adN, log: () => {}, role: "extension", localOnly: true });
  const adP = memoryAdapter({ ...cfg, passphrase: "the page's own" });
  const P = createP2P({ ...common, adapter: adP, log: () => {}, role: "site" });
  assert.strictEqual(await N.start(), true, "it starts with no passphrase");
  assert.deepStrictEqual([N.status().running, N.status().network], [true, false], "for the links on this computer only");
  await P.start();
  const hn = {};
  hn.n = N.addLocalPeer({ send: (m) => setImmediate(() => hn.p && hn.p.receive(clone(m))) }, { trusted: true });
  hn.p = P.addLocalPeer({ send: (m) => setImmediate(() => hn.n && hn.n.receive(clone(m))) }, { trusted: true });
  await waitFor(() => P.status().peers === 1 && N.status().peers === 1, "the page and the extension to see each other");
  await waitFor(async () => adP.store.has(keyN), "its chapter to reach the page");
  assert.strictEqual(adP.store.get(keyN).translated, "No passphrase text");
  const plain = createP2P({ ...common, adapter: memoryAdapter({ ...cfg, passphrase: "" }), log: () => {}, role: "site" });
  assert.strictEqual(await plain.start(), false, "without localOnly, no passphrase still means not started");
  N.stop(); P.stop();
  X.stop(); Y.stop(); Z.stop(); W2.stop();

  console.log("OK — all p2p-core checks passed");
  A2.stop();
  B.stop();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
