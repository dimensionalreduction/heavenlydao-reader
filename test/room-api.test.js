// Reading the library from a device not in it (p2p-core.js askApi), since protocol 10: refused. A phone that knows the passphrase but has not
// joined asks the laptop (a device of the library) for the novels, and gets nothing: it is not told it may ask, and a question sent by hand
// is not answered.
// Run: node test/room-api.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const Library = require("../src/shared/library.js");

function chapterAdapter(passphrase) {
  return {
    getConfig: async () => ({ enabled: true, passphrase, trackers: ["ws://127.0.0.1:1"] }),
    getIndex: async () => ({}),
    setIndex: async () => {},
    getTranslation: async () => undefined,
    setTranslation: async () => {},
    listTranslations: async () => []
  };
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

(async () => {
  const common = { WebTorrent, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {}, apiTimeoutMs: 1500 };
  const clone = (m) => JSON.parse(JSON.stringify(m));
  function link(x, y) {
    const h = {};
    h.x = x.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) });
    h.y = y.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) });
    return h;
  }

  // ---- the laptop: in the library, answering from it (as the extension does) ----
  const lib = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Laptop" });
  await lib.create();
  const N = "wtr-lab:8053";
  await lib.api("PUT", "/api/novels/" + encodeURIComponent(N), { title: "Synthesis Wizard", synopsis: "A wizard.", cover: "https://example.com/c.jpg" });
  await lib.api("PUT", "/api/covers/" + encodeURIComponent(N), { type: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]) });
  await lib.api("PUT", "/api/chapter-index", { key: N, source: "wtr-lab", url: "https://wtr-lab.com/en/novel/8053/x", chapters: [[1, "One", "https://wtr-lab.com/en/novel/8053/x/chapter-1"]] });
  await lib.api("PUT", "/api/comment-identity", { key: "secret-comment-key", name: "Me" }).catch(() => {});
  const answerApi = async (p) => {
    if (lib.status().state !== "member") return null;
    const out = await lib.api("GET", p);
    return out && out.bytes instanceof Uint8Array ? { type: out.type, bytesB64: b64(out.bytes) } : out;
  };
  const laptop = createP2P({ ...common, adapter: chapterAdapter("our passphrase"), role: "extension", answerApi, library: Library.roomLink(lib) });
  const phone = createP2P({ ...common, adapter: chapterAdapter("our passphrase"), role: "site" });
  const stranger = createP2P({ ...common, adapter: chapterAdapter("another passphrase"), role: "site" });
  await laptop.start();
  await phone.start();
  await stranger.start();

  // nobody connected yet
  await assert.rejects(phone.askApi("/api/novels"), (e) => e.code === "nobody");
  assert.strictEqual(phone.canAskApi(), false);

  // ---- protocol 10: the passphrase only finds the room; a device not in the library reads nothing of it ----
  link(laptop, phone);
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(phone.canAskApi(), false, "the laptop is not one it may ask");
  await assert.rejects(phone.askApi("/api/novels"), (e) => e.code === "nobody");
  // and a question sent anyway, by hand, is not answered
  const sent = [];
  const tap = laptop.addLocalPeer({ send: (m) => sent.push(m) });
  tap.receive({ t: "aq", id: "x1", iv: "AAAAAAAAAAAAAAAA", d: "AAAA" });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!sent.some((m) => m.t === "ar"), "no answer to a device not in the library");
  for (const c of [laptop, phone, stranger]) c.stop();
  console.log("OK — a device not in the library reads nothing of it");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
