// Rules the person adds themselves (src/shared/user-rules.js). Run: node test/user-rules.test.js
const assert = require("assert");
const path = require("path");
const RS = require(path.join(__dirname, "..", "src", "shared", "raw-sources.js"));
globalThis.RawSources = RS;
for (const f of require("../tools/sources").dataFiles()) require(f);
const UR = require("../src/shared/user-rules.js");

// ---- hosts ----
assert.strictEqual(UR.cleanHost("https://www.Example.com/book/1?x=2"), "example.com");
assert.strictEqual(UR.cleanHost("WWW.example.com"), "example.com");
assert.strictEqual(UR.cleanHost("sub.example.co.uk"), "sub.example.co.uk");
for (const bad of ["", "localhost", "*.example.com", "exa mple.com", "http://", "192.168.1.1/x", null]) assert.ok(!UR.cleanHost(bad) || UR.cleanHost(bad) === "192.168.1.1", "not a site: " + bad);
assert.strictEqual(UR.cleanHost("*.example.com"), "", "no wildcards");

// ---- validation ----
const good = { host: "https://www.example.com/", selector: "div.content", junk: ".ad, #share", charset: "GBK", name: "Example" };
let v = UR.validate(good);
assert.ok(v.ok, JSON.stringify(v.errors));
assert.deepStrictEqual(v.spec, { host: "example.com", name: "Example", selector: "div.content", junk: ".ad, #share", charset: "gbk" }, "cleaned: the host without the page address, the encoding lower-cased");
v = UR.validate({ host: "example.com" });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["selector"], "the text selector is needed");
v = UR.validate({ host: "nope", selector: "p" });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["host"]);
v = UR.validate({ host: "example.com", selector: "p", charset: "klingon" });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["charset"], "an encoding the browser does not know");
v = UR.validate({ host: "example.com", selector: "p", evil: "x", toc: { list: "a", evil: 1 }, book: { title: "h1", surprise: "x" } });
assert.ok(v.ok && !("evil" in v.spec) && !("evil" in v.spec.toc) && !("surprise" in v.spec.book), "unknown fields are dropped");
v = UR.validate({ host: "example.com", selector: "x".repeat(600) });
assert.ok(!v.ok && v.errors[0].field === "selector", "an absurd selector");
v = UR.validate({ host: "example.com", selector: "p", toc: { reverse: true } });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["toc.list"], "a chapter list needs its links");
v = UR.validate({ host: "example.com", selector: "p", toc: { boxes: "div.l", pick: "second" } });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["toc.pick"]);
v = UR.validate({ host: "example.com", selector: "p", toc: { list: "a", gap: 5 } });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["toc.gap"], "a pause that is not a pause");
v = UR.validate({ host: "example.com", selector: "p", toc: { list: "a", listUrl: { match: "([", to: "https://example.com/$1" } } });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["toc.listUrl"], "a pattern that is not a regular expression");
v = UR.validate({ host: "example.com", selector: "p", toc: { list: "a", listUrl: { match: "^https://example\\.com/b/(\\d+)", to: "https://evil.example.org/$1" } } });
assert.deepStrictEqual(v.errors.map((e) => e.field), ["toc.listUrl"], "the list address must be on the rule's own site");
assert.ok(!UR.validate(null).ok && !UR.validate("x").ok && !UR.validate([]).ok, "anything that is not a rule");

// ---- from a spec to the rule the engine runs ----
const full = UR.validate({
  host: "example.com", selector: "div.content", junk: ".ad", charset: "gbk",
  toc: { list: "ul.chapters a", reverse: true, gap: 2000, pages: { kind: "options", selector: "#pg option", attr: "data-url" }, listUrl: { match: "^https://(?:www\\.)?example\\.com/(?:book|read)/(\\d+)", to: "/list/$1/" } },
  book: { title: "h1", author: ".au", cover: ".cover" }
});
assert.ok(full.ok, JSON.stringify(full.errors));
const rule = UR.toRule(full.spec);
assert.strictEqual(rule.selector, "div.content");
assert.strictEqual(rule.junk, "script, style, ins, iframe, .ad", "the always-removed elements stay");
assert.deepStrictEqual([rule.charset, rule.user, rule.from], ["gbk", true, "added by you"]);
assert.strictEqual(rule.toc.list, "ul.chapters a");
assert.strictEqual(rule.toc.gap, 2000);
assert.strictEqual(rule.toc.url("https://www.example.com/book/42/chapter-7"), "https://www.example.com/list/42/", "the list's address, built from the novel's");
assert.strictEqual(rule.toc.url("https://www.example.com/about"), null, "an address that is not a novel's");
assert.deepStrictEqual(rule.book, { title: "h1", author: ".au", cover: ".cover" });

