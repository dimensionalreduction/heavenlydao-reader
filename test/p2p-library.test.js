// The library's records over the sync protocol (p2p-core.js with opts.library, library.js): the library site's tab (the main device) and
// the extension in its browser, linked directly as site-bridge.js links them. The extension joins at once, as the popup's Detect does (the
// tab takes its request and lets it in: app.js answerExtension "letIn"), then every record crosses the link both ways.
// Run: node test/p2p-library.test.js
const assert = require("assert");
const path = require("path");
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

function chapterAdapter() {
  return {
    getConfig: async () => ({}),
    getIndex: async () => ({}),
    setIndex: async () => {},
    getTranslation: async () => undefined,
    setTranslation: async () => {},
    listTranslations: async () => []
  };
}

(async () => {
  // A device: its library, and its side of the sync protocol, telling the other end what its library writes.
  async function device(name, role) {
    const lib = await Library.open({ adapter: Library.memoryAdapter(), deviceName: name });
    const core = createP2P({ adapter: chapterAdapter(), log: () => {}, role, library: Library.roomLink(lib) });
    lib.on("records", (rs) => core.announceRecords(rs));
    await core.start();
    return { name, lib, core };
  }
  const clone = (m) => JSON.parse(JSON.stringify(m));
  function link(x, y) {
    const h = {};
    h.x = x.core.addLocalPeer({ send: (m) => setImmediate(() => h.y && h.y.receive(clone(m))) }, { trusted: true });
    h.y = y.core.addLocalPeer({ send: (m) => setImmediate(() => h.x && h.x.receive(clone(m))) }, { trusted: true });
    return h;
  }

  const tab = await device("Tab", "site");
  const ext = await device("Chrome on Windows (extension)", "extension");
  await tab.lib.create();
  const G = "wtr-lab:8053";
  const enc = encodeURIComponent(G);
  await tab.lib.api("POST", `/api/glossaries/${enc}/import`, { name: "wizard", terms: [["科雷", "Corey"], ["希恩", "Sheen"]] });
  await tab.lib.api("PUT", "/api/novels/" + enc, { title: "Synthesis Wizard" });
  link(tab, ext);

  // ---- the extension joins at once: the tab takes its request and lets it in; it gets the library over the link ----
  const asked = await ext.lib.joinMessage();
  assert.ok(await tab.lib.joinAsked(asked), "the main device takes the request");
  const { keys } = await tab.lib.allow(asked.id);
  assert.ok(await ext.lib.receiveKeys(keys), "the keys are the extension's");
  ext.core.libraryChanged();
  assert.strictEqual(ext.lib.status().state, "member", "the extension is in the library");
  await waitFor(async () => (await ext.lib.api("GET", "/api/novels")).novels.length === 1, "the library's records to reach the extension");
  assert.deepStrictEqual(norev(await ext.lib.api("GET", "/api/glossaries/" + enc)), norev(await tab.lib.api("GET", "/api/glossaries/" + enc)));
  assert.deepStrictEqual(ext.lib.status().devices.map((d) => d.name).sort(), ["Chrome on Windows (extension)", "Tab"]);

  // ---- a change at either end reaches the other ----
  await ext.lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [["密林", "Deep Forest"]] });
  await waitFor(async () => (await tab.lib.api("GET", "/api/glossaries/" + enc)).terms.some((t) => t[1] === "Deep Forest"), "the extension's term to reach the tab");
  await tab.lib.api("PUT", "/api/term-notes", { source: "科雷", keys: [G], text: "the hero" });
  await waitFor(async () => (await ext.lib.api("GET", "/api/term-notes")).notes.length === 1, "the tab's note to reach the extension");

  // two at once, on the same part of the glossary, at both ends: both stay, and the two agree
  let w1 = null;
  let w2 = null;
  for (let i = 0; !w2; i++) {
    const s = "字" + i;
    if (Library.bucketOf(s) !== Library.bucketOf("科雷")) continue;
    if (!w1) w1 = s; else w2 = s;
  }
  await Promise.all([
    tab.lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [[w1, "One"]] }),
    ext.lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [[w2, "Two"]] })
  ]);
  const both = async (d) => { const t = (await d.lib.api("GET", "/api/glossaries/" + enc)).terms; return t.some((x) => x[0] === w1) && t.some((x) => x[0] === w2); };
  await waitFor(async () => (await both(tab)) && (await both(ext)), "both terms at both ends");
  const views = await Promise.all([tab, ext].map(async (d) => JSON.stringify(norev(await d.lib.api("GET", "/api/glossaries/" + enc)))));
  assert.ok(views.every((v) => v === views[0]), "and the two agree");

  // ---- another library at the other end of a link: none of its records are taken ----
  const other = await device("Other", "site");
  await other.lib.create();
  await other.lib.api("PUT", "/api/novels/" + enc, { title: "Not yours" });
  link(other, ext);
  await sleep(500);
  assert.deepStrictEqual((await ext.lib.api("GET", "/api/novels")).novels.map((n) => n.title), ["Synthesis Wizard"], "another library's records are not taken");
  assert.deepStrictEqual((await other.lib.api("GET", "/api/novels")).novels.map((n) => n.title), ["Not yours"], "nor are this one's given to it");

  for (const d of [tab, ext, other]) d.core.stop();
  console.log("OK — library over the sync protocol passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
