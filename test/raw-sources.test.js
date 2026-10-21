// The per-site rules for reading a chapter's original text. Run: node test/raw-sources.test.js
const assert = require("assert");
const path = require("path");
// the engine, then every site's rules in the order the extension loads them
const RS = require(path.join(__dirname, "..", "src", "shared", "raw-sources.js"));
globalThis.RawSources = RS;
for (const f of require("../tools/sources").dataFiles()) require(f);

// ---- which sites are supported ----
const supported = {
  "https://www.69shuba.com/txt/77582/38804612": "69shuba.com",
  "https://69shuba.com/txt/1/2": "69shuba.com",
  "https://twkan.com/txt/1/2.html": "twkan.com",
  "https://www.novel543.com/0123456789/8096_1.html": "novel543.com",
  "https://www.twbook.cc/0123456789/8096_1.html": "twbook.cc",
  "https://www.uuread.tw/chapter/1878627/2213453.html": "uuread.tw",
  "https://www.piaotia.com/html/1/2/3.html": "piaotia.com",
  "https://www.trxs.cc/tongren/1/2.html": "trxs.cc",
  "https://tongrenshe.cc/tongren/1/2.html": "tongrenshe.cc",
  "https://uukanshu.cc/book/1/2.html": "uukanshu.cc",
  "https://bixiange.xyz/xhqh/23552/index/1.html": "bixiange.xyz",
  "https://www.ffxs8.com/book/1/2.html": "ffxs8.com",
  "https://www.biquge.tw/book/1/2.html": "biquge.tw",
  "https://101kks.com/book/1/2.html": "101kks.com",
  "https://101kanshu.com/book/1/2.html": "101kanshu.com",
  "https://novelcult.com/novels/warriors-touch-deadly-touch-book-2-329243/chapters/c003eea9-0a9f-4b72-a0a7-41eb4da8a970": "novelcult.com"
};
for (const [url, host] of Object.entries(supported)) assert.strictEqual(RS.ruleFor(url), RS.SOURCES[host], url + " uses the " + host + " rule");
for (const url of [
  "https://fanqienovel.com/reader/1", // scrambled font
  "https://www.tadu.com/book/1", "https://www.qimao.com/shuku/1", "https://book.qq.com/book-detail/1", // JavaScript + login
  "http://www.69shuba.com/txt/1/2", // plain http is never read
  "https://evil.example/https://www.69shuba.com/", "https://www.69shuba.com.evil.example/x", "https://constructor/x", "not a url"
]) assert.strictEqual(RS.ruleFor(url), null, url + " is not supported");

// ---- the on-page translator reads the same rules (content.js asks RawSources for a site's selector before its older list) ----
assert.strictEqual(RS.ruleFor("https://www.uuread.tw/chapter/1/2.html").selector, "div.txt_tcontent");

// ---- text encodings ----
const gbkDi = Uint8Array.from([0xb5, 0xda]); // 第
assert.strictEqual(RS.decode(gbkDi, "text/html", RS.SOURCES["69shuba.com"]), "第", "a rule's charset wins (69shuba does not say GBK)");
assert.strictEqual(RS.decode(gbkDi, "text/html; charset=gbk", { selector: "x" }), "第", "else the header's");
assert.strictEqual(RS.decode(Uint8Array.from([...Buffer.from('<meta charset="gbk">'), 0xb5, 0xda]), "text/html", { selector: "x" }).slice(-1), "第", "else the page's own meta tag");
assert.strictEqual(RS.decode(Buffer.from("第"), "text/html", { selector: "x" }), "第", "else UTF-8");
assert.strictEqual(RS.decode(Buffer.from("第"), "text/html; charset=nonsense-9", { selector: "x" }), "第", "an unknown charset falls back to UTF-8");

