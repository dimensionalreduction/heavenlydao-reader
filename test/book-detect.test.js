// "Detect with AI": Gemini says which candidate is which detail (stubbed), and what is made of its answer. Run: node test/book-detect.test.js
// (Collecting the candidates from a page needs a DOM: that part was tried on the real pages of 69shuba.tw and empirenovel.com.)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const D = require("../src/shared/book-detect.js");
const UR = require("../src/shared/user-rules.js");

// ---- the Gemini call ----
let reply = null;
let sent = null;
const ctx = {
  console, JSON, Array, String, Object, Set,
  chrome: { storage: { local: { get: async () => ({ geminiApiKey: "key-123" }) } } },
  fetch: async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return reply instanceof Error ? Promise.reject(reply) : { ok: reply.ok !== false, status: reply.status || 200, json: async () => reply.json };
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "shared", "gemini.js"), "utf8") + "\n;globalThis.geminiDetectBook = geminiDetectBook;", ctx);
const detect = async (...a) => JSON.parse(JSON.stringify(await ctx.geminiDetectBook(...a)));
const answer = (obj) => ({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });

const candidates = [
  { id: "c1", kind: "meta", tag: "meta", src: "https://x.example/c.jpg" },
  { id: "c2", kind: "text", tag: "h1", text: "Reverend Insanity" },
  { id: "c3", kind: "text", tag: "a", text: "Gu Zhen Ren", href: "/author/gu" },
  { id: "c4", kind: "text", tag: "div", text: "Humans are clever in tens of thousands of ways, Gu are the true refined essences of Heaven and Earth." },
  { id: "c5", kind: "group", tag: "ul", texts: ["Action", "Adventure", "Fantasy"] },
  { id: "c6", kind: "text", tag: "p", text: "Short" },
  { id: "c7", kind: "list", tag: "ul", count: 30, first: ["Chapter 2334", "Chapter 2333", "Chapter 2332"], last: ["Chapter 2239", "Chapter 2238"], hrefs: ["/n/2334", "/n/2238"] },
  { id: "c8", kind: "list", tag: "ul", count: 13, partial: true, first: ["Last words", "Chapter 536", "Chapter 535"], last: ["Chapter 528", "More chapters >>"], hrefs: ["/read/9", "/book/1/"] },
  { id: "c9", kind: "list", tag: "ul", count: 3, first: ["a", "b", "c"], last: ["b", "c"], hrefs: ["/a", "/c"] },
  { id: "c12", kind: "pager", tag: "ul", pages: 76, texts: ["2", "3", "4", "75", "76"], hrefs: ["?page=2", "?page=76"] },
  { id: "c10", kind: "link", tag: "a", href: "/novel/x/6", delta: 1, icon: "fa-chevron-right" },
  { id: "c11", kind: "link", tag: "a", href: "/novel/x/4", delta: -1, icon: "fa-chevron-left" }
];
const selectors = { c1: 'meta[property="og:image"]', c2: "h1.title", c3: "a.author", c4: "div.summary", c5: "ul.genres > li > a", c6: "p.x", c7: "ul.chapters a", c8: "ul.last a", c9: "ul.tiny a", c10: "a.me-3", c11: "a.ms-3", c12: "ul.pagination a" };

