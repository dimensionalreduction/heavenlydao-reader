// A chapter's text by Google Translate's free endpoint (google-chapter.js, the Translation rule's last row): the paragraphs one a line, about 1,500 characters a request;
// the glossary's proper names as made-up names (TermAB) put back as its English, a person with how they are called as one name in English order, words left to Google;
// a paragraph whose names did not all come back asked again as it is; lines that do not come back one for one asked in halves; a long paragraph in pieces; Google refusing.
// Run: node test/google-chapter.test.js
const assert = require("assert");
const path = require("path");
globalThis.TermMatch = require(path.join(__dirname, "..", "src", "shared", "term-match.js"));
const G = require(path.join(__dirname, "..", "src", "shared", "google-chapter.js"));

const asked = []; // [{ url, lines }]
let answer = (lines) => lines.map((l) => "EN " + l);
const fetch = async (url, opts) => {
  const q = decodeURIComponent(String(opts.body).replace(/^q=/, "")), lines = q.split("\n");
  asked.push({ url, lines });
  const out = answer(lines, asked.length);
  if (typeof out === "number") return { ok: false, status: out, json: async () => ({}) };
  if (out === "html") return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } };
  return { ok: true, status: 200, json: async () => [(Array.isArray(out) ? [out.join("\n")] : [out]).map((t) => [t, q])] };
};
const slept = [];
const sleep = async (ms) => { slept.push(ms); };
const run = (text, opts = {}) => G.translate(text, { fetch, sleep, lang: "en", ...opts });

