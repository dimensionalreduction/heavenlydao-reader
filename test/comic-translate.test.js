// A chapter of pictures translated in its pictures: where the strip is cut, what is read from an answer, what is drawn, how the site's pictures are made
// again. Run: node test/comic-translate.test.js
const assert = require("assert");
const path = require("path");
const CT = require(path.join(__dirname, "..", "src", "shared", "comic-translate.js"));

// ---- how much of a row is one colour ----
{
  const w = 100, rows = 3, data = new Uint8ClampedArray(w * rows * 4).fill(255);
  const paint = (y, x0, x1, v) => { for (let x = x0; x < x1; x++) data.set([v, v, v, 255], (y * w + x) * 4); };
  paint(1, 0, 50, 0); // half black
  paint(2, 10, 12, 0); // an outline crossing a white row
  assert.deepStrictEqual(CT.flatRows(data, w, rows), [100, 50, 98], "a white row, a half black one, one with two dark pixels");
}

// ---- the strip cut for reading ----
// width 100: chunks of 60 to 220 rows, an overlap of 50, gutters of 4 rows or more
const strip = (H, gutters, quiet) => {
  const flat = new Array(H).fill(50);
  for (const [a, b] of gutters) for (let y = a; y < b; y++) flat[y] = 100;
  for (const [a, b, v] of quiet || []) for (let y = a; y < b; y++) flat[y] = v;
  return flat;
};
{
  const flat = strip(1000, [[100, 120], [300, 310], [700, 702]], [[468, 473, 90]]);
  assert.deepStrictEqual(CT.gutters(flat, 100), [[100, 120], [300, 310]], "a run of blank rows shorter than the gutter is none");
  const list = CT.chunks(flat, 100);
  assert.deepStrictEqual(list.slice(0, 2), [{ y0: 0, y1: 110, cut: "gutter" }, { y0: 110, y1: 305, cut: "gutter" }], "cut in the middle of a gutter in reach");
  assert.strictEqual(list[2].cut, "hard", "no gutter in reach: a hard cut");
  assert.ok(list[2].y1 >= 468 && list[2].y1 < 473, "at the quietest rows, not at the window's end: " + list[2].y1);
  for (let k = 0; k < list.length - 1; k++) {
    const c = list[k];
    assert.ok(c.y1 - c.y0 <= 220 && c.y1 - c.y0 >= 60, "a chunk is 0.6 to 2.2 widths: " + JSON.stringify(c));
    assert.strictEqual(list[k + 1].y0, c.cut === "hard" ? c.y1 - 50 : c.y1, "after a hard cut the next chunk starts half a width earlier");
  }
  assert.deepStrictEqual(list[list.length - 1].y1, 1000, "to the end");
  assert.strictEqual(list[list.length - 1].cut, "end");
  assert.deepStrictEqual(CT.coreOf(list, 2), [305, (list[3].y0 + list[2].y1) / 2], "a chunk's core: from its start (no overlap before) to the middle of the overlap after");

  // ---- what is read: in strip coordinates, each item once ----
  const c2 = list[2], c3 = list[3], h2 = c2.y1 - c2.y0, h3 = c3.y1 - c3.y0;
  const core3 = CT.coreOf(list, 3);
  const at = (c, h, y) => Math.round(((y - c.y0) / h) * 1000); // a strip row as the 0-1000 scale of a picture
  const whole = [at(c2, h2, c2.y1 - 70), 100, at(c2, h2, c2.y1 - 20), 600]; // a bubble near the end of chunk 2, inside its core
  const again = [at(c3, h3, c2.y1 - 70), 100, at(c3, h3, c2.y1 - 20), 600]; // the same bubble in chunk 3's overlap
  const later = [at(c3, h3, core3[1] - 60), 0, at(c3, h3, core3[1] - 40), 1000];
  const answer = { choices: [{ message: { content: "```json\n" + JSON.stringify({
    items: [
      { p: 1, box_2d: whole, kind: "speech", text: "하긴", en: "Well", speaker: "Kim Dokja" },
      { p: 2, box_2d: again, kind: "speech", text: "하긴", en: "Well", speaker: "Kim Dokja" },
      { p: 2, box_2d: [later], kind: "sfx", text: "쾅", en: "Bam", speaker: "" },
      { p: 3, box_2d: whole, kind: "speech", text: "no such picture", en: "x" },
      { p: 1, box_2d: [1, 2, 3], kind: "speech", text: "three numbers", en: "x" },
      { p: 1, box_2d: whole, kind: "speech", text: "  ", en: "x" },
      { p: 1, box_2d: [500, 500, 400, 600], kind: "speech", text: "upside down", en: "x" }
    ],
    terms: [{ source: "김독자", en: "Kim Dokja", kind: "person" }, { source: "no English", en: "" }]
  }) + "\n```" } }] };
  const got = CT.readItems(answer, list, [2, 3], 100);
  assert.deepStrictEqual(got.items.map((i) => i.text), ["하긴", "쾅"], "the bubble seen twice is kept once; a wrong picture, a bad box, no text: left out");
  assert.deepStrictEqual([got.items[0].x0, got.items[0].x1], [10, 60], "across, on the strip's width");
  assert.ok(Math.abs(got.items[0].y0 - (c2.y1 - 70)) <= 1 && Math.abs(got.items[0].y1 - (c2.y1 - 20)) <= 1, "down, in strip rows");
  assert.strictEqual(got.items[1].speaker, null, "no speaker for a sound effect (an empty one is none)");
  assert.strictEqual(got.items[1].kind, "sfx");
  assert.deepStrictEqual(got.terms, [{ source: "김독자", en: "Kim Dokja", kind: "person" }], "terms with no English are left out");
  assert.throws(() => CT.readItems("not json at all", list, [2, 3], 100), /unreadable/);
}

// ---- the request that reads ----
{
  const body = CT.readBody(["data:image/jpeg;base64,AA", "data:image/jpeg;base64,BB"], { from: "Korean", glossary: [{ source: "김독자", en: "Kim Dokja" }], cast: ["Kim Dokja"] });
  assert.strictEqual(body.model, CT.READ_MODEL);
  const parts = body.messages[0].content;
  assert.deepStrictEqual(parts.slice(1).map((p) => p.type === "text" ? p.text : p.image_url.url), ["Picture 1:", "data:image/jpeg;base64,AA", "Picture 2:", "data:image/jpeg;base64,BB"], "each picture after its label");
  assert.ok(/Korean comic/.test(parts[0].text) && /김독자 = Kim Dokja/.test(parts[0].text) && /already met in this chapter[^\n]*Kim Dokja/.test(parts[0].text), "the language, the glossary and the cast so far");
  assert.deepStrictEqual(body.response_format, { type: "json_object" });
}