// ---- reading a page ----
// A tiny stand-in for a DOM: the element tree is described by plain objects.
function el(opts = {}) {
  const node = {
    text: opts.text || "",
    removed: false,
    kids: opts.kids || [],
    attrs: opts.attrs || {},
    get textContent() { return node.removed ? "" : node.text + node.kids.map((k) => k.textContent).join(""); },
    getAttribute: (n) => (n in node.attrs ? node.attrs[n] : null),
    remove() { node.removed = true; },
    append(t) { node.text += t; },
    replaceWith(t) { node.removed = false; node.text = t; node.kids = []; node.isBr = false; },
    querySelectorAll(sel) { return all(node).filter((k) => matches(k, sel)); },
    closest() { return null; }
  };
  Object.assign(node, { tag: opts.tag || "div", cls: opts.cls || "", id: opts.id || "" });
  return node;
}
const all = (n) => n.kids.flatMap((k) => [k, ...all(k)]);
const matches = (n, sel) => sel.split(",").some((s) => {
  s = s.trim();
  return (s[0] === "." && n.cls.split(" ").includes(s.slice(1))) || (s[0] === "#" && n.id === s.slice(1)) || s === n.tag;
});
const page = (selMatch, box) => ({
  querySelector: (sel) => (sel === selMatch ? box : null),
  querySelectorAll: () => []
});

{
  const rule = RS.SOURCES["69shuba.com"];
  const box = el({ kids: [el({ tag: "h1", text: "Title" }), el({ cls: "txtinfo", text: "2026-01-01" }), el({ tag: "br" }), el({ text: "第一行" }), el({ tag: "br" }), el({ tag: "br" }), el({ text: "　第二行" })] });
  box.kids[2].isBr = true;
  const brs = [box.kids[2], box.kids[4], box.kids[5]];
  const realQuery = box.querySelectorAll;
  box.querySelectorAll = (sel) => (sel === "br" ? brs : realQuery(sel));
  assert.strictEqual(RS.textOf(page("div.txtnav", box), rule), "第一行\n第二行", "junk is dropped, breaks become lines, blank lines vanish");
  assert.strictEqual(RS.textOf(page("div.nothing", box), rule), "", "no chapter box means no text (a Cloudflare page)");
}

// a selector the browser cannot use finds nothing; an unusable junk selector leaves the junk but still gives the story
const throwing = { querySelector: () => { throw new SyntaxError("bad selector"); } };
assert.strictEqual(RS.textOf(throwing, { selector: "div[" }), "", "a bad content selector gives no text, not an error");
{
  const box = { textContent: "story", querySelectorAll: (sel) => { if (sel === "br" || /^p,/.test(sel)) return []; throw new SyntaxError("bad junk"); } };
  assert.strictEqual(RS.textOf({ querySelector: () => box }, { selector: "div", junk: "p[[" }), "story", "a bad junk selector leaves the junk but still gives the story");
}

// ---- chapters split into parts ----
const links = (...items) => ({ querySelectorAll: (sel) => items.filter((a) => (sel === "a" || sel === "a#next_url" || sel === ".foot-nav a" ? true : false)) });
const a = (href, text, id) => ({ textContent: text, getAttribute: () => href, id });

const uu = RS.SOURCES["uuread.tw"];
assert.strictEqual(RS.nextPart(links(a("/chapter/1878627/2213453_2.html", "下一頁"), a("/chapter/1878627/2213453_2.html", "看下一章")), "https://www.uuread.tw/chapter/1878627/2213453.html", uu), "https://www.uuread.tw/chapter/1878627/2213453_2.html", "uuread: part 2 of the same chapter");
assert.strictEqual(RS.nextPart(links(a("/chapter/1878627/2213454.html", "下一頁")), "https://www.uuread.tw/chapter/1878627/2213453_2.html", uu), null, "uuread: a link to the next chapter is not a part");
assert.strictEqual(RS.nextPart(links(a("/chapter/1878627/2213454.html", "目錄")), "https://www.uuread.tw/chapter/1878627/2213453_2.html", uu), null, "uuread: the last part has no further part");

const bq = RS.SOURCES["biquge.tw"];
assert.strictEqual(RS.nextPart(links(a("/book/5/100_2.html", "next")), "https://www.biquge.tw/book/5/100.html", bq), "https://www.biquge.tw/book/5/100_2.html", "biquge.tw: a _2 link continues the chapter");
assert.strictEqual(RS.nextPart(links(a("/book/5/101.html", "next")), "https://www.biquge.tw/book/5/100_2.html", bq), null, "biquge.tw: the next chapter is not a part");

