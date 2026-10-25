// Glossary helpers shared by the popup, the site capture script and the in-page translator.
//
// Flow: reading on the site sends that novel's own glossary to your library under an id like
// "wtr-lab:8053" and a name like "synthesis-wizard[wtr-lab]". The library is the source of truth; the extension keeps a read
// cache in `storage.local.glossaryLibrary` / `glossaryBindings` (glossary-server.js). On any other site the popup searches
// that library and *binds* a glossary to the novel being read (keyed by site + URL directory). Bound terms are merged in at
// translation time and are never copied into the user's own glossary.
//
// The site's `/api/v2/reader/terms/<raw_id>.json` holds three glossaries per novel and all of them are used. Each row is
// `[[english, ...variants], chineseSource, ...numbers]`. How many readers chose each English rendering is not in that file;
// it comes from `/api/v2/term-preferences`, one request per term (see wtr-capture.js).
(function (root) {
  const SITE_TAG = "wtr-lab";

  function pairsFromRows(rows) {
    const out = [];
    const seen = new Set();
    for (const r of rows || []) {
      if (!Array.isArray(r)) continue;
      const english = Array.isArray(r[0]) ? r[0][0] : r[0];
      if (typeof english !== "string" || typeof r[1] !== "string") continue;
      const translation = english.trim();
      const term = r[1].trim();
      if (!translation || !term || seen.has(term)) continue;
      seen.add(term);
      out.push([term, translation]);
    }
    return out;
  }

  // The site returns three glossaries per novel:
  //   "novel"  type "raw", hand-curated for this novel (what the site's "Edit Terms" shows)
  //   "ai"     type "raw" with a `build`: AI-extracted candidates, first English variant first
  //   "shared" type "generic": a reusable glossary the novel links to (e.g. "Cultivation")
  function classify(g) {
    const d = (g && g.data) || {};
    if (d.type && d.type !== "raw") return "shared";
    return d.build !== undefined || d.replacements !== undefined ? "ai" : "novel";
  }

  // The site's own terms of the person (its /api/v2/user/config answer: config.terms, one row per term:
  // [id, english, "source|source…", caseSensitive, [serie ids] | null, raw id, …]) that apply to the novel with this raw id, as [source, english] pairs:
  // the ones made for this novel first, then the ones for every novel (no serie ids). Only a source in the novel's own language is taken: a row whose
  // "source" is English is a fix of the site's English text, which means nothing to another translator's text.
  function personalPairs(json, rawId) {
    const rows = json && json.config && json.config.terms;
    if (!Array.isArray(rows)) return [];
    const scoped = [];
    const everywhere = [];
    for (const a of rows) {
      if (!Array.isArray(a) || typeof a[1] !== "string" || typeof a[2] !== "string" || !a[1].trim()) continue;
      if (a[4] == null) everywhere.push(a);
      else if (Number(a[5]) === Number(rawId)) scoped.push(a);
    }
    const out = [];
    const seen = new Set();
    for (const a of scoped.concat(everywhere)) {
      for (const part of a[2].split("|")) {
        const term = part.trim();
        if (!term || !SOURCE_SCRIPT.test(term) || seen.has(term)) continue;
        seen.add(term);
        out.push([term, a[1].trim()]);
      }
    }
    return out;
  }

  // The same rows' English "sources" (fixes of the site's English text: "Star-eater" shown as "Star Devourer"), for the terms of the library's reader
  // (/api/my-terms, which change the English shown after the translation, as on the site): [{ id, from: [text, ...], to, cs, global }] for the novel with
  // this raw id and for every novel. The id is "wtr-" and the row's own, so a later read finds the same term again (and one that the site no longer has).
  function personalReplacements(json, rawId) {
    const rows = json && json.config && json.config.terms;
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const a of rows) {
      if (!Array.isArray(a) || typeof a[0] !== "string" || typeof a[1] !== "string" || typeof a[2] !== "string" || !a[1].trim()) continue;
      const global = a[4] == null;
      if (!global && Number(a[5]) !== Number(rawId)) continue;
      const id = "wtr-" + a[0].replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);
      const from = [...new Set(a[2].split("|").map((p) => p.trim()).filter((p) => p && !SOURCE_SCRIPT.test(p)))];
      if (id.length < 5 || !from.length) continue;
      out.push({ id, from, to: a[1].trim(), cs: a[3] === true, global });
    }
    return out;
  }

  // Parses a terms response into a library record holding all three lists, or null if they are all empty.
  // When the same Chinese term is in more than one list the order is yours > novel > ai > shared; each term records its origin.
  // `personal`: the person's own terms on the site for this novel (personalPairs), origin "yours": what they chose is what the site shows them, so it
  // is what the translation of the same novel from another site is asked to use.
  // (The `replacements` rules are not imported: they are literal find/replace and some are unsafe.)
  function toLibraryEntry(json, rawId, slug, personal) {
    if (!json || !json.success || !Array.isArray(json.glossaries)) throw new Error("unexpected terms response");
    const order = { mine: -1, novel: 0, ai: 1, shared: 2 };
    const sets = json.glossaries
      .map((g) => {
        const kind = classify(g);
        return { kind, origin: kind === "shared" ? "shared:" + (g.title || "glossary") : kind, pairs: pairsFromRows(g.data && g.data.terms) };
      })
      .concat(Array.isArray(personal) && personal.length ? [{ kind: "mine", origin: "yours", pairs: personal.filter((p) => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" && p[0] && p[1]) }] : [])
      .sort((x, y) => order[x.kind] - order[y.kind]);
    const seen = new Set();
    const terms = [];
    const counts = { novel: 0, ai: 0, shared: 0 };
    for (const set of sets) {
      for (const [term, translation] of set.pairs) {
        if (seen.has(term)) continue;
        seen.add(term);
        terms.push([term, translation, { o: set.origin }]);
        counts[set.kind] = (counts[set.kind] || 0) + 1;
      }
    }
    if (!terms.length) return null;
    const cleanSlug = slug || "novel-" + rawId;
    return { id: SITE_TAG + ":" + rawId, name: cleanSlug + "[" + SITE_TAG + "]", site: SITE_TAG, rawId: String(rawId), slug: cleanSlug, terms, counts };
  }

  // The site's /api/v2/term-preferences answer for one term -> [[english, users], ...], most used first.
  // The response also lists the individual users' account IDs; those are deliberately dropped, only the counts are kept.
  function parseVotes(json) {
    if (!json || !json.success || !Array.isArray(json.data)) return null;
    return json.data
      .filter((d) => d && typeof d.to === "string" && d.to.trim() && Number.isFinite(d.userCount))
      .map((d) => [d.to.trim(), Math.max(0, Math.floor(d.userCount))])
      .sort((x, y) => y[1] - x[1]);
  }

  // The site's novel page data (/_next/data/<build>/<lang>/novel/<id>/<slug>.json) -> display info for the site's novel page:
  // title, author, synopsis, cover, tags. `base` is e.g. "https://wtr-lab.com/en". Returns null if there is no title.
  // The site writes terms inside a synopsis as %{fallback|base64 of the name} and shows the decoded name ("Jujutsu"): the plain text.
  function cleanDescription(text) {
    return String(text == null ? "" : text).replace(/%\{([^|}]*)\|([^}]*)\}/g, (all, fallback, b64) => {
      try {
        const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
        const name = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        return name || fallback;
      } catch (e) {
        return fallback;
      }
    });
  }

  // The site's own tables (its page scripts): a novel's status is a number, its genres are numbers.
  const STATUSES = ["Ongoing", "Completed", "Hiatus", "Dropped"];
  const GENRES = {
    1: "action", 2: "adult", 3: "adventure", 4: "comedy", 5: "drama", 6: "ecchi", 7: "erciyuan", 8: "fan-fiction", 9: "fantasy", 10: "game",
    11: "gender-bender", 12: "harem", 13: "historical", 14: "horror", 15: "josei", 16: "martial-arts", 17: "mature", 18: "mecha", 19: "military",
    20: "mystery", 21: "psychological", 22: "romance", 23: "school-life", 24: "sci-fi", 25: "seinen", 26: "shoujo", 27: "shoujo-ai", 28: "shounen",
    29: "shounen-ai", 30: "slice-of-life", 31: "smut", 32: "sports", 33: "supernatural", 34: "tragedy", 35: "urban-life", 36: "wuxia", 37: "xianxia",
    38: "xuanhuan", 39: "yaoi", 40: "yuri"
  };
  // "martial-arts" -> "Martial Arts" ("sci-fi" -> "Sci-Fi", "fan-fiction" -> "Fan-Fiction")
  const genreName = (id) => {
    const slug = GENRES[id];
    return slug ? slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(slug === "sci-fi" || slug === "fan-fiction" ? "-" : " ") : "";
  };
  // the original-language title, which the site keeps as base64 (URL-safe) of UTF-8
  function decodeB64(text) {
    try {
      const bin = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))).trim();
    } catch (e) {
      return "";
    }
  }

  function toNovelInfo(json, rawId, slug, base) {
    const p = json && json.pageProps;
    const sd = p && p.serie && p.serie.serie_data;
    if (!sd || !sd.data || !sd.data.title) return null;
    const tagTitle = new Map(((p && p.tags) || []).map((t) => [t.id, t.title]));
    const realSlug = sd.slug || slug;
    // the raw source the site names for this novel ("biquge.tw", "69shu", "fanqienovel"): in the same data, no extra request
    const raws = (p.serie && p.serie.raws) || [];
    const raw = raws.find((r) => r && r.default) || raws[0];
    return {
      rawSlug: raw && typeof raw.slug === "string" ? raw.slug.slice(0, 60) : undefined,
      id: SITE_TAG + ":" + rawId,
      source: SITE_TAG,
      rawId: String(rawId),
      slug: realSlug,
      url: base && realSlug ? base + "/novel/" + rawId + "/" + realSlug : undefined,
      title: sd.data.title,
      author: sd.data.author,
      authorRaw: sd.data.raw && sd.data.raw.author,
      synopsis: cleanDescription(sd.data.description),
      rawTitle: decodeB64(sd.data.raw_title_b64 || "") || (sd.data.raw && sd.data.raw.title) || undefined,
      names: [...new Set(((p.serie && p.serie.names) || []).map((n) => String(n && n.title || "").trim()).filter((t) => t && t !== sd.data.title))].slice(0, 10),
      status: STATUSES[sd.status] || undefined,
      rawStatus: STATUSES[sd.raw_status] || undefined,
      genres: (sd.genres || []).map(genreName).filter(Boolean),
      cover: sd.data.image,
      chapterCount: sd.chapter_count,
      rating: sd.rating,
      views: sd.view,
      // what the site's Novel Finder also filters and orders by: its length in characters, how many reviewed it, how many have it in their library,
      // the votes for it, and whether it is released or still being voted on (the site marks a novel on voting with a raw status of -1)
      chars: sd.char_count || sd.raw_char_count || undefined,
      ratingCount: sd.total_rate,
      readers: sd.in_library,
      votes: sd.vote,
      release: sd.raw_status === -1 ? "voting" : "released",
      tags: (sd.tags || []).map((id) => tagTitle.get(id)).filter(Boolean)
    };
  }

  // Bindings are { ids, updatedAt }; the very first version stored a bare array of ids, still accepted when reading.
  const bindingIds = (b) => (Array.isArray(b) ? b : b && Array.isArray(b.ids) ? b.ids : []);

  // The site novel URL -> { rawId, slug } (null for any other page). Language segment varies (/en/, /zh/ ...).
  function parseWtrUrl(url) {
    const m = /^https:\/\/wtr-lab\.com\/[^/]+\/novel\/(\d+)(?:\/([^/?#]+))?/.exec(url);
    return m ? { rawId: m[1], slug: m[2] || null } : null;
  }

  // On some sites a novel's info page lives under a different path than its chapters, so "the directory of this page" would
  // give two different keys for one novel (and a glossary bound from the info page would never reach the chapters).
  // These rules map the info page onto the chapter key, so "Use here" means the same wherever you press it.
  // 69shuba: info page /book/<id>(.htm), chapters /txt/<id>/<chapter>.
  const NOVEL_KEY_RULES = [
    { host: "69shuba.com", path: /^\/book\/(\d+)(?:\.htm|\/)?$/, key: (m) => "/txt/" + m[1] }
  ];

  // One key per "novel on a site": host plus the URL directory (or a rule above), the same heuristic used everywhere.
  function bindingKey(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    for (const rule of NOVEL_KEY_RULES) {
      const m = host === rule.host && rule.path.exec(u.pathname);
      if (m) return host + rule.key(m);
    }
    const dir = u.pathname.replace(/\/[^/]*$/, "") || "/";
    return host + dir;
  }

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, "");

  // Substring match first; otherwise an in-order subsequence match, so a typo such as "synesis-wizard" still finds
  // "synthesis-wizard[wtr-lab]". Returns library records, best matches first.
  function search(library, query) {
    const all = Object.values(library || {});
    const q = norm(query || "");
    if (!q) return all.sort((a, b) => a.name.localeCompare(b.name));
    const isSubsequence = (needle, hay) => {
      let i = 0;
      for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
      return false;
    };
    const scored = [];
    for (const g of all) {
      const n = norm(g.name);
      if (n.includes(q)) scored.push([0, g]);
      else if (isSubsequence(q, n)) scored.push([1, g]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, g]) => g);
  }

  // ---------- which of a novel's glossaries are sent (docs/GLOSSARY.md, "Choosing the glossaries sent") ----------
  // A novel's glossaries are lists, each sent or not (its tick on the novel's Glossaries tab), in a fixed order: of two lists with a term, the first gives it.
  //   A site novel's glossary ("wtr-lab:<id>") is several lists, by where each term came from: your own terms on the site, the novel's, the AI's and
  //   its shared one (shared:<name>, Cultivation...). Any other glossary is one list: a file or pasted list ("file:<...>"), a copied novel's ("copy:<id>"),
  //   a shared list ("shared:<name>"), the terms kept from translations ("adopted:<key>").
  //   The order: your terms, the novel's lists, your files, the AI list, the terms kept, shared lists, Cultivation last.
  // Which apply: the novel's own (a site novel's glossary, its implicit one), those bound to its keys (its source's site + folder, and its book), and
  // those for every novel (the binding EVERY; when the library has none: Cultivation). The lists a novel does not send are the binding "off:<book>": list ids,
  // a glossary's id or "<id>#<part>" for a part of a site novel's glossary. (Kept as bindings so that every device and extension has them as they are.)
  const EVERY = "*";
  const EVERY_DEFAULT = ["shared:Cultivation"];
  const offKey = (book) => "off:" + book;
  const isListKey = (key) => key === EVERY || String(key).startsWith("off:"); // (not a novel's key)
  const RANK = { yours: 0, novel: 1, file: 2, ai: 3, kept: 4, shared: 5, cultivation: 6 };
  const isSiteGlossary = (id) => /^wtr-lab:\d+$/.test(String(id));
  const metaOf = (row) => row.slice(2).find((x) => x && typeof x === "object" && !Array.isArray(x));
  // a site novel's glossary's part a term is in: yours, novel, ai or shared:<name>
  const partOf = (o) => (o === "yours" || o === "ai" ? o : typeof o === "string" && o.startsWith("shared:") ? o : "novel");
  function rankOf(gid, part) {
    const p = part || (String(gid).startsWith("shared:") ? gid : "");
    if (p === "shared:Cultivation") return RANK.cultivation;
    if (p.startsWith("shared:")) return RANK.shared;
    if (part) return RANK[part] !== undefined ? RANK[part] : RANK.novel;
    if (gid.startsWith("file:")) return RANK.file;
    if (gid.startsWith("adopted:")) return RANK.kept;
    return RANK.novel;
  }
  // The book a chapter's novel is, as the library names novels: a site novel's chapter "wtr-lab:<id>", any other its site and folder.
  function bookOf(url) {
    const w = parseWtrUrl(String(url || ""));
    if (w) return "wtr-lab:" + w.rawId;
    try { return bindingKey(url); } catch (e) { return ""; }
  }
  // { ids, every }: the glossaries that apply to a novel, its own first (implicit), then those bound to its keys, then those for every novel.
  // bindings: { key: ids | { ids } }
  function glossaryIdsFor(bindings, keys, implicit) {
    const b = bindings || {};
    const ids = [];
    const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
    for (const id of implicit || []) add(id);
    for (const k of keys || []) for (const id of bindingIds(b[k])) add(id);
    const every = Object.prototype.hasOwnProperty.call(b, EVERY) ? bindingIds(b[EVERY]) : EVERY_DEFAULT;
    for (const id of every) add(id);
    return { ids, every: new Set(every) };
  }
  // The lists of a novel's glossaries, in the order they are sent: [{ id, gid, part, name, rank, on, every, hidden, rows }].
  // glossaries: { id: { name, terms: [[source, english, ...]] } } (a row's object says where its term came from: { o }). A shared list that the novel's
  // site glossary carries too is one list (the site's, shown; the other follows its tick: `hidden`).
  function novelLists({ glossaries, bindings, keys, book, implicit }) {
    const { ids, every } = glossaryIdsFor(bindings, keys, implicit);
    const off = new Set(book ? bindingIds((bindings || {})[offKey(book)]) : []);
    const lists = [];
    ids.forEach((gid, at) => {
      const g = (glossaries || {})[gid];
      if (!g || !Array.isArray(g.terms)) return;
      if (!isSiteGlossary(gid)) return void lists.push({ id: gid, gid, part: "", name: g.name || gid, rank: rankOf(gid, ""), at, rows: g.terms });
      const parts = new Map();
      for (const row of g.terms) {
        const meta = metaOf(row);
        const p = partOf(meta && meta.o);
        (parts.get(p) || parts.set(p, []).get(p)).push(row);
      }
      for (const [part, rows] of parts) lists.push({ id: gid + "#" + part, gid, part, name: g.name || gid, rank: rankOf(gid, part), at, rows });
    });
    lists.sort((a, b) => a.rank - b.rank || a.at - b.at);
    for (const l of lists) { l.on = !off.has(l.id); l.every = every.has(l.gid); }
    for (const l of lists) {
      const same = !l.part && l.gid.startsWith("shared:") && lists.find((x) => x.part === l.gid);
      if (same) { l.hidden = true; l.on = l.on && same.on; }
    }
    return lists;
  }
  // The rows sent, of the lists that are on, in their order (a source the first time it comes): [{ row, list }]
  function pickedRows(lists) {
    const seen = new Set();
    const out = [];
    for (const l of lists) {
      if (!l.on) continue;
      for (const row of l.rows) {
        if (!row || !row[0] || !row[1] || seen.has(row[0])) continue;
        seen.add(row[0]);
        out.push({ row, list: l });
      }
    }
    return out;
  }

  // Library terms for the glossaries of the novel of this page, as glossary entries: the lists sent for it (novelLists), in their order. The user's own
  // terms win over library terms for the same source term. book: the novel's (bookOf(url) when not said: a site chapter read from its source names it).
  function boundEntries({ library, bindings, url, ownEntries, hostname, book }) {
    const taken = new Set();
    for (const e of ownEntries || []) {
      if (e.source === "replace" || e.source === "starter") continue; // not source-text terms / generic defaults
      for (const t of e.terms || []) taken.add(t);
    }
    const novel = book || bookOf(url);
    let key = "";
    try { key = bindingKey(url); } catch (e) { /* not a page address */ }
    const lists = novelLists({ glossaries: library, bindings, keys: [key, novel].filter(Boolean), book: novel, implicit: isSiteGlossary(novel) ? [novel] : [] });
    const out = [];
    for (const { row, list } of pickedRows(lists)) {
      const [term, translation] = row;
      if (taken.has(term)) continue;
      taken.add(term);
      // where the term came from (the site's novel list, its AI list, a shared glossary: { o }) and its kind when the library has one ({ k }): TermMatch
      // tells a name from a genre term with them
      const meta = metaOf(row);
      out.push({ terms: [term], translation, scope: "site", hostname, source: "wtr", lib: list.gid, ...(meta && meta.o ? { origin: { o: meta.o } } : {}), ...(meta && meta.k ? { kind: meta.k } : {}) });
    }
    return out;
  }

  // Your own terms, picked in the library's reader ("+ Add Term", or a rendering picked in a glossary term's popup; kept in the library at
  // /api/my-terms), that apply on this page, as glossary entries (read-only here: `lib: "my-terms"`). As on the site they change only what is shown,
  // after the translation (the translator gets the glossary's one rendering of a word): "replace" entries with `mine` set, so they are found the
  // way the library finds them (at a word's edge, `ci` when case does not matter). A term kept for one novel applies on the pages of that novel's
  // chapters: the same site + directory key, or a glossary bound to this page that is the novel's ("wtr-lab:5045": a source site's book read as that
  // The site novel).
  const SOURCE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  function myTermEntries(myTerms, url, bindings) {
    const here = new Set();
    try {
      const key = bindingKey(url);
      here.add(key);
      for (const id of bindingIds((bindings || {})[key])) here.add(id);
    } catch (e) {
      // not a page address: only the terms for every novel
    }
    const out = [];
    for (const t of Array.isArray(myTerms) ? myTerms : []) {
      if (!t || !Array.isArray(t.from) || !t.from.length || typeof t.to !== "string" || !t.to) continue;
      if (Array.isArray(t.keys) && t.keys.length && !t.keys.some((k) => here.has(k))) continue;
      out.push({ terms: t.from.slice(), translation: t.to, scope: "global", source: "replace", lib: "my-terms", mine: true, ci: !t.cs });
    }
    return out;
  }

  // One of your terms' texts as a regex, the way the library finds it: an edge of it that is a letter or digit of a script with spaces between
  // words only at a word's edge ("bell" is not found in "bellow"); Chinese anywhere. A text that ends in a letter is also found with a plural ending
  // ("ju jun" in "ju juns"; applyReplacements gives what it is shown as a plural too).
  function myTermRegex(text, ci) {
    const edge = (ch) => /[\p{L}\p{N}_]/u.test(ch) && !SOURCE_SCRIPT.test(ch);
    const esc = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const last = text[text.length - 1];
    return new RegExp((edge(text[0]) ? "(?<![\\p{L}\\p{N}_])" : "") + esc + (edge(last) ? (/\p{L}/u.test(last) ? "(?<pl>es|s)?" : "") + "(?![\\p{L}\\p{N}_])" : ""), ci ? "giu" : "gu");
  }
  const pluralOf = (w) => (/[^aeiou]y$/i.test(w) ? w.slice(0, -1) + "ies" : /(?:s|x|z|ch|sh)$/i.test(w) ? w + "es" : w + "s");

  // The English fixes ("replace" entries: your own, and your terms from the library's reader) applied to a translation: a literal find and replace on the
  // translator's output, the longest text first, so none of it is sent to the translator.
  function applyReplacements(text, glossary) {
    const rules = (glossary || []).filter((e) => e.source === "replace" && Array.isArray(e.terms) && e.terms.length).sort((a, b) => Math.max(...b.terms.map((t) => t.length)) - Math.max(...a.terms.map((t) => t.length)));
    let result = text;
    for (const rule of rules) {
      for (const oldText of rule.terms) {
        if (!oldText) continue;
        if (rule.mine) result = result.replace(myTermRegex(oldText, rule.ci), (...m) => (typeof m[m.length - 1] === "object" && m[m.length - 1].pl ? pluralOf(rule.translation) : rule.translation));
        else result = result.split(oldText).join(rule.translation);
      }
    }
    return result;
  }

  const api = { toLibraryEntry, personalPairs, personalReplacements, toNovelInfo, cleanDescription, parseVotes, bindingIds, parseWtrUrl, bindingKey, search, boundEntries, myTermEntries, myTermRegex, pluralOf, applyReplacements,
    EVERY, EVERY_DEFAULT, offKey, isListKey, bookOf, glossaryIdsFor, novelLists, pickedRows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WtrTerms = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
