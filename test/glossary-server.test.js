// The extension's library client (glossary-server.js) against a library in this process (library-stand-in.js): the read cache, imports,
// edits, usage counts, bindings, cover copies, and a library that does not answer. Run: node test/glossary-server.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { libraryStandIn } = require("./library-stand-in.js");

// Minimal chrome.storage.local stand-in
function fakeStorage() {
  const data = {};
  return {
    data,
    get: async (keys) => {
      if (keys == null) return JSON.parse(JSON.stringify(data));
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    set: async (o) => Object.assign(data, JSON.parse(JSON.stringify(o))),
    remove: async (k) => { for (const key of [].concat(k)) delete data[key]; }
  };
}

// The client as the background script loads it, asking `lib` (Firefox's background page holds LibraryHost itself)
function loadClient(storage, lib) {
  globalThis.chrome = { storage: { local: storage } };
  globalThis.LibraryHost = lib.host;
  delete globalThis.GlossaryServer;
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "glossary-server.js"), "utf8");
  vm.runInThisContext(code + "\n;globalThis.GlossaryServer = GlossaryServer;");
  return globalThis.GlossaryServer;
}

(async () => {
  const lib = libraryStandIn();
  const storage = fakeStorage();
  const G = loadClient(storage, lib);
  const ID = "wtr-lab:8053";
  const enc = encodeURIComponent(ID);
  const record = { id: ID, name: "synthesis-wizard[wtr-lab]", site: "wtr-lab", rawId: "8053", slug: "synthesis-wizard", terms: [["科雷", "Corey"], ["希恩", "Sheen"]] };

  // first sync with an empty library
  let r = await G.pull();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(storage.data.glossaryLibrary, {});
  assert.ok(G.pull() === G.pull(), "concurrent pulls share one sync");
  await G.pull();

  // importing a snapshot fills the local cache from the library's answer
  r = await G.importSnapshot(record);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.added, 2);
  assert.strictEqual(storage.data.glossaryLibrary[ID].name, "synthesis-wizard[wtr-lab]");
  assert.deepStrictEqual(storage.data.glossaryLibrary[ID].terms.map((t) => t.slice(0, 2)), [["科雷", "Corey"], ["希恩", "Sheen"]]);
  const rev = storage.data.glossaryRev;
  assert.ok(rev > 0);

  // an edit made elsewhere (the website) arrives on the next pull; with nothing new, the cache is untouched
  await lib.api("POST", `/api/glossaries/${enc}/edit`, { set: [["科雷", "Kolei"]] });
  await G.pull();
  assert.strictEqual(storage.data.glossaryLibrary[ID].terms.find((t) => t[0] === "科雷")[1], "Kolei");
  assert.ok(storage.data.glossaryRev > rev);
  const stable = storage.data.glossaryRev;
  await G.pull();
  assert.strictEqual(storage.data.glossaryRev, stable);

  // re-importing the site's unchanged list doesn't override the user's edit
  await G.importSnapshot(record);
  assert.strictEqual(storage.data.glossaryLibrary[ID].terms.find((t) => t[0] === "科雷")[1], "Kolei");

  // usage counts go up in batches and come back with the next pull
  r = await G.sendVotes(ID, [["科雷", [["Kolei", 9], ["Corey", 4]]], ["希恩", [["Sheen", 7]]]]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.updated, 2);
  await G.pull();
  const cachedTerm = storage.data.glossaryLibrary[ID].terms.find((t) => t[0] === "希恩");
  assert.strictEqual(cachedTerm[3].n, 7, "the counted number is in the local cache");
  assert.deepStrictEqual(cachedTerm[3].v, [["Sheen", 7]]);
  assert.strictEqual((await G.sendVotes("wtr-lab:missing", [["a", []]])).ok, false, "counts for an unknown glossary are refused");

  // bindings round-trip
  assert.strictEqual((await G.setBinding("69shuba.com/txt/77582", [ID])).ok, true);
  assert.deepStrictEqual(storage.data.glossaryBindings["69shuba.com/txt/77582"].ids, [ID]);
  await G.setBinding("69shuba.com/txt/77582", []);
  assert.deepStrictEqual(storage.data.glossaryBindings["69shuba.com/txt/77582"].ids, [], "unbinding syncs");

  // a glossary deleted in the library disappears from the cache
  await lib.api("DELETE", `/api/glossaries/${enc}`);
  await G.pull();
  assert.ok(!storage.data.glossaryLibrary[ID]);
  await G.importSnapshot(record); // put it back for the next checks

  // ---- a novel's cover is copied to the library ----
  const realFetch = globalThis.fetch;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("cover bytes")]);
  globalThis.fetch = async (u, opts) => {
    if (!String(u).startsWith("https://img.example/")) return realFetch(u, opts);
    if (String(u).includes("gone")) return new Response("no", { status: 403 });
    if (String(u).includes("page")) return new Response("<html>not a picture</html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response(jpeg, { status: 200, headers: { "content-type": "application/octet-stream" } }); // (the site does not say what it is)
  };
  const COPY_ID = "details.example/book/5";
  const kept = (id) => lib.api("GET", "/api/covers/" + encodeURIComponent(id)).catch(() => null);
  let cp = await G.copyCover(COPY_ID, "https://img.example/c.jpg");
  assert.deepStrictEqual([cp.ok, cp.changed], [true, true], "downloaded and kept in the library");
  const got = await kept(COPY_ID);
  assert.strictEqual(got.type, "image/jpeg", "typed by what the picture is, not by what the site said");
  assert.ok(Buffer.from(got.bytes).equals(jpeg), "the same bytes");
  assert.strictEqual((await G.copyCover(COPY_ID, "https://img.example/c.jpg")).changed, false, "the same picture again changes nothing");
  cp = await G.copyCover(COPY_ID, "https://img.example/gone.jpg");
  assert.ok(!cp.ok && /HTTP 403/.test(cp.error), "a site that refuses is reported, not thrown");
  cp = await G.copyCover(COPY_ID, "https://img.example/page.html");
  assert.ok(!cp.ok && /not a picture/.test(cp.error), "a page is not kept as a cover");
  assert.ok(!(await G.copyCover(COPY_ID, "http://insecure.example/x.jpg")).ok && !(await G.copyCover(COPY_ID, "")).ok, "only https addresses are fetched");
  cp = await G.copyCover("other/id", "", new Blob([jpeg], { type: "image/jpeg" }));
  assert.ok(cp.ok && (await kept("other/id")), "a picture a page fetched itself is kept without downloading it");
  // always on now: a library whose old setting said off copies covers all the same
  await lib.api("PUT", "/api/settings", { copyCovers: false });
  const off = loadClient(fakeStorage(), lib);
  assert.strictEqual(await off.copyCoversOn(), true, "cover copies are always on");
  cp = await off.copyCover("third/id", "https://img.example/c.jpg");
  assert.ok(cp.ok && (await kept("third/id")), "copied though the old setting said off");
  globalThis.fetch = realFetch;
  loadClient(storage, lib);

  // the library does not answer: asked once more, then the cache is kept and the failure is reported, not thrown
  const cached = JSON.stringify(storage.data.glossaryLibrary);
  lib.down = true;
  const before = lib.calls;
  r = await G.pull();
  assert.strictEqual(r.ok, false);
  assert.ok(/did not answer/.test(r.error), r.error);
  assert.ok(lib.calls - before >= 2, "a library that did not answer is asked again");
  assert.strictEqual(JSON.stringify(storage.data.glossaryLibrary), cached, "cache survives a library that does not answer");
  assert.strictEqual((await G.setBinding("x/y", [ID])).ok, false);
  lib.down = false;

  // a library's refusal (a 4xx) is not asked again
  const refusedFrom = lib.calls;
  await assert.rejects(G.api("GET", "/api/glossaries/nope"), /no such glossary/);
  assert.strictEqual(lib.calls - refusedFrom, 1, "a refusal is final");

  // first sync with data already on this device (captured before it had a library): it is uploaded, not lost
  const fresh = libraryStandIn();
  const legacy = fakeStorage();
  legacy.data.glossaryLibrary = { [ID]: { id: ID, name: "synthesis-wizard[wtr-lab]", site: "wtr-lab", rawId: "8053", slug: "synthesis-wizard", updatedAt: 1, terms: [["科雷", "Corey"]] } };
  legacy.data.glossaryBindings = { "69shuba.com/txt/77582": [ID] }; // the first (bare array) binding format
  const GL = loadClient(legacy, fresh);
  r = await GL.pull();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const inLibrary = await fresh.api("GET", "/api/sync?since=0");
  assert.deepStrictEqual(inLibrary.glossaries.map((g) => g.id), [ID], "local-only glossary was uploaded");
  assert.deepStrictEqual(inLibrary.bindings.map((b) => [b.key, b.ids]), [["69shuba.com/txt/77582", [ID]]], "local-only binding was uploaded");
  assert.ok(legacy.data.glossaryLibrary[ID] && legacy.data.glossaryRev > 0);

  // the library comes back empty (made again): this device re-uploads what it has
  const reborn = libraryStandIn();
  globalThis.LibraryHost = reborn.host;
  r = await GL.pull();
  assert.strictEqual(r.ok, true, "reborn pull: " + JSON.stringify(r));
  assert.deepStrictEqual((await reborn.api("GET", "/api/sync?since=0")).glossaries.map((g) => g.id), [ID], "data survives the library being made again");

  console.log("OK — library client checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