// pages named by the first list page, kept to the rule's own site
const opt = (u) => ({ getAttribute: (k) => (k === "data-url" ? u : null) });
const pagesDoc = { querySelectorAll: (s) => (s === "#pg option" ? [opt("/list/42/?page=2"), opt("https://example.com/list/42/?page=3"), opt("https://evil.example.org/steal"), opt("http://example.com/plain"), opt("/list/42/?page=2"), opt("")] : []) };
assert.deepStrictEqual(Array.from(rule.toc.pages(pagesDoc, "https://example.com/list/42/")), ["https://example.com/list/42/?page=2", "https://example.com/list/42/?page=3"], "other sites, plain http and repeats are left out");
assert.deepStrictEqual(Array.from(rule.toc.pages({ querySelectorAll: () => { throw new Error("bad selector"); } }, "https://example.com/")), [], "a selector the browser cannot use finds nothing");
const links = UR.toRule(UR.validate({ host: "example.com", selector: "p", toc: { list: "a", pages: { kind: "links", selector: "ul.pager a" } } }).spec);
const link = (u) => ({ getAttribute: (k) => (k === "href" ? u : null) });
assert.deepStrictEqual(Array.from(links.toc.pages({ querySelectorAll: () => [link("?page=2"), link("https://cdn.example.net/x")] }, "https://example.com/list")), ["https://example.com/list?page=2"], "links to the pages, on the site only");

