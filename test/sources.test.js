// The site rules: the generator that turns WebToEpub's parsers into rules, and the registry they end up in. Run: node test/sources.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const gen = require("../tools/gen-sources");
const tools = require("../tools/sources");

// ---------- the generator, on made-up parsers in WebToEpub's shapes ----------
const parsers = {
  "Simple.js": `
parserFactory.register("simple.example", () => new SimpleParser());
parserFactory.register("www.alias.example", () => new SimpleParser());
parserFactory.registerDeadSite("dead.example", () => new SimpleParser());
class SimpleParser extends Parser {
    constructor() { super(); }
    async getChapterUrls(dom) {
        let menu = dom.querySelector("ul.chapters");
        return util.hyperlinksToChapterList(menu);
    }
    findContent(dom) {
        return dom.querySelector("div.text");
    }
    removeUnwantedElementsFromContentElement(element) {
        util.removeChildElementsMatchingSelector(element, ".ad, #promo");
        super.removeUnwantedElementsFromContentElement(element);
    }
}
`,
  "Gbk.js": `
parserFactory.register("gbk.example", () => new GbkParser());
class GbkParser extends Parser {
    findContent(dom) {
        return dom.querySelector("#chaptercontent") || dom.querySelector(".content");
    }
    async getChapterUrls(dom) {
        return [...dom.querySelectorAll("div.list a")]
            .map(a => util.hyperLinkToChapter(a))
            .reverse();
    }
    async fetchChapter(url) {
        return (await HttpClient.wrapFetch(url, this.makeOptions())).responseXML;
    }
    makeOptions() {
        return ({ makeTextDecoder: () => new TextDecoder("gbk") });
    }
}
`,
  "Family.js": `
parserFactory.register("child.example", () => new ChildParser());
parserFactory.register("plainchild.example", () => new PlainChildParser());
class BaseParser extends Parser {
    findContent(dom) { return dom.querySelector("div.base-content"); }
    makeOptions() { return ({ makeTextDecoder: () => new TextDecoder("gb18030") }); }
    async fetchChapter(url) { return (await HttpClient.wrapFetch(url, this.makeOptions())).responseXML; }
}
class ChildParser extends BaseParser {
    async fetchChapter(url) { return (await HttpClient.wrapFetch(url, this.makeOptions())).responseXML; }
}
class PlainChildParser extends BaseParser {
    async fetchChapter(url) { return (await HttpClient.wrapFetch(url)).responseXML; }
}
`,
  "Shapes.js": `
parserFactory.register("inline.example", () => new InlineParser());
parserFactory.register("pick.example", () => new PickParser());
parserFactory.register("content.example", () => new ContentListParser());
parserFactory.register("links.example", () => new LinksParser());
parserFactory.register("filtered.example", () => new FilteredParser());
class InlineParser extends Parser {
    findContent(dom) { return dom.querySelector("div.text"); }
    async getChapterUrls(dom) {
        return util.hyperlinksToChapterList(dom.querySelector("ul.toc"));
    }
    extractTitleImpl(dom) { return dom.querySelector(".book h1"); }
    extractAuthor(dom) {
        let authorLabel = dom.querySelector(".book .right a");
        return authorLabel?.textContent ?? super.extractAuthor(dom);
    }
    extractDescription(dom) { return dom.querySelector("div.intro").textContent.trim(); }
    findCoverImageUrl(dom) { return util.getFirstImgSrc(dom, "div.cover"); }
    extractSubject(dom) { return [...dom.querySelectorAll("span.genre a")].map(a => a.textContent).join(", "); }
}
class PickParser extends Parser {
    findContent(dom) { return dom.querySelector("div.text"); }
    async getChapterUrls(dom) {
        let menu = [...dom.querySelectorAll("ul.chapters")].pop();
        return util.hyperlinksToChapterList(menu);
    }
}
class ContentListParser extends Parser {
    findContent(dom) { return dom.querySelector("div.post-content"); }
    async getChapterUrls(dom) {
        let menu = this.findContent(dom);
        return util.hyperlinksToChapterList(menu);
    }
}
class LinksParser extends Parser {
    findContent(dom) { return dom.querySelector("div.text"); }
    async getChapterUrls(dom) {
        return [...dom.querySelectorAll("div.chapter-item a")]
            .map(link => this.linkToChapter(link))
            .reverse();
    }
}
class FilteredParser extends Parser {
    findContent(dom) { return dom.querySelector("div.text"); }
    async getChapterUrls(dom) {
        return [...dom.querySelectorAll("a.chapter-card")]
            .filter(a => a.dataset.premium !== "1")
            .map(a => this.linkToChapter(a));
    }
}
`,
  "Paged.js": `
parserFactory.register("paged.example", () => new PagedParser());
parserFactory.register("computed.example", () => new ComputedPagesParser());
class PagedParser extends Parser {
    findContent(dom) { return dom.querySelector("div.text"); }
    async getChapterUrls(dom, chapterUrlsUI) {
        return this.getChapterUrlsFromMultipleTocPages(dom,
            this.extractPartialChapterList,
            this.getUrlsOfTocPages,
            chapterUrlsUI
        );
    }
    extractPartialChapterList(dom) {
        let menu = dom.querySelector("ul#idData");
        return util.hyperlinksToChapterList(menu);
    }
    getUrlsOfTocPages(dom) {
        let options = [...dom.querySelectorAll("#indexselect option")];
        // first option is the page already parsed
        return options.slice(1).map(o => new URL(o.dataset.tocUrl, dom.baseURI).href);
    }
}
class ComputedPagesParser extends Parser {
    findContent(dom) { return dom.querySelector("div.text"); }
    async getChapterUrls(dom, chapterUrlsUI) {
        return (await this.getChapterUrlsFromMultipleTocPages(dom,
            ComputedPagesParser.extractPartialChapterList,
            ComputedPagesParser.getUrlsOfTocPages,
            chapterUrlsUI
        )).reverse();
    }
    static extractPartialChapterList(dom) {
        return [...dom.querySelectorAll("#list dd a")].map(a => util.hyperLinkToChapter(a));
    }
    static getUrlsOfTocPages(dom) {
        let lastUrl = dom.querySelector("#pagelink a.last").href;
        let maxUrl = parseInt(lastUrl.substring(lastUrl.lastIndexOf("/") + 1));
        let urls = [];
        for (let i = 2; i <= maxUrl; ++i) { urls.push(lastUrl + i); }
        return urls;
    }
}
`,
  "Clever.js": `
parserFactory.register("clever.example", () => new CleverParser());
parserFactory.register("built.example", () => new BuiltParser());
class CleverParser extends Parser {
    findContent(dom) { return dom.querySelector("div.c"); }
    async getChapterUrls(dom) {
        let tocUrl = dom.querySelector("a.toc").href;
        let toc = (await HttpClient.wrapFetch(tocUrl)).responseXML;
        return util.hyperlinksToChapterList(toc.querySelector("ul"));
    }
}
class BuiltParser extends Parser {
    findContent(dom) { return Parser.findConstructedContent(dom); }
}
`
};
const rules = gen.extractRules(parsers);

