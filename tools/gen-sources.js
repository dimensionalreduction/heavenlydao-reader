// Turns WebToEpub's parsers (reference/WebToEpub/plugin/js/parsers/*.js: https://github.com/dteviot/WebToEpub, GPL-3.0, a git submodule) into
// site rules: src/shared/sources/_generated.js. Only facts are taken from the parsers (CSS selectors, text encodings, which elements are
// junk, where a chapter list is), never their code. Run it by hand when the submodule is moved to a newer commit:
//
//     node tools/gen-sources.js
//
// What it reads from each parser class (following `extends` through other files, so a site built on WordpressBaseParser gets that base's
// content selector):
//   findContent(dom)                       -> selector   (the querySelector strings, "a || b" becomes the CSS list "a, b")
//   TextDecoder("gbk")                     -> charset
//   removeChildElementsMatchingSelector    -> junk
//   getChapterUrls(dom), when it only reads the page it is given -> toc.list  (the links under a selector, or the selector's own links),
//                                             and toc.reverse when the list is newest first. Shapes read: links under a box (`let menu = dom.querySelector(..)`,
//                                             or inline), the content box itself (`this.findContent(dom)`), the last of several boxes (`[...].pop()`), and
//                                             "these links" (`[...dom.querySelectorAll(..)].map(link => ..)`), with or without `.reverse()`.
//   getChapterUrlsFromMultipleTocPages(dom, extractPartialChapterList, getUrlsOfTocPages) -> toc.list from the first page's list, toc.pages from where
//                                          the other list pages are named (<option data-url>, <option value>, or links): toc.pages.{options|links, attr}
//   extractTitleImpl / extractAuthor / extractDescription (or getInformationEpubItemChildNodes) / findCoverImageUrl / extractSubject
//                                          -> book.{title, author, description, cover, genre}: where a book's page says what the book is
//   this.minimumThrottle = <ms> in its constructor -> wait: how long to wait between two of the site's chapters (the default for a novel
//                                          from it that is fetched chapter after chapter; the person can change it)
// A parser that does anything cleverer (fetches more pages, runs scripts, builds the text) gives no rule for that part, and the extension
// falls back to what works for any site (the page's own "next chapter" link). A site whose parser gives no content selector is left out.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const PARSERS = path.join(root, "reference", "WebToEpub", "plugin", "js", "parsers");
const OUT = path.join(__dirname, "..", "src", "shared", "sources", "_generated.js");
const JUNK = "script, style, ins, iframe"; // always removed (the engine's default; a rule that names junk replaces it, so it is repeated)

// ---- reading JavaScript, just enough ----

// The text of a method (from its signature to its closing brace), or null. Methods are indented four spaces inside a class.
function methodBody(classBody, name) {
  const m = new RegExp("^    (?:static )?(?:async )?" + name + "\\s*\\(", "m").exec(classBody);
  if (!m) return null;
  const open = classBody.indexOf("{", m.index + m[0].length);
  if (open < 0) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < classBody.length; i++) {
    const c = classBody[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && classBody[i + 1] === "/") i = classBody.indexOf("\n", i) - 1; // a comment
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return classBody.slice(m.index, i + 1);
  }
  return null;
}

// The string literals passed to `.<call>(...)`, in order.
function stringArgs(code, call) {
  const out = [];
  const re = new RegExp("\\." + call + "\\(\\s*([\"'`])((?:\\\\.|(?!\\1).)*?)\\1", "g");
  for (let m; (m = re.exec(code)); ) out.push(m[2]);
  return out;
}

// Every class in a file: [{ name, parent, body }]. A class runs to the next one (or the end of the file).
function classesIn(text, file) {
  const out = [];
  const re = /^class (\w+)(?: extends (\w+))?\s*\{/gm;
  const starts = [];
  for (let m; (m = re.exec(text)); ) starts.push({ name: m[1], parent: m[2] || null, at: m.index });
  starts.forEach((s, i) => out.push({ name: s.name, parent: s.parent, file, body: text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length) }));
  return out;
}

// ---- what one class says (alone, not counting its parents) ----

const usable = (sel) => sel && !sel.includes("${") && !/^\s*$/.test(sel);

// A CSS selector list with its empty entries taken out ("a, b, " -> "a, b"), splitting only at commas outside brackets, parentheses and
// quotes (so ":not(a, b)" and '[title="a, b"]' stay whole). Some parsers' strings end in a stray comma, which is not valid CSS.
function tidyList(sel) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const c of String(sel)) {
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean).join(", ");
}

