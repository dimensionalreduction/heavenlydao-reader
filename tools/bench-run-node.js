// Runs the glossary benchmark (bench-glossary.js) from Node, with the real extension code (gemini.js, term-match.js, wtr-terms.js) and no browser:
//   node tools/bench-run-node.js --glossary 93016 --chapters chapters.json [--n 8] [--model gemini-3.5-flash] [--rate 12]
//        [--conditions shared,novel,none] [--matching always,context] [--out results.json]
//        [--no-grow]  Gemini's suggestions are not carried into the next chapter (what the extension does today for English)
//        [--pool 1669,212,...]  the raw ids of other novels: their glossaries are put together by the extension's pool code (term-pool.js) as the
//                               condition "pool", the terms a novel with no glossary of its own would be given by a library that has those novels
// --glossary: the site's raw id; its glossaries are read from the site (the same file the extension reads) and made into the library's list (WtrTerms).
// --chapters: [{ title, url, text }] in reading order: the original text of the novel's chapters (Simplified Chinese, as the site's glossary is).
// The Gemini key is read from GEMINI-API-KEY in the .env at the repo's root (or the GEMINI_API_KEY environment variable) and is never printed.
// Requests wait for their turn at --rate a minute (the extension's own limit, gemini.js geminiTurn).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : def; };
const shared = path.join(__dirname, "..", "src", "shared");

function readKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const m = /^\s*GEMINI[-_]API[-_]KEY\s*=\s*(.+?)\s*$/m.exec(env);
  if (!m) throw new Error("no GEMINI-API-KEY in .env");
  return m[1].replace(/^["']|["']$/g, "");
}

(async () => {
  const key = readKey();
  const redact = (s) => String(s).split(key).join("<key>");
  const rawId = arg("glossary");
  const chapters = JSON.parse(fs.readFileSync(arg("chapters"), "utf8"));
  const model = arg("model", "gemini-3.5-flash");
  const rate = Number(arg("rate", 12));

  // the extension's code, in a context with a storage that has the key, and a library stand-in with the rate
  const ctx = vm.createContext({
    chrome: { storage: { local: { get: async () => ({ geminiApiKey: key }) } } },
    GlossaryServer: { promptSettings: async () => ({ sets: {}, legacy: {} }), geminiRate: async () => rate },
    fetch, setTimeout, clearTimeout, Date, Promise, JSON, console, URL, TextEncoder, TextDecoder
  });
  for (const f of ["term-match.js", "wtr-terms.js", "base-glossary.js", "term-pool.js", "gemini.js"]) vm.runInContext(fs.readFileSync(path.join(shared, f), "utf8"), ctx, { filename: f });
  vm.runInContext("globalThis.api = { translateText, WtrTerms, TermMatch, TermPool, BASE_GLOSSARY };", ctx);
  global.TermMatch = ctx.api.TermMatch;
  global.TermPool = ctx.api.TermPool;
  const bench = require("./bench-glossary.js");

  const res = await fetch("https://wtr-lab.com/api/v2/reader/terms/" + rawId + ".json", { headers: { "User-Agent": "Mozilla/5.0" } });
  const entry = ctx.api.WtrTerms.toLibraryEntry(await res.json(), rawId, "novel-" + rawId, []);
  if (!entry) throw new Error("The site has no glossary for " + rawId);
  const storage = { glossaryLibrary: { ["wtr-lab:" + rawId]: entry } };
  for (const c of chapters) storage["translation:" + c.url + "#original"] = { translated: c.text, pageTitle: c.title };
  const origins = {};
  for (const t of entry.terms) { const o = String((t[2] || {}).o || "?").replace(/^shared:.*/, "shared"); origins[o] = (origins[o] || 0) + 1; }
  console.log("glossary", rawId, entry.terms.length, "terms", JSON.stringify(origins), "| chapters", chapters.length, "| model", model, "| " + rate + " requests a minute");

  // the pool of other novels, made by the extension's own pool code (term-pool.js: the most used rendering, a shared glossary one vote, no names, the public Cultivation
  // glossary as its base layer)
  const bases = {};
  if (arg("pool")) {
    const cache = path.join(process.cwd(), "pool-cache2.json");
    const have = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : {};
    for (const id of arg("pool").split(",")) {
      if (have[id]) continue;
      const r = await fetch("https://wtr-lab.com/api/v2/reader/terms/" + id + ".json", { headers: { "User-Agent": "Mozilla/5.0" } });
      const e = ctx.api.WtrTerms.toLibraryEntry(await r.json(), id, "n", []);
      have[id] = e ? e.terms : [];
      fs.writeFileSync(cache, JSON.stringify(have));
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    const built = ctx.api.TermPool.build(arg("pool").split(",").map((id) => ({ id, terms: have[id] })), { base: ctx.api.BASE_GLOSSARY });
    bases.pool = built.entries.map((e) => ({ terms: [e.source], translation: e.en, origin: { o: "pool" }, ...(e.gender ? { gender: e.gender } : {}) }));
    console.log("pool of", arg("pool").split(",").length, "novels:", bases.pool.length, "terms (" + built.entries.filter((e) => e.base).length + " from the base layer)");
  }
  const saved = [];
  const started = Date.now();
  const report = await bench({
    novels: [{ glossary: "wtr-lab:" + rawId, raw: "" }],
    chapters: Number(arg("n", 8)), model, storage, bases, grow: process.argv.indexOf("--no-grow") < 0,
    conditions: arg("conditions", "shared,novel,none").split(","), matching: arg("matching", "always,context").split(","),
    translate: async (text, glossary, extra) => {
      // (a model that is busy, or a minute's limit, answers with an error: asked again after a wait, up to 6 times)
      for (let attempt = 1; ; attempt++) {
        const r = await ctx.api.translateText(text, glossary, model, null, "en", extra).catch((e) => ({ error: redact(e.message) }));
        if (!r.error || attempt >= 6 || !/high demand|overloaded|quota|rate|try again|unavailable|503|429/i.test(r.error)) return r.error ? { error: redact(r.error) } : r;
        process.stdout.write("  (busy, again in " + 20 * attempt + " s)\n");
        await new Promise((ok) => setTimeout(ok, 20000 * attempt));
      }
    },
    onChapter: (c) => {
      saved.push({ condition: c.condition, matching: c.matching, chapter: c.chapter, sent: c.sent.map((e) => [e.terms[0], e.translation, e.forms || undefined]), error: c.result && c.result.error ? redact(c.result.error) : undefined,
        translated: c.result && c.result.translated, suggestions: c.result && c.result.suggestions });
      process.stdout.write(c.condition + "/" + c.matching + " ch" + (c.chapter + 1) + (c.result && c.result.error ? " ERROR " + redact(c.result.error).slice(0, 80) : " ok") + "  (" + Math.round((Date.now() - started) / 1000) + "s)\n");
    }
  });
  const out = arg("out", path.join(process.cwd(), "bench-" + rawId + ".json"));
  fs.writeFileSync(out, JSON.stringify({ rawId, model, rate, gold: entry.terms, report, runs: saved }, null, 1));
  console.log("saved", out);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
