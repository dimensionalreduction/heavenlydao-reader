// A chapter that is pictures: the addresses on its page, the bundle, the bytes. Run: node test/image-chapter.test.js
const assert = require("assert");
const path = require("path");
const IC = require(path.join(__dirname, "..", "src", "shared", "image-chapter.js"));

// ---- a page's pictures (a small stand-in for the document: the elements answer what the code asks) ----
const img = (attrs) => ({ tagName: "IMG", getAttribute: (n) => (n in attrs ? attrs[n] : null), querySelectorAll: () => [] });
const box = (...imgs) => ({ tagName: "DIV", getAttribute: () => null, querySelectorAll: (s) => (s === "img" ? imgs : []) });
const docOf = (map) => ({ querySelectorAll: (sel) => { if (sel === "BAD") throw new Error("bad selector"); return map[sel] || []; } });
const base = "https://asurascans.com/comics/x/chapter/1";

{
  const page = (n, extra) => img({ src: "https://cdn.asurascans.com/c/" + n + ".webp?v=1", "data-page-index": String(n), ...extra });
  const doc = docOf({ "#pages": [box(page(1), page(2), page(2), img({ src: "data:image/gif;base64,AAAA" }), img({ "data-src": "/rel/3.jpg", src: "data:image/gif;base64,AAAA" }), img({ src: "http://insecure.example/4.jpg" }), img({}))] });
  assert.deepStrictEqual(IC.urlsOf(doc, "#pages", base), ["https://cdn.asurascans.com/c/1.webp?v=1", "https://cdn.asurascans.com/c/2.webp?v=1", "https://asurascans.com/rel/3.jpg"],
    "in order, once each, lazy-load address before src, relative made absolute, no data: or http: pictures");
  assert.deepStrictEqual(IC.urlsOf(docOf({ "img.p": [page(1), page(2)] }), "img.p", base).length, 2, "a selector that finds the pictures themselves");
  assert.deepStrictEqual(IC.urlsOf(doc, "BAD", base), [], "a selector the browser cannot use finds nothing");
  assert.deepStrictEqual(IC.urlsOf(doc, "", base), [], "no selector: nothing");
  const sets = docOf({ "#p": [img({ srcset: "https://a.example/s.jpg 480w, https://a.example/l.jpg 1080w, https://a.example/m.jpg 800w" })] });
  assert.deepStrictEqual(IC.urlsOf(sets, "#p", base), ["https://a.example/l.jpg"], "the largest of a srcset");
  const many = docOf({ "#p": [box(...Array.from({ length: IC.MAX_PAGES + 50 }, (_, i) => img({ src: "https://a.example/" + i + ".jpg" })))] });
  assert.strictEqual(IC.urlsOf(many, "#p", base).length, IC.MAX_PAGES, "no more than MAX_PAGES");
}

// ---- a picture's size from its header, without decoding it ----
{
  const pad = (a, n = 40) => { const b = new Uint8Array(Math.max(n, a.length)); b.set(a); return b; };
  const le16 = (v) => [v & 255, (v >> 8) & 255];
  const le24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
  const real = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));
  assert.deepStrictEqual(IC.sizeOf(pad(real("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")), "image/png"), { w: 1, h: 1 }, "a real PNG");
  assert.strictEqual(IC.sizeOf(new Uint8Array(12), "image/webp"), null, "(too short to have a header: none)");
  assert.deepStrictEqual(IC.sizeOf(real("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="), "image/webp"), { w: 1, h: 1 }, "a real lossless WebP");
  const riff = (tag, data) => [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...Buffer.from(tag), 0, 0, 0, 0, ...data];
  assert.deepStrictEqual(IC.sizeOf(pad(riff("VP8X", [0, 0, 0, 0, ...le24(799), ...le24(14999)])), "image/webp"), { w: 800, h: 15000 }, "extended WebP: a tall strip");
  assert.deepStrictEqual(IC.sizeOf(pad(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1200), ...le16(1800)])), "image/webp"), { w: 1200, h: 1800 }, "lossy WebP");
  assert.deepStrictEqual(IC.sizeOf(pad([...Buffer.from("GIF89a"), ...le16(3), ...le16(2)]), "image/gif"), { w: 3, h: 2 });
  // a JPEG: a JFIF header segment first, then the frame header
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x04, 0xb0, 0x03, 0x20, 3, 1, 0x22, 0];
  assert.deepStrictEqual(IC.sizeOf(pad(jpeg), "image/jpeg"), { w: 800, h: 1200 }, "JPEG: past the other segments to the frame header");
  assert.strictEqual(IC.sizeOf(pad([0xff, 0xd8, 1, 2, 3]), "image/jpeg"), null, "no frame header: none");
  assert.strictEqual(IC.sizeOf(pad([1, 2, 3]), "image/avif"), null, "AVIF is not read");
  assert.strictEqual(IC.sizeOf(null, "image/png"), null);
  // the bundle carries it
  const withSize = IC.packBundle({ key: "k", title: "T" }, [{ bytes: pad(riff("VP8X", [0, 0, 0, 0, ...le24(799), ...le24(14999)])), type: "image/webp", w: 800, h: 15000 }]);
  assert.deepStrictEqual([IC.indexBundle(withSize).pages[0].w, IC.indexBundle(withSize).pages[0].h], [800, 15000], "in the manifest, and in the page's entry");
}

