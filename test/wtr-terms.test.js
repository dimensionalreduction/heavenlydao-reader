// Run: node test/wtr-terms.test.js
const assert = require("assert");
const W = require("../src/shared/wtr-terms.js");

const response = {
  success: true,
  raw_id: 8053,
  glossaries: [
    { raw_id: 8053, data: { type: "raw", terms: [[["Corey"], "科雷", 1, 0, 0], [["Sheen"], "希恩", 1, 0, 0], [[""], "空", 1, 0, 0], [["Dup"], "科雷", 1, 0, 0]] } },
    { id: 17, title: "Cultivation", data: { type: "generic", terms: [[["Dao"], "道", 1, 3, 0]] } },
    { raw_id: 8053, data: { type: "raw", build: 26, replacements: [], terms: [[["Star Alliance"], "星盟", 2, 3, 760]] } }
  ]
};

// capture: all three lists, each term tagged with where it came from; novel > ai > shared; bad/duplicate rows dropped
const entry = W.toLibraryEntry(response, 8053, "synthesis-wizard");
assert.strictEqual(entry.id, "wtr-lab:8053");
assert.strictEqual(entry.name, "synthesis-wizard[wtr-lab]");
assert.deepStrictEqual(entry.terms, [
  ["科雷", "Corey", { o: "novel" }], ["希恩", "Sheen", { o: "novel" }],
  ["星盟", "Star Alliance", { o: "ai" }],
  ["道", "Dao", { o: "shared:Cultivation" }]
]);
assert.deepStrictEqual(entry.counts, { novel: 2, ai: 1, shared: 1 });
assert.strictEqual(W.toLibraryEntry({ success: true, glossaries: [] }, 1, "x"), null, "nothing to import -> null");
assert.throws(() => W.toLibraryEntry({ success: false }, 1, "x"));
assert.strictEqual(W.toLibraryEntry(response, 77, null).name, "novel-77[wtr-lab]", "falls back when the URL has no slug");

// the person's own terms on the site (/api/v2/user/config), as the site sends them: [id, english, "source|source", caseSensitive, [serie ids] | null, raw id, …]
const config = { config: { version: 3, terms: [
  ["1", "taken action", "出手", false, null, 0],
  ["2", "Eight Armed Race", "八臂族|八臂部落", false, [1661], 8053, "id.patch.1", "八臂族"],
  ["3", "Star Devourer", "Star-eater", false, [1661], 8053], // English "source": a fix of the site's English, not a term of the novel
  ["4", "Someone Else's", "别的书", false, [9], 999, "id.raw.999", "别的书"],
  ["5", "Corey Prime", "科雷", false, [1661], 8053], // beats the site's own rendering of the same term
  ["6", "Everywhere Wins Not", "八臂族", false, null, 0], // for every novel: the one made for this novel comes first
  ["bad"], null, ["7", "", "空", false, null, 0]
] } };
assert.deepStrictEqual(W.personalPairs(config, 8053), [["八臂族", "Eight Armed Race"], ["八臂部落", "Eight Armed Race"], ["科雷", "Corey Prime"], ["出手", "taken action"]]);
assert.deepStrictEqual(W.personalPairs(config, 999), [["别的书", "Someone Else's"], ["出手", "taken action"], ["八臂族", "Everywhere Wins Not"]], "another novel: its own, then the ones for every novel");
// the English "sources": fixes of the site's English text, for the library's reader's terms (shown after the translation)
assert.deepStrictEqual(W.personalReplacements(config, 8053), [{ id: "wtr-3", from: ["Star-eater"], to: "Star Devourer", cs: false, global: false }], "only the row whose source is English");
const config2 = { config: { terms: [["1765179657487", "Star Devourer", "Star-eater|Star Eater|星吞者", true, [1661], 8053], ["1765201024612", "Planet Lord", "Sphere Lord", false, null, 0], ["1765201024613", "Other", "Elsewhere", false, [9], 999], ["1765201024614", "Skip", "科雷", false, [1661], 8053]] } };
assert.deepStrictEqual(W.personalReplacements(config2, 8053), [
  { id: "wtr-1765179657487", from: ["Star-eater", "Star Eater"], to: "Star Devourer", cs: true, global: false },
  { id: "wtr-1765201024612", from: ["Sphere Lord"], to: "Planet Lord", cs: false, global: true }
], "this novel's and every novel's, the English texts only; a row with only a Chinese source is a term of the glossary, not one of these");
assert.deepStrictEqual(W.personalReplacements(null, 1), []);
assert.deepStrictEqual(W.personalPairs({ success: false }, 8053), []);
assert.deepStrictEqual(W.personalPairs(null, 8053), []);
const mine = W.toLibraryEntry(response, 8053, "synthesis-wizard", W.personalPairs(config, 8053));
assert.deepStrictEqual(mine.terms.slice(0, 4), [["八臂族", "Eight Armed Race", { o: "yours" }], ["八臂部落", "Eight Armed Race", { o: "yours" }], ["科雷", "Corey Prime", { o: "yours" }], ["出手", "taken action", { o: "yours" }]], "yours first");
assert.ok(mine.terms.some((t) => t[0] === "希恩" && t[1] === "Sheen" && t[2].o === "novel") && !mine.terms.some((t) => t[0] === "科雷" && t[1] === "Corey"), "the novel's own list follows, a term of yours replaces wtr-lab's rendering of it");
assert.strictEqual(mine.counts.mine, 4);
assert.ok(W.toLibraryEntry({ success: true, glossaries: [] }, 1, "x", [["道", "Dao"]]), "terms of yours alone are a glossary too");

