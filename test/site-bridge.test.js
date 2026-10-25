// The relay injected into the library site's tab: page <-> window.postMessage <-> this script <-> runtime port. Run: node test/site-bridge.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ORIGIN = "http://localhost:3000";
const listeners = [];
const seenByPage = []; // what the page's own listener receives from the relay
const window = {
  location: { origin: ORIGIN },
  addEventListener: (type, fn) => type === "message" && listeners.push(fn),
  // like a browser: every listener on the window hears it (the sender's own too), asynchronously
  postMessage(data, targetOrigin, from = window, origin = ORIGIN) {
    if (targetOrigin !== ORIGIN) return; // a message meant for another origin is not delivered here
    setImmediate(() => listeners.forEach((fn) => fn({ data, source: from, origin })));
  }
};
window.window = window;

let ports = [];
let connectThrows = false;
const asked = []; // what the relay asked the extension with sendMessage
const onMessage = []; // the relay's listeners for the extension's messages (the popup's "site:ask")
const runtime = {
  id: "the-extension",
  onMessage: { addListener: (fn) => onMessage.push(fn) },
  sendMessage: async (m) => {
    asked.push(m);
    if (m.type === "lib:wake") return { ok: true };
    if (m.target === "lib" && m.op === "status") return { result: { state: "member", code: "ABCD-1234" } };
    if (m.target === "lib") return { error: "unknown library call " + m.op };
    return undefined;
  },
  connect: (info) => {
    if (connectThrows) throw new Error("Extension context invalidated");
    const port = {
      name: info.name, sent: [], disconnected: false, msgFns: [], discFns: [],
      onMessage: { addListener: (fn) => port.msgFns.push(fn) },
      onDisconnect: { addListener: (fn) => port.discFns.push(fn) },
      postMessage: (m) => void port.sent.push(m),
      disconnect: () => { port.disconnected = true; },
      // the extension side
      deliver: (m) => port.msgFns.forEach((fn) => fn(m)),
      drop: () => port.discFns.forEach((fn) => fn())
    };
    ports.push(port);
    return port;
  }
};
const ctx = { window, location: window.location, chrome: { runtime }, setImmediate, setTimeout, console };
ctx.globalThis = ctx;
vm.createContext(ctx);