// ---- a text chapter's pictures: lines of its text ----
{
  assert.strictEqual(IC.mark(3), "\u27e6image:3\u27e7");
  assert.strictEqual(IC.illustrationNo("\u27e6image:12\u27e7"), 12);
  assert.strictEqual(IC.illustrationNo("  \u27e6image:1\u27e7  "), 1, "(spaces around it are fine)");
  assert.strictEqual(IC.illustrationNo("He said \u27e6image:1\u27e7"), 0, "a line with words is not one");
  assert.strictEqual(IC.illustrationNo("[image]"), 0);
  assert.strictEqual(IC.illustrationNo(""), 0);
  const text = ["One.", IC.mark(1), "Two.", "Three.", IC.mark(2), IC.mark(3), "Four."].join("\n");
  const split = IC.splitIllustrations(text);
  assert.strictEqual(split.text, "One.\nTwo.\nThree.\nFour.", "the words alone");
  assert.deepStrictEqual(split.marks, [{ after: 1, n: 1 }, { after: 3, n: 2 }, { after: 3, n: 3 }], "and where the pictures were");
  assert.strictEqual(IC.stripIllustrations(text), split.text);
  assert.strictEqual(IC.joinIllustrations(split.text, split), text, "put back, the text is as it was");
  // translated: the same number of lines puts each picture where it was; another number puts it at the same place in proportion
  assert.strictEqual(IC.joinIllustrations("Un.\nDos.\nTres.\nCuatro.", split), ["Un.", IC.mark(1), "Dos.", "Tres.", IC.mark(2), IC.mark(3), "Cuatro."].join("\n"));
  const fewer = IC.joinIllustrations("A.\nB.", split).split("\n");
  assert.strictEqual(fewer.filter((l) => IC.illustrationNo(l)).length, 3, "none is lost when the translation has fewer lines");
  assert.deepStrictEqual(fewer.filter((l) => !IC.illustrationNo(l)), ["A.", "B."]);
  assert.strictEqual(IC.joinIllustrations("Words.", IC.splitIllustrations("Words.")), "Words.", "no pictures: untouched");
  assert.strictEqual(IC.splitIllustrations(IC.mark(1)).text, "", "a chapter of nothing but a picture");
  // one <img>'s address
  const el = (attrs) => ({ getAttribute: (n) => (n in attrs ? attrs[n] : null) });
  assert.strictEqual(IC.imgUrl(el({ "data-src": "/a/1.jpg", src: "data:image/gif;base64,AAAA" }), "https://x.example/book/1"), "https://x.example/a/1.jpg");
  assert.strictEqual(IC.imgUrl(el({ src: "http://x.example/1.jpg" }), "https://x.example/"), "", "not http");
  assert.strictEqual(IC.imgUrl(el({}), "https://x.example/"), "");
}

// ---- the page's own list of pictures (an Astro island's props, as asurascans.com has them) ----
{
  const wrap = (v) => (Array.isArray(v) ? [1, v.map(wrap)] : v && typeof v === "object" ? [0, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrap(x)]))] : [0, v]);
  const props = JSON.stringify(wrap({ seriesSlug: "genius-prismatic-mage-11fe7da3", chapterNumber: 1, pages: [
    { url: "https://cdn.example/c/1/001.webp?v=1", width: 1200, height: 800 }, { url: "https://cdn.example/c/1/002.webp?v=1", width: 800, height: 14600 },
    { url: "https://cdn.example/c/1/002.webp?v=1", width: 800, height: 14600 }, { url: "http://insecure.example/3.webp" }, { url: "/c/1/004.webp" }] }));
  const island = (attrs) => ({ getAttribute: (n) => (n === "props" ? attrs : null) });
  const doc = { querySelectorAll: (sel) => (sel === "[props]" ? [island("not json"), island(JSON.stringify(wrap({ other: [1, 2] }))), island(props)] : []) };
  assert.deepStrictEqual(IC.urlsFromProps(doc, base), ["https://cdn.example/c/1/001.webp?v=1", "https://cdn.example/c/1/002.webp?v=1", "https://asurascans.com/c/1/004.webp"],
    "the pages of the island that has them, in order, each once, https only, relative made absolute; islands without pages, and text that is not JSON, are passed over");
  assert.deepStrictEqual(IC.urlsFromProps({ querySelectorAll: () => [] }, base), [], "no islands: none");
  assert.deepStrictEqual(IC.urlsFromProps({ querySelectorAll: () => { throw new Error("x"); } }, base), []);
}

