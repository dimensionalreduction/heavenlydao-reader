// The popup until this extension is a device of your library: only the passphrase and Join. The passphrase is the one your library's site
// shows (Settings > Library > Passphrase); Join asks the library's main device, which shows "… asks to join" with Allow. Once let in, the
// popup's other parts show (#app), and the extension starts working (background.js refuses everything before).
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const lock = document.getElementById("lock");
  const app = document.getElementById("app");
  const text = document.getElementById("lockText");
  const pass = document.getElementById("lockPass");
  const join = document.getElementById("lockJoin");
  const stop = document.getElementById("lockStop");
  const note = document.getElementById("lockNote");
  // the library site's address, for the first visit: heavenlydao.com, else the first https address in the manifest where site-bridge.js runs
  const site = document.getElementById("lockSite");
  const bridge = (ext.runtime.getManifest().content_scripts || []).find((c) => c.js.includes("site-bridge.js"));
  const siteMatch = bridge && (bridge.matches.find((m) => m.startsWith("https://heavenlydao.com/")) || bridge.matches.find((m) => m.startsWith("https://")));
  if (siteMatch) {
    site.href = siteMatch.replace(/\*$/, "");
    site.textContent = "Open " + new URL(site.href).host;
  }

  async function call(op, ...args) {
    await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that keeps the library)
    const r = await ext.runtime.sendMessage({ target: "lib", op, args });
    if (!r) throw new Error("the extension did not answer");
    if (r.error) throw new Error(r.error);
    return r.result;
  }

  let busy = false;
  let shown = "";
  async function draw() {
    let st;
    try {
      st = await call("status");
    } catch (e) {
      st = { state: "error", error: e.message };
    }
    if (st.state === "member") {
      lock.hidden = true;
      app.hidden = false;
      return;
    }
    const now = JSON.stringify([st.state, st.libId, st.code, busy, st.error]);
    if (now === shown) return;
    shown = now;
    lock.hidden = false;
    app.hidden = true;
    stop.hidden = st.state !== "joining" || !!st.libId;
    join.hidden = st.state === "joining";
    pass.hidden = st.state === "joining";
    site.hidden = !site.href || !["none", "removed"].includes(st.state);
    if (st.state === "unsupported") {
      text.textContent = "This browser can't make the library's keys (Ed25519). Update it to use the extension.";
      join.hidden = pass.hidden = true;
    } else if (st.state === "error") {
      text.textContent = "The extension's library can't be reached: " + st.error;
    } else if (st.state === "removed") {
      text.textContent = "This extension was taken off your library's devices. Ask to join again with your library's passphrase.";
      join.hidden = pass.hidden = false;
    } else if (st.state === "joining") {
      text.textContent = st.libId
        ? "Let in. Waiting for your library's list of devices…"
        : "Asking to join… On your library's site, open Settings › Library and press Allow for “" + st.device.name + "”.";
    } else {
      text.textContent = "This extension does nothing until it is one of your library's devices. On your library's site, open Settings › Library › Passphrase, press Copy, and paste it here.";
    }
  }

  join.onclick = async () => {
    const p = pass.value.trim();
    if (!p) return (note.textContent = "Paste your library's passphrase first.");
    busy = true;
    note.textContent = "Asking…";
    try {
      await ext.storage.local.set({ p2pPassphrase: p, p2pEnabled: true }); // (the room starts again with it)
      await call("join");
      note.textContent = "";
    } catch (e) {
      note.textContent = "Not asked: " + e.message;
    }
    busy = false;
    draw();
  };
  stop.onclick = async () => {
    await call("cancelJoin").catch((e) => (note.textContent = e.message));
    draw();
  };
  ext.storage.local.get("p2pPassphrase").then((c) => { pass.value = c.p2pPassphrase || ""; }, () => {});
  draw();
  setInterval(draw, 2000); // let in while the popup is open
})();
