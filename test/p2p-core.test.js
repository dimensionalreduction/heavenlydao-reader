// p2p-core.js over links like the one between the library site's tab and the extension (site-bridge.js): no network.
// Run: node test/p2p-core.test.js
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const testLibrary = require("./test-library.js");

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
    await sleep(50);
  }
  throw new Error("timed out waiting for: " + what);
}
const clone = (m) => JSON.parse(JSON.stringify(m)); // what a message becomes crossing the bridge
function link(x, y, opts = { trusted: true }) {
  const h = {};
  h.x = x.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) }, opts);
  h.y = y.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) }, opts);
  return h;
}

(async () => {
  const cfg = {};
  const key1 = "translation:https://example.com/book/1.html";
  const key2 = "translation:https://example.com/book/2.html";
  const e1 = { translated: "Chapter one — 第一章 text", suggestions: [], savedAt: 1000, model: "m", pageTitle: "Ch 1", novelName: "Book" };
  const e2 = { translated: "Chapter two text", suggestions: [], savedAt: 2000, model: "m", pageTitle: "Ch 2", novelName: "Book" };

  const common = { library: testLibrary(), log: () => {} };
  const adA = memoryAdapter(cfg, [[key1, e1]]);
  const adB = memoryAdapter(cfg);
  const A = createP2P({ ...common, adapter: adA, role: "extension" });
  const B = createP2P({ ...common, adapter: adB, role: "site" });
  await A.start();
  await B.start();
  await waitFor(() => A.getIndex()[key1], "A to index its chapter");
  link(A, B);

  await waitFor(() => A.status().peers === 1 && B.status().peers === 1, "the link to come up");
  await waitFor(async () => adB.store.has(key1), "B to pull chapter 1 from A");
  assert.strictEqual(adB.store.get(key1).translated, e1.translated);
  assert.strictEqual(adB.store.get(key1).pageTitle, "Ch 1");
  assert.ok(B.status().stats.direct >= 1, "by the direct request");

  // Live update: a new chapter saved on A shows up on B without any restart.
  adA.store.set(key2, e2);
  await A.onLocalSave(key2, e2);
  await waitFor(async () => adB.store.has(key2), "B to pull live-published chapter 2");
  assert.strictEqual(adB.store.get(key2).translated, e2.translated);

  // The ends introduce themselves, so each side can tell what it is linked to
  assert.deepStrictEqual(B.status().devices.map((d) => [d.role, d.via]), [["extension", "local"]], "the site sees one end: an extension");
  assert.ok(B.status().devices[0].id && B.status().devices[0].id === A.id, "which names itself");
  assert.ok(B.status().devices.every((d) => d.v >= 12) && B.status().protocol >= 12, "and says which protocol it speaks");

  // Same chapter, same bytes, same id: the index entries on both sides agree, in the form the ends from before accept (40 hex digits).
  assert.strictEqual(A.getIndex()[key1].infohash, B.getIndex()[key1].infohash);
  assert.match(A.getIndex()[key1].infohash, /^[0-9a-f]{40}$/);

  // A re-translation (newer savedAt) replaces the older copy on the other end.
  const e1b = { ...e1, translated: "Chapter one, retranslated", savedAt: 3000 };
  adA.store.set(key1, e1b);
  await A.onLocalSave(key1, e1b);
  await waitFor(async () => adB.store.get(key1).savedAt === 3000, "B to receive the newer translation");
  assert.strictEqual(adB.store.get(key1).translated, "Chapter one, retranslated");

  // Restart A with its index forgotten: it must make the same id again for unchanged chapters.
  const before = A.getIndex()[key2].infohash;
  A.stop();
  const adA2 = memoryAdapter(cfg, [...adA.store]);
  const A2 = createP2P({ ...common, adapter: adA2 });
  await A2.start();
  await waitFor(() => A2.getIndex()[key2], "A2 to index its chapters again");
  assert.strictEqual(A2.getIndex()[key2].infohash, before, "id stable across restart");
  A2.stop();
  B.stop();

  // A chapter several pieces long arrives intact over the link.
  const key3 = "translation:https://example.com/book/3.html";
  const long = Array.from({ length: 4000 }, (_, i) => "第" + i + "行 line of a long chapter, with 中文 mixed in.").join("\n");
  const e3 = { translated: long, suggestions: [], savedAt: 4000, model: "m", pageTitle: "Ch 3", novelName: "Book" };
  const adD = memoryAdapter(cfg, [[key3, e3]]);
  const adE = memoryAdapter(cfg);
  const D = createP2P({ ...common, adapter: adD });
  const E = createP2P({ ...common, adapter: adE });
  await D.start();
  await E.start();
  await waitFor(() => D.getIndex()[key3], "D to index chapter 3");
  link(D, E);
  await waitFor(async () => adE.store.has(key3), "E to receive chapter 3 directly");
  assert.strictEqual(adE.store.get(key3).translated, long, "a multi-piece chapter arrives intact");
  assert.ok(Array.isArray(E.activity().rows), "activity view works");
  D.stop();
  E.stop();

  // ---- a link not trusted (yet): nothing of the chapters crosses it ----
  const keyU = "translation:https://example.com/book/u.html";
  const adU = memoryAdapter(cfg, [[keyU, { ...e1, translated: "Not for an untrusted end", savedAt: 5000 }]]);
  const adV = memoryAdapter(cfg);
  let trusted = false;
  const U = createP2P({ ...common, adapter: adU, role: "extension" });
  const V = createP2P({ ...common, adapter: adV, role: "site" });
  await U.start();
  await V.start();
  await waitFor(() => U.getIndex()[keyU], "U to index its chapter");
  const hu = link(U, V, { trusted: () => trusted });
  await sleep(500);
  assert.ok(!adV.store.has(keyU) && !V.getIndex()[keyU], "not trusted: no entries, no chapters");
  assert.strictEqual(V.status().peers, 0, "and it is not counted");
  trusted = true;
  hu.x.refresh();
  hu.y.refresh();
  await waitFor(async () => adV.store.has(keyU), "once trusted (and refreshed), the chapter to cross");
  U.stop();
  V.stop();

  // ---- a request for an original text goes to the other end, and its progress comes back ----
  const states = [];
  const urls = [];
  const notes = [];
  const Z = createP2P({ ...common, adapter: memoryAdapter(cfg), role: "site", onRawStatus: (k, st, info) => { states.push(st); if (info.url) urls.push(info.url); if (info.note) notes.push(info.note); } });
  let asked = null;
  const customs = [];
  let stopAsked = null;
  const W2 = createP2P({ ...common, adapter: memoryAdapter(cfg), role: "extension", onRawRequest: (k, meta) => { asked = [k, meta.translate]; customs.push(meta.custom); }, onRawStop: (k) => { stopAsked = k; } });
  await Z.start();
  await W2.start();
  const hz = link(Z, W2);
  await waitFor(() => Z.status().peers === 1, "the link to come up");
  assert.strictEqual(Z.requestRaw("translation:https://example.com/x#original", { translate: true }), 1, "a request goes to the end on the other side of the link");
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
  // and the end that asked can say it no longer wants it
  assert.strictEqual(Z.stopRaw("translation:https://example.com/x#list"), 1, "a stop goes to the end on the other side of the link");
  await waitFor(() => stopAsked, "the stop to arrive");
  assert.strictEqual(stopAsked, "translation:https://example.com/x#list");

  // a restart keeps a link that is still open; closing the link ends it
  Z.stop();
  await Z.start();
  await waitFor(() => Z.status().peers === 1, "the link to survive a restart");
  hz.x.close();
  assert.strictEqual(Z.status().peers, 0, "a closed link is gone");
  Z.stop();
  W2.stop();

  console.log("OK — all p2p-core checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
