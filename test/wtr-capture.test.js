// End-to-end test of wtr-capture.js with a fake the site page and API, the real extension client and a library in this process
// (library-stand-in.js). No traffic reaches the site. Run: node test/wtr-capture.test.js
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { libraryStandIn } = require("./library-stand-in.js");
const WtrTerms = require("../src/shared/wtr-terms.js");

const RAW = "8053";
const ID = "wtr-lab:" + RAW;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error("timed out waiting for: " + what);
}
const settle = () => sleep(250); // long enough for several 15 ms ticks to run if they were going to

function fakeStorage() {
  const data = {};
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    data,
    get: async (keys) => {
      if (keys == null) return clone(data);
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    set: async (o) => Object.assign(data, clone(o))
  };
}

// ---- a fake wtr-lab: the terms file in the site's shape, and per-term vote answers that include account IDs ----
const novel = [["科雷", "Corey"], ["希恩", "Sheen"], ["银月花", "Silver Moon Flower"]];
const ai = [["星盟", "Star Alliance", "Xingmeng"], ["权杖", "Scepter", "Staff"]];
const shared = [["道", "Dao"], ["外门弟子", "Outer Sect Disciple"]];
const TERMS_JSON = {
  success: true, raw_id: 8053,
  glossaries: [
    { raw_id: 8053, data: { type: "raw", terms: novel.map(([s, e]) => [[e], s, 1, 0, 0]) } },
    { id: 17, title: "Cultivation", data: { type: "generic", terms: shared.map(([s, e]) => [[e], s, 1, 3, 0]) } },
    { raw_id: 8053, data: { type: "raw", build: 26, terms: ai.map(([s, ...e]) => [e, s, 2, 3, 100]) } }
  ]
};
// the person's own terms on the site (/api/v2/user/config): one for this novel (it beats the AI-built "Scepter"), one for every novel, one that is a fix of English
const USER_CONFIG = { success: true, config: { version: 1, date: 1, terms: [
  ["1", "Scepter of Light", "权杖", false, [7954], 8053],
  ["2", "taken action", "出手", false, null, 0],
  ["3", "English Fix", "Some words", false, [7954], 8053]
] } };
const VOTES = {
  "银月花": [["Silver Moon Flower", 24], ["silvermoon flower", 4], ["Silver Moonflower", 2]],
  "科雷": [["Corey", 52], ["Cole", 3]],
  "星盟": [["Xingmeng", 9], ["Star Alliance", 4]], // AI-built: the most-used rendering should win
  "道": [["Dao", 30]],
  "希恩": [["Sheen", 7]]
};

const NOVEL_JSON = { pageProps: { serie: { serie_data: {
  id: 7954, slug: "synthesis-wizard", chapter_count: 334, rating: 4.0110497, view: 721136, tags: [717, 755, 999],
  data: { title: "Synthesis Wizard", author: "Shi Mian Bu Ru Xie Shu", description: "After traveling...\n\nSecond paragraph.", raw: { title: "", author: "失眠不如写书" }, image: "https://img.wtr-lab.com/cdn/series/x.webp" }
} }, tags: [{ id: 717, title: "Transmigration" }, { id: 755, title: "Wizards" }] } };

// A chapter as the site's reader renders it.
function fakeTracker({ no, rawId = RAW, title, paragraphs, model = "gemini-3.5-flash-lite", dupTitle = false }) {
  const lines = (dupTitle ? [title, title, ...paragraphs] : [title, ...paragraphs]).map((t) => ({ innerText: t }));
  const container = {
    querySelectorAll: (sel) => (sel === ".wtr-line" ? lines : []),
    querySelector: (sel) => (sel === ".separator" ? { innerText: model } : null)
  };
  return {
    getAttribute: (n) => ({ "data-chapter-no": String(no), "data-raw-id": String(rawId) })[n] || null,
    querySelector: (sel) => (sel === ".chapter-container" ? container : null),
    setParagraphs: (p) => lines.splice(1, lines.length, ...p.map((t) => ({ innerText: t })))
  };
}
const longPara = (n) => ("Paragraph " + n + " of the chapter, long enough to count as real text. ").repeat(3);