assert.deepStrictEqual(Object.keys(rules).sort(), ["alias.example", "child.example", "clever.example", "computed.example", "content.example", "filtered.example", "gbk.example", "inline.example", "links.example", "paged.example", "pick.example", "plainchild.example", "simple.example"], "built.example (no selector) and dead.example are left out; 'www.' is dropped from a name");
assert.strictEqual(rules["simple.example"].selector, "div.text");
assert.strictEqual(rules["simple.example"].junk, "script, style, ins, iframe, .ad, #promo", "the parser's junk is added to the always-removed elements");
assert.deepStrictEqual(rules["simple.example"].toc, { list: "ul.chapters a" }, "the links under the element the list is read from");
assert.strictEqual(rules["simple.example"].from, "Simple.js", "where it came from");
assert.deepStrictEqual(rules["alias.example"], rules["simple.example"], "two names, one parser");
assert.strictEqual(rules["gbk.example"].selector, "#chaptercontent, .content", "'a || b' becomes the CSS list 'a, b'");
assert.strictEqual(rules["gbk.example"].charset, "gbk", "the encoding comes from the parser's decoder (through makeOptions)");
assert.deepStrictEqual(rules["gbk.example"].toc, { list: "div.list a", reverse: true }, "a list read as the links themselves, and reversed when the site lists newest first");
assert.strictEqual(rules["child.example"].selector, "div.base-content", "a parser inherits its parent's content selector, across classes");
assert.strictEqual(rules["child.example"].charset, "gb18030", "and the encoding, when it fetches with the parent's options");
assert.strictEqual(rules["plainchild.example"].charset, undefined, "but not when it fetches its own way with no encoding (it is a different site)");
assert.strictEqual(rules["clever.example"].toc, undefined, "a list that needs a second page is not guessed at");
assert.ok(gen.render(rules).includes('RawSources.registerAll({'), "it renders as one registration per site");
// more list shapes
assert.deepStrictEqual(rules["inline.example"].toc, { list: "ul.toc a" }, "links under a box named inline");
assert.deepStrictEqual(rules["pick.example"].toc, { boxes: "ul.chapters", pick: "last" }, "the last of several boxes");
assert.deepStrictEqual(rules["content.example"].toc, { boxes: "div.post-content", pick: "first" }, "a list that lives inside the content box");
assert.deepStrictEqual(rules["links.example"].toc, { list: "div.chapter-item a", reverse: true }, "these links, newest first");
assert.strictEqual(rules["filtered.example"].toc, undefined, "links that are filtered would list something else: no guess");
// a list over several pages: the first page's list and where the other pages are named
assert.deepStrictEqual(rules["paged.example"].toc, { list: "ul#idData a", pages: { options: "#indexselect option", attr: "data-toc-url" } }, "the first page's links, and the option attribute that holds each other page's address");
assert.strictEqual(rules["computed.example"].toc, undefined, "page numbers counted up in code are not guessed at");
assert.deepStrictEqual(gen.pagesOf('getUrlsOfTocPages(dom) {\n    return [...dom.querySelectorAll("ul.pager a")].map(a => a.href);\n}'), { links: "ul.pager a" }, "links to the pages");
assert.deepStrictEqual(gen.pagesOf('getUrlsOfTocPages(dom) {\n    return [...dom.querySelectorAll("select option")].map(o => o.value);\n}'), { options: "select option", attr: "value" }, "option values");
assert.strictEqual(gen.pagesOf('getUrlsOfTocPages(dom) {\n    let n = parseInt(dom.querySelector("a.last").textContent);\n    return [...dom.querySelectorAll("a")].map(a => a.href);\n}'), null, "anything counted is not guessed at");
// where a book's page says what the book is
assert.deepStrictEqual(rules["inline.example"].book, { title: ".book h1", author: ".book .right a", description: "div.intro", cover: "div.cover", genre: "span.genre a" }, "title, author, description, cover and genre selectors");
assert.strictEqual(rules["simple.example"].book, undefined, "a parser that says nothing about the book gives none");

