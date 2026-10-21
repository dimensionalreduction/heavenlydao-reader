// Reading a book's page by visiting it in a background tab (src/shared/book-visit.js), with the browser stubbed. Run: node test/book-visit.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(tabAt, inTab) {
  const listeners = [];
  let clock = 1000000;
  const state = { created: [], removed: [], ran: [], cookies: [], set: [], asked: [], polls: 0, updated: [], advance: (ms) => { clock += ms; }, stamps: { "empirenovel.com/novel/necro#2": 1, "empirenovel.com/novel/other#2": 2, "69shuba.tw/book/390935#2": 3 }, nextTab: 7 };
  const ctx = {
    console, URL, Promise, JSON,
    clearTimeout: (t) => clearTimeout(t),
    // the pause for a page that never answers is 45 seconds: make it short here
    setTimeout: (f, ms) => setTimeout(f, ms >= 45000 ? 400 : ms >= 1000 ? (clock += ms, 0) : ms), // (the long pauses of a bot check move the clock instead of waiting)
    Date: { now: () => clock },
    chrome: {
      runtime: { onMessage: { addListener: (f) => listeners.push(f) } },
      tabs: {
        create: async (o) => { const tab = { id: state.nextTab++, url: o.url, active: o.active }; state.created.push(tab); return tab; },
        remove: async (id) => { state.removed.push(id); },
        get: async (id) => { state.polls++; if (!tabAt) throw new Error("no tab"); const t = tabAt(state.polls, id); if (t === null) throw new Error("No tab with id " + id); return { id, url: "https://x.example/", ...t }; },
        update: async (id, o) => { state.updated.push([id, o]); }
      },
      // a script run in a tab: the page asked for there (inTab(address, tabId) says what the site answered)
      scripting: { executeScript: async (o) => { state.ran.push([o.target.tabId, o.args[0]]); assert.strictEqual(typeof o.func, "function"); return [{ result: inTab ? await inTab(o.args[0], o.target.tabId) : { ok: true, status: 200, url: o.args[0], type: "text/html", body: "eA==" } }]; } },
      // the browser's cookies: state.cookies is what the site has (partitioned ones carry a partitionKey), state.set what was written
      cookies: {
        getAll: async (q) => { state.asked.push(q); if (state.noPartitions) throw new Error("Unexpected property: 'partitionKey'"); return state.cookies; },
        set: async (d) => { if (d.name === "refused") throw new Error("no"); state.set.push(d); }
      },
      storage: { local: { get: async () => ({ bookCapturedAt: JSON.parse(JSON.stringify(state.stamps)) }), set: async (o) => { state.stamps = o.bookCapturedAt; } } }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "book-visit.js"), "utf8"), ctx, { filename: "book-visit.js" });
  const say = (tabId, msg) => listeners.forEach((f) => f(msg, tabId == null ? {} : { tab: { id: tabId } }));
  state.advance = (ms) => { clock += ms; };
  return { BookVisit: ctx.BookVisit, state, say, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

(async () => {
  // ---- a visit that records the book ----
  let { BookVisit, state, say, sleep } = load();
  assert.strictEqual(BookVisit.MARK, "#p2pread-visit");
  let visit = BookVisit.visit("https://www.empirenovel.com/novel/necro#whatever");
  await sleep(20);
  assert.deepStrictEqual(state.created.map((t) => [t.url, t.active]), [["https://www.empirenovel.com/novel/necro#p2pread-visit", false]], "the page opens in a background tab, with the marker the recording script looks for");
  assert.deepStrictEqual(Object.keys(state.stamps).sort(), ["69shuba.tw/book/390935#2", "empirenovel.com/novel/other#2"], "the note that this book was recorded is taken back (and no other book's)");
  say(99, { type: "bookcapture:done", saved: true }); // another tab: not ours
  say(null, { type: "bookcapture:done", saved: true }); // no tab at all
  say(7, { type: "something:else" });
  await sleep(20);
  assert.deepStrictEqual(state.removed, [], "answers from other tabs and other messages change nothing");
  say(7, { type: "bookcapture:done", saved: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await visit)), { ok: true, cover: null }, "recorded (no cover said)");
  assert.deepStrictEqual(state.removed, [7], "the tab is closed");
  // how the cover's copy went, passed on ("Refresh details" says it)
  ({ BookVisit, state, say, sleep } = load());
  visit = BookVisit.visit("https://www.empirenovel.com/novel/necro");
  await sleep(10);
  say(7, { type: "bookcapture:done", saved: true, cover: { ok: false, error: "the site answered HTTP 403" } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await visit)), { ok: true, cover: { ok: false, error: "the site answered HTTP 403" } });

  // ---- the page is not a book's page / the recording failed ----
  ({ BookVisit, state, say, sleep } = load());
  visit = BookVisit.visit("https://example.org/book/1.html");
  await sleep(10);
  say(7, { type: "bookcapture:done", saved: false, reason: "this page does not look like a book's page" });
  await assert.rejects(visit, /does not look like a book's page/, "the reason is the error");
  assert.deepStrictEqual(state.removed, [7], "and the tab is closed all the same");
  ({ BookVisit, state, say, sleep } = load());
  visit = BookVisit.visit("https://example.org/book/1.html");
  await sleep(10);
  say(7, { type: "bookcapture:done", saved: false });
  await assert.rejects(visit, /was not recorded/, "no reason given");

  // ---- a page that never answers (a check waiting for the person) ----
  ({ BookVisit, state } = load());
  await assert.rejects(BookVisit.visit("https://www.empirenovel.com/novel/necro"), /did not finish loading in 45 seconds.*open empirenovel\.com yourself/, "it gives up, and says what to do");
  assert.deepStrictEqual(state.removed, [7], "and closes the tab");

  // ---- only https ----
  ({ BookVisit, state } = load());
  await assert.rejects(BookVisit.visit("http://example.org/book/1"), /https/);
  await assert.rejects(BookVisit.visit("javascript:alert(1)"), /https/);
  assert.strictEqual(state.created.length, 0, "nothing was opened");
  // ---- a site that refuses the extension's own requests: the page is asked for from inside a tab of the site ----
  const plain = (r) => JSON.parse(JSON.stringify(r));
  const page = (body) => (address) => ({ ok: true, status: 200, url: address, type: "text/html; charset=gbk", body });
  // a check that passes by itself
  ({ BookVisit, state, sleep } = load(() => ({ status: "complete", title: "Reverend Insanity read online | Empire Novel", url: "https://www.empirenovel.com/novel/reverend-insanity" }), page("bGlzdA==")));
  assert.deepStrictEqual(plain(await BookVisit.fetchIn("https://www.empirenovel.com/novel/reverend-insanity#x")), { ok: true, status: 200, url: "https://www.empirenovel.com/novel/reverend-insanity", type: "text/html; charset=gbk", body: "bGlzdA==" }, "what the site answered its own tab: the status, the address, the bytes");
  assert.deepStrictEqual(state.created.map((t) => [t.url, t.active]), [["https://www.empirenovel.com/novel/reverend-insanity", false]], "the page is opened in a background tab");
  assert.deepStrictEqual(state.ran, [[7, "https://www.empirenovel.com/novel/reverend-insanity"]], "and asked for from inside it");
  assert.strictEqual(state.updated.length, 0, "never brought forward");
  // the next pages of the site use the same tab
  await BookVisit.fetchIn("https://www.empirenovel.com/novel/reverend-insanity?page=2");
  await BookVisit.fetchIn("https://www.empirenovel.com/novel/reverend-insanity?page=3");
  assert.deepStrictEqual([state.created.length, state.ran.map((r) => r[1].split("?")[1] || "")], [1, ["", "page=2", "page=3"]], "one tab for the whole list");
  await sleep(20);
  assert.deepStrictEqual(state.removed, [7], "closed when nothing has asked through it for a while");
  await BookVisit.fetchIn("https://www.empirenovel.com/novel/reverend-insanity?page=4");
  assert.strictEqual(state.created.length, 2, "and opened again when it is needed again");

  // a check that shows "Just a moment..." first and needs the person: its tab comes to the front once, then it passes
  ({ BookVisit, state, sleep } = load((polls) => (polls < 12 ? { status: "complete", title: "Just a moment..." } : { status: "complete", title: "Reverend Insanity" })));
  assert.strictEqual(plain(await BookVisit.fetchIn("https://www.empirenovel.com/novel/x")).ok, true);
  assert.deepStrictEqual(state.updated.map(([id, o]) => [id, o.active]), [[7, true]], "the tab is brought to the front once, when the check is still showing after a few seconds");
  // one that is still showing after two minutes
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "Just a moment..." })));
  let gone = plain(await BookVisit.fetchIn("https://www.empirenovel.com/novel/x"));
  assert.strictEqual(gone.ok, false);
  assert.match(gone.error, /not passed within 120 seconds/);
  assert.deepStrictEqual([state.removed, state.ran], [[7], []], "the tab is closed, and nothing was asked through it");
  // ... and the site is left alone for a while: no tab after tab
  gone = plain(await BookVisit.fetchIn("https://www.empirenovel.com/novel/y"));
  assert.match(gone.error, /not passed within 120 seconds.*not asked again yet/);
  assert.strictEqual(state.created.length, 1, "no second tab");
  state.advance(4 * 60 * 1000);
  await BookVisit.fetchIn("https://www.empirenovel.com/novel/y");
  assert.strictEqual(state.created.length, 2, "after a few minutes it is tried again");
  // a check by its address (the title may be in any language)
  ({ BookVisit, state } = load((polls) => (polls < 3 ? { status: "complete", title: "…", url: "https://x.example/?__cf_chl_rt_tk=abc" } : { status: "complete", title: "Novel" })));
  assert.strictEqual(plain(await BookVisit.fetchIn("https://x.example/novel")).ok, true);
  // the person closes the tab before the check is passed / the site refuses the browser too
  ({ BookVisit } = load(null));
  assert.match(plain(await BookVisit.fetchIn("https://x.example/novel")).error, /tab was closed/);
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "403 Forbidden" })));
  assert.match(plain(await BookVisit.fetchIn("https://x.example/novel")).error, /refuses the browser too/);
  assert.deepStrictEqual(state.removed, [7]);
  // the site answers its own tab with 403 as well: that is the answer, the tab goes, and the site is left alone for a while
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "Novel" }), (address) => ({ ok: true, status: 403, url: address, type: "", body: "" })));
  gone = plain(await BookVisit.fetchIn("https://x.example/novel"));
  assert.deepStrictEqual([gone.ok, /refuses its own tab too/.test(gone.error), state.removed], [false, true, [7]]);
  assert.match(plain(await BookVisit.fetchIn("https://x.example/novel/2")).error, /not asked again yet/);
  assert.strictEqual(state.created.length, 1);
  // a page the tab could not read (the request failed there)
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "Novel" }), () => ({ ok: false, error: "Failed to fetch" })));
  assert.match(plain(await BookVisit.fetchIn("https://x.example/novel")).error, /could not be read through the site's tab \(Failed to fetch\)/);
  // other statuses are the site's answer, passed on (a 404, a 429 the reader waits for)
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "Novel" }), (address) => ({ ok: true, status: 429, url: address, type: "", body: "" })));
  assert.strictEqual(plain(await BookVisit.fetchIn("https://x.example/novel")).status, 429);
  assert.strictEqual(plain(await BookVisit.fetchIn("https://x.example/novel")).status, 429, "(and the tab stays for the next try)");
  assert.strictEqual(state.created.length, 1);
  // the same site asked by several at once: one tab
  ({ BookVisit, state } = load((polls) => (polls < 4 ? { status: "loading", title: "" } : { status: "complete", title: "Novel" })));
  const together = await Promise.all([1, 2, 3].map((n) => BookVisit.fetchIn("https://x.example/novel/" + n)));
  assert.deepStrictEqual(together.map((r) => plain(r).ok), [true, true, true]);
  assert.deepStrictEqual([state.created.length, state.ran.length], [1, 3], "they share the one tab");
  // a tab the person closed in the middle of a list is opened again
  let closed = false;
  ({ BookVisit, state } = load(() => { if (closed) { closed = false; return null; } return { status: "complete", title: "Novel" }; }));
  await BookVisit.fetchIn("https://x.example/novel/1");
  closed = true;
  assert.strictEqual(plain(await BookVisit.fetchIn("https://x.example/novel/2")).ok, true);
  assert.deepStrictEqual([state.created.length, state.ran.map((r) => r[0])], [2, [7, 8]], "the page is asked for through a new tab");
  // a site that moved the tab to its other name (www or not): a page can only ask its own site, so it is asked under that name
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "Novel", url: "https://www.x.example/novel/1" })));
  await BookVisit.fetchIn("https://x.example/novel/1?page=2");
  assert.deepStrictEqual(state.ran, [[7, "https://www.x.example/novel/1?page=2"]]);
  // ---- the check's pass, brought to where the extension's own requests see it ----
  ({ BookVisit, state } = load());
  const key = { topLevelSite: "https://empirenovel.com" };
  state.cookies = [
    { name: "cf_clearance", value: "PASS", domain: ".empirenovel.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 1800000000, hostOnly: false, partitionKey: key },
    { name: "XSRF-TOKEN", value: "x", domain: "www.empirenovel.com", path: "/", hostOnly: true }, // a plain cookie: it is sent already
    { name: "seen", value: "1", domain: "www.empirenovel.com", path: "/", hostOnly: true, partitionKey: key },
    { name: "seen", value: "1", domain: "www.empirenovel.com", path: "/", hostOnly: true }, // ... and its plain copy from the last time
    { name: "widget", value: "w", domain: ".empirenovel.com", path: "/", partitionKey: { topLevelSite: "https://some-other-site.example" } }, // the site inside another's page
    { name: "refused", value: "r", domain: ".empirenovel.com", path: "/", partitionKey: key }
  ];
  assert.deepStrictEqual(plain(await BookVisit.bringPass("https://www.empirenovel.com/novel/x?page=2")), { ok: true, copied: 1 });
  assert.deepStrictEqual(plain(state.asked), [{ url: "https://www.empirenovel.com/novel/x?page=2", partitionKey: {} }], "the site's cookies, partitioned ones too");
  assert.deepStrictEqual(plain(state.set), [{ url: "https://empirenovel.com/", name: "cf_clearance", value: "PASS", path: "/", secure: true, httpOnly: true, domain: ".empirenovel.com", sameSite: "no_restriction", expirationDate: 1800000000 }], "the pass is written again as a plain cookie (no partition), as it was; not what is there already, not another site's, and one the browser refuses does not stop the rest");
  // nothing to bring: asking again would not help
  state.cookies = state.cookies.slice(1, 4);
  state.set = [];
  assert.deepStrictEqual([plain(await BookVisit.bringPass("https://www.empirenovel.com/novel/x")), state.set.length], [{ ok: true, copied: 0 }, 0]);
  // a browser that does not know partitioned cookies, and addresses that are not a site's
  state.noPartitions = true;
  assert.deepStrictEqual(plain(await BookVisit.bringPass("https://www.empirenovel.com/novel/x")), { ok: false, copied: 0 });
  assert.deepStrictEqual(plain(await BookVisit.bringPass("http://x.example/")), { ok: false, copied: 0 });
  assert.deepStrictEqual(plain(await BookVisit.bringPass("nonsense")), { ok: false, copied: 0 });
  // passing the check in the site's tab brings the pass over too, so the requests after it need no tab
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "Novel", url: "https://www.empirenovel.com/novel/x" })));
  state.cookies = [{ name: "cf_clearance", value: "NEW", domain: ".empirenovel.com", path: "/", httpOnly: true, partitionKey: key }];
  await BookVisit.fetchIn("https://www.empirenovel.com/novel/x");
  assert.deepStrictEqual(state.set.map((c) => [c.name, c.value]), [["cf_clearance", "NEW"]]);

  // only https
  ({ BookVisit, state } = load(() => ({ status: "complete", title: "x" })));
  assert.strictEqual(plain(await BookVisit.fetchIn("http://x.example/")).ok, false);
  assert.strictEqual(plain(await BookVisit.fetchIn("not an address")).ok, false);
  assert.strictEqual(state.created.length, 0);
  console.log("OK — book-visit checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