function startFakeWtr() {
  const state = { requests: {}, order: [], status: 200 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === `/api/v2/reader/terms/${RAW}.json`) return res.end(JSON.stringify(TERMS_JSON));
    if (u.pathname === "/api/v2/user/config") {
      state.configFetches = (state.configFetches || 0) + 1;
      if (state.signedOut) { res.statusCode = 401; return res.end("{}"); }
      return res.end(JSON.stringify(USER_CONFIG));
    }
    if (u.pathname === `/api/chapters/${RAW}`) {
      state.listFetches = (state.listFetches || 0) + 1;
      return res.end(JSON.stringify({ chapters: [
        { serie_id: 1, id: 11, order: 1, title: "Chapter 1 Synthesis Cube", name: "第1章 合成魔方", updated_at: "2026-10-09" },
        { serie_id: 1, id: 12, order: 2, title: "Chapter 2 The Illusory Legend", name: "第2章 虚幻传说", updated_at: "2026-10-09" },
        { serie_id: 1, id: 13, order: 3, title: "Chapter 3 Lesser Dragon Blood Potion", name: "第3章 次级龙血药剂", updated_at: "2026-10-09" },
        { serie_id: 1, id: 14, order: "bad", title: "dropped: no number", name: "" }
      ] }));
    }
    if (u.pathname === `/_next/data/BUILD123/en/novel/${RAW}/synthesis-wizard.json`) { state.novelFetches = (state.novelFetches || 0) + 1; return res.end(JSON.stringify(NOVEL_JSON)); }
    if (u.pathname === "/api/v2/term-preferences") {
      const hash = u.searchParams.get("hash");
      state.requests[hash] = (state.requests[hash] || 0) + 1;
      state.order.push(hash);
      state.last = { source_id: u.searchParams.get("source_id"), lang: u.searchParams.get("lang") };
      if (state.status !== 200) { res.statusCode = state.status; return res.end("{}"); }
      const data = (VOTES[hash] || []).map(([to, n]) => ({ to, lang: "en", userCount: n, users: Array.from({ length: n }, (_, i) => `acct-${hash}-${i}-0000-0000-0000`) }));
      return res.end(JSON.stringify({ success: true, data }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, state, base: "http://127.0.0.1:" + server.address().port })));
}

// ---- the extension's real library client, loaded the way the background script loads it (it asks globalThis.LibraryHost) ----
function loadClient(storage) {
  globalThis.chrome = { storage: { local: storage } };
  delete globalThis.GlossaryServer;
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "glossary-server.js"), "utf8") + "\n;globalThis.GlossaryServer = GlossaryServer;");
  return globalThis.GlossaryServer;
}

// Runs wtr-capture.js as a content script on a site page. `page.terms` are the glossary terms the site has marked in the
// text on screen. Time is a fake clock the test controls; sleeps are skipped; everything else is real.
function runContentScript({ href, storage, wtrBase, G, page, clock, calls }) {
  const intervals = [];
  const handler = async (m) => {
    calls[m.type] = (calls[m.type] || 0) + 1;
    if (m.type === "glossary:import") return G.importSnapshot(m.record);
    if (m.type === "wtr:myterms") { (calls.myterms = calls.myterms || []).push(m); return G.syncPersonalReplacements(m.rawId, m.novel, m.terms); }
    if (m.type === "glossary:votes") return G.sendVotes(m.id, m.votes);
    if (m.type === "glossary:pull") return G.pull();
    if (m.type === "wtr:rawhost") return { host: "uuread.tw", first: "https://www.uuread.tw/chapter/1878627/2213453.html" }; // the background finds where the site's Raw link leads
    if (m.type === "chapterindex:save") return G.saveChapterIndex(m.record);
    if (m.type === "novel:save") return G.saveNovel(m.info);
    return null;
  };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.t])); }
    static now() { return clock.t; }
  }
  let clickHandler = null;
  const ctx = {
    location: { href },
    document: { addEventListener: (type, fn) => { if (type === "click") clickHandler = fn; }, querySelectorAll: (sel) => (sel.includes("chapter-tracker") ? (page.trackers || []) : page.terms.map((h) => ({ getAttribute: (n) => (n === "data-hash" ? h : null) }))), getElementById: (id) => (id === "__NEXT_DATA__" ? { textContent: JSON.stringify({ buildId: "BUILD123" }) } : null) },
    // as in a Firefox content script, which fetches as the extension: a bare "/api/..." is no address there (it threw, and nothing of the site was recorded on Firefox)
    fetch: (u, opts) => (u.startsWith("/") ? Promise.reject(new TypeError(u + " is not a valid URL.")) : fetch(u.replace(/^https:\/\/wtr-lab\.com\//, wtrBase + "/"), opts)),
    chrome: { storage: { local: { ...storage, get: (k) => (Array.isArray(k) && k.includes("libraryOn") ? Promise.resolve({ libraryOn: { libId: "test" } }) : storage.get(k)), set: (o) => storage.set(o) } }, runtime: { sendMessage: handler } },
    WtrTerms,
    setTimeout: (fn) => setImmediate(fn),
    setInterval: (fn) => { const h = setInterval(fn, 15); intervals.push(h); return h; },
    console, Promise, JSON, Object, Math, URL, encodeURIComponent, Date: FakeDate
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "wtr-capture.js"), "utf8"), ctx);
  // (the handler is there once the script found the extension in a library: a moment after it starts)
  const click = async (term) => { while (!clickHandler) await new Promise((r) => setImmediate(r)); clickHandler({ target: { closest: (sel) => (sel.includes("text-patch") ? { getAttribute: (n) => (n === "data-hash" ? term : null) } : null) } }); };
  return { stop: () => intervals.forEach(clearInterval), click };
}

