// Joining at once and leaving (library.js joinMessage, leave, leaveProof, removeLeaving; p2p-core.js "lx"): a device let in with no asking (the
// site's tab in the extension's browser, as the main device, answers the extension's request with the keys), a device leaving and the main device
// taking it off the list, through a device that passes it on, and the device joining again as a new one.
// Run: node test/leave.test.js
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
  const ext = await device("Extension");
  await laptop.lib.create();
  await laptop.lib.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:1"), { title: "Synthesis Wizard" });

  // ---- let in at once: the request is made without asking anyone, and the main device answers it with the keys ----
  const request = ext.lib.joinMessage();
  assert.strictEqual(ext.lib.status().state, "none", "making the request asks nobody");
  assert.strictEqual(Library.roomLink(ext.lib).joinRequest(), null, "nor does the room ask for it");
  assert.ok(laptop.lib.joinAsked(request));
  const { keys } = await laptop.lib.allow(request.id);
  assert.ok(await ext.lib.receiveKeys(keys));
  assert.strictEqual(ext.lib.status().state, "member", "in the library as the keys come (the list comes with them)");
  const tabAsk = tab.lib.joinRequest();
  laptop.lib.joinAsked(tabAsk);
  assert.ok(await tab.lib.receiveKeys((await laptop.lib.allow(tabAsk.id)).keys));

  // the extension reaches the laptop only through the tab
  link(laptop, tab);
  link(tab, ext);
  await waitFor(async () => (await ext.lib.api("GET", "/api/novels")).novels.length === 1, "the library to reach the extension through the tab");
  await waitFor(() => ext.lib.status().devices.length === 3 && tab.lib.status().devices.length === 3, "every list to have the three devices");

  // ---- leaving ----
  // the main device can't while others are in it; a library only it is in, it can
  await assert.rejects(laptop.lib.leave(), /main device/);
  const lone = await Library.open({ adapter: Library.memoryAdapter(), deviceName: "Lone" });
  await lone.create();
  await lone.leave();
  assert.strictEqual(lone.status().state, "none");
  assert.strictEqual(await lone.leaveProof(), null, "in no library: nothing to sign");

  const oldId = ext.lib.status().device.id;
  const proof = await ext.lib.leaveProof();
  assert.deepStrictEqual([proof.t, proof.lib, proof.id], ["lx", laptop.lib.status().libId, oldId]);
  // a proof changed, or from another library, does not count
  assert.strictEqual(await laptop.lib.removeLeaving(Object.assign({}, proof, { at: proof.at + 1 })), false, "a proof changed is refused");
  assert.strictEqual(await laptop.lib.removeLeaving(Object.assign({}, proof, { lib: lone.status().libId || "x" })), false, "another library's");
  assert.strictEqual(await tab.lib.removeLeaving(proof), false, "only the main device takes a device off");
  await ext.lib.leave();
  const st = ext.lib.status();
  assert.strictEqual(st.state, "none", "it is in no library");
  assert.notStrictEqual(st.device.id, oldId, "a new device from then on");
  await assert.rejects(ext.lib.api("GET", "/api/novels"), /not in a library/);
  // the room passes it on (the tab is not the main device), and the laptop takes it off the list
  assert.strictEqual(ext.core.sayLeaving(proof), 1, "told the one device it is linked to");
  await waitFor(() => laptop.lib.status().devices.length === 2, "the laptop to take it off the list");
  assert.deepStrictEqual(laptop.lib.status().devices.map((d) => d.name).sort(), ["Laptop", "Tab"]);
  await waitFor(() => tab.lib.status().devices.length === 2, "the tab to have the new list");
  assert.strictEqual(tab.lib.status().state, "member", "the tab stays (it was sent the new owner key)");
  assert.strictEqual(await laptop.lib.removeLeaving(proof), false, "the same proof again: off the list already");

  // ---- and joining again, as a new device ----
  const again = ext.lib.joinMessage();
  assert.notStrictEqual(again.id, oldId);
  assert.ok(laptop.lib.joinAsked(again), "the main device takes the new device's request");
  assert.ok(await ext.lib.receiveKeys((await laptop.lib.allow(again.id)).keys));
  ext.core.libraryChanged();
  await waitFor(async () => ext.lib.status().state === "member" && (await ext.lib.api("GET", "/api/novels").catch(() => ({ novels: [] }))).novels.length === 1, "the library to reach it again");

  for (const d of [laptop, tab, ext]) d.core.stop();
  console.log("OK — joining at once and leaving passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
