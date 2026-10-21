// The glossary benchmark (tools/bench-glossary.js) with a translator stood in for: it scores a translation against the site's glossary, runs every
// condition both ways of choosing terms, and carries what the translator suggests into the next chapter. No network.
// Run: node test/bench-glossary.test.js
const assert = require("assert");
global.TermMatch = require("../src/shared/term-match.js");
const bench = require("../tools/bench-glossary.js");

const text1 = "白师兄来了。他终于明白了，墙是白色的。傅心汉笑了。天道无情。";
const text2 = "傅心汉说：“你明白了吗？这是白色的。”";
const storage = {
  glossaryLibrary: { "wtr-lab:1": { terms: [["傅心汉", "Fu Xinhan", "wtr", { o: "novel" }], ["白", "Bai", "wtr", { o: "ai" }], ["天道", "Heavenly Dao", "wtr", { o: "shared:Cultivation" }]] } },
  "translation:https://raw.example/b/1#original": { translated: text1.repeat(20), pageTitle: "Chapter 1" },
  "translation:https://raw.example/b/2#original": { translated: text2.repeat(30), pageTitle: "Chapter 2" }
};
const sentWith = [];
const translate = async (text, glossary, extra) => {
  sentWith.push({ n: glossary.length, singles: extra.singles, terms: glossary.map((e) => e.terms[0]) });
  // a translator that renders 傅心汉 right only when the glossary has it, and invents 许尧 as a suggestion
  const has = glossary.some((e) => e.terms[0] === "傅心汉");
  return { translated: (has ? "Fu Xinhan" : "Fu Xin Han") + " and Heavenly Dao and Bai", suggestions: [{ term: "许尧", translation: "Xu Yao", kind: "person" }, { term: "傅心汉", translation: "Fu Xinhan", kind: "person" }] };
};

(async () => {
  const r = await bench({ novels: [{ glossary: "wtr-lab:1", raw: "raw.example/b/" }], chapters: 2, conditions: ["shared", "novel", "full", "none"], translate, storage, log: false });
  assert.strictEqual(r.length, 8, "four conditions, each both ways");
  const by = (c, m) => r.find((x) => x.condition === c && x.matching === m);
  assert.strictEqual(by("novel", "context").chapters, 2);
  assert.strictEqual(by("novel", "context")["hit%"], 100, "with wtr-lab's list the name and the shared term are in the answer");
  assert.ok(by("none", "context")["hit%"] < 100, "without it the translator says Fu Xin Han in the first chapter: not a hit");
  // 白 (a single character): the old way sends it wherever the character is, the new one only as a name
  assert.ok(by("full", "always")["singlesWrong/ch"] > 0, "the old way sends 白 where it is in 明白 and 白色");
  assert.ok(by("full", "context")["singlesWrong/ch"] < by("full", "always")["singlesWrong/ch"], "the new one sends it only in the chapter where it is a name");
  assert.ok(by("full", "context")["singles/ch"] < by("full", "always")["singles/ch"]);
  assert.ok(by("full", "always")["terms/ch"] >= by("full", "context")["terms/ch"]);
  // what the translator suggests joins the glossary for the next chapter
  assert.ok(sentWith.some((s) => s.terms.includes("傅心汉")), "傅心汉 suggested in chapter 1 is sent with chapter 2 (condition none)");
  assert.strictEqual(by("none", "context").suggested, 2, "the suggestions, once each");
  console.log("bench-glossary: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