const n543 = RS.SOURCES["novel543.com"];
assert.strictEqual(RS.nextPart(links(a("/0123/8096_1.html", "prev"), a("/0123/8096_1_2.html", "next")), "https://www.novel543.com/0123/8096_1.html", n543), "https://www.novel543.com/0123/8096_1_2.html", "novel543: the footer's last link when it continues this chapter");
assert.strictEqual(RS.nextPart(links(a("/0123/8096_2.html", "next")), "https://www.novel543.com/0123/8096_1_2.html", n543), null, "novel543: the next chapter ends it");
assert.strictEqual(RS.nextPart({ querySelectorAll: () => [] }, "https://www.69shuba.com/txt/1/2", RS.SOURCES["69shuba.com"]), null, "single-page sites have no parts");

// ---- the next CHAPTER: the page's own link, never a part, another site, or the page itself ----
const doc = (...anchors) => ({
  querySelector: () => null,
  querySelectorAll: (sel) => (sel === "a" ? anchors : [])
});
const uuLast = "https://www.uuread.tw/chapter/1878627/2213453_2.html";
assert.strictEqual(RS.nextChapter(doc(a("/chapter/1878627/2213453.html", "上一頁"), a("/chapter/1878627/2213454.html", "下一章")), uuLast), "https://www.uuread.tw/chapter/1878627/2213454.html", "uuread: the last part's next-chapter link");
assert.strictEqual(RS.nextChapter(doc(a("/chapter/1878627/2213453_2.html", "看下一章")), "https://www.uuread.tw/chapter/1878627/2213453.html"), null, "uuread: on part 1, the 'next chapter' link only leads to part 2, so it is not the next chapter");
assert.strictEqual(RS.nextChapter(doc(a("/txt/77582/38804613", "下一章")), "https://www.69shuba.com/txt/77582/38804612"), "https://www.69shuba.com/txt/77582/38804613", "69shuba: a site without .html addresses");
assert.strictEqual(RS.nextChapter(doc(a("https://ads.example/x", "下一章")), "https://www.69shuba.com/txt/1/2"), null, "a link to another site is never followed");
assert.strictEqual(RS.nextChapter(doc(a("javascript:void(0)", "下一章"), a("#", "下一章")), "https://www.69shuba.com/txt/1/2"), null, "script and anchor links are skipped");
assert.strictEqual(RS.nextChapter(doc(a("/txt/1/3", "下一頁")), "https://www.69shuba.com/txt/1/2"), null, "'next page' is not 'next chapter'");
assert.strictEqual(RS.nextChapter({ querySelector: (sel) => (sel === 'a[rel="next"]' ? a("/txt/1/3", "") : null), querySelectorAll: () => [] }, "https://www.69shuba.com/txt/1/2"), "https://www.69shuba.com/txt/1/3", "a rel=next link is used");
assert.strictEqual(RS.nextChapter(doc(), "https://www.69shuba.com/txt/1/2"), null, "the last chapter has none");

// ---- the previous chapter, the same way ----
assert.strictEqual(RS.prevChapter(doc(a("/txt/77582/38804611", "上一章"), a("/txt/77582/38804613", "下一章")), "https://www.69shuba.com/txt/77582/38804612"), "https://www.69shuba.com/txt/77582/38804611", "69shuba: the 'previous chapter' link");
assert.strictEqual(RS.prevChapter({ querySelector: (sel) => (sel === 'a[rel="prev"]' ? a("/txt/1/1", "") : null), querySelectorAll: () => [] }, "https://www.69shuba.com/txt/1/2"), "https://www.69shuba.com/txt/1/1", "a rel=prev link is used");
assert.strictEqual(RS.prevChapter(doc(a("javascript:void(0)", "上一章"), a("https://ads.example/x", "上一章")), "https://www.69shuba.com/txt/1/2"), null, "script links and other sites are never followed");
assert.strictEqual(RS.prevChapter(doc(a("/txt/1/1", "上一頁")), "https://www.69shuba.com/txt/1/2"), null, "'previous page' is not 'previous chapter'");
assert.strictEqual(RS.prevChapter(doc(), "https://www.69shuba.com/txt/1/2"), null, "the first chapter has none");