// a book of one chapter, a picture on each of its pages (a gallery: nhentai.net/g/<id>/ and /g/<id>/1/ ... ): no list of links, no order, no list pages
v = UR.validate({ host: "example.com", images: "#image-container > a > img", toc: { gallery: "#thumbnail-container a[href]", list: "ul a", reverse: true, titleDrop: ".x", pages: { kind: "numbered", selector: ".pg a" }, listUrl: { match: "^https://(?:www\\.)?example\\.com/g/([^/?#]+)(?:[/?#]|$)", to: "https://example.com/g/$1/" } } });
assert.ok(v.ok, JSON.stringify(v.errors));
assert.deepStrictEqual(v.spec.toc, { gallery: "#thumbnail-container a[href]", listUrl: { match: "^https://(?:www\\.)?example\\.com/g/([^/?#]+)(?:[/?#]|$)", to: "https://example.com/g/$1/" } }, "the gallery's links and the list's address; a list, its order, its title parts and its pages are not a gallery's");
assert.ok(UR.validate({ host: "example.com", images: "img", toc: { gallery: "#t a" } }).ok, "a gallery needs no list's links");
assert.deepStrictEqual(UR.validate({ host: "example.com", images: "img", toc: { gallery: "x".repeat(600) } }).errors.map((e) => e.field), ["toc.gallery"], "an absurd selector");
const gallery = UR.toRule(UR.validate({ host: "example.com", images: "#image-container img", book: { title: "h1 > span.pretty" }, toc: { gallery: "#t a", listUrl: { match: "^https://(?:www\\.)?example\\.com/g/([^/?#]+)(?:[/?#]|$)", to: "https://example.com/g/$1/" } } }).spec);
const thumb = (u) => ({ getAttribute: (k) => (k === "href" ? u : null) });
const galleryDoc = (links, title) => ({ title: "Book » site", querySelector: (s) => (s === "h1 > span.pretty" && title ? { textContent: "  " + title + " " } : s === "h1" ? { textContent: "[Circle] " + title + " [English]" } : null), querySelectorAll: (s) => (s === "#t a" ? links : []) });
const pagesHere = [thumb("/g/7/1/"), thumb("/g/7/2/"), thumb("https://example.com/g/7/3/#x"), thumb("/g/7/2/"), thumb("https://evil.example.org/g/7/4/"), thumb("/g/7/")];
assert.deepStrictEqual(Array.from(gallery.toc.galleryPages(galleryDoc(pagesHere, "A Book"), "https://example.com/g/7/")), ["https://example.com/g/7/1/", "https://example.com/g/7/2/", "https://example.com/g/7/3/"], "its pages in order, each once, on the site, not the book's page itself");
assert.deepStrictEqual(JSON.parse(JSON.stringify(gallery.toc.list(galleryDoc(pagesHere, "A Book"), "https://example.com/g/7/#top"))), [{ title: "A Book", url: "https://example.com/g/7/" }], "the list is one chapter: the book's page, named by the book's title");
assert.deepStrictEqual(JSON.parse(JSON.stringify(gallery.toc.list(galleryDoc(pagesHere, ""), "https://example.com/g/7/"))), [{ title: "[Circle] [English]", url: "https://example.com/g/7/" }], "with no title of its own, the page's h1 (its spaces as one)");
assert.deepStrictEqual(Array.from(gallery.toc.list(galleryDoc([], "A Book"), "https://example.com/g/7/")), [], "a page without the links has no chapter (a page of the book, not the book's page)");
assert.strictEqual(gallery.toc.url("https://example.com/g/7/12/"), "https://example.com/g/7/", "the book's page from one of its pages");
const RSg = { rule: gallery, url: "https://example.com/g/7/" };
assert.deepStrictEqual(RS.tocChapters(galleryDoc(pagesHere, "A Book"), RSg, "").map((c) => [c.num, c.url]), [[1, "https://example.com/g/7/"]], "numbered as a list is");
// what Detect finds replaces what was saved: a gallery replaces a list, a list replaces a gallery
let st = UR.withDetected({ "example.com": { spec: { host: "example.com", toc: { list: "ul a", reverse: true, pages: { kind: "numbered", selector: ".pg a" }, gap: 2000 } }, enabled: true } }, "example.com", { toc: { gallery: "#t a", listUrl: null }, images: "#ic img" }, 1);
assert.deepStrictEqual(st["example.com"].spec.toc, { gallery: "#t a", gap: 2000 }, "a found gallery replaces the list (the pause set by hand stays)");
assert.strictEqual(st["example.com"].spec.images, "#ic img");
st = UR.withDetected(st, "example.com", { toc: { list: "ul.chapters a" } }, 2);
assert.ok(!st["example.com"].spec.toc.gallery && st["example.com"].spec.toc.list === "ul.chapters a", "and a found list replaces the gallery");
// a badge in the title (book.titleDrop) is kept with the title, and goes when a title is found without one
st = UR.withDetected(st, "example.com", { book: { title: "div.post-title > h1", titleDrop: "span.manga-title-badges.hot" } }, 3);
assert.deepStrictEqual(st["example.com"].spec.book, { title: "div.post-title > h1", titleDrop: "span.manga-title-badges.hot" }, "the badge is saved with the title");
assert.strictEqual(UR.validate(st["example.com"].spec).spec.book.titleDrop, "span.manga-title-badges.hot", "and kept by the rule's check");
assert.ok(!UR.validate({ host: "example.com", book: { author: "a.author", titleDrop: "span.badge" } }).spec.book.titleDrop, "with no title it is not kept");
st = UR.withDetected(st, "example.com", { book: { author: "a.author" } }, 4);
assert.strictEqual(st["example.com"].spec.book.titleDrop, "span.manga-title-badges.hot", "another part found keeps it");
st = UR.withDetected(st, "example.com", { book: { title: "h1.entry-title" } }, 5);
assert.ok(!("titleDrop" in st["example.com"].spec.book), "a new title found without a badge drops it");
// a list found in what the page's script asked for with a POST (the Madara theme's <book>/ajax/chapters/): kept with its address, gone when a list is found otherwise
const ajax = { match: "^https://(?:www\\.)?example\\.com/manga/([^/?#]+)(?:[/?#]|$)", to: "https://example.com/manga/$1/ajax/chapters/" };
st = UR.withDetected(st, "example.com", { toc: { list: "ul.main a", reverse: true, listUrl: ajax, post: true } }, 6);
assert.ok(st["example.com"].spec.toc.post === true && st["example.com"].spec.toc.listUrl.to === ajax.to, "a POST list is saved with its address");
const postRule = UR.toRule(UR.validate(st["example.com"].spec).spec);
assert.ok(postRule.toc.post("https://example.com/manga/moon-river/ajax/chapters/", "https://example.com/manga/moon-river/chapter-2/"), "the rule says its own list address is asked with a POST");
assert.ok(!postRule.toc.post("https://example.com/other/", "https://example.com/manga/moon-river/"), "and no other address");
st = UR.withDetected(st, "example.com", { toc: { list: "ul.chapters a", listUrl: null } }, 7);
assert.ok(!("post" in st["example.com"].spec.toc), "a list found on a page drops it");
st = UR.withDetected(st, "example.com", { toc: { list: "ul.main a", listUrl: ajax, post: true } }, 8);
st = UR.withDetected(st, "example.com", { toc: { gallery: "#t a", listUrl: null } }, 9);
assert.ok(!("post" in st["example.com"].spec.toc), "and so does a gallery");

