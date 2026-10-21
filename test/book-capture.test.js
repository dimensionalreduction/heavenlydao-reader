// What a book's page says about itself, as the capture script reads it. Run: node test/book-capture.test.js
const assert = require("assert");
const B = require("../src/shared/book-capture.js");

// a stand-in for a document: its og: meta tags and links
const page = (metas, links = []) => ({
  querySelectorAll: (sel) => (sel === 'meta[property^="og:"]' ? Object.entries(metas).map(([k, v]) => ({ getAttribute: (n) => (n === "property" ? k : v) })) : sel === "a" ? links.map(([text, href]) => ({ textContent: text, getAttribute: () => href })) : [])
});
const href = "https://www.69shuba.com/book/74649.htm";
const metas = {
  "og:novel:book_name": "仙工开物", "og:novel:author": "蛊真人", "og:novel:category": "修真武侠", "og:novel:status": "连载",
  "og:image": "https://cdn.example/74649s.jpg", "og:novel:read_url": "https://www.69shuba.com/book/74649/",
  "og:description": "火山中，先贤大能遗留的机关仙宫。<br />\n母亲舍命争取。<br />\n我佛心魔印！"
};

const book = B.readBook(page(metas), href);
assert.strictEqual(book.id, "69shuba.com/book/74649", "the site and the book's path, without the extension");
assert.deepStrictEqual([book.source, book.rawTitle, book.authorRaw, book.category, book.status, book.cover, book.listUrl], ["69shuba.com", "仙工开物", "蛊真人", "修真武侠", "Ongoing", "https://cdn.example/74649s.jpg", "https://www.69shuba.com/book/74649/"]);
assert.deepStrictEqual(book.synopsis, ["火山中，先贤大能遗留的机关仙宫。", "母亲舍命争取。", "我佛心魔印！"], "the synopsis as paragraphs, <br /> tags gone");

// a page without the metadata is not a book's page, and sends nothing
assert.strictEqual(B.readBook(page({ "og:title": "Home" }), "https://www.69shuba.com/"), null);
assert.strictEqual(B.readBook(page({ "og:novel:book_name": "x" }), href), null, "a name alone is not enough");

// the list's address from a link when the metadata has none; a non-https one is dropped
const noRead = { ...metas };
delete noRead["og:novel:read_url"];
assert.strictEqual(B.readBook(page(noRead, [["首页", "/"], ["完整目录", "/book/74649/"]]), href).listUrl, "https://www.69shuba.com/book/74649/");
assert.strictEqual(B.readBook(page({ ...metas, "og:image": "http://insecure/x.jpg", "og:novel:read_url": "http://insecure/list" }), href).cover, "", "only https links");

// status words
assert.deepStrictEqual(["连载", "连载中", "完结", "完本", "completed", "？"].map(B.statusOf), ["Ongoing", "Ongoing", "Completed", "Completed", "Completed", ""]);

// the record: titles in English, the originals kept
const texts = B.textsOf(book);
assert.deepStrictEqual(texts, ["仙工开物", "蛊真人", "修真武侠", "火山中，先贤大能遗留的机关仙宫。", "母亲舍命争取。", "我佛心魔印！"]);
const info = B.toNovelInfo(book, ["Immortal Craft", "Gu Zhen Ren", "Xiuzhen Wuxia", "Line one.", "Line two.", "Line three."]);
assert.deepStrictEqual([info.id, info.title, info.rawTitle, info.author, info.authorRaw, info.genres, info.status, info.listUrl], ["69shuba.com/book/74649", "Immortal Craft", "仙工开物", "Gu Zhen Ren", "蛊真人", ["Xiuzhen Wuxia"], "Ongoing", "https://www.69shuba.com/book/74649/"]);
assert.strictEqual(info.synopsis, "Line one.\n\nLine two.\n\nLine three.", "paragraphs kept apart");
const untranslated = B.toNovelInfo(book, null);
assert.strictEqual(untranslated.title, "仙工开物", "if the titles cannot be translated the original words stand in");