// usage counts: only [english, users] pairs survive, most used first; account IDs are dropped
const votes = W.parseVotes({ success: true, data: [
  { to: "silvermoon flower", lang: "en", userCount: 4, users: ["secret-id-1"] },
  { to: "Silver Moon Flower", lang: "en", userCount: 24, users: ["secret-id-2", "secret-id-3"] },
  { to: "  ", userCount: 9 }, { to: "bad", userCount: "x" }, null
] });
assert.deepStrictEqual(votes, [["Silver Moon Flower", 24], ["silvermoon flower", 4]]);
assert.ok(!JSON.stringify(votes).includes("secret-id"), "no account IDs are kept");
assert.strictEqual(W.parseVotes({ success: false }), null);
assert.deepStrictEqual(W.parseVotes({ success: true, data: [] }), []);

// url parsing
assert.deepStrictEqual(W.parseWtrUrl("https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-1"), { rawId: "8053", slug: "synthesis-wizard" });
assert.deepStrictEqual(W.parseWtrUrl("https://wtr-lab.com/zh/novel/12"), { rawId: "12", slug: null });
assert.strictEqual(W.parseWtrUrl("https://wtr-lab.com/en"), null);
assert.strictEqual(W.parseWtrUrl("https://example.com/en/novel/8053/x"), null);

// binding key: host (no www) + URL directory, so every chapter of one novel on a site shares it
assert.strictEqual(W.bindingKey("https://www.69shuba.com/txt/77582/38804615"), "69shuba.com/txt/77582");
assert.strictEqual(W.bindingKey("https://69shuba.com/txt/77582/38804616?x=1"), "69shuba.com/txt/77582");
assert.notStrictEqual(W.bindingKey("https://www.69shuba.com/txt/1/2"), W.bindingKey("https://www.69shuba.com/txt/77582/2"));

// a novel's info page and its chapters get the same key, so "Use here" works wherever you press it (69shuba)
assert.strictEqual(W.bindingKey("https://www.69shuba.com/book/77582.htm"), "69shuba.com/txt/77582");
assert.strictEqual(W.bindingKey("https://www.69shuba.com/book/77582/"), "69shuba.com/txt/77582");
assert.strictEqual(W.bindingKey("https://www.69shuba.com/book/77582"), "69shuba.com/txt/77582");
assert.strictEqual(W.bindingKey("https://www.69shuba.com/txt/77582/38804613"), "69shuba.com/txt/77582", "chapter pages are unchanged");
assert.strictEqual(W.bindingKey("https://example.com/book/77582.htm"), "example.com/book", "other sites keep the directory rule");

