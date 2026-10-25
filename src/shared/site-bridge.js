// Injected into the library site's own tab (see the content_scripts entry for it in the manifests). It lets the page and the extension talk
// directly when they are in the same browser: no trackers, no WebRTC, nothing leaves the computer, and it works offline.
//
// The page cannot reach the extension by itself, so this script relays: page <-> window.postMessage <-> this script <-> runtime port <-> the
// extension page that runs the sync (p2p-host.js). What crosses is the ordinary sync protocol (chapters, requests, progress), which the
// sync code already validates, so the page gets no more power over the extension than a device on the network would have.
//
// Page -> this script: { source: "p2pread-page", type: "connect" | "msg" | "close" | "lib", data }
// This script -> page: { source: "p2pread-ext",  type: "hello" | "connected" | "msg" | "close" | "lib", data }
// "lib" is a call to your library ({ id, op, args } -> { id, result | error }): the library tab in the same browser reads and changes the
// library the extension keeps, and lets new devices in, the way the popup does.
// "fish" ({ id, op: "speak" | "credit", text, voice, model, key } -> { id, audio, type | credit | error, needsAccess }): Listen with a Fish Audio key (fish-speech.js).
// "access" (page -> extension only): { keys, token }, the keys this page keeps for translation profiles and the playground's sign-in for this extension, so
// that the chapters a watch fetches are translated with the novel's profile while no page is open (profile-translate.js).
// "ask" (extension -> page) and "answer" (page -> extension): the popup asks this page about its library ({ id, op, args } -> { id, result |
// error }): "library" (which one it is, with its passphrase), "letIn" (this extension's request to join: the keys, when this page is its main
// device), "leaving" (this extension's proof as it leaves: taken off the list there). Sent here as { type: "site:ask", op, args }.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  if (window.__p2preadBridge) return; // injected twice: the first one is enough
  window.__p2preadBridge = true;

  let port = null;
  const post = (type, data) => window.postMessage({ source: "p2pread-ext", type, data }, location.origin);

  // The popup's questions to this page. The page listens once its own script has run (it says so with any message): asked before that, the
  // question waits for it.
  const ASK_MS = 20000;
  const asked = new Map(); // id -> sendResponse
  let askSeq = 0;
  let pageUp = false;
  const waiting = [];
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "site:ask" || typeof msg.op !== "string" || !sender || sender.id !== ext.runtime.id) return;
    const id = "a" + ++askSeq;
    asked.set(id, sendResponse);
    setTimeout(() => { if (asked.delete(id)) sendResponse({ error: "the page did not answer" }); }, ASK_MS);
    const send = () => post("ask", { id, op: msg.op, args: Array.isArray(msg.args) ? msg.args : [] });
    if (pageUp) send();
    else waiting.push(send);
    return true; // answered later
  });

  function connect() {
    if (port) return post("connected"); // asked again (the page restarted its side): the link is already up
    try {
      port = ext.runtime.connect({ name: "p2p-local" });
    } catch (e) {
      return post("close"); // the extension was reloaded under this page, or is not reachable
    }
    port.onMessage.addListener((m) => post("msg", m));
    port.onDisconnect.addListener(() => {
      port = null;
      post("close");
    });
    post("connected");
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    // only this page itself, and only our own envelope
    if (ev.source !== window || ev.origin !== location.origin || !d || d.source !== "p2pread-page") return;
    if (!pageUp) { pageUp = true; for (const send of waiting.splice(0)) send(); }
    if (d.type === "answer" && d.data && asked.has(d.data.id)) {
      const reply = asked.get(d.data.id);
      asked.delete(d.data.id);
      reply(d.data.error ? { error: String(d.data.error) } : { result: d.data.result });
    } else if (d.type === "connect") connect();
    else if (d.type === "msg" && port) {
      try {
        port.postMessage(d.data);
      } catch (e) {
        // the port closed meanwhile: onDisconnect tells the page
      }
    } else if (d.type === "close" && port) {
      const p = port;
      port = null;
      p.disconnect();
    } else if (d.type === "lib" && d.data && typeof d.data.op === "string") {
      // The page asks your library (library-host.js), which the extension keeps: this browser's library tab is its window onto it.
      const { id, op, args } = d.data;
      const ask = async () => {
        await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that keeps it)
        return ext.runtime.sendMessage({ target: "lib", op, args: Array.isArray(args) ? args : [] });
      };
      ask().then(
        (r) => post("lib", { id, result: r && r.result, error: r ? r.error : "the extension did not answer", status: r && r.status }),
        (e) => post("lib", { id, error: String((e && e.message) || e) })
      );
    } else if (d.type === "fish" && d.data && d.data.id != null && (d.data.op === "speak" || d.data.op === "credit")) {
      // Listen with a Fish Audio key kept in the page: the extension makes the call (fish-speech.js), the audio comes back in base64
      const { id, op, text, voice, model, key } = d.data;
      Promise.resolve(ext.runtime.sendMessage(op === "speak" ? { type: "fish:speak", text, voice, model, key } : { type: "fish:credit", key })).then(
        (r) => post("fish", Object.assign({ id }, r || { error: "the extension did not answer" })),
        (e) => post("fish", { id, error: String((e && e.message) || e) })
      );
    } else if (d.type === "access" && d.data && typeof d.data === "object") {
      Promise.resolve(ext.runtime.sendMessage({ type: "profile:access", keys: d.data.keys, token: d.data.token })).catch(() => {});
    }
  });

  post("hello"); // the page may already be waiting; if it starts later it asks with "connect"
  // where the site is, for the extension's notifications: clicking one with no page of the site open opens this address (notice-bg.js)
  Promise.resolve().then(() => ext.runtime.sendMessage({ type: "site:seen", url: location.origin + (location.pathname || "/") })).catch(() => {});
})();
