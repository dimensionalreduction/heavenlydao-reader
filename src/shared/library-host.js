// Your library (library.js), kept by the extension: in the page that runs the sync room (Chrome's offscreen document, Firefox's background
// page), so the library and the room are in one place and the library is loaded once, not each time Chrome's service worker wakes.
//
// Who asks it what, all with { target: "lib", op, args } (Firefox's background page calls LibraryHost.call directly):
//   the library calls (glossary-server.js): "api" — every /api/... call, answered from the library once this device is in it; the popup and
//   the library site's tab (through site-bridge.js): "status", "create" (an empty library), "join", "cancelJoin", "allow", "refuse", "unrefuse"; sharing: "share" (args: [true] for a new link), "put"
//   (the library's name, a novel shared: [key, body]), "sharedBooks", "removeDevice" ([id, { newLink }]), "publishing" (the rooms it is in),
//   "seeded" (how much this device sent your library's readers: { total, books: { <book id>: bytes } }); the notifications (notice-host.js):
//   "noticeSettings" ([settings] from the site's Settings › Notifications), "notices" (those shown while no page of the site was open);
//   "room" ([call, ...args]: the site's tab answering for this library in its own room).
// p2p-host.js gives it the room (LibraryHost.room) and passes the library to the room (LibraryHost.roomLink), and gives it the chapters this
// device holds (LibraryHost.startPublishing): once the library is shared, this device publishes it for readers (share-rooms.js).
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const direct = !!(ext.storage && ext.storage.local); // Firefox's background page; Chrome's offscreen page has no storage of its own

  // "Chrome on Windows (extension)": what the main device shows when this device asks to join.
  function deviceName() {
    const ua = navigator.userAgent || "";
    const browserName = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return browserName + (os ? " on " + os : "") + " (extension)";
  }

  const ready = Library.supported().then((ok) => (ok ? Library.open({ adapter: Library.idbAdapter("p2p-read-library"), deviceName: deviceName() }) : null));
  const host = { room: null, publishing: null };
  // Whether this extension is a device of a library now (asked often: the room trusts the library site's tab in this browser only then, and
  // the extension does nothing for anyone until it is).
  let opened = null;
  ready.then((l) => { opened = l; }, () => {});
  host.isMember = () => !!opened && opened.status().state === "member";
  const seeded = typeof ShareRooms !== "undefined" ? ShareRooms.localTally("p2p-read-seeded") : null;

  const EDITIONS_EVERY_MS = 5 * 60 * 1000; // (other libraries' editions of your novels, looked at with no page open)
  // Publishing for readers: the rooms of the library and of the novels shared, with the chapters this device holds.
  //   chapters: { getTranslation(key), listTranslations() } (p2p-host.js's adapter); trackers: the sync's
  host.startPublishing = async (chapters, trackers) => {
    host.chapters = chapters; // (the notifications look at your novels' chapters: notice-host.js)
    if (!lists.chapters) { // (the shared lists: from these chapters, now and every 10 minutes)
      lists.chapters = chapters;
      soonLists();
      setInterval(() => keepSharedLists(), LISTS_EVERY_MS);
    }
    const lib = await ready;
    if (!lib || host.publishing || typeof ShareRooms === "undefined" || typeof WebTorrent === "undefined") return;
    const rooms = ShareRooms.createRooms({
      WebTorrent, trackers: trackers && trackers.length ? trackers : P2PCore.DEFAULT_TRACKERS,
      makeSeedInput: (bytes, name) => new File([bytes], name, { type: "application/octet-stream" }),
      // (what went to your library's readers, and to the readers of the libraries you follow kept here: not the rooms of other libraries'
      // editions, which share these rooms)
      onSent: (roomId, key, bytes, bookId) => {
        const followed = typeof FollowHost !== "undefined" && FollowHost.libOf(roomId);
        if (seeded && followed) return seeded.add(followed, bookId, bytes);
        if (!seeded || !host.publishing || !host.publishing.rooms().some((r) => r.id === roomId)) return;
        seeded.add(lib.status().libId, bookId, bytes);
      },
      // (what each of your devices sends your readers a day at most: the library's own limit, else 50 GB; a library you follow: its own)
      canSend: (roomId, bytes) => {
        const followed = typeof FollowHost !== "undefined" && FollowHost.libOf(roomId);
        if (followed) return FollowHost.canSend(followed, bytes);
        return !seeded || seeded.todayOf(lib.status().libId) + bytes <= ((lib.sharing && lib.sharing().outCap) || 50 * 1024 ** 3);
      },
      log: (...a) => console.debug("[share]", ...a)
    });
    host.publishing = ShareRooms.publishing({
      lib, rooms,
      getChapter: (key) => chapters.getTranslation(key),
      listChapters: async () => new Map((await chapters.listTranslations()).map(([k, e]) => [k, e && e.savedAt])),
      getCover: async (id) => lib.cover(id),
      log: (...a) => console.debug("[share]", ...a)
    });
    // The libraries you follow, in these rooms too (follow-host.js; the site's tab says which: "follows")
    if (typeof FollowHost !== "undefined") FollowHost.attach(rooms, seeded);
    // Other libraries' editions of your novels, "Tell me about new chapters": looked at here, with no page open (every 5 minutes); a new chapter
    // of theirs is fetched from your own source and translated by this extension (p2p-host.js gives fetchChapter and readList).
    host.editions = ShareRooms.editionWatch({
      lib, rooms, store: ShareRooms.followStore(ShareRooms.idbAdapter("p2p-read-editions")),
      listChapters: async () => new Map((await chapters.listTranslations()).map(([k, e]) => [k, e && e.savedAt])),
      fetchChapter: (key, meta) => (host.fetchChapter ? host.fetchChapter(key, meta) : Promise.reject(new Error("not ready"))),
      readList: (url) => (host.readList ? host.readList(url) : Promise.reject(new Error("not ready"))),
      log: (...a) => console.debug("[editions]", ...a)
    });
    const look = () => { host.editionsAt = Date.now(); return host.editions.check().catch((e) => console.debug("[editions] look failed", e)); };
    host.editionsAt = 0;
    host.editionsFirst = Date.now() + 30 * 1000;
    setTimeout(look, 30 * 1000);
    setInterval(look, EDITIONS_EVERY_MS);
  };
  // A chapter this device saved (translated here, or come from another of your devices): its novel's readers are told, and its list.
  host.chapterSaved = (key, entry) => {
    if (host.publishing && entry && entry.translated) host.publishing.chapterSaved(key, entry.savedAt).catch(() => {});
    if (entry && entry.translated) soonLists();
    if (entry && entry.translated && typeof NoticeHost !== "undefined" && NoticeHost.host) NoticeHost.host.soonChapters();
  };

  // Your shared novels' lists (ShareLists, the library site's own code), kept up to date by the extension itself, with no page of the site
  // open: a moment after chapters are saved here (they come in batches) and every 10 minutes, from the chapters this device holds and the
  // library's records. Each is written together with the list the library has (nothing taken away), so a page of the site writing them too
  // does no harm.
  const LISTS_SOON_MS = 20 * 1000;
  const LISTS_EVERY_MS = 10 * 60 * 1000;
  const lists = { chapters: null, timer: null, running: false };
  async function keepSharedLists() {
    const lib = await ready;
    if (!lib || !lists.chapters || lists.running || lib.status().state !== "member" || typeof ShareLists === "undefined" || typeof Chapters === "undefined") return;
    lists.running = true;
    try {
      const books = (await lib.sharedBooks()) || {};
      const rule = (await lib.sharing()) || {};
      if (!rule.all && !Object.keys(books).length) return;
      const index = (await lists.chapters.getIndex()) || {};
      const have = new Set(((await lists.chapters.listTranslations()) || []).filter(([, e]) => e && e.translated).map(([k]) => k));
      const records = ((await lib.api("GET", "/api/novels").catch(() => null)) || {}).novels || [];
      const novels = ShareLists.novelsOf({ index, have, chapterIndex: {} });
      const n = await ShareLists.write({ novels, books, rule, records, chapterIndex: {}, put: (id, m) => lib.put("sbook:" + id, m), stable: (x, y) => Library.stable(x) === Library.stable(y) });
      if (n) console.debug("[lists] the lists of " + n + " shared novel" + (n === 1 ? "" : "s") + " written");
    } catch (e) {
      console.warn("[lists] not written", e);
    } finally {
      lists.running = false;
    }
  }
  function soonLists() {
    clearTimeout(lists.timer);
    lists.timer = setTimeout(() => keepSharedLists(), LISTS_SOON_MS);
  }
  host.keepSharedLists = keepSharedLists;

  // What Chrome's service worker keeps for itself (it has the storage): whether this extension is in the library.
  const bg = (op, ...args) => (direct ? null : ext.runtime.sendMessage({ target: "p2p-bg", op, args }).then((r) => { if (r && r.error) throw new Error(r.error); return r && r.result; }));
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
    // What came from another device: the glossary cache the translator reads is brought up to date (it asks the library, now).
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

  const BEFORE_JOINING = new Set(["status", "join", "cancelJoin", "create"]);
  async function call(op, args = []) {
    const lib = await ready;
    if (!lib) {
      if (op === "status") return { state: "unsupported" };
      throw new Error("this browser cannot make the library's keys (Ed25519): update it");
    }
    // Not a device of a library yet: it can only ask to join one (or be made one: "create").
    if (lib.status().state !== "member" && !BEFORE_JOINING.has(op)) throw new Error("this extension is not in a library yet: open its popup, enter your library's passphrase and press Join");
    switch (op) {
      case "status":
        return Object.assign(lib.status(), { room: host.room ? host.room.status().peers : 0 });
      // An empty library, with this device as its main device.
      case "create":
        await lib.create();
        await setFlag(lib);
        return lib.status();
      case "join":
        if (lib.status().state === "removed") await lib.abandon(); // (taken off the list: the old library goes, and it asks as a new device)
        lib.joinRequest();
        if (host.room) host.room.askToJoin();
        return lib.status();
      case "cancelJoin":
        await lib.cancelJoin();
        return lib.status();
      case "allow": {
        const { keys } = await lib.allow(String(args[0]));
        if (host.room) host.room.sendKeys(keys);
        return lib.status();
      }
      case "refuse":
        await lib.refuse(String(args[0]));
        return lib.status();
      case "unrefuse":
        await lib.unrefuse(String(args[0]));
        return lib.status();
      case "share":
        return lib.share(args[0] === true);
      case "put":
        return lib.put(String(args[0]), args[1] === undefined ? null : args[1]);
      case "sharedBooks":
        return lib.sharedBooks();
      case "sharing":
        return lib.sharing();
      case "layers":
        return lib.layers();
      case "makePr":
        return lib.makePr(args[0] || {});
      case "inbox":
        return lib.inbox();
      case "signComment":
        return lib.signComment(args[0] || {});
      case "editions":
        return lib.editions();
      case "removeDevice": {
        const r = await lib.removeDevice(String(args[0]), args[1] || {});
        return Object.assign(r, lib.status());
      }
      case "publishing":
        return host.publishing ? host.publishing.rooms() : [];
      // the libraries you follow, from the site's tab in this browser (follow-host.js looks after them with no page open)
      case "follows":
        return typeof FollowHost !== "undefined" ? FollowHost.set(args[0], args[1]) : { follows: 0 };
      case "followStatus":
        return typeof FollowHost !== "undefined" ? FollowHost.status() : null;
      // when the extension does what it does on its own, for the site's Triggers tab and Activity › Upcoming: each job's last run (0: not yet;
      // `next` then says when its first is) and how often it runs. The "New chapters" watches carry their own times (watcher.js nextDue).
      case "schedule": {
        const job = (at, every, first) => ({ at: at || 0, every, next: at ? at + every : first || 0 });
        return {
          now: Date.now(),
          editions: host.editions ? job(host.editionsAt, EDITIONS_EVERY_MS, host.editionsFirst) : null,
          follows: typeof FollowHost !== "undefined" && FollowHost.schedule ? await FollowHost.schedule() : null,
          watches: { every: 60 * 1000 },
          fills: host.fills ? host.fills() : {} // (watches set to every chapter: { <watch id>: { at, asked, got, pausedUntil, reason } }, p2p-host.js)
        };
      }
      // "Try again now": a watch's fetching paused by the site's refusal (its bot check) goes on at the next pass
      case "fillResume":
        return host.resumeFill ? host.resumeFill(String(args[0] || "")) : false;
      case "seeded":
        return seeded ? seeded.get(lib.status().libId) : { total: 0, books: {} };
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
      // The library site's tab in this browser answers for this library in its own room (a tab beside this extension has no library of its
      // own, and a device given its passphrase meets it, not this extension): what the room asks of the library (Library.roomLink), call by
      // call. This extension's key signs only a proof for a connection of this library's room.
      case "room": {
        const name = String(args[0] || "");
        if (!Object.prototype.hasOwnProperty.call(Library.ROOM_CALLS, name)) throw new Error("not something the room asks: " + name);
        const rest = args.slice(1);
        if (name === "peerProof" && !(typeof rest[0] === "string" && rest[0].startsWith("p2p-read peer v1|" + lib.status().libId + "|"))) return null;
        return Library.roomLink(lib)[name](...rest);
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

  // The room's view of the library (p2p-core.js opts.library), usable before the library has finished loading.
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