// ---- a rule that says where the links are (an icon-only link has no wording to find it by) ----
const byRule = (map) => ({ querySelector: (sel) => map[sel] || null, querySelectorAll: () => [] });
RS.setUserRules({ "iconic.example": { selector: "div.c", nav: { next: "a.me-3", prev: "a.ms-3" } }, "broken.example": { selector: "div.c", nav: { next: "a[[", prev: "a.p" } } });
const chap = "https://www.iconic.example/novel/x/5";
assert.strictEqual(RS.nextChapter(byRule({ "a.me-3": a("/novel/x/6", ""), "a.ms-3": a("/novel/x/4", "") }), chap), "https://www.iconic.example/novel/x/6", "the rule's next link, though it has no words");
assert.strictEqual(RS.prevChapter(byRule({ "a.me-3": a("/novel/x/6", ""), "a.ms-3": a("/novel/x/4", "") }), chap), "https://www.iconic.example/novel/x/4", "and its previous link");
assert.strictEqual(RS.nextChapter(byRule({ "a.me-3": a("https://ads.example/x", "") }), chap), null, "even the rule's link is never another site's");
assert.strictEqual(RS.nextChapter(byRule({ "a.me-3": a("/novel/x/5", "") }), chap), null, "or the page itself");
assert.strictEqual(RS.nextChapter({ querySelector: (sel) => (sel === "a.me-3" ? null : sel === 'a[rel="next"]' ? a("/novel/x/6", "") : null), querySelectorAll: () => [] }, chap), "https://www.iconic.example/novel/x/6", "a page where the rule's link is not found falls back to the usual places");
assert.strictEqual(RS.nextChapter({ querySelector: (sel) => { if (sel === "a[[") throw new SyntaxError("bad selector"); return sel === 'a[rel="next"]' ? a("/novel/y/2", "") : null; }, querySelectorAll: () => [] }, "https://broken.example/novel/y/1"), "https://broken.example/novel/y/2", "a selector the browser cannot use does not stop the usual places being tried");
RS.setUserRules({});
assert.strictEqual(RS.nextChapter(byRule({ "a.me-3": a("/novel/x/6", "") }), chap), null, "with the rule gone, the icon-only link is not found again");

// ---- chapter-list pages (what WebToEpub's getChapterUrls reads) ----
assert.strictEqual(RS.tocFor("https://www.uuread.tw/chapter/1878627/2213453.html").url, "https://www.uuread.tw/1878627", "uuread: the book page, from one of its chapters");
assert.strictEqual(RS.tocFor("https://www.uuread.tw/1878627").url, "https://www.uuread.tw/1878627", "and from the book page itself");
assert.strictEqual(RS.tocFor("https://twkan.com/txt/76222/46362641").url, "https://twkan.com/ajax_novels/chapterlist/76222.html", "twkan: its AJAX list");
assert.strictEqual(RS.tocFor("https://twkan.com/book/76222.html").url, "https://twkan.com/ajax_novels/chapterlist/76222.html", "also from its book page");
assert.strictEqual(RS.tocFor("https://www.novel543.com/0123456789/8096_1.html").url, "https://www.novel543.com/0123456789/dir", "novel543: /<book>/dir");
assert.strictEqual(RS.tocFor("https://www.twbook.cc/0123456789/8096_1.html").url, "https://www.twbook.cc/0123456789/dir", "twbook: the same layout");
const ncList = "https://novelcult.com/novels/warriors-touch-deadly-touch-book-2-329243/chapters";
for (const from of ["https://novelcult.com/novels/warriors-touch-deadly-touch-book-2-329243", ncList, ncList + "/c003eea9-0a9f-4b72-a0a7-41eb4da8a970"]) assert.strictEqual(RS.tocFor(from).url, ncList, "novelcult: the /chapters page, from the novel page, the list or a chapter");
assert.strictEqual(RS.tocFor("https://www.alicesw.com/book/1/2.html"), null, "a site with no list reader here has none (it is followed page by page)");
assert.strictEqual(RS.tocFor("https://evil.example/1878627"), null);

