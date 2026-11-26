// A comic whose script draws its pictures, when the site's rule no longer finds them (src/shared/book-visit.js relearnPictures): the chapter is opened in a background
// tab, the list that names the pictures it shows is found again from its scripts and saved in the site's rule. The browser is stubbed, its clock moves with every pause;
// the tab shows a real chapter page of mh160mh.com (test/fixtures/qtcms-chapter.html: its list base64 in qTcms_S_m_murl_e). Run: node test/relearn-pictures.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shared = path.join(__dirname, "..", "src", "shared");
const html = fs.readFileSync(path.join(__dirname, "fixtures", "qtcms-chapter.html"), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => "<script>" + m[2] + "</script>").join("\n");
const CHAPTER = "https://www.mh160mh.com/kanmanhua/dingjiqiyunqiaoqiaoxiulianqiannian/1671357697.html";
const OTHER = "https://www.mh160mh.com/kanmanhua/dingjiqiyunqiaoqiaoxiulianqiannian/1671357698.html";
const path1 = "/mh160tuku/d/%E9%A1%B6%E7%BA%A7%E6%B0%94%E8%BF%90-%E6%82%84%E6%82%84%E4%BF%AE%E7%82%BC%E5%8D%83%E5%B9%B4_62157/02_168051/";
const OLD = { name: "qTcms_S_m_murl_e", base64: true, prefix: "https://mhpic789-5.tgmhfc.uk" };
const NEW = { name: "qTcms_S_m_murl_e", base64: true, prefix: "https://mhpic5er.tgmhfc.uk" };
// the chapter as its tab shows it: its scripts, and the first 3 pictures drawn on the server its script picked (and the site's loading picture)
const drawn = (server) => ({ url: CHAPTER, title: "顶级气运，悄悄修炼千年02", scripts, shown: ["https://www.mh160mh.com/template/skin1/css/d7s/images/pic_loading.gif", ...["0001", "0002", "0003"].map((n) => server + path1 + n + ".jpg")] });

// page(state, tabId) -> what the tab is on now: { url, title, status, scripts, shown, noScript }. firefox: the browser is Firefox's (tabs.executeScript with code)
function load(page, firefox) {
  let clock = 5000000;
  const state = { created: [], removed: [], updated: [], stored: { "mh160mh.com": { spec: { host: "mh160mh.com", toc: { list: "#mh-chapter-list-ol-0 a" }, scriptPictures: OLD }, enabled: true, updatedAt: 1 } }, sets: 0, now: () => clock, advance: (ms) => { clock += ms; } };
  const ctx = {
    console, URL, atob, TextDecoder,
    Date: { now: () => clock },
    setTimeout: (f, ms) => { clock += ms || 0; return setImmediate(f); }, // (a pause moves the clock and is over at once)
    clearTimeout: () => {},
    chrome: {
      runtime: { onMessage: { addListener: () => {} } },
      tabs: {
        create: async (o) => { const tab = { id: 50 + state.created.length, url: o.url, active: o.active }; state.created.push(tab); return tab; },
        get: async (id) => { if (state.removed.includes(id)) throw new Error("No tab with id " + id); const p = page(state, id); return { id, url: p.url, title: p.title, status: p.status || "complete" }; },
        remove: async (id) => { state.removed.push(id); },
        update: async (id, o) => { state.updated.push([id, o]); }
      },
      scripting: { executeScript: async (o) => { const p = page(state, o.target.tabId); if (p.noScript) throw new Error("Cannot access contents of the page"); return [{ result: { url: p.url, title: p.title, ready: "complete", scripts: p.scripts || "", shown: p.shown || [] } }]; } },
      storage: { local: { get: async (k) => ({ [k]: JSON.parse(JSON.stringify(state.stored)) }), set: async (o) => { state.sets++; state.stored = JSON.parse(JSON.stringify(o.userRules)); } } }
    }
  };
  if (firefox) {
    // Firefox's background page: no scripting API; tabs.executeScript runs the code it is given in the tab (here: in a page made of what page() says)
    ctx.browser = { ...ctx.chrome, scripting: undefined, tabs: { ...ctx.chrome.tabs, executeScript: async (tabId, o) => {
      const p = page(state, tabId);
      if (p.noScript) throw new Error("Missing host permission for the tab");
      const img = (u) => ({ currentSrc: u, src: u, getAttribute: () => null });
      const doc = { images: (p.shown || []).map(img), scripts: [...String(p.scripts || "").matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => ({ src: "", textContent: m[1] })), title: p.title, readyState: "complete" };
      return [vm.runInNewContext(o.code, { document: doc, location: { href: p.url } })];
    } } };
    delete ctx.chrome;
  }
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(shared, "user-rules.js"), "utf8"), ctx, { filename: "user-rules.js" }); // (the background has it: UserRules)
  vm.runInContext(fs.readFileSync(path.join(shared, "book-visit.js"), "utf8"), ctx, { filename: "book-visit.js" });
  return { BV: ctx.BookVisit, state };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
