// The sync's index saved by what changed (p2p-core.js): bucketedIndex over a key-value storage (the extension's), and the core asking the
// adapter to save only the entries that changed (putIndex) instead of the whole index each time. Run: node test/index-store.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P, bucketedIndex, INDEX_BUCKETS } = globalThis.P2PCore;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- bucketedIndex over a storage that counts what it writes ----
  const data = new Map();
  let written = [];
  const storage = {
    get: async (names) => Object.fromEntries((Array.isArray(names) ? names : [names]).filter((n) => data.has(n)).map((n) => [n, JSON.parse(JSON.stringify(data.get(n)))])),
    set: async (o) => { for (const [k, v] of Object.entries(o)) { data.set(k, JSON.parse(JSON.stringify(v))); written.push(k); } },
    remove: async (k) => { data.delete(k); }
  };
  const key = (i) => "translation:https://example.com/novel/" + i + ".html";
  // an index kept whole (from before) is moved into its parts the first time it is read
  const whole = {};
  for (let i = 0; i < 1000; i++) whole[key(i)] = { infohash: "a".repeat(40), savedAt: i + 1 };
  data.set("p2pIndex", whole);
  const ix = bucketedIndex(Object.assign({ base: "p2pIndex" }, storage));
  assert.deepStrictEqual(await ix.getIndex(), whole, "the whole index, as it was");
  assert.ok(!data.has("p2pIndex"), "and no longer kept whole");
  assert.strictEqual([...data.keys()].filter((k) => k.startsWith("p2pIndex:")).length, INDEX_BUCKETS);
  assert.deepStrictEqual(await ix.getIndex(), whole, "read again from its parts");

  // a change writes its part only; a null deletes
  written = [];
  await ix.putIndex({ [key(5)]: { infohash: "b".repeat(40), savedAt: 99 }, [key(6)]: null, [key(2000)]: { infohash: "c".repeat(40), savedAt: 7 } });
  assert.ok(written.length <= 3, "at most the three parts touched, not " + INDEX_BUCKETS);
  const now = await ix.getIndex();
  assert.strictEqual(now[key(5)].savedAt, 99);
  assert.ok(!(key(6) in now), "deleted");
  assert.strictEqual(now[key(2000)].savedAt, 7);
  assert.strictEqual(Object.keys(now).length, 1000);
  // changes made at once do not undo each other
  await Promise.all(Array.from({ length: 20 }, (_, i) => ix.putIndex({ [key(3000 + i)]: { infohash: "d".repeat(40), savedAt: i + 1 } })));
  assert.strictEqual(Object.keys(await ix.getIndex()).length, 1020, "twenty changes at once, all kept");

  // ---- the core saves what changed ----
  const saved = [];
  let wholeSaves = 0;
  const chapters = new Map();
  const adapter = {
    getConfig: async () => ({ enabled: true, passphrase: "index store test", trackers: ["ws://127.0.0.1:1"] }),
    getIndex: async () => ({}),
    setIndex: async () => { wholeSaves++; },
    putIndex: async (c) => { saved.push(c); },
    getTranslation: async (k) => chapters.get(k),
    setTranslation: async (k, e) => { chapters.set(k, e); },
    listTranslations: async () => [...chapters].map(([k, e]) => [k, { savedAt: e.savedAt, translated: true }])
  };
  const core = createP2P({ WebTorrent, adapter, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {} });
  await core.start();
  for (let i = 0; i < 5; i++) {
    const e = { translated: "Text " + i, savedAt: 1000 + i, pageTitle: "Chapter " + i };
    chapters.set(key(i), e);
    await core.onLocalSave(key(i), e);
  }
  await sleep(600);
  core.stop();
  const keys = saved.flatMap((c) => Object.keys(c));
  assert.strictEqual(wholeSaves, 0, "the whole index is not saved");
  assert.deepStrictEqual([...new Set(keys)].sort(), [0, 1, 2, 3, 4].map(key).sort(), "the five chapters' entries, and nothing else");
  assert.ok(saved.every((c) => Object.values(c).every((v) => v && v.savedAt)), "each with its entry");

  console.log("OK — index store passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