// ---- the parts of the strip drawn again ----
{
  // width 690: drawn at most 1518 rows at once, a span of text padded by 55 rows, at least 256 rows sent
  const W = 690;
  const flat = strip(6000, [[500, 540], [1000, 1100], [2000, 2050], [2600, 2700]]);
  const item = (y0, y1, en = "x") => ({ y0, y1, x0: 100, x1: 400, kind: "speech", text: "t", en });
  const items = [item(200, 400), item(700, 800), item(1500, 1600, ""), item(2100, 2300), item(3000, 3400), item(4300, 4700), item(5800, 5850)];
  const secs = CT.sections(flat, W, items);
  assert.deepStrictEqual(secs.map((s) => [s.y0, s.y1]), [[145, 855], [2045, 2355], [2945, 3455], [4245, 4755], [5745, 5905]],
    "two spans with text side by side are one request; a span with no text (or only text not translated) is not sent; a tall span is cut where no box crosses");
  assert.deepStrictEqual(secs[0].items.map((i) => i.y0), [200, 700]);
  assert.deepStrictEqual([secs[4].cy0, secs[4].cy1], [5697, 5953], "a small section is sent as 256 rows around it, and only its own rows are taken back");
  assert.deepStrictEqual([secs[1].cy0, secs[1].cy1], [2045, 2355], "a big enough one is sent as it is");
  for (let i = 1; i < secs.length; i++) assert.ok(secs[i].y0 >= secs[i - 1].y1, "sections never overlap");

  // a span with no text between two that have some, all within reach: one request
  const joined = CT.sections(strip(1200, [[280, 320], [580, 620]]), W, [item(100, 200), item(700, 800)]);
  assert.deepStrictEqual(joined.map((s) => [s.y0, s.y1, s.items.length]), [[45, 855, 2]]);
  // a sound effect taller than anything sent at once: the cut goes after it
  const tall = CT.sections(strip(3000, []), W, [item(100, 2900)]);
  assert.deepStrictEqual(tall.map((s) => [s.y0, s.y1]), [[45, 2900]]);

  const body = CT.drawBody({ ...secs[0], items: [{ ...secs[0].items[0], text: "하긴", en: "Well, who would" }, { ...secs[0].items[1], kind: "sfx", text: "덜컹", en: "Rattle" }] }, "data:image/png;base64,CC", { width: W, from: "Korean" });
  assert.strictEqual(body.model, CT.DRAW_MODEL);
  assert.strictEqual(body.quality, CT.DRAW_QUALITY);
  assert.strictEqual(CT.drawBody(secs[0], "data:image/png;base64,CC", { width: W, model: "black-forest-labs/flux-3-image-klein" }).quality, undefined, "no quality for another model unless given");
  assert.deepStrictEqual(body.input_references, [{ type: "image_url", image_url: { url: "data:image/png;base64,CC" } }]);
  assert.ok(body.prompt.includes('1. top centre, speech bubble: "하긴" becomes "Well, who would"') && body.prompt.includes('2. bottom centre, sound effect: "덜컹" becomes "Rattle"'), body.prompt);
  assert.ok(/Leave any other lettering/.test(body.prompt), "other lettering stays");
  assert.strictEqual(body.aspect_ratio, "auto");
  const plain = CT.drawBody({ ...secs[0], items: [{ ...secs[0].items[0], text: "하긴,\n3,000화가", en: "Well, who\nwould" }, { ...secs[0].items[1], kind: "sfx", text: "덜컹", en: "Rattle" }] }, "data:image/png;base64,CC", { width: W, style: "list" });
  assert.strictEqual(plain.prompt, "Translate the image with this:\n1. 하긴, 3,000화가 -> Well, who would\n2. 덜컹 -> Rattle", "the plain prompt: the translations only, a line each");
  // a section refused as a whole: in two, then an item on its own, the rows around it within the section, at least 256 sent
  const one = CT.partOf([secs[0].items[1]], secs[0], W, 6000);
  assert.deepStrictEqual([one.y0, one.y1, one.cy0, one.cy1, one.items.length, one.alone], [645, 855, 622, 878, 1, true]);
  const halves = CT.halvesOf({ y0: 0, y1: 2000, cy0: 0, cy1: 2000, items: [item(100, 200), item(250, 300), item(900, 1000), item(1100, 1200)] }, W, 6000);
  assert.deepStrictEqual(halves.map((h) => h.items.map((i) => i.y0)), [[100, 250], [900, 1100]], "a refused section in two, at the widest gap between its items");
  assert.strictEqual(CT.drawnOf({ data: [{ b64_json: "QUJD", media_type: "image/webp" }] }), "data:image/webp;base64,QUJD");
  assert.strictEqual(CT.drawnOf({ data: [] }), "");
  assert.strictEqual(CT.drawnOf(null), "");
}

// ---- an item's letters, and whether they are on one flat colour ----
{
  // a white bubble with a black outline on noisy art, two black "letters" inside, the second reaching past the box the reading gave
  const w = 120, h = 100;
  const make = (inside) => {
    const d = new Uint8ClampedArray(w * h * 4);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const e = ((x - 60) / 50) ** 2 + ((y - 50) / 40) ** 2, i = (y * w + x) * 4;
      const v = e > 1.12 ? 100 + rnd() * 80 : e > 0.9 ? 0 : inside(x, y);
      d.set([v, v, v, 255], i);
    }
    const rect = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([v, v, v, 255], (y * w + x) * 4); };
    rect(40, 40, 55, 48, 0); rect(60, 52, 81, 61, 0);
    return d;
  };
  const box = { x0: 30, y0: 30, x1: 75, y1: 58 }; // (the bubble's middle, as the reading gives it: mostly paper)
  const got = CT.letters(make(() => 255), w, h, box);
  assert.strictEqual(got.plain, true, "letters on a white bubble are plain");
  assert.deepStrictEqual(got.paper, [255, 255, 255]);
  assert.deepStrictEqual(got.ink, [0, 0, 0]);
  assert.deepStrictEqual(got.bbox, { x0: 40, y0: 40, x1: 81, y1: 61 }, "the whole of a letter the box cut through");
  assert.ok(got.mask[44 * w + 45] && got.mask[56 * w + 78] && got.mask[38 * w + 45], "the letters, grown by 2");
  assert.ok(!got.mask[50 * w + 10] && !got.mask[50 * w + 25], "not the outline, not the paper away from the letters");
  assert.ok(got.area[30 * w + 60] && got.area[50 * w + 15] && !got.area[2 * w + 2] && !got.area[50 * w + 10], "the bubble's inside, not its outline or the art");
  assert.strictEqual(got.open, false);
  assert.strictEqual(got.lines, 2, "two lines of letters (rows 40 to 47, and 52 to 60)");
  const art = CT.letters(make((x, y) => 150 + ((x * 7 + y * 13) % 60)), w, h, box);
  assert.strictEqual(art.plain, false, "letters over shaded art are not plain");
  // a caption on a black page: no outline round it
  const cap = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) cap.set([0, 0, 0, 255], p * 4);
  for (let y = 45; y < 55; y++) for (let x = 30; x < 90; x++) if (x % 4 < 2) cap.set([250, 250, 250, 255], (y * w + x) * 4); // (strokes)
  const c = CT.letters(cap, w, h, { x0: 26, y0: 40, x1: 94, y1: 60 });
  assert.ok(c.plain && c.open, "white letters on black are plain, and nothing closes them in");
  const tight = CT.letters(cap, w, h, { x0: 30, y0: 44, x1: 50, y1: 56 });
  assert.deepStrictEqual([tight.bbox.x0, tight.bbox.x1], [32, 90], "a box around the first words only: the rest of the line is found beside them");
  assert.strictEqual(CT.letters(cap, w, h, { x0: 30, y0: 45, x1: 32, y1: 55 }).plain, false, "a box that is nearly all letters: the paper cannot be told, so not plain");
  assert.deepStrictEqual(c.ink, [250, 250, 250]);
}