(async () => {
  const lib = libraryStandIn();
  globalThis.LibraryHost = lib.host;
  const wtr = await startFakeWtr();
  const href = `https://wtr-lab.com/en/novel/${RAW}/synthesis-wizard/chapter-1`;
  const serverGlossary = () => lib.api("GET", "/api/glossaries/" + encodeURIComponent(ID)).catch(() => null);
  const term = (g, s) => g.terms.find((t) => t[0] === s);
  const requested = () => Object.keys(wtr.state.requests).sort();
  const resetRequests = () => { Object.keys(wtr.state.requests).forEach((k) => delete wtr.state.requests[k]); wtr.state.order.length = 0; };
  const DAY = 24 * 60 * 60 * 1000;

  // ============ 1. reading a chapter: glossaries go up with origins; counts only for the terms you click ============
  const storage = fakeStorage();
  const G = loadClient(storage);
  const clock = { t: Date.now() };
  const calls = {};
  const page = { terms: ["银月花", "科雷", "星盟", "道", "不在词表"] }; // "not in the glossary" is on screen too
  const script = runContentScript({ href, storage, wtrBase: wtr.base, G, page, clock, calls });

  await until(async () => (await serverGlossary()) !== null, "the glossary to reach the library");
  await settle();
  assert.deepStrictEqual(requested(), [], "nothing is requested from wtr-lab until a term is clicked");
  assert.strictEqual((await serverGlossary()).countedTerms || 0, 0);
  for (const t of ["银月花", "科雷", "星盟", "道", "不在词表"]) script.click(t); // "not in the glossary" is clicked too
  await until(async () => ((await serverGlossary()) || { countedTerms: 0 }).countedTerms >= 4, "counts for the clicked terms");
  let g = await serverGlossary();
  assert.strictEqual(g.termCount, 8, "novel (3) + AI-built (2) + shared (2) + one of yours for every novel (the one for this novel took an AI-built term's place)");
  assert.deepStrictEqual([term(g, "权杖")[1], term(g, "权杖")[3].o, term(g, "出手")[1], term(g, "出手")[3].o], ["Scepter of Light", "yours", "taken action", "yours"], "the person's own terms from wtr-lab come first, as theirs");
  assert.ok(!g.terms.some((x) => x[1] === "English Fix"), "a fix of wtr-lab's English is not a term of the glossary");
  assert.deepStrictEqual(calls.myterms.map((m) => m.terms), [[{ id: "wtr-3", from: ["Some words"], to: "English Fix", cs: false, global: false }]], "it goes to the library's terms (shown after the translation), once, with this novel's own");
  assert.strictEqual(calls.myterms[0].rawId, RAW);
  assert.deepStrictEqual(["科雷", "星盟", "道"].map((s) => term(g, s)[3].o), ["novel", "ai", "shared:Cultivation"]);
  assert.deepStrictEqual(term(g, "银月花")[3].v, [["Silver Moon Flower", 24], ["silvermoon flower", 4], ["Silver Moonflower", 2]], "the 24 / 4 / 2 from the wtr-lab page");
  assert.strictEqual(term(g, "银月花")[3].n, 24);
  assert.strictEqual(term(g, "科雷")[1], "Corey", "curated wording untouched");
  assert.strictEqual(term(g, "星盟")[1], "Xingmeng", "an uncurated term switches to the rendering most readers chose");
  assert.strictEqual(term(g, "道")[3].n, 30);
  assert.deepStrictEqual(requested(), ["不在词表", "星盟", "科雷", "道", "银月花"].sort(), "asked about exactly the clicked terms, nothing else");
  assert.ok(Object.values(wtr.state.requests).every((n) => n === 1));
  assert.strictEqual(term(g, "希恩")[3].n, undefined, "a term that was not clicked is not asked about");
  assert.deepStrictEqual(wtr.state.last, { source_id: "id.raw." + RAW, lang: "en" });
  // privacy: the account IDs the site returned never reach the library or local storage
  const everything = JSON.stringify(lib.state) + JSON.stringify(storage.data);
  assert.ok(!everything.includes("acct-"), "no account IDs are stored anywhere");
  assert.ok(!("wtrVotes" in storage.data), "there is no manual fetch job any more");
  assert.strictEqual(storage.data.wtrCapturedAt[RAW].v, 4);

  // ============ 1b. the novel's display info goes up too, for the site's novel page ============
  const novelsList = async () => (await lib.api("GET", "/api/novels")).novels;
  await until(async () => (await novelsList()).length === 1, "the novel info to reach the library");
  const nv = (await novelsList())[0];
  assert.deepStrictEqual([nv.id, nv.title, nv.author, nv.authorRaw, nv.cover, nv.chapterCount], ["wtr-lab:8053", "Synthesis Wizard", "Shi Mian Bu Ru Xie Shu", "失眠不如写书", "https://img.wtr-lab.com/cdn/series/x.webp", 334]);
  assert.deepStrictEqual(nv.tags, ["Transmigration", "Wizards"], "tag ids are turned into names; unknown ids are dropped");
  assert.strictEqual(nv.url, "https://wtr-lab.com/en/novel/8053/synthesis-wizard");
  assert.strictEqual(nv.rawHost, "uuread.tw", "the novel's raw source site goes up with its info");
  assert.strictEqual(nv.rawFirst, "https://www.uuread.tw/chapter/1878627/2213453.html", "and so does where chapter 1 is on it");
  assert.strictEqual(storage.data.wtrRawHost[RAW].host, "uuread.tw", "and is remembered, so it is looked up once per novel");
  assert.strictEqual(storage.data.wtrRawHost[RAW].first, "https://www.uuread.tw/chapter/1878627/2213453.html");
  assert.strictEqual(nv.synopsis, "After traveling...\n\nSecond paragraph.");
  await settle();
  assert.strictEqual(wtr.state.novelFetches, 1, "it is fetched once, not on every tick");

  // ============ 1b2. the novel's whole chapter list goes up too, so the library can show every chapter ============
  const indexes = async () => (await lib.api("GET", "/api/chapter-index?key=wtr-lab:" + RAW)).indexes;
  await until(async () => (await indexes()).length === 1, "the chapter list to reach the library");
  const ci = (await indexes())[0];
  assert.deepStrictEqual(ci.chapters.map((c) => c[0]), [1, 2, 3], "every numbered chapter; the one without a number is dropped");
  assert.deepStrictEqual(ci.chapters[1], [2, "Chapter 2 The Illusory Legend", "https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-2", "第2章 虚幻传说"], "number, English title, the chapter's own wtr-lab address, original title");
  await settle();
  assert.strictEqual(wtr.state.listFetches, 1, "one request for the list, not one per pass");
  assert.ok(storage.data.wtrChapterListAt[RAW] > 0, "and it is remembered, so the list is never asked for again on a timer");

  // ============ 1c. the chapters you read are saved like any other translated chapter ============
  const ch1 = fakeTracker({ no: 1, title: "Chapter 1: Synthesis Cube", paragraphs: [longPara(1), longPara(2), longPara(3)], model: "Deepseek-Chat", dupTitle: true }); // chapter 1 on the site repeats its title
  const ch2 = fakeTracker({ no: 2, title: "Chapter 2: The Illusory Legend", paragraphs: [longPara(4), longPara(5), longPara(6)] });
  const locked = fakeTracker({ no: 3, title: "Chapter 3: Locked", paragraphs: ["Unlock to read", "x", "y"] }); // a placeholder, not a chapter
  const otherNovel = fakeTracker({ no: 1, rawId: 99999, title: "Chapter 1: Elsewhere", paragraphs: [longPara(7), longPara(8), longPara(9)] });
  const KEY1 = "translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-1";
  const KEY2 = "translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-2";
  page.trackers = [ch1, ch2, locked, otherNovel];
  await until(async () => storage.data[KEY1] && storage.data[KEY2], "both chapters to be saved");
  const saved1 = storage.data[KEY1];
  assert.strictEqual(saved1.pageTitle, "Chapter 1: Synthesis Cube");
  assert.strictEqual(saved1.novelName, "Synthesis Wizard", "named after the novel (from the info fetched above)");
  assert.strictEqual(saved1.model, "wtr-lab · Deepseek-Chat", "records which source and which AI model");
  assert.strictEqual(saved1.translated, [longPara(1), longPara(2), longPara(3)].map((s) => s.trim()).join("\n"), "the title line is not part of the text; one paragraph per line");
  assert.deepStrictEqual(saved1.suggestions, []);
  assert.strictEqual(storage.data[KEY2].model, "wtr-lab · gemini-3.5-flash-lite");
  await settle();
  assert.ok(!Object.keys(storage.data).some((k) => k.includes("chapter-3") || k.includes("99999")), "placeholders and other novels' chapters are not saved");
  // unchanged text is not saved again; changed text is (so the site's re-translations follow)
  const stamp1 = saved1.savedAt;
  await settle();
  assert.strictEqual(storage.data[KEY1].savedAt, stamp1, "unchanged chapter keeps its version");
  clock.t += 1000;
  ch1.setParagraphs([longPara(1), longPara(2), longPara(10)]);
  await until(async () => storage.data[KEY1].translated.includes("Paragraph 10"), "the changed chapter to be saved again");
  assert.ok(storage.data[KEY1].savedAt > stamp1, "a changed chapter gets a newer version");
  // a chapter still streaming in (text changing every pass) waits until it settles
  const streaming = fakeTracker({ no: 4, title: "Chapter 4: Streaming", paragraphs: [longPara(11), longPara(12), longPara(13)] });
  const KEY4 = KEY1.replace("chapter-1", "chapter-4");
  page.trackers.push(streaming);
  let n = 0;
  const grow = setInterval(() => streaming.setParagraphs([longPara(11), longPara(12), longPara(13), longPara(100 + ++n)]), 5);
  await settle();
  assert.ok(!storage.data[KEY4], "not saved while its text keeps changing");
  clearInterval(grow);
  await until(async () => storage.data[KEY4], "the settled chapter to be saved");
  page.trackers = [];

  // ============ 2. clicking an already counted term asks nothing; a new term is counted when clicked ============
  const before = JSON.stringify(wtr.state.requests);
  for (const t of ["银月花", "科雷"]) script.click(t);
  await settle();
  assert.strictEqual(JSON.stringify(wtr.state.requests), before, "terms already counted are not asked about again");
  script.click("希恩");
  await until(async () => term(await serverGlossary(), "希恩")[3].n === 7, "the new term to be counted");
  assert.strictEqual(wtr.state.requests["希恩"], 1);
  assert.ok(Object.entries(wtr.state.requests).filter(([k]) => k !== "希恩").every(([, n]) => n === 1), "and nothing else was repeated");

  // ============ 3. counts go stale after a week; clicking the term then refreshes it, nothing happens by itself ============
  resetRequests();
  clock.t += 8 * DAY;
  await settle();
  assert.deepStrictEqual(requested(), [], "stale counts are not refreshed in the background");
  script.click("银月花");
  script.click("银月花");
  await until(async () => wtr.state.requests["银月花"] === 1, "the clicked term to be counted again");
  await settle();
  assert.deepStrictEqual(requested(), ["银月花"], "only the clicked term was asked about, once, even after a double click");
  assert.strictEqual(wtr.state.listFetches, 1, "a week later the chapter list is still not fetched again: nothing refreshes it on a timer");
  script.stop();

  // ============ 4. data sent by an older version is re-sent once (this is what repairs missing origins) ============
  const storage4 = fakeStorage();
  const G4 = loadClient(storage4);
  storage4.data.wtrCapturedAt = { [RAW]: Date.now() }; // the old format: a bare timestamp
  const calls4 = {};
  const script4 = runContentScript({ href, storage: storage4, wtrBase: wtr.base, G: G4, page: { terms: [] }, clock, calls: calls4 });
  await until(async () => calls4["glossary:import"] >= 1, "the old-format stamp to trigger a re-send");
  assert.strictEqual(storage4.data.wtrCapturedAt[RAW].v, 4);
  await settle();
  assert.strictEqual(calls4["glossary:import"], 1, "and then it is not sent again");
  script4.stop();
  // sent before the person's English fixes went too (version 3): once more, with them
  const storage4b = fakeStorage();
  const G4b = loadClient(storage4b);
  storage4b.data.wtrCapturedAt = { [RAW]: { at: clock.t, v: 3 } };
  const calls4b = {};
  const script4b = runContentScript({ href, storage: storage4b, wtrBase: wtr.base, G: G4b, page: { terms: [] }, clock, calls: calls4b });
  await until(async () => calls4b["glossary:import"] >= 1, "the version-3 stamp to trigger a re-send");
  assert.strictEqual(storage4b.data.wtrCapturedAt[RAW].v, 4);
  script4b.stop();

  // ============ 5. the library lost the glossary: it is re-sent, then the counts go up ============
  await lib.api("DELETE", "/api/glossaries/" + encodeURIComponent(ID));
  assert.strictEqual(await serverGlossary(), null);
  const storage5 = fakeStorage();
  const G5 = loadClient(storage5);
  storage5.data.wtrCapturedAt = { [RAW]: { at: clock.t, v: 4 } }; // this device believes the library has it
  resetRequests();
  const calls5 = {};
  const script5 = runContentScript({ href, storage: storage5, wtrBase: wtr.base, G: G5, page: { terms: [] }, clock, calls: calls5 });
  script5.click("银月花");
  await until(async () => calls5["glossary:votes"] >= 1, "the first upload attempt");
  await settle();
  assert.strictEqual(await serverGlossary(), null, "the first upload is refused (no such glossary) and it waits instead of hammering");
  const attempts = calls5["glossary:votes"];
  script5.click("银月花");
  await settle();
  assert.strictEqual(calls5["glossary:votes"], attempts, "clicking again right away does not hammer the library");
  clock.t += 61 * 1000;
  script5.click("银月花");
  await until(async () => ((await serverGlossary()) || { countedTerms: 0 }).countedTerms >= 1, "the glossary to be re-sent and the count to land");
  assert.strictEqual(term(await serverGlossary(), "银月花")[3].n, 24);
  script5.stop();

  // ============ 6. The site pushing back: a refusal pauses everything for ten minutes ============
  const storage6 = fakeStorage();
  const G6 = loadClient(storage6);
  resetRequests();
  wtr.state.status = 429;
  const script6 = runContentScript({ href, storage: storage6, wtrBase: wtr.base, G: G6, page: { terms: [] }, clock, calls: {} });
  script6.click("银月花");
  await until(async () => wtr.state.order.length >= 1, "the first request");
  await settle();
  script6.click("科雷");
  await settle();
  assert.strictEqual(wtr.state.order.length, 1, "after a refusal nothing more is asked while it pauses");
  clock.t += 11 * 60 * 1000;
  script6.click("科雷");
  await until(async () => wtr.state.order.length >= 2, "a request after the ten-minute wait");
  wtr.state.status = 200; // The site recovers
  clock.t += 11 * 60 * 1000;
  script6.click("科雷");
  await until(async () => { const kl = term((await serverGlossary()) || { terms: [] }, "科雷"); return !!kl && kl[3].n !== undefined; }, "科雷's count to land once wtr-lab answers again");
  assert.strictEqual(wtr.state.order.length, 3);
  script6.stop();

  wtr.server.close();
  wtr.server.closeAllConnections();
  console.log("OK — wtr-capture checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
