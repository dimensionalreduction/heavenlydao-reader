// The pool's terms a chapter is sent with: what the library's novels agree a term is called (term-pool.js), for the terms the chapter has that the novel's own glossary
// has no rendering of, so a new novel (or one with no glossary of its own) starts with "Loose Cultivator" and not whatever Gemini says that day. Own terms always win:
// a source the glossary has is never taken from the pool.
//
// Once a pool term is used in a chapter it is kept in the novel's own glossary ("adopted:<novel key>", bound to the novel, each term marked as the pool's), so the novel
// says it the same way from then on whatever the pool becomes (another novel added, a rendering outvoted): the pool is where a novel starts, not what it follows.
// The terms Gemini suggests while it translates a chapter (names, places, techniques the glossary has no rendering of) are kept there too (keepSuggestions), each marked
// as Gemini's, so the next chapter is given them: a novel with no glossary from the site gets one of its own, and says a name the way it first did.
//
// Runs in the background script (storage, the library's client). Needs term-match.js, term-pool.js, base-glossary.js, wtr-terms.js and glossary-server.js before it.
var PoolHints = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  // The switches (the library's settings poolHints and keepTerms, on unless they say otherwise), read at most once a minute.
  let setting = { at: 0, poolHints: true, keepTerms: true };
  async function settings() {
    if (Date.now() - setting.at < 60 * 1000) return setting;
    try {
      const s = await GlossaryServer.api("GET", "/api/settings");
      setting = { at: Date.now(), poolHints: !(s && s.poolHints === false), keepTerms: !(s && s.keepTerms === false) };
    } catch (e) {
      setting = { at: Date.now(), poolHints: true, keepTerms: true }; // (the library cannot be asked: as they are by default)
    }
    return setting;
  }
  const enabled = async () => (await settings()).poolHints;

  // The pool of a language ("en": the novels' glossaries, the base layer and the public pool (PoolShare); another: the glossaries Gemini made in it, "<id>@<code>"), made again when the library's glossaries
  // change: from the novels' glossaries in the extension's copy of the library (not the copies, the adopted ones and the person's pins: they are not novels of their own), and the
  // renderings the person pinned (the glossary "pool", "pool@<code>").
  let caches = new Map(); // language -> { key, pool }
  async function pool(lang) {
    lang = lang || "en";
    const stored = await ext.storage.local.get(["glossaryLibrary", "glossaryRev", "centralPool"]);
    const library = stored.glossaryLibrary || {};
    const central = lang === "en" && stored.centralPool && Array.isArray(stored.centralPool.entries) ? stored.centralPool : null; // (the public pool, PoolShare: English)
    const key = stored.glossaryRev + ":" + Object.keys(library).length + ":" + (central ? central.at : 0);
    const hit = caches.get(lang);
    if (hit && hit.key === key) return hit.pool;
    const home = (id) => (id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : "en");
    const glossaries = Object.entries(library)
      .filter(([id]) => home(id) === lang && !/^(copy:|adopted:|pool(@|$))/.test(id))
      .map(([id, g]) => ({ id, terms: (g && g.terms) || [] }));
    const pins = ((library[lang === "en" ? "pool" : "pool@" + lang] || {}).terms || []).map((t) => [t[0], t[1]]);
    const built = TermPool.build(glossaries, { base: lang === "en" && typeof BASE_GLOSSARY !== "undefined" ? BASE_GLOSSARY : [], central: central ? central.entries : [], pins });
    caches.set(lang, { key, pool: built });
    return built;
  }

  const asEntry = (e) => ({ terms: [e.source], translation: e.en, scope: "global", hostname: null, source: "pool", origin: { o: "pool" }, ...(e.kind ? { kind: e.kind } : {}), ...(e.gender ? { gender: e.gender } : {}) });

  // The pool's terms in this text that `glossary` has no entry for, chosen the way the whole glossary's are for a translation (TermMatch.select: a pool term inside a longer
  // term of the glossary is not found there). -> entries to send beside the glossary.
  async function entriesFor(text, glossary) {
    if (!(await enabled())) return [];
    const p = await pool("en");
    const have = new Set();
    for (const e of glossary || []) for (const t of e.terms || [e.term]) if (t) have.add(t);
    const candidates = p.entries.filter((e) => !have.has(e.source) && String(text).includes(e.source)).map(asEntry);
    if (!candidates.length) return [];
    const chosen = TermMatch.select(String(text), (glossary || []).concat(candidates)).entries;
    return chosen.filter((e) => e.source === "pool");
  }

  // Adds terms to the novel's own glossary ("adopted:<novel key>": only terms it has none of, so the first rendering of a source stays and one the person changed or deleted
  // is theirs) and binds it to the novel. from: "pool" or "gemini". -> terms added. Never throws: a chapter is not lost for it.
  async function keep(url, from, rows) {
    try {
      if (!rows.length) return 0;
      const key = WtrTerms.bindingKey(url);
      const id = "adopted:" + key;
      const r = await GlossaryServer.api("POST", "/api/glossaries/" + encodeURIComponent(id) + "/add", { from, name: key + " (kept while translating)", site: "adopted", terms: rows });
      const { glossaryBindings } = await ext.storage.local.get("glossaryBindings");
      const ids = WtrTerms.bindingIds((glossaryBindings || {})[key]);
      if (!ids.includes(id)) await GlossaryServer.setBinding(key, ids.concat(id));
      return (r && r.added) || 0;
    } catch (e) {
      return 0;
    }
  }
  // The pool terms a chapter was sent.
  const adopt = (url, entries) => keep(url, "pool", entries.map((e) => [e.terms[0], e.translation, "pool"]));

  // Another language (a chapter translated into it): the terms of the glossary asked for with no rendering in it yet are given the pool's of that language when it has one, and the
  // pool's terms the chapter has that the glossary has no entry for go with it. -> { glossary, used: [[source, rendering]] } (the pool terms the chapter was sent, to be kept).
  async function forLanguage(text, glossary, lang) {
    const list = glossary || [];
    if (!(await enabled())) return { glossary: list, used: [] };
    const p = await pool(lang);
    const used = [];
    const filled = list.map((e) => {
      const source = (e.terms || [e.term])[0];
      const hit = !e.translation && source ? p.by.get(source) : null;
      if (!hit) return e;
      used.push([source, hit.en]);
      return Object.assign({}, e, { translation: hit.en });
    });
    const known = new Set();
    for (const e of filled) for (const t of e.terms || [e.term]) if (t) known.add(t);
    const candidates = p.entries.filter((e) => !known.has(e.source) && String(text).includes(e.source)).map(asEntry);
    if (candidates.length) {
      const chosen = TermMatch.select(String(text), filled.concat(candidates)).entries.filter((e) => e.source === "pool");
      for (const e of chosen) used.push([e.terms[0], e.translation]);
      return { glossary: filled.concat(chosen), used };
    }
    return { glossary: filled, used };
  }
  // The terms of a language kept in the novel (its glossary "<home>@<code>"), bound to it when the home is the novel's own "adopted:<key>". from: "pool" or "gemini".
  async function keepInLanguage(url, home, lang, from, rows, name) {
    try {
      if (!rows.length) return 0;
      const r = await GlossaryServer.api("POST", "/api/glossaries/" + encodeURIComponent(home + "@" + lang) + "/add", { from, name: name || home + " (" + lang + ")", site: "adopted", terms: rows });
      if (home.startsWith("adopted:")) await bind(url, home);
      return (r && r.added) || 0;
    } catch (e) {
      return 0;
    }
  }
  async function bind(url, id) {
    const key = WtrTerms.bindingKey(url);
    const { glossaryBindings } = await ext.storage.local.get("glossaryBindings");
    const ids = WtrTerms.bindingIds((glossaryBindings || {})[key]);
    if (!ids.includes(id)) await GlossaryServer.setBinding(key, ids.concat(id));
  }

  // The terms Gemini suggested from this chapter ({ term, translation, kind }): those that are in its text, are a term (not a character or a sentence), and the glossary it was
  // sent with has no rendering of. At most 60 a chapter.
  async function keepSuggestions(url, text, suggestions, glossary) {
    if (!(await settings()).keepTerms || !Array.isArray(suggestions)) return 0;
    const have = new Set();
    for (const e of glossary || []) for (const t of e.terms || [e.term]) if (t && (e.translation || "")) have.add(t);
    const rows = [];
    for (const s of suggestions) {
      const term = s && typeof s.term === "string" ? s.term.trim() : "";
      const en = s && typeof s.translation === "string" ? s.translation.trim() : "";
      if (!term || !en || have.has(term) || !String(text).includes(term) || !TermPool.plausible(term, en)) continue;
      have.add(term);
      rows.push([term, en]);
      if (rows.length >= 60) break;
    }
    return keep(url, "gemini", rows);
  }

  return { entriesFor, adopt, keepSuggestions, forLanguage, keepInLanguage, pool, enabled };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PoolHints;