// ---- saved rules: switched on, valid, applied to the engine ----
const stored = {
  "example.com": { spec: good, enabled: true },
  "off.example.com": { spec: { host: "off.example.com", selector: "p" }, enabled: false },
  "broken.example.com": { spec: { host: "broken.example.com" }, enabled: true },
  "69shuba.com": { spec: { host: "69shuba.com", selector: "div.mine" }, enabled: true }
};
const compiled = UR.compile(stored);
assert.deepStrictEqual(Object.keys(compiled.rules).sort(), ["69shuba.com", "example.com"], "only the rules that are on and valid");
assert.strictEqual(compiled.problems.length, 1, "and the broken one is reported");
const before = RS.ruleFor("https://www.69shuba.com/txt/1/2").selector;
assert.strictEqual(before, "div.txtnav");
assert.strictEqual(RS.ruleFor("https://example.com/a"), null, "not a site before the rule is saved");
assert.strictEqual(UR.apply(stored).count, 2);
assert.strictEqual(RS.ruleFor("https://example.com/book/1").selector, "div.content", "a site the extension did not know is now read");
assert.strictEqual(RS.ruleFor("https://www.69shuba.com/txt/1/2").selector, "div.mine", "the person's rule wins over the built-in one for the same site");
assert.ok(RS.tocFor("https://example.com/x") === null && typeof RS.ruleFor("https://example.com/x").toc === "undefined", "(this one has no chapter list rule)");
assert.deepStrictEqual(RS.userHosts().sort(), ["69shuba.com", "example.com"]);
assert.strictEqual(RS.hostForSlug("example.com"), "example.com", "the translation site's raw source names a site of theirs too");
UR.apply({});
assert.strictEqual(RS.ruleFor("https://example.com/a"), null, "removed: gone");
assert.strictEqual(RS.ruleFor("https://www.69shuba.com/txt/1/2").selector, "div.txtnav", "and the built-in rule is back");

// ---- what the book-recording script needs ----
assert.deepStrictEqual(UR.bookTable({ "example.com": { spec: { ...good, book: { title: "h1" } }, enabled: true }, "b.example.com": { spec: { host: "b.example.com", selector: "p" }, enabled: true } }), { "example.com": { book: { title: "h1" }, selector: "div.content" } }, "only rules with book selectors");