// selector lists are tidied: stray commas go, commas inside brackets and quotes stay
assert.strictEqual(gen.tidyList("div.a, div.b, "), "div.a, div.b");
assert.strictEqual(gen.tidyList("script, , table,span.x"), "script, table, span.x");
assert.strictEqual(gen.tidyList('p:not(.a, .b), [title="x, y"], '), 'p:not(.a, .b), [title="x, y"]', "commas inside :not() and quoted values are not separators");

// the helpers
assert.strictEqual(gen.methodBody("class A {\n    foo() {\n        if (x) { y(); }\n        return \"}\";\n    }\n    bar() {}\n}", "foo").trim().endsWith("}"), true, "a method's end is found past nested braces and braces in strings");
assert.deepStrictEqual(gen.stringArgs('a.querySelector("x"); b.querySelector(\'y\'); c.querySelectorAll("z")', "querySelector"), ["x", "y"]);

// ---------- the real parsers ----------
const PARSERS = path.join(__dirname, "..", "reference", "WebToEpub", "plugin", "js", "parsers");
if (fs.existsSync(PARSERS)) {
  const real = gen.extractRules(gen.readParsers());
  const n = Object.keys(real).length;
  assert.ok(n >= 500, "most of WebToEpub's sites yield a rule (" + n + ")");
  assert.strictEqual(fs.readFileSync(gen.OUT, "utf8"), gen.render(real), "sources/_generated.js is what the generator makes from the parser snapshot (run: node tools/gen-sources.js)");
  assert.strictEqual(real["230book.net"].charset, "gbk", "a real parser: the encoding set through makeOptions");
  assert.strictEqual(real["69shuba.tw"].charset, undefined, "a real parser that fetches in its own way, with no encoding");
  assert.strictEqual(real["trxs.cc"].toc.list, ".book_list a", "a real parser: its chapter list");
  const listed = Object.values(real).filter((r) => r.toc).length;
  const booked = Object.values(real).filter((r) => r.book).length;
  assert.ok(listed >= 200, "more than the simplest list shape yields a chapter list (" + listed + ")");
  assert.ok(booked >= 450, "most sites have where their book page says what the book is (" + booked + ")");
  assert.strictEqual(real["230book.net"].book.title, "#info h1", "a real parser: the title of its book page");
  assert.deepStrictEqual(real["novgo.net"].toc, { list: "ul#idData a", pages: { options: "#indexselect option", attr: "data-url" } }, "a real parser: novgo's list runs over pages named by its page selector");
}

