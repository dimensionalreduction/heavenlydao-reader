// The pool of what a library's novels agree a term is called (term-pool.js). No network, no storage.
// Run: node test/term-pool.test.js
const assert = require("assert");
const TermPool = require("../src/shared/term-pool.js");
const BASE = require("../src/shared/base-glossary.js");

const g = (id, rows) => ({ id, terms: rows });
const pool = (glossaries, base) => TermPool.build(glossaries, { base });

// two novels that agree make a term; one novel does not
let p = pool([g("a", [["散修", "Loose Cultivator"], ["金丹", "Golden Core"]]), g("b", [["散修", "Loose Cultivator"], ["元婴", "Nascent Soul"]])]);
assert.deepStrictEqual(p.entries.map((e) => [e.source, e.en, e.n]), [["散修", "Loose Cultivator", 2]], "only what two novels have");

// novels that split evenly: not in the pool, listed as undecided for a pin
p = pool([g("a", [["魔兽师", "Beast Master"]]), g("b", [["魔兽师", "Beast Tamer"]])]);
assert.deepStrictEqual(p.entries, []);
assert.deepStrictEqual(p.contested.map((c) => [c.source, c.total, c.alts.length, c.undecided]), [["魔兽师", 2, 1, true]]);
assert.strictEqual(pool([g("a", [["魔兽师", "Beast Master"]])]).contested.length, 0, "one novel is not a disagreement");

// where they differ the most used wins, the other is an alternative; the spelling most use is kept
p = pool([g("a", [["散修", "Loose Cultivator"]]), g("b", [["散修", "loose cultivator"]]), g("c", [["散修", "Rogue Cultivator"]]), g("d", [["散修", "Loose Cultivator"]])]);
assert.strictEqual(p.by.get("散修").en, "Loose Cultivator");
assert.strictEqual(p.by.get("散修").n, 3);
assert.deepStrictEqual(p.by.get("散修").alts, [{ en: "Rogue Cultivator", n: 1 }]);
assert.strictEqual(p.by.get("散修").total, 4);

// a shared list carried by several novels counts once (as two novels), not once for each
const cult = (id) => g(id, [["斗者", "Dou Practitioner", { o: "shared:Cultivation" }], ["散修", "Loose Cultivator", { o: "shared:Cultivation" }]]);
p = pool([cult("a"), cult("b"), cult("c")]);
assert.deepStrictEqual(p.entries.map((e) => [e.source, e.n]), [["斗者", 2], ["散修", 2]], "three novels with the list: its two votes, not three; a curated list is enough for a term");
p = pool([cult("a"), cult("b"), cult("c"), g("d", [["斗者", "Dou Zhe", { o: "novel" }]]), g("e", [["斗者", "Dou Zhe", { o: "novel" }]]), g("f", [["斗者", "Dou Zhe", { o: "novel" }]])]);
assert.strictEqual(p.by.get("斗者").en, "Dou Zhe", "three novels that chose their own outvote the list");

// the base layer counts as three novels: what a library knows adds to it, and has to outvote it to change it
const base = [["散修", "Loose Cultivator", "person", ""], ["散修", "Rogue Cultivator", "person", ""], ["师兄", "Senior Martial Brother", "person", "male"]];
p = pool([g("a", [["散修", "Rogue Cultivator"]]), g("b", [["散修", "Rogue Cultivator"]])], base);
assert.strictEqual(p.by.get("散修").en, "Loose Cultivator", "two novels do not outvote the base layer's three");
assert.strictEqual(p.by.get("散修").base, true);
p = pool([g("a", [["散修", "Rogue Cultivator"]]), g("b", [["散修", "Rogue Cultivator"]]), g("c", [["散修", "Rogue Cultivator"]]), g("d", [["散修", "Rogue Cultivator"]])], base);
assert.strictEqual(p.by.get("散修").en, "Rogue Cultivator", "four do");
assert.deepStrictEqual([p.by.get("师兄").kind, p.by.get("师兄").gender, p.by.get("师兄").n], ["person", "male", 3], "a base term is in with no novel, with its kind and gender");
assert.strictEqual(pool([], base).by.get("散修").en, "Loose Cultivator", "the first rendering of a source in the layer is the layer's");

// what is kept out
p = pool([g("a", [["道", "Dao"], ["气", "Qi"], ["萧炎", "Xiao Yan"], ["小纯", "Xiao Chun"], ["很长很长很长很长很长很长的一句话", "A sentence"], ["谎言", "He lied. Then he left."]]),
  g("b", [["道", "Dao"], ["气", "Qi"], ["萧炎", "Xiao Yan"], ["小纯", "Xiao Chun"], ["很长很长很长很长很长很长的一句话", "A sentence"], ["谎言", "He lied. Then he left."]])]);
assert.deepStrictEqual(p.entries.map((e) => e.source), [], "one character, a name two novels agree on, a long source, a sentence");
p = pool([g("a", [["萧炎", "Xiao Yan"]]), g("b", [["萧炎", "Xiao Yan"]]), g("c", [["萧炎", "Xiao Yan"]])]);
assert.deepStrictEqual(p.entries.map((e) => e.source), ["萧炎"], "a name three novels use");
assert.strictEqual(TermPool.nameLike("Dou Qi Continent"), false, "a term with English in it is not a name");
assert.strictEqual(TermPool.nameLike("Xiao Yan"), true);