const ruleOf = (state) => state.stored["mh160mh.com"].spec.scriptPictures;

(async () => {
  // ---- the site put its pictures on another server ----
  let { BV, state } = load(() => drawn("https://mhpic5er.tgmhfc.uk"));
  let r = plain(await BV.relearnPictures(CHAPTER + "#original", OLD));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.scriptPictures, NEW, "the same list, on the server the chapter's page shows the pictures from");
  assert.strictEqual(r.url, CHAPTER, "found on this chapter");
  assert.strictEqual(r.urls.length, 43, "its 43 pictures, from its tab");
  assert.strictEqual(r.urls[0], NEW.prefix + path1 + "0001.jpg");
  assert.deepStrictEqual(state.created.map((t) => [t.url, t.active]), [[CHAPTER, false]], "the chapter is opened in a background tab");
  assert.deepStrictEqual(state.removed, [50], "and closed");
  assert.deepStrictEqual(ruleOf(state), NEW, "the site's rule names the server now");
  assert.deepStrictEqual(state.stored["mh160mh.com"].spec.toc, { list: "#mh-chapter-list-ol-0 a" }, "the rest of the rule is as it was");
  // another chapter that failed with the old rule a moment later: what was found, with no tab
  const sets = state.sets;
  r = plain(await BV.relearnPictures(OTHER, OLD));
  assert.deepStrictEqual(r, { ok: true, scriptPictures: NEW, count: 43 }, "a chapter asked for before the rule had changed takes what was found");
  assert.strictEqual(state.created.length, 1, "no tab for it");
  assert.strictEqual(state.sets, sets, "the rule already says so: not written again");
  state.stored["mh160mh.com"].spec.scriptPictures = OLD; // (set back by hand meanwhile)
  r = plain(await BV.relearnPictures(OTHER, OLD));
  assert.ok(r.ok && ruleOf(state).prefix === NEW.prefix, "a rule set back since is set again");
  // the list found does not work either: said at once
  r = plain(await BV.relearnPictures(OTHER, NEW));
  assert.deepStrictEqual(r, { ok: false, error: "they were found again a moment ago, and are still not there" });
  assert.strictEqual(state.created.length, 1, "no tab");
  // ten minutes on, a chapter that fails is looked at again
  state.advance(11 * 60 * 1000);
  r = plain(await BV.relearnPictures(OTHER, NEW));
  assert.strictEqual(state.created.length, 2, "looked at again");
  assert.ok(r.ok && r.same && r.urls.length === 43, "its page lists them as the rule says: the rule is right, and the pictures come from its tab");

  // ---- the site lists them in another variable (and plain, not base64) ----
  const renamed = scripts.replace(/qTcms_S_m_murl_e="([^"]*)"/, (m, b64) => 'pics = "' + Buffer.from(b64, "base64").toString("utf8").split("$qingtiandy$").map((p) => "https://cdn.example.org" + p).join("|") + '"');
  ({ BV, state } = load(() => ({ ...drawn("https://cdn.example.org"), scripts: renamed })));
  r = plain(await BV.relearnPictures(CHAPTER, OLD));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.scriptPictures, { name: "pics" }, "the list is the other variable, whole addresses: no server, no base64");
  assert.deepStrictEqual(ruleOf(state), { name: "pics" });
  assert.strictEqual(r.urls[0], "https://cdn.example.org" + path1 + "0001.jpg");

  // ---- nothing drawn from a list (a chapter taken down) ----
  ({ BV, state } = load(() => ({ url: CHAPTER, title: "漫画160", scripts: "<script>var a = 1;</script>", shown: ["https://www.mh160mh.com/logo.png"] })));
  const t0 = state.now();
  r = plain(await BV.relearnPictures(CHAPTER, OLD));
  assert.deepStrictEqual(r, { ok: false, error: "its page showed no pictures from a list in its script within 25 seconds" });
  assert.ok(state.now() - t0 < 30000, "it gave up 25 seconds after the page was there");
  assert.deepStrictEqual(state.removed, [50], "the tab is closed");
  assert.deepStrictEqual(ruleOf(state), OLD, "the rule is left as it was");
  r = plain(await BV.relearnPictures(OTHER, OLD));
  assert.deepStrictEqual(r, { ok: false, error: "its page showed no pictures from a list in its script within 25 seconds (a moment ago: not tried again yet)" }, "said at once for the next chapter, with no tab");
  assert.strictEqual(state.created.length, 1);
  // a page the extension cannot look into (an error page): the same, 25 seconds after it loaded
  ({ BV, state } = load(() => ({ url: CHAPTER, title: "This site can't be reached", noScript: true })));
  r = plain(await BV.relearnPictures(CHAPTER, OLD));
  assert.ok(!r.ok && /within 25 seconds/.test(r.error), JSON.stringify(r));

  // ---- the site's check: the tab comes to the front when it waits for the person, and the look goes on once it is passed ----
  let started = 0;
  ({ BV, state } = load((st) => {
    started = started || st.now();
    return st.now() - started < 20000 ? { url: CHAPTER, title: "Just a moment...", scripts: "", shown: [] } : drawn("https://mhpic5er.tgmhfc.uk");
  }));
  r = plain(await BV.relearnPictures(CHAPTER, OLD));
  assert.ok(r.ok && r.scriptPictures.prefix === NEW.prefix, JSON.stringify(r));
  assert.deepStrictEqual(plain(state.updated), [[50, { active: true }]], "brought to the front once");
  // the site refuses the browser too
  ({ BV, state } = load(() => ({ url: CHAPTER, title: "403 Forbidden" })));
  r = plain(await BV.relearnPictures(CHAPTER, OLD));
  assert.deepStrictEqual(r, { ok: false, error: "the site refuses the browser too (403 Forbidden)" });

  // ---- two chapters that fail at once: one tab ----
  ({ BV, state } = load(() => drawn("https://mhpic5er.tgmhfc.uk")));
  const [a, b] = (await Promise.all([BV.relearnPictures(CHAPTER, OLD), BV.relearnPictures(OTHER, OLD)])).map(plain);
  assert.strictEqual(state.created.length, 1, "one tab");
  assert.ok(a.ok && a.url === CHAPTER && a.urls.length === 43, "the first gets its own pictures");
  assert.deepStrictEqual(b, { ok: true, scriptPictures: NEW, count: 43 }, "the second what was found (its pictures come from its own page)");

  // ---- Firefox: the tab is looked into with tabs.executeScript and a string of code (the function written out), which runs there ----
  ({ BV, state } = load(() => drawn("https://mhpic5er.tgmhfc.uk"), true));
  r = plain(await BV.relearnPictures(CHAPTER, OLD));
  assert.ok(r.ok && r.urls.length === 43 && r.scriptPictures.prefix === NEW.prefix, JSON.stringify(r).slice(0, 300));
  assert.deepStrictEqual(ruleOf(state), NEW, "saved in Firefox too");

  // ---- not a page it may open ----
  assert.deepStrictEqual(plain(await BV.relearnPictures("http://www.mh160mh.com/x.html", OLD)), { ok: false, error: "not an https address" });

  console.log("OK — relearn-pictures checks passed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