// ---- the English in the bubble's shape ----
{
  const measure = (t, size) => t.length * size * 0.5;
  const rect = new Uint8Array(200 * 100).fill(1);
  const words = "Well, who would easily want".split(" ");
  const fit = CT.layout(rect, 200, 100, { x: 100, y: 50 }, words, measure, { maxSize: 20 });
  assert.strictEqual(fit.size, 20, "the largest size that fits");
  assert.deepStrictEqual(fit.lines.map((l) => l.text), ["Well, who would", "easily want"], "as few lines as fit, filled in order");
  assert.ok(fit.lines.every((l) => l.x === 100), "centred");
  assert.ok(fit.lines[0].y < 50 && fit.lines[1].y > 50, "around the old text's middle");
  const oval = new Uint8Array(200 * 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) oval[y * 200 + x] = ((x - 100) / 100) ** 2 + ((y - 50) / 50) ** 2 <= 1 ? 1 : 0;
  const long = "Even I, the only reader, took over ten years to finally read the last chapter".split(" ");
  const inRect = CT.layout(rect, 200, 100, { x: 100, y: 50 }, long, measure, { maxSize: 30 }), inOval = CT.layout(oval, 200, 100, { x: 100, y: 50 }, long, measure, { maxSize: 30 });
  assert.ok(inOval && inRect && inOval.size < inRect.size, "an oval bubble holds less than its box: " + (inOval && inOval.size) + " < " + (inRect && inRect.size));
  assert.strictEqual(CT.layout(new Uint8Array(30 * 30).fill(1), 30, 30, { x: 15, y: 15 }, ["Supercalifragilisticexpialidocious"], measure, { maxSize: 20 }), null, "a word wider than the bubble at the smallest size: none");
  assert.ok(CT.layout(rect, 200, 100, { x: 100, y: 50 }, ["one"], measure, { maxSize: 60, maxWidth: 40 }).size <= 26, "an open caption keeps to about its old width");
  const row = CT.layout(rect, 200, 100, { x: 100, y: 50 }, words, measure, { maxSize: 20, lines: 1 });
  assert.deepStrictEqual([row.lines.length, row.size < 20], [1, true], "a screen's row stays one line, smaller");
}

// ---- the full method: the text detector's tiles, lines, and reading them by number ----
{
  assert.deepStrictEqual(CT.tilesOf(100, 300), [0, 75, 150, 200], "square tiles three quarters of a width apart, the last ending at the strip's end");
  assert.deepStrictEqual(CT.tilesOf(100, 80), [0], "a strip shorter than its width: one tile");
  assert.deepStrictEqual([CT.detectSideOf(316), CT.detectScale(316), CT.detectSideOf(800), CT.detectSideOf(480)], [640, 2, 960, 960], "a narrow strip is enlarged at most twice, in a smaller square (a 316 px strip took 125 tiles of 960)");
  const rgba = new Uint8ClampedArray([255, 0, 0, 255]); // one red pixel
  const input = CT.detectInput(rgba, 1);
  assert.ok(Math.abs(input[2] - (1 - 0.406) / 0.225) < 1e-6 && Math.abs(input[0] - (0 - 0.485) / 0.229) < 1e-6, "blue, green, red; ImageNet's mean and spread");

  // a 100 x 100 map at twice the strip's size (scale 2): a line in the middle, one touching the bottom edge, and a speck
  const size = 100, map = new Uint8Array(size * size);
  const fill = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) map[y * size + x] = 200; };
  fill(20, 40, 80, 50); fill(10, 96, 60, 100); fill(5, 5, 7, 7);
  const mid = CT.linesOfTile(map, size, 2, 1000, 50, 50, {});
  assert.strictEqual(mid.length, 1, "the line at the tile's bottom edge is left to the next tile, the speck is no line");
  const l = mid[0], d = (30 * 5 * 1.5) / (2 * 35); // (30 x 5 strip pixels, grown by area x 1.5 / perimeter)
  assert.deepStrictEqual([l.x0, l.y0, l.x1, l.y1], [Math.round(10 - d), Math.round(1020 - d), Math.round(40 + d), Math.round(1025 + d)], "in strip pixels, grown as PaddleOCR grows a line");
  assert.strictEqual(CT.linesOfTile(map, size, 2, 1000, 50, 50, { last: true }).length, 2, "at the strip's end the edge line is kept");
  const merged = CT.mergeLines([{ x0: 0, y0: 100, x1: 50, y1: 120 }, { x0: 2, y0: 102, x1: 48, y1: 118 }, { x0: 0, y0: 10, x1: 40, y1: 30 }]);
  assert.deepStrictEqual(merged, [{ x0: 0, y0: 10, x1: 40, y1: 30, n: 1 }, { x0: 0, y0: 100, x1: 50, y1: 120, n: 2 }], "a line two tiles saw is kept once; numbered top to bottom");

  // reading by number: chunks 0-1000 and 900-2000 (an overlap of 100), lines in both
  const list = [{ y0: 0, y1: 1000, cut: "hard" }, { y0: 900, y1: 2000, cut: "end" }];
  const lines = [{ x0: 10, y0: 100, x1: 90, y1: 130, n: 1 }, { x0: 10, y0: 140, x1: 90, y1: 170, n: 2 }, { x0: 10, y0: 930, x1: 90, y1: 960, n: 3 }, { x0: 10, y0: 1500, x1: 90, y1: 1530, n: 4 }];
  assert.deepStrictEqual(CT.linesIn(list, 0, lines, 100).map((x) => x.n), [1, 2, 3], "line 3 is in both chunks (its middle 945), shown in the one whose core holds it (chunk 1 up to 950)");
  assert.deepStrictEqual(CT.linesIn(list, 1, lines, 100).map((x) => x.n), [4]);
  assert.deepStrictEqual(CT.linesIn(list, 0, lines, 100)[0].box_2d, [100, 100, 130, 900], "its box on the chunk's 0-1000 scale");
  const body = CT.markedReadBody(["data:a", "data:b"], [CT.linesIn(list, 0, lines, 100), CT.linesIn(list, 1, lines, 100)], { from: "Korean" });
  const parts = body.messages[0].content;
  assert.ok(/numbered box round each line/.test(parts[0].text) && /"keep": true/.test(parts[0].text) && /"lines": \[\]/.test(parts[0].text), "the prompt: numbered lines, keep, text with no box");
  assert.strictEqual(parts[3].text, "Lines in picture 1: 1 [100,100,130,900], 2 [140,100,170,900], 3 [930,100,960,900]", "each picture's lines after it");
  const used = new Set();
  const answer = JSON.stringify({ items: [
    { lines: [1, 2], kind: "speech", text: "하긴\n그래", en: "Well, true", speaker: "Kim Dokja", keep: false },
    { lines: ["L4"], kind: "screen", text: "뉴토끼", en: "Newtoki", keep: true },
    { lines: [2], kind: "speech", text: "again", en: "again" },
    { lines: [], p: 1, box_2d: [500, 0, 600, 1000], kind: "sfx", text: "쾅", en: "Bam" },
    { lines: [], p: 2, box_2d: [0, 0, 20, 1000], kind: "sfx", text: "in the overlap", en: "x" }
  ], terms: [] });
  const got = CT.readMarked(answer, list, [0, 1], 100, lines, used);
  assert.deepStrictEqual(got.items.map((i) => i.text), ["하긴\n그래", "뉴토끼", "쾅"], "a line given twice is one item's; text with no line in the overlap is kept from the chunk that holds it");
  assert.deepStrictEqual([got.items[0].x0, got.items[0].y0, got.items[0].x1, got.items[0].y1, got.items[0].lines.length, got.items[0].located], [10, 100, 90, 170, 2, true], "where its lines are");
  assert.strictEqual(got.items[1].keep, true, "a watermark is kept as it is");
  assert.deepStrictEqual([got.items[2].y0, got.items[2].y1, got.items[2].located], [500, 600, false], "a sound effect with no line: where the reading drew it");
  assert.deepStrictEqual([...used].sort(), [1, 2, 4], "the lines given out, for the next request");

  // a tag copied into the text (it sat beside its line) comes out; a number of the text's own stays; not_text takes nothing from an item that names the line
  const tagged = JSON.stringify({ items: [
    { lines: [1, 2], kind: "speech", text: "나머지는 1\n2\n16년 전부", en: "All of it, 16 years" },
    { lines: [3], kind: "speech", text: "3 넘겨주고 올게.", en: "I'll hand it over." }
  ], not_text: [1, 3, 4], terms: [] });
  const clean = CT.readMarked(tagged, list, [0, 1], 100, lines, new Set());
  assert.deepStrictEqual(clean.items.map((i) => i.text), ["나머지는\n16년 전부", "넘겨주고 올게."], "its own lines' numbers at a row's ends, or a row of one, are taken out");
  assert.deepStrictEqual(clean.items.map((i) => i.lines.map((l) => l.n)), [[1, 2], [3]], "an item keeps the lines it names, whatever not_text says");
}

