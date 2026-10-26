// Your library's rules: glossaries, novels, covers, chapter lists, your terms, term notes, ratings, watches and the rest, over one state object,
// answering /api/... calls. A library (library.js) keeps the state as signed records on your own devices and answers the extension's and the
// site's calls with it. (The calls and the state are those of the glossary server this replaced, so libraries made from one read the same.)
//
// createLibraryApi({ state, persist, covers }) -> { handle(method, path, body) }
//   state     the data (normalizeState makes a whole one from whatever was saved)
//   persist   called after every real change with what changed: { kind, id?, sources?, removed? } (see CHANGE KINDS below); a library
//             rewrites those records
//   covers    where cover pictures' bytes are kept: { save(id, bytes), read(id) -> bytes | null } (may be async)
//   handle    one call: method, path with its query ("/api/chapter-index?key=a,b"), and the body (JSON, or { type, bytes } for a cover);
//             answers JSON, or { type, bytes, hash } for a cover; an error carries .status (an HTTP status)
//
// CHANGE KINDS: glossary (its name and details, or deleted) · terms (glossary id, sources: the terms that changed) · binding · novel · cover ·
// settings · wtrLibrary · rating · note (removed: the note is gone) · myTerm (removed) · commentLink · commentIdentity · chapterIndex ·
// novelLinks · watch · notice (removed: ids dropped from the end of the list)
(function (root) {
  "use strict";
  const webcrypto = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : require("node:crypto").webcrypto;

  const MAX_TERMS = 50000;
  const MAX_STR = 500;
  const MAX_CHAPTERS = 10000;
  const MAX_COVER = 800 * 1024; // a cover is a small picture; the extension shrinks big ones before sending
  const COVER_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" }; // (no SVG: it can carry script)
  const WTR_NOVEL = /^wtr-lab:\d{1,12}$/;

  const latin1 = (b, from, to) => String.fromCharCode.apply(null, Array.from(b.subarray(from, to)));
  // Does the content look like the image type it claims? (Only what a browser can show as a picture, never something else served back as one.)
  function looksLike(type, b) {
    if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (type === "image/png") return b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x);
    if (type === "image/gif") return b.length > 6 && latin1(b, 0, 4) === "GIF8";
    if (type === "image/webp") return b.length > 12 && latin1(b, 0, 4) === "RIFF" && latin1(b, 8, 12) === "WEBP";
    if (type === "image/avif") return b.length > 12 && latin1(b, 4, 8) === "ftyp" && /^(avif|avis)$/.test(latin1(b, 8, 12));
    return false;
  }

  const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  const randomHex = (n) => hex(webcrypto.getRandomValues(new Uint8Array(n)));
  const sha256Hex = async (bytes) => hex(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)));

  // A whole state from whatever was saved (a data file from before some part existed has none of it). Parts this code does not know are kept.
  function normalizeState(saved) {
    const s = Object.assign({
      rev: 0, glossaries: {}, bindings: {}, novels: {}, covers: {}, chapterIndex: {}, watches: {}, notices: [], wtrLibrary: { importedAt: 0, novels: [] },
      myRatings: {}, myTerms: {}, termNotes: {}, commentLinks: {}, commentIdentity: { key: "", name: "" }, novelLinks: { merges: [], apart: [], hidden: [], updatedAt: 0 }
    }, saved || {});
    for (const k of ["glossaries", "bindings", "novels", "covers", "chapterIndex", "watches", "myRatings", "myTerms", "termNotes", "commentLinks"]) s[k] = s[k] || {};
    s.notices = s.notices || [];
    // (every switch is always in the answer, so a page can tell a server that knows it from one that does not)
    s.settings = Object.assign({ copyCovers: true, termNotesAi: false, poolHints: true, keepTerms: true, sharePool: false, titleTranslate: "google" }, s.settings);
    return s;
  }

  const countFor = (variants, text) => {
    const hit = (variants || []).find((x) => String(x[0]).toLowerCase() === String(text).toLowerCase());
    return hit ? hit[1] : 0;
  };

  const clean = (v, max = MAX_STR) => String(v == null ? "" : v).trim().slice(0, max);

  // Is a list read from address `a` the one of the book at `b`? The same address, or (a book's info page and its list page differ: /book/3903.htm,
  // /book/3903/) the same site and the same book number. (The site matches its cached lists the same way: ShareLists.sameBookUrl.)
  function sameBookUrl(a, b) {
    const bare = (u) => String(u || "").replace(/^https:\/\/www\./, "https://").replace(/\/+$/, "");
    if (bare(a) === bare(b)) return true;
    const part = (u) => { try { const x = new URL(u); return [x.hostname.replace(/^www\./, ""), (/\d{3,}/.exec(x.pathname) || [])[0]]; } catch (e) { return [null, null]; } };
    const [ha, na] = part(a);
    const [hb, nb] = part(b);
    return !!ha && ha === hb && !!na && na === nb;
  }

  function putProfiles(next, body) {
    // Translation profiles (docs/PROFILES.md), the settings' part of them: a model and a prompt saved in the playground, which the library's page translates chapters with.
    // Changes `next` (the settings) by what `body` says; the site's waiting copy (site/profiles.js) is kept by the same rules.
    // translateProfiles: the whole list ({ id, name, model, prompt, pay: "tickets" | "key" | "extension" (translated by the extension, with its own Gemini key), base: the provider's address, for a key; never the key });
    // (expressionProfiles below.) translateProfile: the library's default, one of their ids (blank or null: Gemini through the extension); novelProfiles: { <book>: <id> | "gemini" },
    // a novel's own choice (null: the library's default again). A choice whose profile is gone goes with it.
    // A list of profiles as it is kept: a bad one (short id, no model, a way to pay not in `pays`, a key with no address, the same id twice) is dropped.
    const cleanProfiles = (src, pays) => {
      const seen = new Set();
      return src
        .filter((p) => p && /^[A-Za-z0-9_-]{3,24}$/.test(String(p.id)) && typeof p.model === "string" && /^[A-Za-z0-9][\w.:/@+-]{0,119}$/.test(p.model.trim()) && pays.includes(p.pay) && !seen.has(String(p.id)) && seen.add(String(p.id)))
        .map((p) => ({ id: String(p.id), name: clean(p.name, 60) || "Profile", model: p.model.trim(), prompt: typeof p.prompt === "string" ? p.prompt.slice(0, 20000) : "", pay: p.pay, base: p.pay === "key" && typeof p.base === "string" && /^https?:\/\/[^\s"'<>]{3,200}$/.test(p.base.trim()) ? p.base.trim().replace(/\/+$/, "") : "", ...(["fish", "gemini", "openai"].includes(p.voice) ? { voice: p.voice } : {}) }))
        .filter((p) => p.pay !== "key" || p.base)
        .slice(0, 20);
    };
    if (Array.isArray(body.translateProfiles)) {
      const list = cleanProfiles(body.translateProfiles, ["tickets", "key", "extension"]);
      if (list.length) next.translateProfiles = list;
      else delete next.translateProfiles;
    }
    // expressionProfiles (Listen › Expression): the same fields, a model that writes the cues a voice acts out into the text before it is said (the prompt: blank is
    // the built-in one); paid with tickets or a key, never by the extension. voice (optional): the kind of voice the cues are for ("fish", "gemini", "openai"; none: any). Each browser picks the one it uses; there is no library default.
    if (Array.isArray(body.expressionProfiles)) {
      const list = cleanProfiles(body.expressionProfiles, ["tickets", "key"]);
      if (list.length) next.expressionProfiles = list;
      else delete next.expressionProfiles;
    }
    const profileIds = new Set((next.translateProfiles || []).map((p) => p.id));
    if (body.translateProfile === null || body.translateProfile === "") delete next.translateProfile;
    else if (typeof body.translateProfile === "string" && profileIds.has(body.translateProfile)) next.translateProfile = body.translateProfile;
    if (next.translateProfile && !profileIds.has(next.translateProfile)) delete next.translateProfile;
    if ((body.novelProfiles && typeof body.novelProfiles === "object") || next.novelProfiles) {
      const all = Object.assign({}, next.novelProfiles);
      for (const [book, v] of Object.entries((body.novelProfiles && typeof body.novelProfiles === "object" && body.novelProfiles) || {}).slice(0, 2000)) {
        const k = clean(book, 300);
        if (!k) continue;
        if (v === null || v === "") delete all[k];
        else if (v === "gemini" || profileIds.has(v)) all[k] = v;
      }
      for (const [k, v] of Object.entries(all)) if (v !== "gemini" && !profileIds.has(v)) delete all[k];
      if (Object.keys(all).length) next.novelProfiles = all;
      else delete next.novelProfiles;
    }
  }

  function httpError(status, message) {
    return Object.assign(new Error(message), { status });
  }

  function createLibraryApi({ state, persist, covers }) {
    const S = state;
    const now = () => Date.now();
    const bump = () => ++S.rev;
    const changed = (change) => persist(change);

    const liveTerms = (g) => Object.entries(g.terms).filter(([, v]) => !v.deleted);
    // the terms by the list they came from: novel, ai, shared (any of the site's shared glossaries), yours (typed or edited here), gemini, copied...
    const originOf = (v) => (v.src === "user" ? "yours" : String(v.o || "novel").startsWith("shared") ? "shared" : v.o || "novel");
    const summary = (g) => {
      const live = liveTerms(g);
      const origins = {};
      for (const [, v] of live) origins[originOf(v)] = (origins[originOf(v)] || 0) + 1;
      return {
        id: g.id, name: g.name, site: g.site, rawId: g.rawId, slug: g.slug,
        termCount: live.length, countedTerms: live.filter(([, v]) => v.n !== undefined).length, origins,
        createdAt: g.createdAt, updatedAt: g.updatedAt, rev: g.rev
      };
    };
    const termMeta = (v) => {
      const m = { o: v.o || "novel" };
      if (v.n !== undefined) m.n = v.n;
      if (v.v && v.v.length) m.v = v.v;
      return m;
    };
    const full = (g) => Object.assign(summary(g), { terms: liveTerms(g).map(([s, v]) => [s, v.t, v.src, termMeta(v)]) });

    function getOrCreate(id, meta) {
      let g = S.glossaries[id];
      if (!g || g.deleted) {
        const dropped = g ? Object.keys(g.terms) : []; // (a deleted glossary made again starts with no terms)
        g = S.glossaries[id] = {
          id, name: clean(meta.name, 200) || id, site: clean(meta.site, 50), rawId: clean(meta.rawId, 50), slug: clean(meta.slug, 200),
          createdAt: now(), updatedAt: now(), rev: bump(), terms: {}
        };
        if (dropped.length) changed({ kind: "terms", id, sources: dropped });
      }
      return g;
    }

    // ---- mutations (each returns a small summary and only bumps rev when something really changed) ----
    function importSnapshot(id, body) {
      if (!Array.isArray(body.terms) || body.terms.length > MAX_TERMS) throw httpError(400, "terms must be an array (max " + MAX_TERMS + ")");
      const incoming = new Map();
      for (const row of body.terms) {
        if (!Array.isArray(row)) continue;
        const s = clean(row[0]);
        const t = clean(row[1]);
        const o = clean(row[2] && typeof row[2] === "object" ? row[2].o : "", 60) || "novel";
        if (s && t && !incoming.has(s)) incoming.set(s, { t, o });
      }
      if (!incoming.size) throw httpError(400, "no valid terms in the import");

      const existed = S.glossaries[id] && !S.glossaries[id].deleted;
      const g = getOrCreate(id, body);
      const r = { added: 0, updated: 0, removed: 0, kept: 0 };
      let metaChanged = !existed;
      const touched = [];
      const touch = (s, term, t, o) => {
        term.t = t; term.w = t; term.src = "wtr"; term.o = o; term.updatedAt = now(); term.rev = S.rev + 1; delete term.deleted;
        delete term.v; delete term.n; // counts belonged to the old rendering; they are fetched again
        touched.push(s);
      };

      for (const [s, { t, o }] of incoming) {
        const cur = g.terms[s];
        if (!cur) { g.terms[s] = {}; touch(s, g.terms[s], t, o); r.added++; }
        else if (cur.src === "user") r.kept++; // yours: never overwritten, and a term you deleted stays deleted
        else if (cur.deleted) { touch(s, cur, t, o); r.added++; } // The site re-added what it had dropped
        else if ((cur.w !== undefined ? cur.w : cur.t) !== t) { touch(s, cur, t, o); r.updated++; } // The site changed its own value
        else if ((cur.o || "novel") !== o) { cur.o = o; cur.updatedAt = now(); cur.rev = S.rev + 1; touched.push(s); } // moved between lists
      }
      for (const [s, cur] of Object.entries(g.terms)) {
        // (keepYours: this import could not read the person's own terms on the site, so the ones the library has are not known to be gone)
        if (cur.src === "wtr" && !cur.deleted && !incoming.has(s) && !(body.keepYours === true && cur.o === "yours")) {
          cur.deleted = true; cur.updatedAt = now(); cur.rev = S.rev + 1; r.removed++; touched.push(s);
        }
      }
      for (const k of ["name", "site", "rawId", "slug"]) {
        const v = clean(body[k], k === "name" || k === "slug" ? 200 : 50);
        if (v && g[k] !== v) { g[k] = v; metaChanged = true; }
      }
      const any = metaChanged || touched.length > 0;
      if (any) {
        g.rev = bump(); g.updatedAt = now();
        changed({ kind: "glossary", id });
        if (touched.length) changed({ kind: "terms", id, sources: touched });
      }
      return Object.assign(r, { rev: S.rev, changed: any });
    }

    // Terms Gemini made for a language of its own (the glossary of one novel in one language, id "<glossary>@<language>"): added when the glossary has none
    // for that source yet, never over one that is there (one the person edited or deleted stays as it is). Created with the first.
    function addTerms(id, body) {
      if (!Array.isArray(body.terms) || body.terms.length > MAX_TERMS) throw httpError(400, "terms must be an array (max " + MAX_TERMS + ")");
      const rows = [];
      for (const row of body.terms) {
        if (!Array.isArray(row)) continue;
        const s = clean(row[0]);
        const t = clean(row[1]);
        // a term sent with a novel (from: "copied") keeps the list it was in (novel / ai / shared:<name>)
        const o = clean(typeof row[2] === "string" ? row[2] : row[2] && typeof row[2] === "object" ? row[2].o : "", 60);
        if (s && t) rows.push([s, t, o]);
      }
      if (!rows.length) return { added: 0, rev: S.rev, changed: false };
      const g = getOrCreate(id, body);
      const copied = body.from === "copied";
      const pooled = body.from === "pool"; // (terms the pool gave a novel, kept in it: see pool-hints.js)
      const touched = [];
      for (const [s, t, o] of rows) {
        if (g.terms[s]) continue;
        if (liveTerms(g).length >= MAX_TERMS) break;
        g.terms[s] = { t, src: copied ? "copied" : pooled ? "pool" : "gemini", o: copied ? o || "novel" : pooled ? "pool" : "gemini", updatedAt: now(), rev: S.rev + 1 };
        touched.push(s);
      }
      if (touched.length) {
        g.rev = bump(); g.updatedAt = now();
        changed({ kind: "glossary", id });
        changed({ kind: "terms", id, sources: touched });
      }
      return { added: touched.length, rev: S.rev, changed: touched.length > 0 };
    }

    function editTerms(id, body) {
      const g = S.glossaries[id];
      if (!g || g.deleted) throw httpError(404, "no such glossary");
      const r = { set: 0, removed: 0 };
      const touched = [];
      for (const row of Array.isArray(body.set) ? body.set : []) {
        if (!Array.isArray(row)) continue;
        const s = clean(row[0]);
        const t = clean(row[1]);
        if (!s || !t) continue;
        const cur = g.terms[s];
        if (cur && !cur.deleted && cur.t === t && cur.src === "user") continue;
        if (liveTerms(g).length >= MAX_TERMS && !cur) throw httpError(413, "glossary is full");
        const edited = { t, src: "user", o: (cur && cur.o) || "novel", updatedAt: now(), rev: S.rev + 1 };
        if (cur && cur.v) { edited.v = cur.v; edited.n = countFor(cur.v, t); } // keep the usage counts, re-read for the new wording
        g.terms[s] = edited;
        r.set++; touched.push(s);
      }
      for (const s of Array.isArray(body.remove) ? body.remove : []) {
        const key = clean(s);
        const cur = g.terms[key];
        if (cur && !cur.deleted) {
          // Becomes a "user" tombstone so a later the site import doesn't bring it back.
          g.terms[key] = { t: cur.t, src: "user", o: cur.o || "novel", deleted: true, updatedAt: now(), rev: S.rev + 1 };
          r.removed++; touched.push(key);
        }
      }
      if (touched.length) {
        g.rev = bump(); g.updatedAt = now();
        changed({ kind: "glossary", id });
        changed({ kind: "terms", id, sources: touched });
      }
      return Object.assign(r, { rev: S.rev, changed: touched.length > 0 });
    }

    // Usage counts for terms: [[source, [[english, users], ...]], ...]. Only numbers are kept.
    function applyVotes(id, body) {
      const g = S.glossaries[id];
      if (!g || g.deleted) throw httpError(404, "no such glossary");
      if (!Array.isArray(body.votes) || body.votes.length > 2000) throw httpError(400, "votes must be an array (max 2000)");
      const r = { updated: 0, retitled: 0 };
      const touched = [];
      for (const row of body.votes) {
        if (!Array.isArray(row) || !Array.isArray(row[1])) continue;
        const source = clean(row[0]);
        const cur = g.terms[source];
        if (!cur || cur.deleted) continue;
        const v = row[1]
          .filter((x) => Array.isArray(x) && typeof x[0] === "string" && Number.isFinite(x[1]))
          .map((x) => [clean(x[0]), Math.max(0, Math.floor(x[1]))])
          .filter((x) => x[0])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);
        let t = cur.t;
        const top = v[0];
        // Only terms the site did not curate: switch to the rendering most readers chose. Curated terms, the person's own ("yours": what they chose
        // on the site) and user terms stay put.
        if (cur.src === "wtr" && (cur.o || "novel") !== "novel" && cur.o !== "yours" && top && top[0] !== t && top[1] > countFor(v, t)) {
          t = top[0];
          r.retitled++;
        }
        const n = countFor(v, t);
        if (JSON.stringify(cur.v || []) === JSON.stringify(v) && cur.n === n && cur.t === t) continue;
        cur.v = v; cur.n = n; cur.t = t; cur.updatedAt = now(); cur.rev = S.rev + 1;
        r.updated++;
        touched.push(source);
      }
      if (touched.length) {
        g.rev = bump(); g.updatedAt = now();
        changed({ kind: "glossary", id });
        changed({ kind: "terms", id, sources: touched });
      }
      return Object.assign(r, { rev: S.rev, changed: touched.length > 0 });
    }

    function deleteGlossary(id) {
      const g = S.glossaries[id];
      if (!g || g.deleted) throw httpError(404, "no such glossary");
      g.deleted = true; g.rev = bump(); g.updatedAt = now();
      changed({ kind: "glossary", id });
      return { rev: S.rev };
    }

    function setBinding(body) {
      const key = clean(body.key, 300);
      if (!key || !Array.isArray(body.ids) || body.ids.length > 100) throw httpError(400, "key and ids[] are required");
      const ids = [...new Set(body.ids.map((i) => clean(i, 200)).filter(Boolean))];
      const cur = S.bindings[key];
      if (cur && JSON.stringify(cur.ids) === JSON.stringify(ids)) return { rev: S.rev, changed: false };
      S.bindings[key] = { ids, rev: bump(), updatedAt: now() };
      changed({ kind: "binding", id: key });
      return { rev: S.rev, changed: true };
    }

    // Display info for a novel's page (cover, synopsis, author, tags...). Idempotent: identical info changes nothing.
    function saveNovel(id, body) {
      const text = (k, max) => clean(body[k], max);
      const num = (k) => (Number.isFinite(body[k]) ? Math.round(body[k] * 100) / 100 : undefined);
      const whole = (k) => (Number.isFinite(body[k]) ? Math.max(0, Math.floor(body[k])) : undefined);
      const title = text("title", 300);
      if (!title) throw httpError(400, "title is required");
      const url = (k) => { const v = text(k, 500); return /^https:\/\//.test(v) ? v : ""; }; // only https links are kept
      const info = {
        id, source: text("source", 50) || "wtr-lab", rawId: text("rawId", 50), slug: text("slug", 200), url: url("url"),
        rawHost: /^[a-z0-9.-]{3,100}$/.test(text("rawHost", 100)) ? text("rawHost", 100) : "", // The site the site's "Raw" link leads to
        rawFirst: url("rawFirst"), // where chapter 1 is on that site: the page the "Raw" link of chapter 1 lands on
        listUrl: url("listUrl"), // a novel from a source site (not the site): the page that lists its chapters, which ties it to its chapter list
        title, author: text("author", 300), authorRaw: text("authorRaw", 300), synopsis: clean(body.synopsis, 5000), cover: url("cover"),
        chapterCount: Number.isFinite(body.chapterCount) ? Math.max(0, Math.floor(body.chapterCount)) : undefined,
        rating: num("rating"), views: Number.isFinite(body.views) ? Math.max(0, Math.floor(body.views)) : undefined,
        tags: (Array.isArray(body.tags) ? body.tags : []).map((t) => clean(t, 60)).filter(Boolean).slice(0, 40),
        genres: (Array.isArray(body.genres) ? body.genres : []).map((t) => clean(t, 40)).filter(Boolean).slice(0, 20),
        rawTitle: text("rawTitle", 300), // the title in the novel's own language
        names: (Array.isArray(body.names) ? body.names : []).map((t) => clean(t, 300)).filter(Boolean).slice(0, 10), // its other titles
        status: ["Ongoing", "Completed", "Hiatus", "Dropped"].includes(body.status) ? body.status : "",
        rawStatus: ["Ongoing", "Completed", "Hiatus", "Dropped"].includes(body.rawStatus) ? body.rawStatus : "",
        // what the site's Novel Finder also filters and orders by, for the library's own: its length in characters, how many reviewed it, how many
        // have it in their library there, the votes for it, and whether the site has released it or it is still being voted on
        chars: whole("chars"), ratingCount: whole("ratingCount"), readers: whole("readers"), votes: whole("votes"),
        release: ["released", "voting"].includes(body.release) ? body.release : "",
        // a novel uploaded as an EPUB (its record is "up-<upload id>"): the file's name, when it was uploaded, how many chapters it had
        upload: body.upload && typeof body.upload === "object" ? {
          file: clean(body.upload.file, 200),
          at: Number.isFinite(body.upload.at) ? Math.max(0, Math.floor(body.upload.at)) : 0,
          chapters: Number.isFinite(body.upload.chapters) ? Math.max(0, Math.floor(body.upload.chapters)) : 0
        } : undefined
      };
      const cur = S.novels[id];
      const bare = ({ updatedAt, addedAt, ...rest }) => JSON.stringify(rest); // (the record without its dates)
      if (cur && bare(cur) === bare(info)) return { changed: false };
      // addedAt: when the novel first came here (a record from before that was kept: when it was last changed)
      S.novels[id] = Object.assign(info, { addedAt: (cur && (cur.addedAt || cur.updatedAt)) || now(), updatedAt: now() });
      changed({ kind: "novel", id });
      return { changed: true };
    }

    // ---- covers ----
    async function saveCover(id, type, bytes) {
      if (!id || id.length > 300) throw httpError(400, "a novel id is required");
      if (!COVER_TYPES[type]) throw httpError(415, "a cover must be a jpeg, png, webp, gif or avif image");
      if (!bytes || !bytes.length) throw httpError(400, "the image is empty");
      if (bytes.length > MAX_COVER) throw httpError(413, "the cover is larger than " + Math.round(MAX_COVER / 1024) + " KB");
      if (!looksLike(type, bytes)) throw httpError(415, "the content is not a " + type + " image");
      const hash = await sha256Hex(bytes);
      const cur = S.covers[id];
      if (cur && cur.hash === hash && cur.type === type) return { changed: false };
      await covers.save(id, bytes);
      S.covers[id] = { type, size: bytes.length, at: now(), hash };
      changed({ kind: "cover", id });
      return { changed: true };
    }
    async function readCover(id) {
      const meta = S.covers[id];
      if (!meta) return null;
      try {
        const bytes = await covers.read(id);
        return bytes ? { type: meta.type, bytes, hash: meta.hash } : null;
      } catch (e) {
        return null; // the file is gone: as if there were no copy
      }
    }
    // A novel row as the page gets it: the record, and whether a copy of its cover is kept here (and when it was made).
    const withCover = (n) => (S.covers[n.id] ? Object.assign({}, n, { coverCopy: true, coverAt: S.covers[n.id].at }) : n);

    function saveSettings(body) {
      const next = Object.assign({}, S.settings);
      if (typeof body.copyCovers === "boolean") next.copyCovers = body.copyCovers;
      if (typeof body.termNotesAi === "boolean") next.termNotesAi = body.termNotesAi;
      if (typeof body.poolHints === "boolean") next.poolHints = body.poolHints;
      if (typeof body.keepTerms === "boolean") next.keepTerms = body.keepTerms;
      // agreeing to add the terms one made to a public pool (CC0): off until the person says so; when they said it is kept (nothing is sent for what was made before it)
      if (typeof body.sharePool === "boolean" && body.sharePool !== next.sharePool) { next.sharePool = body.sharePool; if (body.sharePool) next.sharePoolAt = Date.now(); else delete next.sharePoolAt; }
      // Gemini's requests a minute, for every device of the library together (each extension keeps to it: gemini.js); none kept: 12
      if (Number.isFinite(body.geminiRate)) next.geminiRate = Math.max(1, Math.min(120, Math.floor(body.geminiRate)));
      // how titles and details that are not in English are put into English (gemini.js translateByMode, and the site): Google Translate,
      // Gemini, Gemini with Google Translate when Gemini can't, or not at all
      if (["google", "gemini", "gemini-google", "off"].includes(body.titleTranslate)) next.titleTranslate = body.titleTranslate;
      // the Gemini model chapters are translated with (Settings › Translation › Gemini model, a chapter's footer, the extension's popup: the same on every device;
      // blank: the extension's own default)
      if (typeof body.geminiModel === "string") {
        const m = body.geminiModel.trim();
        if (!m) delete next.geminiModel;
        else if (/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(m)) next.geminiModel = m;
      }
      // the language chapters, titles and details are translated into (a code such as es or pt-BR; English when none is kept)
      if (typeof body.targetLanguage === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(body.targetLanguage)) {
        if (body.targetLanguage === "en") delete next.targetLanguage;
        else next.targetLanguage = body.targetLanguage;
      }
      // the Gemini prompts the person changed in Settings › Translation ({ translate, notes, detect }; a name set to blank or null: the built-in one
      // again). Every extension of the library sends these (gemini.js geminiPrompt); none kept: the built-in ones
      if (body.geminiPrompts && typeof body.geminiPrompts === "object") {
        const all = Object.assign({}, next.geminiPrompts);
        for (const name of ["translate", "notes", "detect"]) {
          if (!(name in body.geminiPrompts)) continue;
          const v = body.geminiPrompts[name];
          if (typeof v === "string" && v.trim()) all[name] = v.slice(0, 20000);
          else delete all[name];
        }
        if (Object.keys(all).length) next.geminiPrompts = all;
        else delete next.geminiPrompts;
      }
      // the prompts of each of translate, notes and detect (Settings › Translation › Gemini prompts): { active, mine: [{ id, name, text }] }: the one in use (the
      // id of one that comes with the extension, gemini.js GEMINI_PROMPT_PRESETS, or of one of the person's own) and the ones the person saved. What is sent
      // for a kind replaces its whole entry; a kind left out is as it was; null: the extension's own default again
      if (body.promptSets && typeof body.promptSets === "object") {
        const all = Object.assign({}, next.promptSets);
        for (const name of ["translate", "notes", "detect"]) {
          if (!(name in body.promptSets)) continue;
          const v = body.promptSets[name];
          if (v === null) { delete all[name]; continue; }
          if (!v || typeof v !== "object") continue;
          const seen = new Set();
          const mine = (Array.isArray(v.mine) ? v.mine : [])
            .filter((p) => p && /^[A-Za-z0-9_-]{3,24}$/.test(String(p.id)) && typeof p.text === "string" && p.text.trim() && !seen.has(String(p.id)) && seen.add(String(p.id)))
            .slice(0, 40)
            .map((p) => ({ id: String(p.id), name: clean(p.name, 60) || "Prompt", text: p.text.slice(0, 20000) }));
          all[name] = { active: typeof v.active === "string" ? clean(v.active, 40) : "", mine };
        }
        if (Object.keys(all).length) next.promptSets = all;
        else delete next.promptSets;
      }
      putProfiles(next, body);
      // which of your extensions does the triggers (looks for new chapters, fetches and translates on its own): one device of the library, by its
      // id (library.js status().device), else every one; null: every one again
      if (body.triggerDevice === null) delete next.triggerDevice;
      else if (body.triggerDevice && typeof body.triggerDevice.id === "string" && /^[0-9a-f]{8,40}$/.test(body.triggerDevice.id)) {
        next.triggerDevice = { id: body.triggerDevice.id, name: clean(body.triggerDevice.name, 80) };
      }
      // seconds between two chapters of a site fetched one after another, the person's default for each site ({ host: seconds }; null: the
      // site's own again), as Settings › Limits sets them; a novel's own (its watch's `wait`) comes first
      if (body.siteWaits && typeof body.siteWaits === "object") {
        const all = Object.assign({}, next.siteWaits);
        for (const [h, v] of Object.entries(body.siteWaits).slice(0, 200)) {
          const host = String(h).replace(/^www\./, "").toLowerCase();
          if (!/^[a-z0-9.-]{3,100}$/.test(host)) continue;
          if (v === null) delete all[host];
          else if (Number.isFinite(Number(v))) all[host] = Math.max(0, Math.min(300, Math.round(Number(v) * 10) / 10));
        }
        next.siteWaits = all;
      }
      if (JSON.stringify(next) !== JSON.stringify(S.settings)) {
        S.settings = next;
        changed({ kind: "settings" });
        return Object.assign({ changed: true }, S.settings);
      }
      return Object.assign({ changed: false }, S.settings);
    }

    // ---- your the site library, and the stars you give its novels here ----
    // The list is what the site's own library page lists (it only shows it to you, signed in, so it is sent here; nothing more is read of a novel
    // than the list itself says). The stars are yours, given on the library's Rate page: 1 to 5 per novel, kept here and nowhere else.
    function saveWtrLibrary(body) {
      if (!Array.isArray(body.novels) || body.novels.length > 5000) throw httpError(400, "novels must be an array (max 5000)");
      const digits = (v) => (/^\d{1,12}$/.test(String(v)) ? String(v) : "");
      const count = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
      const https = (v) => (/^https:\/\//.test(clean(v, 500)) ? clean(v, 500) : "");
      const seen = new Set();
      const novels = [];
      for (const n of body.novels) {
        const id = n && typeof n === "object" ? clean(n.id, 60) : "";
        const title = id ? clean(n.title, 300) : "";
        if (!WTR_NOVEL.test(id) || !title || seen.has(id)) continue;
        seen.add(id);
        novels.push({
          id, serieId: digits(n.serieId), rawId: id.slice(8), slug: /^[a-z0-9-]{1,200}$/i.test(clean(n.slug, 200)) ? clean(n.slug, 200) : "", title, rawTitle: clean(n.rawTitle, 300),
          author: clean(n.author, 300), authorRaw: clean(n.authorRaw, 300), cover: https(n.cover), url: https(n.url),
          status: ["Ongoing", "Completed", "Hiatus", "Dropped"].includes(n.status) ? n.status : "",
          chapterCount: count(n.chapterCount), readTo: count(n.readTo), // how many chapters it has, and the chapter you are at on the site
          rating: Number.isFinite(n.rating) ? Math.round(n.rating * 100) / 100 : 0, // The site's readers' rating
          wtrRate: Number.isFinite(n.wtrRate) ? Math.min(5, Math.max(0, Math.round(n.wtrRate))) : 0, // the stars you gave it on the site itself (0: none)
          addedAt: count(n.addedAt), readAt: count(n.readAt) // when you put it in your the site library, and when you last read it there
        });
      }
      S.wtrLibrary = { importedAt: now(), novels };
      changed({ kind: "wtrLibrary" });
      return { count: novels.length };
    }
    function saveMyRating(rawId, body) {
      const id = clean(rawId, 60);
      if (!WTR_NOVEL.test(id)) throw httpError(400, "a rating is of a site novel (wtr-lab:<its number>)");
      const rate = Number(body.rate);
      if (!rate) { // no stars: the rating is taken back
        const had = !!S.myRatings[id];
        delete S.myRatings[id];
        if (had) changed({ kind: "rating", id });
        return { changed: had };
      }
      if (!Number.isInteger(rate) || rate < 1 || rate > 5) throw httpError(400, "a rating is 1 to 5 stars");
      if (S.myRatings[id] && S.myRatings[id].rate === rate) return { changed: false, rate };
      S.myRatings[id] = { rate, at: now() };
      changed({ kind: "rating", id });
      return { changed: true, rate };
    }

    // ---- notes on a novel's terms (yours, and Gemini's when it is let keep them) ----
    // A note is found by its term's source word and the novel: any key in common is the same novel (a novel gets known by more keys over time,
    // and they are all kept). One call writes one note or several (Gemini's answer for a chapter): { notes: [{ source, keys, ... }] }.
    const MAX_NOTES = 20000;
    const MAX_NOTE = 4000;
    const noteKeys = (keys) => [...new Set((Array.isArray(keys) ? keys : []).map((k) => clean(k, 300)).filter(Boolean))].slice(0, 50);
    function findNote(source, keys) {
      return Object.values(S.termNotes).find((n) => n.source === source && n.keys.some((k) => keys.includes(k))) || null;
    }
    function saveTermNote(body) {
      const source = clean(body.source, 100);
      if (!source) throw httpError(400, "source is the term's source word");
      const keys = noteKeys(body.keys);
      if (!keys.length) throw httpError(400, "keys say which novel the note is of");
      let n = findNote(source, keys);
      const before = n ? JSON.stringify(n) : "";
      if (!n) {
        if (Object.keys(S.termNotes).length >= MAX_NOTES) throw httpError(400, "too many notes");
        n = { id: randomHex(8), source, english: "", novel: "", keys: [], text: "", ai: "", at: 0 };
      }
      n.keys = noteKeys(n.keys.concat(keys));
      if (typeof body.english === "string" && clean(body.english, 200)) n.english = clean(body.english, 200);
      if (typeof body.novel === "string" && clean(body.novel, 200)) n.novel = clean(body.novel, 200);
      const noteText = (v) => String(v).replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTE);
      if (typeof body.text === "string") n.text = noteText(body.text);
      if (typeof body.ai === "string") {
        const ai = noteText(body.ai);
        if (ai !== n.ai) {
          if (!body.undo) { if (n.ai) n.aiPrev = n.ai; } // what it said before, so a bad change can be taken back (an undo does not keep what it undid)
          else delete n.aiPrev;
          n.ai = ai;
          n.aiAt = now();
          if (body.chapter !== undefined) n.aiChapter = clean(body.chapter, 20);
        }
      }
      if (JSON.stringify(n) === before) return { changed: false, note: n };
      n.at = now();
      if (!n.text && !n.ai && !n.aiPrev) { delete S.termNotes[n.id]; changed({ kind: "note", id: n.id, removed: true }); return { changed: true, note: null }; } // nothing left: no note
      S.termNotes[n.id] = n;
      changed({ kind: "note", id: n.id });
      return { changed: true, note: n };
    }
    function saveTermNotes(body) {
      if (Array.isArray(body.notes)) {
        if (body.notes.length > 200) throw httpError(400, "at most 200 notes at once");
        return { results: body.notes.map((one) => saveTermNote(one || {})) };
      }
      return saveTermNote(body);
    }

    // ---- your own terms (the library reader's "Add Term") ----
    // One term at a time, so two devices adding terms do not undo each other. The same term again changes nothing.
    const MAX_MY_TERMS = 5000;
    function saveMyTerm(rawId, body) {
      const id = clean(rawId, 40);
      if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw httpError(400, "a term's id is 4 to 40 letters, digits, - or _");
      const from = [...new Set((Array.isArray(body.from) ? body.from : []).map((f) => clean(f, 128)).filter(Boolean))].slice(0, 20);
      if (!from.length) throw httpError(400, "from is the text to replace: at least one");
      const to = clean(body.to, 128);
      if (!to) throw httpError(400, "to is what it is replaced with");
      const keys = [...new Set((Array.isArray(body.keys) ? body.keys : []).map((k) => clean(k, 300)).filter(Boolean))].slice(0, 50);
      // src "wtr": one the extension read from the person's own terms on the site (the site stays its source, and follows it until it is edited here: a term
      // saved without src, as the site does when the person changes one, is theirs from then on and the site's later reads leave it alone)
      const term = { id, from, to, cs: !!body.cs, novel: keys.length ? clean(body.novel, 200) : "", keys, ...(body.src === "wtr" ? { src: "wtr" } : {}) };
      const cur = S.myTerms[id];
      if (cur && JSON.stringify(Object.assign({}, cur, { at: 0 })) === JSON.stringify(Object.assign({}, term, { at: 0 }))) return { changed: false, term: cur };
      if (!cur && Object.keys(S.myTerms).length >= MAX_MY_TERMS) throw httpError(400, "too many terms");
      S.myTerms[id] = Object.assign(term, { at: now() });
      changed({ kind: "myTerm", id });
      return { changed: true, term: S.myTerms[id] };
    }
    function deleteMyTerm(rawId) {
      const id = clean(rawId, 40);
      const cur = S.myTerms[id];
      if (!cur || cur.gone) return { changed: false };
      // one from the site that is deleted stays deleted: a mark is kept (listed as `gone`), so its next read does not bring it back
      if (cur.src === "wtr") {
        S.myTerms[id] = { id, from: cur.from, to: cur.to, cs: !!cur.cs, novel: "", keys: cur.keys || [], src: "wtr", gone: true, at: now() };
        changed({ kind: "myTerm", id });
      } else {
        delete S.myTerms[id];
        changed({ kind: "myTerm", id, removed: true });
      }
      return { changed: true };
    }

    // ---- comments: which novel a source's book is, and who you are there ----
    // The comments are on the public comments server; what is yours alone is kept here, so every device of yours agrees.
    function saveCommentLink(body) {
      const key = clean(body.key, 300);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}\/[^/]/.test(key)) throw httpError(400, "key is a site and the directory a book's chapters are in (69shuba.com/txt/39164)");
      const novel = clean(body.novel, 60);
      if (novel && !WTR_NOVEL.test(novel)) throw httpError(400, "novel is a site novel (wtr-lab:<its number>), or empty for none");
      const cur = S.commentLinks[key];
      if (cur && cur.novel === novel) return { changed: false, links: commentLinks() };
      if (!cur && Object.keys(S.commentLinks).length >= 5000) throw httpError(400, "too many links");
      S.commentLinks[key] = { novel, at: now() };
      changed({ kind: "commentLink", id: key });
      return { changed: true, links: commentLinks() };
    }
    const commentLinks = () => Object.fromEntries(Object.entries(S.commentLinks).map(([k, v]) => [k, v.novel]));
    // The key is set once and then stays (two devices that both made one up end with the same: the first to arrive); the name is the last one given.
    function saveCommentIdentity(body) {
      const next = { key: S.commentIdentity.key, name: S.commentIdentity.name };
      const key = clean(body.key, 128);
      if (!next.key && key) {
        if (!/^[A-Za-z0-9_-]{20,128}$/.test(key)) throw httpError(400, "a key is 20 to 128 letters, digits, - or _");
        next.key = key;
      }
      if (typeof body.name === "string") next.name = clean(body.name, 40);
      if (next.key !== S.commentIdentity.key || next.name !== S.commentIdentity.name) {
        S.commentIdentity = next;
        changed({ kind: "commentIdentity" });
      }
      return S.commentIdentity;
    }

    // The full chapter list of a novel on a reader site. Idempotent: an identical list changes nothing.
    function saveChapterIndex(body) {
      const key = clean(body.key, 300);
      if (!key) throw httpError(400, "key is required");
      if (!Array.isArray(body.chapters) || !body.chapters.length || body.chapters.length > MAX_CHAPTERS) {
        throw httpError(400, "chapters must be a non-empty array (max " + MAX_CHAPTERS + ")");
      }
      const seen = new Set();
      const chapters = [];
      for (const row of body.chapters) {
        if (!Array.isArray(row)) continue;
        const num = Number(row[0]);
        const url = clean(row[2], 500);
        if (!Number.isInteger(num) || num < 0 || !/^https:\/\//.test(url) || seen.has(url)) continue; // only https links; one entry per URL
        seen.add(url);
        chapters.push([num, clean(row[1], 300), url, clean(row[3], 300)]);
      }
      if (!chapters.length) throw httpError(400, "no valid chapters in the list");
      chapters.sort((a, b) => a[0] - b[0]);
      const next = { key, source: clean(body.source, 50), url: /^https:\/\//.test(clean(body.url, 500)) ? clean(body.url, 500) : "", chapters };
      const cur = S.chapterIndex[key];
      if (cur && JSON.stringify(Object.assign({}, cur, { updatedAt: 0 })) === JSON.stringify(Object.assign({}, next, { updatedAt: 0 }))) return { changed: false, count: chapters.length };
      S.chapterIndex[key] = Object.assign(next, { updatedAt: now() });
      changed({ kind: "chapterIndex", id: key });
      return { changed: true, count: chapters.length };
    }

    // ---- novels merged or split by hand ----
    // { merges: [[ref, ref]], apart: [[ref, ref]] }: "these are one novel" / "these are not" (a ref is any id a novel carries, or "name:<its name>").
    // The whole document is replaced by the one that was last saved, so every device sees the same.
    function saveNovelLinks(body) {
      const pairs = (v) => (Array.isArray(v) ? v : [])
        .filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string")
        .map((p) => [clean(p[0], 300), clean(p[1], 300)])
        .filter((p) => p[0] && p[1] && p[0] !== p[1])
        .slice(0, 1000);
      // hidden: parts of a novel that are linked to it but not shown
      const refs = (Array.isArray(body.hidden) ? body.hidden : []).filter((r) => typeof r === "string").map((r) => clean(r, 300)).filter(Boolean).slice(0, 1000);
      const next = { merges: pairs(body.merges), apart: pairs(body.apart), hidden: [...new Set(refs)] };
      if (JSON.stringify([S.novelLinks.merges, S.novelLinks.apart, S.novelLinks.hidden || []]) === JSON.stringify([next.merges, next.apart, next.hidden])) return S.novelLinks;
      S.novelLinks = Object.assign(next, { updatedAt: now() });
      changed({ kind: "novelLinks" });
      return S.novelLinks;
    }

    // ---- new-chapter watches ----
    const httpsUrl = (v) => (/^https:\/\//.test(clean(v, 500)) ? clean(v, 500) : "");
    const wholeNumber = (v, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(0, Math.floor(Number(v)))) : 0);
    // The days of the week a "daily" watch looks on, as a sorted list of 0 (Sunday) ... 6; every day (or none given) is []
    const weekdays = (v) => {
      const d = [...new Set((Array.isArray(v) ? v : []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
      return d.length === 7 ? [] : d;
    };
    // What a watch does with the chapters (`then`) and the novel's name, kept apart from the watch as well: in the settings (watchModes), which an
    // older build keeps as they are when it writes them. An older build's extension writes the watch again after each look, without them, and
    // its library keeps it so; read from here, the person's choice holds. (An absent `then` keeps what was chosen.)
    const THEN = ["tell", "fetch", "all"];
    const modesOf = () => (S.settings && S.settings.watchModes) || {};
    // (`above`: for "fetch", the new ones are the chapters numbered past this, the list's last chapter when it was chosen: so whichever device
    // looked first, every chapter released since is fetched)
    const withMode = (w) => {
      const md = w && modesOf()[w.id];
      return md ? Object.assign({}, w, { then: md.then, name: md.name || w.name }, md.above !== undefined ? { above: md.above } : {}, md.wait !== undefined ? { wait: md.wait } : {}) : w;
    };
    function saveWatch(rawId, body) {
      const id = clean(rawId, 220);
      const m = /^([^|]{1,120})\|([a-z0-9.-]{3,100})$/i.exec(id);
      if (!m) throw httpError(400, "a watch id looks like <novel id>|<source site>");
      const cur = S.watches[id];
      const modes = modesOf();
      const md = modes[id] || {};
      const then = THEN.includes(body.then) ? body.then : md.then || (cur && THEN.includes(cur.then) ? cur.then : "tell");
      const name = clean(body.name, 300) || md.name || (cur && cur.name) || "";
      // where the new ones start: set when "fetch" is chosen (what the page knew, else what the watch knew), kept while it stays chosen
      const above = then !== "fetch" ? undefined : md.then === "fetch" && md.above !== undefined ? md.above
        : Number.isFinite(Number(body.above)) ? wholeNumber(body.above, 1000000) : wholeNumber((cur && cur.known) || body.known, 1000000);
      // the novel's own wait between two chapters of this source (seconds; null: the site's), kept unless said again
      const wait = body.wait === null ? undefined : Number.isFinite(Number(body.wait)) && body.wait !== "" ? Math.max(0, Math.min(300, Math.round(Number(body.wait) * 10) / 10)) : md.wait;
      if ((modes[id] || then !== "tell" || wait !== undefined) && (md.then !== then || (md.name || "") !== name || md.above !== above || md.wait !== wait)) {
        const all = Object.assign({}, modes, { [id]: Object.assign({ then, name }, above !== undefined ? { above } : {}, wait !== undefined ? { wait } : {}) });
        const ids = Object.keys(all);
        if (ids.length > 2000) for (const k of ids.slice(0, ids.length - 2000)) delete all[k];
        S.settings = Object.assign({}, S.settings, { watchModes: all });
        changed({ kind: "settings" });
      }
      const next = {
        id, novel: m[1], source: m[2].toLowerCase(), on: body.on === true,
        mode: body.mode === "daily" ? "daily" : "every",
        hours: Math.min(168, Math.max(1, wholeNumber(body.hours, 168) || 12)), // "every N hours"
        at: /^([01]\d|2[0-3]):[0-5]\d$/.test(clean(body.at, 5)) ? clean(body.at, 5) : "09:00", // "daily at" (the person's local time)
        days: weekdays(body.days), // "daily" on these days of the week (0 = Sunday ... 6); none: every day
        tz: Number.isFinite(Number(body.tz)) ? Math.max(-840, Math.min(840, Math.round(Number(body.tz)))) : 0, // minutes to add to local time to get UTC
        // what is done with the chapters: the new ones told about; or fetched (and translated) too; or every chapter of the list not here, too
        then,
        name, // the novel's name in the library: the chapters fetched are saved under it
        from: httpsUrl(body.from), // where to start looking on a source that is followed page by page: the latest chapter known there
        known: wholeNumber(body.known, 1000000), // the highest chapter number known when it was switched on (or last found)
        url: httpsUrl(body.url), // the novel's page, for sources that list chapters themselves (the site)
        lastCheck: wholeNumber(body.lastCheck, 8.64e15),
        lastResult: clean(body.lastResult, 200)
      };
      if (cur && JSON.stringify(Object.assign({}, cur, { updatedAt: 0 })) === JSON.stringify(Object.assign({}, next, { updatedAt: 0 }))) return { changed: false, watch: withMode(cur) };
      if (!cur && Object.keys(S.watches).length >= 2000) throw httpError(400, "too many watches");
      S.watches[id] = Object.assign(next, { updatedAt: now() });
      changed({ kind: "watch", id });
      return { changed: true, watch: withMode(S.watches[id]) };
    }

    function addNotice(body) {
      const novel = clean(body.novel, 120);
      const source = clean(body.source, 100).toLowerCase();
      const latest = httpsUrl(body.latest);
      if (!novel || !source || !latest) throw httpError(400, "novel, source and latest are required");
      if (S.notices.some((n) => n.novel === novel && n.source === source && n.latest === latest)) return { changed: false }; // the same finding again
      const notice = {
        id: randomHex(6), novel, source, count: Math.max(1, wholeNumber(body.count, 100000)),
        firstNum: wholeNumber(body.firstNum, 1000000), lastNum: wholeNumber(body.lastNum, 1000000),
        first: httpsUrl(body.first), latest, at: now(), seen: false
      };
      S.notices.unshift(notice);
      const dropped = S.notices.splice(300).map((x) => x.id);
      changed({ kind: "notice", id: notice.id });
      for (const id of dropped) changed({ kind: "notice", id, removed: true });
      return { changed: true, notice };
    }

    function markSeen(body) {
      const novel = clean(body.novel, 120);
      let n = 0;
      for (const x of S.notices) if (!x.seen && (!novel || x.novel === novel)) { x.seen = true; n++; changed({ kind: "notice", id: x.id }); }
      return { changed: n > 0, marked: n };
    }

    function sync(since) {
      const s = Number(since) || 0;
      const glossaries = [];
      const removed = [];
      for (const g of Object.values(S.glossaries)) {
        if (g.rev <= s) continue;
        if (g.deleted) removed.push(g.id);
        else glossaries.push(full(g));
      }
      const bindings = Object.entries(S.bindings).filter(([, b]) => b.rev > s).map(([key, b]) => ({ key, ids: b.ids, rev: b.rev }));
      return { rev: S.rev, glossaries, removed, bindings };
    }

    // ---- one call ----
    async function handle(method, fullPath, body) {
      const url = new URL(fullPath, "http://x");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const q = (k) => url.searchParams.get(k);
      const json = () => (body && typeof body === "object" ? body : {});
      const notFound = () => { throw httpError(404, "not found"); };
      if (parts[0] !== "api") notFound();

      if (parts[1] === "sync" && method === "GET") return sync(q("since"));
      // Everything kept, as it is kept (deleted terms, the site's own wording of a term you changed...), for moving it into a library.
      // Covers are only described here; their pictures are fetched one by one.
      if (parts[1] === "export" && method === "GET") return S;

      if (parts[1] === "glossaries") {
        const id = parts[2];
        if (!id) {
          if (method === "GET") return { rev: S.rev, glossaries: Object.values(S.glossaries).filter((g) => !g.deleted).map(summary) };
        } else if (!parts[3]) {
          if (method === "GET") {
            const g = S.glossaries[id];
            if (g && !g.deleted) return full(g);
            throw httpError(404, "no such glossary");
          }
          if (method === "DELETE") return deleteGlossary(id);
        } else if (parts[3] === "import" && method === "POST") {
          return importSnapshot(id, json());
        } else if (parts[3] === "add" && method === "POST") {
          return addTerms(id, json());
        } else if (parts[3] === "edit" && method === "POST") {
          return editTerms(id, json());
        } else if (parts[3] === "votes" && method === "POST") {
          return applyVotes(id, json());
        }
      }

      if (parts[1] === "novels") {
        if (method === "GET" && !parts[2]) {
          // ?ids=a,b: only those novels; ?fields=card: every novel without its synopsis (what a library's page of cards needs: a library of
          // thousands, read from another device, is not sent in full to draw its cards)
          const ids = q("ids") ? new Set(q("ids").split(",")) : null;
          const list = Object.values(S.novels).filter((n) => !ids || ids.has(n.id)).map(withCover);
          return { novels: q("fields") === "card" ? list.map((n) => Object.assign({}, n, { synopsis: undefined })) : list };
        }
        if (method === "PUT" && parts[2]) return saveNovel(parts[2], json());
      }

      if (parts[1] === "covers" && parts[2]) {
        if (method === "PUT") return saveCover(parts[2], String((body && body.type) || "").split(";")[0].trim().toLowerCase(), body && body.bytes);
        if (method === "GET") {
          const c = await readCover(parts[2]);
          if (!c) throw httpError(404, "no copy of this cover");
          return c;
        }
      }

      if (parts[1] === "settings") {
        if (method === "GET") return S.settings;
        if (method === "PUT") return saveSettings(json());
      }

      if (parts[1] === "chapter-index") {
        // ?key=a,b limits the answer to those novels (a full list is tens of KB per novel).
        if (method === "GET") {
          const only = (q("key") || "").split(",").map((k) => k.trim()).filter(Boolean);
          const all = Object.values(S.chapterIndex);
          const byUrl = q("url"); // ?url=<list page address>: the list that was read from that page, or from another page of the same book
          if (byUrl) return { indexes: all.filter((i) => i.url && sameBookUrl(i.url, byUrl)) };
          return { indexes: only.length ? all.filter((i) => only.includes(i.key)) : all };
        }
        if (method === "PUT") return saveChapterIndex(json());
      }

      if (parts[1] === "novel-links") {
        if (method === "GET") return S.novelLinks;
        if (method === "PUT") return saveNovelLinks(json());
      }

      if (parts[1] === "watches") {
        if (method === "GET" && !parts[2]) {
          const only = q("novel");
          return { watches: Object.values(S.watches).filter((w) => !only || w.novel === only).map(withMode) };
        }
        if (method === "PUT" && parts[2]) return saveWatch(parts[2], json());
      }

      if (parts[1] === "notices") {
        if (method === "GET" && !parts[2]) {
          const only = q("novel");
          return { notices: S.notices.filter((n) => !only || n.novel === only) };
        }
        if (method === "POST" && !parts[2]) return addNotice(json());
        if (method === "POST" && parts[2] === "seen") return markSeen(json());
      }

      if (parts[1] === "wtr-library") {
        if (method === "GET") return S.wtrLibrary;
        if (method === "PUT") return saveWtrLibrary(json());
      }

      if (parts[1] === "my-ratings") {
        if (method === "GET" && !parts[2]) return { ratings: S.myRatings };
        if (method === "PUT" && parts[2]) return saveMyRating(parts[2], json());
      }

      if (parts[1] === "term-notes") {
        // ?key=a,b: the notes of the novel known by any of those keys
        if (method === "GET") {
          const only = (q("key") || "").split(",").map((k) => k.trim()).filter(Boolean);
          return { notes: Object.values(S.termNotes).filter((n) => !only.length || n.keys.some((k) => only.includes(k))) };
        }
        if (method === "PUT") return saveTermNotes(json());
      }

      if (parts[1] === "my-terms") {
        if (method === "GET" && !parts[2]) return { terms: Object.values(S.myTerms).filter((t) => !t.gone).sort((a, b) => a.at - b.at), gone: Object.values(S.myTerms).filter((t) => t.gone).map((t) => t.id) };
        if (method === "PUT" && parts[2]) return saveMyTerm(parts[2], json());
        if (method === "DELETE" && parts[2]) return deleteMyTerm(parts[2]);
      }

      if (parts[1] === "comment-links") {
        if (method === "GET") return { links: commentLinks() };
        if (method === "PUT") return saveCommentLink(json());
      }

      if (parts[1] === "comment-identity") {
        if (method === "GET") return S.commentIdentity;
        if (method === "PUT") return saveCommentIdentity(json());
      }

      if (parts[1] === "bindings") {
        if (method === "GET") return { rev: S.rev, bindings: Object.entries(S.bindings).map(([key, b]) => ({ key, ids: b.ids, rev: b.rev })) };
        if (method === "PUT") return setBinding(json());
      }
      return notFound();
    }

    return { handle, state: S };
  }

  const LibraryApi = { createLibraryApi, normalizeState, httpError, putProfiles, MAX_COVER, COVER_TYPES };
  if (typeof module !== "undefined" && module.exports) module.exports = LibraryApi;
  else root.LibraryApi = LibraryApi;
})(typeof self !== "undefined" ? self : this);