(async () => {
  reply = answer({ title: "c2", author: "c3", description: "c4", cover: "c1", genre: "c5" });
  let r = await detect(candidates, { host: "example.com", title: "Reverend Insanity read online" });
  assert.deepStrictEqual(r, { picks: { title: "c2", author: "c3", description: "c4", cover: "c1", genre: "c5", chapterList: null, pager: null, next: null, prev: null, listOrder: null } }, "what Gemini left out is null");
  const prompt = sent.body.contents[0].parts[0].text;
  assert.ok(prompt.includes("example.com") && prompt.includes(JSON.stringify(candidates)), "the site and the candidates go in");
  assert.ok(/ids only/.test(prompt) && /Never invent an id/.test(prompt), "it is asked for ids, not selectors");
  assert.ok(!/selector/i.test(prompt.split("\n\n")[0]), "(it is never asked to write one)");
  assert.strictEqual(sent.body.generationConfig.responseMimeType, "application/json", "JSON, in a fixed shape");
  assert.deepStrictEqual(sent.body.generationConfig.responseSchema.required.slice().sort(), ["author", "chapterList", "cover", "description", "genre", "next", "pager", "prev", "title"]);
  assert.deepStrictEqual(sent.body.generationConfig.responseSchema.properties.listOrder.enum, ["asc", "desc"], "the order of a list is one of two words");
  assert.ok(/delta/.test(prompt) && /partial/.test(prompt) && /chapterList/.test(prompt) && /NEXT chapter/.test(prompt) && /pagination bar/.test(prompt), "it is told what a delta, a partial list, the chapter list, its pagination bar and the next chapter are");
  assert.ok(sent.url.includes("key=key-123"), "with the key the person set");

  reply = answer({ title: "c2", author: null, description: "c99", cover: 7, genre: "" });
  r = await detect(candidates, {});
  assert.deepStrictEqual(r.picks, { title: "c2", author: null, description: null, cover: null, genre: null, chapterList: null, pager: null, next: null, prev: null, listOrder: null }, "null, an id that is not on the page, a number and a blank are no answer");
  reply = answer({ chapterList: "c7", pager: "c12", next: "c10", prev: "c11", listOrder: "desc" });
  r = await detect(candidates, {});
  assert.deepStrictEqual([r.picks.chapterList, r.picks.pager, r.picks.next, r.picks.prev, r.picks.listOrder], ["c7", "c12", "c10", "c11", "desc"], "the chapter list, its pagination bar, the links, and which way the list runs");
  reply = answer({ listOrder: "sideways" });
  assert.strictEqual((await detect(candidates, {})).picks.listOrder, null, "an order that is not asc or desc is no answer");

  reply = { ok: false, status: 429, json: { error: { message: "quota exceeded" } } };
  assert.deepStrictEqual(await detect(candidates, {}), { error: "quota exceeded" }, "Gemini's own reason");
  reply = { ok: false, status: 500, json: {} };
  assert.deepStrictEqual(await detect(candidates, {}), { error: "Gemini answered HTTP 500" });
  reply = { json: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } };
  assert.ok((await detect(candidates, {})).error, "an answer that is not JSON is an error, not a crash");
  reply = new Error("network down");
  assert.deepStrictEqual(await detect(candidates, {}), { error: "network down" });
  assert.deepStrictEqual(await detect([], {}), { error: "no candidates on the page" }, "nothing to ask about");

  // ---- what is made of the answer: only a candidate of a kind the detail can be ----
  let out = D.interpret({ title: "c2", author: "c3", description: "c4", cover: "c1", genre: "c5" }, candidates, selectors);
  assert.deepStrictEqual(out.found, { title: "h1.title", author: "a.author", description: "div.summary", cover: 'meta[property="og:image"]', genre: "ul.genres > li > a" }, "ids become the selectors made from the page's own elements");
  assert.deepStrictEqual(Object.keys(out.skipped).sort(), ["chapterList", "next", "pager", "prev"], "(what was not answered is not on the page)");
  out = D.interpret({ title: "c1", author: "c5", description: "c6", cover: "c2", genre: null }, candidates, selectors);
  assert.deepStrictEqual(out.found, {}, "a picture is not a title, a group is not an author, a short line is not a synopsis, a heading is not a cover");
  assert.deepStrictEqual(Object.keys(out.skipped).sort(), ["author", "chapterList", "cover", "description", "genre", "next", "pager", "prev", "title"]);
  assert.strictEqual(out.skipped.genre, "not found on the page");
  assert.match(out.skipped.description, /too short/);
  out = D.interpret({ title: "c2", genre: "c2" }, candidates, selectors);
  assert.deepStrictEqual(out.found, { title: "h1.title", genre: "h1.title" }, "genres may also be one element's text");
  out = D.interpret({ title: "c404" }, candidates, selectors);
  assert.strictEqual(out.skipped.title, "no such element");
  assert.deepStrictEqual(D.interpret(null, candidates, selectors).found, {}, "no answer at all");
  // the chapter list and the links between chapters
  out = D.interpret({ chapterList: "c7", next: "c10", prev: "c11" }, candidates, selectors);
  assert.deepStrictEqual(out.found, { chapterList: "ul.chapters a", next: "a.me-3", prev: "a.ms-3" }, "a list of links, and two links");
  out = D.interpret({ chapterList: "c8" }, candidates, selectors);
  assert.deepStrictEqual(out.found, {}, "a list that ends in 'more chapters' is only the latest ones");
  assert.match(out.skipped.chapterList, /only the latest chapters are listed here/);
  out = D.interpret({ chapterList: "c9", next: "c7", prev: "c2" }, candidates, selectors);
  assert.deepStrictEqual(out.found, {}, "three links are not a chapter list; a list is not a link; a heading is not a link");
  assert.match(out.skipped.chapterList, /too few links/);
  out = D.interpret({ next: "c1" }, candidates, selectors);
  assert.deepStrictEqual(out.found, {}, "a picture is not a link to the next chapter");
  out = D.interpret({ chapterList: "c7", pager: "c12" }, candidates, selectors);
  assert.deepStrictEqual(out.found, { chapterList: "ul.chapters a", pager: "ul.pagination a" }, "the bar of page links");
  assert.deepStrictEqual(D.interpret({ pager: "c7" }, candidates, selectors).found, {}, "a chapter list is not a pagination bar");
  assert.deepStrictEqual(D.interpret({ chapterList: "c12" }, candidates, selectors).found, {}, "nor the other way round");

  // which way a list runs, from its own numbers
  const entry = (n, t) => ({ text: (t || "Chapter ") + n, href: "/n/" + n });
  assert.strictEqual(D.orderOf([1, 2, 3, 4, 5, 6, 7, 8].map((n) => entry(n))), "asc");
  assert.strictEqual(D.orderOf([8, 7, 6, 5, 4, 3, 2, 1].map((n) => entry(n))), "desc");
  assert.strictEqual(D.orderOf([{ text: "Last words", href: "/x" }, ...[536, 535, 534, 533, 532, 531].map((n) => entry(n)), { text: "More chapters >>", href: "/more" }]), "desc", "entries without a number (a farewell, a link to more) do not matter");
  assert.strictEqual(D.orderOf([{ text: "Chapter 2334Aug 7, 2025", href: "/a" }, { text: "Chapter 2333Aug 7, 2025", href: "/b" }, { text: "Chapter 2332Aug 6, 2025", href: "/c" }, { text: "Chapter 2331Aug 5, 2025", href: "/d" }]), "desc", "the first number is the chapter's, not the date's");
  assert.strictEqual(D.orderOf([{ text: "x", href: "/n/10" }, { text: "y", href: "/n/11" }, { text: "z", href: "/n/12" }, { text: "w", href: "/n/13" }]), "asc", "the address when the text has none");
  assert.strictEqual(D.orderOf([5, 1, 9, 2, 8, 3].map((n) => entry(n))), null, "numbers all over the place say nothing");
  assert.strictEqual(D.orderOf([entry(1), entry(2)]), null, "too few numbers");

  // what was found, as the parts of a rule
  assert.deepStrictEqual(D.asRuleParts({ title: "h1", cover: "img", chapterList: "ul a", next: "a.n", prev: "a.p" }, "desc"), { book: { title: "h1", cover: "img" }, toc: { list: "ul a", reverse: true, pages: null, titleDrop: null }, nav: { next: "a.n", prev: "a.p" } }, "(no pagination bar: the list is one page)");
  assert.deepStrictEqual(D.asRuleParts({ chapterList: "ul a" }, "asc"), { toc: { list: "ul a", reverse: false, pages: null, titleDrop: null } }, "oldest first is said, not left to chance");
  assert.deepStrictEqual(D.asRuleParts({ chapterList: "ul a" }, null), { toc: { list: "ul a", pages: null, titleDrop: null } }, "an order nobody could tell is not made up");
  assert.deepStrictEqual(D.asRuleParts({ chapterList: "ul a", pager: "ul.pagination a" }, "desc", { listUrl: { match: "^m", to: "t" }, titleDrop: ".small" }).toc, { list: "ul a", reverse: true, pages: { kind: "numbered", selector: "ul.pagination a" }, titleDrop: ".small", listUrl: { match: "^m", to: "t" } }, "the whole chapter-list rule: links, order, pages, parts left out of titles, how to reach the list page");
  assert.deepStrictEqual(D.asRuleParts({ pager: "ul.pagination a" }, null), {}, "(a bar with no list is nothing)");
  assert.deepStrictEqual(D.asRuleParts({}, null), {}, "nothing found");

  const long = [{ id: "c1", kind: "text", tag: "div", text: "x".repeat(160), longer: 900 }];
  assert.deepStrictEqual(D.interpret({ description: "c1" }, long, { c1: "div.s" }).found, { description: "div.s" }, "a long synopsis (its text is cut to 160 for Gemini) counts by its real length");
  assert.deepStrictEqual(D.stableClasses({ classList: ["book-title", "x1234", "ls-is-cached", "9a", "a"] }), ["book-title", "ls-is-cached"], "classes that say what an element is, not generated ones");

  // ---- saving what was found: a one-field-at-a-time rule on top of the built-in one ----
  const before = { "other.example": { spec: { host: "other.example", selector: "p" }, enabled: true } };
  let saved = UR.withBookSelectors(before, "example.com", { title: "h1.title", cover: " img.c ", genre: "", bogus: "x" }, 5);
  assert.deepStrictEqual(saved["example.com"], { spec: { host: "example.com", book: { title: "h1.title", cover: "img.c" } }, enabled: true, updatedAt: 5 }, "only the details found, trimmed; blanks and unknown fields are left out");
  assert.ok(saved["other.example"] === before["other.example"] && !("example.com" in before), "other rules are kept, and the map given is not changed");
  saved = UR.withBookSelectors(saved, "example.com", { author: "a.author", title: "h1.new" }, 9);
  assert.deepStrictEqual(saved["example.com"].spec.book, { title: "h1.new", cover: "img.c", author: "a.author" }, "a later detection adds to what is there and replaces what it finds again");
  saved = UR.withBookSelectors({ "example.com": { spec: { host: "example.com", selector: "div.t", toc: { list: "ul a" } }, enabled: false } }, "example.com", { title: "h1" });
  assert.deepStrictEqual([saved["example.com"].spec.selector, saved["example.com"].spec.toc.list, saved["example.com"].enabled], ["div.t", "ul a", true], "the rest of an existing rule stays; it is switched on");
  assert.ok(UR.validate(saved["example.com"].spec, {}).ok, "and what is saved is a rule the rules page accepts");
  assert.strictEqual(UR.withBookSelectors(null, "example.com", null)["example.com"].spec.book, undefined, "nothing found, nothing set");
  // ---- saving all of it ----
  let all = UR.withDetected({}, "example.com", { book: { title: "h1" }, toc: { list: "ul.ch a", reverse: true }, nav: { next: "a.n", prev: " a.p " } }, 7);
  assert.deepStrictEqual(all["example.com"], { spec: { host: "example.com", book: { title: "h1" }, nav: { next: "a.n", prev: "a.p" }, toc: { list: "ul.ch a", reverse: true } }, enabled: true, updatedAt: 7 });
  all = UR.withDetected(all, "example.com", { toc: { list: "ol.ch a", reverse: false }, nav: { next: "a.next2" } }, 8);
  assert.deepStrictEqual([all["example.com"].spec.toc, all["example.com"].spec.nav, all["example.com"].spec.book], [{ list: "ol.ch a" }, { next: "a.next2", prev: "a.p" }, { title: "h1" }], "a later one replaces the list and the links it finds, keeps the rest, and oldest-first is the default again");
  all = UR.withDetected({ "example.com": { spec: { host: "example.com", selector: "div.t", toc: { boxes: "div.lists", pick: "last", pages: { kind: "links", selector: "ul.pager a" }, gap: 2000 } }, enabled: true } }, "example.com", { toc: { list: "ul.ch a" } }, 9);
  assert.deepStrictEqual(all["example.com"].spec.toc, { pages: { kind: "links", selector: "ul.pager a" }, gap: 2000, list: "ul.ch a" }, "a list found by its links replaces one read from a box; the list's pages and pause stay");
  assert.ok(UR.validate(all["example.com"].spec, {}).ok, "and what is saved is a rule the rules page accepts");
  assert.deepStrictEqual(Object.keys(UR.withDetected({}, "example.com", {})["example.com"].spec), ["host"], "nothing found, nothing set");
  // (a selector the browser cannot use is refused by the rules page; here there is no document to try it on)
  assert.deepStrictEqual(UR.validate({ host: "example.com", selector: "p", nav: { next: "a[[", prev: "a.p" } }).errors.map((e) => e.field), []);
  const rule = UR.toRule(UR.validate({ host: "example.com", selector: "p", nav: { next: "a#n", prev: "a#p" } }).spec);
  assert.deepStrictEqual(rule.nav, { next: "a#n", prev: "a#p" }, "the engine's rule carries the links");
  // ---- a complete chapter-list rule: the pagination bar ----
  const book = "https://www.empirenovel.com/novel/reverend-insanity";
  let pager = UR.pagerOf([book + "?page=2", book + "?page=3", book + "?page=4", book + "?page=75", book + "?page=76", book + "?page=2"], book);
  assert.deepStrictEqual([pager.max, pager.min, pager.param, pager.template, pager.urls.length, pager.urls[0], pager.urls[pager.urls.length - 1]], [76, 2, "page", book + "?page={n}", 75, book + "?page=2", book + "?page=76"], "every page up to the highest number in the bar, from the links that are there");
  pager = UR.pagerOf(["/chapters/5/page/2/", "/chapters/5/page/3/", "/chapters/5/page/94/", "/chapters/5/"], "https://ranobes.top/chapters/5/");
  assert.deepStrictEqual([pager.max, pager.param, pager.template], [94, "", "https://ranobes.top/chapters/5/page/{n}/"], "a number in the path works as well as one in the query (a link to the first page, with no number, is left out)");
  pager = UR.pagerOf(["/read/12_2.html", "/read/12_9.html"], "https://x.example/read/12.html");
  assert.strictEqual(pager.template, "https://x.example/read/12_{n}.html", "and one in a file name");
  assert.strictEqual(UR.pagerOf(["/a/1", "/b/2"], book), null, "links to different things are not page numbers");
  assert.strictEqual(UR.pagerOf(["/novel/x"], book), null, "one link is not a bar");
  assert.strictEqual(UR.pagerOf(["/n/5/1?x=3", "/n/5/2?x=4"], book), null, "two numbers changing is not page numbers");
  assert.strictEqual(UR.pagerOf(["http://x.example/p?page=2", "http://x.example/p?page=3"], book), null, "plain http is not taken");
  assert.strictEqual(UR.pagerOf([book + "?page=2", book + "?page=5000"], book), null, "an absurd number of pages");
  assert.strictEqual(UR.pagerOf(null, book), null);

  // the list page from a chapter's address: the book's own part of the address, tried back
  assert.deepStrictEqual(UR.listUrlRule(book, book + "/2334"), { match: "^https://(?:www\\.)?empirenovel\\.com/novel/([^/?#]+)(?:[/?#]|$)", to: "https://www.empirenovel.com/novel/$1" }, "the slug of the book is the part that changes");
  assert.deepStrictEqual(UR.listUrlRule("https://69shuba.tw/book/390935/", "https://69shuba.tw/read/390935/2698373"), { match: "^https://(?:www\\.)?69shuba\\.tw/read/([^/?#]+)(?:[/?#]|$)", to: "https://69shuba.tw/book/$1/" }, "a list page and chapters under different names, tied by the book's id");
  const nested = UR.listUrlRule("https://novelcult.com/novels/warriors-touch-book-2-329243/chapters", "/novels/warriors-touch-book-2-329243/chapters/c003eea9-0a9f");
  assert.deepStrictEqual(nested, { match: "^https://(?:www\\.)?novelcult\\.com/novels/([^/?#]+)(?:[/?#]|$)", to: "https://novelcult.com/novels/$1/chapters" }, "a list under the book (/novels/<slug>/chapters): the slug is the part that changes, not the last part");
  const nestedRule = UR.toRule(UR.validate({ host: "novelcult.com", selector: "p", toc: { list: "a", listUrl: nested } }).spec);
  assert.strictEqual(nestedRule.toc.url("https://novelcult.com/novels/another-book-77/chapters/abc"), "https://novelcult.com/novels/another-book-77/chapters", "and it leads to another book's list, not only this one's");
  assert.strictEqual(UR.listUrlRule(book, "https://www.empirenovel.com/chapter/9"), null, "a chapter whose address does not hold the book: no rule rather than a wrong one");
  assert.strictEqual(UR.listUrlRule(book, "https://other.example/novel/reverend-insanity/1"), null, "another site");
  assert.strictEqual(UR.listUrlRule("https://www.empirenovel.com/", book + "/1"), null, "a list page with no book in its address");
  const viaRule = UR.toRule(UR.validate({ host: "empirenovel.com", selector: "p", toc: { list: "ul a", listUrl: UR.listUrlRule(book, book + "/2334") } }).spec);
  assert.strictEqual(viaRule.toc.url("https://www.empirenovel.com/novel/some-other-book/77"), "https://www.empirenovel.com/novel/some-other-book", "and the rule works for the next book too");

  // the numbered pages as the engine runs them (a rule's pages are only ever on its own site)
  const barLink = (h) => ({ getAttribute: () => h });
  const numbered = UR.toRule(UR.validate({ host: "empirenovel.com", selector: "p", toc: { list: "ul a", pages: { kind: "numbered", selector: "ul.pagination a" } } }).spec);
  const gotPages = Array.from(numbered.toc.pages({ querySelectorAll: () => [barLink(book + "?page=2"), barLink(book + "?page=4"), barLink("https://evil.example/x?page=900")] }, book));
  assert.deepStrictEqual([gotPages.length, gotPages[0], gotPages[2]], [3, book + "?page=2", book + "?page=4"], "the pages up to the highest number on the site's own links (a link to another site is not a page)");
  assert.deepStrictEqual(Array.from(numbered.toc.pages({ querySelectorAll: () => [barLink(book + "?page=2"), barLink(book + "?page=3")] }, book + "?page=2")), [book + "?page=3"], "the page being read is not read again");
  assert.deepStrictEqual(Array.from(numbered.toc.pages({ querySelectorAll: () => [] }, book)), [], "a page with no bar has no others");
  assert.deepStrictEqual(UR.validate({ host: "x.example", selector: "p", toc: { list: "a", pages: { kind: "numbered", selector: "ul.pager a" } } }).spec.toc.pages, { kind: "numbered", selector: "ul.pager a" }, "the numbered kind is a kind of rule");

  // parts of a chapter link that are not its title
  const entryEl = (href, whole, small) => ({ getAttribute: () => href, cloneNode: () => ({ querySelectorAll: () => [{ remove() {} }], textContent: whole.replace(small, "") }) });
  const clean2 = UR.toRule(UR.validate({ host: "empirenovel.com", selector: "p", toc: { list: "ul.row a", titleDrop: "div.small" } }).spec);
  assert.strictEqual(typeof clean2.toc.list, "function", "a list with parts to leave out is read by a function");
  assert.deepStrictEqual(Array.from(clean2.toc.list({ querySelectorAll: (sel) => (sel === "ul.row a" ? [entryEl("/novel/x/2", "Chapter  2 Aug 7, 2025", " Aug 7, 2025"), entryEl("/novel/x/1", "Chapter 1 Aug 6, 2025", " Aug 6, 2025"), entryEl("/novel/x/2", "again", "")] : []) }, book), (c) => [c.title, c.url]), [["Chapter 2", "https://www.empirenovel.com/novel/x/2"], ["Chapter 1", "https://www.empirenovel.com/novel/x/1"]], "titles without the date, each chapter once");
  assert.strictEqual(UR.toRule(UR.validate({ host: "x.example", selector: "p", toc: { list: "ul a" } }).spec).toc.list, "ul a", "(without parts to leave out the list stays a selector)");
  const fakeEl = (tag, text, classes) => ({ tagName: tag, textContent: text, classList: classes || [] });
  const entryWith = (whole, kids) => ({ textContent: whole, querySelectorAll: () => kids });
  assert.strictEqual(D.titleDropFor([1, 2, 3].map((n) => entryWith("Chapter " + n + " Aug " + n + ", 2025", [fakeEl("DIV", "Chapter " + n + " Aug " + n + ", 2025"), fakeEl("DIV", "Aug " + n + ", 2025", ["small", "fst-italic"])]))), "div.small.fst-italic", "the date in a small element is found");
  assert.strictEqual(D.titleDropFor([entryWith("Chapter 3 3 days ago", [fakeEl("TIME", "3 days ago")])]), "time", "a time element too");
  assert.strictEqual(D.titleDropFor([entryWith("Chapter 3", [fakeEl("SPAN", "Chapter 3")])]), "", "a link with no date has nothing to leave out");
  assert.strictEqual(D.titleDropFor([entryWith("Chapter 2000 The Return", [fakeEl("SPAN", "2000")])]), "", "a bare tag is never a part to leave out (the title could go with it)");

  // saving the whole list rule
  let full = UR.withDetected({}, "empirenovel.com", { toc: { list: "ul.row a", reverse: true, pages: { kind: "numbered", selector: "ul.pagination a" }, titleDrop: "div.small", listUrl: UR.listUrlRule(book, book + "/2334") } }, 11);
  assert.deepStrictEqual(Object.keys(full["empirenovel.com"].spec.toc).sort(), ["list", "listUrl", "pages", "reverse", "titleDrop"]);
  assert.ok(UR.validate(full["empirenovel.com"].spec, {}).ok, "what is saved is a rule the rules page accepts");
  full = UR.withDetected(full, "empirenovel.com", { toc: { list: "ol.chapters a", pages: null, titleDrop: null } }, 12);
  assert.deepStrictEqual(full["empirenovel.com"].spec.toc, { list: "ol.chapters a", reverse: true, listUrl: UR.listUrlRule(book, book + "/2334") }, "a list found with no bar and nothing to leave out is one page of plain titles; how to reach the list page stays");
  full = UR.withDetected(full, "empirenovel.com", { toc: { list: "ol.chapters a" } }, 13);
  assert.ok(!("pages" in full["empirenovel.com"].spec.toc), "(and a detection that says nothing of pages does not bring them back)");
  const keepPause = UR.withDetected({ "x.example": { spec: { host: "x.example", selector: "p", toc: { list: "ul a", gap: 3000, pages: { kind: "links", selector: "a.p" } } }, enabled: true } }, "x.example", { toc: { list: "ol a", pages: { kind: "numbered", selector: "ul.pagination a" } } }, 14);
  assert.deepStrictEqual(keepPause["x.example"].spec.toc, { list: "ol a", gap: 3000, pages: { kind: "numbered", selector: "ul.pagination a" } }, "a bar found replaces the pages that were there; a pause set by hand stays");

  // ---- a site whose pages a script fills in from its data (chikari.moe's shapes: the page is an empty frame, /api/... holds the list and the text) ----
  const slug = "the-heroes-who-executed-me-are-obsessed-with-me";
  const site = "https://chikari.moe";
  const bookUrl = site + "/novels/" + slug;
  const chapter = (n) => ({ number: n, volume: "", title: "Chapter " + n + " : Title " + n, lang: "en", created_at: "2026-01-28T01:02:00+00:00" });
  const newest = (from, k) => Array.from({ length: k }, (_, i) => chapter(from - i));
  const listUrl0 = site + "/api/novels/" + slug + "/chapters?order=desc&limit=100&offset=0";
  const listData = { items: newest(202, 100), total: 202, limit: 100, offset: 0 };
  // what the page shows: the list's links, with the date after each title
  const shownList = newest(202, 100).map((c) => ({ url: bookUrl + "/" + c.number, text: c.title + " 9 months ago" }));
  let dl = D.listFromData(listData, listUrl0, shownList);
  assert.deepStrictEqual(dl.json, { items: "items", title: "title", link: site + "/novels/$1/{number}", page: "offset", count: "total" }, "the chapters, their titles and addresses, and how to ask for the rest, all found in the data");
  assert.deepStrictEqual(dl.listUrl, { match: "^https://(?:www\\.)?chikari\\.moe/novels/([^/?#]+)(?:[/?#]|$)", to: site + "/api/novels/$1/chapters?order=desc&limit=100&offset=0" }, "the data's address from the book's (or a chapter's): its slug");
  assert.deepStrictEqual([dl.reverse, dl.partial, dl.shown, dl.count], [true, false, 100, 202], "newest first; the whole list can be read");
  // the list shown after scrolling on (offset 100): the rule still starts at the beginning
  dl = D.listFromData({ items: newest(102, 100), total: 202 }, site + "/api/novels/" + slug + "/chapters?order=desc&limit=100&offset=100", newest(102, 100).map((c) => ({ url: bookUrl + "/" + c.number, text: c.title })));
  assert.ok(/offset=0$/.test(dl.listUrl.to), "the data's first part, whichever part the page had loaded");
  // the book's own record holds only the latest ten: not the list
  const novelData = { id: 14402, slug, title: "The Heroes", chapter_count: 202, comment_count: 4, genres: [{ slug: "action", name: "Action" }, { slug: "drama", name: "Drama" }], chapters_head: newest(202, 10), chapters_tail: newest(10, 10).reverse() };
  dl = D.listFromData(novelData, site + "/api/novels/" + slug, shownList.slice(0, 10));
  assert.deepStrictEqual([dl.partial, dl.shown, dl.count, dl.json.count], [true, 10, 202, undefined], "ten of 202, and no way to ask for more: partial");
  assert.strictEqual(D.listFromData({ items: [{ name: "Action" }, { name: "Drama" }, { name: "Fantasy" }] }, listUrl0, shownList), null, "data that is not the list the page shows is no list");
  assert.strictEqual(D.listFromData(listData, listUrl0, []), null, "(nothing shown, nothing to match)");

  // the rule made of it, as the engine runs it
  const dataSpec = UR.validate({ host: "chikari.moe", toc: { json: D.listFromData(listData, listUrl0, shownList).json, listUrl: D.listFromData(listData, listUrl0, shownList).listUrl, reverse: true } });
  assert.ok(dataSpec.ok, "what is saved is a rule the rules page accepts (no selectors needed)");
  const dataRule = UR.toRule(dataSpec.spec);
  assert.strictEqual(dataRule.toc.url(bookUrl), listUrl0, "from the book's address");
  assert.strictEqual(dataRule.toc.url(site + "/novels/another-book-7/12"), site + "/api/novels/another-book-7/chapters?order=desc&limit=100&offset=0", "from another book's chapter");
  const part1 = dataRule.toc.list(null, listUrl0, JSON.stringify(listData));
  assert.deepStrictEqual([part1.length, part1[0], part1[99].url], [100, { title: "Chapter 202 : Title 202", url: bookUrl + "/202" }, bookUrl + "/103"], "each chapter's title and address");
  assert.deepStrictEqual(dataRule.toc.pages(null, listUrl0, JSON.stringify(listData)), [listUrl0.replace("offset=0", "offset=100"), listUrl0.replace("offset=0", "offset=200")], "the other parts, up to the total");
  assert.deepStrictEqual(dataRule.toc.list(null, listUrl0, "<html>Cloudflare</html>"), [], "an answer that is not the data has no chapters");
  assert.strictEqual(dataRule.toc.data, true);
  const paged = UR.toRule(UR.validate({ host: "x.example", toc: { json: { items: "data.list", title: "name", link: "/read/{id}", page: "page", pages: "meta.last_page" }, listUrl: { match: "^https://x\\.example/b/(\\d+)", to: "https://x.example/api/b/$1?page=1" } } }).spec);
  assert.deepStrictEqual(paged.toc.pages(null, "https://x.example/api/b/9?page=1", JSON.stringify({ data: { list: [{ id: 1, name: "a" }] }, meta: { last_page: 3 } })), ["https://x.example/api/b/9?page=2", "https://x.example/api/b/9?page=3"], "parts counted by page, up to the last");
  assert.deepStrictEqual(paged.toc.list(null, "https://x.example/api/b/9?page=1", JSON.stringify({ data: { list: [{ id: 1, name: "a" }, { id: 2 }, { name: "no id" }, { id: 1, name: "again" }] } })), [{ title: "a", url: "https://x.example/read/1" }, { title: "", url: "https://x.example/read/2" }], "a chapter with no address is left out, each address once");
  const offSite = UR.toRule(UR.validate({ host: "x.example", toc: { json: { title: "t", link: "{url}" }, listUrl: { match: "^https://x\\.example/b/(\\d+)", to: "https://x.example/api/b/$1" } } }).spec);
  assert.deepStrictEqual(offSite.toc.list(null, "https://x.example/api/b/1", JSON.stringify([{ t: "a", url: "https://evil.example/1" }, { t: "b", url: "/c/2" }])), [{ title: "b", url: "https://x.example/c/2" }], "an address the data gives whole is kept only on the rule's site");
  // what the rules page refuses
  let bad = UR.validate({ host: "x.example", toc: { json: { title: "t", link: "https://evil.example/{id}" }, listUrl: { match: "^a", to: "https://x.example/l" } } });
  assert.deepStrictEqual(bad.errors.map((e) => e.field), ["toc.json.link"], "a chapter address on another site");
  bad = UR.validate({ host: "x.example", toc: { json: { link: "/c/{id}", title: "a b" } } });
  assert.deepStrictEqual(bad.errors.map((e) => e.field).sort(), ["toc.json.title", "toc.listUrl"], "a field that is not a name; a list with no address for its data");

  // the chapter's text: the longest text in the data that the page shows, and its address from the chapter's
  const body = Array.from({ length: 40 }, (_, i) => "Paragraph " + i + " of the chapter, where the knight said something “quoted” and went on.").join("\n\n");
  const chapterData = { number: 5, title: "Chapter 5 : Tangled Threads", novel_slug: slug, body, comment_count: 6, prev_number: 4, next_number: 6, latest_number: 202 };
  const shownPage = "Home  The Heroes\nChapter 5 : Tangled Threads\n" + body.replace(/\n\n/g, "\n") + "\nPrevious chapter Next chapter";
  const found5 = D.textInData(chapterData, shownPage);
  assert.deepStrictEqual([found5.field, found5.length > 1000], ["body", true], "the text the page shows, found in the data");
  assert.strictEqual(D.textInData(chapterData, "Home  The Heroes"), null, "not shown on the page: not the chapter's text");
  const chapterUrl = bookUrl + "/5";
  const dataUrl5 = site + "/api/novels/" + slug + "/chapters/5/read";
  const tr = D.dataUrlRule(chapterUrl, dataUrl5);
  assert.deepStrictEqual(tr, { match: "^https://(?:www\\.)?chikari\\.moe/novels/([^/?#]+)/([^/?#]+)(?:[/?#]|$)", to: site + "/api/novels/$1/chapters/$2/read" }, "the slug and the number, from the chapter's address into the data's");
  assert.deepStrictEqual(D.dataUrlRule("https://x.example/read?id=12-3", "https://x.example/api/text?chapter=12-3"), null, "(a chapter's address with nothing in its path that the data's holds)");
  assert.deepStrictEqual(D.dataUrlRule("https://x.example/book/77/3", "https://api.x.example/v1/chapter?book=77&n=3"), { match: "^https://(?:www\\.)?x\\.example/book/([^/?#]+)/([^/?#]+)(?:[/?#]|$)", to: "https://api.x.example/v1/chapter?book=$1&n=$2" }, "data on the site's api part, named in its query");
  assert.strictEqual(D.dataUrlRule("https://x.example/book/77/3", "https://other.example/api/77/3"), null, "data on another site");
  const next5 = D.nextFromData(chapterData, dataUrl5, tr, chapterUrl, bookUrl + "/6");
  assert.strictEqual(next5, site + "/novels/$1/{next_number}", "the next chapter's address: the field named next, not the count that happens to be 6");
  assert.strictEqual(D.nextFromData(chapterData, dataUrl5, tr, chapterUrl, bookUrl + "/77"), "", "no field holds it");
  const textSpec = UR.validate({ host: "chikari.moe", json: { ...tr, text: "body", next: next5 } });
  assert.ok(textSpec.ok, "a rule with only the text from the data, no selector");
  const textRule = UR.toRule(textSpec.spec);
  assert.strictEqual(textRule.textUrl(bookUrl + "/77"), site + "/api/novels/" + slug + "/chapters/77/read", "another chapter's data");
  assert.strictEqual(textRule.textUrl("https://chikari.moe/about"), null, "(not a chapter's address)");
  const read77 = await textRule.fromHtml(JSON.stringify({ ...chapterData, number: 77, next_number: 78 }), site + "/api/novels/" + slug + "/chapters/77/read");
  assert.deepStrictEqual([read77.text.split("\n").length, read77.text.split("\n")[1], read77.next], [40, "Paragraph 1 of the chapter, where the knight said something “quoted” and went on.", bookUrl + "/78"], "its text, one paragraph a line, and the next chapter's address");
  assert.strictEqual(await textRule.fromHtml("<html>Just a moment...</html>", dataUrl5), null, "a bot check's page is no text");
  assert.strictEqual(UR.linesOf("<p>One &amp; two</p><p>Three<br>Four</p><script>x()</script>"), "One & two\nThree\nFour", "text with markup, read as a page's is");
  assert.strictEqual(UR.linesOf("How much time had passed?\n\n<em>Drip, drip.</em>\n\nRain fell."), "How much time had passed?\nDrip, drip.\nRain fell.", "plain text with a tag here and there (chikari's)");
  assert.strictEqual(UR.linesOf("<p>[Quest] <System> says:</p><p>a < b</p>"), "[Quest] <System> says:\na < b", "a < of the story's own stays");
  assert.strictEqual(UR.linesOf("<System> Level up!\n\nYou gained <Skill: Fireball>."), "<System> Level up!\nYou gained <Skill: Fireball>.", "(text with no markup at all is left as it is)");
  assert.deepStrictEqual(UR.groupsOf("https://x.example/api/b/$1?page=1&slug=$2", "https://x.example/api/b/9?page=4&slug=a%20b").slice(1), ["9", "a b"], "the parts an address was made from, in its path and its query");
  assert.deepStrictEqual(UR.validate({ host: "x.example", json: { match: "(", to: "https://evil.example/$1", text: "" } }).errors.map((e) => e.field), ["json.match", "json.to", "json.text"], "what the rules page refuses for the text");

  // saving it: a list from the data replaces one read from a page, and the other way round
  let ds = UR.withDetected({ "chikari.moe": { spec: { host: "chikari.moe", toc: { list: "div a", titleDrop: "span.x", pages: { kind: "numbered", selector: "ul a" }, gap: 2000 } }, enabled: true } }, "chikari.moe", { toc: { json: dataSpec.spec.toc.json, listUrl: dataSpec.spec.toc.listUrl, reverse: true }, json: textSpec.spec.json }, 20);
  assert.deepStrictEqual(Object.keys(ds["chikari.moe"].spec.toc).sort(), ["gap", "json", "listUrl", "reverse"], "the page's list settings go; the pause stays");
  assert.deepStrictEqual(ds["chikari.moe"].spec.json, textSpec.spec.json);
  assert.ok(UR.validate(ds["chikari.moe"].spec, {}).ok, "and what is saved is a rule the rules page accepts");
  ds = UR.withDetected(ds, "chikari.moe", { toc: { list: "ol a" } }, 21);
  assert.ok(!("json" in ds["chikari.moe"].spec.toc) && ds["chikari.moe"].spec.json, "a list found on a page later replaces the data's; the text's rule stays");
  // where a chapter's text is, on a site that sends its pages whole (found on two chapters' pages: the Firefox end-to-end test tries it on a real page)
  assert.deepStrictEqual(D.asRuleParts({ chapterList: "ul a" }, null, { textSelector: "div#chapter-text" }), { toc: { list: "ul a", pages: null, titleDrop: null }, selector: "div#chapter-text" }, "the text's place goes in the rule");
  let ts = UR.withDetected({}, "plain.example", { toc: { list: "ul a" }, selector: " main > div.text " }, 30);
  assert.strictEqual(ts["plain.example"].spec.selector, "main > div.text", "saved as the rule's chapter text");
  assert.ok(UR.validate(ts["plain.example"].spec, {}).ok, "and what is saved is a rule the rules page accepts");
  ts = UR.withDetected(ts, "plain.example", { nav: { next: "a.next" } }, 31);
  assert.strictEqual(ts["plain.example"].spec.selector, "main > div.text", "a later detection that found no text place keeps it");
  assert.deepStrictEqual(D.asRuleParts({ next: "a.n" }, null, { dataList: { json: { title: "t", link: "/c/{id}" }, listUrl: { match: "^a", to: "b" }, reverse: true }, dataText: { match: "^a", to: "b", text: "body" } }), { nav: { next: "a.n" }, toc: { json: { title: "t", link: "/c/{id}" }, listUrl: { match: "^a", to: "b" }, reverse: true }, json: { match: "^a", to: "b", text: "body" } }, "the parts read from the data, as the parts of a rule");

  console.log("OK — book-detect checks passed");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
