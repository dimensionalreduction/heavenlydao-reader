// A phone that fetches chapters on demand (fetch "open") asks a device with the extension for a chapter it has not got (requestRaw), as the
// reader does for a site chapter: once that device says it is done, the phone fetches the chapter, though it never asked for it by its own key.
// Run: node test/raw-ask-on-demand.test.js
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
function memAdapter(fetch) {
  let index = {};
  const store = new Map();
  return {
    store,
    getConfig: async () => ({ enabled: true, passphrase: "raw ask test", trackers: ["ws://127.0.0.1:1"], fetch }),
    getIndex: async () => index,
    setIndex: async (i) => { index = i; },
    getTranslation: async (k) => store.get(k),
    setTranslation: async (k, e) => { store.set(k, e); },
    listTranslations: async () => [...store.entries()].map(([k, e]) => [k, { savedAt: e.savedAt, translated: !!e.translated }])
  };
}
const own = "translation:https://wtr-lab.com/en/novel/1/slug/chapter-7";
const other = "translation:https://wtr-lab.com/en/novel/1/slug/chapter-8";

(async () => {
  const clone = (m) => JSON.parse(JSON.stringify(m));
  const common = { WebTorrent, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {}, library: testLibrary() };
  const extA = memAdapter("all");
  let ext;
  ext = createP2P({ ...common, adapter: extA, role: "extension",
    onRawRequest: async (key) => { // (the extension: downloads it, keeps it, says so)
      const k = key.replace(/#original$/, "");
      const entry = { translated: "text", savedAt: Date.now(), model: "wtr-lab", pageTitle: "Chapter", novelName: "Novel" };
      await extA.setTranslation(k, entry);
      await ext.onLocalSave(k, entry);
      ext.announceRaw(key, "done", {});
    } });
  const phoneA = memAdapter("open");
  const statuses = [];
  const phone = createP2P({ ...common, adapter: phoneA, role: "site", onRawStatus: (k, s) => statuses.push(k + " " + s) });
  await ext.start();
  await phone.start();
  const h = {};
  h.x = ext.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) });
  h.y = phone.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) });
  await sleep(300);

  assert.strictEqual(phone.requestRaw(own + "#original", { novelName: "Novel", translate: true, source: "wtr-lab.com" }), 1, "one device asked");
  await waitFor(() => statuses.includes(own + "#original done"), "the extension says it is done");
  await waitFor(() => phoneA.store.has(own), "the phone has the chapter it asked for");

  // a chapter nobody on this phone asked for is not fetched
  const entry = { translated: "text", savedAt: Date.now(), model: "wtr-lab", pageTitle: "Chapter", novelName: "Novel" };
  await extA.setTranslation(other, entry);
  await ext.onLocalSave(other, entry);
  await waitFor(() => !!phone.getIndex()[other], "the phone learns of the other chapter");
  await sleep(600);
  assert.ok(!phoneA.store.has(other), "the other chapter stays unfetched");

  for (const c of [ext, phone]) c.stop();
  console.log("OK — a chapter asked of the extension is fetched on demand");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