// ---- fetching the pictures: a few at a time, paced, tried again, kept when one fails ----
{
  const urls = Array.from({ length: 6 }, (_, i) => "https://cdn.example/" + i + ".webp");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = (url) => ({ bytes: new Uint8Array([url.length]), type: "image/webp", from: url });
  globalThis.fetchTests = async () => { // (run last: the checks above block for a while, which would throw the timing off)
    // in order, never more than 3 at once, starts at least `gap` apart
    let live = 0;
    let most = 0;
    const starts = [];
    const got = await IC.fetchPages(urls, async (url) => { starts.push(Date.now()); live++; most = Math.max(most, live); await sleep(120); live--; return page(url); }, { gap: 25 }); // (a picture takes longer than three starts, so three are under way together)
    assert.deepStrictEqual(got.map((p) => p.from), urls, "in the order of the addresses");
    assert.strictEqual(most, 3, "three at a time");
    assert.ok(starts[5] - starts[0] >= 100, "starts are spaced (25 ms apart, five times): " + JSON.stringify(starts.map((t) => t - starts[0])));

    // a picture that fails twice and then comes is tried again (after the waits) and is not lost
    const tries = {};
    const waits = [];
    const again = await IC.fetchPages(urls, async (url, i) => { tries[i] = (tries[i] || 0) + 1; if (i === 2 && tries[i] < 3) throw new Error("HTTP 503"); return page(url); }, { gap: 0, backoff: [30, 60] });
    assert.strictEqual(tries[2], 3, "tried three times");
    assert.deepStrictEqual(again.map((p) => p.from), urls);

    // fatal: not tried again
    let fatalTries = 0;
    await assert.rejects(IC.fetchPages(urls, async (url, i) => { if (i === 1) { fatalTries++; throw Object.assign(new Error("HTTP 404"), { fatal: true }); } return page(url); }, { gap: 0, parallel: 1, backoff: [10] }), /HTTP 404/);
    assert.strictEqual(fatalTries, 1);

    // one keeps failing: the error says what was fetched, and asking again with it carries on from there
    const calls = [];
    let broken = true;
    const fetchOne = async (url, i) => { calls.push(i); if (i === 3 && broken) throw new Error("HTTP 500"); return page(url); };
    const err = await IC.fetchPages(urls, fetchOne, { gap: 0, parallel: 1, retries: 1, backoff: [5] }).then(() => null, (e) => e);
    assert.ok(err && /HTTP 500/.test(err.message), "the error comes");
    assert.deepStrictEqual(err.partial.map((p) => !!p), [true, true, true, false, false, false], "with the pictures before it (nothing after it is started)");
    broken = false;
    calls.length = 0;
    const progress = [];
    const rest = await IC.fetchPages(urls, fetchOne, { gap: 0, parallel: 1, have: err.partial, onProgress: (d, t) => progress.push(d + "/" + t) });
    assert.deepStrictEqual(calls, [3, 4, 5], "only the missing ones are fetched");
    assert.deepStrictEqual(rest.map((p) => p.from), urls);
    assert.strictEqual(progress[0], "3/6", "the progress starts from what is kept");
    assert.strictEqual(progress[progress.length - 1], "6/6");
  };
}

