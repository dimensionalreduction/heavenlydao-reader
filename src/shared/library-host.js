// Your library (library.js), kept by the extension: in the page that runs the sync with the site's tab (Chrome's offscreen document, Firefox's
// background page), so the library is loaded once, not each time Chrome's service worker wakes.
//
// Who asks it what, all with { target: "lib", op, args } (Firefox's background page calls LibraryHost.call directly):
//   the library calls (glossary-server.js): "api" — every /api/... call, answered from the library once this device is in it; the popup and
//   the library site's tab (through site-bridge.js): "status", "create" (an empty library);
//   joining the library of the site's tab in this browser (the popup's Detect, the site's Settings › Library): "joinRequest", then
//   "receiveKeys" ([keys]); the popup only: "leave"; the notifications (notice-host.js): "noticeSettings" ([settings] from the site's
//   Settings › Notifications), "notices" (those shown while no page of the site was open); the site's Triggers tab: "schedule", "fillResume".
// p2p-host.js gives it the link to the site's tab (LibraryHost.room) and passes the library to it (LibraryHost.roomLink), and gives it the
// chapters this device holds (LibraryHost.setChapters: the notifications look at them).
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const direct = !!(ext.storage && ext.storage.local); // Firefox's background page; Chrome's offscreen page has no storage of its own

  // "Chrome on Windows (extension)": the name this device has in the library.
  function deviceName() {
    const ua = navigator.userAgent || "";
    const browserName = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return browserName + (os ? " on " + os : "") + " (extension)";
  }

  const ready = Library.supported().then((ok) => (ok ? Library.open({ adapter: Library.idbAdapter("p2p-read-library"), deviceName: deviceName() }) : null));
  const host = { room: null };
  // Whether this extension is a device of a library now (asked often: the link trusts the library site's tab in this browser only then, and
  // the extension does nothing for anyone until it is).
  let opened = null;
  ready.then((l) => { opened = l; }, () => {});
  host.isMember = () => !!opened && opened.status().state === "member";

  // The chapters this device holds: { getIndex(), listTranslations() } (p2p-host.js's adapter); the notifications look at them (notice-host.js)
  host.setChapters = (chapters) => { host.chapters = chapters; };
  // A chapter this device saved: the notifications look at your novels' chapters again a little later.
  host.chapterSaved = (key, entry) => {
    if (entry && entry.translated && typeof NoticeHost !== "undefined" && NoticeHost.host) NoticeHost.host.soonChapters();
  };

  // What Chrome's service worker keeps for itself (it has the storage): whether this extension is in the library.
  const bg = (op, ...args) => (direct ? null : ext.runtime.sendMessage({ target: "p2p-bg", op, args }).then((r) => { if (r && r.error) throw new Error(r.error); return r && r.result; }));
  // What this extension keeps of a library besides the library itself, gone as it leaves: the chapters (and their index), the glossaries' copy.
  const LIBRARY_COPIES = ["glossaryLibrary", "glossaryBindings", "glossaryRev", "myTerms"];
  async function forgetStored() {
    if (!direct) return bg("forgetLibrary");
    const all = await ext.storage.local.get(null);
    await ext.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("translation:") || k.startsWith("p2pIndex") || LIBRARY_COPIES.includes(k)));
  }
  async function setFlag(lib) {
    const st = lib.status();
    const on = st.state === "member" ? { libId: st.libId, code: st.code } : null;
    if (direct) await ext.storage.local.set({ libraryOn: on });
    else await bg("setLibraryOn", on);
  }

  let changeTimer = null;
  ready.then((lib) => {
    if (!lib) return;
    setFlag(lib).catch(() => {});
    lib.on("records", (rs) => { if (host.room) host.room.announceRecords(rs); });
    // What came from the site's tab: the glossary cache the translator reads is brought up to date (it asks the library, now).
    lib.on("change", () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        setFlag(lib).catch(() => {});
        if (lib.status().state !== "member") return;
        if (direct) GlossaryServer.pull();
        else ext.runtime.sendMessage({ type: "glossary:pull" }).catch(() => {});
      }, 1500);
    });
  });

  // Bytes cross the extension's messages as base64.
  function b64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function unb64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const BEFORE_JOINING = new Set(["status", "create", "joinRequest", "receiveKeys", "leave"]);
  const OWN_PAGES_ONLY = new Set(["leave"]); // (not the site's tab)
  async function call(op, args = []) {
    const lib = await ready;
    if (!lib) {
      if (op === "status") return { state: "unsupported" };
      throw new Error("this browser cannot make the library's keys (Ed25519): update it");
    }
    // Not a device of a library yet: it can only join one (or be made one: "create").
    if (lib.status().state !== "member" && !BEFORE_JOINING.has(op)) throw new Error("this extension is not in a library yet: open the library site in this browser, then the extension's popup, and press Detect library");
    switch (op) {
      case "status":
        return lib.status();
      // An empty library, with this device as its main device.
      case "create":
        await lib.create();
        await setFlag(lib);
        return lib.status();
      // Joining the library of the site's tab in this browser: what this extension sends to ask, which that tab, as the main device,
      // answers at once with the keys.
      case "joinRequest": {
        const st = lib.status();
        if (st.state === "member") throw new Error("this extension is in a library already: leave it first");
        if (st.state !== "none") await lib.leave(); // (asking another, or one it was taken off: a new device then)
        return lib.joinMessage();
      }
      case "receiveKeys": {
        if (!(await lib.receiveKeys(args[0]))) throw new Error("those keys are not for this extension");
        await setFlag(lib);
        if (host.room) host.room.libraryChanged();
        return lib.status();
      }
      // Leaving the library (the popup gives the proof to the site's tabs in this browser, so the main device takes this one off its list),
      // then what this extension holds of it goes. The extension's own settings stay (its Gemini key, prompts, rules).
      case "leave": {
        const was = lib.status();
        const proof = was.state === "member" && was.devices.some((d) => !d.me) ? await lib.leaveProof() : null;
        await lib.leave();
        if (host.room) host.room.forget(Object.keys(host.room.getIndex()));
        await forgetStored();
        await setFlag(lib);
        return Object.assign(lib.status(), { proof });
      }
      // the main device takes a device off the library (the site's Settings › Library: one that left, or is no longer used)
      case "removeDevice": {
        const r = await lib.removeDevice(String(args[0]), args[1] || {});
        return Object.assign(r, lib.status());
      }
      // when the extension does what it does on its own, for the site's Triggers tab and Activity › Upcoming: how often the watches are looked
      // at (they carry their own times: watcher.js nextDue) and the watches set to every chapter.
      case "schedule":
        return {
          now: Date.now(),
          watches: { every: 60 * 1000 },
          fills: host.fills ? host.fills() : {} // (watches set to every chapter: { <watch id>: { at, asked, got, pausedUntil, reason } }, p2p-host.js)
        };
      // "Try again now": a watch's fetching paused by the site's refusal (its bot check) goes on at the next pass
      case "fillResume":
        return host.resumeFill ? host.resumeFill(String(args[0] || "")) : false;
      // the notifications (notice-host.js): what to tell, from the site's Settings › Notifications; those shown, for the site's bell
      case "noticeSettings":
        return typeof NoticeHost !== "undefined" && NoticeHost.host ? NoticeHost.host.setSettings(args[0]) : null;
      case "notices":
        return typeof NoticeHost !== "undefined" && NoticeHost.host ? NoticeHost.host.list() : [];
      // the Gemini models the extension can list (its key's own list, else a short built-in one), for the site's model pickers
      case "models": {
        const r = typeof listGeminiModels === "function" ? { models: await listGeminiModels().catch(() => []) } : await ext.runtime.sendMessage({ type: "listModels" }).catch(() => null);
        return r && Array.isArray(r.models) ? r.models.map(String).slice(0, 200) : [];
      }
      // titles the site shows in English, as the library's setting says (the background's translateByMode: Gemini is the extension's)
      case "translateTitles": {
        const texts = Array.isArray(args[0]) ? args[0].map(String).slice(0, 500) : [];
        // (in the background itself, as on Firefox, called directly: a message to itself does not arrive)
        const r = typeof translateByMode === "function" ? { texts: await translateByMode(texts, "titles").catch(() => texts) } : await ext.runtime.sendMessage({ type: "translateTitles", texts }).catch(() => null);
        return r && Array.isArray(r.texts) && r.texts.length === texts.length ? r.texts : texts;
      }
      case "api": {
        const [method, path, body] = args;
        const b = body && typeof body.bytesB64 === "string" ? { type: body.type, bytes: unb64(body.bytesB64) } : body;
        const out = await lib.api(String(method), String(path), b);
        return out && out.bytes instanceof Uint8Array ? { type: out.type, hash: out.hash, bytesB64: b64(out.bytes) } : out;
      }
      default:
        throw new Error("unknown library call " + op);
    }
  }

  // The link's view of the library (p2p-core.js opts.library), usable before the library has finished loading.
  const roomLink = Library.lazyRoomLink(ready);

  // The library site's addresses: where site-bridge.js runs (site-matches.js, from the manifest; a --dev build adds localhost:3000). A web
  // page elsewhere is not the site, whatever its content script sends. The extension's own pages are: the popup and the background (no tab),
  // and the popup or the rules page opened in a tab (the extension's own address).
  const SITE_MATCHES = typeof SITE_BRIDGE_MATCHES !== "undefined" ? SITE_BRIDGE_MATCHES : [];
  host.fromSite = (sender) => !!sender && !!sender.tab && typeof sender.url === "string" && SITE_MATCHES.some((m) => sender.url.startsWith(m.replace(/\*$/, "")));
  const ownPage = (sender) => !sender.tab || (typeof sender.url === "string" && sender.url.startsWith(ext.runtime.getURL("")));

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "lib") return;
    if (sender && !ownPage(sender) && !host.fromSite(sender)) return void sendResponse({ error: "not the library's site" });
    if (sender && !ownPage(sender) && OWN_PAGES_ONLY.has(msg.op)) return void sendResponse({ error: "only the extension's popup does that" });
    call(msg.op, msg.args || []).then((result) => sendResponse({ result }), (e) => sendResponse({ error: String((e && e.message) || e), status: e && e.status }));
    return true; // answered later
  });

  self.LibraryHost = Object.assign(host, { ready, call, roomLink });
})();
