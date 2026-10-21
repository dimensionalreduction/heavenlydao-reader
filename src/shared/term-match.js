// Which terms of a glossary a chapter needs, and where the terms of a novel are mentioned.
//
// Chinese has no spaces between words, so "the text has the term's characters" is not "the text uses the term": 白 is in 明白 and 白色, 道 is in 说道. What is
// sent to the translator with a chapter is chosen here instead of with text.includes:
//   - longest first: a term inside a longer term of the glossary (小纯 in 白小纯, 道 in 天道) is not found there;
//   - a term of one character (a surname, 道, 气) is sent only where it is used as one: as a name (before 师兄, 公子, 先生..., after 小, 老...), or when the term
//     says it always is (match: "always"); `singles` in the options: "context" (this, the default), "off" (never), "always" (as text.includes did);
//   - the parts of a person's name are sent with the full name, not as terms of their own: "傅心汉 (also 傅, 心汉 alone) = Fu Xinhan", so the same person is
//     Fu, Xinhan and Fu Xinhan all through, and 傅 is never "Fu" in a word that is not his name.
// And a novel's index of mentions: for each term, the chapters whose text has it (kept as ranges, "3,5-9"), so the terms of a chapter, the chapters of a
// term and what to send with some chapters are known without reading the text again.
// Pure functions: no storage, no network. Loaded in the background script before gemini.js.
var TermMatch = (function () {
  const chars = (s) => Array.from(String(s || "")).length;

  // What a person's name is followed by when it is a name alone (傅师兄, 傅先生) and what it follows (小傅, 老傅).
  const AFTER = ["师兄", "师姐", "师弟", "师妹", "师父", "师尊", "师叔", "师伯", "师祖", "前辈", "先生", "小姐", "公子", "姑娘", "大人", "长老", "老师", "老爷", "夫人", "少爷", "少主", "掌门", "仙子", "道友", "同学", "同志", "医生", "教授", "老板", "总", "哥", "姐", "叔", "姨", "爷", "家", "兄", "弟", "妹", "氏", "某"];
  const BEFORE = ["小", "老", "大", "阿", "姓", "叫", "名叫", "叫做", "叫作"];
  // Surnames of two characters (a four-character name with one of them splits 2 + 2).
  const COMPOUND = new Set("欧阳 司马 上官 诸葛 东方 皇甫 尉迟 公孙 慕容 长孙 宇文 轩辕 令狐 夏侯 司徒 澹台 公冶 淳于 单于 太叔 申屠 南宫 西门 独孤 端木".split(" "));
  const PERSON = new Set(["person", "people", "name", "character"]);
  const NAMELIKE = new Set(["person", "people", "name", "character", "place", "organization", "creature"]);

  // A capitalised word made only of pinyin syllables (an optional initial, vowels, an optional n / ng): Xu, Xinhan, Ouyang; not Master, Third, Young Master.
  const PINYIN = { test: (w) => /^[A-Z]/.test(w) && /^(?:(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?[aeiouü]+(?:ng|n|r)?)+$/i.test(w) };
  const startsAt = (text, i, words) => words.some((w) => text.startsWith(w, i));
  const endsAt = (text, i, words) => words.some((w) => i >= w.length && text.slice(i - w.length, i) === w);

  // Is the term at text[i .. i+len) used as a name there?
  function nameContext(text, i, len) {
    return startsAt(text, i + len, AFTER) || endsAt(text, i, BEFORE);
  }

  // The parts of a person's name, or null: { surname, given } in the source and the English ("傅心汉" / "Fu Xinhan" -> 傅 / 心汉, Fu / Xinhan).
  // Only names of 2 to 4 characters whose English is two words.
  function splitName(source, english) {
    const src = Array.from(String(source || ""));
    const words = String(english || "").trim().split(/\s+/);
    if (words.length !== 2 || src.length < 2 || src.length > 4 || !src.every((c) => /\p{Script=Han}/u.test(c))) return null;
    if (!PINYIN.test(words[0]) || !PINYIN.test(words[1])) return null; // ("Master Xu" is not a surname and a given name)
    const cut = src.length === 4 ? (COMPOUND.has(src.slice(0, 2).join("")) ? 2 : 0) : 1;
    if (!cut) return null;
    return { surname: src.slice(0, cut).join(""), given: src.slice(cut).join(""), surnameEn: words[0], givenEn: words[1] };
  }

  const isPerson = (e) => !!e.kind && PERSON.has(String(e.kind).toLowerCase());
  // A term made of one character is meant as a name when its kind says a name, or (no kind) its English is a capitalised proper word that does not come from
  // the genre glossaries the site shares between novels (道 = Dao, 气 = Qi).
  function nameLike(e) {
    if (e.kind) return NAMELIKE.has(String(e.kind).toLowerCase());
    const o = String((e.origin && e.origin.o) || e.origin || "");
    return !o.startsWith("shared") && /^[A-Z]/.test(e.translation || "");
  }

  function occurrences(text, term) {
    const out = [];
    for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) out.push(i);
    return out;
  }

  // The places of each term in the text that no longer term takes: -> { free: Map(term -> [positions]), overlaps(position, length) }.
  function segment(text, terms) {
    const uniq = [...new Set(terms)].sort((a, b) => chars(b) - chars(a));
    const claimed = [];
    const overlaps = (i, len) => claimed.some(([a, b]) => i < b && a < i + len);
    const free = new Map();
    // (terms of one length are settled together: two of the same length that cross each other cannot be told apart, so both stay)
    for (let k = 0; k < uniq.length; ) {
      const n = chars(uniq[k]);
      const group = [];
      for (; k < uniq.length && chars(uniq[k]) === n; k++) {
        const mine = occurrences(text, uniq[k]).filter((i) => !overlaps(i, uniq[k].length));
        free.set(uniq[k], mine);
        group.push(...mine.map((i) => [i, i + uniq[k].length]));
      }
      if (n > 1) claimed.push(...group); // (a term of one character takes no place from the parts of a name)
    }
    return { free, overlaps };
  }

  // entries: [{ terms: [source...], translation, kind?, match?: "always", origin? }] (the glossary the chapter would be sent with; entries with no
  // translation are kept as they are: they are terms Gemini is asked to render).
  // options: { singles: "context" | "off" | "always" }
  // -> { entries: the entries to send (a person with `forms`: the parts of the name used alone in this text), found: [sources found, for the index] }
  function select(text, entries, options) {
    text = String(text || "");
    const singles = (options && options.singles) || "context";
    const list = Array.isArray(entries) ? entries : [];
    if (singles === "always") {
      const keep = list.filter((e) => (e.terms || [e.term]).some((t) => t && text.includes(t)));
      return { entries: keep, found: keep.flatMap((e) => (e.terms || [e.term]).filter((t) => t && text.includes(t))) };
    }
    // the text cut into the glossary's terms, longest first (the way a word list reads a text without spaces): a term counts only where no longer term
    // (or an earlier one of its length) already has those characters, so 小纯 in 白小纯 and 道 in 天道 are not found, nor 法修 across 办法|修炼
    const all = [];
    for (const e of list) for (const t of e.terms || [e.term]) if (t) all.push(t);
    const { free: freeAt, overlaps } = segment(text, all);

    const out = [];
    const found = new Set();
    const wholeNames = new Map(); // surname / given -> the entry of the full name it belongs to
    for (const e of list) {
      const sources = (e.terms || [e.term]).filter(Boolean);
      let used = false;
      for (const t of sources) {
        const n = chars(t);
        const free = freeAt.get(t) || [];
        if (!free.length) continue;
        if (n === 1) {
          if (singles === "off") continue;
          const okName = nameLike(e) && free.some((i) => nameContext(text, i, t.length));
          if (!(okName || e.match === "always")) continue;
        }
        used = true;
        found.add(t);
      }
      if (!used) continue;
      out.push(e);
      // a person: the parts of the name that stand alone in this text
      const s0 = sources[0];
      const parts = e.translation && sources.length === 1 ? splitName(s0, e.translation) : null;
      if (parts && (isPerson(e) || !e.kind)) wholeNames.set(e, parts);
    }
    const result = [];
    for (const e of out) {
      const parts = wholeNames.get(e);
      let forms = [];
      if (parts) {
        // used alone: outside the full name and every other longer term (a surname: where it is a name; a given name of two characters: anywhere)
        const alone = (part, needContext) => occurrences(text, part).some((i) => !overlaps(i, part.length) && (!needContext || nameContext(text, i, part.length)));
        if (alone(parts.surname, true)) forms.push(parts.surname + " = " + parts.surnameEn);
        if (chars(parts.given) > 1 && alone(parts.given, false)) forms.push(parts.given + " = " + parts.givenEn);
      }
      result.push(forms.length ? Object.assign({}, e, { forms }) : e);
    }
    // the parts of a name that have entries of their own are in the full name's line now
    const covered = new Set();
    for (const e of result) if (e.forms) for (const f of e.forms) covered.add(f.split(" = ")[0]);
    const final = result.filter((e) => !((e.terms || [e.term]).length === 1 && covered.has((e.terms || [e.term])[0]) && !e.forms));
    return { entries: final, found: [...found] };
  }

  // ---------- a novel's index of mentions ----------
  // { v: 1, last: highest chapter number seen, terms: { <source>: "3,5-9" } }. Chapters are numbers (the chapter's place in the novel).
  const emptyIndex = () => ({ v: 1, last: 0, terms: {} });
  function parseRanges(s) {
    const out = [];
    for (const part of String(s || "").split(",")) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (m) out.push([Number(m[1]), Number(m[2] || m[1])]);
    }
    return out;
  }
  function formatRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged.map(([a, b]) => (a === b ? String(a) : a + "-" + b)).join(",");
  }
  const hasChapter = (s, no) => parseRanges(s).some(([a, b]) => no >= a && no <= b);

  // Records that these sources are in chapter `no` (and drops the chapter from the terms that are not, when it was recorded before). -> the index.
  function record(index, no, sources, allSources) {
    const ix = index && index.v === 1 ? index : emptyIndex();
    if (!Number.isFinite(no) || no < 1) return ix;
    const now = new Set(sources);
    for (const t of now) ix.terms[t] = formatRanges(parseRanges(ix.terms[t]).concat([[no, no]]));
    if (allSources) {
      // (the chapter was read again with the terms known now: a term it no longer has is taken out of it)
      for (const t of allSources) {
        if (now.has(t) || !ix.terms[t] || !hasChapter(ix.terms[t], no)) continue;
        const rest = [];
        for (const [a, b] of parseRanges(ix.terms[t])) {
          if (no < a || no > b) rest.push([a, b]);
          else {
            if (a < no) rest.push([a, no - 1]);
            if (no < b) rest.push([no + 1, b]);
          }
        }
        if (rest.length) ix.terms[t] = formatRanges(rest);
        else delete ix.terms[t];
      }
    }
    ix.last = Math.max(ix.last || 0, no);
    return ix;
  }
  const chaptersOf = (index, source) => parseRanges(index && index.terms && index.terms[source]);
  const countOf = (index, source) => chaptersOf(index, source).reduce((n, [a, b]) => n + (b - a + 1), 0);
  const firstOf = (index, source) => { const r = chaptersOf(index, source); return r.length ? Math.min(...r.map((x) => x[0])) : null; };
  // The sources mentioned in any of these chapters (numbers): what goes with them when they are sent.
  function termsInChapters(index, numbers) {
    const want = new Set(numbers);
    const out = [];
    for (const [t, s] of Object.entries((index && index.terms) || {})) if (parseRanges(s).some(([a, b]) => { for (const n of want) if (n >= a && n <= b) return true; return false; })) out.push(t);
    return out;
  }

  return { select, segment, splitName, nameContext, record, chaptersOf, countOf, firstOf, termsInChapters, parseRanges, formatRanges, emptyIndex, isPerson };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TermMatch;
