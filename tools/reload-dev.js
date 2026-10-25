// Reloads the unpacked extension in the dev browser (Chrome started with --remote-debugging-port, which loads extension/dist/chrome), so a build is used
// at once: Chrome reads an unpacked extension's files again only when it is reloaded (a rebuild alone leaves the old service worker running). It opens
// chrome://extensions over the DevTools protocol, finds the extension loaded from dist/chrome and reloads it, as its reload icon does. Nothing happens
// when that browser is not running.
// node tools/reload-dev.js [port]   (9222 unless said), or after a build: node build.js --reload
const path = require("path");

const DIST = path.join(__dirname, "..", "dist", "chrome");

async function main(PORT = 9222) {
  let version;
  try {
    version = await (await fetch("http://127.0.0.1:" + PORT + "/json/version", { signal: AbortSignal.timeout(2000) })).json();
  } catch (e) {
    console.log("No dev browser on port " + PORT + ": nothing reloaded (start Chrome with --remote-debugging-port=" + PORT + ", or reload the extension in chrome://extensions)");
    return;
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("could not reach the browser's DevTools")); });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "chrome://extensions", background: true });
  try {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    // (the page's own API: the list of extensions with where each is loaded from, and reload: what its buttons use)
    const expression = `(async (dist) => {
      for (let i = 0; i < 50 && !(globalThis.chrome && chrome.developerPrivate); i++) await new Promise((r) => setTimeout(r, 100));
      const norm = (p) => String(p || "").replace(/[\\\\/]+$/, "").replace(/\\//g, "\\\\").toLowerCase();
      const list = await chrome.developerPrivate.getExtensionsInfo();
      const e = list.find((x) => x.location === "UNPACKED" && (norm(x.path) === norm(dist) || norm(x.prettifiedPath).endsWith("\\\\extension\\\\dist\\\\chrome")));
      if (!e) return { found: false, unpacked: list.filter((x) => x.location === "UNPACKED").map((x) => x.name + " (" + (x.prettifiedPath || x.path || "") + ")") };
      await chrome.developerPrivate.reload(e.id, { failQuietly: true, populateErrorForUnpacked: false });
      return { found: true, id: e.id, name: e.name, version: e.version };
    })(${JSON.stringify(DIST)})`;
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error((exceptionDetails.exception && exceptionDetails.exception.description) || exceptionDetails.text);
    const r = result.value || {};
    if (r.found) console.log("Reloaded " + r.name + " " + r.version + " (" + r.id + ") from " + DIST);
    else console.log("The dev browser has no extension loaded from " + DIST + (r.unpacked && r.unpacked.length ? " (unpacked there: " + r.unpacked.join(", ") + ")" : "") + ": load it once with Load unpacked");
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
    ws.close();
  }
}

module.exports = { reloadDev: main };
if (require.main === module) {
  main(Number(process.argv[2]) || 9222).catch((e) => {
    console.error("Not reloaded: " + e.message);
    process.exit(1);
  });
}
