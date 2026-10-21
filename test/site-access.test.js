// Which sites the extension may read (site-access.js): asked of the browser where it can, of the background where it cannot, noted for the popup
// when refused. Run: node test/site-access.test.js
const assert = require("assert");
const path = require("path");
const SA = require(path.join(__dirname, "..", "src", "shared", "site-access.js"));

// A browser: `granted` is the list of patterns it gave; permissions.contains answers for a pattern covered by one of them.
function browserWith(granted, { storage = true, permissions = true, background = null } = {}) {
  const store = {};
  const covers = (pattern) => SA.covered(granted, pattern); // (a grant covers what its pattern says: https://*.host/* the host and its subdomains)
  const ext = { runtime: { sendMessage: async (m) => (background ? background(m) : undefined) } };
  if (permissions) ext.permissions = { contains: async ({ origins }) => origins.every(covers), request: async ({ origins }) => { granted.push(...origins); return true; } };
  if (storage) ext.storage = { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } };
  ext.store = store;
  return ext;
}

(async () => {
  // ---- the permission a site's address needs ----
  assert.strictEqual(SA.patternOf("https://www.69shuba.com/txt/1/2"), "https://*.69shuba.com/*", "www is dropped: the permission covers the whole site");
  assert.strictEqual(SA.patternOf("https://Novel543.COM/a"), "https://*.novel543.com/*");
  assert.strictEqual(SA.patternOf("data:text/plain,x"), "", "not a site");
  assert.strictEqual(SA.hostOfPattern("https://*.twkan.com/*"), "twkan.com");

  // ---- sites read with no question ----
  const none = browserWith([]);
  for (const url of ["https://generativelanguage.googleapis.com/v1beta/models", "https://translate.googleapis.com/translate_a/single", "https://heavenlydao.com/", "https://p2p-library.pages.dev/", "http://localhost:3000/", "data:text/plain,x"]) {
    assert.strictEqual(await SA.has(url, none), true, url + " needs no permission");
  }
  assert.strictEqual(await SA.has("https://anything.example/", null), true, "no browser to ask: not stopped");

  // ---- allowed and not allowed ----
  const ext = browserWith(["https://*.69shuba.com/*"]);
  assert.strictEqual(await SA.has("https://www.69shuba.com/txt/1/2", ext), true, "an allowed site");
  assert.strictEqual(await SA.has("https://twkan.com/txt/1", ext), false, "a site not allowed");
  await SA.guard("https://www.69shuba.com/txt/1/2", ext);
  await assert.rejects(SA.guard("https://twkan.com/txt/1", ext), (e) => e.needsAccess === "twkan.com" && /Allow/.test(e.message), "refused with what to do");
  assert.ok(ext.store[SA.KEY]["twkan.com"] > 0, "the need is noted for the popup");

  // ---- the popup lists what is not allowed yet, and forgets what is ----
  assert.deepStrictEqual((await SA.pending(ext)).map((p) => p.host), ["twkan.com"]);
  // a grant of the site's own address (as the dev build and the site's manifest entry give) is as good as one for the whole site
  const own = browserWith(["https://wtr-lab.com/*"]);
  assert.strictEqual(await SA.has("https://wtr-lab.com/api/reader/get", own), true, "https://host/* covers the host itself");
  assert.strictEqual(await SA.has("https://m.wtr-lab.com/x", own), false, "but not a subdomain");
  assert.strictEqual(await SA.request(["https://*.twkan.com/*"], ext), true, "the click: the browser gives it");
  assert.deepStrictEqual(await SA.pending(ext), [], "allowed now: nothing left to ask");
  assert.strictEqual(await SA.has("https://twkan.com/txt/1", ext), true);
  const denied = browserWith([]);
  denied.permissions.request = async () => false;
  assert.strictEqual(await SA.request(["https://*.piaotia.com/*"], denied), false, "the person said no");

  // ---- the offscreen page: no permissions, no storage: the background answers ----
  const bg = browserWith(["https://*.uukanshu.cc/*"]);
  const sent = [];
  const offscreen = browserWith([], { storage: false, permissions: false, background: async (m) => { sent.push(m); return SA.answerMessage(m, bg); } });
  assert.strictEqual(await SA.has("https://uukanshu.cc/book/1", offscreen), true, "asked of the background: yes");
  assert.strictEqual(await SA.has("https://www.trxs.cc/book/1", offscreen), false, "asked of the background: no");
  await assert.rejects(SA.guard("https://www.trxs.cc/book/1", offscreen), (e) => e.needsAccess === "trxs.cc");
  assert.ok(sent.some((m) => m.type === "access:note" && m.pattern === "https://*.trxs.cc/*"), "the need goes to the background to be noted");
  assert.ok(bg.store[SA.KEY]["trxs.cc"] > 0, "and the background notes it");
  assert.strictEqual(SA.answerMessage({ type: "something else" }, bg), null, "other messages are not these");
  const silent = browserWith([], { storage: false, permissions: false });
  assert.strictEqual(await SA.has("https://trxs.cc/", silent), true, "no answer from anyone: not this module's place to stop the request");

  // ---- scripts: which match patterns the granted origins cover ----
  const granted = ["https://*.69shuba.com/*", "https://wtr-lab.com/*"];
  assert.strictEqual(SA.covered(granted, "https://www.69shuba.com/book/*"), true, "a page of an allowed site");
  assert.strictEqual(SA.covered(granted, "https://69shuba.com/book/*"), true, "the bare domain too");
  assert.strictEqual(SA.covered(granted, "https://*.69shuba.com/*"), true, "the site's own pattern");
  assert.strictEqual(SA.covered(granted, "https://wtr-lab.com/*"), true);
  assert.strictEqual(SA.covered(granted, "https://twkan.com/*"), false, "a site not allowed");
  assert.strictEqual(SA.covered(granted, "https://evil69shuba.com/*"), false, "a different domain that ends the same");
  assert.strictEqual(SA.covered(["https://*/*"], "https://twkan.com/*"), true, "every site allowed");
  assert.strictEqual(SA.covered([], "https://twkan.com/*"), false);

  // ---- fetch: only when allowed ----
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true }; };
  const fx = browserWith(["https://*.69shuba.com/*"]);
  globalThis.chrome = fx; // (the module finds the browser by itself in its own use)
  try {
    await SA.fetch("https://www.69shuba.com/a");
    await assert.rejects(SA.fetch("https://novel543.com/b"), /Allow/);
  } finally { delete globalThis.chrome; }
  assert.deepStrictEqual(calls, ["https://www.69shuba.com/a"], "the refused site was never asked");
  console.log("OK — site-access checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