// search: exact, case/punctuation-insensitive, and tolerant of a typo (the subsequence fallback)
const lib = { a: { id: "a", name: "synthesis-wizard[wtr-lab]", terms: [] }, b: { id: "b", name: "family-cultivation[wtr-lab]", terms: [] } };
assert.deepStrictEqual(W.search(lib, "synthesis-wizard[wtr-lab]").map((g) => g.id), ["a"]);
assert.deepStrictEqual(W.search(lib, "SYNTHESIS wizard").map((g) => g.id), ["a"]);
assert.deepStrictEqual(W.search(lib, "synesis-wizard").map((g) => g.id), ["a"], "typo still finds it");
assert.deepStrictEqual(W.search(lib, "zzz").map((g) => g.id), []);
assert.deepStrictEqual(W.search(lib, "").map((g) => g.id), ["b", "a"], "empty query lists everything, sorted by name");

// binding -> entries: only the glossaries bound to THIS novel, your own terms win
const library = { "wtr-lab:8053": { id: "wtr-lab:8053", terms: [["科雷", "Corey"], ["希恩", "Sheen"]] } };
const bindings = { "69shuba.com/txt/77582": { ids: ["wtr-lab:8053"], updatedAt: 5 } };
const own = [{ terms: ["希恩"], translation: "MINE", source: "manual" }, { terms: ["科雷"], translation: "Generic", source: "starter" }];
const here = W.boundEntries({ library, bindings, url: "https://www.69shuba.com/txt/77582/1", ownEntries: own, hostname: "69shuba.com" });
assert.deepStrictEqual(here.map((e) => e.terms[0] + "=" + e.translation), ["科雷=Corey"], "own term wins; a starter term does not block");
assert.ok(here.every((e) => e.source === "wtr" && e.lib === "wtr-lab:8053" && e.scope === "site" && e.hostname === "69shuba.com"));
assert.deepStrictEqual(W.boundEntries({ library, bindings, url: "https://www.69shuba.com/txt/99999/1", ownEntries: [], hostname: "69shuba.com" }), [], "other novels on the same site are untouched");
assert.deepStrictEqual(W.boundEntries({ library: {}, bindings, url: "https://www.69shuba.com/txt/77582/1", ownEntries: [], hostname: "x" }), [], "dangling binding is ignored");
// the first version stored a bare array of ids; still understood
const legacy = W.boundEntries({ library, bindings: { "69shuba.com/txt/77582": ["wtr-lab:8053"] }, url: "https://www.69shuba.com/txt/77582/1", ownEntries: [], hostname: "69shuba.com" });
assert.strictEqual(legacy.length, 2);
assert.deepStrictEqual(W.bindingIds(["a"]), ["a"]);
assert.deepStrictEqual(W.bindingIds({ ids: ["b"], updatedAt: 1 }), ["b"]);
assert.deepStrictEqual(W.bindingIds(undefined), []);
// the raw source the site names in a novel's data
const page = (raws) => ({ pageProps: { serie: { serie_data: { slug: "s", data: { title: "T" }, tags: [] }, raws }, tags: [] } });
assert.strictEqual(W.toNovelInfo(page([{ slug: "other" }, { slug: "biquge.tw", default: true }]), 1, "s", "https://wtr-lab.com/en").rawSlug, "biquge.tw", "the default raw source");
assert.strictEqual(W.toNovelInfo(page([{ slug: "69shu" }]), 1, "s").rawSlug, "69shu", "or the only one");
assert.strictEqual(W.toNovelInfo(page(undefined), 1, "s").rawSlug, undefined, "none named");
// terms inside a synopsis: %{fallback|base64 name} shows the decoded name
assert.strictEqual(W.cleanDescription("[%{Curse World|SnVqdXRzdQ}][Nuwa] Traveling to %{Curse World|SnVqdXRzdSBLYWlzZW4}, ok"), "[Jujutsu][Nuwa] Traveling to Jujutsu Kaisen, ok", "the decoded name, not the fallback label");
assert.strictEqual(W.cleanDescription("a %{Fallback|!!notbase64} b"), "a Fallback b", "an undecodable name keeps the fallback");
assert.strictEqual(W.cleanDescription("plain text"), "plain text");
assert.strictEqual(W.cleanDescription(undefined), "");
// details: status, genres, titles
const detailed = W.toNovelInfo({ pageProps: { serie: { serie_data: { slug: "s", status: 3, raw_status: 1, genres: [1, 16, 24, 8, 999], tags: [], data: { title: "Main Title", raw_title_b64: Buffer.from("咒术转盘", "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_"), raw: { title: "" } } }, names: [{ title: "Main Title" }, { title: "Other Name" }, { title: "Other Name" }], raws: [] }, tags: [] } }, 1, "s");
assert.deepStrictEqual([detailed.status, detailed.rawStatus], ["Dropped", "Completed"], "status words, from wtr-lab's own numbering");
assert.deepStrictEqual(detailed.genres, ["Action", "Martial Arts", "Sci-Fi", "Fan-Fiction"], "genre names (an unknown number is skipped)");
assert.strictEqual(detailed.rawTitle, "咒术转盘", "the original-language title, decoded");
assert.deepStrictEqual(detailed.names, ["Other Name"], "other titles, without the main one or repeats");
// what the library's Novel Finder filters and orders by, the way the site's does
const counted = (sd) => W.toNovelInfo({ pageProps: { serie: { serie_data: Object.assign({ slug: "s", data: { title: "T" }, tags: [] }, sd) }, tags: [] } }, 1, "s");
const full = counted({ raw_status: 0, char_count: 399315, raw_char_count: 400000, total_rate: 6, in_library: 109, vote: 9 });
assert.deepStrictEqual([full.chars, full.ratingCount, full.readers, full.votes, full.release], [399315, 6, 109, 9, "released"], "its length, reviews, readers, votes, and that it is released");
assert.deepStrictEqual([counted({ raw_status: -1, raw_char_count: 268546 }).release, counted({ raw_status: -1, raw_char_count: 268546 }).chars], ["voting", 268546], "a novel still on voting; the raw text's length when wtr-lab has no other");
assert.strictEqual(counted({}).chars, undefined, "a length that is not known is not a length of 0");