// ---- a bubble's lines are numbered one after another: two bubbles side by side, their rows at the same heights (mh160mh.com 86691162, picture 2, as the finder found
// them on its 800 px strip: 不可能！ alone, 他不是死在 / 渺渺宇宙中 / 了吗？ in the middle, 假的！肯定只 / 是一道阵法投 / 影罢了！ on the right). Numbered by their tops
// they alternated, the reading gave all six to the middle bubble, and the right one's text was lost ----
{
  const row = (x0, y0, x1, y1, name) => ({ x0: x0 * 800, y0: y0 * 1131, x1: x1 * 800, y1: y1 * 1131, name });
  const lines = [row(0.05, 0.711, 0.15, 0.735, "left"), row(0.38, 0.713, 0.51, 0.734, "mid 1"), row(0.62, 0.721, 0.78, 0.744, "right 1"), row(0.37, 0.737, 0.51, 0.759, "mid 2"),
    row(0.62, 0.744, 0.78, 0.766, "right 2"), row(0.38, 0.760, 0.45, 0.783, "mid 3"), row(0.61, 0.769, 0.71, 0.790, "right 3")];
  assert.deepStrictEqual(CT.lineOrder(lines).map((i) => lines[i].name), ["left", "mid 1", "mid 2", "mid 3", "right 1", "right 2", "right 3"], "each bubble's rows one after another, the bubbles by their tops");
  // columns of a vertical bubble: right to left; one under another (a bubble lower down) after it
  const col = (x0, y0, x1, y1, name) => ({ x0, y0, x1, y1, name });
  const vert = [col(100, 0, 120, 100, "col 2"), col(130, 0, 150, 100, "col 1"), col(100, 300, 160, 320, "below")];
  assert.deepStrictEqual(CT.lineOrder(vert).map((i) => vert[i].name), ["col 1", "col 2", "below"], "a column bubble right to left, then the next block");
  assert.deepStrictEqual(CT.lineOrder([]), []);
}

// ---- a bubble's lines go to one chunk, whole (by their block's middle, not each line's own) ----
{
  const list = [{ y0: 0, y1: 1000, cut: "hard" }, { y0: 900, y1: 2000, cut: "end" }]; // (the core of the first ends at 950)
  const line = (x0, y0, x1, y1, n) => ({ x0, y0, x1, y1, n });
  // a bubble across 950 whose block's middle (962) is below it: its first line's own middle (942) is above
  const low = [line(20, 930, 60, 955, 1), line(15, 950, 65, 975, 2), line(25, 970, 55, 995, 3)];
  // one whose block's middle (932) is above: its last line's own middle (952) is below
  const high = [line(120, 900, 160, 925, 4), line(115, 920, 165, 945, 5), line(125, 940, 155, 965, 6)];
  const beside = line(70, 945, 100, 975, 7); // (another bubble on the same rows: not over the first one)
  const far = line(20, 1500, 60, 1530, 8);
  const lines = [...low, ...high, beside, far];
  const mids = CT.blocksOf(lines);
  assert.deepStrictEqual(mids.map((m) => Math.round(m * 10) / 10), [962.5, 962.5, 962.5, 932.5, 932.5, 932.5, 960, 1515], "lines over one another are one block; one beside them is not");
  assert.deepStrictEqual(CT.linesIn(list, 0, lines.map((l) => ({ ...l })), 100).map((x) => x.n), [1, 4, 5], "by each line's own middle: both bubbles cut in two");
  assert.deepStrictEqual(CT.claimLines(list, 0, lines).map((x) => x.n), [4, 5, 6], "the first chunk takes the bubble whose middle is in its core, its last line too");
  assert.deepStrictEqual(CT.claimLines(list, 1, lines).map((x) => x.n), [1, 2, 3, 7, 8], "the next takes the other bubble whole, the one beside it and the rest");
  assert.deepStrictEqual(CT.linesIn(list, 0, lines, 100).map((x) => x.n), [4, 5, 6], "linesIn follows what was taken");
  assert.deepStrictEqual(CT.claimLines(list, 0, lines).map((x) => x.n), [4, 5, 6], "taken once, for good");
  // a line the chunk of its block does not show goes by its own middle
  const tall = [line(20, 600, 60, 640, 1), line(20, 630, 60, 670, 2), line(20, 660, 60, 700, 3), line(20, 690, 60, 730, 4), line(20, 720, 60, 760, 5),
    line(20, 750, 60, 790, 6), line(20, 780, 60, 820, 7), line(20, 810, 60, 850, 8), line(20, 840, 60, 880, 9), line(20, 870, 60, 910, 10), line(20, 900, 60, 940, 11),
    line(20, 930, 60, 970, 12), line(20, 960, 60, 1000, 13), line(20, 990, 60, 1030, 14), line(20, 1020, 60, 1060, 15)];
  const first = CT.claimLines(list, 0, tall).map((x) => x.n);
  assert.ok(first.includes(13) && !first.includes(14) && !first.includes(15), "a block running past the chunk's end: what the chunk does not show is the next one's: " + first);
  assert.deepStrictEqual(CT.claimLines(list, 1, tall).map((x) => x.n), [14, 15]);
}

