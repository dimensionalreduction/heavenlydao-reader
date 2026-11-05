// Your library as each copy keeps it (src/shared/library.js): the page's copy and the extension's, records going between them, terms
// changed in both at once, records that must be refused, loading again, a library kept before 2026-11 (encrypted) written again as plain
// records, and moving the glossary server's data in.
// Run: node test/library.test.js
const assert = require("assert");
const { webcrypto } = require("node:crypto");
const Library = require("../src/shared/library.js");

// The API's answers without what is only one copy's own counting (rev), so two copies' answers can be compared.
// (A glossary's terms come in the order each copy first had them, so they are compared sorted.)
const norev = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "rev" ? undefined : k === "terms" && Array.isArray(x) ? x.slice().sort((p, q) => (p[0] < q[0] ? -1 : 1)) : x)));
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

(async () => {
  // ---- two copies of the library: the page's and the extension's ----
  const adA = Library.memoryAdapter();
  const A = await Library.open({ adapter: adA });
  const B = await Library.open({ adapter: Library.memoryAdapter() });
  assert.deepStrictEqual((await A.api("GET", "/api/novels")).novels, [], "a library at once, empty");

  // What one copy writes goes to the other through the "records" listener.
  const toB = [];
  const toA = [];
  A.on("records", (rs) => toB.push(...rs));
  B.on("records", (rs) => toA.push(...rs));
  const deliver = async (queue, to) => {
    const results = [];
    while (queue.length) results.push(await to.receive(queue.shift()));
    return results;
  };

  // ---- what is written in one copy is read in the other ----
  const G = "wtr-lab:8053";
  const enc = encodeURIComponent(G);
  await A.api("POST", `/api/glossaries/${enc}/import`, { name: "wizard", site: "wtr-lab", rawId: "8053", slug: "w", terms: [["科雷", "Corey"], ["希恩", "Sheen"], ["密林小屋", "Secret Forest Cabin", { o: "ai" }]] });
  await A.api("POST", `/api/glossaries/${enc}/votes`, { votes: [["密林小屋", [["Forest Hut", 9], ["Secret Forest Cabin", 2]]]] });
  await A.api("PUT", "/api/bindings", { key: "69shuba.com/txt/1", ids: [G] });
  await A.api("PUT", "/api/novels/" + enc, { title: "Synthesis Wizard", author: "Someone", tags: ["magic"] });
  await A.api("PUT", "/api/covers/" + enc, { type: "image/png", bytes: PNG });
  await A.api("PUT", "/api/chapter-index", { key: "69shuba.com/txt/1", source: "69shuba", chapters: [[1, "One", "https://69shuba.com/txt/1/1"], [2, "Two", "https://69shuba.com/txt/1/2"]] });
  // a list is found by the address it was read from, and by the book's info page (a book recorded from /book/3903.htm, its list read from /book/3903/)
  await A.api("PUT", "/api/chapter-index", { key: "69shuba.com/txt/3903", source: "69shuba.com", url: "https://www.69shuba.com/book/3903/", chapters: [[1, "One", "https://www.69shuba.com/txt/3903/2344025"]] });
  const byUrl = async (u) => (await A.api("GET", "/api/chapter-index?url=" + encodeURIComponent(u))).indexes.map((i) => i.key);
  assert.deepStrictEqual(await byUrl("https://www.69shuba.com/book/3903/"), ["69shuba.com/txt/3903"], "the list page's own address");
  assert.deepStrictEqual(await byUrl("https://www.69shuba.com/book/3903.htm"), ["69shuba.com/txt/3903"], "the book's info page");
  assert.deepStrictEqual(await byUrl("https://www.69shuba.com/book/39031.htm"), [], "not another book");
  assert.deepStrictEqual(await byUrl("https://69shuba.tw/book/3903/"), [], "nor the same number on another site");
  await A.api("PUT", "/api/my-terms/abcd1", { from: ["Corey"], to: "Kory", keys: [G], novel: "Synthesis Wizard" });
  await A.api("PUT", "/api/term-notes", { source: "科雷", keys: [G], text: "the hero" });
  await A.api("PUT", "/api/settings", { termNotesAi: true });
  // the Gemini prompts a person changed: kept as given, a blank one is the built-in again, a name that is none of the three is not kept
  let saved = await A.api("PUT", "/api/settings", { geminiPrompts: { translate: "Translate it.", notes: "Notes.", other: "x" } });
  assert.deepStrictEqual(saved.geminiPrompts, { translate: "Translate it.", notes: "Notes." });
  saved = await A.api("PUT", "/api/settings", { geminiPrompts: { notes: "  " } });
  assert.deepStrictEqual(saved.geminiPrompts, { translate: "Translate it." });
  // saved prompts: the one in use and the person's own; a bad one (no id, blank text) is dropped, a kind that is none of the three is not kept, null puts one back
  saved = await A.api("PUT", "/api/settings", { promptSets: { translate: { active: "pone", mine: [{ id: "pone", name: " Mine ", text: "Say it." }, { id: "pone", name: "Twice", text: "x" }, { id: "no", name: "Short id", text: "x" }, { id: "ptwo", name: "", text: "  " }, { id: "pthree", text: "Third" }] }, other: { active: "x", mine: [] } } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.promptSets)), { translate: { active: "pone", mine: [{ id: "pone", name: "Mine", text: "Say it." }, { id: "pthree", name: "Prompt", text: "Third" }] } });
  saved = await A.api("PUT", "/api/settings", { promptSets: { notes: { active: "default", mine: [] } } });
  assert.deepStrictEqual(Object.keys(saved.promptSets).sort(), ["notes", "translate"], "a kind left out is as it was");
  saved = await A.api("PUT", "/api/settings", { promptSets: { translate: null, notes: null } });
  assert.strictEqual(saved.promptSets, undefined, "none left: none kept");
  // translation profiles: a bad one (short id, no model, an unknown way to pay, a key with no address, the same id twice) is dropped, a key is never kept;
  // the library's default and a novel's choice must be one of them (or "gemini" for a novel), and go when their profile does
  saved = await A.api("PUT", "/api/settings", { translateProfiles: [
    { id: "pro1", name: " Haiku plain ", model: "anthropic/claude-haiku-5.5", prompt: "Translate to {language}.", pay: "tickets", key: "sk-secret" },
    { id: "pro2", name: "Mine", model: "gpt-5-mini", prompt: "", pay: "key", base: "https://api.example.com/v1/", key: "sk-secret" },
    { id: "p3", model: "x", pay: "tickets" }, { id: "pro4", model: "", pay: "tickets" }, { id: "pro5", model: "m", pay: "card" }, { id: "pro6", model: "m", pay: "key" }, { id: "pro1", model: "again", pay: "tickets" },
    { id: "pro7", name: "By the extension", model: "gemini-3.5-flash", prompt: "Translate.", pay: "extension", base: "https://x.example/v1" }
  ], translateProfile: "pro2", novelProfiles: { "wtr-lab:1": "pro1", "record:up-x": "gemini", "wtr-lab:2": "nope" } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.translateProfiles)), [
    { id: "pro1", name: "Haiku plain", model: "anthropic/claude-haiku-5.5", prompt: "Translate to {language}.", pay: "tickets", base: "" },
    { id: "pro2", name: "Mine", model: "gpt-5-mini", prompt: "", pay: "key", base: "https://api.example.com/v1" },
    { id: "pro7", name: "By the extension", model: "gemini-3.5-flash", prompt: "Translate.", pay: "extension", base: "" }
  ]);
  assert.strictEqual(saved.translateProfile, "pro2");
  assert.deepStrictEqual(saved.novelProfiles, { "wtr-lab:1": "pro1", "record:up-x": "gemini" });
  saved = await A.api("PUT", "/api/settings", { novelProfiles: { "wtr-lab:1": null } });
  assert.deepStrictEqual(saved.novelProfiles, { "record:up-x": "gemini" }, "null: the library's default again");
  saved = await A.api("PUT", "/api/settings", { translateProfiles: [saved.translateProfiles[0]], novelProfiles: { "wtr-lab:3": "pro2" } });
  assert.strictEqual(saved.translateProfile, undefined, "its profile deleted: Gemini again");
  assert.deepStrictEqual(saved.novelProfiles, { "record:up-x": "gemini" }, "a novel's choice of a deleted profile goes");
  saved = await A.api("PUT", "/api/settings", { translateProfiles: [], novelProfiles: { "record:up-x": null } });
  assert.ok(saved.translateProfiles === undefined && saved.novelProfiles === undefined, "none left: none kept");
  // expression profiles (Listen › Expression): the same fields, but never paid by the extension, and kept apart from the translation ones
  saved = await A.api("PUT", "/api/settings", { translateProfiles: [{ id: "tr1", name: "Plain", model: "m1", pay: "tickets" }], expressionProfiles: [
    { id: "ex1", name: " Cues ", model: "anthropic/claude-haiku-5.5", prompt: "Add cues.", pay: "tickets", key: "sk-secret" },
    { id: "ex2", name: "Mine", model: "gpt-5-mini", pay: "key", base: "https://api.example.com/v1/" },
    { id: "ex3", model: "m", pay: "extension" }, { id: "ex4", model: "m", pay: "key" }, { id: "ex1", model: "again", pay: "tickets" }, { id: "x", model: "m", pay: "tickets" }
  ] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.expressionProfiles)), [
    { id: "ex1", name: "Cues", model: "anthropic/claude-haiku-5.5", prompt: "Add cues.", pay: "tickets", base: "" },
    { id: "ex2", name: "Mine", model: "gpt-5-mini", prompt: "", pay: "key", base: "https://api.example.com/v1" }
  ]);
  assert.deepStrictEqual(saved.translateProfiles.map((p) => p.id), ["tr1"], "the translation ones are not mixed with them");
  saved = await A.api("PUT", "/api/settings", { novelProfiles: { "wtr-lab:9": "ex1" }, translateProfile: "ex1" });
  assert.ok(saved.novelProfiles === undefined && saved.translateProfile === undefined, "and a translation choice cannot be an expression profile");
  saved = await A.api("PUT", "/api/settings", { translateProfiles: [] });
  assert.strictEqual(saved.expressionProfiles.length, 2, "a field left out is as it was");
  saved = await A.api("PUT", "/api/settings", { expressionProfiles: [] });
  assert.strictEqual(saved.expressionProfiles, undefined, "none left: none kept");
  // a person's own terms from the site (origin "yours"): kept when an import could not read them (keepYours), gone when the site no longer has them,
  // and the readers' most used rendering never replaces them
  const Y = encodeURIComponent("wtr-lab:777");
  await A.api("POST", `/api/glossaries/${Y}/import`, { name: "y", site: "wtr-lab", rawId: "777", slug: "y", terms: [["八臂族", "Eight Armed Race", { o: "yours" }], ["道", "Dao", { o: "shared:Cultivation" }]] });
  await A.api("POST", `/api/glossaries/${Y}/votes`, { votes: [["八臂族", [["Octos", 50], ["Eight Armed Race", 2]]], ["道", [["Way", 50], ["Dao", 2]]]] });
  let yg = await A.api("GET", `/api/glossaries/${Y}`);
  assert.deepStrictEqual(yg.terms.map((t) => [t[0], t[1]]), [["八臂族", "Eight Armed Race"], ["道", "Way"]], "votes change a shared term, not one of yours");
  await A.api("POST", `/api/glossaries/${Y}/import`, { name: "y", terms: [["道", "Dao", { o: "shared:Cultivation" }]], keepYours: true });
  yg = await A.api("GET", `/api/glossaries/${Y}`);
  assert.ok(yg.terms.some((t) => t[0] === "八臂族"), "the translation site could not be asked for the person's terms: the ones the library has stay");
  await A.api("POST", `/api/glossaries/${Y}/import`, { name: "y", terms: [["道", "Dao", { o: "shared:Cultivation" }]] });
  yg = await A.api("GET", `/api/glossaries/${Y}`);
  assert.ok(!yg.terms.some((t) => t[0] === "八臂族"), "asked, and no longer there: removed");
  await A.api("DELETE", `/api/glossaries/${Y}`);
  // the language chapters are translated into: a code, kept; English is none; anything else is not a language
  assert.strictEqual((await A.api("PUT", "/api/settings", { targetLanguage: "es" })).targetLanguage, "es");
  assert.strictEqual((await A.api("PUT", "/api/settings", { targetLanguage: "Spanish!" })).targetLanguage, "es", "not a code: ignored");
  assert.strictEqual((await A.api("PUT", "/api/settings", { targetLanguage: "en" })).targetLanguage, undefined, "English is the default: none kept");
  // the Gemini model chapters are translated with: a model name, kept; anything else is ignored; blank puts the extension's own default back
  assert.strictEqual((await A.api("PUT", "/api/settings", { geminiModel: " gemini-3.5-flash " })).geminiModel, "gemini-3.5-flash");
  assert.strictEqual((await A.api("PUT", "/api/settings", { geminiModel: "bad model!" })).geminiModel, "gemini-3.5-flash", "not a model name: ignored");
  assert.strictEqual((await A.api("PUT", "/api/settings", { geminiModel: "" })).geminiModel, undefined, "none kept");
  // agreeing to add one's terms to a public pool: off until the person says so, and when they did is kept
  assert.strictEqual((await A.api("GET", "/api/settings")).sharePool, false, "off by default");
  let sp = await A.api("PUT", "/api/settings", { sharePool: true });
  assert.ok(sp.sharePool === true && sp.sharePoolAt > 0, "on, with when");
  sp = await A.api("PUT", "/api/settings", { termNotesAi: false });
  assert.ok(sp.sharePool === true && sp.sharePoolAt > 0, "another setting changed: still as it was");
  sp = await A.api("PUT", "/api/settings", { sharePool: false });
  assert.ok(sp.sharePool === false && sp.sharePoolAt === undefined, "off again: no date");
  // a novel's glossary in another language, made by Gemini: terms are only ever added; one edited or deleted by the person stays theirs
  const ES = encodeURIComponent("wtr-lab:778@es");
  let added = await A.api("POST", `/api/glossaries/${ES}/add`, { name: "novel (es)", site: "wtr-lab", rawId: "778", slug: "n", terms: [["道", "Camino"], ["火", "Fuego"], ["", "x"], ["x"]] });
  assert.strictEqual(added.added, 2);
  added = await A.api("POST", `/api/glossaries/${ES}/add`, { terms: [["道", "Otro"], ["水", "Agua"]] });
  assert.strictEqual(added.added, 1, "only what is new");
  let eg = await A.api("GET", `/api/glossaries/${ES}`);
  assert.deepStrictEqual(eg.terms.map((t) => [t[0], t[1], t[2], t[3].o]), [["道", "Camino", "gemini", "gemini"], ["火", "Fuego", "gemini", "gemini"], ["水", "Agua", "gemini", "gemini"]], "the first rendering stays; Gemini's own");
  await A.api("POST", `/api/glossaries/${ES}/edit`, { set: [["道", "Sendero"]], remove: ["火"] });
  added = await A.api("POST", `/api/glossaries/${ES}/add`, { terms: [["道", "Camino"], ["火", "Lumbre"]] });
  assert.strictEqual(added.added, 0, "an edited term is not overwritten, a deleted one not brought back");
  eg = await A.api("GET", `/api/glossaries/${ES}`);
  assert.deepStrictEqual(eg.terms.map((t) => [t[0], t[1]]), [["道", "Sendero"], ["水", "Agua"]]);
  await A.api("DELETE", `/api/glossaries/${ES}`);
  // what a novel's readers are sent with it (glossaryFor): the glossaries bound to its keys and their other languages, a deleted term left out, each term with its list
  const GES = encodeURIComponent(G + "@es");
  await A.api("POST", `/api/glossaries/${GES}/add`, { name: "wizard (es)", terms: [["科雷", "Corey"], ["黑", "Negro"]] });
  const sent = A.glossaryFor(["69shuba.com/txt/1"]);
  assert.deepStrictEqual(Object.keys(sent.langs).sort(), ["en", "es"], "the glossary and its Spanish one");
  assert.deepStrictEqual(sent.langs.en.find((r) => r[0] === "密林小屋"), ["密林小屋", "Forest Hut", "ai"], "the rendering as the glossary has it now (the readers' most used one)");
  assert.strictEqual(sent.langs.es.length, 2);
  assert.ok(sent.ver[0] > 1, "with a version that changes when a glossary does");
  assert.strictEqual(A.glossaryFor(["nothing/here"]), null, "a novel with no glossary sends none");
  await A.api("DELETE", `/api/glossaries/${GES}`);
  // the terms of a copied novel: kept with the list they were in (shared, novel...), counted by list, the first rendering stays
  const COPY = encodeURIComponent("copy:abc");
  added = await A.api("POST", `/api/glossaries/${COPY}/add`, { from: "copied", name: "N (copied)", terms: [["道", "Dao", "shared:Cultivation"], ["火", "Fire", "novel"], ["水", "Water"]] });
  assert.strictEqual(added.added, 3);
  added = await A.api("POST", `/api/glossaries/${COPY}/add`, { from: "copied", terms: [["道", "Way"], ["风", "Wind", "ai"]] });
  assert.strictEqual(added.added, 1, "only what is new");
  const cg = await A.api("GET", `/api/glossaries/${COPY}`);
  assert.deepStrictEqual(cg.terms.map((t) => [t[0], t[1], t[2], t[3].o]), [["道", "Dao", "copied", "shared:Cultivation"], ["火", "Fire", "copied", "novel"], ["水", "Water", "copied", "novel"], ["风", "Wind", "copied", "ai"]]);
  assert.deepStrictEqual((await A.api("GET", "/api/glossaries")).glossaries.find((x) => x.id === "copy:abc").origins, { shared: 1, novel: 2, ai: 1 }, "counted by the list");
  await A.api("DELETE", `/api/glossaries/${COPY}`);
  await A.api("PUT", "/api/my-ratings/" + enc, { rate: 4 });
  await A.api("PUT", "/api/novel-links", { merges: [["a", "b"]] });
  await A.api("PUT", "/api/watches/" + encodeURIComponent(G + "|69shuba.com"), { on: true, hours: 6, then: "fetch", name: "Synthesis Wizard" });
  const days = async (d) => (await A.api("PUT", "/api/watches/" + encodeURIComponent(G + "|69shuba.com"), { on: true, hours: 6, then: "fetch", name: "Synthesis Wizard", days: d })).watch.days;
  assert.deepStrictEqual(await days([5, "5", 0, 9, "x"]), [0, 5], "days of the week are kept sorted, once each, 0 to 6 only");
  assert.deepStrictEqual(await days([0, 1, 2, 3, 4, 5, 6]), [], "every day is none");
  assert.deepStrictEqual(await days(undefined), [], "no days: every day");
  await A.api("POST", "/api/notices", { novel: G, source: "69shuba.com", latest: "https://69shuba.com/txt/1/3", count: 1 });
  await A.api("PUT", "/api/comment-links", { key: "69shuba.com/txt/1", novel: G });
  await A.api("PUT", "/api/comment-identity", { key: "k".repeat(24), name: "me" });
  assert.ok(toB.length > 10, "every change became records");
  assert.ok(toB.some((r) => r.body && /Synthesis/.test(r.body)) && toB.every((r) => r.lib === undefined), "records are plain, with no library id");
  const results = await deliver(toB, B);
  // (every record is taken, or is no newer than one B holds: a part of a glossary B merged with its own terms and published again is newer than what A wrote before it)
  assert.ok(results.every((x) => x.stored || x.why === "not newer"), "B keeps every record of A, or has a newer one");
  for (const p of ["/api/glossaries", "/api/glossaries/" + enc, "/api/bindings", "/api/novels", "/api/chapter-index", "/api/my-terms", "/api/term-notes", "/api/settings", "/api/my-ratings", "/api/novel-links", "/api/watches", "/api/notices", "/api/comment-links", "/api/comment-identity"]) {
    assert.deepStrictEqual(norev(await B.api("GET", p)), norev(await A.api("GET", p)), p + " is the same in both copies");
  }
  const bw = (await B.api("GET", "/api/watches")).watches[0];
  assert.deepStrictEqual([bw.then, bw.name, bw.hours], ["fetch", "Synthesis Wizard", 6], "a watch keeps what it does with what it finds, and the novel's name");
  // a look written back without `then` (as an extension of an older build writes it after each look) keeps the choice, in both copies
  await B.api("PUT", "/api/watches/" + encodeURIComponent(G + "|69shuba.com"), { on: true, hours: 6, lastCheck: 5, lastResult: "no new chapters" });
  await deliver(toA, A);
  for (const [who, dev] of [["B", B], ["A", A]]) {
    const w = (await dev.api("GET", "/api/watches")).watches[0];
    assert.deepStrictEqual([w.then, w.name, w.lastResult], ["fetch", "Synthesis Wizard", "no new chapters"], who + ": the look is kept, and so is what the person chose");
  }
  // and a watch record an older build wrote (no `then` in it at all) still reads as chosen: the choice is kept in the settings, which such a build
  // keeps as they are
  const LibraryApi = require("../src/shared/library-api.js");
  const old = LibraryApi.createLibraryApi({ state: LibraryApi.normalizeState({ watches: { "n|wtr-lab.com": { id: "n|wtr-lab.com", novel: "n", source: "wtr-lab.com", on: true, known: 644 } },
    settings: { copyCovers: true, watchModes: { "n|wtr-lab.com": { then: "all", name: "N" } } } }), persist: () => {} });
  const ow = (await old.handle("GET", "/api/watches")).watches[0];
  assert.deepStrictEqual([ow.then, ow.name, ow.known], ["all", "N", 644], "read with the choice laid over it");
  await old.handle("PUT", "/api/settings", { copyCovers: false });
  assert.strictEqual((await old.handle("GET", "/api/watches")).watches[0].then, "all", "saving the settings keeps the choices");
  await old.handle("PUT", "/api/watches/" + encodeURIComponent("n|wtr-lab.com"), { on: true, then: "tell" });
  assert.strictEqual((await old.handle("GET", "/api/watches")).watches[0].then, "tell", "and choosing again changes it");
  // "fetch": the new ones are those past the list's last chapter when it was chosen, kept while it stays chosen
  await old.handle("PUT", "/api/watches/" + encodeURIComponent("n|wtr-lab.com"), { on: true, then: "fetch", above: 644 });
  await old.handle("PUT", "/api/watches/" + encodeURIComponent("n|wtr-lab.com"), { on: true, then: "fetch", known: 650, above: 650 });
  assert.strictEqual((await old.handle("GET", "/api/watches")).watches[0].above, 644, "where the new ones start is kept (a look moving on does not move it)");
  // each site's wait, in the settings, kept by a save of something else; a novel's own wait, on its watch
  await old.handle("PUT", "/api/settings", { siteWaits: { "www.ranobes.top": 8, "wtr-lab.com": 4.5 } });
  await old.handle("PUT", "/api/settings", { copyCovers: true, siteWaits: { "ranobes.top": null } });
  assert.deepStrictEqual((await old.handle("GET", "/api/settings")).siteWaits, { "wtr-lab.com": 4.5 }, "kept; null takes a site's back to its own");
  await old.handle("PUT", "/api/settings", { siteWaits: { "wtr-lab.com": 9999 } });
  assert.strictEqual((await old.handle("GET", "/api/settings")).siteWaits["wtr-lab.com"], 300, "a wait is at most 300 s");
  await old.handle("PUT", "/api/watches/" + encodeURIComponent("n|wtr-lab.com"), { on: true, wait: 3 });
  await old.handle("PUT", "/api/watches/" + encodeURIComponent("n|wtr-lab.com"), { on: true, lastResult: "a look" });
  assert.strictEqual((await old.handle("GET", "/api/watches")).watches[0].wait, 3, "a novel's own wait, kept when a look writes the watch");
  await old.handle("PUT", "/api/watches/" + encodeURIComponent("n|wtr-lab.com"), { on: true, wait: null });
  assert.strictEqual((await old.handle("GET", "/api/watches")).watches[0].wait, undefined, "null: the site's again");
  const cover = await B.api("GET", "/api/covers/" + enc);
  assert.deepStrictEqual([cover.type, [...cover.bytes]], ["image/png", [...PNG]], "the cover's picture came over");
  // /api/sync on B sees the glossary that arrived, as the extension's sync would
  const sync = await B.api("GET", "/api/sync?since=0");
  assert.deepStrictEqual(sync.glossaries.map((g) => g.id), [G]);
  assert.strictEqual(sync.glossaries[0].terms.find((t) => t[0] === "密林小屋")[1], "Forest Hut", "the votes came over");

  // the same record again, or an older one, is not kept twice
  const again = A.get("novel:" + G);
  assert.strictEqual((await B.receive(again)).stored, false);

  // ---- the two copies changing terms of one glossary at once: both changes stay ----
  // (two words in the same part of the glossary, so it is one record changed on both sides)
  const sources = ["科雷", "希恩", "密林小屋"];
  let w1 = null;
  let w2 = null;
  for (let i = 0; !w2; i++) {
    const s = "词" + i;
    if (Library.bucketOf(s) !== Library.bucketOf(sources[0])) continue;
    if (!w1) w1 = s; else w2 = s;
  }
  await A.api("POST", `/api/glossaries/${enc}/edit`, { set: [[w1, "From Laptop"]] });
  await B.api("POST", `/api/glossaries/${enc}/edit`, { set: [[w2, "From Phone"]] });
  const fromA = toB.splice(0);
  const fromB = toA.splice(0);
  await deliver(fromB, A);
  await deliver(fromA, B);
  await deliver(toB, B); // what A wrote again after merging
  await deliver(toA, A);
  for (const dev of [A, B]) {
    const terms = (await dev.api("GET", "/api/glossaries/" + enc)).terms;
    assert.ok(terms.some((t) => t[0] === w1 && t[1] === "From Laptop") && terms.some((t) => t[0] === w2 && t[1] === "From Phone"), "both edits are kept");
  }
  assert.deepStrictEqual(norev(await A.api("GET", "/api/glossaries/" + enc)), norev(await B.api("GET", "/api/glossaries/" + enc)), "and the copies agree");
  assert.strictEqual(toA.length + toB.length, 0, "and stop writing once they agree");

  // a deleted term stays deleted in the other copy
  await B.api("POST", `/api/glossaries/${enc}/edit`, { remove: ["希恩"] });
  await deliver(toA, A);
  assert.ok(!(await A.api("GET", "/api/glossaries/" + enc)).terms.some((t) => t[0] === "希恩"));
  // and so does a removed term of yours
  await A.api("DELETE", "/api/my-terms/abcd1");
  await deliver(toB, B);
  assert.deepStrictEqual((await B.api("GET", "/api/my-terms")).terms, []);

  // ---- what must be refused ----
  const good = A.get("novel:" + G);
  const later = (r) => Object.assign({}, r, { ver: [good.ver[0] + 1, 0, "x"] });
  assert.strictEqual((await B.receive(later(Object.assign({}, good, { v: 1 })))).why, "malformed", "a record of before (encrypted)");
  assert.strictEqual((await B.receive(Object.assign({}, good, { ver: [1, 0] }))).why, "malformed", "a version that is not one");
  assert.strictEqual((await B.receive(later(Object.assign({}, good, { key: "devices" })))).why, "unknown kind", "a kind the library does not have");
  assert.strictEqual((await B.receive(later(Object.assign({}, good, { body: "{not json" })))).why, "cannot be read");
  assert.strictEqual((await B.receive(later(Object.assign({}, good, { body: "x".repeat(3 * 1024 * 1024) })))).why, "too big");

  // ---- loading again from what was kept ----
  const A2 = await Library.open({ adapter: adA });
  for (const p of ["/api/glossaries/" + enc, "/api/novels", "/api/term-notes", "/api/notices", "/api/settings"]) {
    assert.deepStrictEqual(norev(await A2.api("GET", p)), norev(await A.api("GET", p)), p + " after loading again");
  }
  // the clock goes on from where it was: what A2 writes is newer than everything A wrote
  await A2.api("PUT", "/api/novels/" + enc, { title: "Synthesis Wizard!" });
  assert.ok(A2.wants("x", [1, 0, ""]) && Library.cmpVer(A2.get("novel:" + G).ver, good.ver) > 0);

  // ---- a library kept before 2026-11: its records encrypted with the owner key, read and written again as plain ones ----
  {
    const subtle = webcrypto.subtle;
    const raw = webcrypto.getRandomValues(new Uint8Array(32));
    const key = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
    const b64 = (u) => Buffer.from(u).toString("base64");
    const seal = async (body) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      return { iv: b64(iv), body: b64(new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(body))))) };
    };
    const me = "0123456789abcdef";
    const lib = "the library's id";
    const ver = (n) => [1700000000000 + n, 0, me];
    const ad = Library.memoryAdapter();
    await ad.setMeta({ device: { id: me, name: "Laptop", pub: "p", priv: "q", dhPub: "d", dhPriv: "e" }, hlc: [1700000000009, 0], libId: lib, root: { priv: "r" }, ownerKey: b64(raw), keys: { 0: b64(raw) }, gen: 0 });
    await ad.putRecords([
      { v: 1, lib, key: "devices", ver: ver(1), by: "root", iv: null, body: "[]", sig: "s" },
      { v: 1, lib, key: "dh:" + me, ver: ver(2), by: me, iv: null, body: "{}", sig: "s" },
      Object.assign({ v: 1, lib, key: "novel:" + G, ver: ver(3), by: me, sig: "s" }, await seal({ id: G, title: "Synthesis Wizard", addedAt: 1, updatedAt: 1 })),
      { v: 1, lib, key: "term:gone", ver: ver(4), by: me, iv: null, body: null, sig: "s" },
      Object.assign({ v: 1, lib, key: "settings", ver: ver(5), by: me, sig: "s", kg: 1 }, await seal({ copyCovers: false })) // (a key this copy never had)
    ]);
    const M = await Library.open({ adapter: ad });
    assert.deepStrictEqual((await M.api("GET", "/api/novels")).novels.map((n) => n.title), ["Synthesis Wizard"], "its novels are read");
    const kept = await ad.load();
    assert.deepStrictEqual(kept.meta, { id: me, hlc: [1700000000009, 0] }, "no id or keys are kept");
    assert.deepStrictEqual(kept.records.map((r) => [r.key, r.v, r.ver[0], r.body === null]).sort(), [["novel:" + G, 2, ver(3)[0], false], ["term:gone", 2, ver(4)[0], true]],
      "plain records with their versions; the devices, their keys and what could not be read are gone");
    assert.ok(kept.records.every((r) => !("lib" in r) && !("sig" in r) && !("iv" in r)));
    const M2 = await Library.open({ adapter: ad });
    assert.deepStrictEqual(norev(await M2.api("GET", "/api/novels")), norev(await M.api("GET", "/api/novels")), "opened again: the same");
  }

  // ---- moving the glossary server's data in ----
  const E = await Library.open({ adapter: Library.memoryAdapter() });
  // a server state with a deleted term of yours (which a site import must not bring back) and the site's own wording of a term you changed
  const serverState = require("../src/shared/library-api.js").normalizeState({
    rev: 7,
    glossaries: { [G]: { id: G, name: "wizard", site: "wtr-lab", rawId: "8053", slug: "w", createdAt: 1, updatedAt: 2, rev: 7, terms: {
      "科雷": { t: "Kory", w: "Corey", src: "user", o: "novel", updatedAt: 5, rev: 6 },
      "希恩": { t: "Sheen", src: "user", o: "novel", deleted: true, updatedAt: 6, rev: 7 }
    } } },
    novels: { [G]: { id: G, title: "Synthesis Wizard", addedAt: 1, updatedAt: 1 } },
    covers: { [G]: { type: "image/png", size: PNG.length, at: 3, hash: "h" }, "gone": { type: "image/png", size: 1, at: 1, hash: "g" } },
    ratings: { "something from another branch": 1 }
  });
  const imported = await E.importState(serverState, { [G]: PNG });
  assert.ok(imported.records >= 4);
  let gE = await E.api("GET", "/api/glossaries/" + enc);
  assert.deepStrictEqual(gE.terms.map((t) => t.slice(0, 3)), [["科雷", "Kory", "user"]], "the deleted term stays deleted");
  await E.api("POST", `/api/glossaries/${enc}/import`, { terms: [["科雷", "Corey"], ["希恩", "Sheen"]] });
  gE = await E.api("GET", "/api/glossaries/" + enc);
  assert.deepStrictEqual(gE.terms.map((t) => t.slice(0, 2)), [["科雷", "Kory"]], "a translation-site import neither overwrites your term nor brings back the one you deleted");
  assert.deepStrictEqual((await E.api("GET", "/api/novels")).novels.map((n) => [n.id, n.coverCopy]), [[G, true]], "covers whose picture came are kept");
  await assert.rejects(E.api("GET", "/api/covers/gone"), /no copy/);
  // importing again replaces the library's content: what is no longer there is deleted
  await E.importState(require("../src/shared/library-api.js").normalizeState({ novels: {} }), {});
  assert.deepStrictEqual((await E.api("GET", "/api/novels")).novels, []);
  assert.strictEqual(E.get("novel:" + G).body, null, "the novel's record says it is gone");

  console.log("OK — library checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