// ---- what a picture is, from its bytes ----
{
  const bytes = (...b) => Uint8Array.from([...b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(IC.kindOf(bytes(0x89, 0x50, 0x4e, 0x47)), "image/png");
  assert.strictEqual(IC.kindOf(bytes(0xff, 0xd8, 0xff)), "image/jpeg");
  assert.strictEqual(IC.kindOf(bytes(0x47, 0x49, 0x46, 0x38)), "image/gif");
  assert.strictEqual(IC.kindOf(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  assert.strictEqual(IC.kindOf(new TextEncoder().encode("<!DOCTYPE html><html>")), "", "a page is not a picture");
  assert.strictEqual(IC.kindOf(new Uint8Array(3)), "");
}

// ---- the bundle: pack, index, read back ----
{
  const webp = (n, size) => { const b = new Uint8Array(size); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); for (let i = 12; i < size; i++) b[i] = (i * 7 + n) & 255; return b; };
  const pages = [{ bytes: webp(1, 5000), type: "image/webp", w: 800, h: 14000 }, { bytes: webp(2, 123), type: "image/webp" }, { bytes: Uint8Array.from([0xff, 0xd8, 1, 2, 3]), type: "image/jpeg" }];
  const bundle = IC.packBundle({ key: "translation:https://asurascans.com/comics/x/chapter/1", title: "Chapter 1 — ünï" }, pages);
  const { manifest, pages: entries } = IC.indexBundle(bundle);
  assert.strictEqual(manifest.v, 1);
  assert.strictEqual(manifest.title, "Chapter 1 — ünï");
  assert.strictEqual(manifest.key, "translation:https://asurascans.com/comics/x/chapter/1");
  assert.deepStrictEqual(entries.map((e) => [e.name, e.type, e.length]), [["p001.webp", "image/webp", 5000], ["p002.webp", "image/webp", 123], ["p003.jpg", "image/jpeg", 5]]);
  assert.deepStrictEqual(entries[0].w, 800);
  entries.forEach((e, i) => assert.deepStrictEqual([...IC.pageBytes(bundle, e)], [...pages[i].bytes], "page " + (i + 1) + " comes back byte for byte"));
  // it is an ordinary zip (a CBZ reader or `unzip` opens it): the first file is the manifest and the checksums are right
  assert.strictEqual(String.fromCharCode(...bundle.subarray(0, 2)), "PK");
  assert.strictEqual(new DataView(bundle.buffer, bundle.byteOffset).getUint32(14, true), IC.crc32(new TextEncoder().encode(JSON.stringify({ v: 1, key: manifest.key, title: manifest.title, pages: manifest.pages }))), "the manifest's checksum");
  assert.strictEqual(IC.crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "crc32 of the standard test string");
  assert.throws(() => IC.indexBundle(new Uint8Array(100)), /not a chapter bundle/);
  assert.throws(() => IC.indexBundle(bundle.subarray(0, bundle.length - 10)), /not a chapter bundle/, "cut short");
  assert.throws(() => IC.packBundle({ key: "k" }, []), /1 to/);
  // a zip system tool agrees (when there is one on this computer)
  const os = require("os");
  const fs = require("fs");
  const { spawnSync } = require("child_process");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bundle-")), "chapter.zip");
  fs.writeFileSync(file, bundle);
  const tool = spawnSync("tar", ["-tf", file], { encoding: "utf8" });
  if (tool.status === 0) assert.deepStrictEqual(tool.stdout.trim().split(/\r?\n/), ["manifest.json", "p001.webp", "p002.webp", "p003.jpg"], "tar lists the same files");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ---- keeping to a limit: the least recently read goes first, what is being read stays ----
{
  const rows = [{ key: "a", size: 100, readAt: 5 }, { key: "b", size: 100, readAt: 1 }, { key: "c", size: 100, readAt: 3 }, { key: "d", size: 100, readAt: 9 }];
  assert.deepStrictEqual(IC.planTrim(rows, 400, []), [], "it fits: nothing goes");
  assert.deepStrictEqual(IC.planTrim(rows, 250, []), ["b", "c"], "the two read longest ago");
  assert.deepStrictEqual(IC.planTrim(rows, 250, ["b"]), ["c", "a"], "a kept one is passed over");
  assert.deepStrictEqual(IC.planTrim(rows, 0, ["a", "b", "c", "d"]), [], "only kept ones left: nothing goes");
  assert.deepStrictEqual(IC.planTrim([{ key: "x", size: 500, readAt: 1 }], 100, []), ["x"], "one over the limit by itself goes");
  assert.deepStrictEqual(rows.map((r) => r.key), ["a", "b", "c", "d"], "the rows are not reordered");
}

// ---- bytes <-> text ----
{
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => (i * 31) & 255);
  assert.deepStrictEqual([...IC.fromB64(IC.toB64(bytes))], [...bytes]);
  assert.strictEqual(IC.toB64(new Uint8Array(0)), "");
}

// ---- a picture that cannot be made smaller stays as it was ----
IC.squeeze(new Uint8Array(500000), "image/jpeg").then((r) => {
  assert.strictEqual(r.type, "image/jpeg", "(no browser here to decode it)");
  return IC.squeeze(new Uint8Array(10), "image/webp");
}).then((r) => {
  assert.strictEqual(r.type, "image/webp");
  return globalThis.fetchTests();
}).then(() => console.log("image-chapter: all passed"), (e) => { console.error(e); process.exit(1); });