// ---- where a line's number tag goes: on no text ----
{
  // three lines of one bubble, boxes as the detector grows them (each reaching past its letters, so they overlap), lines 20 px tall and 5 px apart
  const grown = (x0, y0, x1, y1, n) => { const d = (((x1 - x0) * (y1 - y0) * 1.5) / (2 * (x1 - x0 + y1 - y0))); return { x0: x0 - d, y0: y0 - d, x1: x1 + d, y1: y1 + d, n, letters: { x0, y0, x1, y1 } }; };
  const lines = [grown(120, 100, 180, 120, 1), grown(100, 125, 200, 145, 2), grown(130, 150, 170, 170, 3)];
  assert.ok(Math.abs(CT.unclipOf(lines[1]) - (lines[1].letters.x0 - lines[1].x0)) < 1e-6, "how far the detector grew a box, from the box");
  const tw = () => 20, th = 17, bounds = { x0: 0, y0: 0, x1: 400, y1: 400 };
  const spots = CT.tagSpots(lines, lines, tw, th, bounds, CT.unclipOf);
  const over = (r, b) => Math.max(0, Math.min(r.x + r.w, b.x1) - Math.max(r.x, b.x0)) * Math.max(0, Math.min(r.y + r.h, b.y1) - Math.max(r.y, b.y0));
  spots.forEach((s, i) => lines.forEach((l) => assert.strictEqual(over(s, l.letters), 0, "tag " + (i + 1) + " covers no letters of line " + l.n + ": " + JSON.stringify(s))));
  assert.deepStrictEqual([spots[0].x, spots[0].y], [lines[0].x0, lines[0].y0 - th], "the first line's tag above its first letter, as before");
  assert.ok(spots[1].x + spots[1].w <= lines[1].x0 + 1e-9 || spots[1].x >= lines[1].x1 - 1e-9, "the next lines' tags beside them: above, they sat on the line over them");
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) assert.strictEqual(over(spots[i], { x0: spots[j].x, y0: spots[j].y, x1: spots[j].x + spots[j].w, y1: spots[j].y + spots[j].h }), 0, "tags do not cover one another");
  // with no room anywhere, the place that covers least; always inside the picture
  const packed = [grown(0, 0, 400, 20, 1), grown(0, 25, 400, 45, 2), grown(0, 50, 400, 70, 3)];
  const tight = CT.tagSpots([packed[1]], packed, tw, th, { x0: 0, y0: -20, x1: 400, y1: 120 }, CT.unclipOf)[0];
  assert.ok(tight.x >= 0 && tight.x + tight.w <= 400 && tight.y >= -20 && tight.y + tight.h <= 120, "inside the picture");
  // a line at the picture's top: not above it
  const top = CT.tagSpots([grown(50, 2, 150, 22, 1)], [grown(50, 2, 150, 22, 1)], tw, th, bounds, CT.unclipOf)[0];
  assert.ok(top.y >= 0, "a tag stays in the picture");
  // the reading's boxes (a vision model's: tight, nothing to take off): side by side, a tag left of the second sits on the first, so it goes elsewhere
  const buttons = [{ x0: 10, y0: 50, x1: 90, y1: 70, n: 1 }, { x0: 95, y0: 50, x1: 175, y1: 70, n: 2 }];
  const b = CT.tagSpots(buttons, buttons, tw, th, bounds)[1];
  assert.ok(over(b, { x0: 7, y0: 47, x1: 93, y1: 73 }) === 0, "a tag never touches another box where it has a free place: " + JSON.stringify(b));
}

// ---- an item's letters are its own lines' (not the other items' text inside its box) ----
{
  const w = 200, h = 80, d = new Uint8ClampedArray(w * h * 4).fill(255);
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([0, 0, 0, 255], (y * w + x) * 4); };
  for (let x = 20; x < 60; x += 6) rect(x, 30, x + 4, 40); // (its own words)
  for (let x = 70; x < 110; x += 6) rect(x, 30, x + 4, 40); // (the next bubble's, close on the same row)
  const box = { x0: 10, y0: 25, x1: 120, y1: 45 }; // (a box the reading made over both)
  const both = CT.letters(d, w, h, box);
  assert.ok(both.mask[35 * w + 22] && both.mask[35 * w + 72], "with nothing said: everything in the box");
  const one = CT.letters(d, w, h, box, { own: [{ x0: 15, y0: 25, x1: 64, y1: 45 }], others: [{ x0: 66, y0: 25, x1: 114, y1: 45 }] });
  assert.ok(one.mask[35 * w + 22] && one.mask[35 * w + 56], "its own words");
  assert.ok(!one.mask[35 * w + 72] && !one.mask[35 * w + 106], "not the next bubble's, though they are in its box and beside its words");
  assert.deepStrictEqual([one.bbox.x0, one.bbox.x1], [20, 60]);
}

// ---- big bold letters on a gradient: the paper is what is round them, not their own colour (the commonest in a tight box) ----
{
  // a see-through bubble shaded 190 to 250 across, three bold black letters with a hole each (ㅁ), nearly all of the box: black is its commonest colour
  const w = 120, h = 80, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.round(190 + x / 2); d.set([v, v, v, 255], (y * w + x) * 4); }
  const isStroke = (x, y) => y >= 32 && y < 48 && [24, 50, 76].some((l) => x >= l && x < l + 20 && !(x >= l + 6 && x < l + 14 && y >= 38 && y < 42));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isStroke(x, y)) d.set([0, 0, 0, 255], (y * w + x) * 4);
  const got = CT.letters(d, w, h, { x0: 22, y0: 31, x1: 98, y1: 49 });
  assert.ok(got.paper[0] > 150, "the paper is the shade round the letters, not their black: " + got.paper);
  assert.ok(got.mask[33 * w + 25] && got.mask[45 * w + 60] && got.mask[35 * w + 95], "the letters' strokes are what is taken out (not only the holes in them)");
  assert.deepStrictEqual(got.bbox, { x0: 24, y0: 32, x1: 96, y1: 48 });
  assert.ok(!got.mask[10 * w + 60], "not the bubble round them");
}

// ---- letters touching art a shade off the paper that runs to the region's edge (a cloud on a label under a title): with the item's lines, still its letters ----
{
  const w = 160, h = 90, d = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) d.set([110, 170, 220, 255], p * 4);
  for (let y = 44; y < h; y++) for (let x = 20; x < 60; x++) d.set([225, 245, 255, 255], (y * w + x) * 4); // (the cloud, under the first word and down to the edge)
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([10, 40, 90, 255], (y * w + x) * 4); };
  for (let x = 30; x < 130; x += 12) rect(x, 30, x + 8, 46);
  const line = { x0: 28, y0: 28, x1: 132, y1: 48 };
  const got = CT.letters(d, w, h, line, { own: [line], others: [] });
  assert.ok(got.mask[38 * w + 33] && got.mask[38 * w + 123], "the first word, on the cloud, as well as the last");
  assert.ok(!got.mask[85 * w + 40], "not the cloud far from the line");
}

// ---- where the text is, from a vision model: a chunk's request, its boxes on the strip (only those whose middle is in the chunk's core) ----
{
  const glm = CT.findBody("data:image/jpeg;base64,AA", { model: "z-ai/glm-5.3-flash", from: "Korean" });
  assert.strictEqual(glm.model, "z-ai/glm-5.3-flash");
  assert.ok(!glm.response_format, "GLM is not told the format (it answers no JSON then)");
  assert.ok(/part of a Korean comic/.test(glm.messages[0].content[0].text) && glm.messages[0].content[1].image_url.url === "data:image/jpeg;base64,AA");
  assert.deepStrictEqual(CT.findBody("x", { model: "google/gemini-3.5-flash-lite" }).response_format, { type: "json_object" });
  const list = [{ y0: 0, y1: 1000 }, { y0: 800, y1: 1800 }]; // (the core of the first: 0 to 900)
  const answer = { choices: [{ message: { content: "```json\n" + JSON.stringify({ items: [
    { x0: 100, y0: 100, x1: 500, y1: 200, kind: "speech" }, // y 100-200: in the core
    { x0: 0, y0: 880, x1: 300, y1: 990 }, // middle at y 935: the next chunk's
    { x0: 500, y0: 10, x1: 400, y1: 50 }, // backwards: left out
    { x0: "a", y0: 1, x1: 2, y1: 3 }
  ] }) + "\n```" } }] };
  assert.deepStrictEqual(CT.boxesOf(answer, list, 0, 690), [{ x0: 69, y0: 100, x1: 345, y1: 200 }], "the box on the strip, by the chunk's width and height");
  assert.deepStrictEqual(CT.boxesOf({ choices: [{ message: { content: "no" } }] }, list, 0, 690), [], "an unreadable answer: no boxes");
}

