// P2P sync core: a small index of the translated chapters (chapter key -> version) that devices exchange with each other over a private
// "room" swarm, and the chapters themselves sent over the same connections.
//
// Room: every device that knows the same passphrase seeds an identical tiny torrent whose content is
// derived from that passphrase, so they all land on the same infohash and find each other through the
// WebSocket trackers. Over those room connections they speak a BitTorrent extension protocol
// ("p2pread", BEP-10) to swap index entries, and a chapter's text is sent over them when a device asks for it ("get" / "blob").
// (Until 2026-10 every chapter was also seeded as a torrent of its own; that is on the branch chapter-torrents.)
//
// The core is storage-agnostic: the host passes an adapter, so the same code runs in the browser
// extension (storage.local) and on the library site (IndexedDB).
//
// adapter = {
//   getConfig(): Promise<{ passphrase, trackers?, enabled?, fetch? }>,   fetch: "all" (every chapter in the index is fetched, the default) or
//     "open" (only the chapters asked for with request(), and newer versions of the ones this device holds: a phone with a big library)
//   getIndex(): Promise<object>, setIndex(index): Promise<void>, putIndex?(changes: { key: entry | null }): Promise<void> (when there, only
//   the entries that changed are saved, not the whole index: bucketedIndex makes one over a key-value storage),
//   getTranslation(key): Promise<entry|undefined>,
//   setTranslation(key, entry): Promise<void>,
//   listTranslations(): Promise<[key, { savedAt, translated: boolean }][]>   (light rows, no text)
// }
//
// opts.rtcConfig: the RTCPeerConnection settings every connection is made with ({ iceServers }: a TURN relay, for a phone on mobile data that
// cannot be reached directly). It is kept by reference: changing its iceServers later (a new login) applies to the connections made after.
// opts.localOnly: with no passphrase, still start, for the links on this computer only (addLocalPeer): the extension, which the library site's
// tab in the same browser reaches with no passphrase.
//
// The library (docs/SHARED-LIBRARIES.md): when opts.library is given, the devices of one library also swap its records here: each says which
// records it has ("lv", with their versions), asks for the newer ones ("lq"), sends them in pieces ("lr") and tells the others when it has new
// ones ("lh"). A device asking to join sends "jn" now and then; the main device's "Allow" comes back as "jk" (the owner key, sealed for that
// device), passed on by the others. A device leaving says so ("lx", signed by it), passed on to the main device, which takes it off the list.
// Every record is checked by the library itself; this only carries them.
//   opts.library = {
//     lib(): libId | "",  versions(): [[key, ver]],  wants(key, ver): bool,  wantsMany?(rows): the rows of [[key, ver]] wanted,  get(key): record | null,
//     receive(record): { stored, why?, out?: [records written again] },  joinAsked(msg),  receiveKeys(msg): bool,  joinRequest(): msg | null,
//     leaving?(msg): bool (taken off the list here)
//   }   (each may answer with a promise)
//   A local link whose other end keeps this very library (addLocalPeer's sameLibrary: the library site's tab answering for the extension's
//   library in its own room) writes records this side's room does not hear of: what it tells of them ("lh") is passed on.
//
// Reading the library from a device not in it yet: a device that knows the passphrase but has not joined asks the devices of the library for
// what a page shows (askApi: a read-only /api/... call, "aq"), and one of them answers ("ar", in pieces): the novels, a cover, a chapter
// list, a glossary... only what is asked for, when it is asked. Both are encrypted with a key made from the passphrase, so the room's id alone
// (which the trackers see) opens nothing. A device answers with opts.answerApi(path, { remote }) (null: it is in no library, or does not answer
// that device); only the reads in ROOM_API are answered.
//
// Who may do what (protocol 10). The passphrase only finds the room: a device reads from another, and has it work, only once it has proved it
// is a device of the same library. Each connection makes a fresh X25519 key at both ends ("ah"); a device of the library signs both with its
// device key ("pf", library.js peerProof). Until the other end's proof checks out, nothing of the chapters goes to it: not the list of what
// this device holds ("ver"), not entries, texts or requests ("need", "get", "raw"...), and nothing of that kind it sends is taken or answered.
// What it sends of MEMBER_ONLY also carries an HMAC from the two keys and a number that only goes up ("m", "q"), so a device that passes on
// a real device's proof gets nowhere. A chapter's text is taken only when its bytes are the ones its index entry names. A device in no
// library talks chapters with nobody on the network; only asking to join ("jn" / "jk") and the library's records (signed and encrypted by the
// library itself) pass. A local link the host trusts (addLocalPeer(link, { trusted }), trusted: a boolean, or a function asked each time:
// the site and the extension in one browser) is a device of the library.
(function (root) {
  const EXT_NAME = "p2pread";
  const DEFAULT_TRACKERS = [
    "wss://tracker.heavenlydao.com", // the project's own (turn-server/tracker): a phone on mobile data met no one on the public ones
    "wss://tracker.webtorrent.dev"
  ]; // (tracker.btorrent.xyz was dropped: it refuses connections, and every device only wastes time retrying it. tracker.openwebtorrent.com
  // was dropped too: it lists devices long gone and passes no offers on, so every device only made offers there for no one.)
  const MAX_MSG_BYTES = 12000; // stay under the 16 KB WebRTC data-channel message size
  const MAX_CHAPTER_BYTES = 2 * 1024 * 1024;
  const RETRY_INTERVAL_MS = 2 * 60 * 1000;
  const KEY_PREFIX = "translation:";
  // A chapter in another language than English is its own entry beside the chapter's, "<chapter key>#lang=<code>" (the chapter key itself holds the English one):
  // versions of the same chapter, which the library lists as one. The language is in the key, so nothing else says it.
  const LANG_KEY = /#lang=([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/;
  const langOf = (key) => { const m = LANG_KEY.exec(String(key || "")); return m ? m[1] : ""; }; // "es", or "" for the chapter's own
  const baseKeyOf = (key) => String(key || "").replace(LANG_KEY, "");
  const langKey = (key, lang) => baseKeyOf(key) + (lang && lang !== "en" ? "#lang=" + lang : "");
  // What this build of the sync protocol can do. Bumped when devices gain a message the others must understand, so a device can tell
  // which of the devices it is connected to are current: 2 = direct sending ("get"/"blob"), 3 = original texts and translating on request
  // ("raw"/"rs"), 4 = looking up a next-chapter link, 5 = redoing a chapter. Devices from before this existed send nothing ("unknown").
  // 6 = devices carry an id, so a device reachable both locally and over the network is used once; 7 = the library's records ("lv" / "lq" / "lr" / "lh")
  // and joining it ("jn" / "jk")
  // 8 = reading the library from a device not in it ("aq" / "ar"); 9 = devices of the library proving it ("ah" / "pf", HMACs on MEMBER_ONLY)
  // 10 = only devices of the library talk chapters: the list of what a device holds, entries, texts, requests and the read-only calls (CHAPTER_TALK)
  const PROTOCOL = 10;
  const MEMBER_ONLY = new Set(["ent", "raw", "rs", "rawfail", "rawstop"]);
  const CHAPTER_TALK = new Set(["ver", "need", "get", "blob", "aq", "ar"]);
  const AUTH_WAIT_MS = 15 * 1000; // a device that has not sent its connection key by then (one from before protocol 9) is sent nothing signed
  const KICK_MS = 10 * 1000; // how often a device with no peers looks at its tracker connections
  // A chapter is sent straight over the connection two devices already have (the room's wire), in pieces small enough for one
  // message each. That needs no extra connection, so it arrives in about a second.
  const DIRECT_CHUNK = 8000; // raw bytes per message (about 10.7 KB once base64-encoded, under MAX_MSG_BYTES' 16 KB channel limit)
  const DIRECT_REASK_MS = 5000;
  // A version of a chapter nobody connected answers for (the device that has it is offline; or the others hold an older copy) is asked for again
  // less and less often: after DIRECT_REASK_MS, then REASK_BACKOFF_MS, twice as long each time up to REASK_MAX_MS. A device connecting, a newer
  // version, or a person opening the chapter (request) asks at once.
  const REASK_BACKOFF_MS = 2 * 60 * 1000;
  const REASK_MAX_MS = 60 * 60 * 1000;
  const reaskAfter = (n) => (n < 2 ? DIRECT_REASK_MS : Math.min(REASK_BACKOFF_MS * 2 ** (n - 2), REASK_MAX_MS));
  const MAX_ASSEMBLIES = 30;
  const MAX_RECORD_BYTES = 4 * 1024 * 1024; // one library record as sent (its body is at most 2 MB before encryption: library.js)
  const JOIN_EVERY_MS = 15 * 1000; // a device asking to join the library asks again this often, so a main device that comes later hears it
  // What a device not in the library may read from it (GET only): not everything at once (export, sync), and not the key comments are posted with.
  const ROOM_API = /^\/api\/(novels|covers\/[^/?]+|chapter-index|novel-links|bindings|glossaries(\/[^/?]+)?|watches|notices|wtr-library|my-ratings|term-notes|my-terms|comment-links|settings)(\?.*)?$/;
  const API_TIMEOUT_MS = 30 * 1000;
  const API_MAX_BYTES = 12 * 1024 * 1024; // one answer (the novels of a library of thousands, a long chapter list)
  const API_PIECE = 10000; // characters of the encrypted answer per message

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function toB64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromB64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Canonical JSON (sorted keys) so the same entry always serializes to the same bytes, which makes the
  // same chapter always hash to the same id (its index entry's "infohash") — after a restart too.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
      return (
        "{" +
        Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(v);
  }

  // Only translated chapters are synced this way. Glossaries and the rest of the library pass between devices as library records (library.js).
  //   translation:<url>   { translated, suggestions, savedAt, model, pageTitle, novelName }   (`savedAt`: newest wins)
  function kindOf(key) {
    if (typeof key !== "string" || key.length >= 2048) return null;
    return key.startsWith(KEY_PREFIX + "http") ? "translation" : null;
  }

  // Returns a clean copy of a chapter entry, or null if the key isn't a chapter.
  function sanitize(key, e) {
    if (!kindOf(key) || !e || typeof e !== "object") return null;
    return {
      translated: String(e.translated || ""),
      suggestions: Array.isArray(e.suggestions) ? e.suggestions : [],
      savedAt: Number(e.savedAt) || 0,
      model: e.model || null,
      pageTitle: e.pageTitle ? String(e.pageTitle) : "",
      novelName: e.novelName ? String(e.novelName) : "",
      // where the next chapter is on the source site (https only), so a reader can go on past the chapters it knows about
      next: typeof e.next === "string" && /^https:\/\//.test(e.next) && e.next.length <= 500 ? e.next : undefined
    };
  }

  const hasContent = (key, e) => !!(sanitize(key, e) || {}).translated;

  // What the index shows for a chapter.
  const describe = (key, clean) => ({ novelName: clean.novelName, pageTitle: clean.pageTitle, model: clean.model });

  // A room's torrent makes WebRTC offers only when someone could take them. Each announce to a tracker carries up to 5 offers, each a
  // connection being set up (on a page with a relay login, holding relay addresses), whoever is in the room. A device alone in a room, or
  // already connected to everyone the tracker lists, needs none: a device that arrives sends its own offers, and the tracker passes them
  // to the ones already there. So each tracker's answer (how many devices it lists in the room) sets how many offers the next announce to
  // that tracker carries: as many as the devices it lists that this one is not connected to, at most 5. Until a tracker has answered, the
  // usual 5. (A tracker that lists devices long gone gets offers as before.) And none past the connection target: in a room of thousands, a
  // device connected to 30 of them (8 on a page whose connections go through the relay, each holding relay ports) makes no more offers; the
  // room is a web of devices each connected to some, not everyone to everyone, and records spread across it.
  // And a room connected to nobody while a tracker lists other devices announces again soon (15 s, then 30, 60, at most 120 s apart) instead of
  // at the tracker's own interval (minutes), until it is connected or listed alone: a device that came back under a new id (its page opened
  // again) sends its offers to a few of the devices listed, which may all be entries of devices long gone, so the one waiting for it must
  // ask again itself to be found.
  // This reaches into the tracker client of the pinned WebTorrent 1.9.7 (bittorrent-tracker 9: client._trackers, tracker.announce,
  // "update", client.update()); if that changes, it does nothing.
  let connectionTarget = 30;
  function setConnectionTarget(n) {
    if (Number.isFinite(n) && n > 0) connectionTarget = Math.floor(n);
  }
  const LONELY_FIRST_MS = 15 * 1000;
  const LONELY_MAX_MS = 120 * 1000;
  function offerOnlyWhenNeeded(torrent, opts = {}) {
    const client = torrent && torrent.discovery && torrent.discovery.tracker;
    if (!client || !Array.isArray(client._trackers) || client.__offersFitted) return false;
    client.__offersFitted = true;
    const others = new Map(); // tracker's announce url -> how many other devices it listed in its last answer
    const first = opts.lonelyMs || LONELY_FIRST_MS;
    const most = opts.lonelyMaxMs || LONELY_MAX_MS;
    let lonely = { timer: null, wait: first };
    client.on("update", (d) => {
      if (d && typeof d.announce === "string") others.set(d.announce, Math.max(0, (Number(d.complete) || 0) + (Number(d.incomplete) || 0) - 1));
      // (connected to nobody, others listed: asked again soon)
      const listed = [...others.values()].some((n) => n > 0);
      if ((torrent.numPeers || 0) > 0 || !listed || torrent.destroyed) {
        clearTimeout(lonely.timer);
        lonely = { timer: null, wait: first };
        return;
      }
      if (lonely.timer) return;
      lonely.timer = setTimeout(() => {
        lonely.timer = null;
        if (!torrent.destroyed && !(torrent.numPeers > 0) && typeof client.update === "function") client.update();
      }, lonely.wait);
      if (lonely.timer && lonely.timer.unref) lonely.timer.unref();
      lonely.wait = Math.min(lonely.wait * 2, most);
    });
    for (const t of client._trackers) {
      if (!t || typeof t.announce !== "function") continue;
      const announce = t.announce.bind(t);
      t.announce = (o) => {
        const listed = others.get(t.announceUrl);
        if (listed === undefined || !o || o.event === "stopped" || o.event === "completed") return announce(o);
        const need = Math.max(0, Math.min(listed, connectionTarget) - (torrent.numPeers || 0));
        return announce(Object.assign({}, o, { numwant: Math.min(Number(o.numwant) || 5, need) }));
      };
    }
    return true;
  }

  // The index over a key-value storage (chrome.storage.local, browser.storage.local): kept in INDEX_BUCKETS parts ("<base>:<n>", by a hash of
  // the chapter key), so a change rewrites its part and not the whole index; an index kept whole under "<base>" (before this) is moved into
  // them the first time it is read. get(names) -> { name: value }, set({ name: value }), remove(name). -> { getIndex, setIndex, putIndex }
  const INDEX_BUCKETS = 64;
  function bucketedIndex({ get, set, remove, base }) {
    const partOf = (k) => { let h = 0x811c9dc5; for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) % INDEX_BUCKETS; };
    const names = Array.from({ length: INDEX_BUCKETS }, (_, i) => base + ":" + i);
    let chain = Promise.resolve(); // (one change at a time: each reads its parts, then writes them)
    const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    const split = (index) => {
      const out = {};
      for (const n of names) out[n] = {};
      for (const [k, v] of Object.entries(index || {})) out[names[partOf(k)]][k] = v;
      return out;
    };
    return {
      getIndex: () => serial(async () => {
        const got = (await get(names.concat(base))) || {};
        if (got[base] && typeof got[base] === "object") {
          await set(split(got[base]));
          await remove(base);
          return got[base];
        }
        return Object.assign({}, ...names.map((n) => got[n] || {}));
      }),
      setIndex: (index) => serial(() => set(split(index))),
      putIndex: (changes) => serial(async () => {
        const touched = [...new Set(Object.keys(changes).map((k) => names[partOf(k)]))];
        if (!touched.length) return;
        const got = (await get(touched)) || {};
        const out = {};
        for (const n of touched) out[n] = Object.assign({}, got[n] || {});
        for (const [k, v] of Object.entries(changes)) { const part = out[names[partOf(k)]]; if (v) part[k] = v; else delete part[k]; }
        await set(out);
      })
    };
  }

  function createP2P(opts) {
    const { adapter, WebTorrent } = opts;
    const log = opts.log || (() => {});
    // skip(key): a chapter this device ignores (a novel deleted from it): not asked for, not taken from a device, not offered again
    const skip = typeof opts.skip === "function" ? opts.skip : () => false;
    // The room's torrent: browsers seed it from a File; node (tests) from a Buffer with a name option.
    const makeSeedInput =
      opts.makeSeedInput || ((bytes, name) => new File([bytes], name, { type: "application/octet-stream" }));
    const onChange = opts.onChange || (() => {});

    let client = null;
    let cfg = null;
    let trackers = DEFAULT_TRACKERS;
    let index = {};
    let roomTorrent = null;
    let roomId = null;
    let BufferClass = typeof Buffer !== "undefined" ? Buffer : null;
    const peers = new Set();
    // A random name for this running copy of the core. Devices tell each other (in "hi"), so one reached twice, over the local link AND the
    // network, is recognised as one, and the local link is the one used.
    const ownId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    const locals = new Set(); // links to devices on this computer (see addLocalPeer): kept across restarts of the network side

    // The peers to talk to: every one, except a network peer that is also connected through a local link.
    function usablePeers() {
      const localIds = new Set([...peers].filter((p) => p.local && p.info && p.info.id).map((p) => p.info.id));
      return [...peers].filter((p) => p.local || !(p.info && localIds.has(p.info.id)));
    }
    const trustedNow = (p) => !!(p.local && (typeof p.trusted === "function" ? p.trusted() : p.trusted));
    // The ones that are devices of this library (proved it, or a local link the host trusts): the only ones chapters go to and come from.
    const memberPeers = () => usablePeers().filter((p) => p.ready && (trustedNow(p) || p.member === true));
    // The same, asked of one peer that just sent something (its proof may still be being checked).
    async function allowed(peer) {
      if (trustedNow(peer)) return true;
      if (!lib || !(await lib.lib())) return false;
      const a = peer.auth;
      return !!(a && a.member && (await a.member));
    }
    const seeded = new Map(); // torrent name -> torrent (the room's)
    let retryTimer = null;
    let persistTimer = null;
    let stopped = true;
    const stats = { fetched: 0, published: 0, errors: 0, direct: 0, kicks: 0 };
    let kickTimer = null;
    const lastKick = new WeakMap(); // tracker connection -> when it was last reconnected by hand
    const directAsked = new Map(); // chapter key -> when the direct transfer was last asked for
    const unanswered = new Map(); // chapter key -> { n, at, ver }: asks for that version nobody answered yet (reaskAfter)
    const assemblies = new Map(); // chapter key -> pieces received so far
    const transfers = new Map(); // chapter key -> { direct: { since } }: what the activity view shows
    const lib = opts.library || null;
    const recAsked = new Map(); // library record key -> { at, ver }: when it was asked for, and which version
    const recHeard = new Map(); // library record key -> { ver, peer }: the newest version a device said it has (asked for again if what came is older)
    const recAssemblies = new Map(); // library record key -> pieces received so far
    let afterDevices = new Set(); // records refused for now (their device not listed yet, their owner key not here yet): asked for again when that comes
    const keysSeen = new Set(); // "jk" messages already passed on
    const apiAsks = new Map(); // id -> a read-only library call this device is waiting on (askApi)
    let onDemand = false; // cfg.fetch === "open": only what is asked for
    const wanted = new Set(); // (on demand) chapters asked for and not here yet
    const rawAsks = new Map(); // chapters asked of the devices with the extension (requestRaw) and not said done yet -> whether the original text alone was asked for
    let retrySoon = null;
    let apiKey = null; // Promise<CryptoKey>: made from the passphrase
    const joinsSeen = new Set(); // requests to join already passed on (per device, per JOIN_EVERY_MS)
    let joinTimer = null;

    // ---------- helpers ----------
    function encodeChapter(key, entry) {
      return enc.encode(stable({ v: 1, key, entry: sanitize(key, entry) }));
    }

    // The index is saved shortly after it changes: the entries that changed (adapter.putIndex), else the whole of it.
    const dirty = new Set();
    function schedulePersist(keys) {
      for (const k of keys || []) dirty.add(k);
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistIndex, 300);
    }
    function persistIndex() {
      if (adapter.putIndex) {
        if (!dirty.size) return;
        const changes = {};
        for (const k of dirty) changes[k] = index[k] || null;
        dirty.clear();
        adapter.putIndex(changes).catch((e) => log("index not saved", e));
      } else {
        dirty.clear();
        adapter.setIndex(index).catch(() => {});
      }
    }

    function validKey(key) {
      return kindOf(key) !== null;
    }

    // A chapter's id in the index: the first 40 hex digits of its bytes' SHA-256. It is still called "infohash", and kept at 40 hex digits,
    // because it was a torrent's infohash once and devices from then accept an index entry only in that form.
    async function chapterId(bytes) {
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(buf).subarray(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function validMeta(m) {
      return (
        m &&
        validKey(m.key) &&
        typeof m.infohash === "string" &&
        /^[0-9a-f]{40}$/.test(m.infohash) &&
        Number.isFinite(m.savedAt) &&
        m.savedAt > 0
      );
    }

    function metaOf(key) {
      return Object.assign({ key }, index[key]);
    }

    function seedBytes(bytes, name, { keep = true, announce = trackers } = {}) { // (the room's torrent)
      return new Promise((resolve, reject) => {
        if (seeded.has(name)) return resolve(seeded.get(name));
        let settled = false;
        const torrent = client.seed(makeSeedInput(bytes, name), { name, announce }, (t) => {
          settled = true;
          if (!BufferClass && t.torrentFile) BufferClass = t.torrentFile.constructor;
          if (keep) seeded.set(name, t);
          resolve(t);
        });
        torrent.on("error", (err) => {
          if (!settled) reject(err);
        });
        // Callers attach wire listeners via this hook before peers connect.
        if (opts.__onTorrentCreated) opts.__onTorrentCreated(torrent);
      });
    }

    // ---------- peer protocol ----------
    function makeExtClass() {
      function Ext(wire) {
        this._wire = wire;
        this.ready = false;
        this.remoteVersions = {};
      }
      Ext.prototype.name = EXT_NAME;
      Ext.prototype.onHandshake = function () {};
      Ext.prototype.onExtendedHandshake = function () {
        this.ready = true;
        peers.add(this);
        onPeerReady(this);
      };
      Ext.prototype.onMessage = function (buf) {
        let msg;
        try {
          msg = JSON.parse(dec.decode(buf));
        } catch (e) {
          return;
        }
        onPeerMessage(this, msg).catch((e) => log("peer message error", e));
      };
      Ext.prototype.send = function (obj) {
        const json = JSON.stringify(obj);
        const payload = BufferClass ? BufferClass.from(json, "utf8") : enc.encode(json);
        try {
          this._wire.extended(EXT_NAME, payload);
        } catch (e) {
          // peer doesn't speak our extension (or wire already closed)
        }
      };
      return Ext;
    }
    const Ext = makeExtClass();

    function attachWire(wire) {
      if (wire[EXT_NAME]) return;
      wire.use(Ext);
      wire.once("close", () => {
        peers.delete(wire[EXT_NAME]);
      });
    }

    // Splits `items` into messages that each serialize to <= MAX_MSG_BYTES.
    function sendChunked(peer, makeMsg, items, fits) {
      let batch = [];
      let size = 0;
      const flush = (last) => {
        say(peer, makeMsg(batch, last));
        batch = [];
        size = 0;
      };
      for (const it of items) {
        const itSize = fits(it);
        if (batch.length && size + itSize > MAX_MSG_BYTES) flush(false);
        batch.push(it);
        size += itSize;
      }
      flush(true);
    }

    function sendVersions(peer) {
      const rows = Object.keys(index).map((k) => [k, index[k].savedAt]);
      sendChunked(peer, (b, last) => ({ t: "ver", v: b, last }), rows, (r) => r[0].length + 24);
    }

    function sendEntries(peer, keys) {
      const metas = keys.filter((k) => index[k]).map(metaOf);
      if (!metas.length) return;
      sendChunked(peer, (b) => ({ t: "ent", e: b }), metas, (m) => JSON.stringify(m).length + 2);
    }

    function broadcastEntries(keys, exceptPeer) {
      for (const p of memberPeers()) {
        if (p !== exceptPeer) sendEntries(p, keys);
      }
    }

    // ---------- links to devices on this computer ----------
    // A device in the same browser (the site's page and the extension) can talk directly, with no trackers and no WebRTC: the host gives a
    // link { send(obj) } and passes what comes back to receive(msg). It is one more peer to everything else here.
    // trusted: true, or a function asked each time (the extension trusts the site's tab once it is in a library itself); refresh() after it may
    // have changed: once trusted, what this device holds is said to it. sameLibrary: a function asked each time, true while the other end keeps
    // the library this side's room speaks for (see opts.library).
    function attachLocal(l) {
      l.peer = { ready: true, local: true, trusted: l.trusted, sameLibrary: l.sameLibrary, remoteVersions: {}, info: undefined, send: (obj) => { try { l.link.send(obj); } catch (e) { /* the link just closed */ } } };
      peers.add(l.peer);
      onPeerReady(l.peer);
    }
    function refreshLocal(l) {
      const p = l.peer;
      if (!p || stopped) return;
      const now = trustedNow(p);
      if (now && !p.toldTrusted) { sendVersions(p); retryMissing(); }
      p.toldTrusted = now;
    }

    function addLocalPeer(link, { trusted = false, sameLibrary = null } = {}) {
      const l = { link, trusted: typeof trusted === "function" ? trusted : !!trusted, sameLibrary: typeof sameLibrary === "function" ? sameLibrary : () => false, peer: null };
      locals.add(l);
      if (!stopped) attachLocal(l);
      return {
        receive: (msg) => { if (l.peer && msg && typeof msg === "object") onPeerMessage(l.peer, msg).catch((e) => log("local peer message error", e)); },
        refresh: () => refreshLocal(l),
        close: () => { locals.delete(l); if (l.peer) peers.delete(l.peer); l.peer = null; }
      };
    }

    function onPeerReady(peer) {
      unanswered.clear(); // (a device came: it may have what nobody had)
      // (b: which build of its role this is, when it says: the site tells an extension too old for what it is asked, opts.build)
      peer.send({ t: "hi", r: String(opts.role || "device").slice(0, 20), v: PROTOCOL, i: ownId, b: Math.max(0, Math.floor(Number(opts.build) || 0)) });
      startAuth(peer); // (a local link too: one the host does not trust yet may still prove it is a device of the library)
      if (peer.local) refreshLocal({ peer }); // trusted: what this device holds is said now; a network peer hears it once its proof checks out
      retryMissing();
      if (lib) {
        sendRecordVersions(peer).catch((e) => log("library versions failed", e));
        askToJoin(peer).catch(() => {});
      }
    }

    // ---------- who a peer is (MEMBER_ONLY) ----------
    const X = { name: "X25519" };
    const proofText = (libId, prover, verifier) => "p2p-read peer v1|" + libId + "|" + prover + "|" + verifier;
    function startAuth(peer) {
      const a = { theirs: null, member: null, sent: 0, got: 0, chain: Promise.resolve(), recv: Promise.resolve() };
      a.key = new Promise((res) => { a.setKey = res; });
      peer.auth = a;
      setTimeout(() => a.setKey(null), AUTH_WAIT_MS);
      a.mine = (async () => {
        const k = await crypto.subtle.generateKey(X, false, ["deriveBits"]);
        return { priv: k.privateKey, pub: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey))) };
      })();
      a.mine.then((m) => peer.send({ t: "ah", e: m.pub }), () => a.setKey(null));
    }
    // The other end's key came: the HMAC key from both, and (on a device of the library) the proof, sent before anything signed with it.
    async function onAuthKey(peer, e) {
      const a = peer.auth;
      if (!a || a.theirs || typeof e !== "string" || e.length > 100) return;
      a.theirs = e;
      try {
        const m = await a.mine;
        const pub = await crypto.subtle.importKey("raw", fromB64(e), X, false, []);
        const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, m.priv, 256);
        const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode([m.pub, e].sort().join("|")), info: enc.encode("p2p-read peer v1") },
          hk, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        await sendProof(peer).catch(() => {});
        a.setKey(key);
      } catch (err) {
        a.setKey(null);
      }
    }
    // ask: the other end is asked to send its own again (this device could not check it before: it was not in the library yet, or did not
    // have the library's list of devices yet)
    async function sendProof(peer, ask = false) {
      const a = peer.auth;
      if (!a || !a.theirs || !lib) return;
      const l = await lib.lib();
      const proof = l && (await lib.peerProof(proofText(l, (await a.mine).pub, a.theirs)));
      if (proof) peer.send({ t: "pf", d: proof.d, s: proof.s, ...(ask ? { r: 1 } : {}) });
    }
    // The devices this one has not found to be of its library are asked for their proof again (the list of devices, or an owner key, came).
    function askProofs() {
      for (const p of usablePeers()) if (p.ready && p.member !== true && !trustedNow(p)) sendProof(p, true).catch(() => {});
    }
    // Sends a message; one of MEMBER_ONLY is signed for this connection, in the order asked (the other end takes only rising numbers).
    function say(peer, obj) {
      const a = peer.auth;
      if (!a || !MEMBER_ONLY.has(obj.t)) return peer.send(obj);
      a.chain = a.chain.then(async () => {
        const key = await a.key;
        if (key) {
          obj.q = ++a.sent;
          obj.m = toB64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode((await a.mine).pub + "|" + stable(obj)))));
        }
        peer.send(obj);
      }).catch((e) => log("signing a message failed", e));
    }
    // May this peer send this device a MEMBER_ONLY message? (Checked in the order they came: the numbers must rise.)
    function fromMember(peer, msg) {
      if (trustedNow(peer)) return Promise.resolve(true);
      const a = peer.auth;
      const check = async () => {
        if (!lib || !(await lib.lib())) return false; // this device is in no library: it takes this from nobody on the network
        if (!a || !a.member || !(await a.member)) return false;
        const key = await a.key;
        if (!key || typeof msg.m !== "string" || !Number.isInteger(msg.q) || msg.q <= a.got) return false;
        const { m, ...rest } = msg;
        let ok = false;
        try { ok = await crypto.subtle.verify("HMAC", key, fromB64(m), enc.encode(a.theirs + "|" + stable(rest))); } catch (e) { /* not base64 */ }
        if (ok) a.got = msg.q;
        return ok;
      };
      if (!a) return check();
      const out = a.recv.then(check, check);
      a.recv = out.catch(() => {});
      return out;
    }

    // ---------- reading the library from a device not in it ----------
    function roomKey() {
      if (!apiKey) apiKey = crypto.subtle.digest("SHA-256", enc.encode("p2p-read:v1:api:" + cfg.passphrase)).then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
      return apiKey;
    }
    async function sealApi(obj) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await roomKey(), enc.encode(JSON.stringify(obj))));
      return { iv: toB64(iv), d: toB64(ct) };
    }
    async function openApi(iv, d) {
      return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await roomKey(), fromB64(d))));
    }
    // The devices that may answer: devices of the library (since protocol 10 nobody answers a device not in it), on a build that knows these calls.
    const apiPeers = () => memberPeers().filter((p) => p.info && p.info.v >= 8);

    // Ask the devices of the library: the first that answers is listened to; it fails when all say they are in no library, or none answers.
    async function askApi(path) {
      if (stopped || !cfg) throw Object.assign(new Error("not connected"), { code: "nobody" });
      if (!ROOM_API.test(path)) throw new Error("not something to read from another device: " + path);
      const targets = apiPeers();
      if (!targets.length) throw Object.assign(new Error("no device of your library is connected"), { code: "nobody" });
      const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
      const q = await sealApi({ m: "GET", p: path });
      return new Promise((resolve, reject) => {
        const done = (fn, v) => { clearTimeout(a.timer); apiAsks.delete(id); fn(v); };
        const a = {
          left: new Set(targets), from: null, parts: null, got: 0,
          ok: (v) => done(resolve, v), fail: (e) => done(reject, e),
          timer: setTimeout(() => done(reject, Object.assign(new Error("no device of your library answered"), { code: "nobody" })), opts.apiTimeoutMs || API_TIMEOUT_MS)
        };
        apiAsks.set(id, a);
        for (const p of targets) p.send({ t: "aq", id, iv: q.iv, d: q.d });
      });
    }

    async function answerApi(peer, msg) {
      let q;
      try { q = await openApi(msg.iv, msg.d); } catch (e) { return; } // (not this passphrase's)
      if (!q || q.m !== "GET" || typeof q.p !== "string" || q.p.length > 2000 || !ROOM_API.test(q.p) || !opts.answerApi) return peer.send({ t: "ar", id: msg.id, no: 1 });
      let out;
      try {
        out = await opts.answerApi(q.p, { remote: !peer.local });
      } catch (e) {
        const s = await sealApi({ error: String((e && e.message) || e).slice(0, 300), status: (e && e.status) || 500 });
        return peer.send({ t: "ar", id: msg.id, iv: s.iv, i: 0, n: 1, d: s.d });
      }
      if (out === null || out === undefined) return peer.send({ t: "ar", id: msg.id, no: 1 }); // in no library
      const s = await sealApi({ ok: out });
      if (s.d.length > API_MAX_BYTES * 1.4) return peer.send({ t: "ar", id: msg.id, no: 1 });
      const n = Math.ceil(s.d.length / API_PIECE);
      for (let i = 0; i < n && peers.has(peer); i++) {
        peer.send({ t: "ar", id: msg.id, iv: s.iv, i, n, d: s.d.slice(i * API_PIECE, (i + 1) * API_PIECE) });
        if (i % 20 === 19) await new Promise((res) => setTimeout(res, 0)); // (a long answer does not stop everything else)
      }
    }

    async function receiveApi(peer, msg) {
      const a = apiAsks.get(msg.id);
      if (!a || !a.left.has(peer) && a.from !== peer) return;
      if (msg.no) {
        a.left.delete(peer);
        if (!a.left.size && !a.from) a.fail(Object.assign(new Error("no device of your library is connected"), { code: "nobody" }));
        return;
      }
      const maxPieces = Math.ceil((API_MAX_BYTES * 1.4) / API_PIECE);
      if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > maxPieces || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string" || typeof msg.iv !== "string") return;
      if (a.from && a.from !== peer) return; // (another device is answering)
      if (!a.from) { a.from = peer; a.parts = new Array(msg.n); a.iv = msg.iv; }
      if (msg.n !== a.parts.length || msg.iv !== a.iv || a.parts[msg.i] !== undefined) return;
      a.parts[msg.i] = msg.d;
      if (++a.got < a.parts.length) return;
      let r;
      try { r = await openApi(a.iv, a.parts.join("")); } catch (e) { return a.fail(new Error("the answer could not be read")); }
      if (r && "ok" in r) a.ok(r.ok);
      else a.fail(Object.assign(new Error((r && r.error) || "failed"), { status: r && r.status }));
    }

    // ---------- the library's records ----------
    async function sendRecordVersions(peer) {
      const l = await lib.lib();
      if (!l) return;
      const rows = (await lib.versions()).map(([k, v]) => [k, v]);
      // (the list of devices first: without it the other device cannot check any record)
      rows.sort((a, b) => (b[0] === "devices") - (a[0] === "devices"));
      sendChunked(peer, (b, last) => ({ t: "lv", l, v: b, last }), rows, (r) => r[0].length + 40);
    }

    const verAfter = (a, b) => JSON.stringify(a) !== JSON.stringify(b) && (a[0] - b[0] || a[1] - b[1] || (a[2] > b[2] ? 1 : -1)) > 0;
    // rows: [[key, ver]] this peer has and this device wants
    async function askRecords(peer, rows) {
      const fresh = [];
      const now = Date.now();
      for (const [k, v] of rows) {
        const heard = recHeard.get(k);
        if (!heard || verAfter(v, heard.ver)) recHeard.set(k, { ver: v, peer });
        const asked = recAsked.get(k);
        if (asked && now - asked.at < DIRECT_REASK_MS * 4 && !verAfter(v, asked.ver)) continue; // this version (or a later one) is on its way
        recAsked.set(k, { at: now, ver: v });
        fresh.push(k);
      }
      fresh.sort((a, b) => (b === "devices") - (a === "devices"));
      for (let i = 0; i < fresh.length; i += 300) peer.send({ t: "lq", k: fresh.slice(i, i + 300) });
    }

    // What a device asked for goes out one record at a time, so a phone asking for the whole library does not stop everything else.
    function queueRecords(peer, keys) {
      peer.recQueue = peer.recQueue || [];
      for (const k of keys) if (!peer.recQueue.includes(k)) peer.recQueue.push(k);
      if (peer.recSending) return;
      peer.recSending = true;
      (async () => {
        while (peer.recQueue.length && !stopped && peers.has(peer)) {
          const r = await lib.get(peer.recQueue.shift());
          if (!r) continue;
          const bytes = enc.encode(JSON.stringify(r));
          if (bytes.length > MAX_RECORD_BYTES) continue;
          const n = Math.ceil(bytes.length / DIRECT_CHUNK);
          const s = JSON.stringify(r.ver);
          for (let i = 0; i < n; i++) peer.send({ t: "lr", k: r.key, s, i, n, d: toB64(bytes.subarray(i * DIRECT_CHUNK, (i + 1) * DIRECT_CHUNK)) });
          await new Promise((res) => setTimeout(res, 0));
        }
      })().catch((e) => log("sending records failed", e)).finally(() => { peer.recSending = false; });
    }

    async function receiveRecordPiece(peer, msg) {
      const key = msg.k;
      if (!recAsked.has(key)) return; // only what was asked for
      const maxPieces = Math.ceil(MAX_RECORD_BYTES / DIRECT_CHUNK);
      if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > maxPieces || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string") return;
      let a = recAssemblies.get(key);
      if (!a || a.id !== msg.s || a.n !== msg.n) {
        if (recAssemblies.size >= MAX_ASSEMBLIES) recAssemblies.delete(recAssemblies.keys().next().value);
        a = { id: msg.s, n: msg.n, parts: new Array(msg.n), got: 0 };
        recAssemblies.set(key, a);
      }
      if (a.parts[msg.i]) return;
      // (a library record is not a chapter: it is not counted as downloading, so nothing is left there that no entry of the log follows)
      let piece;
      try {
        piece = fromB64(msg.d);
      } catch (e) {
        return;
      }
      if (piece.length > DIRECT_CHUNK) return;
      a.parts[msg.i] = piece;
      if (++a.got < a.n) return;
      recAssemblies.delete(key);
      recAsked.delete(key);
      const bytes = new Uint8Array(a.parts.reduce((sum, x) => sum + x.length, 0));
      let at = 0;
      for (const x of a.parts) {
        bytes.set(x, at);
        at += x.length;
      }
      let record;
      try {
        record = JSON.parse(dec.decode(bytes));
      } catch (e) {
        return;
      }
      if (!record || record.key !== key) return;
      const res = (await lib.receive(record)) || {};
      // a later version was said to be there while this one was on its way: that one is asked for now
      const heard = recHeard.get(key);
      if (heard && Array.isArray(record.ver) && verAfter(heard.ver, record.ver) && peers.has(heard.peer)) askRecords(heard.peer, [[key, heard.ver]]);
      else recHeard.delete(key);
      // refused for now: its device is not listed yet, or it was written with an owner key that is still on its way (after a device was removed)
      if (res.why === "not a device of this library" || res.why === "key not known yet") afterDevices.add(key);
      if (!res.stored) return;
      stats.records = (stats.records || 0) + 1;
      const told = [[record.key, record.ver]].concat((res.out || []).map((r) => [r.key, r.ver]));
      for (const p of usablePeers()) if (p !== peer && p.ready) p.send({ t: "lh", l: record.lib, v: told }); // passed on
      if (res.out && res.out.length) peer.send({ t: "lh", l: record.lib, v: res.out.map((r) => [r.key, r.ver]) }); // (merged: the sender wants it too)
      if (key === "devices" || key.startsWith("okey:")) askProofs();
      if ((key === "devices" || key.startsWith("okey:")) && afterDevices.size) {
        const again = [...afterDevices];
        afterDevices = new Set();
        for (const k of again) recAsked.set(k, { at: Date.now(), ver: [0, 0, ""] });
        for (const p of usablePeers()) if (p.ready) p.send({ t: "lq", k: again.slice(0, 300) });
      }
      onChange({ type: "record", key });
    }

    // On a device asking to join: ask whoever is there, now and then, until it is let in.
    async function askToJoin(peer) {
      const msg = await lib.joinRequest();
      if (!msg) return;
      for (const p of peer ? [peer] : usablePeers()) if (p.ready) p.send(msg);
    }

    // Records this device wrote (from the library's API): the other devices are told, and ask for them.
    async function announceRecords(records) {
      if (!lib || stopped || !records.length) return;
      const l = await lib.lib();
      const v = records.map((r) => [r.key, r.ver]);
      for (const p of usablePeers()) if (p.ready) p.send({ t: "lh", l, v });
    }

    // This device leaves the library (msg: library.js leaveProof): every device here is told, and passes it on to the main device.
    function sayLeaving(msg) {
      if (!msg || msg.t !== "lx") return 0;
      joinsSeen.add("lx:" + msg.id + "@" + msg.at);
      let told = 0;
      for (const p of usablePeers()) if (p.ready) { p.send(msg); told++; }
      return told;
    }

    // The main device let a device in: its key goes to every device here (only the one it is for can open it), and they pass it on.
    function sendKeys(msg) {
      keysSeen.add(msg.epk);
      for (const p of usablePeers()) if (p.ready) p.send(msg);
    }

    // After joining (the owner key arrived), or now and then: every device is asked for what it has.
    function syncLibrary() {
      if (!lib || stopped) return;
      for (const p of usablePeers()) {
        if (!p.ready) continue;
        p.send({ t: "lvq" });
        sendRecordVersions(p).catch(() => {});
      }
    }

    // The library this device speaks for changed (it joined one; the site's tab answers for the extension's library now, or for its own again):
    // it proves itself again to every device and asks for theirs (each, having checked it, says what it holds; local links it trusts now hear it
    // too), and the library's records are compared again.
    function libraryChanged() {
      if (!lib || stopped) return;
      for (const p of usablePeers()) if (p.ready) { if (p.auth) p.auth.echoed = false; sendProof(p, true).catch(() => {}); }
      for (const l of locals) refreshLocal(l);
      syncLibrary();
    }

    // What this device lacks of what a device holds (asked for) and what that device lacks of this one's (sent), by the versions it told.
    function compareVersions(peer) {
      const need = [];
      const give = [];
      for (const k of Object.keys(peer.remoteVersions)) {
        if (skip(k)) continue;
        if (!index[k] || index[k].savedAt < peer.remoteVersions[k]) need.push(k);
      }
      for (const k of Object.keys(index)) {
        if (!(k in peer.remoteVersions) || peer.remoteVersions[k] < index[k].savedAt) give.push(k);
      }
      if (need.length) peer.send({ t: "need", k: need.slice(0, 500) });
      if (give.length) sendEntries(peer, give);
    }
    // Compared again with every device connected, from the versions they told: after chapters this device ignored are taken again.
    function resync() {
      if (stopped) return;
      for (const p of usablePeers()) if (p.ready) compareVersions(p);
    }

    async function onPeerMessage(peer, msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "pf") {
        // (set before anything is awaited, so the messages after it wait for the answer)
        const a = peer.auth;
        if (a && lib && typeof msg.d === "string" && typeof msg.s === "string") {
          a.member = (async () => {
            const l = await lib.lib();
            return !!(l && a.theirs && (await lib.peerCheck(msg.d, proofText(l, a.theirs, (await a.mine).pub), msg.s)));
          })().catch(() => false);
          const was = peer.member === true;
          if (msg.r) a.key.then(() => sendProof(peer)).catch(() => {}); // (asked for this device's again)
          a.member.then(async (ok) => {
            peer.member = ok;
            if (!ok || was || stopped) return;
            // A device of this library: once this device's own proof is on its way (a.key is set after it is sent), what it holds is said.
            await a.key;
            if (!a.echoed) { a.echoed = true; await sendProof(peer).catch(() => {}); } // (it may have checked this one before this one was in the library)
            sendVersions(peer);
            retryMissing();
          });
        }
        return;
      }
      if (msg.t === "ah") {
        // a local link whose other end started again (a reloaded page, the sync restarted): this end starts again with it
        if (peer.local && peer.auth && peer.auth.theirs && msg.e !== peer.auth.theirs) { peer.member = undefined; startAuth(peer); }
        return onAuthKey(peer, msg.e);
      }
      if (MEMBER_ONLY.has(msg.t) && !(await fromMember(peer, msg))) return;
      if (CHAPTER_TALK.has(msg.t) && !(await allowed(peer))) return; // (not a device of this library: nothing of the chapters)
      if (msg.t === "ver" && Array.isArray(msg.v)) {
        for (const row of msg.v) {
          if (Array.isArray(row) && validKey(row[0]) && Number.isFinite(row[1])) peer.remoteVersions[row[0]] = row[1];
        }
        if (msg.last) compareVersions(peer);
      } else if (msg.t === "need" && Array.isArray(msg.k)) {
        sendEntries(peer, msg.k.filter(validKey).slice(0, 500));
      } else if (msg.t === "ent" && Array.isArray(msg.e)) {
        const changed = [];
        for (const m of msg.e) {
          if (!validMeta(m) || skip(m.key)) continue;
          const local = index[m.key];
          if (local && local.savedAt >= m.savedAt) continue;
          index[m.key] = {
            infohash: m.infohash,
            savedAt: m.savedAt,
            novelName: m.novelName ? String(m.novelName) : "",
            pageTitle: m.pageTitle ? String(m.pageTitle) : "",
            model: m.model || null,
            size: Number(m.size) || 0
          };
          changed.push(m.key);
          if (!onDemand || wanted.has(m.key)) enqueueFetch(m.key);
        }
        if (changed.length) {
          // on demand: a newer version of a chapter this device holds is fetched too (looked up all at once, shortly)
          if (onDemand) { clearTimeout(retrySoon); retrySoon = setTimeout(retryMissing, 2000); }
          schedulePersist(changed);
          broadcastEntries(changed, peer); // gossip onward
          onChange({ type: "index", keys: changed });
        }
      } else if (msg.t === "hi") {
        peer.info = { role: String(msg.r || "device").slice(0, 20), v: Math.max(0, Math.floor(Number(msg.v) || 0)), id: String(msg.i || "").slice(0, 40), b: Math.max(0, Math.floor(Number(msg.b) || 0)) };
        if (peer.auth && peer.info.v < 9) peer.auth.setKey(null); // (from before devices proved who they are)
      } else if (msg.t === "get" && validKey(msg.k)) {
        await sendDirect(peer, msg.k);
      } else if (msg.t === "blob" && validKey(msg.k)) {
        await receiveDirect(msg);
      } else if (msg.t === "raw" && validKey(msg.k) && opts.onRawRequest) {
        // A device that cannot reach the source site (the phone reader) asks one that can (the extension) to download a chapter's original text.
        // The answer is the chapter arriving like any other; a failure is reported back so the asker can show why nothing came.
        // remote: asked by another device (not this browser's own tab, a local link). What is not done for another device is declined ("rs",
        // "declined", to the asker alone: another device may be doing it); decline(why) says so for a part of it (its translation).
        const decline = (why) => say(peer, { t: "rs", k: msg.k, s: "declined", e: String(why || "").slice(0, 300) });
        Promise.resolve()
          .then(() => opts.onRawRequest(msg.k, { remote: !peer.local, novelName: String(msg.n || "").slice(0, 300), pageTitle: String(msg.p || "").slice(0, 300), translate: !!msg.tr, source: String(msg.s || "").slice(0, 100), ahead: Math.max(0, Math.min(10, Number(msg.a) || 0)), findNext: !!msg.f, force: !!msg.x, retranslate: !!msg.rt, wtrRawId: /^\d{1,12}$/.test(String(msg.w || "")) ? String(msg.w) : "",
            // lang: the language to translate it into (a code), when it is not the one the library says
            lang: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(msg.l || "")) ? String(msg.l) : "",
            // notes: how many chapters from this one (it, and the ones asked for ahead of it) get Gemini's notes on terms; none said: the library-wide switch decides
            ...(Number.isFinite(msg.nt) ? { notes: Math.max(0, Math.min(11, Math.floor(msg.nt))) } : {}),
            // custom: the reader's Custom prompt, for this one request: the prompt (instead of the one in use) and what is sent with it
            ...(msg.cp && typeof msg.cp === "object" && typeof msg.cp.p === "string" && msg.cp.p.trim() ? { custom: { prompt: msg.cp.p.slice(0, 8000), notes: !!msg.cp.n, glossary: msg.cp.g !== false, replace: !!msg.cp.e } } : {}) }, { decline }))
          .catch((e) => (e && e.declined ? decline(e.message) : say(peer, { t: "rawfail", k: msg.k, e: String((e && e.message) || e).slice(0, 300) })));
      } else if (msg.t === "rs" && validKey(msg.k) && opts.onRawStatus) {
        // on demand: a chapter this device asked a device with the extension for (requestRaw) is wanted once that one has it, whichever address it is kept
        // under (the one asked, or the source site's own, said in "u"), though nothing opened it by its own key. Asked for its original text alone
        // (translate: false, a novel this page translates with a profile), the original text is wanted too.
        if (msg.s === "done" && rawAsks.has(msg.k)) {
          const original = rawAsks.get(msg.k);
          rawAsks.delete(msg.k);
          const own = [msg.k.replace(/#original$/, ""), /^https:\/\//.test(String(msg.u || "")) ? "translation:" + String(msg.u).slice(0, 600) : "", original ? msg.k : ""].filter((k) => k && validKey(k));
          for (const k of own) { if (onDemand) wanted.add(k); enqueueFetch(k, true); }
        }
        opts.onRawStatus(msg.k, String(msg.s || "").slice(0, 30), { pageTitle: String(msg.p || "").slice(0, 300), error: String(msg.e || "").slice(0, 300), url: /^https:\/\//.test(String(msg.u || "")) ? String(msg.u).slice(0, 600) : "", note: String(msg.n || "").slice(0, 120) });
      } else if (msg.t === "rawfail" && validKey(msg.k) && opts.onRawFail) {
        opts.onRawFail(msg.k, String(msg.e || "").slice(0, 300));
      } else if (msg.t === "rawstop" && validKey(msg.k) && opts.onRawStop) {
        opts.onRawStop(msg.k); // the device that asked no longer wants it (a long chapter list, stopped part way)
      } else if (msg.t === "aq" && typeof msg.id === "string" && msg.id.length <= 40 && typeof msg.iv === "string" && typeof msg.d === "string" && msg.d.length < 8000) {
        await answerApi(peer, msg);
      } else if (msg.t === "ar" && typeof msg.id === "string") {
        await receiveApi(peer, msg);
      } else if (lib) {
        await onLibraryMessage(peer, msg);
      }
    }

    async function onLibraryMessage(peer, msg) {
      const rows = (v) => (Array.isArray(v) ? v : []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && r[0].length <= 600 && Array.isArray(r[1]));
      if ((msg.t === "lv" || msg.t === "lh") && typeof msg.l === "string") {
        if (msg.l !== (await lib.lib())) return; // another library's devices (or this one is not in one yet)
        if (msg.t === "lv") {
          peer.recVersions = (peer.recVersions || []).concat(rows(msg.v));
          if (!msg.last) return;
        }
        const list = msg.t === "lv" ? peer.recVersions : rows(msg.v);
        if (msg.t === "lv") peer.recVersions = [];
        let want = [];
        if (lib.wantsMany) want = rows(await lib.wantsMany(list));
        else for (const [k, v] of list) if (await lib.wants(k, v)) want.push([k, v]);
        if (want.length) await askRecords(peer, want);
        // (from the other end of a local link keeping this very library: the ones this side has too were written there, and this side's room
        // has not heard of them; the others ask this device for them)
        if (msg.t === "lh" && peer.local && peer.sameLibrary && peer.sameLibrary()) {
          const asked = new Set(want.map((r) => r[0]));
          const known = list.filter((r) => !asked.has(r[0]));
          if (known.length) for (const p of usablePeers()) if (p !== peer && p.ready) p.send({ t: "lh", l: msg.l, v: known });
        }
      } else if (msg.t === "lvq") {
        await sendRecordVersions(peer);
      } else if (msg.t === "lq" && Array.isArray(msg.k)) {
        if (!(await lib.lib())) return;
        queueRecords(peer, msg.k.filter((k) => typeof k === "string" && k.length <= 600).slice(0, 300));
      } else if (msg.t === "lr" && typeof msg.k === "string") {
        await receiveRecordPiece(peer, msg);
      } else if (msg.t === "jn" && typeof msg.id === "string" && msg.id.length <= 40) {
        // Kept by the main device; any other device passes it on (once a while), so it reaches the main device through them.
        if (await lib.joinAsked(msg)) return;
        const seenKey = msg.id + "@" + Math.floor(Date.now() / JOIN_EVERY_MS);
        if (joinsSeen.has(seenKey)) return;
        joinsSeen.add(seenKey);
        if (joinsSeen.size > 200) joinsSeen.delete(joinsSeen.values().next().value);
        for (const p of usablePeers()) if (p !== peer && p.ready) p.send(msg);
      } else if (msg.t === "lx" && typeof msg.id === "string" && msg.id.length <= 40 && Number.isFinite(msg.at)) {
        // A device leaving the library (signed by it): the main device takes it off the list; any other device passes it on, once.
        if (lib.leaving && (await lib.leaving(msg))) return;
        const seenKey = "lx:" + msg.id + "@" + msg.at;
        if (joinsSeen.has(seenKey)) return;
        joinsSeen.add(seenKey);
        for (const p of usablePeers()) if (p !== peer && p.ready) p.send(msg);
      } else if (msg.t === "jk" && typeof msg.epk === "string" && typeof msg.to === "string") {
        if (keysSeen.has(msg.epk)) return;
        keysSeen.add(msg.epk);
        if (await lib.receiveKeys(msg)) {
          onChange({ type: "joined" });
          libraryChanged(); // (a device of the library now)
          return;
        }
        for (const p of usablePeers()) if (p !== peer && p.ready) p.send(msg); // not for this device: passed on
      }
    }

    // ---------- publishing ----------
    async function publishLocal(key, entry) {
      const clean = sanitize(key, entry);
      if (!clean) throw new Error("not a valid document: " + key);
      const bytes = encodeChapter(key, entry);
      const meta = {
        infohash: await chapterId(bytes),
        savedAt: clean.savedAt,
        ...describe(key, clean),
        size: bytes.length
      };
      const existing = index[key];
      const changed = !existing || existing.infohash !== meta.infohash || existing.savedAt !== meta.savedAt;
      if (changed && (!existing || existing.savedAt <= meta.savedAt)) {
        index[key] = meta;
        schedulePersist([key]);
        stats.published++;
        broadcastEntries([key]);
        onChange({ type: "index", keys: [key] });
      }
    }

    // These chapters are no longer here (their novel was deleted from this device): off the index, so they are not offered to devices or fetched
    // again (skip keeps them out when a device lists them). Their texts are the adapter's to delete.
    function forget(keys) {
      for (const k of keys || []) {
        delete index[k];
        wanted.delete(k);
        unanswered.delete(k);
      }
      schedulePersist(keys);
    }

    async function onLocalSave(key, entry) {
      if (stopped || !hasContent(key, entry)) return;
      const known = index[key];
      if (known && known.savedAt >= (entry.savedAt || 0)) return;
      try {
        await publishLocal(key, entry);
      } catch (e) {
        stats.errors++;
        log("publish failed", key, e);
      }
    }

    // ---------- direct transfer (over the room connection) ----------
    function track(key, part) {
      const t = transfers.get(key) || {};
      t[part] = { since: Date.now() };
      transfers.set(key, t);
    }

    function untrack(key, part) {
      const t = transfers.get(key);
      if (!t) return;
      delete t[part];
      if (!t.direct) transfers.delete(key);
    }

    // Asks every connected device for this chapter's text. Safe to call often: it asks again only after DIRECT_REASK_MS, and a version nobody
    // answered for less and less often (reaskAfter), unless `now` (a person opened it). It is shown as on its way once its text starts to come
    // (receiveDirect), not while nobody answers.
    function askDirect(key, force) {
      if (stopped || !index[key]) return;
      const now = Date.now();
      if (now - (directAsked.get(key) || 0) < DIRECT_REASK_MS) return;
      const u = unanswered.get(key);
      if (u && u.ver !== index[key].savedAt) unanswered.delete(key); // (a newer version: maybe a device has that one)
      else if (u && !force && now - u.at < reaskAfter(u.n)) return;
      let asked = false;
      for (const p of memberPeers()) {
        if (!p.ready) continue;
        p.send({ t: "get", k: key });
        asked = true;
      }
      if (!asked) return;
      directAsked.set(key, now);
      unanswered.set(key, { n: (u && u.ver === index[key].savedAt ? u.n : 0) + 1, at: now, ver: index[key].savedAt });
    }

    async function sendDirect(peer, key) {
      const local = await adapter.getTranslation(key);
      const clean = hasContent(key, local) && sanitize(key, local);
      if (!clean) return;
      const bytes = encodeChapter(key, local);
      if (bytes.length > MAX_CHAPTER_BYTES) return;
      const n = Math.ceil(bytes.length / DIRECT_CHUNK);
      for (let i = 0; i < n; i++) {
        peer.send({ t: "blob", k: key, s: clean.savedAt, i, n, d: toB64(bytes.subarray(i * DIRECT_CHUNK, (i + 1) * DIRECT_CHUNK)) });
      }
    }

    async function receiveDirect(msg) {
      const key = msg.k;
      if (!directAsked.has(key)) return; // only what we asked for
      const maxPieces = Math.ceil(MAX_CHAPTER_BYTES / DIRECT_CHUNK);
      if (!Number.isInteger(msg.i) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > maxPieces || msg.i < 0 || msg.i >= msg.n || typeof msg.d !== "string") return;
      let a = assemblies.get(key);
      if (!a || a.id !== msg.s || a.n !== msg.n) {
        if (assemblies.size >= MAX_ASSEMBLIES) assemblies.delete(assemblies.keys().next().value);
        a = { id: msg.s, n: msg.n, parts: new Array(msg.n), got: 0 };
        assemblies.set(key, a);
      }
      if (a.parts[msg.i]) return;
      let piece;
      try {
        piece = fromB64(msg.d);
      } catch (e) {
        return;
      }
      if (piece.length > DIRECT_CHUNK) return;
      a.parts[msg.i] = piece;
      if (++a.got < a.n) return;
      assemblies.delete(key);
      const bytes = new Uint8Array(a.parts.reduce((sum, x) => sum + x.length, 0));
      let at = 0;
      for (const x of a.parts) {
        bytes.set(x, at);
        at += x.length;
      }
      let payload;
      try {
        payload = JSON.parse(dec.decode(bytes));
      } catch (e) {
        return;
      }
      const refused = () => untrack(key, "direct"); // (not the version asked for: it is not on its way)
      if (!payload || payload.key !== key) return refused();
      const entry = sanitize(key, payload.entry);
      const meta = index[key];
      if (!entry || !entry.translated || !meta || entry.savedAt < meta.savedAt) return refused();
      if ((await chapterId(bytes)) !== meta.infohash) return refused(); // only the text its index entry names (anyone in the room can answer "get")
      const have = await adapter.getTranslation(key);
      if (have && have.savedAt >= entry.savedAt) return refused();
      await adapter.setTranslation(key, entry);
      directAsked.delete(key);
      unanswered.delete(key);
      untrack(key, "direct");
      stats.fetched++;
      stats.direct++;
      onChange({ type: "chapter", key });
    }

    // ---------- fetching ----------
    function enqueueFetch(key, force) {
      if (stopped) return;
      askDirect(key, force);
    }

    function retryMissing() {
      if (stopped) return;
      adapter
        .listTranslations()
        .then((rows) => {
          const have = new Map(rows.map(([k, e]) => [k, e && e.savedAt]));
          for (const k of Object.keys(index)) {
            if (have.get(k) >= index[k].savedAt) { wanted.delete(k); continue; }
            if (!onDemand || wanted.has(k) || have.has(k)) enqueueFetch(k); // (on demand: asked for, or an older copy is here)
          }
        })
        .catch(() => {});
    }

    // ---------- lifecycle ----------
    async function reconcileLocal() {
      const rows = await adapter.listTranslations();
      rows.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
      for (const [key, light] of rows) {
        if (stopped) return;
        if (!validKey(key) || !light || !light.translated || skip(key)) continue;
        const known = index[key];
        if (known && known.savedAt >= light.savedAt) continue; // (indexed already: nothing to do for it)
        const entry = await adapter.getTranslation(key);
        if (hasContent(key, entry)) await publishLocal(key, entry).catch((e) => log("publish failed", key, e));
      }
      retryMissing();
    }

    async function start() {
      stop();
      cfg = (await adapter.getConfig()) || {};
      if (!cfg.enabled || (!cfg.passphrase && !opts.localOnly)) return false;
      stopped = false;
      trackers = cfg.trackers && cfg.trackers.length ? cfg.trackers : DEFAULT_TRACKERS;
      onDemand = cfg.fetch === "open";
      index = (await adapter.getIndex()) || {};
      // No passphrase: no room on the network, but the links to devices on this computer still work (the library site's tab and this
      // browser's extension: their own library, which needs no passphrase between them).
      if (!cfg.passphrase) {
        retryTimer = setInterval(() => { retryMissing(); syncLibrary(); }, RETRY_INTERVAL_MS);
        for (const l of locals) attachLocal(l);
        reconcileLocal().catch((e) => log("reconcile failed", e));
        return true;
      }
      client = new WebTorrent({ dht: false, lsd: false, utp: false, tracker: opts.rtcConfig ? { rtcConfig: opts.rtcConfig } : {} });
      client.on("error", (e) => log("client error", e && e.message));

      roomId = await sha256Hex("p2p-read:v1:" + cfg.passphrase);
      apiKey = null; // (the passphrase may have changed)
      opts.__onTorrentCreated = (t) => {
        if (!roomTorrent) {
          roomTorrent = t;
          t.on("wire", attachWire);
        }
      };
      await seedBytes(enc.encode(roomId), "room-" + roomId.slice(0, 16), { keep: true });
      opts.__onTorrentCreated = null;
      offerOnlyWhenNeeded(roomTorrent);
      roomTorrent.wires.forEach(attachWire);

      retryTimer = setInterval(() => { retryMissing(); syncLibrary(); }, RETRY_INTERVAL_MS);
      if (lib) joinTimer = setInterval(() => askToJoin().catch(() => {}), JOIN_EVERY_MS);
      for (const l of locals) attachLocal(l); // links to devices on this computer survive a restart of the network side
      clearInterval(kickTimer);
      kickTimer = setInterval(kickTrackers, opts.kickMs || KICK_MS);
      reconcileLocal().catch((e) => log("reconcile failed", e));
      return true;
    }

    function stop() {
      stopped = true;
      clearInterval(retryTimer);
      clearInterval(joinTimer);
      clearInterval(kickTimer);
      clearTimeout(persistTimer);
      clearTimeout(retrySoon);
      if (client) {
        try {
          client.destroy();
        } catch (e) {
          // ignore
        }
      }
      client = null;
      roomTorrent = null;
      peers.clear();
      for (const l of locals) l.peer = null;
      seeded.clear();
    }

    // What is moving right now, for the activity view: each chapter being fetched, plus totals.
    // The chapters asked for that have not come yet (one nobody answered for 30 s is dropped: the next ask starts a new one).
    function inFlight() {
      const now = Date.now();
      for (const [key, t] of transfers) if (t.direct && now - t.direct.since > 30000) untrack(key, "direct");
      return transfers;
    }

    function activity() {
      const now = Date.now();
      const rows = [...inFlight()].map(([key, t]) => ({ key, direct: { ms: now - t.direct.since } }));
      return {
        rows,
        roomPeers: roomTorrent ? roomTorrent.numPeers : 0,
        down: client ? client.downloadSpeed : 0,
        up: client ? client.uploadSpeed : 0,
        direct: stats.direct
      };
    }

    // Two devices find each other because both are connected to the same tracker at the same time. When a tracker connection drops
    // (a laptop waking from sleep, a network change, the tracker restarting) the library waits before it reconnects: a random 0-5 minutes
    // plus a delay that doubles with every failed try. Without peers that wait is pure dead time, so while there are none, any tracker
    // connection that is waiting to reconnect is reconnected now, and the room is announced again now and then.
    // (This reaches into the tracker client of the pinned WebTorrent 1.9.7; if that ever changes, the try/catch makes it a no-op.)
    // Announce the room now (a relay was just switched on: the next offers carry its addresses, so a device that could not be reached
    // before can be now).
    function announceNow() {
      if (stopped || !roomTorrent || !roomTorrent.discovery || !roomTorrent.discovery.tracker) return;
      lastAnnounce = Date.now();
      try { roomTorrent.discovery.tracker.update(); } catch (e) { log("announce failed", e && e.message); }
    }

    function kickTrackers() {
      if (stopped || !roomTorrent || usablePeers().length > 0) return;
      try {
        const now = Date.now();
        const gap = (opts.kickMs || KICK_MS) * 3; // one tracker is not hammered: at most once per three ticks
        const list = (roomTorrent.discovery && roomTorrent.discovery.tracker && roomTorrent.discovery.tracker._trackers) || [];
        let kicked = false;
        for (const t of list) {
          if (!t || !t.reconnecting || typeof t._openSocket !== "function" || now - (lastKick.get(t) || 0) < gap) continue;
          lastKick.set(t, now);
          clearTimeout(t.reconnectTimer);
          t.retries = 0;
          t._openSocket();
          kicked = true;
          stats.kicks++;
        }
        // connected but still alone: announce again, so peers that arrived since hear about us (the tracker passes our offers on at once)
        if (!kicked && now - lastAnnounce > gap * 2 && roomTorrent.discovery && roomTorrent.discovery.tracker) {
          lastAnnounce = now;
          roomTorrent.discovery.tracker.update();
        }
      } catch (e) {
        log("tracker kick failed", e && e.message);
      }
    }
    let lastAnnounce = 0;

    function status() {
      return {
        running: !stopped,
        network: !!roomTorrent, // (false with no passphrase: only the links on this computer)
        peers: memberPeers().length, // (devices of this library; others: in the room, not proved to be)
        others: usablePeers().filter((p) => !memberPeers().includes(p)).length,
        roomPeers: roomTorrent ? roomTorrent.numPeers : 0,
        indexed: Object.keys(index).length,
        queued: inFlight().size, // chapters asked for that have not come yet
        fetch: onDemand ? "open" : "all",
        protocol: PROTOCOL,
        // the devices connected right now: what each says it is, or "unknown" for a build from before devices introduced themselves
        devices: memberPeers().map((p) => ({ ...(p.info || { role: "unknown", v: 0 }), via: p.local ? "local" : "network" })),
        stats
      };
    }

    return {
      start,
      stop,
      status,
      onLocalSave,
      forget,
      resync,
      getIndex: () => index,
      addLocalPeer,
      id: ownId,
      request: (key) => { if (onDemand && validKey(key)) wanted.add(key); enqueueFetch(key, true); }, // (a person opened it, or reads ahead: asked at once)
      // "all" or "open" (see getConfig): which chapters this device fetches, changed without restarting
      setFetch: (mode) => { onDemand = mode === "open"; if (!onDemand) retryMissing(); },
      // Tells the connected devices how a chapter's original text is coming along (downloading, translating, done, failed).
      announceRaw: (key, state, info = {}) => {
        for (const p of memberPeers()) say(p, { t: "rs", k: key, s: state, p: info.pageTitle || "", e: info.error || "", u: info.url || "", n: info.note || "" });
      },
      queuedKeys: () => [...inFlight().keys()],
      // the library: records this device wrote, the main device's answer to a device asking to join, and asking everyone again
      announceRecords: (records) => announceRecords(records).catch((e) => log("announce failed", e)),
      sendKeys,
      sayLeaving,
      syncLibrary,
      libraryChanged,
      askToJoin: () => askToJoin().catch(() => {}),
      _kick: kickTrackers, // for tests
      announceNow,
      activity,
      // Asks the connected devices that can fetch from the source site to save this chapter's original text. Returns how many were asked.
      requestRaw: (key, meta = {}) => {
        let asked = 0;
        if (!meta.findNext && !String(key).endsWith("#notes") && !String(key).endsWith("#details") && !String(key).endsWith("#list")) {
          rawAsks.delete(key); // (asked again: kept as the newest, with what this ask wants)
          rawAsks.set(key, meta.translate === false && String(key).endsWith("#original")); // (not said: a site chapter read from its source, kept under its own key)
          if (rawAsks.size > 200) rawAsks.delete(rawAsks.keys().next().value);
        }
        for (const p of memberPeers()) {
          if (!p.ready) continue;
          say(p, { t: "raw", k: key, n: meta.novelName || "", p: meta.pageTitle || "", tr: !!meta.translate, s: meta.source || "", a: meta.ahead || 0, f: !!meta.findNext, x: !!meta.force, rt: !!meta.retranslate, w: meta.wtrRawId || "", ...(meta.lang ? { l: String(meta.lang) } : {}), ...(Number.isFinite(meta.notes) ? { nt: meta.notes } : {}), ...(meta.custom ? { cp: { p: String(meta.custom.prompt || ""), n: !!meta.custom.notes, g: meta.custom.glossary !== false, e: !!meta.custom.replace } } : {}) });
          asked++;
        }
        return asked;
      },
      // Tells them to stop working on something asked for with requestRaw (a chapter list being read page after page). Returns how many were told.
      // A read-only /api/... call answered by a device of the library (for a device not in it): resolves with what the call answers.
      askApi,
      // Is a device that could answer it connected?
      canAskApi: () => apiPeers().length > 0,
      stopRaw: (key) => {
        let told = 0;
        for (const p of memberPeers()) {
          if (!p.ready) continue;
          say(p, { t: "rawstop", k: key });
          told++;
        }
        return told;
      },
      _internals: { sha256Hex, stable }
    };
  }

  root.P2PCore = { createP2P, DEFAULT_TRACKERS, KEY_PREFIX, langOf, baseKeyOf, langKey, kindOf, offerOnlyWhenNeeded, setConnectionTarget, bucketedIndex, INDEX_BUCKETS, reaskAfter };
})(typeof globalThis !== "undefined" ? globalThis : this);