// ---- a site without the standard metadata: its page is read through its rule's selectors ----
const el = (text, extra = {}) => ({ textContent: text, tagName: extra.tag || "div", getAttribute: (n) => (extra.attrs || {})[n] || null, querySelector: (s) => (extra.inner || {})[s] || null });
const ruled = (map, all = {}) => ({ querySelector: (s) => map[s] || null, querySelectorAll: (s) => all[s] || [] });
const rule = { selector: "div.txtnav", book: { title: ".info h1", author: ".info .au", description: ".intro", cover: ".cover", genre: ".tags a" } };
const bookPage = ruled({
  ".info h1": el(" 仙工 开物 "), ".info .au": el("作者：蛊真人"), ".intro": el("火山中。\n母亲舍命争取。\n"),
  ".cover": el("", { inner: { img: { getAttribute: (n) => (n === "data-src" ? "/img/c.jpg" : "/img/lazy.gif") } } })
}, { ".tags a": [el("修真"), el("武侠"), el("修真"), el("x".repeat(60))] });
const byRule = B.readBookByRule(bookPage, "https://www.example.org/book/55.html#top", rule);
assert.deepStrictEqual([byRule.id, byRule.source, byRule.url, byRule.rawTitle, byRule.authorRaw, byRule.cover, byRule.category, byRule.listUrl], ["example.org/book/55", "example.org", "https://www.example.org/book/55.html", "仙工 开物", "蛊真人", "https://www.example.org/img/c.jpg", "修真 / 武侠", "https://www.example.org/book/55.html"], "title and author cleaned (the author label dropped), the cover from the lazy-load attribute, genres once each");
assert.deepStrictEqual(byRule.synopsis, ["火山中。", "母亲舍命争取。"], "the synopsis by line");
assert.strictEqual(B.toNovelInfo(byRule, ["Immortal Creation", "Gu Zhenren", "Cultivation / Martial Arts", "a", "b"]).genres.join("|"), "Cultivation|Martial Arts", "the genres split again after translation");
// titleDrop: parts of the title element that are not the title (ranobes.top puts the original names in a subtitle inside the <h1>)
const withSubtitle = ruled({ "h1.title": { textContent: "Reverend Insanity • Gu Zhen Ren Daoist Gu", tagName: "h1", getAttribute: () => null, cloneNode: () => ({ textContent: "Reverend Insanity", querySelectorAll: (s) => (s === "span.subtitle" ? [{ remove() {} }] : []) }) }, ".au": el("Gu Zhen Ren") });
assert.strictEqual(B.readBookByRule(withSubtitle, "https://ranobes.top/novels/1-x.html", { book: { title: "h1.title", titleDrop: "span.subtitle", author: ".au" } }).rawTitle, "Reverend Insanity", "the subtitle is left out of the title");
// a chapter page (it has the chapter text box) is not a book
assert.strictEqual(B.readBookByRule(ruled({ ...Object.fromEntries([[".info h1", el("T")], [".info .au", el("A")], ["div.txtnav", el("text")]]) }), "https://www.example.org/txt/1/2", rule), null, "the chapter's text is on the page: it is a chapter");
// too little to be a book: a title alone
assert.strictEqual(B.readBookByRule(ruled({ ".info h1": el("Only a title") }), "https://www.example.org/x", rule), null);
assert.strictEqual(B.readBookByRule(bookPage, "https://www.example.org/x", { selector: "p" }), null, "a site with no book selectors");
// the person's own selectors on top of the built-in ones: one of theirs that finds nothing on this page (picked on another book's page, where things sat
// elsewhere) gives way to the built-in one for that field; one that does find something wins
const mineOnTop = { selector: "div.txtnav", book: { ...rule.book, author: "p.picked-author", cover: "img.picked-cover", genre: "ul.picked-genres a", description: "div.my-intro" }, fallback: rule.book };
const otherBook = ruled({ ...Object.fromEntries([".info h1", ".info .au", ".intro", ".cover"].map((k) => [k, bookPage.querySelector(k)])), "div.my-intro": el("Their own pick of the synopsis.") }, { ".tags a": [el("修真"), el("武侠")] });
const fellBack = B.readBookByRule(otherBook, "https://www.example.org/book/56.html", mineOnTop);
assert.deepStrictEqual([fellBack.authorRaw, fellBack.cover, fellBack.category, fellBack.synopsis], ["蛊真人", "https://www.example.org/img/c.jpg", "修真 / 武侠", ["Their own pick of the synopsis."]], "author, cover and genres by the built-in selectors where theirs found nothing; the synopsis by theirs");
const noFallback = B.readBookByRule(otherBook, "https://www.example.org/book/56.html", { ...mineOnTop, fallback: null });
assert.deepStrictEqual([noFallback.authorRaw, noFallback.cover, noFallback.category], ["", "", ""], "(a site of their own has nothing to fall back on)");
assert.strictEqual(B.readBookByRule(ruled({ ".info h1": el("T"), ".info .au": el("A") }), "https://www.example.org/b", { book: { title: "[[bad", author: ".info .au" } }) , null, "an unusable selector finds nothing rather than failing");