// ---- the drawing taken back only where it changed the page ----
{
  const w = 120, h = 60, N = w * h;
  const page = () => { const d = new Uint8ClampedArray(N * 4).fill(255); return d; };
  const paint = (d, x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([v, v, v, 255], (y * w + x) * 4); };
  const orig = page(), drawn = page();
  paint(orig, 0, 40, w, 42, 0); paint(drawn, 0, 41, w, 43, 0); // a line of the art, drawn one row lower: not a change
  paint(orig, 10, 10, 14, 20, 0); // an old letter, gone from the drawing
  paint(drawn, 80, 10, 85, 20, 0); // an English letter, where there was paper
  const bound = new Uint8Array(N).fill(1);
  const got = CT.changedPixels(orig, drawn, w, h, bound, { radius: 2, grow: 2 });
  assert.ok(got[15 * w + 11] && got[15 * w + 82], "the old letter and the new one are taken back");
  assert.ok(!got[41 * w + 60] && !got[42 * w + 30], "a line drawn a row off is not: the page's own stays");
  assert.ok(!got[30 * w + 40] && !got[5 * w + 100], "paper away from the letters stays");
  assert.ok(got[15 * w + 86] && !got[15 * w + 89],"the letters' soft edges (grown by 2), no further");
  const inRoom = new Uint8Array(N); // only the room round the new letter
  for (let y = 0; y < h; y++) inRoom.fill(1, y * w + 70, y * w + 100);
  const roomed = CT.changedPixels(orig, drawn, w, h, inRoom, { radius: 2, grow: 2 });
  assert.ok(roomed[15 * w + 82] && !roomed[15 * w + 11], "outside the room nothing is taken back");
  // a tall Japanese column (30 wide, 200 tall): the room is as wide as English needs (most of the height), a sound effect's bigger than a bubble's
  const tall = CT.roomsOf([{ x0: 200, y0: 50, x1: 230, y1: 250, kind: "speech" }], 500, 400, 0); // (room: 98 to 332 across)
  assert.ok(tall[150 * 500 + 110] && tall[150 * 500 + 320] && !tall[150 * 500 + 60] && !tall[150 * 500 + 400], "a tall column's room reaches about its height to each side");
  const flat = (kind) => CT.roomsOf([{ x0: 100, y0: 100, x1: 200, y1: 130, kind }], 400, 300, 0).reduce((a, b) => a + b, 0);
  assert.ok(flat("sfx") > flat("speech"), "a sound effect's room is larger");
}

// ---- a drawing request an image model's providers will not take as it is ----
{
  // the picture sent: a PNG's header is all the ratio is read from (690 x 1000)
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(690, 16); head.writeUInt32BE(1000, 20);
  const url = "data:image/png;base64," + head.toString("base64") + "AAAA";
  assert.ok(Math.abs(CT.pngRatio(url) - 0.69) < 1e-9, "a PNG's ratio, from its header");
  assert.strictEqual(CT.pngRatio("data:image/jpeg;base64,AAAA"), 0, "not a PNG: none");
  const send = { model: "m", prompt: "p", input_references: [{ type: "image_url", image_url: { url } }], aspect_ratio: "auto", resolution: "1K", quality: undefined };
  // the model's providers take no picture in (Krea 2 Large, as OpenRouter said): the request cannot be made to fit, and it is said so
  const krea = 'No provider for krea/krea-2-large supports the requested parameter(s): resolution "1K", aspect_ratio "auto", input_references (1 items). Provider rejections: Krea: aspect_ratio: not supported. Accepted: 1:1, 4:3, 3:2, 16:9, 4:5, 2:3, 9:16';
  assert.deepStrictEqual(CT.fitDraw(send, krea), { unsupported: "cannot draw on a picture (it takes no picture in)" }, "a model whose providers refuse input_references cannot draw on a picture");
  // another model that takes the picture but not "auto" or 1K: the resolution left out, the nearest ratio of the ones it lists (690 x 1000 is nearest to 2:3)
  const ratio = 'No provider for x/y supports the requested parameter(s): resolution "1K", aspect_ratio "auto". Provider rejections: P: aspect_ratio: not supported. Accepted: 1:1, 4:3, 3:2, 16:9, 4:5, 2:3, 9:16';
  const fit = CT.fitDraw(send, ratio);
  assert.ok(fit && fit.body && !("resolution" in fit.body) && fit.body.aspect_ratio === "2:3" && fit.body.input_references === send.input_references && fit.body.prompt === "p", JSON.stringify(fit && fit.body && { ...fit.body, input_references: "..." }));
  assert.strictEqual(send.aspect_ratio, "auto", "the request it was given is not changed");
  // no list of ratios given: the ratio is left out (the model's own default)
  const bare = CT.fitDraw(send, 'No provider for x/y supports the requested parameter(s): aspect_ratio "auto"');
  assert.ok(bare && bare.body && !("aspect_ratio" in bare.body) && bare.body.resolution === "1K");
  assert.strictEqual(CT.fitDraw(send, "Your request was rejected by the safety system"), null, "another error: not this");
  assert.strictEqual(CT.fitDraw({ prompt: "p", input_references: send.input_references }, 'No provider for x/y supports the requested parameter(s): resolution "1K"'), null, "nothing of what it refuses was sent: nothing to change");
}

// ---- a refused part is tried again in two parts only so many times ----
{
  const items = [0, 1, 2, 3].map((i) => ({ y0: i * 100, y1: i * 100 + 50, x0: 0, x1: 100, en: "x", text: "y" }));
  const whole = { y0: 0, y1: 400, cy0: 0, cy1: 400, items };
  assert.strictEqual(CT.MAX_RETRIES, 3, "three retries a part");
  assert.strictEqual(CT.splitsAgain(whole), true, "a part with several items is tried again in two");
  const halves = CT.halvesOf(whole, 100, 1000);
  assert.deepStrictEqual(halves.map((h) => h.depth), [1, 1], "each half knows it has been tried again once");
  assert.deepStrictEqual(CT.halvesOf(halves[1], 100, 1000).map((h) => h.depth), [2, 2], "and each of theirs twice");
  assert.strictEqual(CT.splitsAgain({ ...whole, depth: 2 }), true, "the third retry is allowed");
  assert.strictEqual(CT.splitsAgain({ ...whole, depth: 3 }), false, "after the third it is given up: left as it was");
  assert.strictEqual(CT.splitsAgain({ ...whole, depth: 3 }, 5), true, "a caller may allow more");
  assert.strictEqual(CT.splitsAgain(whole, 0), false, "or none");
  assert.strictEqual(CT.splitsAgain({ ...whole, items: [items[0]] }), false, "one item cannot be split: left as it was");
}

// ---- how big the old letters were: by a line's height across, by a column's width down the page ----
{
  const w = 140, h = 260, data = new Uint8ClampedArray(w * h * 4).fill(255);
  const square = (x, y, n) => { for (let j = y; j < y + n; j++) for (let i = x; i < x + n; i++) data.set([0, 0, 0, 255], (j * w + i) * 4); };
  // set down the page: two columns of seven glyphs stacked (10 px glyphs 22 px apart), the columns 26 px apart
  for (let c = 0; c < 2; c++) for (let k = 0; k < 7; k++) square(40 + c * 26, 30 + k * 22, 10);
  const tall = CT.letters(data, w, h, { x0: 30, y0: 20, x1: 90, y1: 185 });
  assert.strictEqual(tall.columns, 2, "two columns of letters");
  assert.strictEqual(tall.lines, 7, "seven glyphs down each");
  const t = CT.letterSize(tall, 1);
  assert.ok(t.vertical, "a tall narrow box of stacked glyphs is text set down the page");
  assert.ok(t.size < 20 && t.size > 14, "its size is a column's width, not the box's height (which sized it at 48): " + t.size);
  // across the page: three lines of five letters
  const flat = new Uint8ClampedArray(w * h * 4).fill(255);
  const sq2 = (x, y, n) => { for (let j = y; j < y + n; j++) for (let i = x; i < x + n; i++) flat.set([0, 0, 0, 255], (j * w + i) * 4); };
  for (let r = 0; r < 3; r++) for (let k = 0; k < 5; k++) sq2(30 + k * 20, 40 + r * 30, 10);
  const wide = CT.letters(flat, w, h, { x0: 20, y0: 30, x1: 130, y1: 130 });
  const n = CT.letterSize(wide, 3);
  assert.ok(!n.vertical, "lines across are not taken for columns");
  assert.ok(Math.abs(n.size - Math.min(48, ((wide.bbox.y1 - wide.bbox.y0) / 3) * 0.95)) < 1e-9, "their size is by a line's height, as before");
}

