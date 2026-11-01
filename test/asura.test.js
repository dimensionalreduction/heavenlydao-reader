// asurascans.com, the built-in rule (sources/asurascans.com.js), on pages fetched from the real site on 2026-10-22 (test/fixtures: only their Astro islands).
// Run: node test/asura.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const RS = require(path.join(__dirname, "..", "src", "shared", "raw-sources.js"));
globalThis.RawSources = RS;
for (const f of require("../tools/sources").dataFiles()) require(f);
const IC = require(path.join(__dirname, "..", "src", "shared", "image-chapter.js"));
const BC = require(path.join(__dirname, "..", "src", "shared", "book-capture.js"));

// a page of just its islands, as far as the rule asks of a document
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function pageOf(file, edit) {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8");
  const islands = [...html.matchAll(/<astro-island[^>]*>/g)].map((m) => {
    const attr = (name) => { const a = new RegExp(" " + name + '="([^"]*)"').exec(m[0]); return a ? decode(a[1]) : null; };
    const island = { component: attr("component-url"), props: attr("props"), getAttribute: (n) => (n === "props" ? island.props : attr(n)) };
    return island;
  });
  if (edit) edit(islands);
  return { querySelector: () => null, querySelectorAll: (sel) => (sel === "astro-island" || sel === "[props]" ? islands : []) };
}

const BOOK = "https://asurascans.com/comics/genius-prismatic-mage-11fe7da3";
const rule = RS.ruleFor(BOOK + "/chapter/1");
assert.ok(rule, "asurascans.com is a built-in site");
assert.ok(rule.pictures && rule.selector, "its chapters are pictures; a selector that only a chapter's page matches tells a chapter from a book");

// the changing end of the book's address
assert.strictEqual(RS.canonicalUrl(BOOK + "/chapter/7"), "https://asurascans.com/comics/genius-prismatic-mage/chapter/7");
assert.strictEqual(RS.canonicalUrl("https://asurascans.com/comics/genius-prismatic-mage/chapter/7"), "https://asurascans.com/comics/genius-prismatic-mage/chapter/7", "already short");

// the list: from a chapter's address or the book's, the chapters in order, as short addresses
for (const from of [BOOK, BOOK + "/chapter/50", "https://asurascans.com/comics/genius-prismatic-mage/chapter/3"]) {
  const toc = RS.tocFor(from);
  assert.ok(toc && toc.url && /^https:\/\/asurascans\.com\/comics\/genius-prismatic-mage(-11fe7da3)?$/.test(toc.url), "the book's page from " + from + ": " + (toc && toc.url));
}
{
  const toc = RS.tocFor(BOOK);
  const chapters = RS.tocChapters(pageOf("asura-book.html"), { rule: toc.rule, url: BOOK }, "");
  assert.strictEqual(chapters.length, 99, "all 99 chapters");
  assert.deepStrictEqual(chapters.slice(0, 2).map((c) => [c.num, c.title, c.url]), [[1, "Chapter 1", "https://asurascans.com/comics/genius-prismatic-mage/chapter/1"], [2, "Chapter 2", "https://asurascans.com/comics/genius-prismatic-mage/chapter/2"]], "oldest first, numbered by place, the short address");
  assert.strictEqual(chapters[98].url, "https://asurascans.com/comics/genius-prismatic-mage/chapter/99");
  // a premium chapter is left out
  const edited = RS.tocChapters(pageOf("asura-book.html", (islands) => {
    const island = islands.find((i) => /ChapterListReact/.test(i.component));
    const props = JSON.parse(island.props);
    props.chapters[1].find((c) => c[1].number[1] === 5)[1].is_premium = [0, true];
    island.props = JSON.stringify(props);
  }), { rule: toc.rule, url: BOOK }, "");
  assert.strictEqual(edited.length, 98, "a premium chapter is not listed");
  assert.ok(!edited.some((c) => /\/chapter\/5$/.test(c.url)));
}

// the book's details, from the page's own data: title, author, synopsis, cover, genres, status
{
  const doc = pageOf("asura-book.html");
  const book = BC.readBookByRule(doc, BOOK, { book: RS.rawRule("asurascans.com").book, selector: rule.selector });
  assert.ok(book, "a book's page");
  assert.strictEqual(book.rawTitle, "Genius Prismatic Mage");
  assert.strictEqual(book.authorRaw, "Hasu");
  assert.strictEqual(book.cover, "https://cdn.asurascans.com/asura-images/covers/genius-prismatic-mage.cd6e06.webp");
  assert.ok(/Action \/ Adventure \/ Fantasy/.test(book.category), "its genres: " + book.category);
  assert.strictEqual(book.status, "Ongoing");
  assert.ok(book.synopsis.length >= 3 && /^In the slums lived a young boy named Ray/.test(book.synopsis[0]) && !/<p>/.test(book.synopsis.join("")), "the synopsis as paragraphs: " + JSON.stringify(book.synopsis.slice(0, 2)));
  assert.strictEqual(book.source, "asurascans.com");
  // a chapter's page is not a book's
  const chapter = pageOf("asura-chapter-50.html");
  const asChapterPage = { ...chapter, querySelector: (sel) => (sel === rule.selector ? {} : null) };
  assert.strictEqual(BC.readBookByRule(asChapterPage, BOOK + "/chapter/50", { book: RS.rawRule("asurascans.com").book, selector: rule.selector }), null, "a chapter's page (it has the reader island) is not recorded as a book");
}

// a chapter: its pictures (the page's own list), and the links to the next and the previous chapter
{
  const doc = pageOf("asura-chapter-50.html");
  const urls = IC.urlsFromProps(doc, BOOK + "/chapter/50");
  assert.strictEqual(urls.length, 10, "10 pictures");
  assert.ok(urls.every((u) => /^https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\/genius-prismatic-mage\/50\/\d{3}\.webp/.test(u)), urls[0]);
  assert.strictEqual(RS.nextChapter(doc, BOOK + "/chapter/50"), "https://asurascans.com/comics/genius-prismatic-mage/chapter/51");
  assert.strictEqual(RS.prevChapter(doc, BOOK + "/chapter/50"), "https://asurascans.com/comics/genius-prismatic-mage/chapter/49");
  const last = pageOf("asura-chapter-99.html");
  assert.strictEqual(IC.urlsFromProps(last, BOOK + "/chapter/99").length, 19, "19 pictures");
  assert.strictEqual(RS.nextChapter(last, BOOK + "/chapter/99"), null, "the last chapter has no next");
  assert.strictEqual(RS.prevChapter(last, BOOK + "/chapter/99"), "https://asurascans.com/comics/genius-prismatic-mage/chapter/98");
}
// a premium chapter (early access): its page has no pictures and says when it unlocks; the rule says so
{
  const locked = pageOf("asura-chapter-locked.html");
  assert.strictEqual(IC.urlsFromProps(locked, BOOK + "/chapter/166").length, 0, "no pictures in a locked chapter's page");
  const why = rule.locked(locked);
  assert.ok(/premium on asurascans\.com until /.test(why) && /2026|22/.test(why), "it says it is premium, and until when: " + why);
  assert.strictEqual(rule.locked(pageOf("asura-chapter-50.html")), "", "a free chapter is not locked");
  assert.strictEqual(rule.locked({ querySelectorAll: () => [] }), "", "a page that is not a chapter's: nothing to say");
}
console.log("OK — asura checks passed");