const listDoc = (selector, ...anchors) => ({ querySelectorAll: (sel) => (sel === selector ? anchors : []) });
const uuToc = RS.tocFor("https://www.uuread.tw/chapter/1878627/2213453.html");
const chapters = RS.tocChapters(listDoc("ul#newlist li a", a("/chapter/1878627/2213453.html", "第1章 金手指五選三，十五年後"), a("/chapter/1878627/2213459.html", "第2章 重生"), a("/chapter/1878627/2213459.html", "第2章 重生 (again)"), a("/chapter/1878627/2213465.html", "序章")), uuToc);
assert.deepStrictEqual(chapters.map((c) => [c.num, c.title, c.url]), [[1, "第1章 金手指五選三，十五年後", "https://www.uuread.tw/chapter/1878627/2213453.html"], [2, "第2章 重生", "https://www.uuread.tw/chapter/1878627/2213459.html"], [3, "序章", "https://www.uuread.tw/chapter/1878627/2213465.html"]], "absolute addresses, the number is the place in the list (not the title's), a repeated address once");
const tw = RS.tocChapters(listDoc("ul li a", a("/txt/1/10", "第10章 a"), a("/about", "About"), a("/txt/1/11", "第11章 b")), RS.tocFor("https://twkan.com/txt/76222/1"));
assert.deepStrictEqual(tw.map((c) => c.num), [1, 2], "twkan: only chapter links count, numbered by their place");
const nc = RS.tocChapters(listDoc("a[href*='/chapters/']", a("/novels/x-1/chapters/aaa", "1: One"), a("/novels/x-1/chapters", "Chapters"), a("/novels/x-1/chapters/bbb", "2: Two"), a("/novels/other-2/chapters/ccc", "elsewhere")), RS.tocFor(ncList));
assert.deepStrictEqual(nc.map((c) => c.url), ["https://novelcult.com/novels/x-1/chapters/aaa", "https://novelcult.com/novels/x-1/chapters/bbb", "https://novelcult.com/novels/other-2/chapters/ccc"], "novelcult: the chapter links, not the link to the list");
const n5 = RS.tocChapters(listDoc("div.chaplist ul:nth-of-type(2) a", a("/0123456789/8096_1.html", "第1章 x")), RS.tocFor("https://www.novel543.com/0123456789/8096_1.html"));
assert.strictEqual(n5[0].url, "https://www.novel543.com/0123456789/8096_1.html", "novel543: the second list on the page");

