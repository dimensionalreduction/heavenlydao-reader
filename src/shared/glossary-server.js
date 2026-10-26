// Your library's client in the background script: the popup, the in-page translator and the scripts on the site and the source sites reach the
// library through it (runtime messages). Every call is answered by your library (library-host.js: Firefox's background page holds it, Chrome's
// offscreen page over a message), which the extension is in before it does anything at all. (The name is from when a glossary server answered.)
//
// It keeps a read cache in storage.local, so translating keeps working while the library cannot be asked (Chrome's offscreen page starting):
//   glossaryLibrary   { [id]: { id, name, site, rawId, slug, updatedAt, terms: [[source, english, origin], ...] } }
//   glossaryBindings  { [novelKey]: { ids: [id], updatedAt } }
//   glossaryRev       the library's revision this cache is current to (sync is incremental from there)
//   myTerms           [{ id, from, to, cs, novel, keys }]   the terms you picked in the library's reader (/api/my-terms), read whole on each sync
var GlossaryServer = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  let inflight = null;

  // A call answered by the library: here (Firefox's background page keeps it) or in Chrome's offscreen page. Every call is safe to repeat (imports,
  // edits and bindings are idempotent), so a library that did not answer (the offscreen page was just starting) is asked once more.
  async function request(method, path, body) {
    try {
      return await viaLibrary(method, path, body);
    } catch (e) {
      if (!e.network) throw e;
      return viaLibrary(method, path, body);
    }
  }
  async function viaLibrary(method, path, body) {
    if (typeof LibraryHost !== "undefined") return LibraryHost.call("api", [method, path, body]);
    if (api.wake) await api.wake().catch(() => {});
    const r = await ext.runtime.sendMessage({ target: "lib", op: "api", args: [method, path, body] }).catch(() => null);
    if (!r) throw Object.assign(new Error("the library did not answer"), { network: true });
    if (r.error) throw new Error(r.error);
    return r.result;
  }

  const toCacheRecord = (g) => ({ id: g.id, name: g.name, site: g.site, rawId: g.rawId, slug: g.slug, updatedAt: g.updatedAt, terms: g.terms });

  // One sync pass. Never throws: returns { ok, error? }.
  async function syncOnce() {
      try {
        const store = await ext.storage.local.get(["glossaryLibrary", "glossaryBindings", "glossaryRev"]);
        const firstSync = store.glossaryRev === undefined;
        let since = Number(store.glossaryRev) || 0;
        let library = Object.assign({}, store.glossaryLibrary || {});
        let bindings = Object.assign({}, store.glossaryBindings || {});

        let data = await request("GET", "/api/sync?since=" + since);
        // Local copies that may need uploading: everything we have, on the first sync, or when the library has fewer changes than
        // we've seen (it was made again).
        let uploadFrom = null;
        if (firstSync) uploadFrom = { library: Object.assign({}, library), bindings: Object.assign({}, bindings) };
        if (data.rev < since) {
          uploadFrom = { library: Object.assign({}, library), bindings: Object.assign({}, bindings) };
          library = {};
          bindings = {};
          since = 0;
          data = await request("GET", "/api/sync?since=0");
        }
        const syncedIds = new Set();
        for (const g of data.glossaries) {
          library[g.id] = toCacheRecord(g);
          syncedIds.add(g.id);
        }
        for (const id of data.removed) delete library[id];
        for (const b of data.bindings) bindings[b.key] = { ids: b.ids, updatedAt: b.rev };

        // Anything only we have goes up to the library instead of being lost.
        let uploaded = 0;
        if (uploadFrom) {
          const listing = await request("GET", "/api/glossaries");
          const known = new Set([...syncedIds, ...listing.glossaries.map((g) => g.id)]);
          for (const g of Object.values(uploadFrom.library)) {
            if (known.has(g.id) || !Array.isArray(g.terms) || !g.terms.length) continue;
            await request("POST", "/api/glossaries/" + encodeURIComponent(g.id) + "/import", {
              name: g.name, site: g.site, rawId: g.rawId, slug: g.slug, terms: g.terms.map((t) => [t[0], t[1], t[3] && t[3].o ? { o: t[3].o } : undefined])
            });
            uploaded++;
          }
          const libraryBindings = await request("GET", "/api/bindings");
          const haveKeys = new Set(libraryBindings.bindings.map((b) => b.key));
          for (const [key, b] of Object.entries(uploadFrom.bindings)) {
            const ids = Array.isArray(b) ? b : b && b.ids;
            if (haveKeys.has(key) || !Array.isArray(ids) || !ids.length) continue;
            await request("PUT", "/api/bindings", { key, ids });
            uploaded++;
          }
        }
        await ext.storage.local.set({ glossaryLibrary: library, glossaryBindings: bindings, glossaryRev: data.rev });
        // Your terms from the library's reader: a short list, read whole (when they cannot be read, the copy here is kept).
        try {
          const mine = await request("GET", "/api/my-terms");
          if (Array.isArray(mine.terms)) await ext.storage.local.set({ myTerms: mine.terms });
        } catch (e) {
          // keep the copy we have
        }
        if (uploaded) return syncOnce(); // pick up what we just uploaded (and the revision the library gave it)
        return { ok: true, rev: data.rev };
      } catch (e) {
        return { ok: false, error: e.message };
      }
  }

  // Brings the local cache up to date. One sync at a time: concurrent callers share the running one.
  function pull() {
    if (!inflight) {
      inflight = Promise.all([syncOnce(), settings(true)]).then(([result]) => result).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  // Sends a site glossary snapshot to the library, then refreshes the cache. The library decides what changed.
  async function importSnapshot(record) {
    try {
      const result = await request("POST", "/api/glossaries/" + encodeURIComponent(record.id) + "/import", {
        name: record.name, site: record.site, rawId: record.rawId, slug: record.slug, terms: record.terms, keepYours: record.keepYours === true
      });
      await pull();
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // The person's own English fixes from the site (wtr-terms.js personalReplacements) as the terms of the library's reader (/api/my-terms), shown after the
  // translation. `rawId` and `novel` (its title): which novel the ones that are not for every novel are for. They are marked src "wtr": the ones the
  // library has so from an earlier read that the site no longer has are removed, the rest follow the site. A term the person changed on the site is theirs
  // (no mark any more) and is left alone, and one they deleted stays deleted. Never throws: { ok, error? }.
  async function syncPersonalReplacements(rawId, novel, terms) {
    try {
      const key = "wtr-lab:" + rawId;
      const read = await request("GET", "/api/my-terms");
      const all = read.terms || [];
      const gone = new Set(read.gone || []);
      const byId = new Map(all.map((t) => [t.id, t]));
      const wanted = new Set(terms.map((t) => t.id));
      for (const t of all) if (t.src === "wtr" && !wanted.has(t.id) && (!(t.keys && t.keys.length) || t.keys.includes(key))) await request("DELETE", "/api/my-terms/" + encodeURIComponent(t.id));
      for (const t of terms) {
        const cur = byId.get(t.id);
        if (gone.has(t.id) || (cur && cur.src !== "wtr")) continue; // (deleted here, or changed here: the person's now)
        await request("PUT", "/api/my-terms/" + encodeURIComponent(t.id), { from: t.from, to: t.to, cs: t.cs, novel: t.global ? "" : novel, keys: t.global ? [] : [key], src: "wtr" });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Usage counts for some terms: [[source, [[english, users], ...]], ...]. Resolves { ok, result? }; does not re-pull
  // (the caller sends many batches, then refreshes once).
  async function sendVotes(id, votes) {
    try {
      const result = await request("POST", "/api/glossaries/" + encodeURIComponent(id) + "/votes", { votes });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // A novel's full chapter list from a reader site (e.g. 69shuba's /book/<id>/ page), so the site can list every chapter.
  async function saveChapterIndex(record) {
    try {
      const result = await request("PUT", "/api/chapter-index", record);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Display info for a novel's page on the site (cover, synopsis, author, tags).
  async function saveNovel(info) {
    try {
      const result = await request("PUT", "/api/novels/" + encodeURIComponent(info.id), info);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // One novel's record, or null (the whole list is read: it is small, and the library has no call for one).
  async function getNovel(id) {
    try {
      const all = await request("GET", "/api/novels");
      return ((all && all.novels) || []).find((n) => n && n.id === id) || null;
    } catch (e) {
      return null;
    }
  }

  // ---- cover copies ----
  // The library keeps a copy of a novel's cover, so it shows even where the source site refuses to serve the picture to other sites. Always on (it
  // was a switch in the site's settings; a library that had it off copies covers again).
  async function copyCoversOn() {
    return true;
  }
  // The library's settings (Settings on the site), read at most once a minute and kept in between: how many requests a minute Gemini is sent (gemini.js
  // keeps to it, for everything this extension has Gemini do), how titles and details that are not in English are put into English (gemini.js
  // translateByMode), and the Gemini prompts the person changed. When the library cannot be reached what was known stays, asked for again in a minute.
  let settingsRead = { at: 0, s: null };
  async function settings(force) {
    if (!force && Date.now() - settingsRead.at < 60 * 1000) return settingsRead.s;
    try {
      settingsRead = { at: Date.now(), s: await request("GET", "/api/settings") };
      await mirrorPrompts(settingsRead.s);
      await mirrorModel(settingsRead.s);
    } catch (e) {
      settingsRead.at = Date.now();
    }
    return settingsRead.s;
  }
  // A copy of the prompts the person set in storage.local (geminiPromptSets: the setting promptSets; geminiPrompts: the older setting geminiPrompts), for
  // the popup to list and for when the library cannot be reached.
  let mirrored = null;
  async function mirrorPrompts(s) {
    const sets = (s && s.promptSets) || {};
    const legacy = (s && s.geminiPrompts) || {};
    const text = JSON.stringify([sets, legacy]);
    if (text === mirrored) return;
    mirrored = text;
    if (Object.keys(sets).length) await ext.storage.local.set({ geminiPromptSets: sets });
    else await ext.storage.local.remove("geminiPromptSets");
    if (Object.keys(legacy).length) await ext.storage.local.set({ geminiPrompts: legacy });
    else await ext.storage.local.remove("geminiPrompts");
  }
  // The model chapters are translated with is the library's setting geminiModel (the same on every device); the extension's own copy of it, storage.local.selectedModel
  // (what the popup's model list and every translation read), follows it whenever the library says one.
  async function mirrorModel(s) {
    const model = s && typeof s.geminiModel === "string" ? s.geminiModel : "";
    if (!model) return;
    const have = (await ext.storage.local.get("selectedModel")).selectedModel;
    if (have !== model) await ext.storage.local.set({ selectedModel: model });
  }
  // Sets it in the library (from the popup's model list), and here at once. Never throws: { ok, error? }.
  async function setGeminiModel(model) {
    try {
      await ext.storage.local.set({ selectedModel: model });
      await request("PUT", "/api/settings", { geminiModel: model });
      settingsRead.at = 0;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // 15 when the library has none or cannot be reached
  async function geminiRate() {
    const s = await settings();
    return s && Number.isFinite(s.geminiRate) ? s.geminiRate : 12;
  }
  // Google Translate when the library has none or cannot be reached
  async function titleMode() {
    const s = await settings();
    return (s && s.titleTranslate) || "google";
  }
  // The language chapters, titles and details are translated into (a code, gemini.js GEMINI_LANGUAGES): the library's setting; English when it has none or
  // cannot be reached
  async function targetLanguage() {
    const s = await settings();
    return (s && typeof s.targetLanguage === "string" && s.targetLanguage) || "en";
  }
  // The translation profiles (docs/PROFILES.md, profile-translate.js): { translateProfiles, translateProfile, novelProfiles } as the library has them; none when it
  // cannot be reached
  async function profileSettings() {
    const s = await settings();
    return { translateProfiles: (s && s.translateProfiles) || [], translateProfile: (s && s.translateProfile) || "", novelProfiles: (s && s.novelProfiles) || {} };
  }
  // The prompts the person set: { sets, legacy }, the library's promptSets (for each of translate, notes and detect, the prompt in use and the ones saved) and
  // its older geminiPrompts ({ translate?, notes?, detect? }: text); the last ones known when the library cannot be reached (gemini.js geminiPromptFrom picks)
  async function promptSettings() {
    const s = await settings();
    if (s) return { sets: s.promptSets || {}, legacy: s.geminiPrompts || {} };
    const kept = await ext.storage.local.get(["geminiPromptSets", "geminiPrompts"]);
    return { sets: kept.geminiPromptSets || {}, legacy: kept.geminiPrompts || {} };
  }
  const COVER_SEND_MAX = 700 * 1024; // the library takes 800 KB
  const COVER_KEEP = 300 * 1024; // a bigger picture is scaled down first

  // What a picture is, from its first bytes ("" when it is none the library keeps).
  async function pictureType(blob) {
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const text = (from, to) => String.fromCharCode(...b.slice(from, to));
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x89 && text(1, 4) === "PNG") return "image/png";
    if (text(0, 4) === "GIF8") return "image/gif";
    if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
    if (text(4, 8) === "ftyp" && /^avi[fs]$/.test(text(8, 12))) return "image/avif";
    return "";
  }

  // A big picture, scaled to at most 600 pixels high and kept as JPEG; one that cannot be scaled is returned as it is.
  async function shrink(blob) {
    if (blob.size <= COVER_KEEP) return blob;
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 600 / bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    } catch (e) {
      return blob;
    }
  }

  // Copies the cover of novel `id` to the library. `blob`: the picture, when a page that could fetch it has already done so; otherwise it is downloaded from
  // `coverUrl` (with the person's cookies). force: asked for now ("Refresh details"), whatever the setting says. Never throws: { ok, changed?, skipped?: "off", error? }.
  async function copyCover(id, coverUrl, blob, { force = false } = {}) {
    try {
      if (!force && !(await copyCoversOn())) return { ok: false, skipped: "off" };
      if (!blob) {
        if (!/^https:\/\//.test(coverUrl || "")) return { ok: false, error: "no cover address" };
        const res = await fetch(coverUrl, { credentials: "include" });
        if (!res.ok) throw new Error("the site answered HTTP " + res.status);
        blob = await res.blob();
      }
      const type = await pictureType(blob);
      if (!type) throw new Error("that is not a picture the library can keep (jpeg, png, webp, gif or avif)");
      blob = await shrink(blob.type === type ? blob : blob.slice(0, blob.size, type));
      if (blob.size > COVER_SEND_MAX) throw new Error("the picture is too large to copy");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); // (pictures cross the extension's messages as base64)
      const data = await request("PUT", "/api/covers/" + encodeURIComponent(id), { type: blob.type || type, bytesB64: btoa(bin) });
      return { ok: true, changed: !!data.changed };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async function setBinding(key, ids) {
    try {
      await request("PUT", "/api/bindings", { key, ids });
      await pull();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // New-chapter watches and notices (see watcher.js). These throw on failure: the scheduler records the failure itself.
  const listWatches = async () => (await request("GET", "/api/watches")).watches || [];
  const saveWatch = (w) => request("PUT", "/api/watches/" + encodeURIComponent(w.id), w);
  const addNotice = (n) => request("POST", "/api/notices", n);
  // chapter index records, throwing version (saveChapterIndex above reports instead)
  const putChapterIndex = (record) => request("PUT", "/api/chapter-index", record);

  // `api`: any other call of the library's (throws on failure), for what has no function of its own here
  // `wake` (Chrome): set by the service worker, to bring back the offscreen page that keeps the library
  const api = { api: request, pull, importSnapshot, sendVotes, saveNovel, getNovel, copyCover, copyCoversOn, syncPersonalReplacements, geminiRate, titleMode, targetLanguage, setGeminiModel, promptSettings, profileSettings, saveChapterIndex, setBinding, listWatches, saveWatch, addNotice, putChapterIndex };
  return api;
})();