// ---------- the registry the extension runs ----------
const reg = tools.loadRegistry();
const hosts = Object.keys(reg);
assert.ok(hosts.length >= 500, "the registry covers the generated sites and the hand-written ones (" + hosts.length + ")");
for (const h of hosts) {
  const r = reg[h];
  assert.ok(/^[a-z0-9.-]+\.[a-z]+$/.test(h), h + " is a plain host name (no www., no path)");
  assert.ok(typeof r.selector === "string" && r.selector.trim(), h + " has a content selector");
  if (r.junk !== undefined) assert.ok(typeof r.junk === "string" && r.junk.includes("script"), h + ": junk keeps the always-removed elements");
  if (r.charset) assert.doesNotThrow(() => new TextDecoder(r.charset), h + ": the encoding is one the browser knows");
  if (r.toc) assert.ok(typeof r.toc.list === "function" || typeof r.toc.parse === "function", h + ": a chapter list becomes a function when registered (or is parsed from JSON)");
  if (r.next) assert.strictEqual(typeof r.next, "function", h);
}
// hand-written files win over the generated one, and keep their extras
assert.strictEqual(typeof reg["uuread.tw"].toc.url, "function", "uuread.tw: its own rule (a list address from a chapter address), not a generated one");
assert.strictEqual(typeof reg["uuread.tw"].next, "function", "and its page-by-page chapters");
assert.strictEqual(reg["69shuba.com"].charset, "gb18030");
assert.ok(reg["101kanshu.com"], "a hand-written file can register several names");
assert.deepStrictEqual(tools.dataFiles().map((f) => path.basename(f))[0], "_generated.js", "the generated file loads first, so everything else overrides it");

