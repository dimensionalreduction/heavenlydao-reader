// The pool: what a library's novels agree a term is called, so a novel starts with it and does not have to find it again.
//
// Each novel's glossary has one English for a source ("散修" = Loose Cultivator). Put the glossaries of all the novels together and the same source has the English
// most of them use; where they differ, that is the pool's, and the others are shown as alternatives. A base layer (base-glossary.js: a publicly shared Cultivation
// glossary) is counted as several novels, so what a library knows only adds to it. What is kept out of the pool:
//   - terms of one character (道, 气: they are in words) and terms too long to be a term (a sentence in a glossary translates worse, not better);
//   - names: a rendering that is only pinyin words (Xiao Yan) is in the pool only when three novels agree on it, which characters of different novels do not;
//   - what is in one novel only: a term needs two novels (the base layer counts for itself).
// Pure functions: no storage, no network. Used by pool-hints.js (what a translation is sent) and the library's Pool page.
var TermPool = (function () {
  const BASE_VOTES = 3; // the base layer's rendering counts as this many novels
  const MIN_NOVELS = 2; // a term needs this many novels (the base layer has them in itself)
  const MIN_NAME = 3; // ...and a rendering that is only pinyin, this many
  const CENTRAL_VOTES = 2; // what the public pool has (what many agreed on, and Gemini checked) counts as this many novels
  const SHARED_VOTES = 2; // a shared glossary (one list, however many novels carry it) counts as this many novels: a curated list stands for itself
  const MAX_SOURCE = 12;
  const MAX_WORDS = 8;

  const chars = (s) => Array.from(String(s)).length;
  // A capitalised word made only of pinyin syllables (Xiao, Yan, Xinhan): see TermMatch's PINYIN.
  const pinyinWord = (w) => /^[A-Z]/.test(w) && /^(?:(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?[aeiouü]+(?:ng|n|r)?)+$/i.test(w.replace(/['’-]/g, ""));
  const nameLike = (en) => {
    const words = String(en).trim().split(/\s+/);
    return words.length <= 3 && words.every(pinyinWord);
  };
  // Is this a pair a pool may have? (a term and a rendering, not a sentence, not a stray character)
  function plausible(source, en) {
    const s = String(source || "").trim();
    const t = String(en || "").trim();
    if (chars(s) < 2 || chars(s) > MAX_SOURCE || !/\p{Script=Han}/u.test(s)) return false;
    if (!t || t.length > 80 || t.split(/\s+/).length > MAX_WORDS || /[.!?;。！？；]/.test(t)) return false;
    return true;
  }

  // glossaries: [{ id, terms: [[source, rendering, { o: list }?]] }], each a novel's (the ones that are copies or adopted terms, and other languages, are left to the caller to leave out)
  // options: { base: [[source, rendering, kind, gender]], central: [[source, rendering]], pins: [[source, rendering]], minNovels, minName, baseVotes }
  // -> { contested: [the same, undecided: terms novels have but disagree on, none with two novels: not in the pool], entries: [{ source, en, n (novels that use it), total (all that have the source), alts: [{ en, n }], base (it is the base layer's), pinned (the person's choice), kind, gender }], by: Map(source -> entry) }
  function build(glossaries, options) {
    const o = options || {};
    const baseVotes = o.baseVotes || BASE_VOTES;
    const minNovels = o.minNovels || MIN_NOVELS;
    const minName = o.minName || MIN_NAME;
    const sharedVotes = o.sharedVotes || SHARED_VOTES;
    const centralVotes = o.centralVotes || CENTRAL_VOTES;
    const votes = new Map(); // source -> Map(lower-cased rendering -> { en, n, forms: Map(form -> count), base })
    const meta = new Map(); // source -> { kind, gender } from the base layer
    const add = (source, en, n, base) => {
      const key = en.toLowerCase();
      const per = votes.get(source) || votes.set(source, new Map()).get(source);
      const v = per.get(key) || per.set(key, { en, n: 0, forms: new Map(), base: false }).get(key);
      v.n += n;
      v.forms.set(en, (v.forms.get(en) || 0) + n);
      if (base) v.base = true;
    };
    const baseSeen = new Set();
    const baseDup = new Set();
    for (const [source, en, kind, gender] of o.base || []) {
      if (!plausible(source, en)) continue;
      const once = source + "|" + en.trim().toLowerCase();
      if (baseDup.has(once)) continue; // (the layer says the same twice: once)
      baseDup.add(once);
      if (!baseSeen.has(source)) { baseSeen.add(source); add(source, en.trim(), baseVotes, true); meta.set(source, { kind: kind || "", gender: gender || "" }); } // (the first of a source is the layer's rendering)
      else add(source, en.trim(), 1, true); // (the layer's own other renderings of it: alternatives)
    }
    // The public pool: [[source, rendering]] that many people agreed on, once each.
    const centralSeen = new Set();
    for (const row of o.central || []) {
      const source = String(row[0] || "").trim();
      const en = String(row[1] || "").trim();
      const once = source + "|" + en.toLowerCase();
      if (!plausible(source, en) || centralSeen.has(once)) continue;
      centralSeen.add(once);
      add(source, en, centralVotes, false);
    }
    // A shared glossary (the site's "Cultivation", in sixteen novels' glossaries) is one list however many novels carry it: it counts once (as two novels), not sixteen times.
    const sharedSeen = new Set();
    for (const g of glossaries || []) {
      const seen = new Set();
      for (const row of g.terms || []) {
        const source = String(row[0] || "").trim();
        const en = String(row[1] || "").trim();
        if (seen.has(source) || !plausible(source, en)) continue;
        seen.add(source); // (a glossary has one rendering of a source: it is one vote)
        const meta = row.slice(2).find((x) => x && typeof x === "object" && !Array.isArray(x));
        if (meta && typeof meta.o === "string" && meta.o.startsWith("shared:")) {
          const once = meta.o + "|" + source + "|" + en.toLowerCase();
          if (sharedSeen.has(once)) continue;
          sharedSeen.add(once);
          add(source, en, sharedVotes, false);
          continue;
        }
        add(source, en, 1, false);
      }
    }
    const entries = [];
    const contested = [];
    for (const [source, per] of votes) {
      const list = [...per.values()].sort((x, y) => y.n - x.n || (y.base ? 1 : 0) - (x.base ? 1 : 0));
      const top = list[0];
      const total = list.reduce((a, v) => a + v.n, 0);
      const fromBase = baseSeen.has(source);
      if (!fromBase && (top.n < minNovels || (nameLike(top.en) && top.n < minName))) {
        // novels that have it but do not agree (each rendering one novel's): not the pool's, listed for the person to pin one
        if (list.length > 1 && total >= minNovels && !nameLike(top.en)) {
          contested.push({ source, en: top.en, n: top.n, total, alts: list.slice(1).map((v) => ({ en: v.en, n: v.n })), base: false, undecided: true, kind: "", gender: "" });
        }
        continue;
      }
      const form = [...top.forms].sort((x, y) => y[1] - x[1])[0][0]; // (the spelling of it most novels use)
      const m = meta.get(source) || {};
      entries.push({ source, en: form, n: top.n, total, alts: list.slice(1).map((v) => ({ en: [...v.forms].sort((x, y) => y[1] - x[1])[0][0], n: v.n })), base: top.base, kind: m.kind || "", gender: m.gender || "" });
    }
    // The person's pins: [[source, rendering]], the pool's rendering whatever the votes (a term one novel has, a name, the base layer's other rendering), the votes' choice beside it.
    for (const [source, en0] of o.pins || []) {
      const en = String(en0 || "").trim();
      const src = String(source || "").trim();
      if (chars(src) < 2 || chars(src) > MAX_SOURCE || !en || en.length > 80) continue;
      const at = entries.findIndex((e) => e.source === src);
      const was = at >= 0 ? entries[at] : null;
      const m = meta.get(src) || {};
      const alts = was ? [{ en: was.en, n: was.n }].concat(was.alts).filter((a) => a.en.toLowerCase() !== en.toLowerCase()) : [];
      const pinned = { source: src, en, n: was && was.en.toLowerCase() === en.toLowerCase() ? was.n : 0, total: was ? was.total : 0, alts, base: false, pinned: true, kind: m.kind || "", gender: m.gender || "" };
      if (at >= 0) entries[at] = pinned; else entries.push(pinned);
    }
    return { entries, contested: contested.filter((c) => !entries.some((e) => e.source === c.source)), by: new Map(entries.map((e) => [e.source, e])) };
  }

  // ---------- for a central pool (not built; what it needs from here) ----------
  // A novel's key that means the same novel on every device of every library: a site novel ("wtr-lab:93016") or a source site's book ("69shuba.com/txt/77582", a glossary
  // "adopted:<that>" kept for it). A copy or an uploaded file (copy:<id>, upload:<id>) is one person's: null.
  function keyOf(id) {
    let s = String(id || "").trim();
    if (s.startsWith("adopted:")) s = s.slice(8);
    if (/^wtr-lab:\d+$/.test(s)) return s;
    if (/^(copy|upload|pool|shared|adopted):/.test(s) || s.includes("@")) return null;
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/\S+$/i.test(s) ? s.replace(/^www\./i, "") : null;
  }
  // What a person's library would add to a public pool if they agreed to: the terms they made themselves (typed or edited: "yours", or Gemini's that they kept: "gemini") in the
  // glossaries of novels that have a stable key, as pairs [source, rendering]; never what came from the site or a copy (novel, ai, shared:<name>, pool, copied), a name, a
  // character or a sentence. No novel, no person, no time with them: a pair is sent once. glossaries: [{ id, terms: [[source, rendering, { o } | "yours"]] }].
  function contribution(glossaries) {
    const pairs = new Map();
    let novels = 0;
    for (const g of glossaries || []) {
      if (!keyOf(g.id)) continue;
      let any = false;
      for (const row of g.terms || []) {
        // who made it: the library's row says (row[2]: "user" the person typed or edited it, "gemini" Gemini's and kept; "wtr", "copied", "pool" are not theirs); a row without that
        // says by its list ("yours", "gemini")
        const owner = row.slice(2).find((x) => typeof x === "string");
        const meta = row.slice(2).find((x) => x && typeof x === "object" && !Array.isArray(x));
        const origin = owner === "user" ? "yours" : owner === "gemini" ? "gemini" : owner === "yours" ? "yours" : owner ? "" : meta && meta.o;
        if (origin !== "yours" && origin !== "gemini") continue;
        const source = String(row[0] || "").trim();
        const en = String(row[1] || "").trim();
        if (!plausible(source, en) || nameLike(en)) continue;
        pairs.set(source + "|" + en.toLowerCase(), [source, en]);
        any = true;
      }
      if (any) novels++;
    }
    return { pairs: [...pairs.values()], novels };
  }

  return { build, plausible, nameLike, keyOf, contribution, BASE_VOTES, SHARED_VOTES, CENTRAL_VOTES, MIN_NOVELS, MIN_NAME };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TermPool;
