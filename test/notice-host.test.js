// The extension's notifications with no page of the site open (notice-host.js): what is told, once, and what is only noted.
// Run: node test/notice-host.test.js
const assert = require("assert");
const path = require("path");
global.Notify = require(path.join(__dirname, "..", "src", "shared", "notify.js"));
const NoticeHost = require(path.join(__dirname, "..", "src", "shared", "notice-host.js"));

(async () => {
  let t = 1_000_000;
  const mem = {};
  const storage = { get: (k) => (k in mem ? JSON.parse(mem[k]) : null), set: (k, v) => { mem[k] = JSON.stringify(v); } };
  const shown = [];
  let pageOpen = false; // a page of the site open: notice-bg.js shows nothing
  const show = async (item) => { if (pageOpen) return false; shown.push(item); return true; };

  const st = { state: "member", libId: "L1", main: true, devices: [{ id: "d1", name: "Chrome (extension)" }] };
  let notices = [];
  const lib = { status: () => st,
    api: async (m, p) => (p === "/api/notices" ? { notices } : p === "/api/novels" ? { novels: [{ id: "wtr-lab:5", title: "Watched Novel" }] } : null) };
  // your novels' chapters: { novel: last chapter number }
  let mine = { "My Novel": 10 };
  const novelsOf = () => new Map(Object.entries(mine).map(([name, last]) => [name, { name, chapters: Array.from({ length: last }, (_, i) => ({ num: i + 1, indexedOnly: false })) }]));
  const chapters = () => ({ getIndex: async () => ({}), listTranslations: async () => [] });

  const make = () => NoticeHost.create({ lib: async () => lib, chapters, novelsOf, show, storage, now: () => t });
  let h = make();

  // ---- the first look: nothing is news ----
  notices = [{ id: "n0", novel: "wtr-lab:5", source: "wtr-lab", count: 2, seen: false }];
  await h.look("all");
  assert.deepStrictEqual(shown, [], "what was there before is not told");

  // ---- the watch's finding, your novels (a minute after the first look) ----
  t += 2 * 60 * 1000;
  notices = [{ id: "n0", novel: "wtr-lab:5", source: "wtr-lab", count: 2, seen: false }, { id: "n1", novel: "wtr-lab:5", source: "wtr-lab", count: 3, firstNum: 11, lastNum: 13, seen: false }];
  mine = { "My Novel": 12, "Uploaded": 300 };
  await h.look("all");
  assert.deepStrictEqual(shown.map((x) => x.title), [
    "My Novel: 2 new chapters",
    "Watched Novel: 3 new chapters on wtr-lab"
  ], "each told once; an old one and a new novel of yours are not");
  assert.strictEqual(shown[0].href, "#/n/My%20Novel", "the site's address of the novel");
  assert.strictEqual(shown[1].text, "Chapters 11 to 13.");

  // ---- a page of the site open: nothing shown, nothing kept (the page told it); not told again later ----
  pageOpen = true;
  mine = { "My Novel": 14, "Uploaded": 300 };
  await h.look("all");
  pageOpen = false;
  shown.length = 0;
  await h.look("all");
  assert.deepStrictEqual(shown, [], "told by the page: not again");

  // ---- the site's settings: a kind off, the extension off, turned off for a while ----
  h.setSettings({ kinds: { chapters: false } });
  mine = { "My Novel": 15, "Uploaded": 300 };
  await h.look("all");
  assert.deepStrictEqual(shown, [], "that kind off");
  h.setSettings({ ext: false });
  mine = { "My Novel": 16, "Uploaded": 300 };
  await h.look("all");
  assert.deepStrictEqual(shown, [], "the extension's notifications off");
  h.setSettings({ until: t + 30 * 60 * 1000 });
  mine = { "My Novel": 17, "Uploaded": 300 };
  await h.look("all");
  assert.deepStrictEqual(shown, [], "turned off for 30 minutes");

  // ---- kept across a restart: what was told, and the list shown ----
  h.setSettings({});
  h = make();
  await h.look("all");
  assert.deepStrictEqual(shown, [], "nothing told again after a restart");
  assert.ok(h.list().length >= 2, "the list shown is kept (the site's bell takes it in)");

  // ---- not in a library: nothing ----
  st.state = "none";
  mine = { "My Novel": 30, "Uploaded": 300 };
  await h.look("all");
  assert.deepStrictEqual(shown, []);

  console.log("OK — notice-host checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