// ---- a rule on top of a built-in one: fix one thing, keep the rest ----
(() => {
  const base = RS.rawRule("69shuba.tw");
  assert.ok(base && base.selector === "#nr1" && base.book.cover === ".bookinfo", "(a built-in rule to sit on)");
  assert.deepStrictEqual(UR.validate({ host: "69shuba.tw", book: { cover: "td > img" } }).errors.map((e) => e.field), ["selector"], "without a built-in rule the chapter selector is needed");
  // a chapter list saved before any chapter's page was looked at (Detect with AI on a book's page): a rule that lists chapters, with no text selector yet
  const listOnly = { host: "asurascans.com", toc: { list: "a.chapter", reverse: true }, book: { title: "h1" } };
  assert.ok(UR.validate(listOnly).ok, "a chapter list alone is a rule");
  const listRule = UR.toRule(UR.validate(listOnly).spec);
  assert.ok(listRule.toc && !listRule.selector, "it has the list and no text selector");
  assert.strictEqual(RS.textOf({ querySelector: () => { throw new Error("must not be asked"); } }, listRule), "", "and reads no text rather than failing");
  // a site whose chapters are pictures (a comic): the pictures' selector stands in for the text selector
  const comic = { host: "asurascans.com", images: "#pages img", toc: { list: "a.chapter" } };
  assert.ok(UR.validate({ host: "asurascans.com", images: "#pages img" }).ok, "the pictures' selector is enough for a rule");
  assert.strictEqual(UR.toRule(UR.validate(comic).spec).images, "#pages img", "the rule carries it");
  assert.strictEqual(UR.validate({ host: "asurascans.com", images: "  " }).errors[0].field, "selector", "(without either, the text selector is asked for)");
  // a changing end of a book's address (asurascans.com: /comics/some-book-11fe7da3/chapter/1) is left out of the chapter addresses
  assert.strictEqual(UR.dropSlugSuffix("https://asurascans.com/comics/genius-prismatic-mage-11fe7da3/chapter/1?x=1#y"), "https://asurascans.com/comics/genius-prismatic-mage/chapter/1?x=1#y");
  assert.strictEqual(UR.dropSlugSuffix("https://x.example/comics/champions-league/chapter/2"), "https://x.example/comics/champions-league/chapter/2", "a word of 8 letters is not a suffix (it needs a digit)");
  assert.strictEqual(UR.dropSlugSuffix("not an address"), "not an address");
  const slugRule = UR.toRule(UR.validate({ host: "asurascans.com", images: "#pages img", slugSuffix: true }).spec);
  assert.strictEqual(slugRule.canonical("https://asurascans.com/comics/a-book-0a1b2c3d/chapter/9"), "https://asurascans.com/comics/a-book/chapter/9", "the rule has it");
  assert.ok(!UR.toRule(UR.validate({ host: "asurascans.com", images: "#pages img" }).spec).canonical, "and only when asked for");
  assert.strictEqual(UR.validate({ host: "asurascans.com", images: "#pages img", slugSuffix: "yes" }).spec.slugSuffix, undefined, "(only true counts)");
  // and the engine keeps chapters under that short address: the list, and the link to the next chapter
  {
    const spec = UR.validate({ host: "asurascans.com", images: "#pages img", slugSuffix: true, nav: { next: "a.next" }, toc: { list: "a.chapter" } }).spec;
    RS.setUserRules({ "asurascans.com": UR.toRule(spec) });
    const link = (href, text) => ({ getAttribute: (n) => (n === "href" ? href : null), textContent: text || "" });
    const chapterPage = "https://asurascans.com/comics/a-book-0a1b2c3d/chapter/1";
    const doc = { querySelector: (sel) => (sel === "a.next" ? link("/comics/a-book-0a1b2c3d/chapter/2") : null), querySelectorAll: (sel) => (sel === "a.chapter" ? [link("/comics/a-book-0a1b2c3d/chapter/1", "One"), link("/comics/a-book-0a1b2c3d/chapter/2", "Two")] : []) };
    assert.strictEqual(RS.nextChapter(doc, chapterPage), "https://asurascans.com/comics/a-book/chapter/2", "the next chapter's link is kept without the changing end");
    const samePage = { querySelector: (sel) => (sel === "a.next" ? link("/comics/a-book-0a1b2c3d/chapter/1") : null), querySelectorAll: () => [] };
    assert.strictEqual(RS.nextChapter(samePage, "https://asurascans.com/comics/a-book/chapter/1"), null, "a link to the page itself, with or without the end, is not the next chapter");
    const toc = RS.tocFor(chapterPage);
    assert.ok(toc, "(the rule has a list)");
    assert.deepStrictEqual(RS.tocChapters(doc, { rule: toc.rule, url: chapterPage }, "").map((c) => c.url), ["https://asurascans.com/comics/a-book/chapter/1", "https://asurascans.com/comics/a-book/chapter/2"], "the list's chapters too");
    assert.strictEqual(RS.canonicalUrl(chapterPage), "https://asurascans.com/comics/a-book/chapter/1");
    assert.strictEqual(RS.canonicalUrl("https://69shuba.tw/x-0a1b2c3d/1"), "https://69shuba.tw/x-0a1b2c3d/1", "a site without the setting keeps its addresses");
    RS.setUserRules({});
  }
  const v2 = UR.validate({ host: "69shuba.tw", book: { cover: "td > img" } }, base);
  assert.ok(v2.ok, JSON.stringify(v2.errors));
  const rule2 = UR.toRule(v2.spec, base);
  assert.strictEqual(rule2.selector, "#nr1", "the chapter selector is the built-in one");
  assert.strictEqual(rule2.junk, base.junk, "and so is its junk");
  assert.deepStrictEqual(rule2.book, { ...base.book, cover: "td > img" }, "the book selectors are the built-in ones, with the cover replaced");
  assert.deepStrictEqual([rule2.user, rule2.from, rule2.parser], [true, "added by you, on top of the built-in rule", base.parser]);
  const withJunk = UR.toRule(UR.validate({ host: "69shuba.tw", junk: ".extra" }, base).spec, base);
  assert.strictEqual(withJunk.junk, base.junk + ", .extra", "junk is added to the built-in junk");
  // through the saved rules and the engine
  UR.apply({ "69shuba.tw": { spec: { host: "69shuba.tw", book: { cover: "td > img" } }, enabled: true } });
  const live = RS.ruleFor("https://69shuba.tw/book/390935/");
  assert.deepStrictEqual([live.selector, live.book.cover, live.book.title], ["#nr1", "td > img", base.book.title], "a one-field rule changes just that field of the live rule");
  assert.strictEqual(typeof RS.ruleFor("https://69shuba.com/txt/1/2").toc.list, "function", "(other sites are not touched)");
  UR.apply({});
  assert.strictEqual(RS.ruleFor("https://69shuba.tw/book/390935/").book.cover, ".bookinfo", "removed: the built-in cover selector is back");
  // what the book-recording script is given: only what the person set
  assert.deepStrictEqual(UR.bookTable({ "69shuba.tw": { spec: { host: "69shuba.tw", book: { cover: "td > img" } }, enabled: true } }), { "69shuba.tw": { book: { cover: "td > img" } } }, "just the cover (no chapter selector of its own)");
  assert.deepStrictEqual(UR.bookTable({ "example.com": { spec: { host: "example.com", book: { cover: "img" } }, enabled: false } }), {}, "a rule that is off gives nothing");
})();

