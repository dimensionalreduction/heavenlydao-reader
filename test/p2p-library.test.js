// The library's records and joining it, over the sync protocol (p2p-core.js with opts.library, library.js): three devices in a row, Laptop —
// Tab — Phone, where the phone reaches the laptop (the main device) only through the tab. No network: the devices are linked directly, as the
// site and the extension in one browser are.
// Run: node test/p2p-library.test.js
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const Library = require("../src/shared/library.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for: " + what);
}
const norev = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "rev" ? undefined : k === "terms" && Array.isArray(x) ? x.slice().sort((p, q) => (p[0] < q[0] ? -1 : 1)) : x)));

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

(async () => {
  const common = { WebTorrent, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {} };
  // A device: its library, and its side of the sync protocol, telling the others what its library writes.
  async function device(name) {
    const lib = await Library.open({ adapter: Library.memoryAdapter(), deviceName: name });
    const core = createP2P({ ...common, adapter: chapterAdapter("room " + name), role: "device", library: Library.roomLink(lib) });
    lib.on("records", (rs) => core.announceRecords(rs));
    await core.start();
    return { name, lib, core };
  }
  const clone = (m) => JSON.parse(JSON.stringify(m));
  function link(x, y) {
    const h = {};
    h.x = x.core.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) });
    h.y = y.core.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) });
    return h;
  }

  const laptop = await device("Laptop");
  const tab = await device("Tab");
  const phone = await device("Phone");
  await laptop.lib.create();
  const G = "wtr-lab:8053";
  const enc = encodeURIComponent(G);
  await laptop.lib.api("POST", `/api/glossaries/${enc}/import`, { name: "wizard", terms: [["科雷", "Corey"], ["希恩", "Sheen"]] });
  await laptop.lib.api("PUT", "/api/novels/" + enc, { title: "Synthesis Wizard" });
  link(laptop, tab);
  link(tab, phone);

  // ---- the tab asks to join; the laptop lets it in; it gets the library ----
  assert.strictEqual(laptop.lib.status().joins.length, 0, "nobody asks until asked to");
  tab.lib.joinRequest();
  tab.core.askToJoin();
  await waitFor(() => laptop.lib.status().joins.length === 1, "the request to reach the main device");
  const { keys } = await laptop.lib.allow(laptop.lib.status().joins[0].id);
  laptop.core.sendKeys(keys);
  await waitFor(() => tab.lib.status().state === "member", "the tab to be in the library");
  await waitFor(async () => (await tab.lib.api("GET", "/api/novels")).novels.length === 1, "the library's records to reach the tab");
  assert.deepStrictEqual(norev(await tab.lib.api("GET", "/api/glossaries/" + enc)), norev(await laptop.lib.api("GET", "/api/glossaries/" + enc)));
  assert.strictEqual(phone.lib.status().state, "none", "the phone has not asked");

  // ---- the phone asks through the tab (which is not the main device and passes it on) ----
  phone.lib.joinRequest();
  phone.core.askToJoin();
  await waitFor(() => laptop.lib.status().joins.some((j) => j.name === "Phone"), "the phone's request to reach the laptop through the tab");
  assert.strictEqual(tab.lib.status().joins.length, 0, "the tab keeps no requests: it is not the main device");
  const phoneKeys = await laptop.lib.allow(laptop.lib.status().joins.find((j) => j.name === "Phone").id);
  laptop.core.sendKeys(phoneKeys.keys);
  await waitFor(() => phone.lib.status().state === "member", "the phone to be let in, its key passed on by the tab");
  await waitFor(async () => (await phone.lib.api("GET", "/api/glossaries")).glossaries.length === 1, "the library to reach the phone through the tab");
  assert.deepStrictEqual(phone.lib.status().devices.map((d) => d.name).sort(), ["Laptop", "Phone", "Tab"]);

  // ---- a change on the phone reaches the laptop through the tab, and the other way ----
  await phone.lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [["密林", "Deep Forest"]] });
  await waitFor(async () => (await laptop.lib.api("GET", "/api/glossaries/" + enc)).terms.some((t) => t[1] === "Deep Forest"), "the phone's term to reach the laptop");
  await laptop.lib.api("PUT", "/api/term-notes", { source: "科雷", keys: [G], text: "the hero" });
  await waitFor(async () => (await phone.lib.api("GET", "/api/term-notes")).notes.length === 1, "the laptop's note to reach the phone");

  // two at once, on the same part of the glossary, at both ends: both stay, and all three agree
  let w1 = null;
  let w2 = null;
  for (let i = 0; !w2; i++) {
    const s = "字" + i;
    if (Library.bucketOf(s) !== Library.bucketOf("科雷")) continue;
    if (!w1) w1 = s; else w2 = s;
  }
  await Promise.all([
    laptop.lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [[w1, "One"]] }),
    phone.lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [[w2, "Two"]] })
  ]);
  const both = async (d) => { const t = (await d.lib.api("GET", "/api/glossaries/" + enc)).terms; return t.some((x) => x[0] === w1) && t.some((x) => x[0] === w2); };
  await waitFor(async () => (await both(laptop)) && (await both(tab)) && (await both(phone)), "both terms on all three devices");
  const views = await Promise.all([laptop, tab, phone].map(async (d) => JSON.stringify(norev(await d.lib.api("GET", "/api/glossaries/" + enc)))));
  assert.ok(views.every((v) => v === views[0]), "and the three agree");

  // ---- a device of another library in the same room: none of its records are taken ----
  const other = await device("Other");
  await other.lib.create();
  await other.lib.api("PUT", "/api/novels/" + enc, { title: "Not yours" });
  link(other, laptop);
  await sleep(500);
  assert.deepStrictEqual((await laptop.lib.api("GET", "/api/novels")).novels.map((n) => n.title), ["Synthesis Wizard"], "another library's records are not taken");
  assert.deepStrictEqual((await other.lib.api("GET", "/api/novels")).novels.map((n) => n.title), ["Not yours"], "nor are this one's given to it");

  for (const d of [laptop, tab, phone, other]) d.core.stop();
  console.log("OK — library over the sync protocol passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