// a list taken from one of several boxes
(() => {
  const link = (href, text) => ({ textContent: text, getAttribute: () => href });
  const box = (...links) => ({ querySelectorAll: (sel) => (sel === "a" ? links : []) });
  const doc = (sel, boxes) => ({ querySelectorAll: (s) => (s === sel ? boxes : []) });
  const boxes = [box(link("/a1", "A1")), box(link("/b1", "B1"), link("/b2", "B2"))];
  RS.register("boxes.example", { selector: "div.t", toc: { boxes: "ul.chapters", pick: "last" } });
  const last = RS.tocFor("https://boxes.example/x");
  assert.deepStrictEqual(Array.from(RS.tocChapters(doc("ul.chapters", boxes), { rule: last.rule, url: "https://boxes.example/book" }), (c) => c.url), ["https://boxes.example/b1", "https://boxes.example/b2"], "the links under the last box");
  RS.register("boxes2.example", { selector: "div.t", toc: { boxes: "ul.chapters", pick: "first", reverse: true } });
  const first = RS.tocFor("https://boxes2.example/x");
  assert.deepStrictEqual(Array.from(RS.tocChapters(doc("ul.chapters", boxes), { rule: first.rule, url: "https://boxes2.example/book" }), (c) => c.url), ["https://boxes2.example/a1"], "or the first, and reversed when it is newest first");
  assert.deepStrictEqual(RS.tocChapters(doc("ul.chapters", []), { rule: last.rule, url: "https://boxes.example/book" }), [], "no box: no chapters, not a failure");
  // a list over several pages: the others named by the first, joined in order, reversed once
(() => {
  const el = (attrs, href) => ({ getAttribute: (n) => (n === "href" ? href : attrs[n] || null) });
  const doc = (map) => ({ querySelectorAll: (s) => map[s] || [] });
  RS.register("pages.example", { selector: "div.t", toc: { list: "ul a", pages: { options: "#pg option", attr: "data-url" } } });
  const t = RS.tocFor("https://pages.example/x");
  const first = doc({ "#pg option": [el({ "data-url": "/book" }), el({ "data-url": "/book?page=2" }), el({ "data-url": "/book?page=3" }), el({ "data-url": "/book?page=2" }), el({})] });
  assert.deepStrictEqual(RS.tocPageUrls(first, { rule: t.rule, url: "https://pages.example/book" }), ["https://pages.example/book?page=2", "https://pages.example/book?page=3"], "the other pages, absolute, each once, not the page itself");
  RS.register("links.example2", { selector: "div.t", toc: { list: "ul a", pages: { links: "ul.pager a" } } });
  const lt = RS.tocFor("https://links.example2/x");
  assert.deepStrictEqual(RS.tocPageUrls(doc({ "ul.pager a": [el({}, "?page=2"), el({}, "?page=3"), el({}, "javascript:void(0)")] }), { rule: lt.rule, url: "https://links.example2/b" }).slice(0, 2), ["https://links.example2/b?page=2", "https://links.example2/b?page=3"], "or the links to them");
  assert.deepStrictEqual(RS.tocPageUrls(first, { rule: RS.tocFor("https://uuread.tw/x/1.html").rule, url: "https://uuread.tw/b" }), [], "a one-page list has no others");
  const link = (u, t) => ({ title: t, url: u });
  const joined = RS.tocJoin([[link("https://p/1", "a"), link("https://p/2", "b")], [link("https://p/2", "b again"), link("https://p/3", "c")]], { rule: { toc: {} } });
  assert.deepStrictEqual(joined.map((c) => [c.num, c.url]), [[1, "https://p/1"], [2, "https://p/2"], [3, "https://p/3"]], "pages joined in order, a repeated address once, numbered by place");
  const newestFirst = RS.tocJoin([[link("https://p/3", "c"), link("https://p/2", "b")], [link("https://p/1", "a")]], { rule: { toc: { reverse: true } } });
  assert.deepStrictEqual(newestFirst.map((c) => c.url), ["https://p/1", "https://p/2", "https://p/3"], "a newest-first list is reversed as a whole, not page by page");
})();
// a hand-written rule registered after the generated one keeps what the generated one knew of the book's page
  RS.register("keeps.example", { selector: "div.t", book: { title: "h1" }, from: "generated" });
  RS.register("keeps.example", { selector: "div.u", toc: { list: "ul a" }, from: "by hand" });
  assert.deepStrictEqual(RS.ruleFor("https://keeps.example/x").book, { title: "h1" }, "the book selectors survive");
  assert.strictEqual(RS.ruleFor("https://keeps.example/x").selector, "div.u", "while the rest is the hand-written rule");
})();

// paragraphs stay apart: textContent alone would join <p> blocks into one line
(() => {
  const para = (t) => ({ t, append(s) { this.t += s; }, remove() {} });
  const ps = [para("First paragraph."), para("Second paragraph."), para("Third.")];
  const box = {
    querySelectorAll: (sel) => (sel === "br" ? [] : /^p,/.test(sel) ? ps : []),
    get textContent() { return ps.map((p) => p.t).join(""); }
  };
  const doc = { querySelector: () => box };
  assert.strictEqual(RS.textOf(doc, { selector: "div.c" }), "First paragraph.\nSecond paragraph.\nThird.", "one line per paragraph");
})();

// ---- page scripts never reach the parser ----
assert.strictEqual(RS.stripScripts('<a onclick="x()" href=1>t</a><script>var a=1;</script><div class="txtnav" onload=\'y\'>hi</div>'), '<a href=1>t</a><div class="txtnav">hi</div>');

console.log("OK — raw-sources checks passed");