// ---- a chapter list of the person's own, on a site that has a built-in list rule: the rest of the built-in list rule stays ----
(() => {
  const base = RS.rawRule("empirenovel.com");
  assert.ok(base && typeof base.toc.url === "function" && typeof base.toc.pages === "function" && base.toc.reverse, "(a built-in list rule to sit on: its list address, its pages, newest first)");
  // what an older "Detect with AI" saved: just the links and the order
  const spec = UR.validate({ host: "empirenovel.com", toc: { list: "a.mine", reverse: false } }, base);
  assert.ok(spec.ok, JSON.stringify(spec.errors));
  const rule = UR.toRule(spec.spec, base);
  assert.strictEqual(rule.toc.list, "a.mine", "the person's links");
  assert.strictEqual(!!rule.toc.reverse, false, "and the order they gave, not the built-in one");
  const book = "https://www.empirenovel.com/novel/100-love-from-the-boss";
  assert.strictEqual(rule.toc.url(book + "/12"), book, "the list page is still found from any address of the book (without it the chapter's own page was read, and a bot check on it was the whole error)");
  assert.strictEqual(rule.toc.pages, base.toc.pages, "and the other pages of the list are still read");
  UR.apply({ "empirenovel.com": { spec: spec.spec, enabled: true } });
  assert.strictEqual(RS.tocFor(book + "/12").url, book, "through the engine too");
  // no order given: the built-in one is not carried over to a list it was not made for
  const noOrder = UR.toRule(UR.validate({ host: "empirenovel.com", toc: { list: "a.mine" } }, base).spec, base);
  assert.ok(!noOrder.toc.reverse, "(a list of the person's own has its own order)");
  // settings without a list of their own change just those
  const pause = UR.toRule(UR.validate({ host: "empirenovel.com", toc: { gap: 3000 } }, base).spec, base);
  assert.deepStrictEqual([pause.toc.gap, pause.toc.reverse, pause.toc.list === base.toc.list], [3000, base.toc.reverse, true], "a pause alone leaves the built-in links and order");
  UR.apply({});
})();