// ---- your terms from the library's reader (/api/my-terms) ----
const myTerms = [
  { id: "a", from: ["宁奇"], to: "Ning Qi", cs: true, keys: ["69shuba.com/txt/77582", "wtr-lab:5045"] },
  { id: "b", from: ["morning bell", "Morning Bell"], to: "dawn bell", cs: false, keys: [] },
  { id: "c", from: ["Key"], to: "Kei", cs: true, keys: ["novgo.net/other"] },
  { id: "d", from: [], to: "nothing" },
  null
];
const onPage = W.myTermEntries(myTerms, "https://www.69shuba.com/txt/77582/3104.html");
assert.deepStrictEqual(onPage.map((e) => [e.terms, e.translation, e.source, e.lib]), [[["宁奇"], "Ning Qi", "replace", "my-terms"], [["morning bell", "Morning Bell"], "dawn bell", "replace", "my-terms"]], "this novel's and every novel's; all only change what is shown (none goes to the translator), Chinese too");
assert.deepStrictEqual([onPage[1].mine, onPage[1].ci, onPage[0].ci], [true, true, false]);
assert.deepStrictEqual(W.myTermEntries(myTerms, "https://novgo.net/other/1.html").map((e) => e.translation), ["dawn bell", "Kei"]);
assert.deepStrictEqual(W.myTermEntries(myTerms, "not a url").map((e) => e.translation), ["dawn bell"], "an address that is not one: every novel's only");
assert.deepStrictEqual(W.myTermEntries(undefined, "https://x.com/a/b"), []);
const linked = W.myTermEntries([{ id: "e", from: ["齐原"], to: "Qi Yuan", keys: ["wtr-lab:5045"] }], "https://www.69shuba.com/txt/90001/1.html", { "69shuba.com/txt/90001": { ids: ["wtr-lab:5045"] } });
assert.deepStrictEqual(linked.map((e) => e.translation), ["Qi Yuan"], "a book whose bound glossary is the novel's gets the novel's terms");
const swap = (text, f, to, ci) => text.replace(W.myTermRegex(f, ci), () => to);
assert.strictEqual(swap("The Morning Bell, a bellow, a bell.", "bell", "gong", true), "The Morning gong, a bellow, a gong.", "at a word's edge, any case");
assert.strictEqual(swap("Key and key", "Key", "Kei", false), "Kei and key", "case sensitive");
assert.strictEqual(swap("他看见宁奇走来", "宁奇", "Ning Qi", false), "他看见Ning Qi走来", "Chinese anywhere");
assert.strictEqual(swap("cost $5 (x)", "$5 (x)", "five", false), "cost five", "regex characters are text");
console.log("OK — wtr-terms checks passed");
