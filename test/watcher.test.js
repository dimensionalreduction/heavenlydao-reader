// The "New chapters" scheduler: what is due and when, and what is written back. Run: node test/watcher.test.js
const assert = require("assert");
const path = require("path");
const W = require(path.join(__dirname, "..", "src", "shared", "watcher.js"));

const HOUR = 3600 * 1000;
const T = Date.UTC(2026, 9, 10, 12, 0, 0); // 2026-10-10 12:00 UTC
const watch = (over = {}) => ({ id: "wtr-lab:1|wtr-lab.com", novel: "wtr-lab:1", source: "wtr-lab.com", on: true, mode: "every", hours: 6, at: "09:00", tz: 0, from: "", known: 10, url: "https://wtr-lab.com/en/novel/1/x", lastCheck: 0, lastResult: "", ...over });

(async () => {
  // ---- off means nothing, ever ----
  assert.strictEqual(W.isDue(watch({ on: false }), T), false, "a switched-off watch is never due");
  assert.strictEqual(W.isDue(null, T), false);

  // ---- every N hours ----
  assert.strictEqual(W.isDue(watch({ lastCheck: 0 }), T), true, "never looked: due straight away (so switching it on gives a first look)");
  assert.strictEqual(W.isDue(watch({ lastCheck: T - 5 * HOUR }), T), false, "5 hours into a 6-hour interval");
  assert.strictEqual(W.isDue(watch({ lastCheck: T - 6 * HOUR }), T), true, "6 hours: due");
  assert.strictEqual(W.isDue(watch({ hours: 0, lastCheck: T - 11 * HOUR }), T), false, "a missing interval falls back to 12 hours");
  assert.strictEqual(W.isDue(watch({ hours: 0, lastCheck: T - 12 * HOUR }), T), true);

  // ---- daily at a time on the person's own clock ----
  // 12:00 UTC. In UTC the 09:00 slot was 3 hours ago.
  assert.strictEqual(W.lastScheduled(watch({ mode: "daily", at: "09:00", tz: 0 }), T), Date.UTC(2026, 9, 10, 9, 0), "today's 09:00");
  assert.strictEqual(W.isDue(watch({ mode: "daily", at: "09:00", lastCheck: T - 2 * HOUR }), T), false, "looked at 10:00, after the 09:00 slot: not due");
  assert.strictEqual(W.isDue(watch({ mode: "daily", at: "09:00", lastCheck: Date.UTC(2026, 9, 10, 9, 0) }), T), false, "looked exactly at 09:00: not due");
  assert.strictEqual(W.isDue(watch({ mode: "daily", at: "09:00", lastCheck: Date.UTC(2026, 9, 10, 8, 59) }), T), true, "a look at 08:59 came before the 09:00 slot: due");
  assert.strictEqual(W.lastScheduled(watch({ mode: "daily", at: "18:30", tz: 0 }), T), Date.UTC(2026, 9, 9, 18, 30), "18:30 has not come today: the last slot was yesterday's");
  assert.strictEqual(W.isDue(watch({ mode: "daily", at: "18:30", lastCheck: Date.UTC(2026, 9, 9, 19, 0) }), T), false, "looked after yesterday's slot, today's is still ahead");
  // time zones: a person at UTC+5:30 has tz = -330 (getTimezoneOffset). Their 09:00 is 03:30 UTC.
  assert.strictEqual(W.lastScheduled(watch({ mode: "daily", at: "09:00", tz: -330 }), T), Date.UTC(2026, 9, 10, 3, 30), "09:00 in UTC+5:30 is 03:30 UTC");
  // a person at UTC-5 (tz = 300): 12:00 UTC is 07:00 there, so 09:00 has not come: yesterday's 09:00 = 14:00 UTC the day before
  assert.strictEqual(W.lastScheduled(watch({ mode: "daily", at: "09:00", tz: 300 }), T), Date.UTC(2026, 9, 9, 14, 0), "UTC-5: today's 09:00 (14:00 UTC) has not come yet");

  // ---- on chosen days of the week (2026-10-10 is a Saturday; Friday 2026-10-09; Sunday 0 ... Saturday 6) ----
  const fridays = { mode: "daily", at: "08:00", days: [5] };
  assert.strictEqual(W.lastScheduled(watch(fridays), T), Date.UTC(2026, 9, 9, 8, 0), "Fridays 08:00: the last one was yesterday's");
  assert.strictEqual(W.nextDue(watch({ ...fridays, lastCheck: Date.UTC(2026, 9, 9, 8, 1) }), T), Date.UTC(2026, 9, 16, 8, 0), "looked on Friday: the next is a week on");
  assert.strictEqual(W.isDue(watch({ ...fridays, lastCheck: Date.UTC(2026, 9, 9, 8, 1) }), T), false, "not due on a Saturday after Friday's look");
  assert.strictEqual(W.isDue(watch({ ...fridays, lastCheck: Date.UTC(2026, 9, 2, 8, 1) }), T), true, "Friday's slot passed since the last look: due");
  assert.strictEqual(W.nextDue(watch({ ...fridays, lastCheck: Date.UTC(2026, 9, 2, 8, 1) }), T), Date.UTC(2026, 9, 9, 8, 0), "a missed Friday is due now");
  const weekend = watch({ mode: "daily", at: "07:00", days: [6, 0], lastCheck: Date.UTC(2026, 9, 10, 7, 5) });
  assert.strictEqual(W.nextDue(weekend, T), Date.UTC(2026, 9, 11, 7, 0), "Saturday and Sunday: after Saturday's look comes Sunday's");
  assert.strictEqual(W.nextDue({ ...weekend, days: [1, 2, 3, 4, 5] }, T), Date.UTC(2026, 9, 12, 7, 0), "weekdays: after a Saturday comes Monday");
  assert.strictEqual(W.nextDue({ ...weekend, days: [] }, T), Date.UTC(2026, 9, 11, 7, 0), "none chosen: every day");
  assert.strictEqual(W.nextDue({ ...weekend, days: undefined }, T), Date.UTC(2026, 9, 11, 7, 0), "an older watch has no days: every day");
  // the weekday is the person's own: at UTC+10 (tz = -600) it is already Sunday 2026-10-11 at 08:00 when it is 22:00 UTC on the Saturday
  const late = Date.UTC(2026, 9, 10, 22, 0);
  assert.strictEqual(W.lastScheduled(watch({ mode: "daily", at: "08:00", tz: -600, days: [0] }), late), Date.UTC(2026, 9, 10, 22, 0), "Sunday 08:00 in UTC+10 is Saturday 22:00 UTC");
  assert.strictEqual(W.nextDue(watch({ mode: "daily", at: "08:00", tz: -600, days: [6], lastCheck: late }), late), Date.UTC(2026, 9, 17, 22, 0) - 24 * HOUR, "Saturday 08:00 in UTC+10 (Friday 22:00 UTC) next comes a week later");

  // ---- when it is due next (the novel page's Triggers tab, the Activity page's Upcoming) ----
  assert.strictEqual(W.nextDue(watch({ on: false }), T), 0, "off: never");
  assert.strictEqual(W.nextDue(watch({ lastCheck: T - 2 * HOUR }), T), T + 4 * HOUR, "every 6 hours, looked 2 hours ago: in 4 hours");
  assert.ok(W.nextDue(watch({ lastCheck: 0 }), T) <= T, "never looked: due already");
  assert.strictEqual(W.nextDue(watch({ mode: "daily", at: "18:30", lastCheck: Date.UTC(2026, 9, 9, 19, 0) }), T), Date.UTC(2026, 9, 10, 18, 30), "daily: today's 18:30, still ahead");
  assert.strictEqual(W.nextDue(watch({ mode: "daily", at: "09:00", lastCheck: Date.UTC(2026, 9, 10, 9, 5) }), T), Date.UTC(2026, 9, 11, 9, 0), "daily: today's 09:00 looked at, so tomorrow's");
  assert.strictEqual(W.nextDue(watch({ mode: "daily", at: "09:00", lastCheck: Date.UTC(2026, 9, 9, 9, 5) }), T), Date.UTC(2026, 9, 10, 9, 0), "daily: today's 09:00 missed (the extension was off): due since then");
  for (const w of [watch({ lastCheck: T - 7 * HOUR }), watch({ lastCheck: T - HOUR }), watch({ mode: "daily", lastCheck: T - 26 * HOUR }), watch({ mode: "daily", lastCheck: T - HOUR })]) {
    assert.strictEqual(W.isDue(w, T), W.nextDue(w, T) <= T, "isDue and nextDue agree");
  }

  // ---- a pass: only what is due is looked at, and the results are written back ----
  const saved = [];
  const notices = [];
  const indexes = [];
  const checked = [];
  const list = (n) => Array.from({ length: n }, (_, i) => [i + 1, "Chapter " + (i + 1), "https://wtr-lab.com/en/novel/1/x/chapter-" + (i + 1), ""]);
  const deps = {
    listWatches: async () => [
      watch({ id: "a|wtr-lab.com", novel: "a", known: 10 }), // due, 3 new
      watch({ id: "b|wtr-lab.com", novel: "b", known: 10, lastCheck: T - HOUR }), // not due
      watch({ id: "c|uuread.tw", novel: "c", source: "uuread.tw", from: "https://www.uuread.tw/chapter/1/10.html", url: "" }), // due, followed page by page
      watch({ id: "d|wtr-lab.com", novel: "d", on: false }), // off
      watch({ id: "e|wtr-lab.com", novel: "e", known: 13 }) // due, nothing new
    ],
    check: async (w) => {
      checked.push(w.id);
      if (w.novel === "a") return { kind: "list", chapters: list(13) };
      if (w.novel === "e") return { kind: "list", chapters: list(13) };
      if (w.novel === "c") return { kind: "follow", urls: ["https://www.uuread.tw/chapter/1/11.html", "https://www.uuread.tw/chapter/1/12.html"], more: false };
      throw new Error("unexpected " + w.id);
    },
    saveWatch: async (w) => void saved.push(w),
    addNotice: async (n) => void notices.push(n),
    saveChapterIndex: async (r) => void indexes.push(r)
  };
  const out = await W.tick(deps, T);
  assert.deepStrictEqual(checked.sort(), ["a|wtr-lab.com", "c|uuread.tw", "e|wtr-lab.com"], "only the due, switched-on watches were looked at");
  assert.strictEqual(out.checked.length, 3);

  const a = saved.find((w) => w.novel === "a");
  assert.deepStrictEqual([a.lastCheck, a.known, a.lastResult], [T, 13, "3 new chapters"], "known moves up to the newest chapter, so it is not announced again");
  assert.deepStrictEqual(notices.find((n) => n.novel === "a"), { novel: "a", source: "wtr-lab.com", count: 3, firstNum: 11, lastNum: 13, first: "https://wtr-lab.com/en/novel/1/x/chapter-11", latest: "https://wtr-lab.com/en/novel/1/x/chapter-13" });
  assert.deepStrictEqual([indexes.length, indexes[0].key, indexes[0].chapters.length], [1, "a", 13], "the whole refreshed list goes to the library (only when something is new)");

  const c = saved.find((w) => w.novel === "c");
  assert.deepStrictEqual([c.from, c.lastResult], ["https://www.uuread.tw/chapter/1/12.html", "2 new chapters"], "a followed source continues from the newest page next time");
  assert.deepStrictEqual(notices.find((n) => n.novel === "c"), { novel: "c", source: "uuread.tw", count: 2, first: "https://www.uuread.tw/chapter/1/11.html", latest: "https://www.uuread.tw/chapter/1/12.html" });

  const e = saved.find((w) => w.novel === "e");
  assert.deepStrictEqual([e.lastCheck, e.lastResult, e.known], [T, "no new chapters", 13], "nothing new: the look is still recorded");
  assert.ok(!notices.some((n) => n.novel === "e"), "and no notice is made");

  // ---- then: "fetch": the new ones are the list's chapters past `above` (its last when "fetch" was chosen), fetched by the pass's fill, whoever looked ----
  const fetched = [];
  const nlists = { g: list(12), h: list(12), z: list(9) };
  const fetchDeps = { ...deps, chapterList: async (key) => nlists[key] || [], fetchChapters: async (items, w, opts) => { fetched.push([w.novel, items.map((c) => c.num), opts]); return { asked: items.length }; } };
  saved.length = 0;
  await W.tick({ ...fetchDeps, listWatches: async () => [watch({ id: "g|wtr-lab.com", novel: "g", known: 12, above: 10, then: "fetch", lastCheck: T - HOUR }), watch({ id: "h|wtr-lab.com", novel: "h", known: 10, lastCheck: T - HOUR })] }, T);
  assert.deepStrictEqual(fetched, [["g", [11, 12], { missing: true, batch: 5, paced: true }]], "only the watch set to fetch asks, for the chapters past where it was chosen (another device's look moved `known` already: no matter)");
  fetched.length = 0;
  await W.tick({ ...fetchDeps, listWatches: async () => [watch({ id: "z|wtr-lab.com", novel: "z", known: 9, above: 9, then: "fetch", lastCheck: T - HOUR })] }, T);
  assert.deepStrictEqual(fetched, [], "nothing past it: nothing asked");
  await W.tick({ ...fetchDeps, listWatches: async () => [watch({ id: "z2|wtr-lab.com", novel: "z", known: 7, then: "fetch", lastCheck: T - HOUR })] }, T);
  assert.deepStrictEqual(fetched.map((f) => f[1]), [[8, 9]], "a watch set to fetch before `above` was kept: past what it knew");
  // a look of a site watch set to fetch only says what it found (the fetching is fill's)
  saved.length = 0;
  await W.tick({ ...fetchDeps, chapterList: async () => [], listWatches: async () => [watch({ id: "g2|wtr-lab.com", novel: "g2", known: 10, then: "fetch" })], check: async () => ({ kind: "list", chapters: list(12) }) }, T);
  assert.strictEqual(saved[0].lastResult, "2 new chapters");
  // a source followed page by page has no list: what its look finds is fetched there and then
  saved.length = 0;
  fetched.length = 0;
  await W.tick({ ...fetchDeps, listWatches: async () => [watch({ id: "c3|uuread.tw", novel: "c3", source: "uuread.tw", then: "fetch", from: "https://www.uuread.tw/chapter/1/10.html" })], check: async () => ({ kind: "follow", urls: ["https://www.uuread.tw/chapter/1/11.html"], more: false }) }, T);
  assert.deepStrictEqual([fetched.length, saved[0].lastResult], [1, "1 new chapter · fetching it to translate"], "followed page by page: fetched when found");
  saved.length = 0;
  await W.tick({ ...deps, fetchChapters: async () => { throw new Error("the extension's page did not answer"); }, listWatches: async () => [watch({ id: "c2|uuread.tw", novel: "c2", source: "uuread.tw", then: "fetch", from: "https://www.uuread.tw/chapter/1/10.html" })], check: async () => ({ kind: "follow", urls: ["https://www.uuread.tw/chapter/1/11.html"], more: false }) }, T);
  assert.strictEqual(saved[0].lastResult, "1 new chapter · not fetched: the extension's page did not answer", "a chapter that could not be asked for is said, and the look still counts");
  assert.strictEqual(saved[0].from, "https://www.uuread.tw/chapter/1/11.html");

  // ---- one extension does the triggers: the library's triggerDevice; with none, or one taken off the library, every one ----
  const me = (id, others = []) => ({ device: { id }, devices: [{ id }, ...others.map((x) => ({ id: x }))] });
  assert.strictEqual(W.mayRun({}, me("aa")), true, "none chosen: every extension");
  assert.strictEqual(W.mayRun({ triggerDevice: { id: "aa" } }, me("aa", ["bb"])), true, "the one chosen");
  assert.strictEqual(W.mayRun({ triggerDevice: { id: "bb" } }, me("aa", ["bb"])), false, "another one chosen: not this one");
  assert.strictEqual(W.mayRun({ triggerDevice: { id: "cc" } }, me("aa", ["bb"])), true, "the one chosen is no longer in the library: every one");
  let looked = 0;
  const notMine = await W.tick({ ...deps, settings: async () => ({ triggerDevice: { id: "bb" } }), me: async () => me("aa", ["bb"]), listWatches: async () => { looked++; return []; } }, T);
  assert.deepStrictEqual([notMine.notMine, looked], [true, 0], "an extension that does not do the triggers looks at nothing");

  // ---- then: "all": every chapter of the list that is not here, a batch each pass, whether or not the watch is due ----
  const lists = { "wtr-lab:5045": list(644), "key:chapter/9": [[1, "Chapter 1: One", "https://www.uuread.tw/chapter/9/100.html"], [2, "Chapter 2: Two", "https://www.uuread.tw/chapter/9/101.html"]] };
  const asksAll = [];
  let reply = { asked: 10 };
  const allDeps = {
    ...deps,
    bindingKey: (u) => "key:" + new URL(u).pathname.split("/").slice(1, 3).join("/"),
    chapterList: async (key) => lists[key] || [],
    fetchChapters: async (items, w, opts) => { asksAll.push([w.id, items.length, opts]); return reply; }
  };
  const wAll = watch({ id: "wtr-lab:5045|wtr-lab.com", novel: "wtr-lab:5045", known: 644, then: "all", lastCheck: T - HOUR }); // not due
  const uAll = watch({ id: "u|uuread.tw", novel: "u", source: "uuread.tw", then: "all", from: "https://www.uuread.tw/chapter/9/101.html", known: 2, lastCheck: T - HOUR });
  saved.length = 0;
  let pass = await W.tick({ ...allDeps, listWatches: async () => [wAll, uAll, watch({ id: "t|wtr-lab.com", novel: "t", lastCheck: T - HOUR })] }, T);
  assert.deepStrictEqual(asksAll, [["wtr-lab:5045|wtr-lab.com", 644, { missing: true, batch: 5, paced: true }], ["u|uuread.tw", 2, { missing: true, batch: 3, paced: false }]],
    "each watch set to every chapter hands its whole list over (the page leaves out what is here), wtr-lab 5 at a time, a translated source 3");
  assert.deepStrictEqual([pass.checked.length, saved.length], [0, 0], "not due: nothing looked at, and the watch is not written (no record a minute)");
  assert.strictEqual(W.listKey(allDeps, uAll), "key:chapter/9", "a source's list is kept under its chapters' site and folder");
  reply = { asked: 0, complete: true };
  asksAll.length = 0;
  await W.tick({ ...allDeps, listWatches: async () => [wAll] }, T);
  await W.tick({ ...allDeps, listWatches: async () => [wAll] }, T + 60000);
  assert.strictEqual(asksAll.length, 1, "once nothing is left to fetch, the list is not gone through again...");
  await W.tick({ ...allDeps, listWatches: async () => [{ ...wAll, lastCheck: T - 12 * HOUR }], check: async () => ({ kind: "list", chapters: list(645) }) }, T + 120000);
  assert.strictEqual(asksAll.length, 2, "...until its next look");
  pass = await W.tick({ ...allDeps, fetchChapters: async () => { throw new Error("down"); }, listWatches: async () => [uAll, { ...wAll, id: "w2" }] }, T);
  assert.deepStrictEqual(pass.filling.map((f) => [f.id, f.error || ""]), [["u|uuread.tw", "down"], ["w2", "down"]], "a batch that cannot be asked for is said, and the next watch still gets its turn");

  // ---- titles: the number apart from the words ----
  assert.deepStrictEqual(W.splitTitle("第12章 重生"), { prefixed: true, body: "重生" });
  assert.deepStrictEqual(W.splitTitle("10.第10章 这就是巫师吗"), { prefixed: true, body: "这就是巫师吗" }, "a leading '10.' is ignored");
  assert.deepStrictEqual(W.splitTitle("后记"), { prefixed: false, body: "后记" });
  assert.strictEqual(W.composeTitle(12, "第12章 重生", "Rebirth"), "Chapter 12: Rebirth");
  assert.strictEqual(W.composeTitle(12, "第12章", ""), "Chapter 12", "a chapter with no title words");
  assert.strictEqual(W.composeTitle(5, "后记", "Afterword"), "Chapter 5: Afterword", "an unnumbered title is its place in the list, then its translation");
  assert.deepStrictEqual(W.splitTitle("001傅家三爷，信佛如魔新书求收（2/3）"), { prefixed: false, body: "傅家三爷，信佛如魔新书求收（2/3）" }, "a leading list number before Chinese words is dropped");
  assert.strictEqual(W.composeTitle(2, "001傅家三爷，信佛如魔新书求收（2/3）", ""), "Chapter 2: 傅家三爷，信佛如魔新书求收（2/3）", "the index first, the site's words after it");

  // ---- titles are translated once and remembered ----
  const area = { data: {}, get: async (k) => ({ [k]: area.data[k] }), set: async (o) => Object.assign(area.data, o) };
  const asked = [];
  const tr = async (texts) => { asked.push(texts.slice()); return texts.map((t) => "EN:" + t); };
  assert.deepStrictEqual(await W.cachedTitles(area, tr, ["a", "b", "a"]), ["EN:a", "EN:b", "EN:a"]);
  assert.deepStrictEqual(asked, [["a", "b"]], "each distinct title is asked for once");
  assert.deepStrictEqual(await W.cachedTitles(area, tr, ["b", "c"]), ["EN:b", "EN:c"]);
  assert.deepStrictEqual(asked[1], ["c"], "only the title not seen before is asked for");
  assert.deepStrictEqual(await W.cachedTitles(area, async () => { throw new Error("must not be called"); }, ["a", "c"]), ["EN:a", "EN:c"], "a list looked at again asks for nothing");

  // ---- a source with a chapter-list page ----
  const tocList = (n) => Array.from({ length: n }, (_, i) => [i + 1, "第" + (i + 1) + "章 标题" + (i + 1), "https://www.uuread.tw/chapter/9/" + (100 + i) + ".html"]);
  const tocDeps = (found, w, log) => ({
    listWatches: async () => [w],
    check: async () => ({ kind: "toc", tocUrl: "https://www.uuread.tw/9", chapters: found }),
    saveWatch: async (x) => void log.saved.push(x),
    addNotice: async (n) => void log.notices.push(n),
    saveChapterIndex: async (r) => void log.indexes.push(r),
    bindingKey: (u) => "key:" + new URL(u).pathname.split("/").slice(1, 3).join("/"),
    translateTitles: async (t) => t.map((x) => "EN-" + x)
  });
  const L = () => ({ saved: [], notices: [], indexes: [] });
  const uw = (over) => watch({ id: "n|uuread.tw", novel: "n", source: "uuread.tw", url: "", from: "https://www.uuread.tw/chapter/9/102.html", known: 0, ...over });

  let lg = L();
  await W.tick(tocDeps(tocList(3), uw({}), lg), T);
  assert.deepStrictEqual([lg.saved[0].known, lg.saved[0].from, lg.saved[0].lastResult, lg.notices.length], [3, "https://www.uuread.tw/chapter/9/102.html", "watching: 3 chapters so far", 0], "the first look is a baseline: the whole list noted, nothing announced");
  assert.deepStrictEqual([lg.indexes[0].key, lg.indexes[0].source, lg.indexes[0].url, lg.indexes[0].chapters[1]], ["key:chapter/9", "uuread.tw", "https://www.uuread.tw/9", [2, "Chapter 2: EN-标题2", "https://www.uuread.tw/chapter/9/101.html", "第2章 标题2"]], "every chapter goes to the library, titled in English, under the key the chapters' site and folder share");

  lg = L();
  await W.tick(tocDeps(tocList(5), uw({ known: 3, from: "https://www.uuread.tw/chapter/9/102.html" }), lg), T);
  assert.deepStrictEqual(lg.notices[0], { novel: "n", source: "uuread.tw", count: 2, firstNum: 4, lastNum: 5, first: "https://www.uuread.tw/chapter/9/103.html", latest: "https://www.uuread.tw/chapter/9/104.html" }, "the chapters after the one it had got to");
  assert.deepStrictEqual([lg.saved[0].known, lg.saved[0].from, lg.saved[0].lastResult, lg.indexes.length], [5, "https://www.uuread.tw/chapter/9/104.html", "2 new chapters", 1], "and it moves on, so they are announced once");

  lg = L();
  const asks = [];
  await W.tick({ ...tocDeps(tocList(5), uw({ known: 3, then: "fetch" }), lg), chapterList: async (key) => (lg.indexes.find((ix) => ix.key === key) || { chapters: [] }).chapters,
    fetchChapters: async (items) => { asks.push(...items); return { asked: items.length }; } }, T);
  assert.deepStrictEqual(asks, [{ num: 4, title: "Chapter 4: EN-标题4", url: "https://www.uuread.tw/chapter/9/103.html" }, { num: 5, title: "Chapter 5: EN-标题5", url: "https://www.uuread.tw/chapter/9/104.html" }], "a source site's new chapters are asked for, from the list the look saved, with their English titles");
  assert.strictEqual(lg.saved[0].lastResult, "2 new chapters");

  lg = L();
  await W.tick(tocDeps(tocList(5), uw({ known: 3, from: "https://www.uuread.tw/chapter/9/gone.html" }), lg), T);
  assert.strictEqual(lg.notices[0].count, 2, "if its chapter is no longer listed, those numbered above the known one are new");

  lg = L();
  await W.tick(tocDeps(tocList(3), uw({ known: 3, from: "https://www.uuread.tw/chapter/9/102.html" }), lg), T);
  assert.deepStrictEqual([lg.saved[0].lastResult, lg.notices.length, lg.indexes.length], ["no new chapters", 0, 0], "nothing new: no notice, and the list is not sent again");

  lg = L();
  const failingTr = { ...tocDeps(tocList(2), uw({}), lg), translateTitles: async () => { throw new Error("translator down"); } };
  await W.tick(failingTr, T);
  assert.strictEqual(lg.indexes[0].chapters[0][1], "Chapter 1: 标题1", "if titles cannot be translated the list is still complete, with the original words");

  // a list asked for by a person is saved at once with the site's own titles (no translating first), then again in English
  lg = L();
  const quickDeps = { ...tocDeps(tocList(2), uw({}), lg), translateTitles: async () => { throw new Error("must not translate in the quick pass"); } };
  await W.apply(quickDeps, uw({}), { kind: "toc", tocUrl: "https://www.uuread.tw/9", chapters: tocList(2), quick: true }, T);
  assert.strictEqual(lg.indexes[0].chapters[0][1], "Chapter 1: 标题1", "the quick pass keeps the site's words and does not wait for a translator");
  await W.apply(tocDeps(tocList(2), uw({}), lg), uw({}), { kind: "toc", tocUrl: "https://www.uuread.tw/9", chapters: tocList(2) }, T);
  assert.strictEqual(lg.indexes[1].chapters[0][1], "Chapter 1: EN-标题1", "and the second pass saves the list again with English titles");

  // ---- a first look with nothing known is a baseline: no flood of "new" chapters ----
  saved.length = 0;
  notices.length = 0;
  indexes.length = 0;
  await W.tick({ ...deps, listWatches: async () => [watch({ id: "f|wtr-lab.com", novel: "f", known: 0 })], check: async () => ({ kind: "list", chapters: list(217) }) }, T);
  const f = saved.find((w) => w.novel === "f");
  assert.deepStrictEqual([f.known, f.lastResult, notices.length, indexes.length], [217, "watching: 217 chapters so far", 0, 1], "the 217 chapters already there are noted and kept for the library, not announced");

  // ---- failures are recorded, not thrown, and the next watch still runs ----
  saved.length = 0;
  const bad = await W.tick({
    ...deps,
    listWatches: async () => [watch({ id: "x|wtr-lab.com", novel: "x" }), watch({ id: "y|wtr-lab.com", novel: "y" })],
    check: async (w) => { if (w.novel === "x") throw new Error("HTTP 403"); return { kind: "list", chapters: list(10) }; }
  }, T);
  assert.strictEqual(bad.checked.length, 2);
  assert.strictEqual(saved.find((w) => w.novel === "x").lastResult, "failed: HTTP 403", "the reason is kept for the page to show");
  assert.strictEqual(saved.find((w) => w.novel === "x").lastCheck, T, "and it is not tried again before its time");
  assert.strictEqual(saved.find((w) => w.novel === "y").lastResult, "no new chapters");

  // ---- two passes at once: the second does nothing ----
  let release;
  const slow = { ...deps, listWatches: () => new Promise((r) => (release = r)) };
  const first = W.tick(slow, T);
  assert.deepStrictEqual(await W.tick(slow, T), { skipped: true }, "a pass in progress is not started again");
  release([]);
  await first;

  // ---- a source that stops answering shows up as the server being unreachable: the pass fails as a whole, without side effects ----
  await assert.rejects(W.tick({ ...deps, listWatches: async () => { throw new Error("server down"); } }, T), /server down/);
  assert.deepStrictEqual(await W.tick({ ...deps, listWatches: async () => [] }, T), { checked: [], filling: [] }, "and the next pass works again (the lock is released)");

  console.log("OK — watcher checks passed");
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