// ---- a cover address that does not start with https:// (69shuba.tw: og:image is //p.69shuba.tw/390/390935/390935s.jpg) ----
const tw = "https://69shuba.tw/book/390935/";
assert.strictEqual(B.readBook(page({ ...metas, "og:image": "//p.69shuba.tw/390/390935/390935s.jpg" }), tw).cover, "https://p.69shuba.tw/390/390935/390935s.jpg", "an address without a scheme is the page's own site");
assert.strictEqual(B.readBook(page({ ...metas, "og:image": "/covers/1.jpg" }), tw).cover, "https://69shuba.tw/covers/1.jpg", "so is one with only a path");
assert.strictEqual(B.readBook(page({ ...metas, "og:image": "http://insecure.example/c.jpg" }), tw).cover, "", "plain http is still not taken");

// ---- the selectors complete a book read from the page's metadata, and what the person picked wins ----
const noCover = () => B.readBook(page({ ...metas, "og:image": "" }), tw);
const imgEl = (src) => el("", { tag: "img", attrs: { src } });
const doc2 = (map) => ({ ...page({}), querySelector: (s) => map[s] || null, querySelectorAll: () => [] });
assert.strictEqual(noCover().cover, "", "(a metadata page with no cover)");
assert.strictEqual(B.fillGaps(noCover(), doc2({ ".bookinfo": el("", { inner: { img: imgEl("//p.69shuba.tw/c.jpg") } }) }), tw, { cover: ".bookinfo" }, null).cover, "https://p.69shuba.tw/c.jpg", "the built-in cover selector fills the gap");
assert.strictEqual(B.fillGaps(noCover(), doc2({}), tw, { cover: ".gone" }, null).cover, "", "a selector that finds nothing leaves it empty");
const withCover = () => B.readBook(page({ ...metas, "og:image": "https://cdn.example/meta.jpg" }), tw);
assert.strictEqual(B.fillGaps(withCover(), doc2({ ".bookinfo": el("", { inner: { img: imgEl("/other.jpg") } }) }), tw, { cover: ".bookinfo" }, null).cover, "https://cdn.example/meta.jpg", "a built-in selector does not replace what the page already said");
assert.strictEqual(B.fillGaps(withCover(), doc2({ "td > img": imgEl("/mine.jpg") }), tw, { cover: ".bookinfo" }, { cover: "td > img" }).cover, "https://69shuba.tw/mine.jpg", "but the person's own pick does");
assert.strictEqual(B.fillGaps(withCover(), doc2({}), tw, null, { cover: "td > img" }).cover, "https://cdn.example/meta.jpg", "(and when their pick finds nothing, the metadata stays)");
assert.strictEqual(B.fillGaps(null, doc2({}), tw, {}, {}), null, "no book, nothing to complete");
const synopsisFilled = B.fillGaps(B.readBook(page({ ...metas, "og:description": "" }), tw), doc2({ ".intro": el("First line.\nSecond line.") }), tw, { description: ".intro" }, null);
assert.deepStrictEqual(synopsisFilled.synopsis, ["First line.", "Second line."], "a missing synopsis is read from the page too");

console.log("OK — book-capture checks passed");