// ---- a list address of the person's own that covers only chapters: the built-in one still finds the list from the book's page ----
(() => {
  const base = RS.rawRule("69shuba.com");
  // what Detect with AI saved on 69shuba's list page: the links, and the list's address from a chapter's
  const saved = { host: "69shuba.com", toc: { list: "#catalog > ul a", listUrl: { match: "^https://(?:www\\.)?69shuba\\.com/txt/([^/?#]+)(?:[/?#]|$)", to: "https://www.69shuba.com/book/$1/" } } };
  const spec = UR.validate(saved, base);
  assert.ok(spec.ok, JSON.stringify(spec.errors));
  const rule = UR.toRule(spec.spec, base);
  assert.strictEqual(rule.toc.url("https://www.69shuba.com/txt/3903/2344025"), "https://www.69shuba.com/book/3903/", "from a chapter: theirs");
  assert.strictEqual(rule.toc.url("https://www.69shuba.com/book/3903.htm"), "https://www.69shuba.com/book/3903/", "from the book's page, which theirs does not cover: the built-in one (else 'the chapter has no link to the chapter list')");
  assert.strictEqual(rule.toc.list, "#catalog > ul a", "with their links");
  UR.apply({ "69shuba.com": { spec: spec.spec, enabled: true } });
  assert.strictEqual(RS.tocFor("https://www.69shuba.com/book/3903.htm").url, "https://www.69shuba.com/book/3903/", "through the engine too");
  UR.apply({});
})();

// ---- following storage ----
(async () => {
  const listeners = [];
  const mem = { userRules: { "example.com": { spec: good, enabled: true } } };
  const ext = { storage: { local: { get: async (k) => ({ [k]: mem[k] }) }, onChanged: { addListener: (f) => listeners.push(f) } } };
  await UR.start(ext);
  assert.ok(RS.ruleFor("https://example.com/a"), "read from storage at start");
  listeners[0]({ userRules: { newValue: {} } }, "local");
  assert.strictEqual(RS.ruleFor("https://example.com/a"), null, "and follows a change");
  listeners[0]({ userRules: { newValue: { "example.com": { spec: good, enabled: true } } } }, "sync");
  assert.strictEqual(RS.ruleFor("https://example.com/a"), null, "(only the local area counts)");
  listeners[0]({ userRules: { newValue: { "example.com": { spec: good, enabled: true } } } }, "local");
  assert.ok(RS.ruleFor("https://example.com/a"));

  // the offscreen document has no storage: it asks the service worker, and is told of changes
  UR.apply({});
  const msgs = [];
  const asked = [];
  const ext2 = { runtime: { sendMessage: async (m) => (asked.push(m), { result: { "example.com": { spec: good, enabled: true } } }), onMessage: { addListener: (f) => msgs.push(f) } } };
  await UR.start(ext2);
  assert.deepStrictEqual(asked, [{ target: "p2p-bg", op: "getUserRules" }]);
  assert.ok(RS.ruleFor("https://example.com/a"), "asked of the service worker");
  msgs[0]({ target: "user-rules", stored: {} });
  assert.strictEqual(RS.ruleFor("https://example.com/a"), null, "and told when they change");
  msgs[0]({ target: "somebody-else", stored: { "example.com": { spec: good } } });
  assert.strictEqual(RS.ruleFor("https://example.com/a"), null, "(a message not meant for this is ignored)");

  // a page handed the rules (a script injected into a tab)
  UR.apply({});
  globalThis.__USER_RULES__ = { "example.com": { spec: good, enabled: true } };
  await UR.start(null);
  assert.ok(RS.ruleFor("https://example.com/a"), "rules handed over in window.__USER_RULES__");
  delete globalThis.__USER_RULES__;
  UR.apply({});
  console.log("OK — user-rules checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