function contentOf(body) {
  const m = methodBody(body, "findContent");
  if (!m) return { has: false };
  if (/super\.findContent\(/.test(m) && !stringArgs(m, "querySelector").length) return { has: false }; // "whatever the parent does"
  const sels = stringArgs(m, "querySelector").filter(usable);
  return { has: true, selector: sels.length ? sels.join(", ") : null };
}

// util.removeChildElementsMatchingSelector(element, ".ad, #promo")  and  util.removeElements(element.querySelectorAll("div.adBlock"))
function junkOf(body) {
  const m = methodBody(body, "removeUnwantedElementsFromContentElement");
  if (!m) return [];
  const out = [];
  const shapes = [
    /removeChildElementsMatchingSelector\(\s*\w+\s*,\s*(["'`])((?:\\.|(?!\1).)*?)\1/g,
    /removeElements\(\s*\w+\.querySelectorAll\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g
  ];
  for (const re of shapes) {
    for (let r; (r = re.exec(m)); ) out.push(r[2]);
  }
  return out.filter(usable);
}

function charsetOf(body) {
  // (not in a comment: NullTranslation.js says `TextDecoder("iso-8859-1") ... doesn't work` in one, and decodes UTF-8)
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  const m = /TextDecoder\(\s*["']([\w-]+)["']\s*\)/.exec(code);
  return m ? m[1].toLowerCase() : null;
}
// A class that fetches its pages its own way says what that way is; one that fetches them without naming an encoding (a site that does
// say it) must not inherit a parent's, which is for a different site. So the nearest class that decodes OR fetches decides.
// ("Fetches its own way" means a fetchChapter that passes no options: one that calls this.makeOptions() uses the encoding defined there.)
const fetchesPlainly = (body) => {
  const m = methodBody(body, "fetchChapter");
  return !!m && !/makeOptions|makeTextDecoder|TextDecoder|options/i.test(m);
};

// A chapter list that is just "the links under this element" or "these links", read from the page the person starts on. `contentSelector` is the
// parser's content selector, for a list that lives inside the content box (`this.findContent(dom)`).
// Answers { has, simple, list, reverse } (the links are `list`), or { boxes, pick, reverse } (the links under one of the boxes `boxes` matches).
function tocOf(body, contentSelector) {
  const m = methodBody(body, "getChapterUrls");
  if (!m) return { has: false };
  if (/getChapterUrlsFromMultipleTocPages/.test(m)) return multiPageTocOf(body, m, contentSelector);
  if (/await|HttpClient|fetch|walkTocPages|MultipleTocPages|TocPage|\.href\s*;|baseURI|\.json\b|JSON\./.test(m)) return { has: true, simple: false }; // reads other pages
  const reverse = /\.reverse\(\)/.test(m);
  // let menu = dom.querySelector("ul.chapter-list"); ... util.hyperlinksToChapterList(menu)
  const holder = /let\s+(\w+)\s*=\s*dom\.querySelector\(\s*(["'`])((?:\\.|(?!\2).)*?)\2\s*\)/.exec(m);
  if (holder && new RegExp("hyperlinksToChapterList\\(\\s*" + holder[1] + "\\b").test(m) && usable(holder[3])) {
    return { has: true, simple: true, list: holder[3] + " a", reverse };
  }
  // util.hyperlinksToChapterList(dom.querySelector("ul.chapter-list"))
  const inline = /hyperlinksToChapterList\(\s*dom\.querySelector\(\s*(["'`])((?:\\.|(?!\1).)*?)\1\s*\)/.exec(m);
  if (inline && usable(inline[2])) return { has: true, simple: true, list: inline[2] + " a", reverse };
  // let menu = [...dom.querySelectorAll("ul.chapters")].pop();  ... util.hyperlinksToChapterList(menu)
  const pick = /let\s+(\w+)\s*=\s*\[\s*\.\.\.dom\.querySelectorAll\(\s*(["'`])((?:\\.|(?!\2).)*?)\2\s*\)\s*\]\s*(?:\.(pop|shift)\(\)|\[\s*(\d+)\s*\])/.exec(m);
  if (pick && new RegExp("hyperlinksToChapterList\\(\\s*" + pick[1] + "\\b").test(m) && usable(pick[3])) {
    return { has: true, simple: true, boxes: pick[3], pick: pick[4] === "pop" ? "last" : pick[4] === "shift" ? "first" : String(pick[5]), reverse };
  }
  // let menu = this.findContent(dom); ... util.hyperlinksToChapterList(menu)
  const content = /let\s+(\w+)\s*=\s*this\.findContent\(\s*dom\s*\)/.exec(m);
  if (content && contentSelector && new RegExp("hyperlinksToChapterList\\(\\s*" + content[1] + "\\b").test(m) && !/removeUnwantedContent|remove\(/.test(m)) {
    return { has: true, simple: true, boxes: contentSelector, pick: "first", reverse };
  }
  // [...dom.querySelectorAll("div.chapters a")].map(a => util.hyperLinkToChapter(a))   (the one selector the list is read with; not when the
  // links are filtered or built from other parts of the page, which would list something else)
  const all = stringArgs(m, "querySelectorAll").filter(usable);
  const onDom = (m.match(/dom\.querySelectorAll\(/g) || []).length;
  const maps = /hyperLinkToChapter|hyperlinksToChapterList|linkToChapter|sourceUrl\s*:\s*\w+\.href/.test(m);
  if (all.length === 1 && onDom === 1 && maps && !/\.filter\(|\.concat\(|document\.|\.querySelector\(/.test(m)) return { has: true, simple: true, list: all[0], reverse };
  return { has: true, simple: false };
}

// The way a method that returns the other list pages' addresses names them, when that is plain data: an element selector and the attribute holding
// the address ("data-url", "value", or the link's own href). Anything computed (page numbers counted up, an address built by string work) is not guessed.
function pagesOf(m) {
  if (!m) return null;
  const code = m.replace(/new URL\([^()]*?,\s*dom\.baseURI\s*\)/g, "X"); // (an address made absolute against the page: still plain)
  if (/parseInt|for\s*\(|while\s*\(|baseURI|lastIndexOf|substring|substr\(|split\(|\.slice\(\s*-|\+\s*["'`]|\$\{|await|fetch/.test(code)) return null;
  const sels = stringArgs(m, "querySelectorAll").filter(usable);
  if (sels.length !== 1) return null;
  const sel = tidyList(sels[0]);
  const data = /\.dataset\.(\w+)/.exec(m);
  if (data) return { options: sel, attr: "data-" + data[1].replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) };
  const named = /\.getAttribute\(\s*["']([\w-]+)["']\s*\)/.exec(m);
  if (named && named[1] !== "href") return { options: sel, attr: named[1] };
  if (/\.value\b/.test(m)) return { options: sel, attr: "value" };
  if (/\.href\b|getAttribute\(\s*["']href["']/.test(m)) return { links: sel };
  return null;
}

// A list read from several pages: the first page's chapters (extractPartialChapterList, read like a single-page list) and where the other pages are.
function multiPageTocOf(body, m, contentSelector) {
  const partial = methodBody(body, "extractPartialChapterList");
  const pages = pagesOf(methodBody(body, "getUrlsOfTocPages"));
  if (!partial || !pages || /await|HttpClient|fetch/.test(partial)) return { has: true, simple: false };
  // the first page's list is the same shapes as a one-page list: wrap it as a getChapterUrls to read it with tocOf
  const shape = tocOf("    async getChapterUrls(dom) {\n" + partial.replace(/^\s*(?:static\s+)?(?:async\s+)?extractPartialChapterList\s*\(dom\)\s*\{/, "").replace(/\}\s*$/, "") + "\n    }\n", contentSelector);
  if (!shape.simple) return { has: true, simple: false };
  return { ...shape, reverse: shape.reverse || /\.reverse\(\)/.test(m), pages };
}

// The selector of the first querySelector("...") / querySelectorAll("...") / getFirstImgSrc(dom, "...") in a method, or null.
function firstSelector(m) {
  if (!m) return null;
  const re = /(?:querySelectorAll|querySelector|getFirstImgSrc\(\s*dom\s*,)\(?\s*(["'`])((?:\\.|(?!\1).)*?)\1/g;
  for (let r; (r = re.exec(m)); ) if (usable(r[2]) && !/^\s*(a|img|\*)\s*$/.test(r[2])) return tidyList(r[2]);
  return null;
}

// Where one class says the book's details are: { title, author, description, cover, genre } (any may be missing).
function bookOf(body) {
  const out = {};
  const title = firstSelector(methodBody(body, "extractTitleImpl"));
  const author = firstSelector(methodBody(body, "extractAuthor"));
  const description = firstSelector(methodBody(body, "extractDescription")) || firstSelector(methodBody(body, "getInformationEpubItemChildNodes"));
  const cover = firstSelector(methodBody(body, "findCoverImageUrl"));
  const genre = firstSelector(methodBody(body, "extractSubject"));
  if (title) out.title = title;
  if (author) out.author = author;
  if (description) out.description = description;
  if (cover) out.cover = cover;
  if (genre) out.genre = genre;
  return out;
}

// ---- putting a class together with its parents ----

function ruleFor(cls, classes) {
  const chain = [];
  for (let c = cls, guard = 0; c && guard < 6; c = classes.get(c.parent), guard++) chain.push(c);
  let content = null;
  for (const c of chain) {
    const r = contentOf(c.body);
    if (r.has) { content = r.selector; break; } // the nearest class that says anything about it decides; "dynamic" (null) means none
  }
  if (!content) return null;
  const rule = { selector: tidyList(content) };
  const junk = chain.flatMap((c) => junkOf(c.body)).map(tidyList).filter(Boolean);
  rule.junk = JUNK + (junk.length ? ", " + [...new Set(junk)].join(", ") : "");
  let charset = null;
  for (const c of chain) {
    charset = charsetOf(c.body);
    if (charset || fetchesPlainly(c.body)) break;
  }
  if (charset) rule.charset = charset;
  for (const c of chain) {
    const t = tocOf(c.body, rule.selector);
    if (!t.has) continue;
    if (t.simple) {
      const how = t.boxes ? { boxes: tidyList(t.boxes), pick: t.pick } : { list: tidyList(t.list) };
      if (t.pages) how.pages = t.pages;
      rule.toc = t.reverse ? { ...how, reverse: true } : how;
    }
    break;
  }
  // the details of a book: each from the nearest class that says where it is
  const book = {};
  for (const c of chain) {
    const b = bookOf(c.body);
    for (const k of Object.keys(b)) if (!(k in book)) book[k] = b[k];
  }
  if (Object.keys(book).length) rule.book = book;
  // how long the site wants between two chapters: the nearest class that sets it
  for (const c of chain) {
    const m = /this\.minimumThrottle\s*=\s*(\d+)\s*;/.exec(methodBody(c.body, "constructor") || "");
    if (m) { if (Number(m[1]) > 0) rule.wait = Number(m[1]); break; }
  }
  rule.from = path.basename(cls.file);
  rule.parser = cls.name; // (a file of rules for one family of sites finds its members by it: RawSources.hostsOf)
  return rule;
}

// { host: rule } for the parsers in `files` ({ name: text }). Hosts of dead sites, and hosts with a path in them, are left out.
function extractRules(files) {
  const classes = new Map();
  for (const [file, text] of Object.entries(files)) for (const c of classesIn(text, file)) classes.set(c.name, c);
  const out = {};
  for (const [file, text] of Object.entries(files)) {
    const re = /parserFactory\.register\(\s*"([^"/]+)"\s*,\s*\(\)\s*=>\s*new\s+(\w+)\s*\(/g;
    for (let m; (m = re.exec(text)); ) {
      const cls = classes.get(m[2]);
      const rule = cls && ruleFor(cls, classes);
      const host = m[1].replace(/^www\./, "").toLowerCase();
      if (rule && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) out[host] = rule;
    }
  }
  return out;
}

function render(rules) {
  const lines = Object.keys(rules).sort().map((h) => "  " + JSON.stringify(h) + ": " + JSON.stringify(rules[h]));
  return (
    "// GENERATED by tools/gen-sources.js from WebToEpub's parsers (https://github.com/dteviot/WebToEpub, GPL-3.0). Do not edit by hand:\n" +
    "// change the parser snapshot or the generator and run it again. A site that needs more than this gets its own file in this folder,\n" +
    "// which is loaded after this one and replaces the site's entry.\n" +
    "RawSources.registerAll({\n" + lines.join(",\n") + "\n});\n"
  );
}

function readParsers() {
  const files = {};
  for (const f of fs.readdirSync(PARSERS).filter((x) => x.endsWith(".js")).sort()) files[f] = fs.readFileSync(path.join(PARSERS, f), "utf8");
  return files;
}

module.exports = { extractRules, render, methodBody, stringArgs, classesIn, readParsers, tidyList, tocOf, bookOf, pagesOf, OUT };

if (require.main === module) {
  const rules = extractRules(readParsers());
  fs.writeFileSync(OUT, render(rules));
  const n = Object.keys(rules).length;
  const withToc = Object.values(rules).filter((r) => r.toc).length;
  const withBook = Object.values(rules).filter((r) => r.book).length;
  const withCharset = Object.values(rules).filter((r) => r.charset).length;
  console.log("wrote " + path.relative(root, OUT) + ": " + n + " sites (" + withToc + " with a chapter list, " + withBook + " with book details, " + withCharset + " with a text encoding)");
}
