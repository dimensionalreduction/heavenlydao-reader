// The public pool from this side (pool-share.js): the pool downloaded once a day, and, only when the person agreed, the terms they made sent once each, with a proof of work and
// nothing else. Stand-ins for storage, the library and the service.
// Run: node test/pool-share.test.js
const assert = require("assert");

const stored = {
  glossaryLibrary: {
    "wtr-lab:1": { terms: [["灵兽师", "Spirit Beast Tamer", "user", { o: "novel" }], ["散修", "Loose Cultivator", "wtr", { o: "shared:Cultivation" }], ["萧炎", "Xiao Yan", "user", { o: "novel" }]] },
    "adopted:69shuba.com/txt/9": { terms: [["御兽", "Beast Taming", "gemini", { o: "gemini" }]] },
    "adopted:upload:abc": { terms: [["青云宗", "Azure Cloud Sect", "gemini", { o: "gemini" }]] }
  }
};
global.chrome = { storage: { local: { get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, stored[x]])) : { [k]: stored[k] }), set: async (o) => Object.assign(stored, o) } } };
global.TermPool = require("../src/shared/term-pool.js");
let settings = {};
global.GlossaryServer = { api: async (m, p) => { if (p === "/api/settings") return settings; throw new Error("unexpected " + p); } };
const PoolShare = require("../src/shared/pool-share.js");

const requests = [];
let down = { v: 1, at: 1, entries: [["散修", "Loose Cultivator", 40], ["谎", "x", 9], ["bad"]] };
const fetcher = async (url, opts) => {
  requests.push([url, opts]);
  if (/snapshot$/.test(url)) return { ok: true, json: async () => down };
  return { ok: true };
};

(async () => {
  // not agreed: the pool is downloaded, nothing is sent
  let out = await PoolShare.maybeRun({ force: true, fetcher });
  assert.deepStrictEqual(out, { downloaded: 2, sent: 0 }, "the pool comes down, nothing goes up");
  assert.deepStrictEqual(stored.centralPool.entries.map((e) => e[0]), ["散修", "谎"], "its terms and renderings only");
  assert.deepStrictEqual(requests.map(([u]) => u), ["https://pool.heavenlydao.com/api/pool/snapshot"]);
  assert.strictEqual(requests[0][1].credentials, "omit");
  assert.strictEqual(requests[0][1].referrerPolicy, "no-referrer");

  // once a day
  assert.deepStrictEqual(await PoolShare.maybeRun({ fetcher }), { skipped: true });
  assert.strictEqual(requests.length, 1);

  // agreed: what the person made goes, once each
  settings = { sharePool: true };
  requests.length = 0;
  out = await PoolShare.maybeRun({ force: true, fetcher });
  assert.strictEqual(out.sent, 2);
  const posts = requests.filter(([u]) => /contribute$/.test(u));
  assert.strictEqual(posts.length, 1);
  const body = JSON.parse(posts[0][1].body);
  assert.deepStrictEqual(Object.keys(body).sort(), ["n", "pairs", "t", "v"], "a version, a time, the pairs, a proof: nothing about who or which novels");
  assert.deepStrictEqual(body.pairs.slice().sort(), [["灵兽师", "Spirit Beast Tamer"], ["御兽", "Beast Taming"]].sort(), "what they made: not wtr-lab's, not a name, not an uploaded file's novel");
  assert.ok(PoolShare.zeroBits(await PoolShare.sha256Hex(body.n + ":" + JSON.stringify({ v: 1, t: body.t, pairs: body.pairs })), 14), "with its proof of work");
  assert.strictEqual(posts[0][1].credentials, "omit");
  assert.strictEqual(stored.poolSent.length, 2);
  assert.ok(stored.poolSent.every((k) => /^[0-9a-f]{12}$/.test(k)), "what was sent is remembered as short hashes");

  // not again, and a new one when there is one
  requests.length = 0;
  assert.strictEqual((await PoolShare.maybeRun({ force: true, fetcher })).sent, 0);
  assert.strictEqual(requests.filter(([u]) => /contribute$/.test(u)).length, 0);
  stored.glossaryLibrary["adopted:69shuba.com/txt/9"].terms.push(["金丹期", "Golden Core Stage", "gemini", { o: "gemini" }]);
  assert.strictEqual((await PoolShare.maybeRun({ force: true, fetcher })).sent, 1);
  assert.deepStrictEqual(JSON.parse(requests.filter(([u]) => /contribute$/.test(u))[0][1].body).pairs, [["金丹期", "Golden Core Stage"]]);

  // the person turned the pool off: it is not downloaded; turned sharing off: nothing goes
  settings = { poolHints: false, sharePool: false };
  requests.length = 0;
  stored.glossaryLibrary["adopted:69shuba.com/txt/9"].terms.push(["丹药", "Medicinal Pill", "gemini", { o: "gemini" }]);
  assert.deepStrictEqual(await PoolShare.maybeRun({ force: true, fetcher }), { downloaded: 0, sent: 0 });
  assert.strictEqual(requests.length, 0);

  // a service that does not answer: nothing breaks, nothing is marked sent
  settings = { sharePool: true };
  const before = stored.poolSent.length;
  const broken = async () => { throw new Error("offline"); };
  assert.deepStrictEqual(await PoolShare.maybeRun({ force: true, fetcher: broken }), { downloaded: 0, sent: 0 });
  assert.strictEqual(stored.poolSent.length, before);
  const refusing = async (url) => ({ ok: false });
  assert.strictEqual((await PoolShare.maybeRun({ force: true, fetcher: refusing })).sent, 0);
  assert.strictEqual(stored.poolSent.length, before, "a request the service did not take is sent again later");

  // the downloaded pool is a layer of what a translation starts from
  global.WtrTerms = require("../src/shared/wtr-terms.js");
  global.TermMatch = require("../src/shared/term-match.js");
  global.BASE_GLOSSARY = [];
  global.GlossaryServer.setBinding = async () => {};
  stored.glossaryRev = 1;
  const PoolHints = require("../src/shared/pool-hints.js");
  const hints = await PoolHints.entriesFor("他是一名散修。", []);
  assert.deepStrictEqual(hints.map((e) => [e.terms[0], e.translation]), [["散修", "Loose Cultivator"]], "from the public pool, with no novel of the library having it");

  console.log("pool-share: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
