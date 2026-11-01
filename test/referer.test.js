// The Referer a chapter's pictures are asked for with (referer.js): a session rule for the pictures' hosts while they are fetched, taken away after, and the
// service worker doing it for a page that cannot. Run: node test/referer.test.js
const assert = require("assert");
const path = require("path");

const rules = new Map(); // id -> rule, as the browser would hold them
const calls = [];
globalThis.chrome = {
  runtime: { id: "abcdefgh", sendMessage: async (m) => { calls.push(m); return { ok: true }; } },
  declarativeNetRequest: {
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const r of addRules) rules.set(r.id, r);
    }
  }
};
const Referer = require(path.join(__dirname, "..", "src", "shared", "referer.js"));
const refererOf = (host) => { const r = rules.get(Referer.ruleId(host)); return r && r.action.requestHeaders[0].value; };

(async () => {
  // the rule: set Referer for requests the extension makes to that host
  const rule = Referer.ruleFor("cdn.example.com", "https://example.com/book/1", "abcdefgh");
  assert.deepStrictEqual(rule.action, { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: "https://example.com/book/1" }] });
  assert.deepStrictEqual(rule.condition, { requestDomains: ["cdn.example.com"], resourceTypes: ["xmlhttprequest"], initiatorDomains: ["abcdefgh"] }, "only for the extension's own requests, only fetches");
  assert.ok(!("initiatorDomains" in Referer.ruleFor("cdn.example.com", "https://example.com/", "").condition), "(no initiator named where the pages have none to name)");
  assert.notStrictEqual(Referer.ruleId("a.example.com"), Referer.ruleId("b.example.com"));
  assert.strictEqual(Referer.ruleId("a.example.com"), Referer.ruleId("a.example.com"), "the same host, the same rule: a worker that forgot can still replace it");

  // set while the pictures are fetched, one rule for each host, taken away after
  const release = await Referer.use(["https://cdn.example.com/1.webp", "https://cdn.example.com/2.webp", "https://img.example.org/3.png"], "https://example.com/book/1");
  assert.strictEqual(rules.size, 2, "one rule for each host");
  assert.strictEqual(refererOf("cdn.example.com"), "https://example.com/book/1");
  assert.strictEqual(refererOf("img.example.org"), "https://example.com/book/1");
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(rules.size, 0, "gone when the fetching is done");

  // two chapters of one site at once: the later Referer is in force, and when it is released the earlier one comes back
  const a = await Referer.use(["https://cdn.example.com/a.webp"], "https://example.com/book/1");
  const b = await Referer.use(["https://cdn.example.com/b.webp"], "https://example.com/book/2");
  assert.strictEqual(refererOf("cdn.example.com"), "https://example.com/book/2");
  b();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(refererOf("cdn.example.com"), "https://example.com/book/1", "the first chapter goes on with its own");
  a();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(rules.size, 0);

  // nothing to send (no Referer, or not an address): nothing is set
  (await Referer.use(["https://cdn.example.com/a.webp"], ""))();
  (await Referer.use(["https://cdn.example.com/a.webp"], "javascript:alert(1)"))();
  assert.strictEqual(rules.size, 0);

  // the service worker's side
  assert.strictEqual(Referer.answerMessage({ type: "something else" }), null, "not its message");
  assert.deepStrictEqual(await Referer.answerMessage({ type: "referer:set", host: "cdn.example.com", referer: "https://example.com/x" }), { ok: true });
  assert.strictEqual(refererOf("cdn.example.com"), "https://example.com/x");
  assert.deepStrictEqual(await Referer.answerMessage({ type: "referer:clear", host: "cdn.example.com" }), { ok: true });
  assert.strictEqual(rules.size, 0);
  assert.ok((await Referer.answerMessage({ type: "referer:set", host: "bad host/../", referer: "https://example.com/x" })).error, "a host that is not one is refused");
  assert.ok((await Referer.answerMessage({ type: "referer:set", host: "cdn.example.com", referer: "file:///etc/passwd" })).error, "and a Referer that is not an address");
  assert.strictEqual(rules.size, 0);

  // a page without the API (Chrome's offscreen page) asks the worker, which holds no state of its own
  const dnr = globalThis.chrome.declarativeNetRequest;
  delete globalThis.chrome.declarativeNetRequest;
  calls.length = 0;
  const viaWorker = await Referer.use(["https://cdn.example.com/a.webp"], "https://example.com/book/3");
  assert.deepStrictEqual(calls, [{ type: "referer:set", host: "cdn.example.com", referer: "https://example.com/book/3" }]);
  viaWorker();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls[1], { type: "referer:clear", host: "cdn.example.com" });

  // and where there is neither, or the browser refuses, the pictures go on without it
  globalThis.chrome.runtime.sendMessage = async () => ({ error: "no permission for that host" });
  const without = await Referer.use(["https://cdn.example.com/a.webp"], "https://example.com/book/4");
  without(); // (does nothing, does not throw)
  globalThis.chrome.declarativeNetRequest = dnr;
  console.log("referer: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
