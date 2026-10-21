// A device let in through devices that are not in the library, and the library site's tab answering for the extension's library in its own
// room (site/app.js roomLink, library-host.js "room"), over the sync protocol (p2p-core.js, library.js). No network: the devices are linked
// directly. Run: node test/p2p-standin.test.js
//   1. Laptop (main) — Stranger (in no library) — Phone: the stranger passes the request and the keys on, and the list of devices comes with
//      the keys, so the phone is in the library at once (before, it waited for a list nobody it met could send).
//   2. Laptop — Extension (main) ⇄ Tab (in no library of its own, answering for the extension's) — Phone: the phone meets only the tab (it
//      was given the tab's passphrase), joins, gets the library, and what each side writes reaches the other.
const assert = require("assert");
const path = require("path");
const WebTorrent = require("webtorrent");
require(path.join(__dirname, "..", "src", "shared", "p2p-core.js"));
const { createP2P } = globalThis.P2PCore;
const Library = require("../src/shared/library.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for: " + what);
}
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
const clone = (m) => (m === undefined ? m : JSON.parse(JSON.stringify(m)));
const titles = async (lib) => (await lib.api("GET", "/api/novels")).novels.map((n) => n.title).sort();

(async () => {
  const common = { WebTorrent, makeSeedInput: (bytes, name) => Object.assign(Buffer.from(bytes), { name }), log: () => {} };
  async function core(name, library) {
    const c = createP2P({ ...common, adapter: chapterAdapter("room " + name), role: "device", library });
    await c.start();
    return c;
  }
  async function device(name) {
    const lib = await Library.open({ adapter: Library.memoryAdapter(), deviceName: name });
    const c = await core(name, Library.roomLink(lib));
    lib.on("records", (rs) => c.announceRecords(rs));
    return { name, lib, core: c };
  }
  function link(x, y, xOpts = {}, yOpts = {}) {
    const h = {};
    h.x = x.core.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) }, xOpts);
    h.y = y.core.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) }, yOpts);
    return h;
  }
  async function letIn(main, asker, through) {
    asker.lib.joinRequest();
    asker.core.askToJoin();
    await waitFor(() => main.lib.status().joins.some((j) => j.name === asker.name), asker.name + "'s request to reach " + main.name + " through " + through);
    const { keys } = await main.lib.allow(main.lib.status().joins.find((j) => j.name === asker.name).id);
    main.core.sendKeys(keys);
  }

  // ---- 1. let in through a device in no library ----
  {
    const laptop = await device("Laptop");
    const stranger = await device("Stranger");
    const phone = await device("Phone");
    await laptop.lib.create();
    await laptop.lib.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:1"), { title: "One" });
    link(laptop, stranger);
    link(stranger, phone);
    await letIn(laptop, phone, "the stranger");
    await waitFor(() => phone.lib.status().libId, "the keys to reach the phone");
    assert.strictEqual(phone.lib.status().state, "member", "the list of devices came with the keys: in the library at once");
    assert.ok(phone.lib.status().devices.some((d) => d.name === "Laptop" && d.main), "the main device is on its list");
    assert.strictEqual(stranger.lib.status().state, "none", "the stranger only passed them on");
    for (const d of [laptop, stranger, phone]) await d.core.stop();
  }

  // ---- 2. the tab answering for the extension's library ----
  const laptop = await device("Laptop");
  const extension = await device("Extension");
  const phone = await device("Phone");
  await extension.lib.create();
  await extension.lib.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:1"), { title: "One" });
  // the tab: a sync room whose library is the extension's, each call crossing the bridge (as JSON, and later); its own library has none
  const bridged = Library.roomLink(extension.lib);
  const viaBridge = {};
  for (const name of Object.keys(Library.ROOM_CALLS)) viaBridge[name] = async (...a) => { await sleep(1); return clone(await bridged[name](...clone(a))); };
  const tab = { name: "Tab", core: await core("Tab", viaBridge) };
  // the extension and its tab, one browser: each trusts the other, and keeps the same library
  link(extension, tab, { trusted: true, sameLibrary: () => true }, { trusted: true, sameLibrary: () => true });
  link(laptop, extension);
  await letIn(extension, laptop, "a direct link");
  await waitFor(async () => laptop.lib.status().state === "member" && (await titles(laptop.lib)).length === 1, "the laptop to have the library");

  // the phone meets only the tab
  link(tab, phone);
  await letIn(extension, phone, "the tab");
  await waitFor(() => phone.lib.status().state === "member", "the phone to be in the library");
  await waitFor(async () => (await titles(phone.lib)).join() === "One", "the library's records to reach the phone through the tab");
  assert.ok(phone.core.status().devices.length >= 1, "the tab is a device of the library to the phone (it proved it, as the extension)");

  // written by the extension: the tab passes on what it tells of it, and the phone asks the tab for it
  await extension.lib.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:2"), { title: "Two" });
  await waitFor(async () => (await titles(phone.lib)).join() === "One,Two", "a novel the extension wrote to reach the phone");
  // written on the phone: it goes into the extension's library through the tab, and the extension passes it on to the laptop
  await phone.lib.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:3"), { title: "Three" });
  await waitFor(async () => (await titles(extension.lib)).join() === "One,Three,Two", "the phone's novel to reach the extension");
  await waitFor(async () => (await titles(laptop.lib)).join() === "One,Three,Two", "and the laptop, which meets only the extension");

  console.log("OK — let in through others, and the site's tab answering for the extension's library, passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