// the page's own listener, as the site registers it
window.addEventListener("message", (ev) => {
  if (ev.source === window && ev.origin === ORIGIN && ev.data && ev.data.source === "p2pread-ext") seenByPage.push(ev.data);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toRelay = (type, data) => window.postMessage({ source: "p2pread-page", type, data }, ORIGIN);
const types = () => seenByPage.map((m) => m.type);

(async () => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "site-bridge.js"), "utf8"), ctx, { filename: "site-bridge.js" });
  await sleep(20);
  assert.deepStrictEqual(types(), ["hello"], "it announces itself so a page that started first knows it is there");

  // ---- the popup asks the page (Detect library): asked before the page has said anything, the question waits for it ----
  const replies = [];
  const keepsOpen = onMessage[0]({ type: "site:ask", op: "library", args: [] }, { id: "the-extension" }, (r) => replies.push(r));
  assert.strictEqual(keepsOpen, true, "answered later");
  assert.strictEqual(onMessage[0]({ type: "site:ask", op: "library" }, { id: "another-extension" }, () => replies.push("no")), undefined, "another extension is not heard");
  await sleep(20);
  assert.deepStrictEqual(types(), ["hello"], "not asked before the page is there");

  // ---- connect, then messages both ways ----
  toRelay("connect");
  await sleep(20);
  assert.strictEqual(ports.length, 1);
  assert.strictEqual(ports[0].name, "p2p-local", "it opens the port the extension's sync page listens for");
  const ask = seenByPage.find((m) => m.type === "ask");
  assert.strictEqual(JSON.stringify(ask && [ask.data.op, ask.data.args]), JSON.stringify(["library", []]), "asked once the page said something");
  assert.deepStrictEqual(types(), ["hello", "ask", "connected"]);
  toRelay("answer", { id: "nobody", result: 1 });
  toRelay("answer", { id: ask.data.id, result: { state: "member", code: "ABCD-1234" } });
  toRelay("answer", { id: ask.data.id, result: "again" });
  await sleep(20);
  assert.strictEqual(JSON.stringify(replies), JSON.stringify([{ result: { state: "member", code: "ABCD-1234" } }]), "the answer goes back to the popup, once");
  onMessage[0]({ type: "site:ask", op: "letIn", args: [{ t: "jn" }] }, { id: "the-extension" }, (r) => replies.push(r));
  await sleep(20);
  const ask2 = seenByPage.filter((m) => m.type === "ask")[1];
  toRelay("answer", { id: ask2.data.id, error: "not let in" });
  await sleep(20);
  assert.strictEqual(JSON.stringify(replies[1]), JSON.stringify({ error: "not let in" }), "an error too");
  seenByPage.length = 0;
  seenByPage.push({ type: "hello" }, { type: "connected" });
  toRelay("msg", { t: "get", k: "translation:https://x/1" });
  await sleep(20);
  assert.deepStrictEqual(ports[0].sent, [{ t: "get", k: "translation:https://x/1" }], "page -> extension");
  ports[0].deliver({ t: "hi", r: "extension" });
  await sleep(20);
  assert.deepStrictEqual(seenByPage.filter((m) => m.type === "msg").map((m) => m.data), [{ t: "hi", r: "extension" }], "extension -> page");

  // ---- the page asks again (it restarted its side): the link is the same one ----
  toRelay("connect");
  await sleep(20);
  assert.strictEqual(ports.length, 1, "no second port");
  assert.strictEqual(types().filter((t) => t === "connected").length, 2, "but the page is told it is connected");

  // ---- only this page, only our envelope ----
  const before = ports[0].sent.length;
  window.postMessage({ source: "p2pread-page", type: "msg", data: { t: "evil" } }, ORIGIN, { notTheWindow: true }); // another frame
  window.postMessage({ source: "p2pread-page", type: "msg", data: { t: "evil" } }, ORIGIN, window, "https://evil.example"); // another origin
  window.postMessage({ source: "something-else", type: "msg", data: { t: "evil" } }, ORIGIN); // not our envelope
  window.postMessage("a plain string", ORIGIN);
  await sleep(30);
  assert.strictEqual(ports[0].sent.length, before, "messages from another frame or origin, or without our envelope, are ignored");

  // ---- Listen with a Fish Audio key: the page's ask goes to the extension, the answer comes back with the same id ----
  const before2 = asked.length;
  runtime.sendMessage = ((was) => async (m) => (String(m.type).startsWith("fish:") && asked.push(m), m.type === "fish:speak" ? { audio: "SUQz", type: "audio/mpeg" } : m.type === "fish:credit" ? { error: "Allow api.fish.audio", needsAccess: true } : was(m)))(runtime.sendMessage);
  seenByPage.length = 0;
  toRelay("fish", { id: 7, op: "speak", text: "Hi.", voice: "v", model: "s2.1-pro-free", key: "k", extra: "dropped" });
  toRelay("fish", { id: 8, op: "credit", key: "k" });
  toRelay("fish", { id: 9, op: "something-else", key: "k" });
  toRelay("fish", { op: "speak", text: "no id" });
  await sleep(30);
  assert.strictEqual(JSON.stringify(asked.slice(before2)), JSON.stringify([{ type: "fish:speak", text: "Hi.", voice: "v", model: "s2.1-pro-free", key: "k" }, { type: "fish:credit", key: "k" }]), "only the two asks go on, with only their own fields");
  assert.strictEqual(JSON.stringify(seenByPage.filter((m) => m.type === "fish").map((m) => m.data)), JSON.stringify([{ id: 7, audio: "SUQz", type: "audio/mpeg" }, { id: 8, error: "Allow api.fish.audio", needsAccess: true }]), "and the answers come back by id");

  // ---- the page closes it ----
  toRelay("close");
  await sleep(20);
  assert.ok(ports[0].disconnected, "closing from the page disconnects the port");
  toRelay("msg", { t: "late" });
  await sleep(20);
  assert.strictEqual(ports[0].sent.length, before, "nothing is sent on a closed link");

  // ---- the extension goes away (reloaded): the page is told ----
  toRelay("connect");
  await sleep(20);
  assert.strictEqual(ports.length, 2, "a new link after the old one was closed");
  seenByPage.length = 0;
  ports[1].drop();
  await sleep(20);
  assert.deepStrictEqual(types(), ["close"], "the page learns the link is gone");
  toRelay("connect");
  await sleep(20);
  assert.strictEqual(ports.length, 3, "and can connect again");

  // ---- the extension cannot be reached (context invalidated) ----
  connectThrows = true;
  seenByPage.length = 0;
  toRelay("close");
  await sleep(20);
  toRelay("connect");
  await sleep(20);
  assert.deepStrictEqual(types(), ["close"], "a connect that throws is reported as closed, not as an error in the page");

  // ---- a call to the library: asked of the extension, answered to the page with the same id ----
  seenByPage.length = 0;
  toRelay("lib", { id: 7, op: "status", args: [] });
  toRelay("lib", { id: 8, op: "nope" });
  await sleep(30);
  const libReplies = seenByPage.filter((m) => m.type === "lib").map((m) => m.data).sort((x, y) => x.id - y.id);
  assert.deepStrictEqual(libReplies.map((r) => [r.id, r.result && r.result.code, r.error]), [[7, "ABCD-1234", undefined], [8, undefined, "unknown library call nope"]]);
  assert.ok(asked.some((m) => m.type === "lib:wake"), "the extension's page that keeps the library is woken first");
  assert.ok(asked.some((m) => m.type === "site:seen" && m.url.startsWith(ORIGIN)), "the site's address is told (where a notification opens it)");
  assert.ok(asked.some((m) => m.target === "lib" && m.op === "status" && Array.isArray(m.args)));

  // ---- injected twice: still one relay ----
  connectThrows = false;
  const listenersBefore = listeners.length;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "site-bridge.js"), "utf8"), ctx, { filename: "site-bridge.js" });
  assert.strictEqual(listeners.length, listenersBefore, "a second injection adds nothing");

  console.log("OK — site-bridge checks passed");
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
