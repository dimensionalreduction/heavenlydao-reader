// The extension's library (library-host.js) with its client (glossary-server.js), as Firefox's background page runs them: before a library,
// every call is refused; once there is one, the calls are answered by it. Run: node test/library-host.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shared = path.join(__dirname, "..", "src", "shared");

(async () => {
  const G = "wtr-lab:8053";

  // ---- Firefox's background page: storage, messages ----
  const store = {};
  const changeFns = [];
  const msgFns = [];
  const storage = {
    local: {
      get: async (keys) => {
        if (keys === null) return Object.assign({}, store);
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
        changeFns.forEach((fn) => fn(changes, "local"));
      },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; }
    },
    onChanged: { addListener: (fn) => changeFns.push(fn) }
  };
  // the site's addresses as build.js writes them into site-matches.js, from the release manifest (no localhost)
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "firefox", "manifest.json"), "utf8"));
  const SITE_BRIDGE_MATCHES = manifest.content_scripts.find((c) => c.js.includes("site-bridge.js")).matches;
  const browser = { storage, runtime: { onMessage: { addListener: (fn) => msgFns.push(fn) }, sendMessage: async () => undefined, getURL: (p) => "moz-extension://test-uuid/" + p } };
  const ctx = vm.createContext({ SITE_BRIDGE_MATCHES, browser, fetch, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, URL, setTimeout, clearTimeout, setInterval, clearInterval, navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/140.0" }, console, AbortController, Blob, Uint8Array });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  const load = (f) => vm.runInContext(fs.readFileSync(path.join(shared, f), "utf8"), ctx, { filename: f });
  for (const f of ["glossary-server.js", "library-api.js", "library.js"]) load(f);
  vm.runInContext("Library.idbAdapter = () => Library.memoryAdapter();", ctx); // (no IndexedDB in node)
  load("library-host.js");
  const { GlossaryServer, LibraryHost } = ctx;
  // what the popup and the library tab send ({ target: "lib" }), answered by the page's listener
  const ask = (op, ...args) => new Promise((resolve) => msgFns.forEach((fn) => fn({ target: "lib", op, args }, {}, resolve)));
  const askFrom = (url, op, ...args) => new Promise((resolve) => msgFns.forEach((fn) => fn({ target: "lib", op, args }, { tab: { id: 7 }, url }, resolve)));

  // ---- who may ask: the extension's own pages (no tab, or its popup opened in a tab), and a tab of the library site; a tab anywhere else is refused ----
  assert.strictEqual((await askFrom("https://p2p-library.pages.dev/#/settings/library", "status")).result.state, "none", "the site's tab");
  assert.strictEqual((await askFrom("moz-extension://test-uuid/popup.html", "status")).result.state, "none", "the popup, opened in a tab");
  assert.strictEqual((await askFrom("moz-extension://another-extension/popup.html", "status")).error, "not the library's site", "another extension's page");
  for (const elsewhere of ["http://heavenlydao.com/", "http://localhost:3000/", "http://127.0.0.1:3000/", "https://p2p-library.pages.dev.example.com/", "https://www.69shuba.com/txt/1/1"]) {
    assert.strictEqual((await askFrom(elsewhere, "status")).error, "not the library's site", "refused: " + elsewhere);
  }
  assert.ok(LibraryHost.fromSite({ tab: { id: 1 }, url: "https://heavenlydao.com/#/" }) && !LibraryHost.fromSite({ url: "https://heavenlydao.com/" }), "a tab of the site, not just its address");

  // ---- before a library: every call is refused ----
  assert.strictEqual((await ask("status")).result.state, "none");
  await assert.rejects(GlossaryServer.api("GET", "/api/novels"), /not in a library yet/, "nothing is answered before the extension is in a library");
  assert.ok(!store.libraryOn);
  assert.match((await ask("room", "versions")).error, /not in a library yet/, "the site's tab answers for no library of this extension's before");

  // ---- an empty library, with this device as its main device ----
  const made = await ask("create");
  assert.ok(!made.error, made.error);
  assert.deepStrictEqual([made.result.state, made.result.main], ["member", true]);
  assert.ok(store.libraryOn && store.libraryOn.code === made.result.code, "the extension is told it is in a library");

  // ---- the calls are answered by the library ----
  await GlossaryServer.api("POST", "/api/glossaries/" + encodeURIComponent(G) + "/import", { name: "wizard", terms: [["科雷", "Corey"]] });
  await GlossaryServer.api("PUT", "/api/novels/" + encodeURIComponent(G), { title: "Synthesis Wizard" });
  assert.strictEqual((await GlossaryServer.api("GET", "/api/novels")).novels[0].title, "Synthesis Wizard", "read from the library");
  const pulled = await GlossaryServer.pull();
  assert.ok(pulled.ok, pulled.error);
  assert.deepStrictEqual(Object.keys(store.glossaryLibrary), [G], "the extension's glossary cache is filled from the library");
  // the Gemini prompts set in the library's settings: read from it, and a copy kept for the popup to list
  const ps = async () => JSON.stringify(await GlossaryServer.promptSettings());
  assert.strictEqual(await ps(), '{"sets":{},"legacy":{}}', "none set: the built-in ones");
  await GlossaryServer.api("PUT", "/api/settings", { geminiPrompts: { translate: "Mine." } });
  await GlossaryServer.pull();
  assert.strictEqual(await ps(), '{"sets":{},"legacy":{"translate":"Mine."}}', "an older one, as soon as the cache is brought up to date");
  assert.strictEqual(JSON.stringify(store.geminiPrompts), '{"translate":"Mine."}', "and the popup's copy");
  await GlossaryServer.api("PUT", "/api/settings", { geminiPrompts: { translate: "" }, promptSets: { translate: { active: "pone", mine: [{ id: "pone", name: "Mine", text: "Say it." }] } } });
  await GlossaryServer.pull();
  assert.strictEqual(await ps(), '{"sets":{"translate":{"active":"pone","mine":[{"id":"pone","name":"Mine","text":"Say it."}]}},"legacy":{}}', "a saved prompt in use");
  assert.strictEqual(JSON.stringify(store.geminiPromptSets), '{"translate":{"active":"pone","mine":[{"id":"pone","name":"Mine","text":"Say it."}]}}', "and the popup's copy of the list");
  assert.strictEqual(store.geminiPrompts, undefined, "(none of the older kind any more)");
  await GlossaryServer.api("PUT", "/api/settings", { promptSets: { translate: null } });
  await GlossaryServer.pull();
  assert.strictEqual(await ps(), '{"sets":{},"legacy":{}}');
  assert.strictEqual(store.geminiPromptSets, undefined, "put back to the built-in ones: no copy");
  // the model chapters are translated with: the library's setting, which the extension's own copy (selectedModel: what its popup and every translation read) follows
  await GlossaryServer.api("PUT", "/api/settings", { geminiModel: "gemini-3.5-flash" });
  await GlossaryServer.pull();
  assert.strictEqual(store.selectedModel, "gemini-3.5-flash", "the library says one: the extension uses it");
  const picked = await GlossaryServer.setGeminiModel("gemini-3.5-pro");
  assert.ok(picked.ok, picked.error);
  assert.strictEqual(store.selectedModel, "gemini-3.5-pro", "one picked in the popup is used at once");
  assert.strictEqual((await GlossaryServer.api("GET", "/api/settings")).geminiModel, "gemini-3.5-pro", "and is the library's setting, so every device has it");
  await GlossaryServer.api("PUT", "/api/settings", { geminiModel: "" });
  await GlossaryServer.pull();
  assert.strictEqual(store.selectedModel, "gemini-3.5-pro", "the library saying none does not undo what the extension has");
  // the person's English fixes from the site become the terms of the library's reader; one the site no longer has goes, one the person made there stays
  await GlossaryServer.api("PUT", "/api/my-terms/mine1", { from: ["Corey"], to: "Kory", keys: [], cs: false });
  const fix = (id, from, to, global) => ({ id, from: [from], to, cs: false, global });
  let syncedTerms = await GlossaryServer.syncPersonalReplacements("8053", "Synthesis Wizard", [fix("wtr-111", "Star-eater", "Star Devourer", false), fix("wtr-222", "Sphere Lord", "Planet Lord", true)]);
  assert.ok(syncedTerms.ok, syncedTerms.error);
  let mineNow = (await GlossaryServer.api("GET", "/api/my-terms")).terms;
  assert.strictEqual(JSON.stringify(mineNow.map((t) => [t.id, t.keys.join(), t.novel]).sort()), JSON.stringify([["mine1", "", ""], ["wtr-111", "wtr-lab:8053", "Synthesis Wizard"], ["wtr-222", "", ""]]), "one for the novel, one for every novel, the person's own untouched");
  syncedTerms = await GlossaryServer.syncPersonalReplacements("8053", "Synthesis Wizard", [fix("wtr-222", "Sphere Lord", "Planet Lord", true)]);
  mineNow = (await GlossaryServer.api("GET", "/api/my-terms")).terms;
  assert.strictEqual(JSON.stringify(mineNow.map((t) => t.id).sort()), JSON.stringify(["mine1", "wtr-222"]), "the one wtr-lab dropped is gone");
  // changed on the site (saved without src): the person's own from then on, the site's next read leaves it alone; deleted on the site: stays deleted
  await GlossaryServer.api("PUT", "/api/my-terms/wtr-222", { from: ["Sphere Lord"], to: "My Planet Lord", cs: false, keys: [] });
  await GlossaryServer.syncPersonalReplacements("8053", "Synthesis Wizard", [fix("wtr-222", "Sphere Lord", "Planet Lord", true), fix("wtr-333", "Ring", "Band", true)]);
  let after = await GlossaryServer.api("GET", "/api/my-terms");
  assert.strictEqual(after.terms.find((x) => x.id === "wtr-222").to, "My Planet Lord", "a term the person changed is not overwritten by wtr-lab's");
  assert.strictEqual(after.terms.find((x) => x.id === "wtr-333").src, "wtr", "a new one from wtr-lab is added, marked as wtr-lab's");
  await GlossaryServer.api("DELETE", "/api/my-terms/wtr-333");
  await GlossaryServer.syncPersonalReplacements("8053", "Synthesis Wizard", [fix("wtr-222", "Sphere Lord", "Planet Lord", true), fix("wtr-333", "Ring", "Band", true)]);
  after = await GlossaryServer.api("GET", "/api/my-terms");
  assert.ok(!after.terms.some((x) => x.id === "wtr-333") && after.gone.includes("wtr-333"), "one the person deleted is not brought back");
  assert.ok(!(await GlossaryServer.api("GET", "/api/my-terms")).terms.some((x) => x.src === "wtr" && x.gone), "(a mark is not a term)");
  await GlossaryServer.api("DELETE", "/api/my-terms/wtr-222");
  await GlossaryServer.api("DELETE", "/api/my-terms/mine1");
  const imported = await GlossaryServer.importSnapshot({ id: G, name: "wizard", terms: [["科雷", "Corey"], ["希恩", "Sheen"]] });
  assert.ok(imported.ok, imported.error);
  assert.strictEqual(store.glossaryLibrary[G].terms.length, 2, "a wtr-lab import goes into the library");
  const cover = await GlossaryServer.copyCover("wtr-lab:1", "", new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3])], { type: "image/jpeg" }));
  assert.ok(cover.ok && cover.changed, JSON.stringify(cover));
  const got = await ask("api", "GET", "/api/covers/" + encodeURIComponent("wtr-lab:1"));
  assert.deepStrictEqual([got.result.type, got.result.bytesB64], ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString("base64")], "covers go in and come out (as base64 between the extension's pages)");
  // an error says what the library said
  const missing = await ask("api", "GET", "/api/glossaries/nope");
  assert.strictEqual(missing.error, "no such glossary");
  // when it does what it does on its own (the site's Triggers tab and Activity › Upcoming): nothing published yet, so no editions job
  const sch = (await ask("schedule")).result;
  assert.deepStrictEqual([sch.editions, sch.follows, sch.watches.every, typeof sch.now], [null, null, 60000, "number"], "the schedule, before publishing starts");

  // ---- the site's tab answering for this library in its own room ("room"): what the room asks of the library, call by call ----
  const libId = made.result.libId;
  assert.strictEqual((await ask("room", "lib")).result, libId);
  const vers = (await ask("room", "versions")).result;
  assert.ok(vers.some(([k]) => k === "devices") && vers.some(([k]) => k === "novel:" + G), "what this library holds");
  const devVer = vers.find(([k]) => k === "devices")[1];
  assert.deepStrictEqual((await ask("room", "wantsMany", [["devices", devVer], ["novel:wtr-lab:1", [1, 0, "x"]]])).result, [["novel:wtr-lab:1", [1, 0, "x"]]], "only what it does not have");
  assert.strictEqual((await ask("room", "get", "devices")).result.by, "root");
  const proof = (await ask("room", "peerProof", "p2p-read peer v1|" + libId + "|mine|theirs")).result;
  assert.ok(proof && proof.d === made.result.device.id && typeof proof.s === "string", "a proof for a connection of this library's room");
  assert.strictEqual((await ask("room", "peerProof", "anything at all")).result, null, "nothing else is signed with this extension's key");
  assert.strictEqual((await ask("room", "peerProof", "p2p-read peer v1|another library|mine|theirs")).result, null, "nor a proof for another library");
  assert.match((await ask("room", "api", "GET", "/api/novels")).error, /not something the room asks/, "only the room's calls");

  // ---- leaving (the popup only), and joining another library at once (the popup's Detect: the keys from the library's tab) ----
  assert.strictEqual((await askFrom("https://heavenlydao.com/#/", "leave")).error, "only the extension's popup does that", "the site's tab can't make it leave");
  Object.assign(store, { "translation:https://x.example/1": { text: "a chapter", savedAt: 1, translated: true }, "p2pIndex:3": { "translation:https://x.example/1": { savedAt: 1 } },
    myTerms: [{ id: "t" }], geminiApiKey: "the key", p2pPassphrase: "library one" });
  const left = await ask("leave");
  assert.ok(!left.error, left.error);
  assert.strictEqual(left.result.state, "none", "in no library");
  assert.strictEqual(left.result.proof, null, "(its only device: nobody to tell)");
  assert.notStrictEqual(left.result.device.id, made.result.device.id, "a new device from then on");
  assert.strictEqual(JSON.stringify(Object.keys(store).filter((k) => /^translation:|^p2pIndex|^glossary|^myTerms$/.test(k))), "[]", "its chapters and the glossaries' copy are gone");
  assert.strictEqual(store.geminiApiKey, "the key", "the extension's own settings stay");
  assert.ok(!store.libraryOn, "the extension is told it is in no library");
  await assert.rejects(GlossaryServer.api("GET", "/api/novels"), /not in a library yet/);
  const other = await ctx.Library.open({ adapter: ctx.Library.memoryAdapter(), deviceName: "Library tab" });
  await other.create();
  const request = (await askFrom("moz-extension://test-uuid/popup.html", "joinRequest")).result;
  assert.strictEqual((await ask("status")).result.state, "none", "making the request asks nobody");
  assert.ok(other.joinAsked(request));
  const { keys } = await other.allow(request.id);
  const joined = await ask("receiveKeys", keys, "library two");
  assert.ok(!joined.error, joined.error);
  assert.strictEqual(joined.result.code, other.status().code, "in the other library");
  assert.strictEqual(store.p2pPassphrase, "library two", "with its passphrase");
  assert.ok(store.libraryOn && store.libraryOn.code === other.status().code);
  assert.match((await ask("joinRequest")).error, /leave it first/, "not while it is in one");
  assert.match((await ask("receiveKeys", keys, "x")).error, /not for this extension/);


  console.log("OK — library host checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