// families of sites (sources/families.js): a list added to the generated rule, which keeps the text selector and the book details
(() => {
  const RSF = tools.load();
  assert.ok(RSF.hostsOf("NovelfullParser").length >= 20, "the generator names each site's parser, so a family can be found");
  assert.ok(Object.keys(RSF.SOURCES).filter((h) => RSF.SOURCES[h].toc).length >= 300, "the families add their chapter lists to the generated ones");
  for (const h of ["novelfull.com", "readwn.com", "lightnovelpub.com", "88xiaoshuo.net", "blossomtranslation.com", "freewebnovel.com", "novellive.com", "novelbin.com", "ranobes.top", "ranobes.com"]) {
    assert.strictEqual(typeof RSF.SOURCES[h].toc.list, "function", h + " reads a chapter list");
    assert.ok(RSF.SOURCES[h].selector, h + " keeps its text selector when the list is added");
  }
  RSF.register("extend.example", { selector: "div.t", book: { title: "h1" }, parser: "ExampleParser" });
  RSF.extend(RSF.hostsOf("ExampleParser"), { toc: { list: "ul a" } });
  RSF.extend("not-registered.example", { toc: { list: "ul a" } });
  assert.deepStrictEqual([RSF.SOURCES["extend.example"].selector, RSF.SOURCES["extend.example"].book, typeof RSF.SOURCES["extend.example"].toc.list], ["div.t", { title: "h1" }, "function"], "extend adds to the rule instead of replacing it");
  assert.strictEqual(RSF.SOURCES["not-registered.example"], undefined, "extend does not make up a site");

  // ranobes.top: the list is data in a script on /chapters/<id>/ and its /page/N/ pages, newest first (a trimmed copy of the real page)
  const ranobes = RSF.SOURCES["ranobes.top"];
  const data = { book_id: 244924, chapters: [{ id: "2", title: "Chapter 2\u200c: Two \u200c\u200c", link: "https://ranobes.top/reverend-insanity-v812312-244924/2.html" }, { id: "1", title: "Chapter 1: {One}", link: "/reverend-insanity-v812312-244924/1.html" }], pages_count: 3 };
  const page = '<html><script>var x = {"a": 1};</script><script>\n window.__DATA__ = ' + JSON.stringify(data) + ';\n window.other = {};</script></html>';
  const base = "https://ranobes.top/chapters/244924/";
  assert.strictEqual(ranobes.toc.url("https://ranobes.top/novels/244924-reverend-insanity-v812312.html"), base, "from the book's page");
  assert.strictEqual(ranobes.toc.url("https://ranobes.top/reverend-insanity-v812312-244924/367773.html"), base, "from one of its chapters");
  assert.strictEqual(ranobes.toc.url(base + "page/2/"), base, "from a page of the list");
  assert.strictEqual(ranobes.toc.url("https://ranobes.top/"), null);
  const links = Array.from(ranobes.toc.read({}, base, page), (c) => [c.title, c.url]);
  assert.deepStrictEqual(links, [["Chapter 2: Two", "https://ranobes.top/reverend-insanity-v812312-244924/2.html"], ["Chapter 1: {One}", "https://ranobes.top/reverend-insanity-v812312-244924/1.html"]], "titles without the zero-width characters, braces in a title do not end the data early");
  assert.deepStrictEqual(Array.from(ranobes.toc.pages({}, base, page)), [base + "page/2/", base + "page/3/"], "the other pages from pages_count");
  assert.deepStrictEqual(Array.from(ranobes.toc.pages({}, base + "page/2/", page)), [base + "page/2/", base + "page/3/"], "(from any page of the list)");
  assert.deepStrictEqual(Array.from(ranobes.toc.pages({}, base, "<html>no data</html>")), [], "a page without the data gives nothing");
  assert.deepStrictEqual(Array.from(ranobes.toc.list({}, base, page), (c) => c.title), ["Chapter 1: {One}", "Chapter 2: Two"], "joined pages are turned round once: oldest first");
  assert.strictEqual(ranobes.book.titleDrop, "span.subtitle, span[hidden]", "the title leaves out the original names");

  // addresses built from any address of the novel
  assert.strictEqual(RSF.SOURCES["novelbin.com"].toc.url("https://novelbin.com/b/shadow-slave/chapter-2-x"), "https://novelbin.com/ajax/chapter-archive?novelId=shadow-slave");
  assert.strictEqual(RSF.SOURCES["lightnovelpub.com"].toc.url("https://www.lightnovelpub.com/novel/x/chapter-4"), "https://www.lightnovelpub.com/novel/x/chapters");
  assert.strictEqual(RSF.SOURCES["lightnovelpub.com"].toc.url("https://www.lightnovelpub.com/other"), null);

  // page lists counted in code: stub documents with the elements the parsers look at
  const els = (map) => ({ querySelector: (s) => (map[s] || [])[0] || null, querySelectorAll: (s) => map[s] || [] });
  const a = (href, extra) => Object.assign({ getAttribute: (k) => (k === "href" ? href : null), textContent: "" }, extra);
  assert.deepStrictEqual(Array.from(RSF.SOURCES["novelfull.com"].toc.pages(els({ "li.last a": [a("/b/x?page=4", { getAttribute: (k) => (k === "data-page" ? "3" : "/b/x?page=4") })] }), "https://novelfull.com/x.html")), ["https://novelfull.com/b/x?page=2&per-page=50", "https://novelfull.com/b/x?page=3&per-page=50", "https://novelfull.com/b/x?page=4&per-page=50"], "novelfull: data-page counts from 0");
  assert.deepStrictEqual(Array.from(RSF.SOURCES["novelfull.com"].toc.pages(els({}), "https://novelfull.com/x.html")), [], "a one-page list has no others");
  assert.deepStrictEqual(Array.from(RSF.SOURCES["readwn.com"].toc.pages(els({ "ul.pagination li a": [a("/novel/x.html?page=1"), a("/novel/x.html?page=3")] }), "https://readwn.com/novel/x.html?page=1")), ["https://readwn.com/novel/x.html?page=2", "https://readwn.com/novel/x.html?page=3"], "readwn: every page up to the highest, not the one we are on");
  assert.deepStrictEqual(Array.from(RSF.SOURCES["novellive.com"].toc.pages(els({ ".page a.index-container-btn": [a("/book/x/2"), a("/book/x/4")] }), "https://novellive.com/book/x")), ["https://novellive.com/book/x/2", "https://novellive.com/book/x/3", "https://novellive.com/book/x/4"]);

  // empirenovel.com: the book's own page lists the chapters (a.chapter_link, the date in a .small), newest first, over ?page=N pages
  const emp = RSF.SOURCES["empirenovel.com"];
  assert.strictEqual(emp.toc.reverse, true, "newest first");
  assert.strictEqual(emp.toc.url("https://www.empirenovel.com/novel/reverend-insanity/5"), "https://www.empirenovel.com/novel/reverend-insanity", "the list page, from a chapter's address");
  assert.strictEqual(emp.toc.url("https://www.empirenovel.com/novel/reverend-insanity?page=3"), "https://www.empirenovel.com/novel/reverend-insanity", "and from one of its list pages");
  assert.strictEqual(emp.toc.url("https://www.empirenovel.com/"), null);
  const chapterLink = (href, title) => Object.assign(a(href), { cloneNode: () => ({ querySelectorAll: (sel) => (sel === ".small" ? [{ remove() {} }] : []), textContent: title }) });
  const bookPage = "https://www.empirenovel.com/novel/reverend-insanity";
  assert.deepStrictEqual(Array.from(emp.toc.read(els({ "a.chapter_link": [chapterLink(bookPage + "/2334", "Chapter  2334"), chapterLink(bookPage + "/2333", "Chapter 2333"), chapterLink(bookPage + "/2334", "Chapter 2334 again")] }), bookPage), (c) => [c.title, c.url]), [["Chapter 2334", bookPage + "/2334"], ["Chapter 2333", bookPage + "/2333"]], "titles without the date, each chapter once");
  const pagination = els({ ".pagination a": [a(bookPage + "?page=2"), a(bookPage + "?page=3"), a(bookPage + "?page=76"), a(bookPage + "?page=2"), a("/novel/other")] });
  const empPages = Array.from(emp.toc.pages(pagination, bookPage));
  assert.deepStrictEqual([empPages.length, empPages[0], empPages[empPages.length - 1]], [75, bookPage + "?page=2", bookPage + "?page=76"], "every page up to the highest number in the bar");
  assert.deepStrictEqual(Array.from(emp.toc.pages(els({}), bookPage)), [], "a one-page list has no others");
})();