// ---- the old letters taken out of the art: filled from what is round them, nothing else changed ----
{
  const w = 16, h = 12, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 12, 100, 200 - x * 8, 255], (y * w + x) * 4); // (art: a gradient across)
  const was = new Uint8ClampedArray(data), mask = new Uint8Array(w * h);
  for (let y = 4; y < 8; y++) for (let x = 6; x < 10; x++) { mask[y * w + x] = 1; data.set([0, 0, 0, 255], (y * w + x) * 4); } // (a black letter over it)
  CT.fillMasked(data, w, h, mask);
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) assert.deepStrictEqual([...data.slice(p * 4, p * 4 + 4)], [...was.slice(p * 4, p * 4 + 4)], "a pixel outside the mask is not touched");
    else {
      const x = p % w, r = data[p * 4];
      assert.ok(r >= 5 * 12 - 1 && r <= 10 * 12 + 1 && data[p * 4 + 3] === 255, "a filled pixel is within what was beside it, not the letter's black: " + r);
    }
  }
  assert.ok(data[5 * w * 4 + 7 * 4] < data[5 * w * 4 + 9 * 4] + 1, "and the gradient goes on across the filled part");
  const none = new Uint8ClampedArray(w * 4 * 2).fill(7);
  CT.fillMasked(none, w, 2, new Uint8Array(w * 2).fill(1)); // (nothing known to fill from: left as it is, no loop)
  assert.strictEqual(none[0], 7);
}

// ---- the English fitted to a box: balanced lines, the largest size that fits ----
{
  const widths = [60, 20, 20, 20, 20, 60], space = 4, maxW = 90;
  const lines = CT.balancedLines(widths, space, maxW);
  const flat = lines.flat();
  assert.deepStrictEqual(flat, [0, 1, 2, 3, 4, 5], "every word, in order");
  const wide = (ix) => ix.reduce((t, i) => t + widths[i], 0) + space * (ix.length - 1);
  assert.ok(lines.every((ix) => wide(ix) <= maxW), "no line wider than the box");
  // greedy: as many as fit on a line
  const greedy = []; let cur = [];
  widths.forEach((w, i) => { if (cur.length && wide(cur.concat(i)) > maxW) { greedy.push(cur); cur = []; } cur.push(i); });
  greedy.push(cur);
  const slack = (ls) => ls.slice(0, -1).reduce((t, ix) => t + (maxW - wide(ix)) ** 2, 0);
  assert.ok(slack(lines) <= slack(greedy), "no more ragged than greedy wrapping: " + slack(lines) + " vs " + slack(greedy));
  assert.strictEqual(CT.balancedLines([100], 4, 90), null, "a word wider than the box: none");
  assert.deepStrictEqual(CT.balancedLines([], 4, 90), null, "no words: none");

  const measure = (t, size) => t.length * size * 0.6;
  const words = "MORE THAN ANYTHING THEY WILL SUSPECT US OF SPYING ON AND SECRETLY TAKING PICTURES".split(" ");
  const big = CT.fitBoxText(words, 296, 532, measure, 10, 44), small = CT.fitBoxText(words, 120, 140, measure, 10, 44);
  assert.ok(big && big.size >= 28, "a large box gets a large size (it fills the area): " + (big && big.size));
  assert.ok(big.lines.length * big.size * big.lead <= 532 && big.lines.every((l) => measure(l, big.size) <= 296), "and its lines fit the box");
  assert.ok(!small || small.size < big.size, "a small box gets a smaller one");
  assert.strictEqual(CT.fitBoxText(words, 40, 30, measure, 10, 44), null, "a box that cannot hold it at the smallest size: none");
  assert.ok(CT.fitBoxText(["HI"], 200, 100, measure, 10, 44).size === 44, "a short text is no bigger than the largest size");
}

// ---- bubbles kept off one another: the small ones move little, the big ones most ----
{
  const overlaps = (a, b, gap = 0) => Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2) + gap > 0 && Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2) + gap > 0;
  const bounds = { w: 1000, h: 1000 };
  // a big box and a small one on each other: both move, the big one more
  const big = { cx: 300, cy: 300, w: 300, h: 300, m: 1 }, small = { cx: 400, cy: 300, w: 60, h: 60, m: 0.1 };
  CT.separateBoxes([big, small], bounds);
  assert.ok(!overlaps(big, small), "no longer on one another");
  const gave = (box, x, y) => Math.hypot(box.cx - x, box.cy - y);
  assert.ok(gave(big, 300, 300) > gave(small, 400, 300) * 3 && gave(small, 400, 300) > 0, "the big one gave most (the small one a little): " + gave(big, 300, 300) + " vs " + gave(small, 400, 300));
  // one that does not move (the text left where it was) stays, the other gets out of its way
  const fixed = { cx: 500, cy: 500, w: 100, h: 100, m: 0 }, mover = { cx: 540, cy: 500, w: 100, h: 100, m: 0.5 };
  CT.separateBoxes([fixed, mover], bounds);
  assert.deepStrictEqual([fixed.cx, fixed.cy], [500, 500], "a fixed box stays");
  assert.ok(!overlaps(fixed, mover), "and the other is out of its way");
  // held by its reach: it cannot move, so the more mobile box is cut back instead
  const a = { cx: 200, cy: 200, w: 200, h: 200, m: 1, reach: { x0: 100, x1: 300, y0: 100, y1: 300 } }, b = { cx: 330, cy: 200, w: 200, h: 200, m: 0.2, reach: { x0: 230, x1: 430, y0: 100, y1: 300 } };
  CT.separateBoxes([a, b], bounds);
  assert.ok(!overlaps(a, b), "held in place, the boxes are cut back until they are apart: " + JSON.stringify([a, b].map((x) => [x.cx, x.w])));
  assert.ok(a.w < 200, "the more mobile one gave up its edge");
  // boxes apart are not touched
  const far1 = { cx: 100, cy: 100, w: 50, h: 50, m: 1 }, far2 = { cx: 800, cy: 800, w: 50, h: 50, m: 1 };
  CT.separateBoxes([far1, far2], bounds);
  assert.deepStrictEqual([far1.cx, far1.cy, far2.cx, far2.cy], [100, 100, 800, 800], "boxes apart stay put");
}

// ---- the pictures whose text was not read: the reading's skipped parts, by the pictures their rows reach (a picture of another width scaled to the strip's) ----
{
  const sizes = [{ width: 100, height: 200 }, { width: 100, height: 200 }, { width: 100, height: 200 }, { width: 200, height: 400 }, { width: 100, height: 200 }];
  const skip = (...parts) => ({ skipped: parts.map(([y0, y1, why]) => ({ y0, y1, why })) });
  assert.strictEqual(CT.unreadOf(sizes, skip()), "", "all read: nothing");
  assert.strictEqual(CT.unreadOf(sizes, skip([0, 100, "draw: refused"])), "", "a part not drawn is not one not read");
  assert.strictEqual(CT.unreadOf(sizes, skip([210, 390, "read: the reading came back empty"])), "2", "within one picture");
  assert.strictEqual(CT.unreadOf(sizes, skip([210, 390, "read: x"], [600, 800, "read: y"])), "2, 4", "two apart");
  assert.strictEqual(CT.unreadOf(sizes, skip([210, 610, "read: x"], [800, 1000, "read: y"])), "2–5", "runs joined into one range");
}

