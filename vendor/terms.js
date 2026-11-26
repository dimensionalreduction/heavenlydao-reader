// Finds a glossary's terms in a chapter's English text, so the reader can highlight them.
//
// Only data the site already holds is used: the glossaries fetched from the glossary server (each term has its source word, its
// English rendering, who owns it, where it came from and the usage counts), never a request to the translation site. The English rendering is what
// shows up in the translated text, so that is what is searched for.
(function (root) {
  const MIN_LEN = 3; // "AI", "He" would light up everywhere
  const PLURAL_MIN_LEN = 6; // terms at least this long also match with a plural "s" / "es"
  // A term in a script that has no spaces between words (Chinese, Thai...) or that attaches its endings to the word (Sinhala, Hindi, Tamil...) is found anywhere in a
  // word, not only at its edges: "the Silver Moon Flower" must not be found inside "the Silver Moon Flowerbed", but a Sinhala name with its ending on it is the name.
  const LOOSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Sinhala}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Devanagari}]/u;
  const isLoose = (w) => LOOSE_SCRIPT.test(w[0]) || LOOSE_SCRIPT.test(w[w.length - 1]);

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "yours" once you added or edited a term; otherwise which translation-site list it came from: novel | ai | shared.
  function originOf(owner, meta) {
    if (owner === "user") return "yours";
    const o = (meta && meta.o) || "novel";
    return o.startsWith("shared") ? "shared" : o;
  }

  // One entry per term of a glossary { id, name, terms: [[source, english, owner, {o, n, v}], ...] }.
  function entriesFromGlossary(g) {
    return (g.terms || []).map(([source, english, owner, meta]) => ({
      source,
      english,
      owner,
      origin: originOf(owner, meta),
      n: meta && meta.n,
      v: (meta && meta.v) || [],
      glossaryId: g.id,
      glossaryName: g.name
    }));
  }

  // Several glossaries can define the same term; the first one listed wins.
  function dedupe(entries) {
    const seen = new Set();
    return entries.filter((e) => {
      const k = e.source + "\u0000" + e.english;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // entries -> { regex, by: Map<english, entry[]> } or null when there is nothing worth searching for.
  // Longest renderings are tried first, so "Silver Moon Flower" wins over "Silver Moon". Matching is case-sensitive (a name like "Key"
  // must not light up the word "key") and only at word edges (so "Sunan" is not found inside "Sunanda").
  function buildMatcher(entries) {
    const by = new Map();
    for (const e of entries) {
      const en = String(e.english || "").trim();
      if (en.length < MIN_LEN) continue;
      if (!by.has(en)) by.set(en, []);
      by.get(en).push(e);
    }
    if (!by.size) return null;
    const words = [...by.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
    // A longer term may be followed by a plural ("the Silver Moon Flowers"); a short one such as the name "Key" may not, or it would
    // light up the ordinary word "Keys".
    const loose = words.filter(isLoose);
    const tight = words.filter((w) => !isLoose(w));
    const long = tight.filter((w) => w.length >= PLURAL_MIN_LEN);
    const short = tight.filter((w) => w.length < PLURAL_MIN_LEN);
    const alt = [];
    if (long.length) alt.push("(?<long>" + long.map(escapeRegExp).join("|") + ")(?:es|s)?");
    if (short.length) alt.push("(?<short>" + short.map(escapeRegExp).join("|") + ")");
    const parts = [];
    if (alt.length) parts.push("(?<![\\p{L}\\p{N}_])(?:" + alt.join("|") + ")(?![\\p{L}\\p{N}_])");
    if (loose.length) parts.push("(?<loose>" + loose.map(escapeRegExp).join("|") + ")");
    const regex = new RegExp(parts.join("|"), "gu");
    return { regex, by };
  }

  // text -> [{ text }, { text, entries }, ...]: plain stretches and matched terms, in order.
  function split(text, matcher) {
    if (!matcher || !text) return [{ text }];
    const out = [];
    let last = 0;
    for (const m of text.matchAll(matcher.regex)) {
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: m[0], entries: matcher.by.get(m.groups.long || m.groups.short || m.groups.loose) }); // the term itself, without a plural ending
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  // ---- your own terms: text picked in the reader ("+ Add Term", as on the translation site), shown as something else ----
  // A term is { id, from: [text, ...], to, cs, novel, keys: [...] } (see /api/my-terms): each text in `from` is shown as `to`.

  // Chinese, Japanese or Korean: the original text of a chapter. A term in it also goes to the translator (the extension reads it).
  const SOURCE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const isSourceText = (s) => SOURCE_SCRIPT.test(String(s || ""));

  // The terms for a novel known by these keys (its translation-site ids, the site + directory keys of its chapters): a term without keys is for every novel.
  function myTermsFor(terms, novelKeys) {
    const keys = new Set(novelKeys || []);
    return (terms || []).filter((t) => t && Array.isArray(t.from) && t.to && (!(t.keys && t.keys.length) || t.keys.some((k) => keys.has(k))));
  }

  // A text of yours that ends in a letter is also found with a plural ending ("ju jun" in "ju juns"), and what it is shown as takes one too ("jade slips").
  const PLURAL_TAIL = "(?:es|s)?";
  const pluralOf = (w) => (/[^aeiou]y$/i.test(w) ? w.slice(0, -1) + "ies" : /(?:s|x|z|ch|sh)$/i.test(w) ? w + "es" : w + "s");

  // "a|b | c" -> ["a", "b", "c"]: the variations of one text, as typed (the translation site's "+ Variation" adds a "|").
  const variations = (text) => [...new Set(String(text || "").split("|").map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean))];

  // terms -> { cs, ci } (a regex and what each text it finds stands for, one for case-sensitive terms and one for the others), or null. Longest texts first
  // ("Qi Yuan's" before "Qi Yuan"). The end of a text that is a letter or digit of a script with spaces between words is only found at a word's edge (so
  // "bell" is not found in "bellow"); Chinese has no spaces between words, so a Chinese text is found anywhere. A newer term wins over an older one for
  // the same text.
  function buildReplacer(terms) {
    const make = (list, flags) => {
      const by = new Map();
      for (const t of list.slice().sort((a, b) => (b.at || 0) - (a.at || 0))) {
        for (const f of t.from) {
          const k = flags.includes("i") ? f.toLowerCase() : f;
          if (f && !by.has(k)) by.set(k, { text: f, term: t });
        }
      }
      if (!by.size) return null;
      const word = /[\p{L}\p{N}_]/u;
      const edge = (ch) => word.test(ch) && !SOURCE_SCRIPT.test(ch);
      const alts = [...by.values()].map((x) => x.text).sort((a, b) => b.length - a.length || a.localeCompare(b)).map((f) =>
        (edge(f[0]) ? "(?<![\\p{L}\\p{N}_])" : "") + escapeRegExp(f) + (edge(f[f.length - 1]) ? (/\p{L}$/u.test(f) ? PLURAL_TAIL : "") + "(?![\\p{L}\\p{N}_])" : ""));
      return { regex: new RegExp(alts.join("|"), flags), by, lower: flags.includes("i") };
    };
    const ok = (terms || []).filter((t) => t && Array.isArray(t.from) && t.to); // (which novel's they are was decided by the caller)
    const cs = make(ok.filter((t) => t.cs), "gu");
    const ci = make(ok.filter((t) => !t.cs), "giu");
    return cs || ci ? { cs, ci } : null;
  }

  // The term a found text stands for, and whether it was found with a plural ending: the text itself first (a term of yours may be the plural), else without "es" / "s".
  function termFound(r, found) {
    const key = (x) => (r.lower ? x.toLowerCase() : x);
    if (r.by.has(key(found))) return { hit: r.by.get(key(found)), plural: false };
    for (const tail of ["es", "s"]) {
      const base = found.slice(0, found.length - tail.length);
      if (found.length > tail.length && key(found.slice(base.length)) === tail && r.by.has(key(base))) return { hit: r.by.get(key(base)), plural: true };
    }
    return null;
  }

  // text -> [{ text }, { text: what it is shown as, was: the text found, term }, ...] in order. Where two terms are found at the same place the longer
  // text wins, and a case-sensitive term wins a tie (it says more).
  function replaceSplit(text, replacer) {
    if (!replacer || !text) return [{ text }];
    const hits = [];
    for (const r of [replacer.cs, replacer.ci]) {
      if (!r) continue;
      for (const m of text.matchAll(r.regex)) {
        const found = termFound(r, m[0]);
        if (found) hits.push({ at: m.index, end: m.index + m[0].length, was: m[0], term: found.hit.term, plural: found.plural, cs: !r.lower });
      }
    }
    hits.sort((a, b) => a.at - b.at || b.end - a.end || b.cs - a.cs);
    const out = [];
    let last = 0;
    for (const h of hits) {
      if (h.at < last) continue; // inside one already taken
      if (h.at > last) out.push({ text: text.slice(last, h.at) });
      out.push({ text: h.plural ? pluralOf(h.term.to) : h.term.to, was: h.was, term: h.term });
      last = h.end;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  // Does this term of yours stand for this text (one of its texts, in its case when it is case sensitive)?
  const termHas = (t, text) => t.from.some((f) => (t.cs ? f === text : f.toLowerCase() === String(text).toLowerCase()));

  // The term of yours a glossary term is shown as, or null: the newest that names its English (the text the translation has).
  function shownAs(entry, terms) {
    const hits = (terms || []).filter((t) => t && Array.isArray(t.from) && t.to && termHas(t, entry.english));
    return hits.sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  }

  // What a glossary term can be shown as, as on the translation site's popover: the translator writes `entry.english` (the one rendering it is given); after it, the
  // text can show another one instead. Returns [{ to, n, from: ["wtr" | "glossary" | "yours"], glossaries: [name], term }], one per rendering
  // (whatever its case), the one readers chose most first: what the translation site's readers chose (n of them), what another glossary of this novel says for the
  // same source word, and your terms for it (`terms`: the ones for this novel). The translator's own rendering is only listed when one of them gives it.
  function alternatives(entry, allEntries, terms) {
    const byText = new Map();
    const add = (to, from, extra) => {
      const text = String(to || "").trim();
      if (!text) return;
      const k = text.toLowerCase();
      if (!byText.has(k)) byText.set(k, { to: text, n: undefined, from: [], glossaries: [], term: null });
      const alt = byText.get(k);
      if (!alt.from.includes(from)) alt.from.push(from);
      if (extra.n !== undefined) alt.n = Math.max(alt.n || 0, extra.n);
      if (extra.glossary && !alt.glossaries.includes(extra.glossary)) alt.glossaries.push(extra.glossary);
      if (extra.term && !alt.term) alt.term = extra.term;
    };
    for (const [to, n] of entry.v || []) add(to, "wtr", { n });
    for (const e of allEntries || []) if (e.source === entry.source && e.english !== entry.english) add(e.english, "glossary", { glossary: e.glossaryName });
    for (const t of (terms || []).filter((t) => t && Array.isArray(t.from) && t.to && (termHas(t, entry.english) || t.from.includes(entry.source)))) add(t.to, "yours", { term: t });
    return [...byText.values()].sort((a, b) => (b.n ?? -1) - (a.n ?? -1));
  }

  // ---- where each term appears: a chapter's record, for finding a term again in the chapters it is in ----
  const AROUND = 60; // characters kept on each side of a term in its snippet, at most
  const SENTENCE_END = /[.!?。！？\n]/;

  // A chapter's text -> { [source word]: [how many times, a snippet around the first time, where the term starts in the snippet, its length] },
  // for every glossary term found (by its English, as the reader marks it). The snippet is the sentence it is in, cut ("…") to 60 characters on
  // each side of it.
  function occurrences(text, matcher) {
    const out = {};
    if (!matcher || !text) return out;
    text = String(text);
    for (const m of text.matchAll(matcher.regex)) {
      for (const e of matcher.by.get(m.groups.long || m.groups.short || m.groups.loose) || []) {
        if (out[e.source]) { out[e.source][0]++; continue; }
        const termEnd = m.index + m[0].length;
        let sentStart = m.index;
        while (sentStart > 0 && m.index - sentStart <= AROUND && !SENTENCE_END.test(text[sentStart - 1])) sentStart--;
        const endRel = text.slice(termEnd, termEnd + AROUND + 1).search(SENTENCE_END);
        const sentEnd = endRel < 0 ? Math.min(text.length, termEnd + AROUND + 1) : termEnd + endRel + 1;
        const start = Math.max(sentStart, m.index - AROUND);
        const end = Math.min(sentEnd, termEnd + AROUND);
        const raw = text.slice(start, end);
        const pre = start > 0 && !SENTENCE_END.test(text[start - 1]) ? "…" : "";
        const post = end < text.length && !SENTENCE_END.test(text[end - 1]) ? "…" : "";
        const lead = raw.length - raw.trimStart().length;
        out[e.source] = [1, pre + raw.trim() + post, pre.length + m.index - start - lead, m[0].length];
      }
    }
    return out;
  }

  // What the terms are, as one short string: a chapter's record is made again when this changes (a term added, removed or rendered otherwise),
  // not when only the usage counts change.
  function termsSignature(entries) {
    let h = 0;
    for (const s of (entries || []).map((e) => e.source + "\u0001" + e.english).sort()) for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (entries || []).length + ":" + (h >>> 0).toString(36);
  }

  // ---- notes on terms ("sect members: - Qi Yuan (ch1)") ----
  // A note names other terms by their English: the glossary's, or the rendering you picked for one (your terms), so both are found.
  function noteEntries(entries, terms) {
    const out = (entries || []).slice();
    for (const e of entries || []) {
      const t = shownAs(e, terms);
      if (t && t.to.toLowerCase() !== e.english.toLowerCase()) out.push(Object.assign({}, e, { english: t.to }));
    }
    return out;
  }

  const CH_REF = /\(\s*ch(?:apter)?\.?\s*(\d+)\s*\)/gi;
  // One line of a note -> [{ text }, { text, entries } (a term it names), { text, ch } (a chapter it points to: "(ch12)")], in order.
  function noteParts(line, matcher) {
    const out = [];
    for (const seg of split(String(line || ""), matcher)) {
      if (seg.entries) { out.push(seg); continue; }
      let last = 0;
      for (const m of seg.text.matchAll(CH_REF)) {
        if (m.index > last) out.push({ text: seg.text.slice(last, m.index) });
        out.push({ text: m[0], ch: Number(m[1]) });
        last = m.index + m[0].length;
      }
      if (last < seg.text.length) out.push({ text: seg.text.slice(last) });
    }
    return out.length ? out : [{ text: "" }];
  }

  // The lines of a note that name the term with this source word (for "Mentioned in" on that term's page).
  function mentionLines(text, source, matcher) {
    if (!matcher || !text) return [];
    return String(text).split("\n").map((l) => l.trim()).filter((l) => l && split(l, matcher).some((s) => s.entries && s.entries.some((e) => e.source === source)));
  }

  const api = { originOf, entriesFromGlossary, dedupe, buildMatcher, split, MIN_LEN, isSourceText, myTermsFor, variations, buildReplacer, replaceSplit, pluralOf, shownAs, alternatives, occurrences, termsSignature, noteEntries, noteParts, mentionLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Terms = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