// 69shuba.com: the list is the book's /book/<id>/ page, in the site's own order
(() => {
  const shu = reg["69shuba.com"];
  assert.strictEqual(shu.toc.url("https://www.69shuba.com/book/74649.htm"), "https://www.69shuba.com/book/74649/", "from the book's info page");
  assert.strictEqual(shu.toc.url("https://www.69shuba.com/txt/74649/38724946"), "https://www.69shuba.com/book/74649/", "from one of its chapters");
  assert.strictEqual(shu.toc.url("https://www.69shuba.com/"), null);
  const li = (n, href, text) => ({ getAttribute: () => String(n), querySelector: () => ({ getAttribute: () => href, textContent: text }) });
  const doc = { querySelectorAll: (sel) => (sel === "li[data-num]" ? [li(770, "/txt/74649/40938079", "第770章 末"), li(2, "/txt/74649/38724947", "第2章 二"), li(1, "/txt/74649/38724946", "第1章 一"), li(0, "/txt/74649/x", "最新"), li(2, "/txt/74649/38724947", "第2章 二（重复）")] : []) };
  const listed = shu.toc.list(doc, "https://www.69shuba.com/book/74649/");
  assert.deepStrictEqual(Array.from(listed, (c) => c.url), ["https://www.69shuba.com/txt/74649/38724946", "https://www.69shuba.com/txt/74649/38724947", "https://www.69shuba.com/txt/74649/40938079"], "in the site's own order, a repeated chapter once, the unnumbered entry left out");
})();

