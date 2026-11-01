// The popup until this extension is a device of your library. Detect library finds the library of the site's tabs in this browser (with none
// open, it opens the site in a tab of its own), and Join joins it: the tab, the library's main device, lets this extension in at once. Once
// let in, the popup's other parts show (#app), and the extension starts working (background.js refuses everything before).
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const lock = document.getElementById("lock");
  const app = document.getElementById("app");
  const text = document.getElementById("lockText");
  const note = document.getElementById("lockNote");
  const detectRow = document.getElementById("lockDetectRow");
  const detectBtn = document.getElementById("lockDetect");
  const foundEl = document.getElementById("lockFound");
  // the library site's addresses (where site-bridge.js runs, from the manifest), and the one opened when no tab of it is: heavenlydao.com,
  // else the first https one
  const site = document.getElementById("lockSite");
  const bridge = (ext.runtime.getManifest().content_scripts || []).find((c) => c.js.some((j) => /site-bridge\.js$/.test(j)));
  const SITE_MATCHES = bridge ? bridge.matches : [];
  const siteMatch = SITE_MATCHES.find((m) => m.startsWith("https://heavenlydao.com/")) || SITE_MATCHES.find((m) => m.startsWith("https://"));
  if (siteMatch) {
    site.href = siteMatch.replace(/\*$/, "");
    site.textContent = "Open " + new URL(site.href).host;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;
  let shown = ""; // (what the lock screen shows: drawn again only when it changes)
  let wasMember = false;

  async function call(op, ...args) {
    await Promise.resolve(ext.runtime.sendMessage({ type: "lib:wake" })).catch(() => {}); // (Chrome: the offscreen page that keeps the library)
    const r = await ext.runtime.sendMessage({ target: "lib", op, args });
    if (!r) throw new Error("the extension did not answer");
    if (r.error) throw new Error(r.error);
    return r.result;
  }

  // ---------- the site's tabs in this browser ----------
  // A question to the site's page in a tab (site-bridge.js "ask").
  async function ask(tabId, op, args = [], ms = 8000) {
    const r = await Promise.race([
      Promise.resolve(ext.tabs.sendMessage(tabId, { type: "site:ask", op, args })),
      sleep(ms).then(() => ({ error: "the page did not answer" }))
    ]);
    if (!r) throw new Error("the page did not answer");
    if (r.error) throw new Error(r.error);
    return r.result;
  }
  const noBridge = (e) => /establish|receiving end/i.test((e && e.message) || ""); // (a tab from before the extension was there, or still loading)
  // asked again while the tab loads, until `ms`
  async function askLoading(tabId, op, ms) {
    const end = Date.now() + ms;
    for (;;) {
      try {
        return await ask(tabId, op, [], Math.max(1000, end - Date.now()));
      } catch (e) {
        if (!noBridge(e) || Date.now() > end) throw e;
      }
      await sleep(1000);
    }
  }
  const siteTabs = async () => (SITE_MATCHES.length ? await Promise.resolve(ext.tabs.query({ url: SITE_MATCHES })).catch(() => []) : []).filter((t) => t.id >= 0);
  const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return "the site"; } };
  const many = (n, one) => n + " " + one + (n === 1 ? "" : "s");

  // What Detect found: [{ tab, lib } | { tab, error }] (lib: the page's "library" answer, app.js answerExtension)
  let found = [];
  let looking = false;
  let detected = false;
  // Each site tab is asked which library it has. With none open (openIfNone), the site is opened in a tab of its own, which makes its
  // library on its first visit.
  async function detect(openIfNone) {
    looking = true;
    drawFound();
    const shownFor = sleep(700); // (an answer that comes at once is still seen as an answer)
    let tabs = await siteTabs();
    let opened = null;
    if (!tabs.length && openIfNone && site.href) {
      opened = await Promise.resolve(ext.tabs.create({ url: site.href, active: false })).catch(() => null);
      if (opened) tabs = [opened];
    }
    found = await Promise.all(tabs.map(async (tab) => {
      try {
        if (tab !== opened) return { tab, lib: await ask(tab.id, "library") };
        let lib = await askLoading(tab.id, "library", 30000);
        for (let i = 0; i < 10 && lib && lib.state === "none"; i++) { await sleep(1500); lib = await ask(tab.id, "library"); } // (made a moment after it loads)
        return { tab, lib };
      } catch (e) {
        return { tab, error: e };
      }
    }));
    await shownFor;
    looking = false;
    detected = true;
    drawFound();
  }

  function row(title, sub, ...buttons) {
    const r = document.createElement("div");
    r.className = "work";
    const what = document.createElement("div");
    what.className = "what";
    const b = document.createElement("b");
    b.textContent = title;
    const s = document.createElement("span");
    s.textContent = sub;
    what.append(b, s);
    r.append(what, ...buttons);
    foundEl.append(r);
  }
  function button(label, cls, onclick) {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.onclick = onclick;
    return b;
  }
  function drawFound() {
    foundEl.replaceChildren();
    detectBtn.disabled = looking || busy;
    detectBtn.textContent = looking ? "Looking…" : "Detect library";
    foundEl.hidden = looking || !detected;
    if (foundEl.hidden) return;
    const seen = new Set();
    let usable = 0;
    for (const f of found) {
      const host = hostOf(f.tab.url);
      if (f.lib && f.lib.state === "member") {
        if (seen.has(f.lib.libId)) continue; // (several tabs of one library)
        seen.add(f.lib.libId);
        usable++;
        row("Library " + f.lib.code + (f.lib.name ? " · " + f.lib.name : ""), host + " · " + many(f.lib.novels || 0, "novel"),
          button("Join", "btn-primary", () => joinFound(f)));
      } else if (f.error && noBridge(f.error)) {
        row(host, "Reload this tab", button("Reload", "btn-secondary", async () => {
          await Promise.resolve(ext.tabs.reload(f.tab.id)).catch(() => {});
          looking = true;
          drawFound();
          const lib = await askLoading(f.tab.id, "library", 30000).catch((e) => null);
          looking = false;
          if (lib) found = found.map((x) => (x === f ? { tab: f.tab, lib } : x));
          drawFound();
        }));
      } else if (f.error) {
        row(host, f.error.message);
      } else {
        row(host, "No library");
      }
    }
    if (!found.length) foundEl.textContent = "No library tab open.";
    site.hidden = !site.href || usable > 0;
  }

  // Joining a library Detect found: let in by its tab at once (the tab is the library's main device).
  async function joinFound(f) {
    busy = true;
    note.textContent = "Joining…";
    drawFound();
    try {
      if (!f.lib.main) throw new Error("this tab's library was made on another device, which is the only one that lets devices in");
      const request = await call("joinRequest");
      const r = await ask(f.tab.id, "letIn", [request]).catch(() => null);
      if (!r || !r.keys) throw new Error("the tab did not let this extension in");
      await call("receiveKeys", r.keys);
      note.textContent = "";
    } catch (e) {
      note.textContent = "Not joined: " + e.message;
    }
    busy = false;
    shown = "";
    draw();
  }

  // ---------- the lock screen ----------
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
      wasMember = true;
      shown = "";
      return;
    }
    if (wasMember) { wasMember = false; detected = false; setTimeout(() => detect(false), 0); } // (it left: the tabs open now are asked)
    const now = JSON.stringify([st.state, st.libId, st.code, busy, st.error]);
    if (now === shown) return;
    shown = now;
    lock.hidden = false;
    app.hidden = true;
    detectRow.hidden = false;
    drawFound();
    if (st.state === "unsupported") {
      text.textContent = "This browser can't make the library's keys (Ed25519). Update it to use the extension.";
      detectRow.hidden = true;
    } else if (st.state === "error") {
      text.textContent = "The extension's library can't be reached: " + st.error;
    } else if (st.state === "removed") {
      text.textContent = "This extension was taken off your library's devices. Detect your library to join again.";
    } else {
      text.textContent = "Detect the library open in this browser.";
    }
  }

  detectBtn.onclick = () => detect(true);
  // the tabs open now are asked at once (none is opened until Detect is pressed)
  draw().then(() => { if (!lock.hidden && detectRow.hidden === false) detect(false); });
  setInterval(draw, 2000); // let in while the popup is open
})();
