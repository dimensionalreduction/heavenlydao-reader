// The library's records over the sync protocol (p2p-core.js with opts.library, library.js): the library site's tab and the extension in its
// browser, linked directly as site-bridge.js links them. Each came with a library of its own (the page used before the extension was
// installed, the extension used on its own): linked, they hold one library, every record crossing the link both ways.
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
  // One end: its copy of the library, and its side of the sync protocol, telling the other end what its copy writes.
  async function device(name, role) {
    const lib = await Library.open({ adapter: Library.memoryAdapter() });
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
  const G = "wtr-lab:8053";
  const enc = encodeURIComponent(G);
  await tab.lib.api("POST", `/api/glossaries/${enc}/import`, { name: "wizard", terms: [["科雷", "Corey"], ["希恩", "Sheen"]] });
  await tab.lib.api("PUT", "/api/novels/" + enc, { title: "Synthesis Wizard" });
  await ext.lib.api("PUT", "/api/novels/" + encodeURIComponent("wtr-lab:9"), { title: "Imported in the popup" });
  link(tab, ext);

  // ---- linked: what each had reaches the other, nothing asked ----
  const titles = async (d) => (await d.lib.api("GET", "/api/novels")).novels.map((n) => n.title).sort();
  await waitFor(async () => (await titles(ext)).length === 2 && (await titles(tab)).length === 2, "each end's novels to reach the other");
  assert.deepStrictEqual(await titles(ext), ["Imported in the popup", "Synthesis Wizard"]);
  assert.deepStrictEqual(await titles(tab), await titles(ext), "one library at both ends");
  assert.deepStrictEqual(norev(await ext.lib.api("GET", "/api/glossaries/" + enc)), norev(await tab.lib.api("GET", "/api/glossaries/" + enc)));

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

  for (const d of [tab, ext]) d.core.stop();
  console.log("OK — library over the sync protocol passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
