// A comic whose chapter page draws its pictures with a script, from a list in the page itself (rule.scriptPictures): reading the list (user-rules.js) and finding it
// (book-detect.js scriptPicturesFor). The fixture is a real chapter page of mh160mh.com (the qTcms comic CMS: the list base64 in qTcms_S_m_murl_e, addresses from the
// site's root, put on a picture server by the site's script). Run: node test/script-pictures.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const RS = require(path.join(__dirname, "..", "src", "shared", "raw-sources.js"));
globalThis.RawSources = RS;
const UR = require("../src/shared/user-rules.js");
const D = require("../src/shared/book-detect.js");

const page = "https://www.mh160mh.com/kanmanhua/dingjiqiyunqiaoqiaoxiulianqiannian/1671357697.html";
const html = fs.readFileSync(path.join(__dirname, "fixtures", "qtcms-chapter.html"), "utf8");
const server = "https://mhpic5er.tgmhfc.uk";
const first = server + "/mh160tuku/d/%E9%A1%B6%E7%BA%A7%E6%B0%94%E8%BF%90-%E6%82%84%E6%82%84%E4%BF%AE%E7%82%BC%E5%8D%83%E5%B9%B4_62157/02_168051/0001.jpg";

// ---- reading the list ----
const value = UR.scriptValue(html, "qTcms_S_m_murl_e");
assert.ok(/^L21oMTYwdHVrdS9k/.test(value), "the variable's string");
assert.strictEqual(UR.scriptValue(html, "qTcms_S_m_murl_e2"), "", "an empty one is no value");
assert.strictEqual(UR.scriptValue(html, "qTcms_S_m_murl"), "", "(a name is not the start of a longer one)");
const listed = UR.pictureAddressesIn(UR.fromBase64(value));
assert.strictEqual(listed.length, 43, "43 pictures, $qingtiandy$ between them");
assert.strictEqual(listed[0], "/mh160tuku/d/顶级气运-悄悄修炼千年_62157/02_168051/0001.jpg");
const sp = { name: "qTcms_S_m_murl_e", base64: true, prefix: server };
const urls = UR.picturesInScript(html, sp, page);
assert.strictEqual(urls.length, 43);
assert.strictEqual(urls[0], first, "on the picture server, the path encoded as a browser asks for it");
assert.ok(urls[42].endsWith("/0043.jpg"), "in order");
assert.strictEqual(UR.picturesInScript(html, { name: "qTcms_S_m_murl_e", base64: true }, page)[0].startsWith("https://www.mh160mh.com/mh160tuku/"), true, "with no server: the page's own");
assert.deepStrictEqual(UR.picturesInScript(html, { name: "qTcms_S_m_murl_e" }, page), [], "not read as base64: no pictures");

// other ways a page keeps such a list
const other = [
  '<script>var banners = ["/ad/1.jpg", "/ad/2.jpg", "/ad/3.jpg"];',
  'var chapterImages = ["https:\\/\\/cdn.example.net\\/c\\/9\\/001.webp?t=1","https:\\/\\/cdn.example.net\\/c\\/9\\/002.webp?t=1","//cdn.example.net/c/9/003.webp","img/004.webp"];',
  'window.__DATA__ = { "pages": [{"url": "/p/1.png"}, {"url": "/p/2.png"}, {"url": "/p/3.png"}, {"url": "/p/4.png"}] }; if (x == "y") {}</script>'
].join("\n");
assert.deepStrictEqual(UR.picturesInScript(other, { name: "chapterImages" }, "https://example.com/c/9"), ["https://cdn.example.net/c/9/001.webp?t=1", "https://cdn.example.net/c/9/002.webp?t=1", "https://cdn.example.net/c/9/003.webp"], "an array of whole addresses, escaped as JSON; a name from no root (img/004.webp) is not taken");
assert.deepStrictEqual(UR.picturesInScript(other, { name: "pages" }, "https://example.com/c/9").length, 4, "an object's field, quoted");
assert.deepStrictEqual(UR.picturesInScript(other, { name: "x" }, "https://example.com/c/9"), [], "(a comparison is no value)");

// ---- the rule ----
let v = UR.validate({ host: "mh160mh.com", scriptPictures: sp, toc: { list: "#chapter a" } });
assert.ok(v.ok, JSON.stringify(v.errors));
assert.deepStrictEqual(v.spec.scriptPictures, sp);
v = UR.validate({ host: "example.com", scriptPictures: { name: "chapterImages" } });
assert.ok(v.ok && !v.spec.selector, "no text selector needed with it");
assert.deepStrictEqual(UR.validate({ host: "example.com", scriptPictures: { name: "a b" } }).errors.map((e) => e.field), ["scriptPictures.name"]);
assert.deepStrictEqual(UR.validate({ host: "example.com", scriptPictures: { name: "x", prefix: "http://img.example.com" } }).errors.map((e) => e.field), ["scriptPictures.prefix"], "https only");
assert.deepStrictEqual(UR.validate({ host: "example.com", scriptPictures: { name: "x", prefix: "https://img.example.com/?a=1" } }).errors.map((e) => e.field), ["scriptPictures.prefix"]);
assert.deepStrictEqual(UR.validate({ host: "example.com", scriptPictures: { prefix: "https://img.example.com" } }).errors.map((e) => e.field), ["scriptPictures.name"], "a server with no list");
assert.strictEqual(UR.validate({ host: "example.com", scriptPictures: { name: "x", prefix: "https://img.example.com/" } }).spec.scriptPictures.prefix, "https://img.example.com", "(no / at its end)");
const rule = UR.toRule(UR.validate({ host: "mh160mh.com", scriptPictures: sp }).spec, null);
assert.deepStrictEqual(rule.picturesFromHtml(html, page), urls, "the engine's rule reads the page's text");
const saved = UR.withDetected({}, "mh160mh.com", { toc: { list: "#chapter a" }, scriptPictures: sp }, 1);
assert.deepStrictEqual(saved["mh160mh.com"].spec.scriptPictures, sp, "what Detect found is saved");

// ---- finding it (Detect) ----
const shown = [first, "https://www.mh160mh.com/template/skin1/css/d7s/images/pic_loading.gif", server + "/mh160tuku/d/%E9%A1%B6%E7%BA%A7%E6%B0%94%E8%BF%90-%E6%82%84%E6%82%84%E4%BF%AE%E7%82%BC%E5%8D%83%E5%B9%B4_62157/02_168051/0002.jpg"];
assert.deepStrictEqual(D.scriptPicturesFor(html, shown, page), { scriptPictures: sp, count: 43 }, "the list that names the pictures shown, and the server they are shown from");
assert.strictEqual(D.scriptPicturesFor(html, shown.slice(1, 2), page), null, "no picture of the list shown: nothing");
assert.strictEqual(D.scriptPicturesFor(html, [], page), null);
assert.strictEqual(D.scriptLists(html).length, 1, "one list of pictures in the page's scripts");
const found = D.scriptPicturesFor(other, ["https://example.com/ad/1.jpg", "https://example.com/ad/2.jpg", "https://example.com/ad/3.jpg", "https://example.com/p/1.png"], "https://example.com/c/9");
assert.deepStrictEqual(found, { scriptPictures: { name: "pages" }, count: 4 }, "of the lists that name pictures shown, the longest (a chapter, not three banners); on the page's own site: no server");
assert.deepStrictEqual(D.asRuleParts({}, null, { scriptPictures: sp }), { scriptPictures: sp });

console.log("OK — script-pictures checks passed");
