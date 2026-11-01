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

console.log("comic-translate: ok");
