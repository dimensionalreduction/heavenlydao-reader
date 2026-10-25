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

  // the library: this extension is its main device
  const st = { state: "member", libId: "L1", main: true, sharing: true, joins: [], devices: [{ id: "d1", name: "Chrome (extension)" }] };
  let notices = [];
  const lib = { status: () => st, sharedBooks: async () => ({ b1: { title: "Shared Book" } }),
    api: async (m, p) => (p === "/api/notices" ? { notices } : p === "/api/novels" ? { novels: [{ id: "wtr-lab:5", title: "Watched Novel" }] } : null) };
  // the libraries you follow
  let books = { x: { title: "Their Book", n: 3 } };
  const follows = { follows: async () => [{ libId: "F1", readKey: "k", name: "Ana's", followed: true }], body: async (l, k) => (k === "head" ? { books } : null) };
  // your novels' chapters: { novel: last chapter number }
  let mine = { "My Novel": 10 };
  const novelsOf = () => new Map(Object.entries(mine).map(([name, last]) => [name, { name, chapters: Array.from({ length: last }, (_, i) => ({ num: i + 1, indexedOnly: false })) }]));
  const chapters = () => ({ getIndex: async () => ({}), listTranslations: async () => [] });

  const make = () => NoticeHost.create({ lib: async () => lib, follows, chapters, novelsOf, show, storage, now: () => t });
  let h = make();

  // ---- the first look: nothing is news ----
  notices = [{ id: "n0", novel: "wtr-lab:5", source: "wtr-lab", count: 2, seen: false }];
  await h.look("all");
  assert.deepStrictEqual(shown, [], "what was there before is not told");

  // ---- a request to join: told once, with what answers it ----
  st.joins = [{ id: "j1", name: "Phone" }];
  await h.look("devices");
  await h.look("devices");
  assert.deepStrictEqual(shown.map((x) => [x.kind, x.title, x.join && x.join.id]), [["join", "“Phone” asks to join your library", "j1"]], "told once");
  // let in: its buttons go, and the device joined is told
  st.joins = [];
  st.devices = st.devices.concat({ id: "d2", name: "Phone" });
  await h.look("devices");
  assert.strictEqual(h.list().find((x) => x.kind === "join").join.done, "answered");
  assert.strictEqual(shown[1].title, "“Phone” joined your library");

  // ---- the watch's finding, the library followed, your novels (a minute after the first look) ----
  t += 2 * 60 * 1000;
  notices = [{ id: "n0", novel: "wtr-lab:5", source: "wtr-lab", count: 2, seen: false }, { id: "n1", novel: "wtr-lab:5", source: "wtr-lab", count: 3, firstNum: 11, lastNum: 13, seen: false }];
  books = { x: { title: "Their Book", n: 5 }, y: { title: "New One", n: 1 } };
  mine = { "My Novel": 12, "Uploaded": 300 };
  shown.length = 0;
  await h.look("all");
  assert.deepStrictEqual(shown.map((x) => x.title), [
    "My Novel: 2 new chapters",
    "Watched Novel: 3 new chapters on wtr-lab",
    "Their Book: 2 new chapters",
    "New in Ana's: New One"
  ], "each told once; an old one and a new novel of yours are not");
  assert.strictEqual(shown[0].href, "#/n/My%20Novel", "the site's address of the novel");
  assert.strictEqual(shown[2].href, "#/fb/F1/x", "the site's address of a followed novel");
  assert.strictEqual(shown[1].text, "Chapters 11 to 13.");

  // ---- a page of the site open: nothing shown, nothing kept (the page told it); not told again later ----
  pageOpen = true;
  books = { x: { title: "Their Book", n: 6 }, y: { title: "New One", n: 1 } };
  await h.look("all");
  pageOpen = false;
  shown.length = 0;
  await h.look("all");
  assert.deepStrictEqual(shown, [], "told by the page: not again");

  // ---- the site's settings: a library off, a kind off, the extension off ----
  h.setSettings({ libs: { F1: false } });
  books = { x: { title: "Their Book", n: 7 }, y: { title: "New One", n: 1 } };
  await h.look("all");
  assert.deepStrictEqual(shown, [], "that library off");
  h.setSettings({ kinds: { join: false } });
  st.joins = [{ id: "j2", name: "Tablet" }];
  await h.look("devices");
  assert.deepStrictEqual(shown, [], "that kind off");
  h.setSettings({ ext: false });
  st.joins = [{ id: "j3", name: "Laptop" }];
  await h.look("devices");
  assert.deepStrictEqual(shown, [], "the extension's notifications off");
  h.setSettings({ until: t + 30 * 60 * 1000 });
  st.joins = [{ id: "j4", name: "Watch" }];
  await h.look("devices");
  assert.deepStrictEqual(shown, [], "turned off for 30 minutes");

  // ---- kept across a restart: what was told, and the list shown ----
  h.setSettings({});
  h = make();
  await h.look("all");
  assert.deepStrictEqual(shown, [], "nothing told again after a restart");
  assert.ok(h.list().length >= 6, "the list shown is kept (the site's bell takes it in)");

  // ---- not the main device (the site's page is, in this browser): who asks is said, with where to allow it, and no buttons ----
  st.main = false;
  st.devices = [{ id: "d0", name: "Chrome on Windows (library page)", main: true }, { id: "d1", name: "Chrome (extension)" }, { id: "d2", name: "Phone" }];
  st.joins = [];
  st.asking = [{ id: "j9", name: "Tablet" }];
  h.setSettings({});
  await h.look("devices");
  assert.deepStrictEqual(shown.filter((x) => x.kind === "join").map((x) => [x.title, x.text, x.join.elsewhere]), [["“Tablet” asks to join your library", "Allow it on your main device (Chrome on Windows (library page)): Settings › Library.", true]]);
  st.asking = [];
  await h.look("devices");
  assert.strictEqual(h.list().find((x) => x.id === "join:L1:j9").join.done, "answered", "no longer asking");
  shown.length = 0;

  // ---- not in a library: nothing ----
  st.state = "joining";
  st.joins = [{ id: "j4", name: "Nope" }];
  await h.look("all");
  assert.deepStrictEqual(shown, []);

  console.log("OK — notice-host checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
