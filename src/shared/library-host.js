// Your library (library.js), kept by the extension: in the page that runs the sync with the site's tab (Chrome's offscreen document, Firefox's
// background page), so the library is loaded once, not each time Chrome's service worker wakes.
//
// Who asks it what, all with { target: "lib", op, args } (Firefox's background page calls LibraryHost.call directly):
//   the library calls (glossary-server.js): "api" — every /api/... call, answered from the library; the popup and the library site's tab
//   (through site-bridge.js): "ping" (is the library there); the notifications (notice-host.js): "noticeSettings" ([settings] from the
//   site's Settings › Notifications), "notices" (those shown while no page of the site was open); the site's Triggers tab: "schedule",
//   "fillResume".
// The library site's tab in this browser keeps a copy of the same library: the two pass records over the link between them (p2p-host.js
// gives it the link, LibraryHost.room, and passes the library to it, LibraryHost.roomLink). p2p-host.js also gives it the chapters the
// extension holds (LibraryHost.setChapters: the notifications look at them).
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const direct = !!(ext.storage && ext.storage.local); // Firefox's background page; Chrome's offscreen page has no storage of its own

  const ready = Library.open({ adapter: Library.idbAdapter("p2p-read-library") });
  const host = { room: null };

  // The chapters the extension holds: { getIndex(), listTranslations() } (p2p-host.js's adapter); the notifications look at them (notice-host.js)
  host.setChapters = (chapters) => { host.chapters = chapters; };
  // A chapter the extension saved: the notifications look at your novels' chapters again a little later.
  host.chapterSaved = (key, entry) => {
    if (entry && entry.translated && typeof NoticeHost !== "undefined" && NoticeHost.host) NoticeHost.host.soonChapters();
  };

  let changeTimer = null;
  ready.then((lib) => {
    lib.on("records", (rs) => { if (host.room) host.room.announceRecords(rs); });
    // What came from the site's tab: the glossary cache the translator reads is brought up to date (it asks the library, now).
    lib.on("change", () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        if (direct) GlossaryServer.pull();
        else ext.runtime.sendMessage({ type: "glossary:pull" }).catch(() => {});
      }, 1500);
    });
  }, () => {}); // (not opened: every call says why)

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

  async function call(op, args = []) {
    const lib = await ready;
    switch (op) {
      case "ping":
        return true;
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
    call(msg.op, msg.args || []).then((result) => sendResponse({ result }), (e) => sendResponse({ error: String((e && e.message) || e), status: e && e.status }));
    return true; // answered later
  });

  self.LibraryHost = Object.assign(host, { ready, call, roomLink });
})();