// the real base layer: every row is a pair a pool may have, and a source is in once
p = pool([], BASE);
assert.ok(p.entries.length > 350, "the public Cultivation glossary: " + p.entries.length);
assert.strictEqual(p.by.get("掌门").en, "Sect Head", "the first of two renderings in the file");
assert.deepStrictEqual(p.by.get("掌门").alts.map((a) => a.en), ["Sect Leader"]);
assert.strictEqual(p.by.get("功德").en, "Karma");
assert.strictEqual(p.by.get("宗主").n, 3, "a rendering the file has twice counts once");

// a pin is the pool's rendering whatever the votes, and gets a term in that no novel agrees on
p = TermPool.build([g("a", [["散修", "Rogue Cultivator"]]), g("b", [["散修", "Rogue Cultivator"]]), g("c", [["青云宗", "Azure Cloud Sect"]])], { base: BASE, pins: [["散修", "Wandering Cultivator"], ["青云宗", "Azure Cloud Sect"], ["道", "Dao"], ["", "x"]] });
assert.strictEqual(p.by.get("散修").en, "Wandering Cultivator");
assert.strictEqual(p.by.get("散修").pinned, true);
assert.deepStrictEqual(p.by.get("散修").alts.map((a) => a.en), ["Loose Cultivator", "Rogue Cultivator"], "what the votes chose (the base layer outvotes two novels), and the other beside it");
assert.strictEqual(p.by.get("青云宗").pinned, true, "a term one novel has is in the pool once pinned");
assert.strictEqual(p.by.get("道"), undefined, "a character is still not a term");
assert.strictEqual(p.by.get("师兄").gender, "male", "a pin keeps the base layer's kind and gender");
p = TermPool.build([], { base: BASE, pins: [["师兄", "Senior Martial Brother"]] });
assert.strictEqual(p.by.get("师兄").gender, "male");
assert.deepStrictEqual(p.by.get("师兄").alts.map((a) => a.en), ["Senior Brother"], "pinned to what the votes chose: only the base layer's other rendering beside it");

// a novel's key that means the same on every device
assert.strictEqual(TermPool.keyOf("wtr-lab:93016"), "wtr-lab:93016");
assert.strictEqual(TermPool.keyOf("adopted:69shuba.com/txt/77582"), "69shuba.com/txt/77582");
assert.strictEqual(TermPool.keyOf("www.69shuba.com/txt/77582"), "69shuba.com/txt/77582");
assert.strictEqual(TermPool.keyOf("copy:ab12cd34"), null, "a copy is one person's");
assert.strictEqual(TermPool.keyOf("adopted:upload:ab12cd34"), null, "so is an uploaded file's");
assert.strictEqual(TermPool.keyOf("wtr-lab:93016@es"), null);
assert.strictEqual(TermPool.keyOf("pool"), null);

// what a library would add to a public pool: what the person made, of novels with a stable key; no the site data, no names, no sentences
const mine = [
  g("wtr-lab:1", [["散修", "Loose Cultivator", { o: "novel" }], ["灵兽师", "Spirit Beast Tamer", "yours"], ["萧炎", "Xiao Yan", "yours"], ["道", "Dao", "yours"]]),
  g("adopted:69shuba.com/txt/1", [["青云宗", "Azure Cloud Sect", { o: "gemini" }], ["金丹", "Golden Core", { o: "pool" }], ["谎言", "He lied. Then he left.", { o: "gemini" }]]),
  g("adopted:upload:abc", [["青云宗", "Azure Cloud Sect", { o: "gemini" }]]),
  g("copy:abc", [["青云宗", "Azure Cloud Sect", { o: "yours" }]])
];
const c = TermPool.contribution(mine);
assert.deepStrictEqual(c.pairs.sort(), [["灵兽师", "Spirit Beast Tamer"], ["青云宗", "Azure Cloud Sect"]].sort(), "what the person made, not wtr-lab's, the pool's, a name, a character or a sentence");
assert.strictEqual(c.novels, 2);

// the library's own rows: [source, rendering, owner, { o }]: what the person typed or Gemini made and they kept; not the site's, a copy's or the pool's
const rows = [g("wtr-lab:7", [["灵兽师", "Spirit Beast Tamer", "user", { o: "novel" }], ["散修", "Loose Cultivator", "wtr", { o: "shared:Cultivation" }], ["青云宗", "Azure Cloud Sect", "copied", { o: "gemini" }]]),
  g("adopted:69shuba.com/txt/9", [["御兽", "Beast Taming", "gemini", { o: "gemini" }], ["金丹", "Golden Core", "pool", { o: "pool" }]])];
assert.deepStrictEqual(TermPool.contribution(rows).pairs.sort(), [["灵兽师", "Spirit Beast Tamer"], ["御兽", "Beast Taming"]].sort());

// the public pool is a layer of the pool: what many agreed on counts as two novels, and a novel that has its own can outvote it
p = TermPool.build([], { central: [["灵兽师", "Spirit Beast Tamer"], ["灵兽师", "Spirit Beast Tamer"], ["道", "Dao"]] });
assert.deepStrictEqual(p.entries.map((e) => [e.source, e.en, e.n]), [["灵兽师", "Spirit Beast Tamer", 2]]);
p = TermPool.build([g("a", [["灵兽师", "Beast Master"]]), g("b", [["灵兽师", "Beast Master"]]), g("c", [["灵兽师", "Beast Master"]])], { central: [["灵兽师", "Spirit Beast Tamer"]] });
assert.strictEqual(p.by.get("灵兽师").en, "Beast Master");

console.log("term-pool: all passed");
