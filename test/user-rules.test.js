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
assert.strictEqual(RS.hostForSlug("example.com"), "example.com", "wtr-lab's raw source names a site of theirs too");
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
