// Benchmark of how well Gemini keeps a novel's names and terms the way the site does, with different glossaries and different ways of choosing the terms sent
// with a chapter. The "right answer" is the site's own glossary for the novel (its novel list, its AI list and the shared glossaries): for every term of it that
// is in a chapter's original text, the chapter's translation should have the site's English for it.
//
// Run it where the extension's code and data are: the extension's service worker console (chrome://extensions > the extension > "service worker"; Firefox:
// about:debugging > Inspect). Paste this whole file, then:
//     const r = await benchGlossary({ novels: [{ glossary: "wtr-lab:102833", raw: "biquge.tw/book/201675/" }], chapters: 8 });
//     copy(JSON.stringify(r, null, 1))      // the numbers, to keep
// It uses the extension's own Gemini key and model (nothing else is sent anywhere), the original chapters it already holds (the raw text of the novel's
// source site: entries `translation:<address>#original`) and the glossary the library gave it (storage.local.glossaryLibrary).
//
// Every condition translates the same chapters in order. After a chapter, the terms Gemini suggested from it are added to the glossary for the next
// ("on a new chapter": a term found in chapter 3 is used from chapter 4). Conditions:
//     shared        only the glossaries the site shares between novels ("Cultivation"...), then what Gemini finds
//     novel         the site's glossary of the novel + the shared ones, then what Gemini finds
//     full          also the site's AI-built list
//     none          nothing from wtr-lab: Gemini alone, building its own as it goes
//     (and any more `opts.bases` gives: bench-run-node.js --pool makes "pool", what the other novels of a library agree on, for a novel with no glossary of its own)
// and each is run with the terms chosen the old way (`always`: text.includes, every one-character term sent wherever its character is) and the new way
// (`context`: TermMatch: longest first, one-character terms only as names, the parts of a name with the full name).
// The numbers for each run: hit% (the site's English is in the translation) for all terms, for names, for the novel's own list, for terms of a single character;
// terms/chapter sent and the prompt's characters; one-character terms sent, and the places in the text where one of them is not a name (the noise); terms Gemini suggested.
async function benchGlossary(opts) {
  opts = opts || {};
  const conditions = opts.conditions || ["shared", "novel", "none"];
  const matching = opts.matching || ["always", "context"];
  const translate = opts.translate || ((text, glossary, extra) => translateText(text, glossary, opts.model, null, "en", extra));
  const storage = opts.storage || (await (typeof browser !== "undefined" ? browser : chrome).storage.local.get(null));

  // The site's English is in the translation: as a whole word or words, in any case, a space or a hyphen between words, "A / B" (either one), and a plural or 's after it
  const hasWord = benchGlossary.hasWord = (text, en) =>
    String(en).split(/\s*\/\s*/).filter(Boolean).some((alt) => {
      const esc = alt.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/(\\?[ -])+/g, "[\\s-]+");
      return new RegExp("(^|[^\\p{L}\\p{N}])" + esc + "(?:'s|’s|s|es)?($|[^\\p{L}\\p{N}])", "iu").test(text);
    });
  const classOf = (origin) => (String(origin).startsWith("shared") ? "shared" : origin === "ai" ? "ai" : origin === "yours" ? "yours" : "novel");
  const metaOf = (row) => row.slice(2).find((x) => x && typeof x === "object" && !Array.isArray(x)) || {};
  const chars = (s) => Array.from(s).length;

  const report = [];
  for (const novel of opts.novels || []) {
    const g = (storage.glossaryLibrary || {})[novel.glossary];
    if (!g) throw new Error("no glossary " + novel.glossary + " in the extension");
    const gold = g.terms.map((row) => ({ terms: [row[0]], translation: row[1], origin: { o: metaOf(row).o || "novel" } }));
    // the original chapters, in the order of their addresses
    const raws = Object.keys(storage)
      .filter((k) => k.startsWith("translation:") && k.endsWith("#original") && k.includes(novel.raw))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((k) => ({ key: k, text: String((storage[k] || {}).translated || ""), title: (storage[k] || {}).pageTitle || "" }))
      .filter((c) => c.text.length > 200)
      .slice(0, opts.chapters || 8);
    if (!raws.length) throw new Error("no original chapters for " + novel.raw);
    // (opts.bases: more starting glossaries by name, for a condition of your own: the terms the other novels of a library agree on...)
    const base = Object.assign({ shared: gold.filter((e) => classOf(e.origin.o) === "shared"), novel: gold.filter((e) => classOf(e.origin.o) !== "ai"), full: gold, none: [] }, opts.bases || {});

    for (const cond of conditions) {
      for (const how of matching) {
        const glossary = base[cond].map((e) => Object.assign({}, e));
        const known = new Set(glossary.map((e) => e.terms[0]));
        const row = { novel: novel.glossary, condition: cond, matching: how, chapters: raws.length, terms: 0, hit: 0, names: 0, nameHit: 0, ownList: 0, ownHit: 0, singles: 0, singleHit: 0,
          sentTerms: 0, promptChars: 0, singlesSent: 0, singlesWrong: 0, suggested: 0, errors: 0 };
        const perTerm = new Map(); // term -> in each chapter that has it, whether the site's English was used

        for (const c of raws) {
          const text = c.text.slice(0, 20000);
          const picked = how === "always" ? glossary.filter((e) => text.includes(e.terms[0])) : TermMatch.select(text, glossary, { singles: how }).entries;
          row.sentTerms += picked.length;
          row.promptChars += picked.map((e) => e.terms.join(" / ") + " = " + e.translation).join("\n").length;
          // the one-character terms sent, and the places in the text where one of them is not a name (where "use this translation" is wrong)
          for (const e of picked) {
            const t = e.terms[0];
            if (chars(t) !== 1) continue;
            row.singlesSent++;
            for (let i = text.indexOf(t); i !== -1; i = text.indexOf(t, i + 1)) if (!TermMatch.nameContext(text, i, t.length)) row.singlesWrong++;
          }
          const res = await translate(text, glossary, how === "always" ? { singles: "always" } : { singles: "context" });
          if (opts.onChapter) opts.onChapter({ novel: novel.glossary, condition: cond, matching: how, chapter: raws.indexOf(c), sent: picked, result: res });
          if (!res || res.error) { row.errors++; continue; }
          // the answer against the site's: every term of its glossary that is in the original
          // (in the original = found the way the terms are cut out of a text, TermMatch.segment: 法修 across 办法|修炼 is not in it)
          const present = TermMatch.segment(text, gold.map((e) => e.terms[0])).free;
          for (const e of gold) {
            const src = e.terms[0];
            if (!(present.get(src) || []).length) continue;
            const single = chars(src) === 1;
            const ok = hasWord(res.translated, e.translation);
            if (single) { row.singles++; row.singleHit += ok ? 1 : 0; continue; } // (a one-character term is counted apart: it is mostly in words that are not it)
            row.terms++; row.hit += ok ? 1 : 0;
            if (!perTerm.has(src)) perTerm.set(src, []);
            perTerm.get(src).push(ok);
            if (/^[A-Z]/.test(e.translation)) { row.names++; row.nameHit += ok ? 1 : 0; }
            if (classOf(e.origin.o) === "novel" || classOf(e.origin.o) === "ai") { row.ownList++; row.ownHit += ok ? 1 : 0; }
          }
          // what Gemini found in it joins the glossary for the next chapter
          for (const s of opts.grow === false ? [] : res.suggestions || []) {
            if (!s || !s.term || !s.translation || known.has(s.term)) continue;
            if (typeof TermPool !== "undefined" && (!TermPool.plausible(s.term, s.translation) || !text.includes(s.term))) continue; // (as the extension keeps them: a term in the chapter, not a character or a sentence)
            known.add(s.term);
            glossary.push({ terms: [s.term], translation: s.translation, kind: s.kind, origin: { o: "gemini" } });
            row.suggested++;
          }
        }
        const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
        const cons = benchGlossary.consistencyOf(perTerm);
        report.push({
          novel: row.novel, condition: cond, matching: how, chapters: row.chapters,
          "hit%": pct(row.hit, row.terms), "names%": pct(row.nameHit, row.names), "ownList%": pct(row.ownHit, row.ownList), "single%": pct(row.singleHit, row.singles),
          "terms/ch": Math.round((10 * row.sentTerms) / row.chapters) / 10, "promptChars/ch": Math.round(row.promptChars / row.chapters),
          "singles/ch": Math.round((10 * row.singlesSent) / row.chapters) / 10, "singlesWrong/ch": Math.round((10 * row.singlesWrong) / row.chapters) / 10, suggested: row.suggested, errors: row.errors,
          consistent: cons,
          counted: { terms: row.terms, names: row.names, ownList: row.ownList, singles: row.singles }
        });
        if (opts.log !== false && typeof console !== "undefined") console.log(JSON.stringify(report[report.length - 1]));
      }
    }
  }
  if (opts.log !== false && typeof console !== "undefined" && console.table) console.table(report.map(({ counted, ...r }) => r));
  return report;
}
// Of the terms that are in two chapters or more: how many have the site's English in all of them (always), in some of them (mixed: the same term written two
// ways, the Bai / White case), in none (never). perTerm: Map(term -> [true / false per chapter]).
benchGlossary.consistencyOf = (perTerm) => {
  let always = 0, mixed = 0, never = 0;
  for (const hits of perTerm.values()) {
    if (hits.length < 2) continue;
    const n = hits.filter(Boolean).length;
    if (n === hits.length) always++; else if (n === 0) never++; else mixed++;
  }
  const total = always + mixed + never;
  return { repeated: total, "always%": total ? Math.round((1000 * always) / total) / 10 : null, "mixed%": total ? Math.round((1000 * mixed) / total) / 10 : null, "never%": total ? Math.round((1000 * never) / total) / 10 : null };
};
if (typeof module !== "undefined" && module.exports) module.exports = benchGlossary;
