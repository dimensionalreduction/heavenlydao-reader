// Notes on a novel's glossary terms ("sect members: - Qi Yuan (ch1)"), kept up to date by Gemini while it translates the novel's chapters, when the
// library's Settings switch it on (settings.termNotesAi in the library; off by default). The notes live in the library
// (/api/term-notes), one per term of a novel; the library shows them on a term's page.
//
// With it on, a chapter goes to Gemini with the notes of the glossary terms that are in it (Gemini's own, and yours as context), and Gemini answers,
// beside the translation, with the notes it changed: what this chapter tells about those terms, each point ending in (chN). Those are saved as
// Gemini's notes; yours are never changed. A chapter that needs no translating (the site's English, or one translated before without notes) can have
// its notes made alone: its English text and the notes go to Gemini in one request (notesOnly). Runs in the background script (it has storage, the library's client and Gemini); needs
// glossary-server.js, wtr-terms.js, term-match.js, pool-hints.js (when there is one) and gemini.js loaded before it.
var TermNotes = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const MAX_ITEMS = 80; // terms of one chapter whose notes are sent, at most

  // The switch, read from the library at most once a minute.
  let setting = { at: 0, on: false };
  async function enabled() {
    if (Date.now() - setting.at < 60 * 1000) return setting.on;
    try {
      const s = await GlossaryServer.api("GET", "/api/settings");
      setting = { at: Date.now(), on: !!(s && s.termNotesAi === true) };
    } catch (e) {
      setting = { at: Date.now(), on: false }; // no server: no notes could be read or kept
    }
    return setting.on;
  }

  // A chapter's number from its title ("第12章 …", "Chapter 12: …") or, failing that, its address (the site's ".../chapter-12"), or null.
  function chapterNumber(title, url) {
    const m = /第\s*(\d+)\s*[章节節回]/.exec(title || "") || /(?:chapter|ch\.?)\s*(\d+)/i.exec(title || "") || /\/chapter-(\d+)(?:[/?#]|$)/.exec(url || "");
    return m ? Number(m[1]) : null;
  }

  // ...or from the novel's chapter list in the library, when the title has none.
  async function numberFromList(url, key) {
    try {
      const { indexes } = await GlossaryServer.api("GET", "/api/chapter-index?key=" + encodeURIComponent(key));
      const bare = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "");
      for (const idx of indexes || []) for (const c of idx.chapters || []) if (bare(c[2]) === bare(url) && Number.isFinite(c[0])) return c[0];
    } catch (e) {
      // no list
    }
    return null;
  }

  // What the novel of a chapter's page is known by: its site + directory, and the glossaries bound to it (a site novel's id among them); a site
  // chapter's novel, by its own id.
  async function novelKeys(url) {
    const key = WtrTerms.bindingKey(url);
    const { glossaryBindings } = await ext.storage.local.get("glossaryBindings");
    const wtr = WtrTerms.parseWtrUrl(url);
    return [...new Set([key, ...(wtr ? ["wtr-lab:" + wtr.rawId] : []), ...WtrTerms.bindingIds((glossaryBindings || {})[key])])];
  }

  // The glossary of a chapter that is already English: the terms of the library's glossaries the novel is known by, as [{ terms: [source], translation }].
  async function glossaryOf(keys) {
    const { glossaryLibrary } = await ext.storage.local.get("glossaryLibrary");
    const out = [];
    for (const id of keys) for (const t of ((glossaryLibrary || {})[id] || {}).terms || []) out.push({ terms: [t[0]], translation: t[1] });
    return out;
  }

  // The chapters whose notes are made (with their translation, or alone), so a chapter is not sent twice: { url: when } in storage, the newest 5000.
  async function isDone(url) {
    const { termNotesDone } = await ext.storage.local.get("termNotesDone");
    return !!(termNotesDone && termNotesDone[url]);
  }
  async function markDone(url) {
    const { termNotesDone } = await ext.storage.local.get("termNotesDone");
    const done = Object.assign({}, termNotesDone, { [url]: Date.now() });
    const urls = Object.keys(done);
    if (urls.length > 5000) for (const u of urls.sort((a, b) => done[a] - done[b]).slice(0, urls.length - 5000)) delete done[u];
    await ext.storage.local.set({ termNotesDone: done });
  }

  // What goes to Gemini with a chapter: { chapter, keys, items: [{ term (its source word), english, note (Gemini's so far), yours }] }, or null when
  // notes are off, the chapter's number is not known (a note says which chapter each point is from), the chapter has none of the glossary's terms,
  // or the notes cannot be read (Gemini would write them anew from this chapter alone).
  // `notes`: from the library's reader, how many chapters from this one are to get notes (0: not this one); not given: the switch alone decides.
  // english: the text is the chapter in English, so its terms are found by their English (at word edges, in their case) and the glossary is the novel's.
  const wanted = async (notesFor) => !(Number.isFinite(notesFor) && notesFor <= 0) && (await enabled());
  async function context(job) {
    const r = await build(job).catch(() => null);
    return r && r.ctx ? r.ctx : null;
  }
  // -> { ctx } or { skip: why there is nothing to send }. Throws when the notes cannot be read (only when `manual`: asked for with the reader's button,
  // which also goes past the switch, since pressing it is asking).
  async function build({ url, title, text, glossary, notes: notesFor, english, manual }) {
    if (!url) return { skip: "no address" };
    if (!manual && !(await wanted(notesFor))) return { skip: "notes are off" };
    const keys = await novelKeys(url);
    const chapter = chapterNumber(title, url) ?? (await numberFromList(url, keys[0]));
    if (chapter == null) return { skip: "the chapter's number is not known (its title has none, and the novel's chapter list does not have it)" };
    if (english) glossary = await glossaryOf(keys);
    const seen = new Set();
    const relevant = [];
    // (the terms found the way they are chosen for a translation: TermMatch, when the text is the original; the English text is searched by its English below)
    const chosen = !english && typeof TermMatch !== "undefined" ? TermMatch.select(String(text), glossary || []).entries : glossary || [];
    for (const e of chosen) {
      const source = (e.terms || [])[0];
      if (!source || e.source === "replace" || seen.has(source)) continue;
      if (english ? !(e.translation && e.translation.length >= 3 && WtrTerms.myTermRegex(e.translation, false).test(String(text))) : !String(text).includes(source)) continue;
      seen.add(source);
      relevant.push({ source, english: e.translation });
    }
    if (!relevant.length) return { skip: "none of the novel's glossary terms is in it" };
    let notes;
    try {
      notes = (await GlossaryServer.api("GET", "/api/term-notes?key=" + encodeURIComponent(keys.join(",")))).notes || [];
    } catch (e) {
      if (manual) throw new Error("the notes could not be read from the library (" + e.message + ")");
      return { skip: "the notes could not be read" };
    }
    const bySource = new Map(notes.map((n) => [n.source, n]));
    // the terms that already have notes first, so the limit leaves out terms nothing is known of yet
    relevant.sort((a, b) => bySource.has(b.source) - bySource.has(a.source));
    const items = relevant.slice(0, MAX_ITEMS).map(({ source, english }) => {
      const n = bySource.get(source);
      return { term: source, english, note: (n && n.ai) || "", yours: (n && n.text) || "" };
    });
    return { ctx: { chapter, keys, items } };
  }

  // Saves the notes Gemini changed (only for terms it was given, and only real changes). Never throws.
  async function save(ctx, updates, novelName) {
    try {
      const given = new Map(ctx.items.map((i) => [i.term, i]));
      const notes = (Array.isArray(updates) ? updates : [])
        .filter((u) => u && given.has(u.term) && typeof u.note === "string" && u.note.trim() && u.note.trim() !== given.get(u.term).note.trim())
        .map((u) => ({ source: u.term, keys: ctx.keys, english: given.get(u.term).english, novel: novelName || "", ai: u.note.trim(), chapter: String(ctx.chapter) }));
      if (notes.length) await GlossaryServer.api("PUT", "/api/term-notes", { notes });
      return notes.length;
    } catch (e) {
      return 0;
    }
  }

  // A language other than English: the novel's glossary in that language, which Gemini builds over time. The glossary bound to the novel (the site's) is in
  // English, so none of its renderings goes to Gemini: its terms are the list of what the novel has, and each term of it in the chapter is given with its
  // rendering in this language when one was made before, else asked for (an entry with no translation: gemini.js translateText), and what Gemini
  // answers is kept as that glossary ("<bound glossary>@<language>", terms of origin "gemini", which the person can change). Without a bound glossary
  // there is nothing to keep it in: the terms the person made are sent as they are.
  async function languageGlossary(lang, job) {
    let id = "";
    let bound = null;
    try {
      const stored = await ext.storage.local.get(["glossaryBindings", "glossaryLibrary"]);
      id = WtrTerms.bindingIds((stored.glossaryBindings || {})[WtrTerms.bindingKey(job.url)])[0] || "";
      // a site chapter's own glossary needs no binding
      if (!id) { const w = WtrTerms.parseWtrUrl(job.url); if (w) id = "wtr-lab:" + w.rawId; }
      bound = id ? (stored.glossaryLibrary || {})[id] || null : null;
    } catch (e) {
      id = "";
    }
    // a novel with no glossary bound has the one it keeps its own terms in (PoolHints: "adopted:<novel key>"), which is where its terms in this language are kept too
    if (!id && typeof PoolHints !== "undefined" && !job.english) {
      try { id = "adopted:" + WtrTerms.bindingKey(job.url); } catch (e) { id = ""; }
    }
    const made = new Map();
    if (id) {
      try {
        const g = await GlossaryServer.api("GET", "/api/glossaries/" + encodeURIComponent(id + "@" + lang));
        for (const row of g.terms || []) made.set(row[0], row[1]);
      } catch (e) {
        // none yet
      }
    }
    const given = new Set();
    const glossary = (job.glossary || []).map((e) => {
      if (e.source !== "wtr") {
        for (const t of e.terms || []) given.add(t);
        return e;
      }
      for (const t of e.terms || []) given.add(t);
      return Object.assign({}, e, { translation: made.get((e.terms || [])[0]) || "" });
    });
    // The site's own English text of a chapter (translated because its source could not be read): there are no source terms in it, so the bound glossary's English
    // renderings found in it are the terms. Each is given with the rendering made before, or asked for, by its English, and kept under its source term.
    const sourceOf = new Map();
    if (job.english && bound && Array.isArray(bound.terms)) {
      const text = String(job.text || "");
      for (const row of bound.terms) {
        const src = row[0];
        const en = row[1];
        if (typeof en !== "string" || en.length < 3 || given.has(en) || sourceOf.has(en) || !text.includes(en)) continue;
        sourceOf.set(en, src);
        given.add(en);
        glossary.push({ terms: [en], translation: made.get(src) || made.get(en) || "", scope: "global", hostname: null, source: "wtr" });
      }
    }
    for (const [term, translation] of made) if (!given.has(term)) glossary.push({ terms: [term], translation, scope: "global", hostname: null, source: "suggested" });
    const name = (id.startsWith("adopted:") && typeof PoolHints !== "undefined" ? PoolHints.keptName(job.url, job.novelName) : (bound && bound.name) || id) + " (" + lang + ")";
    const keep = async (suggestions) => {
      if (!id) return;
      const rows = (suggestions || []).filter((s) => s && s.term && s.translation).map((s) => [sourceOf.get(s.term) || s.term, s.translation]);
      const seen = new Set();
      const terms = rows.filter(([k]) => !made.has(k) && !seen.has(k) && seen.add(k));
      if (!terms.length) return;
      if (id.startsWith("adopted:") && typeof PoolHints !== "undefined") { await PoolHints.keepInLanguage(job.url, id, lang, "gemini", terms, name); return; } // (bound to the novel too)
      await GlossaryServer.api("POST", "/api/glossaries/" + encodeURIComponent(id + "@" + lang) + "/add", {
        name, site: bound && bound.site, rawId: bound && bound.rawId, slug: bound && bound.slug, terms
      }).catch(() => null);
    };
    // what the library's novels agree a term is called in this language (PoolHints): given for the terms asked for, and the terms the glossary has no entry for; kept in the novel
    let used = [];
    let given2 = glossary;
    if (id && typeof PoolHints !== "undefined" && !job.english) {
      const filled = await PoolHints.forLanguage(String(job.text || ""), glossary, lang).catch(() => null);
      if (filled) { given2 = filled.glossary; used = filled.used; }
    }
    const keepPool = async () => { if (used.length) await PoolHints.keepInLanguage(job.url, id, lang, "pool", used.map(([k, v]) => [k, v, "pool"]), name); };
    return { glossary: given2, keep, keepPool };
  }

  // Translates a chapter (gemini.js translateText), with the notes of its terms when they are on, and keeps the notes Gemini answers with.
  // job: { text, glossary, model, url, title, novelName, notes, lang, custom }. Into the language `lang` says, else the one the library says (Translate into; English when none).
  // custom (the reader's Custom prompt, for this one request): { prompt, notes, glossary }: the prompt in place of the one in use, and what goes with it as
  // the person chose (notes: sent even with the switch off; glossary: false leaves it out).
  async function translate(job) {
    const custom = job.custom || null;
    if (typeof PoolShare !== "undefined") PoolShare.maybeRun().catch(() => {}); // (the public pool: once a day, not waited for)
    const want = custom ? !!custom.notes : await wanted(job.notes).catch(() => false);
    const ctx = want ? await context(custom ? Object.assign({}, job, { manual: true }) : job).catch(() => null) : null;
    const lang = job.lang || (typeof GlossaryServer !== "undefined" && GlossaryServer.targetLanguage ? await GlossaryServer.targetLanguage().catch(() => "en") : "en");
    const other = lang !== "en" ? await languageGlossary(lang, job) : null;
    const noGlossary = !!custom && custom.glossary === false;
    const extra = custom ? { prompt: custom.prompt } : undefined;
    let glossary = noGlossary ? [] : other ? other.glossary : job.glossary;
    // English: what the library's novels agree a term is called, for the terms of this chapter the glossary has none of (PoolHints); kept in the novel's glossary once used
    let pooled = [];
    if (!noGlossary && !other && !job.english && typeof PoolHints !== "undefined") {
      pooled = await PoolHints.entriesFor(String(job.text), glossary || []).catch(() => []);
      if (pooled.length) glossary = (glossary || []).concat(pooled);
    }
    const response = await translateText(job.text, glossary, job.model, ctx, lang, extra);
    if (pooled.length && response && !response.error && job.url) await PoolHints.adopt(job.url, pooled, job.novelName);
    // and the terms Gemini suggested from the chapter (English, from its original: a rendering of a source term), kept in the novel for the chapters after
    if (!other && !job.english && !noGlossary && response && !response.error && job.url && typeof PoolHints !== "undefined") await PoolHints.keepSuggestions(job.url, String(job.text), response.suggestions, glossary, job.novelName);
    if (other && response && !response.error) { await other.keep(response.suggestions); await other.keepPool(); }
    if (ctx && response && !response.error && response.notes) await save(ctx, response.notes, job.novelName);
    if (response) delete response.notes;
    if (response && !response.error) response.language = lang; // (which version of the chapter this is: its key says it, see P2PCore.langKey)
    if (want && response && !response.error && job.url) await markDone(job.url).catch(() => {}); // its notes are made: not asked for again alone
    return response;
  }

  // Only the notes, for a chapter that is already English (the site's, or one translated before without notes): its text and the notes of the terms in
  // it go to Gemini, which answers with the notes it changed. A chapter whose notes are made already is not sent again (unless `force`).
  // job: { url, title, text (the English), novelName, notes, force, custom }. `force`: asked for with the reader's button, so sent even if done before or the
  // switch is off. custom: { prompt }, the reader's Custom prompt, used in place of the notes prompt in use. Answers { ok, saved } or { ok, skipped: why not } or { error }.
  async function notesOnly(job) {
    if (!job.force && (await isDone(job.url))) return { ok: true, skipped: "done before" };
    let built;
    try {
      built = await build(Object.assign({}, job, { english: true, manual: !!job.force }));
    } catch (e) {
      return { error: e.message };
    }
    if (!built.ctx) {
      if (built.skip !== "notes are off") await markDone(job.url); // nothing to write for it
      return { ok: true, skipped: built.skip };
    }
    const ctx = built.ctx;
    const { selectedModel } = await ext.storage.local.get("selectedModel");
    const r = await geminiTermNotes(String(job.text).slice(0, 20000), ctx, job.model || selectedModel, job.custom && job.custom.prompt);
    if (r.error) return { error: r.error };
    const saved = await save(ctx, r.notes, job.novelName);
    await markDone(job.url);
    return { ok: true, saved };
  }

  return { translate, notesOnly, context, save, chapterNumber, enabled, isDone };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TermNotes;