// ---- the lines kept: "not drawn" only for what nothing lettered or drew, not for a bubble lettered here whose rows a part sent to the model shares ----
{
  const sizes = [{ width: 100, height: 400 }];
  const it = (en, y0, y1, method, more) => ({ text: "x", en, kind: "speech", x0: 0, x1: 50, y0, y1, method, ...more });
  const r = { skipped: [{ y0: 100, y1: 300, why: "draw: no model asked (none in the rules, or Lettered here is first)" }],
    items: [it("Here", 120, 160, "lettered here"), it("Over", 150, 250, "patch", { fallback: true, kind: "narration" }), it("Boom", 200, 280, "not drawn", { kind: "sfx" }), it("Same", 10, 20, "kept", { keep: true })] };
  const lines = CT.linesOf(sizes, r);
  assert.deepStrictEqual(lines.map((l) => [l.en, !!l.notDrawn]), [["Here", false], ["Over", false], ["Boom", true]], "only what was left is not drawn: " + JSON.stringify(lines));
  // (an answer without methods: the rows of the parts not drawn say it, as before)
  const old = { skipped: r.skipped, items: [it("Left", 120, 160), it("Away", 320, 360)] };
  assert.deepStrictEqual(CT.linesOf(sizes, old).map((l) => !!l.notDrawn), [true, false], "no methods: by the rows");
}

// ---- the prompts the person can change (Settings › Translation › Comics) ----
{
  const first = (body) => body.messages[0].content[0].text;
  const lineList = [[{ n: 1, box_2d: [0, 0, 10, 10] }]];
  const opts = { from: "Korean", into: "French" };
  // the built-in prompts are the ones listed to start from, and in use when nothing is picked
  assert.deepStrictEqual(Object.keys(CT.PROMPT_PRESETS), ["comicFind", "comicRead", "comicDraw"]);
  for (const k of Object.keys(CT.PROMPT_PRESETS)) assert.strictEqual(CT.PROMPT_PRESETS[k][0].id, "default");
  assert.strictEqual(first(CT.markedReadBody(["u"], lineList, { ...opts, prompts: {} })), first(CT.markedReadBody(["u"], lineList, opts)), "no prompt picked: the built-in one");
  assert.ok(first(CT.markedReadBody(["u"], lineList, opts)).startsWith(CT.PROMPT_PRESETS.comicRead[0].text.replace("{count}", "1").replace("{comic}", "Korean comic").split("{kind}")[0]), "the built-in text is what is sent");
  // promptsFrom: the person's own text, only where one other than the default is in use
  const sets = { comicFind: { active: "pa", mine: [{ id: "pa", name: "A", text: "Find {comic}." }] }, comicRead: { active: "default", mine: [{ id: "pb", name: "B", text: "x" }] }, comicDraw: { active: "gone", mine: [] } };
  assert.deepStrictEqual(CT.promptsFrom(sets), { find: "Find {comic}." });
  assert.deepStrictEqual(CT.promptsFrom(undefined), {});
  // an edited reading prompt: its words and placeholders, then everything the parser depends on
  const read = first(CT.markedReadBody(["u"], lineList, { ...opts, glossary: [{ source: "a", en: "b" }], cast: ["Kim"], reference: "the novel", prompts: { read: "Read these {count} pages of a {comic}. Answer in {language}." } }));
  assert.ok(read.startsWith("Read these 1 pages of a Korean comic. Answer in French."), "the edited text, filled in: " + read);
  assert.ok(read.includes('- "kind": "speech"') && read.includes("outside any bubble"), "KIND_RULE is added when the text has no {kind}");
  for (const f of ['- "lines":', '- "text":', '- "en": the French translation', '- "not_text"']) assert.ok(read.includes(f), "the field the parser reads is added: " + f);
  assert.ok(read.includes("a = b") && read.includes("Kim") && read.includes("the novel"), "the glossary, the cast and the novel's translation");
  assert.ok(read.endsWith('Answer with JSON only: {"items": [...], "not_text": [...], "terms": [...]}'), "the answer's format ends it");
  // a text that names the fields itself is not given them twice; {kind} puts the rule where it is
  const named = first(CT.markedReadBody(["u"], lineList, { prompts: { read: 'Items have "lines", "text" and "en".\n{kind}\nDone.' } }));
  assert.strictEqual(named.split('- "lines":').length, 1, "no field line when the text names it");
  assert.ok(named.indexOf("outside any bubble") < named.indexOf("Done."), "the rule is where {kind} was");
  assert.strictEqual(named.split("outside any bubble").length, 2, "and only once");
  // boxes on no writing (a drawn leaf the finder boxed) have a list of their own, in the built-in text and added to a person's own
  const builtIn = first(CT.markedReadBody(["u"], lineList, opts));
  assert.ok(/"not_text"/.test(builtIn) && /never write a word for what a drawing shows/i.test(builtIn) && /never copy its number into "text"/.test(builtIn), "the built-in prompt: not_text, no word for a drawing, no tag in the text");
  assert.strictEqual(builtIn.split('- "not_text"').length, 2, "its field line once");
  assert.ok(builtIn.endsWith('Answer with JSON only: {"items": [...], "not_text": [...], "terms": [...]}'), "the answer's shape has it");
  assert.ok(/- "not_text" \(beside "items"\)/.test(named), "a person's own prompt that does not name it gets its line");
  // the plain method's reading prompt
  const plain = first(CT.readBody(["u"], { ...opts, prompts: { readPlain: "Plain {comic}." } }));
  assert.ok(plain.startsWith("Plain Korean comic.") && plain.includes('- "box_2d":') && plain.includes('- "p":') && plain.includes('- "en": the French translation'), "plain: the fields are added too");
  // where the text is: the text, the scale when it is not named, and the answer's format
  const find = (prompts) => first(CT.findBody("x", { from: "Korean", prompts, model: "google/gemini-3.5-flash-lite" }));
  assert.ok(find({ find: "Box the text in a {comic}." }).startsWith('Box the text in a Korean comic.\nGive "x0"'), "the scale is added");
  assert.ok(find({ find: "Box it on a 0-1000 scale." }).split("0-1000").length === 2, "and not twice when the text has one");
  assert.ok(find({ find: "x" }).endsWith('Answer with JSON only: {"items": [{"x0": 0, "y0": 0, "x1": 0, "y1": 0, "kind": "", "text": ""}]}'));
  assert.strictEqual(find(undefined), CT.findPrompt("Korean"), "none picked: the built-in prompt");
  // drawing: the text, then the list of what to put in, always
  const sec = { y0: 0, y1: 500, items: [{ y0: 10, y1: 60, x0: 5, x1: 50, kind: "speech", text: "하", en: "Ha" }] };
  const draw = CT.drawBody(sec, "p", { width: 100, from: "Korean", into: "French", prompt: "Put {language} in this {comic} ({count} text)." }).prompt;
  assert.ok(draw.startsWith("Put French in this Korean comic (1 text).\n1. top left, speech bubble:") && draw.includes('"Ha"'), draw);
  assert.strictEqual(CT.drawBody(sec, "p", { width: 100, style: "list", prompt: "ignored" }).prompt.split("\n")[0], "Translate the image with this:", "the plain list style keeps its own words");
}

console.log("comic-translate: ok");
