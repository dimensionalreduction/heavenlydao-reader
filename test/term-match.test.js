// Which terms a chapter is sent with (term-match.js): longest first, one-character terms only as names, the parts of a person's name with the full name;
// and a novel's index of mentions. No network, no storage.
// Run: node test/term-match.test.js
const assert = require("assert");
const TermMatch = require("../src/shared/term-match.js");

const sent = (text, entries, options) => TermMatch.select(text, entries, options).entries.map((e) => e.terms[0]);
const e = (src, translation, extra) => Object.assign({ terms: [src], translation }, extra);

// a surname is not in every word that has its character
assert.deepStrictEqual(sent("他终于明白了，墙是白色的。", [e("白", "Bai")]), [], "白 in 明白 and 白色 is not the surname");
assert.deepStrictEqual(sent("白师兄来了。", [e("白", "Bai")]), ["白"], "白 before 师兄 is a name");
assert.deepStrictEqual(sent("大家都叫他小白。", [e("白", "Bai")]), ["白"], "after 小 it is a name");
assert.deepStrictEqual(sent("他姓白。", [e("白", "Bai")]), ["白"], "after 姓 it is a name");
assert.deepStrictEqual(sent("他说道：“走吧。”", [e("道", "Dao", { origin: { o: "shared:Cultivation" } })]), [], "道 of a genre glossary is not a name, and is not in 说道");
assert.deepStrictEqual(sent("他说道：“走吧。”", [e("道", "Dao", { match: "always" })]), ["道"], "unless the term says it always is");
assert.deepStrictEqual(sent("明白", [e("白", "Bai")], { singles: "always" }), ["白"], "singles: always is the old behaviour (text.includes)");
assert.deepStrictEqual(sent("白师兄来了。", [e("白", "Bai")], { singles: "off" }), [], "singles: off sends none");
assert.deepStrictEqual(sent("白师兄", [e("白", "Bai", { kind: "technique" })]), [], "a one-character technique is not a name");

// longest first
assert.deepStrictEqual(sent("天道无情", [e("天道", "Heavenly Dao"), e("道", "Dao", { match: "always" })]), ["天道"], "道 inside 天道 is the longer term's");
assert.deepStrictEqual(sent("他修道，天道无情", [e("天道", "Heavenly Dao"), e("道", "Dao", { match: "always" })]), ["天道", "道"], "but 道 on its own is found");
assert.deepStrictEqual(sent("白小纯笑了", [e("白小纯", "Bai Xiaochun"), e("小纯", "Xiaochun")]), ["白小纯"], "小纯 inside 白小纯 is not found there");

// a term that crosses the edge of a longer one is not found there either (法修 across 办法|修炼)
assert.deepStrictEqual(sent("他没办法修炼功法", [e("法修", "Spell Cultivator"), e("修炼功法", "cultivation method")]), ["修炼功法"]);
assert.deepStrictEqual(sent("他没办法修炼", [e("法修", "Spell Cultivator"), e("修炼", "cultivate")]), ["法修", "修炼"], "two that cross at the same length cannot be told apart: both stay");
assert.deepStrictEqual(sent("他是法修，也在修炼", [e("法修", "Spell Cultivator"), e("修炼", "cultivate")]), ["法修", "修炼"], "but 法修 where it is a word is");

// a person: the parts used alone go with the full name
let r = TermMatch.select("傅心汉来了。傅先生说：心汉，你过来。傅师兄也在。", [e("傅心汉", "Fu Xinhan"), e("傅", "Fu")]).entries;
assert.strictEqual(r.length, 1, "the surname's own entry is in the full name's line");
assert.deepStrictEqual(r[0].forms, ["傅 = Fu", "心汉 = Xinhan"]);
r = TermMatch.select("傅心汉来了。", [e("傅心汉", "Fu Xinhan")]).entries;
assert.strictEqual(r[0].forms, undefined, "no part alone in the text: the line is as it was");
assert.strictEqual(TermMatch.splitName("许爷", "Master Xu"), null, "Master Xu is not a surname and a given name");
assert.deepStrictEqual(TermMatch.splitName("欧阳明月", "Ouyang Mingyue"), { surname: "欧阳", given: "明月", surnameEn: "Ouyang", givenEn: "Mingyue" });
assert.strictEqual(TermMatch.splitName("天地玄黄", "Heaven Earth"), null);

// terms with no translation (to be rendered by Gemini) are chosen the same way
assert.deepStrictEqual(sent("白师兄来了", [{ terms: ["白"], translation: "" , kind: "person" }]), ["白"]);

// the index of mentions
let ix = TermMatch.record(null, 3, ["傅心汉", "天道"]);
ix = TermMatch.record(ix, 4, ["傅心汉"]);
ix = TermMatch.record(ix, 5, ["傅心汉", "天道"]);
ix = TermMatch.record(ix, 9, ["傅心汉"]);
assert.strictEqual(ix.terms["傅心汉"], "3-5,9");
assert.strictEqual(ix.terms["天道"], "3,5");
assert.strictEqual(TermMatch.countOf(ix, "傅心汉"), 4);
assert.strictEqual(TermMatch.firstOf(ix, "天道"), 3);
assert.deepStrictEqual(TermMatch.termsInChapters(ix, [4]), ["傅心汉"]);
assert.deepStrictEqual(TermMatch.termsInChapters(ix, [3, 9]).sort(), ["傅心汉", "天道"].sort());
assert.strictEqual(ix.last, 9);
ix = TermMatch.record(ix, 4, [], ["傅心汉", "天道"]); // chapter 4 read again without it
assert.strictEqual(ix.terms["傅心汉"], "3,5,9", "a chapter read again drops the terms it no longer has");
ix = TermMatch.record(ix, 3, ["傅心汉"], ["天道"]);
assert.strictEqual(ix.terms["天道"], "5");
assert.strictEqual(TermMatch.record(ix, NaN, ["x"]).terms.x, undefined, "a chapter with no number is not recorded");

// ----- a word of one character (a grade: 甲 = Grade A) is sent wherever it is, marked to be used where it means that -----
{
  const grades = [{ terms: ["甲"], translation: "Grade A" }, { terms: ["乙"], translation: "Grade B", kind: "rank" }, { terms: ["林"], translation: "Lin" }, { terms: ["道"], translation: "Great Dao", origin: "shared:cultivation" }];
  const picked = (text) => TermMatch.select(text, grades).entries.map((e) => (e.terms[0]) + (e.where ? "*" : ""));
  assert.deepStrictEqual(picked("考核分为甲、乙两等，他得了甲等。"), ["甲*", "乙*"], "a grade by its meaning (more than one word) goes with the chapter, marked");
  assert.deepStrictEqual(picked("他穿着金甲，走进树林。"), ["甲*"], "in 金甲 too, marked: the line says to use it only where it means that; 林 (a name) only as a name");
  assert.deepStrictEqual(picked("林师兄说道。"), ["林"], "a name of one character where it is used as one, not marked");
  assert.deepStrictEqual(picked("天道无情，他说道。"), [], "one from the shared genre glossaries is not sent so");
  assert.deepStrictEqual(picked("考核分为甲等。").length, 1);
  assert.strictEqual(TermMatch.line(TermMatch.select("他得了甲。", grades).entries[0]), "甲 = Grade A (only where it means this)", "its line says so");
  assert.strictEqual(TermMatch.line({ terms: ["傅心汉"], translation: "Fu Xinhan", gender: "male", forms: ["傅 = Fu"] }), "傅心汉 = Fu Xinhan (male) (the same person, when written alone: 傅 = Fu)", "a person's line as before");
}

console.log("term-match: all passed");
