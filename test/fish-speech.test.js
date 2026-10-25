// Fish Audio's speech for the library site's Listen tab (fish-speech.js): only the site's tab may ask, only Fish Audio's speech and balance addresses are
// called, the key is not kept, and nothing is called before the browser has let the extension talk to api.fish.audio. Run: node test/fish-speech.test.js
const assert = require("assert");
const path = require("path");

const shared = (f) => path.join(__dirname, "..", "src", "shared", f);
globalThis.SITE_BRIDGE_MATCHES = ["https://heavenlydao.com/*", "http://localhost:3000/*"];
const granted = [];
const store = {};
globalThis.chrome = {
  runtime: { id: "the-extension" },
  permissions: { contains: async ({ origins }) => origins.every((o) => granted.some((g) => g === o || (g === "https://*.api.fish.audio/*" && o === "https://api.fish.audio/*"))) },
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } }
};
globalThis.SiteAccess = require(shared("site-access.js"));
const Fish = require(shared("fish-speech.js"));

const site = { id: "the-extension", tab: { id: 1 }, url: "https://heavenlydao.com/#/r/x" };
const KEY = "fish-key-0123456789";
const VOICE = "b347db033a6549378b48d00acb0d06cd";
const calls = [];
const fishFetch = (reply) => async (url, init) => { calls.push({ url, init }); return reply(url, init); };
const ok = (bytes) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer, json: async () => ({}), text: async () => "" });
const bad = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body || {}), arrayBuffer: async () => new ArrayBuffer(0) });

(async () => {
  assert.strictEqual(Fish.answer({ type: "something:else" }, site), null, "not Fish Audio's message: left to the others");

  // who may ask
  for (const [why, sender] of [["a page of another site", { id: "the-extension", tab: { id: 2 }, url: "https://evil.example/" }], ["a page with no tab", { id: "the-extension", url: "https://heavenlydao.com/" }],
    ["another extension", { id: "other", tab: { id: 1 }, url: "https://heavenlydao.com/" }], ["nobody", null]]) {
    const r = await Fish.answer({ type: "fish:speak", text: "Hi.", key: KEY, model: "s2.1-pro-free" }, sender, fishFetch(() => ok([1])));
    assert.match(r.error, /not the library's site/, why + " is refused");
  }
  assert.strictEqual(calls.length, 0, "nothing was called for them");

  // not allowed yet: nothing is called, and the popup is told
  let r = await Fish.answer({ type: "fish:speak", text: "Hi.", voice: VOICE, key: KEY, model: "s2.1-pro-free" }, site, fishFetch(() => ok([1])));
  assert.deepStrictEqual([r.needsAccess, /Allow api\.fish\.audio/.test(r.error), calls.length], [true, true, 0], "asks for the permission before any call");
  assert.ok(store[SiteAccess.KEY]["api.fish.audio"] > 0, "the need is noted for the popup's Allow");
  assert.deepStrictEqual((await SiteAccess.pending(chrome)).map((p) => p.host), ["api.fish.audio"], "and the popup lists it");

  // allowed: the call, as Fish Audio wants it
  granted.push("https://*.api.fish.audio/*");
  r = await Fish.answer({ type: "fish:speak", text: " Hello there. ", voice: VOICE, key: KEY, model: "s2.1-pro-free" }, site, fishFetch(() => ok([73, 68, 51, 4])));
  assert.deepStrictEqual(r, { audio: Buffer.from([73, 68, 51, 4]).toString("base64"), type: "audio/mpeg" }, "the audio, in base64");
  const c = calls[0];
  assert.strictEqual(c.url, "https://api.fish.audio/v1/tts");
  assert.deepStrictEqual([c.init.method, c.init.headers.Authorization, c.init.headers.model, c.init.headers["Content-Type"]], ["POST", "Bearer " + KEY, "s2.1-pro-free", "application/json"]);
  assert.deepStrictEqual(JSON.parse(c.init.body), { text: "Hello there.", format: "mp3", reference_id: VOICE }, "the text, the voice and mp3");
  r = await Fish.answer({ type: "fish:speak", text: "Hi.", key: KEY, model: "s1" }, site, fishFetch(() => ok([1])));
  assert.ok(!("reference_id" in JSON.parse(calls[1].init.body)), "no voice: Fish Audio's own");
  assert.ok(!JSON.stringify(store).includes(KEY), "the key is kept nowhere");

  // what is refused before anything is called
  calls.length = 0;
  for (const [why, m] of [["no text", { text: " ", key: KEY, model: "s1" }], ["text too long", { text: "a".repeat(5001), key: KEY, model: "s1" }], ["no key", { text: "Hi.", model: "s1" }],
    ["a key with a line break", { text: "Hi.", key: "abcdefgh\r\nX: y", model: "s1" }], ["a model that is a path", { text: "Hi.", key: KEY, model: "../x" }],
    ["a voice that is not an id", { text: "Hi.", key: KEY, model: "s1", voice: "x/../../y" }]]) {
    r = await Fish.answer(Object.assign({ type: "fish:speak" }, m), site, fishFetch(() => ok([1])));
    assert.ok(r.error && !r.audio, why + " is refused");
  }
  assert.strictEqual(calls.length, 0, "none of them reached Fish Audio");

  // what Fish Audio answers
  const say = async (reply) => Fish.answer({ type: "fish:speak", text: "Hi.", key: KEY, model: "s2-pro" }, site, fishFetch(reply));
  assert.match((await say(() => bad(401))).error, /did not accept the key \(401\)/);
  assert.match((await say(() => bad(402, { message: "Insufficient API credit" }))).error, /No API credit.*\(402\)/);
  assert.match((await say(() => bad(429))).error, /limit.*\(429\)/);
  assert.match((await say(() => bad(500, { message: "boom" }))).error, /said 500: boom/);
  assert.match((await say(() => { throw new Error("offline"); })).error, /could not be reached \(offline\)/);

  // the balance (the paid models are offered when there is some)
  calls.length = 0;
  r = await Fish.answer({ type: "fish:credit", key: KEY }, site, fishFetch(() => ({ ok: true, status: 200, json: async () => ({ credit: "12.500000" }) })));
  assert.deepStrictEqual([r, calls[0].url, calls[0].init.headers.Authorization], [{ credit: 12.5 }, "https://api.fish.audio/wallet/self/api-credit", "Bearer " + KEY]);
  r = await Fish.answer({ type: "fish:credit", key: KEY }, { id: "the-extension", tab: { id: 3 }, url: "https://evil.example/" }, fishFetch(() => ok([1])));
  assert.match(r.error, /not the library's site/, "the balance too is for the site only");

  console.log("fish-speech: ok");
})().catch((e) => { console.error(e); process.exit(1); });