// tomatomtl.com: the text is encrypted in the page; the list is JSON; a fanqienovel chapter is mirrored there
(async () => {
  const nodeCrypto = require("crypto");
  const key16 = nodeCrypto.randomBytes(16);
  const code = Buffer.concat([key16, nodeCrypto.randomBytes(8)]).toString("base64"); // the page's key is the first 16 bytes of this
  const iv = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv("aes-128-cbc", key16, iv);
  const plain = ["第一行" + String.fromCharCode(13), "　第二行  ", "", "第三行"].join(String.fromCharCode(10));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
  const page = 'let unlock_code = "' + code + '"; let encryptedData = {"iv":"' + iv.toString("base64") + '","enc":"' + enc + '"};';
  const tomato = reg["tomatomtl.com"];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await tomato.fromHtml(page, "https://tomatomtl.com/book/1/2"))), { text: ["第一行", "第二行", "第三行"].join(String.fromCharCode(10)), next: null }, "decrypted like the page does, one paragraph per line");
  assert.strictEqual(await tomato.fromHtml("<html>please sign in</html>", "https://tomatomtl.com/book/1/2"), null, "a page without the text (not signed in) gives none");
  assert.strictEqual(tomato.toc.url("https://tomatomtl.com/book/7553857878021377086/7690957211404599870"), "https://tomatomtl.com/catalog/7553857878021377086");
  assert.strictEqual(tomato.toc.url("https://tomatomtl.com/book/0/7690957211404599870"), null, "a book id of 0 does not say which list");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(tomato.toc.parse('[{"title":"第1章 a","id":"11"},{"title":"x","id":"bad"},{"title":"第2章 b","id":"22"}]', "https://tomatomtl.com/catalog/55"))), [{ title: "第1章 a", url: "https://tomatomtl.com/book/55/11" }, { title: "第2章 b", url: "https://tomatomtl.com/book/55/22" }], "addresses with the real book id");
  const RSE = tools.load();
  const fanqie = (url, html) => ({ url, text: async () => html });
  const escaped = ["x", "bookId", "bookId"].join("") && String.fromCharCode(92) + String.fromCharCode(34);
  const field = (v) => "bookId" + escaped + ":" + escaped + v + escaped;
  assert.strictEqual(await RSE.mirrorUrl(fanqie("https://fanqienovel.com/reader/777", "x," + field("") + ",y," + field("555000111") + ",z")), "https://tomatomtl.com/book/555000111/777", "the book id from the page (escaped quotes, the empty first one skipped)");
  assert.strictEqual(await RSE.mirrorUrl(fanqie("https://www.69shuba.com/txt/1/2", "x")), null, "a site with no mirror");
  await assert.rejects(RSE.mirrorUrl(fanqie("https://fanqienovel.com/reader/777", "nothing here")), /which book/, "a page that does not say");
  assert.deepStrictEqual(Array.from(tools.loadMirrorHosts()), ["fanqienovel.com"], "the build gives the extension access to the mirrored site as well");
})().then(() => console.log("OK — tomatomtl checks passed"), (e) => { console.error(e); process.exit(1); });

// the bundle is what ships: one script holding the engine and every site
const bundle = tools.bundleText();
assert.ok(bundle.includes("RawSources.registerAll(") && bundle.includes('R.register("uuread.tw"'), "the bundle has the engine, the generated sites and the hand-written ones");

console.log("OK — sources checks passed");