(async () => {
  assert.strictEqual(G.MODEL, "google/translate");
  assert.ok(G.is("google/translate") && G.is("google/translate (Every term)") && !G.is("google/gemini-3.5-flash-lite (Every term)") && !G.is(undefined), "a chapter's model says it was Google Translate's");

  // ----- plain: the paragraphs one a line, in one request, given back a blank line apart
  asked.length = 0;
  let out = await run("第一段。\n\n  第二段。  \n第三段。");
  assert.strictEqual(out, "EN 第一段。\n\nEN 第二段。\n\nEN 第三段。");
  assert.strictEqual(asked.length, 1, "one request");
  assert.deepStrictEqual(asked[0].lines, ["第一段。", "第二段。", "第三段。"], "blank lines and spaces dropped");
  assert.ok(/client=gtx/.test(asked[0].url) && /sl=auto/.test(asked[0].url) && /tl=en$/.test(asked[0].url), asked[0].url);
  assert.strictEqual(await run(""), "", "nothing to translate");
  await run("一。", { lang: "zh" });
  assert.ok(/tl=zh-CN$/.test(asked[asked.length - 1].url), "the library's zh is Google's zh-CN");

  // ----- the glossary: proper names as made-up names, put back; words left as they are
  const glossary = [
    { terms: ["齐原"], translation: "Qi Yuan" }, // a person's name (2 characters, pinyin)
    { terms: ["师弟"], translation: "Junior Brother" }, // how one is called: with a name before it, one name in English order
    { terms: ["七彩峰"], translation: "Seven-Colored Peak" }, // a place: 3 characters
    { terms: ["修士"], translation: "Cultivator" }, // a word, capitalised but 2 characters and no person: left to Google
    { terms: ["无法"], translation: "unable to" } // a word: left to Google
  ];
  asked.length = 0;
  out = await run("齐原师弟走上七彩峰。\n修士无法上去。\n齐原说：“好。”", { glossary });
  assert.deepStrictEqual(asked[0].lines, ["TermAA走上TermAB。", "修士无法上去。", "TermAC说：“好。”"], "names as made-up names: " + JSON.stringify(asked[0].lines));
  assert.strictEqual(out, "EN Junior Brother Qi Yuan 走上 Seven-Colored Peak 。\n\nEN 修士无法上去。\n\nEN Qi Yuan 说：“好。”".replace(" 。", "。"), "put back as the glossary's English: " + JSON.stringify(out));
  // a word touching a name gets a space; punctuation does not
  answer = (lines) => lines.map((l) => l.replace("TermAA走上TermAB。", "TermAAwent up TermAB.").replace("TermAC说：“好。”", "TermAC's word: \"Good.\""));
  out = await run("齐原师弟走上七彩峰。\n齐原说：“好。”", { glossary });
  assert.strictEqual(out, "Junior Brother Qi Yuan went up Seven-Colored Peak.\n\nQi Yuan's word: \"Good.\"", JSON.stringify(out));

  // ----- a paragraph whose names did not all come back: asked again as it is (the other paragraphs keep theirs)
  answer = (lines, n) => (n === 1 ? lines.map((l) => l.replace("TermAB", "TermMAB").replace(/^/, "EN ")) : lines.map((l) => "PLAIN " + l));
  asked.length = 0;
  out = await run("齐原走上七彩峰。\n齐原坐下。", { glossary });
  assert.strictEqual(asked.length, 2, "a second request for the paragraph that lost a name");
  assert.deepStrictEqual(asked[1].lines, ["齐原走上七彩峰。"], "as it is, with no made-up names");
  assert.strictEqual(out, "PLAIN 齐原走上七彩峰。\n\nEN Qi Yuan 坐下。", JSON.stringify(out));

  // ----- lines that do not come back one for one: asked in halves, down to one
  answer = (lines) => (lines.length > 1 ? [lines.map((l) => "EN " + l).join(" ")] : ["EN " + lines[0]]);
  asked.length = 0;
  out = await run("一。\n二。\n三。");
  assert.strictEqual(out, "EN 一。\n\nEN 二。\n\nEN 三。");
  assert.deepStrictEqual(asked.map((a) => a.lines.length), [3, 2, 1, 1, 1], "3 lines, then 2 and 1, then the 2 one by one");

  // ----- about 1,500 characters a request; a long paragraph in pieces at its sentences' ends, joined again
  answer = (lines) => lines.map((l) => "E" + l.length);
  asked.length = 0;
  const p800 = "字".repeat(799) + "。";
  out = await run([p800, p800, p800].join("\n"));
  assert.deepStrictEqual(asked.map((a) => a.lines.length), [1, 1, 1], "two of 800 are more than 1,500: a request each");
  const long = ("字".repeat(999) + "。").repeat(5); // 5,000 characters
  asked.length = 0;
  out = await run(long);
  assert.ok(asked.every((a) => a.lines.join("\n").length <= 2100), "no request too long: " + asked.map((a) => a.lines.join("\n").length));
  assert.strictEqual(asked.reduce((n, a) => n + a.lines.length, 0), 5, "in 5 pieces");
  assert.strictEqual(out, "E1000 E1000 E1000 E1000 E1000", "one paragraph again: " + out);

  // ----- Google refusing: a 429 or a server error asked again after 5 and 10 s, then the error with its status; another status at once
  slept.length = 0;
  answer = (lines, n) => (n <= 2 ? 429 : lines.map((l) => "EN " + l));
  asked.length = 0;
  assert.strictEqual(await run("一。"), "EN 一。", "a 429 twice, then the answer");
  assert.ok(slept.includes(5000) && slept.includes(10000), "waited between: " + slept);
  answer = () => 429;
  await assert.rejects(run("一。"), (e) => e.status === 429 && /Google Translate said 429/.test(e.message), "three 429s: its status");
  answer = () => 400;
  asked.length = 0;
  await assert.rejects(run("一。"), (e) => e.status === 400);
  assert.strictEqual(asked.length, 1, "a 400 is not asked again");
  answer = () => "html";
  await assert.rejects(run("一。"), (e) => e.status === 503 && /did not answer with a translation/.test(e.message), "its unusual-traffic page in place of the answer");
  // (fetch's own failure: the TypeError as it is, so Pay.skipFor knows it was not reached)
  await assert.rejects(G.translate("一。", { fetch: async () => { throw new TypeError("Failed to fetch"); }, sleep }), (e) => e.name === "TypeError");

  console.log("google-chapter: ok");
})().catch((e) => { console.error(e); process.exit(1); });
