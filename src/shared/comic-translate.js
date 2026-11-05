// A chapter of pictures translated in its pictures: the text read off them by a vision model (where it is, the English, who says it, the names in it),
// each part of the strip that has text drawn again by an image model with the English in place, and the strip cut back into the site's own pictures.
// Design, and the tests on a real chapter it comes from: docs/COMICS.md. The requests are made by the caller (`ask`: who pays is theirs to say); this file
// builds them and reads the answers. The site's pictures are not pages (a site may cut its strip anywhere, through a bubble): the chapter is one strip.
//
//   flatRows(data, width, height)         how much of each row of one picture is one colour, 0-100 (data: RGBA, as ImageData.data)
//   gutters(flat, width)                  the runs [y0, y1) of blank rows the strip can be cut in (at least GUTTER of the width tall)
//   chunks(flat, width)                   the strip cut for reading: [{ y0, y1, cut: "gutter" | "hard" | "end" }], MIN_CHUNK to MAX_CHUNK widths each; where the
//                                         art runs on with no gutter, at the quietest row, and the next chunk starts OVERLAP of the width earlier
//   readBody(pictures, opts)              the request that reads up to READ_BATCH chunks (data: URLs): OpenRouter chat completions, a JSON answer
//   readItems(answer, chunks, ids, width) the answer's text items in strip coordinates, each kept once (from the chunk whose core holds its centre): { items, terms }
//   tilesOf(W, H) / detectInput(rgba, size) / linesOfTile(map, size, scale, top, W, h, ends) / mergeLines(lines)   the "full" method's text detector: the
//                                         strip's square tiles, a tile as PaddleOCR's detector takes it, the lines its map shows, every tile's lines as one list
//   linesIn(chunks, k, lines, width) / markedReadBody(pictures, marked, opts) / readMarked(answer, chunks, ids, width, lines, used)   reading the detector's
//                                         numbered lines: the lines a chunk shows, the request, its items (where their lines are; text with no line where drawn)
//   sections(flat, width, items)          the parts of the strip to draw again: whole gutter-to-gutter spans holding text, joined up to MAX_CHUNK widths, cut
//                                         at a row no box crosses when one span is taller; [{ y0, y1 (taken back), cy0, cy1 (sent: at least MIN_DRAW), items }]
//   partOf(items, section, width, H) / halvesOf(section, width, H)   some of a section's items drawn on their own (a section refused as a whole: in two)
//   drawBody(section, picture, opts)      the request that draws one section with its items in English: OpenRouter's images API
//   drawnOf(answer)                       the picture an images API answer holds (a data: URL), or ""
//   letters(data, w, h, box)              an item's letters in the pixels around it: are they on one flat colour (plain), that colour, theirs, which pixels
//                                         are letters (mask) and the bubble's inside (area)
//   layout(area, w, h, centre, words, measure, opts)   the English in lines that follow the bubble's shape, at the largest size that fits
//   Strip.of(sources)                     (a browser) the pictures one under another at one width: width, height, heights, flat(), crop(y0, y1) -> canvas,
//                                         touches(i, drawn), picture(i, drawn) -> Blob (each drawn piece over the original, through its mask)
//   translate(sources, opts)              (a browser) all of it -> { pictures: [Blob | null], items, terms, cost, skipped, lettered }. opts.method: "tiers" (the
//                                         default: plain items lettered here, the rest drawn and taken back only around them), "full" (the same, where the text is from a text
//                                         detector the caller runs: opts.detect(rgba, size) -> its map; or from a vision model, opts.findModel, asked as ask("find", findBody))
//                                         or "all-flux"
//   findBody(picture, { model, from }) / boxesOf(answer, list, k, width)   where the text is, from a vision model: a chunk's request, and its boxes on the strip
//   linesOf(sizes, r)                     what a translated chapter keeps of translate's answer: its lines, each with its picture and its box there (the overlay)
(function (root) {
  const READ_MODEL = "google/gemini-3.5-flash-lite";
  // GPT Image 2.5 Flare at medium spells what it is given right (FLUX 3 Image Klein, "black-forest-labs/flux-3-image-klein", misspelt names) at about 1.6x the
  // drawing cost: docs/COMICS.md
  const DRAW_MODEL = "openai/gpt-image-2.5-flare", DRAW_QUALITY = "medium";
  const BLANK = 99; // a row is blank when this much of it (in %) is one colour
  const TOLERANCE = 24; // how far from that colour a pixel may be, per channel
  const GUTTER = 0.04; // a gutter: blank rows at least this much of the width tall
  const MIN_CHUNK = 0.6, MAX_CHUNK = 2.2, OVERLAP = 0.5; // in widths
  const READ_BATCH = 10; // chunks in one reading request (36 in one request skipped most of the text)
  const MIN_DRAW = 256; // the smallest side the image model takes
  const DRAW_AT_ONCE = 3;
  const FIND_AT_ONCE = 4; // (where the text is from a vision model: a chunk a request)

  // ---------- where the strip can be cut ----------
  function flatRows(data, width, height) {
    const out = new Array(height);
    for (let y = 0; y < height; y++) {
      const o = y * width * 4;
      // the row's commonest colour among 16 samples, in steps of 16
      const counts = new Map();
      let best = 0, n = 0;
      for (let s = 0; s < 16; s++) {
        const i = o + Math.floor(((s + 0.5) * width) / 16) * 4;
        const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        const c = (counts.get(k) || 0) + 1;
        counts.set(k, c);
        if (c > n) { n = c; best = k; }
      }
      const r = (best >> 8) * 16 + 8, g = ((best >> 4) & 15) * 16 + 8, b = (best & 15) * 16 + 8;
      let ok = 0;
      for (let i = o; i < o + width * 4; i += 4) if (Math.abs(data[i] - r) < TOLERANCE && Math.abs(data[i + 1] - g) < TOLERANCE && Math.abs(data[i + 2] - b) < TOLERANCE) ok++;
      out[y] = Math.round((ok / width) * 100);
    }
    return out;
  }

  function gutters(flat, width) {
    const min = Math.round(width * GUTTER);
    const runs = [];
    for (let y = 0; y < flat.length; ) {
      if (flat[y] >= BLANK) {
        let e = y;
        while (e < flat.length && flat[e] >= BLANK) e++;
        if (e - y >= min) runs.push([y, e]);
        y = e;
      } else y++;
    }
    return runs;
  }

  // the quietest row in [from, to] (the most of it one colour, with its neighbours), the later one on a tie; `ok(y)` may rule rows out
  function quietest(flat, from, to, ok) {
    let best = -1, score = -1;
    for (let y = Math.floor(to); y >= Math.ceil(from); y--) {
      if (ok && !ok(y)) continue;
      const s = (flat[y] || 0) + (flat[y - 1] || 0) + (flat[y + 1] || 0);
      if (s > score) { score = s; best = y; }
    }
    return best;
  }

  function chunks(flat, width) {
    const H = flat.length;
    const runs = gutters(flat, width);
    const minH = Math.round(width * MIN_CHUNK), maxH = Math.round(width * MAX_CHUNK), overlap = Math.round(width * OVERLAP);
    const out = [];
    let y0 = 0;
    while (y0 < H) {
      if (H - y0 <= maxH) { out.push({ y0, y1: H, cut: "end" }); break; }
      const lo = y0 + minH, hi = y0 + maxH;
      // a gutter that reaches into the window: any of its rows is a clean cut; the longest (up to 200 rows: longer is no cleaner), the later on a tie
      const reach = runs.filter(([a, b]) => b > lo && a < hi);
      if (reach.length) {
        reach.sort((p, q) => Math.min(q[1] - q[0], 200) - Math.min(p[1] - p[0], 200) || q[0] - p[0]);
        const [a, b] = reach[0];
        const cut = Math.min(hi, Math.max(lo, Math.round((a + b) / 2)));
        out.push({ y0, y1: cut, cut: "gutter" });
        y0 = cut;
      } else {
        const cut = quietest(flat, y0 + maxH * 0.66, hi);
        out.push({ y0, y1: cut, cut: "hard" });
        y0 = cut - overlap;
      }
    }
    return out;
  }

  // the rows of a chunk whose items are kept from it: between the middles of its overlaps with its neighbours
  function coreOf(list, k) {
    const c = list[k], prev = list[k - 1], next = list[k + 1];
    return [prev && prev.y1 > c.y0 ? (c.y0 + prev.y1) / 2 : c.y0, next && next.y0 < c.y1 ? (next.y0 + c.y1) / 2 : c.y1];
  }

  // ---------- reading ----------
  // the novel the comic adapts, the part this chapter tells (opts.reference: its English translation's lines): where the comic says what the novel says, its wording
  const referenceOf = (reference) => reference ? `\nThis comic adapts a novel. Below is the novel's own translation of this part of the story: where a line of the comic says what the novel says, translate it as the novel does (its names, terms and wording); where the comic says something else, translate the comic.\n<<<\n${String(reference).slice(0, 40000)}\n>>>` : "";

  function readPrompt(count, { from, into, glossary, cast, reference }) {
    const terms = (glossary || []).filter((t) => t && t.source && t.en).slice(0, 300);
    const people = (cast || []).filter(Boolean).slice(0, 60);
    return `These ${count} pictures are consecutive parts of one chapter of a ${from ? from + " " : ""}comic, top to bottom (picture 1 is the top). Neighbouring pictures may overlap.
For every piece of text in every picture (speech bubbles, thought bubbles, narration boxes, text on screens, phones and signs, sound effects), return one item:
- "p": the picture number
- "box_2d": [ymin, xmin, ymax, xmax] on a 0-1000 scale of that picture: the whole bubble or box the text sits in (outline included); for text with no bubble, the text itself
- "kind": "speech" | "thought" | "narration" | "screen" | "sfx"
- "text": the original text exactly, line breaks as \\n
- "en": the ${into || "English"} translation, natural comic ${into || "English"}, about as long as the original so it fits the same bubble
- "speaker": who says it: a name if the chapter shows it, else a short description of the character ("the man in the suit"); null for narration, screens and sound effects
Text that appears in two overlapping pictures: give it in each picture where it is whole.
Also list "terms": names of people, places, skills, items, organisations and titles in the text, as {"source": the original, "en": the ${into || "English"} you used, "kind": "person|place|skill|item|organisation|title"}.` +
      (terms.length ? `\nUse these renderings wherever the original appears:\n${terms.map((t) => t.source + " = " + t.en).join("\n")}` : "") +
      (people.length ? `\nCharacters already met in this chapter (use the same names for them): ${people.join(", ")}` : "") + referenceOf(reference) +
      `\nAnswer with JSON only: {"items": [...], "terms": [...]}`;
  }

  // pictures: data: URLs of the chunks, in order
  function readBody(pictures, opts = {}) {
    const content = [{ type: "text", text: readPrompt(pictures.length, opts) }];
    pictures.forEach((url, i) => content.push({ type: "text", text: "Picture " + (i + 1) + ":" }, { type: "image_url", image_url: { url } })); // (unlabelled, a model miscounts them)
    return { model: opts.model || READ_MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" }, reasoning: { effort: "low" }, usage: { include: true } };
  }

  const KINDS = ["speech", "thought", "narration", "screen", "sfx"];
  function parseJson(text) {
    const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      return JSON.parse(t);
    } catch (e) {
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* below */ }
      return null;
    }
  }

  // answer: the chat completion (or its message text); ids: the chunk indexes it was asked about, in order
  function readItems(answer, list, ids, width) {
    const text = typeof answer === "string" ? answer : answer && answer.choices && answer.choices[0] && answer.choices[0].message ? answer.choices[0].message.content : "";
    const data = parseJson(text);
    if (!data || typeof data !== "object") throw new Error("the reading came back unreadable");
    const items = [];
    for (const it of Array.isArray(data.items) ? data.items : []) {
      const k = ids[Math.round(Number(it && it.p)) - 1];
      const c = list[k];
      const box = it && Array.isArray(it.box_2d) ? it.box_2d.flat(2).map(Number) : [];
      if (!c || box.length !== 4 || box.some((v) => !Number.isFinite(v)) || typeof it.text !== "string" || !it.text.trim()) continue;
      const h = c.y1 - c.y0;
      const [a, b, cc, d] = box.map((v) => Math.min(1000, Math.max(0, v)));
      if (cc <= a || d <= b) continue;
      const item = {
        y0: Math.round(c.y0 + (a / 1000) * h), y1: Math.round(c.y0 + (cc / 1000) * h), x0: Math.round((b / 1000) * width), x1: Math.round((d / 1000) * width),
        kind: KINDS.includes(it.kind) ? it.kind : "speech", text: it.text.trim(), en: String(it.en || "").trim(), speaker: typeof it.speaker === "string" && it.speaker.trim() ? it.speaker.trim() : null
      };
      const [top, bottom] = coreOf(list, k), mid = (item.y0 + item.y1) / 2;
      if (mid >= top && mid < bottom) items.push(item);
    }
    const terms = (Array.isArray(data.terms) ? data.terms : []).filter((t) => t && typeof t.source === "string" && t.source.trim() && typeof t.en === "string" && t.en.trim())
      .map((t) => ({ source: t.source.trim(), en: t.en.trim(), kind: String(t.kind || "") }));
    return { items, terms };
  }

  // ---------- where the text is: a text detector (the "full" method) ----------
  // The reading's own boxes are guesses (too tight, too loose, a different set each run: docs/COMICS.md, "Where the text is"), so a text detector finds the
  // lines and the reading only says what they say. The caller runs the detector (opts.detect, as it sends ask): PaddleOCR's PP-OCRv4 mobile detector on
  // DETECT_SIZE square tiles, given detectInput's array, answering its map of how likely each pixel is text (0-255).
  const DETECT_SIZE = 960, DETECT_STEP = 0.75, DETECT_THRESHOLD = 0.3, UNCLIP = 1.5;
  const DETECT_UP = 2; // a narrow strip is enlarged at most this much (a 316 px strip blown up 3 times made every tile cost twice what it needed)
  // the tile's scale and the side of the square the detector is given: a multiple of 32, 960 for a strip 480 px wide or more
  const detectScale = (W) => Math.min(DETECT_SIZE / W, DETECT_UP);
  const detectSideOf = (W) => Math.min(DETECT_SIZE, Math.ceil((W * detectScale(W)) / 32) * 32);

  // the strip's square tiles: a width tall, three quarters of a width apart, the last ending at the strip's end
  function tilesOf(W, H) {
    const out = [], step = Math.max(1, Math.round(W * DETECT_STEP));
    for (let y = 0; ; y += step) {
      const y0 = Math.min(y, Math.max(0, H - W));
      out.push(y0);
      if (y0 + W >= H) break;
    }
    return out;
  }

  // a tile as the detector takes it: RGBA (size x size) -> 3 x size x size, blue, green, red, each less ImageNet's mean and over its spread
  function detectInput(rgba, size) {
    const n = size * size, out = new Float32Array(3 * n), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) out[c * n + p] = (rgba[p * 4 + 2 - c] / 255 - mean[c]) / std[c];
    return out;
  }

  // The lines one tile's map shows, in strip pixels: groups of pixels over the threshold, each grown as PaddleOCR grows a line (area x 1.5 / perimeter). A line
  // touching the tile's top or bottom is left to the tile beside it, which has it whole (not at the strip's own ends: ends.first, ends.last).
  // map: size x size, 0-255; scale: tile pixels a strip pixel; top: the tile's first strip row; W, h: the tile in strip pixels
  function linesOfTile(map, size, scale, top, W, h, ends = {}) {
    const cut = Math.round(DETECT_THRESHOLD * 255), seen = new Uint8Array(size * size), out = [], stack = [];
    const hPx = Math.min(size, Math.round(h * scale));
    for (let p0 = 0; p0 < size * size; p0++) {
      if (map[p0] <= cut || seen[p0]) continue;
      let x0 = size, x1 = 0, y0 = size, y1 = 0, n = 0;
      seen[p0] = 1; stack.push(p0);
      while (stack.length) {
        const p = stack.pop(), x = p % size, y = (p - x) / size;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const q of [x > 0 ? p - 1 : -1, x < size - 1 ? p + 1 : -1, y > 0 ? p - size : -1, y < size - 1 ? p + size : -1]) if (q >= 0 && !seen[q] && map[q] > cut) { seen[q] = 1; stack.push(q); }
      }
      if (n < 12 || (y0 <= 1 && !ends.first) || (y1 >= hPx - 2 && !ends.last)) continue;
      const sx0 = x0 / scale, sx1 = (x1 + 1) / scale, sy0 = top + y0 / scale, sy1 = top + (y1 + 1) / scale;
      const bw = sx1 - sx0, bh = sy1 - sy0, d = (bw * bh * UNCLIP) / (2 * (bw + bh));
      out.push({ x0: Math.max(0, Math.round(sx0 - d)), y0: Math.max(0, Math.round(sy0 - d)), x1: Math.min(W, Math.round(sx1 + d)), y1: Math.round(sy1 + d) });
    }
    return out;
  }

  // the lines of every tile as one list: a line mostly inside a bigger one already kept is the same line seen by two tiles; numbered top to bottom from 1
  function mergeLines(lines) {
    const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    const kept = [];
    for (const l of lines.slice().sort((a, b) => area(b) - area(a))) {
      const same = kept.some((k) => { const ix = Math.min(k.x1, l.x1) - Math.max(k.x0, l.x0), iy = Math.min(k.y1, l.y1) - Math.max(k.y0, l.y0); return ix > 0 && iy > 0 && ix * iy > 0.5 * area(l); });
      if (!same) kept.push(l);
    }
    return kept.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map((l, i) => ({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, n: i + 1 }));
  }

  // ---------- where the text is, from a vision model (opts.findModel: in place of the detector) ----------
  // Each reading chunk is sent alone; the model gives a tight box round each piece of text, which stands for a detector's line (docs/model-tests/comics/box-test.mjs:
  // GLM 5.3 FlashX boxed 96% of the detector's lines on episode 2, Gemini 3.5 Flash Lite 87%, GLM 5.3 Flash 47% and slowly, but it boxed the big brush sound effects).
  function findPrompt(from) {
    return `This picture is part of a ${from ? from + " " : ""}comic. Find every piece of text in it: speech and thought bubbles, narration boxes, text on screens and signs, and sound effects, including big stylised sound effects drawn as part of the art.
For each give "x0", "y0", "x1", "y1": a tight box round the text itself: left, top, right, bottom on a 0-1000 scale of the picture's width and height (x0 = 0 is the left edge, y0 = 0 the top); "kind": "speech" | "thought" | "narration" | "screen" | "sfx"; "text": the text as it is written.
Answer with JSON only: {"items": [{"x0": 0, "y0": 0, "x1": 0, "y1": 0, "kind": "", "text": ""}]}`;
  }
  function findBody(picture, opts = {}) {
    const model = opts.model || READ_MODEL;
    return { model, messages: [{ role: "user", content: [{ type: "text", text: findPrompt(opts.from) }, { type: "image_url", image_url: { url: picture } }] }], temperature: 0,
      ...(/glm|kimi/i.test(model) ? {} : { response_format: { type: "json_object" } }), usage: { include: true } }; // (GLM answers no JSON when told the format)
  }
  // a find answer's boxes on the strip: those whose middle is in chunk k's core (a box is in one chunk only)
  function boxesOf(answer, list, k, width) {
    const text = answer && answer.choices && answer.choices[0] && answer.choices[0].message ? answer.choices[0].message.content : "";
    const data = parseJson(text), c = list[k], h = c.y1 - c.y0, [top, bottom] = coreOf(list, k), out = [];
    for (const it of data && Array.isArray(data.items) ? data.items : []) {
      const v = ["x0", "y0", "x1", "y1"].map((n) => Math.min(1000, Math.max(0, Number(it && it[n]))));
      if (v.some((x) => !Number.isFinite(x)) || v[2] <= v[0] || v[3] <= v[1]) continue;
      const b = { x0: Math.round((v[0] / 1000) * width), y0: Math.round(c.y0 + (v[1] / 1000) * h), x1: Math.round((v[2] / 1000) * width), y1: Math.round(c.y0 + (v[3] / 1000) * h) };
      if ((b.y0 + b.y1) / 2 >= top && (b.y0 + b.y1) / 2 < bottom) out.push(b);
    }
    return out;
  }

  // the lines a chunk shows: those whose middle is in its core (so a line is shown in one chunk only), with their boxes on its 0-1000 scale
  function linesIn(list, k, lines, width) {
    const c = list[k], h = c.y1 - c.y0, [top, bottom] = coreOf(list, k);
    const at = (v, of) => Math.max(0, Math.min(1000, Math.round((v / of) * 1000)));
    return lines.filter((l) => (l.y0 + l.y1) / 2 >= top && (l.y0 + l.y1) / 2 < bottom)
      .map((l) => ({ n: l.n, box_2d: [at(l.y0 - c.y0, h), at(l.x0, width), at(l.y1 - c.y0, h), at(l.x1, width)] }));
  }

  function markedPrompt(count, { from, into, glossary, cast, reference }) {
    const terms = (glossary || []).filter((t) => t && t.source && t.en).slice(0, 300);
    const people = (cast || []).filter(Boolean).slice(0, 60);
    const lang = into || "English";
    return `These ${count} pictures are consecutive parts of one chapter of a ${from ? from + " " : ""}comic, top to bottom (picture 1 is the top). Neighbouring pictures may overlap.
A text finder has drawn a numbered box round each line of text it found (the tag "12" is line 12); each picture's lines are also listed after it with their box_2d [ymin, xmin, ymax, xmax] on a 0-1000 scale of that picture. A box may be on something that is not text: leave it out.
Return one item for every piece of text: a whole speech bubble, thought bubble or narration box, a screen's or sign's text, a sound effect:
- "lines": the numbers of the lines the piece's text is in, in reading order. Give each line to one item at most. A list (rows on a screen, a table, a menu) is one item for each row, never a whole column.
- "kind": "speech" | "thought" | "narration" | "screen" | "sfx"
- "text": the original text exactly, line breaks as \\n
- "en": the ${lang} translation, natural comic ${lang}, about as long as the original so it fits the same place
- "speaker": who says it: a name if the chapter shows it, else a short description of the character; null for narration, screens and sound effects
- "keep": true only for a watermark or the address of the site the pictures come from, and for text that is not words (a phone's clock or battery, numbers alone) or is already in ${lang}; never for the comic's own text (titles, screens, signs and buttons in the story are translated); else false
Text you see that has no box (sound effects drawn as art, lettering the finder missed): give it too, with "lines": [], "p": its picture number and "box_2d" round it on that picture's 0-1000 scale.
Also list "terms": names of people, places, skills, items, organisations and titles in the text, as {"source": the original, "en": the ${lang} you used, "kind": "person|place|skill|item|organisation|title"}.` +
      (terms.length ? `\nUse these renderings wherever the original appears:\n${terms.map((t) => t.source + " = " + t.en).join("\n")}` : "") +
      (people.length ? `\nCharacters already met in this chapter (use the same names for them): ${people.join(", ")}` : "") + referenceOf(reference) +
      `\nAnswer with JSON only: {"items": [...], "terms": [...]}`;
  }

  // pictures: data: URLs of the chunks with their lines drawn on; marked: each picture's lines (linesIn)
  function markedReadBody(pictures, marked, opts = {}) {
    const content = [{ type: "text", text: markedPrompt(pictures.length, opts) }];
    pictures.forEach((url, i) => content.push({ type: "text", text: "Picture " + (i + 1) + ":" }, { type: "image_url", image_url: { url } },
      { type: "text", text: "Lines in picture " + (i + 1) + ": " + (marked[i].length ? marked[i].map((l) => l.n + " " + JSON.stringify(l.box_2d)).join(", ") : "none") }));
    return { model: opts.model || READ_MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" }, reasoning: { effort: "low" }, usage: { include: true } };
  }

  // The answer's items: one with lines is where its lines are (their union; item.lines keeps each); one without is where the reading drew it, kept from the
  // chunk whose core holds its middle. used: the lines given to an item already (across requests), so a line is in one item only.
  function readMarked(answer, list, ids, width, lines, used = new Set()) {
    const text = typeof answer === "string" ? answer : answer && answer.choices && answer.choices[0] && answer.choices[0].message ? answer.choices[0].message.content : "";
    const data = parseJson(text);
    if (!data || typeof data !== "object") throw new Error("the reading came back unreadable");
    const byN = new Map(lines.map((l) => [l.n, l]));
    const items = [];
    for (const it of Array.isArray(data.items) ? data.items : []) {
      if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
      const base = { kind: KINDS.includes(it.kind) ? it.kind : "speech", text: it.text.trim(), en: String(it.en || "").trim(), speaker: typeof it.speaker === "string" && it.speaker.trim() ? it.speaker.trim() : null, keep: it.keep === true };
      const ns = (Array.isArray(it.lines) ? it.lines : []).map((v) => Number(String(v).replace(/^L/i, ""))).filter((n) => byN.has(n) && !used.has(n));
      if (ns.length) {
        const ls = ns.map((n) => byN.get(n));
        ns.forEach((n) => used.add(n));
        items.push({ x0: Math.min(...ls.map((l) => l.x0)), y0: Math.min(...ls.map((l) => l.y0)), x1: Math.max(...ls.map((l) => l.x1)), y1: Math.max(...ls.map((l) => l.y1)),
          ...base, lines: ls.map(({ x0, y0, x1, y1, n }) => ({ x0, y0, x1, y1, n })), located: true });
        continue;
      }
      if (Array.isArray(it.lines) && it.lines.length) continue; // (only lines given to another item already: a repeat)
      const k = ids[Math.round(Number(it.p)) - 1], c = list[k];
      const box = Array.isArray(it.box_2d) ? it.box_2d.flat(2).map(Number) : [];
      if (!c || box.length !== 4 || box.some((v) => !Number.isFinite(v))) continue;
      const h = c.y1 - c.y0, [a, b, cc, d] = box.map((v) => Math.min(1000, Math.max(0, v)));
      if (cc <= a || d <= b) continue;
      const item = { y0: Math.round(c.y0 + (a / 1000) * h), y1: Math.round(c.y0 + (cc / 1000) * h), x0: Math.round((b / 1000) * width), x1: Math.round((d / 1000) * width), ...base, located: false };
      const [top, bottom] = coreOf(list, k), mid = (item.y0 + item.y1) / 2;
      if (mid >= top && mid < bottom) items.push(item);
    }
    const terms = (Array.isArray(data.terms) ? data.terms : []).filter((t) => t && typeof t.source === "string" && t.source.trim() && typeof t.en === "string" && t.en.trim())
      .map((t) => ({ source: t.source.trim(), en: t.en.trim(), kind: String(t.kind || "") }));
    return { items, terms };
  }

  // ---------- drawing ----------
  function sections(flat, width, items) {
    const H = flat.length;
    const maxH = Math.round(width * MAX_CHUNK), minH = Math.round(width * MIN_CHUNK);
    const boxes = items.filter((it) => it.en).sort((a, b) => a.y0 - b.y0);
    const crossed = (y) => boxes.some((b) => b.y0 < y && y < b.y1);
    // the gutter-to-gutter spans
    const cuts = [0, ...gutters(flat, width).map(([a, b]) => Math.round((a + b) / 2)), H].filter((y, i, all) => i === 0 || y > all[i - 1]);
    let spans = [];
    for (let i = 1; i < cuts.length; i++) spans.push([cuts[i - 1], cuts[i]]);
    // a span taller than the most drawn at once: cut where no box crosses (the quietest such row), or at the end of the box that is in the way
    spans = spans.flatMap(([a, b]) => {
      const out = [];
      while (b - a > maxH) {
        let y = quietest(flat, a + minH, a + maxH, (r) => !crossed(r));
        if (y < 0) y = Math.max(...boxes.filter((x) => x.y0 < a + maxH && x.y1 > a + maxH).map((x) => x.y1), a + maxH);
        if (y >= b) break;
        out.push([a, y]);
        a = y;
      }
      out.push([a, b]);
      return out;
    });
    const inSpan = ([a, b]) => boxes.filter((x) => (x.y0 + x.y1) / 2 >= a && (x.y0 + x.y1) / 2 < b);
    // spans with text, joined with the ones after while they fit (one request draws them all for the same price); then only the rows around the text
    // (a span with no text is joined only on the way to one that has text)
    const out = [];
    const pad = Math.round(width * 0.08);
    for (let i = 0; i < spans.length; i++) {
      if (!inSpan(spans[i]).length) continue;
      let [a, b] = spans[i];
      let j = i;
      while (j + 1 < spans.length && spans[j + 1][1] - a <= maxH) {
        if (!inSpan(spans[j + 1]).length && !(spans[j + 2] && spans[j + 2][1] - a <= maxH && inSpan(spans[j + 2]).length)) break;
        j++;
        b = spans[j][1];
      }
      i = j;
      const its = inSpan([a, b]);
      // y0, y1: the rows taken back from the drawing (inside the spans, so sections never overlap); cy0, cy1: the rows sent, at least MIN_DRAW
      const y0 = Math.max(a, Math.min(...its.map((x) => x.y0)) - pad), y1 = Math.min(b, Math.max(...its.map((x) => x.y1)) + pad);
      let cy0 = y0, cy1 = y1;
      if (cy1 - cy0 < MIN_DRAW) { cy0 = Math.max(0, Math.round((y0 + y1 - MIN_DRAW) / 2)); cy1 = Math.min(H, cy0 + MIN_DRAW); cy0 = Math.max(0, cy1 - MIN_DRAW); }
      out.push({ y0, y1, cy0, cy1, items: its });
    }
    return out;
  }

  // some of a section's items on their own: the rows around them within the section, sent as at least MIN_DRAW rows of the strip (H rows in all)
  function partOf(its, section, width, H) {
    const pad = Math.round(width * 0.08);
    const y0 = Math.max(section.y0, Math.min(...its.map((x) => x.y0)) - pad), y1 = Math.min(section.y1, Math.max(...its.map((x) => x.y1)) + pad);
    let cy0 = y0, cy1 = y1;
    if (cy1 - cy0 < MIN_DRAW) { cy0 = Math.max(0, Math.round((y0 + y1 - MIN_DRAW) / 2)); cy1 = Math.min(H, cy0 + MIN_DRAW); cy0 = Math.max(0, cy1 - MIN_DRAW); }
    return { y0, y1, cy0, cy1, items: its, alone: its.length === 1 };
  }

  // a section refused as a whole, in two: split at the widest gap between its items (a refused phone screen of 11 rows cost 11 requests an item at a time)
  function halvesOf(section, width, H) {
    const its = section.items.slice().sort((a, b) => a.y0 - b.y0);
    let at = 0, gap = -Infinity, end = -Infinity;
    for (let i = 0; i < its.length - 1; i++) {
      end = Math.max(end, its[i].y1);
      if (its[i + 1].y0 - end > gap) { gap = its[i + 1].y0 - end; at = i; }
    }
    return [its.slice(0, at + 1), its.slice(at + 1)].map((part) => partOf(part, section, width, H));
  }

  const where = (it, s, width) => {
    const cy = ((it.y0 + it.y1) / 2 - s.y0) / (s.y1 - s.y0), cx = (it.x0 + it.x1) / 2 / width;
    return (cy < 0.34 ? "top" : cy > 0.66 ? "bottom" : "middle") + " " + (cx < 0.34 ? "left" : cx > 0.66 ? "right" : "centre");
  };
  const KIND_NAME = { speech: "speech bubble", thought: "thought bubble", narration: "narration box", screen: "text on a screen or sign", sfx: "sound effect" };

  // picture: the section's rows sent (cy0 to cy1) as a data: URL (PNG). opts.style "list": only the translations, "Translate the image with this:" and
  // "1. original -> English" a line, no places, kinds or instructions (to compare with the default, which says where each is and how to letter it)
  function drawBody(section, picture, opts = {}) {
    const width = opts.width || 1;
    const sent = { y0: section.cy0 != null ? section.cy0 : section.y0, y1: section.cy1 != null ? section.cy1 : section.y1 };
    const flat = (t) => String(t).replace(/\s*\n\s*/g, " ");
    const list = opts.style === "list"
      ? section.items.map((it, i) => (i + 1) + ". " + flat(it.text) + " -> " + flat(it.en)).join("\n")
      : section.items.map((it, i) => (i + 1) + ". " + where(it, sent, width) + ", " + KIND_NAME[it.kind] + ": " + JSON.stringify(it.text) + " becomes " + JSON.stringify(it.en)).join("\n");
    const prompt = opts.style === "list" ? "Translate the image with this:\n" + list
      : `This picture is part of a ${opts.from ? opts.from + " " : ""}comic. Replace the lettering listed below with the ${opts.into || "English"} given, each in the same place, lettered the same way: same colour, weight and style; dialogue centred in its bubble with natural line breaks, sound effects drawn as sound effects. Leave any other lettering and everything else in the picture exactly as it is.\n${list}`;
    const model = opts.model || DRAW_MODEL, quality = opts.quality || (model === DRAW_MODEL ? DRAW_QUALITY : "");
    return { model, prompt, input_references: [{ type: "image_url", image_url: { url: picture } }], aspect_ratio: "auto", resolution: opts.resolution || "1K", ...(quality ? { quality } : {}) };
  }

  function drawnOf(answer) {
    const d = answer && Array.isArray(answer.data) && answer.data[0];
    return d && typeof d.b64_json === "string" && d.b64_json ? "data:" + (d.media_type || "image/png") + ";base64," + d.b64_json : "";
  }

  // ---------- lettering a plain item here ----------
  // An item whose letters sit on one flat colour (a white bubble, a black caption box, a phone screen) is erased by painting that colour over its letters and
  // lettered again here: free, and spelt exactly. Text over art, and sound effects, go to the image model.
  const INK = 40; // how far from the paper's colour (largest channel difference) a pixel counts as ink
  const near = (d, i, c, t) => Math.abs(d[i] - c[0]) <= t && Math.abs(d[i + 1] - c[1]) <= t && Math.abs(d[i + 2] - c[2]) <= t;

  // data: RGBA of a region (w x h) around an item; box: the item's box in it { x0, y0, x1, y1 }. -> { plain, paper, ink, mask, area, open, bbox } where
  // lines: how many lines of letters; mask is 1 on a letter's pixels (grown by 2 for their soft edges), area is 1 inside the bubble (letters included), open: that inside reaches the region's
  // edge (no outline round it: a caption on the page). The letters are the groups of ink that touch the box, do not reach the region's edge and are not as
  // big as the region (the bubble's outline and the art do one or the other), so a box drawn too tight still gets its whole letters.
  function letters(data, w, h, box) {
    const bx0 = Math.max(0, box.x0), by0 = Math.max(0, box.y0), bx1 = Math.min(w, box.x1), by1 = Math.min(h, box.y1);
    const counts = new Map();
    let best = -1, n = 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const i = (y * w + x) * 4, k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const c = (counts.get(k) || 0) + 1;
      counts.set(k, c);
      if (c > n) { n = c; best = k; }
    }
    if (best < 0) return { plain: false };
    // the paper: the mean of the commonest bin
    const sum = [0, 0, 0];
    let m = 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const i = (y * w + x) * 4;
      if ((((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)) !== best) continue;
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; m++;
    }
    const paper = sum.map((v) => Math.round(v / m));
    const N = w * h, ink = new Uint8Array(N), group = new Int32Array(N).fill(-1), keep = [], groups = [];
    for (let p = 0; p < N; p++) ink[p] = near(data, p * 4, paper, INK) ? 0 : 1;
    const stack = [];
    // the box's middle half: a bubble's letters are there, and its corners (outside the oval) are not the bubble
    const mx0 = bx0 + (bx1 - bx0) / 4, mx1 = bx1 - (bx1 - bx0) / 4, my0 = by0 + (by1 - by0) / 4, my1 = by1 - (by1 - by0) / 4;
    // the patches of paper (4 neighbours): a bubble's inside is one, the page outside its outline another
    const sea = new Int32Array(N).fill(-1);
    for (let p0 = 0, n = 0; p0 < N; p0++) {
      if (ink[p0] || sea[p0] >= 0) continue;
      sea[p0] = n; stack.push(p0);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && !ink[q] && sea[q] < 0) { sea[q] = n; stack.push(q); }
      }
      n++;
    }
    for (let p0 = 0; p0 < N; p0++) {
      if (!ink[p0] || group[p0] >= 0) continue;
      const g = keep.length;
      let minx = w, maxx = 0, miny = h, maxy = 0, edge = false, inBox = false, inMiddle = false;
      const around = new Map(); // the paper patches it touches, and how much
      group[p0] = g; stack.push(p0);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (x >= bx0 && x < bx1 && y >= by0 && y < by1) inBox = true;
        if (x >= mx0 && x < mx1 && y >= my0 && y < my1) inMiddle = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
            const q = ny * w + nx;
            if (ink[q] && group[q] < 0) { group[q] = g; stack.push(q); } else if (!ink[q]) around.set(sea[q], (around.get(sea[q]) || 0) + 1);
          }
        }
      }
      const main = [...around.entries()].sort((a, b) => b[1] - a[1])[0];
      groups.push({ minx, maxx, miny, maxy, inBox, inMiddle, sea: main ? main[0] : -1, ok: !edge && maxx - minx < w * 0.8 && maxy - miny < h * 0.8 });
      keep.push(false);
    }
    // the groups that touch the box, then any group in the same paper beside a kept one (on its line within a letter and a half, or on the next line within
    // a line): a box drawn too tight leaves whole words outside it. (Not across a bubble's outline: the words outside it are another patch of paper.)
    // (the paper is the one round the letters in the box's middle; with none there, round any in the box)
    const seeds = groups.filter((g) => g.ok && g.inMiddle).length ? groups.filter((g) => g.ok && g.inMiddle) : groups.filter((g) => g.ok && g.inBox);
    const seas = new Set(seeds.map((g) => g.sea));
    groups.forEach((g, i) => { keep[i] = g.ok && g.inBox && seas.has(g.sea); });
    for (let changed = true; changed; ) {
      changed = false;
      groups.forEach((g, i) => {
        if (keep[i] || !g.ok || !seas.has(g.sea)) return;
        const gh = g.maxy - g.miny + 1;
        for (let j = 0; j < groups.length; j++) {
          if (!keep[j]) continue;
          const k = groups[j], kh = k.maxy - k.miny + 1, size = Math.max(gh, kh, 6);
          const vOver = Math.min(g.maxy, k.maxy) - Math.max(g.miny, k.miny), hOver = Math.min(g.maxx, k.maxx) - Math.max(g.minx, k.minx);
          const hGap = Math.max(g.minx - k.maxx, k.minx - g.maxx), vGap = Math.max(g.miny - k.maxy, k.miny - g.maxy);
          if ((vOver >= 0.4 * Math.min(gh, kh) && hGap <= 1.5 * size) || (hOver > 0 && vGap <= size)) { keep[i] = true; changed = true; return; }
        }
      });
    }
    const core = new Uint8Array(N);
    let any = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    for (let p = 0; p < N; p++) if (group[p] >= 0 && keep[group[p]]) {
      core[p] = 1; any++;
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!any) return { plain: false, paper };
    const mask = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (core[p]) {
      const x = p % w, y = (p - x) / w;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h) mask[ny * w + nx] = 1; }
    }
    // plain: right round the letters (their box grown by 6) what is not a letter is the paper, and most of the item's box is not letters (else the "paper"
    // was the letters' colour). (Not the whole item's box: it holds the bubble's outline, and the art beyond the bubble's corners.)
    let other = 0, flatN = 0, lettered = 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) if (core[y * w + x]) lettered++;
    for (let y = Math.max(0, y0 - 6); y <= Math.min(h - 1, y1 + 6); y++) for (let x = Math.max(0, x0 - 6); x <= Math.min(w - 1, x1 + 6); x++) {
      const p = y * w + x;
      if (mask[p]) continue;
      other++;
      if (near(data, p * 4, paper, TOLERANCE)) flatN++;
    }
    // the letters' colour: the middle one of the pixels most unlike the paper
    const strong = [];
    for (let p = 0; p < N; p++) if (core[p]) { const i = p * 4; strong.push([Math.max(Math.abs(data[i] - paper[0]), Math.abs(data[i + 1] - paper[1]), Math.abs(data[i + 2] - paper[2])), data[i], data[i + 1], data[i + 2]]); }
    strong.sort((a, b) => b[0] - a[0]);
    const top = strong.slice(0, Math.max(1, Math.ceil(strong.length / 2)));
    const mid = (c) => top.map((s) => s[c]).sort((a, b) => a - b)[Math.floor(top.length / 2)];
    const inkColour = [mid(1), mid(2), mid(3)];
    // the bubble's inside: from the letters over paper and letters, stopped by anything else (the outline)
    const area = new Uint8Array(N);
    let open = false;
    for (let p = 0; p < N; p++) if (core[p]) { area[p] = 1; stack.push(p); }
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!area[q] && (mask[q] || near(data, q * 4, paper, TOLERANCE))) { area[q] = 1; stack.push(q); }
      }
    }
    // the lines of letters: runs of rows that hold some, apart by 2 rows or more
    let lines = 0;
    for (let y = y0, gap = 2; y <= y1 + 1; y++) {
      let has = false;
      for (let x = x0; x <= x1 && !has; x++) if (y <= y1 && core[y * w + x]) has = true;
      if (has) { if (gap >= 2) lines++; gap = 0; } else gap++;
    }
    return { lines, plain: other > 0 && flatN / other >= 0.95 && lettered < (bx1 - bx0) * (by1 - by0) * 0.55, paper, ink: inkColour, mask, area, open, bbox: { x0, y0, x1: x1 + 1, y1: y1 + 1 } };
  }

  // Where the English goes: lines centred on `centre`, each as wide as the area is at its height (less a margin), the largest size from opts.maxSize down to
  // opts.minSize that holds every word (in exactly opts.lines lines when given: a screen's row stays one row). measure(text, size) -> its width. -> { size, lines: [{ text, x, y (baseline) }] }, or null when nothing fits.
  function layout(area, w, h, centre, words, measure, opts = {}) {
    const maxSize = Math.max(opts.minSize || 9, Math.round(opts.maxSize || 40)), minSize = opts.minSize || 9, lead = 1.18;
    const cx = Math.max(0, Math.min(w - 1, Math.round(centre.x))), cy = centre.y;
    const span = (y) => { // the area's width at row y, kept centred on cx
      const r = Math.round(y);
      if (r < 0 || r >= h || !area[r * w + cx]) return 0;
      let l = cx, rr = cx;
      while (l > 0 && area[r * w + l - 1]) l--;
      while (rr < w - 1 && area[r * w + rr + 1]) rr++;
      return Math.min(2 * Math.min(cx - l, rr - cx), opts.maxWidth || Infinity);
    };
    for (let size = maxSize; size >= minSize; size--) {
      const lh = size * lead, pad = size * 0.3;
      for (let n = opts.lines || 1; n * lh <= h && (!opts.lines || n === opts.lines); n++) {
        const top = cy - (n * lh) / 2;
        const lines = [];
        let i = 0;
        for (let k = 0; k < n && i < words.length; k++) {
          const room = Math.min(span(top + k * lh + lh * 0.12), span(top + k * lh + lh * 0.5), span(top + k * lh + lh * 0.88)) - 2 * pad;
          let line = "";
          while (i < words.length) {
            const t = line ? line + " " + words[i] : words[i];
            if (measure(t, size) <= room) { line = t; i++; } else break;
          }
          if (!line) break;
          lines.push(line);
        }
        if (i === words.length) return { size, lines: lines.map((text, k) => ({ text, x: cx, y: top + k * lh + lh * 0.8 })) };
      }
    }
    return null;
  }

  // ---------- in a browser: the strip, and all of it ----------
  const Strip = {
    // sources: ImageBitmaps (or anything drawImage takes, with width and height), the site's pictures in order. The strip is the commonest width; a picture of
    // another width is scaled to it here and back when it is made again.
    async of(sources) {
      const widths = new Map();
      for (const s of sources) widths.set(s.width, (widths.get(s.width) || 0) + 1);
      const width = [...widths.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const heights = sources.map((s) => Math.round((s.height * width) / s.width));
      const height = heights.reduce((a, b) => a + b, 0);
      const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
      const crop = (y0, y1) => {
        const cv = new OffscreenCanvas(width, y1 - y0), x = cv.getContext("2d");
        sources.forEach((s, i) => { if (tops[i] + heights[i] > y0 && tops[i] < y1) x.drawImage(s, 0, tops[i] - y0, width, heights[i]); });
        return cv;
      };
      return {
        width, height, heights,
        flat() {
          const rows = [];
          sources.forEach((s, i) => {
            const cv = new OffscreenCanvas(width, heights[i]), x = cv.getContext("2d", { willReadFrequently: true });
            x.drawImage(s, 0, 0, width, heights[i]);
            const part = flatRows(x.getImageData(0, 0, width, heights[i]).data, width, heights[i]);
            for (const v of part) rows.push(v); // (no spread: a chapter has tens of thousands of rows)
          });
          return rows;
        },
        crop,
        // does anything drawn reach picture i
        touches: (i, drawn) => drawn.some((d) => (d.mask ? d.cy0 : d.y0) < tops[i] + heights[i] && (d.mask ? d.cy1 : d.y1) > tops[i]),
        // the site's picture i made again: the original, and over it each drawn piece, the lower layers first. A piece is a bitmap of the strip's rows cy0 to
        // cy1 (columns x0 to x0 + w, all of them by default), taken back where its mask is (a canvas of those rows and columns), or with no mask as whole rows
        // y0 to y1 (the sections drawn whole, the all-flux method).
        async picture(i, drawn, type) {
          const cv = new OffscreenCanvas(sources[i].width, sources[i].height), x = cv.getContext("2d");
          const k = sources[i].width / width, top = tops[i], bot = top + heights[i];
          x.drawImage(sources[i], 0, 0);
          for (const d of drawn.slice().sort((a, b) => (a.layer || 0) - (b.layer || 0))) {
            const r0 = Math.max(d.mask ? d.cy0 : d.y0, top), r1 = Math.min(d.mask ? d.cy1 : d.y1, bot);
            if (r1 <= r0) continue;
            const dx = d.x0 || 0, dw = d.w || width, sy = d.bitmap.height / (d.cy1 - d.cy0); // (the drawing is of the rows sent)
            if (!d.mask) {
              x.drawImage(d.bitmap, 0, (r0 - d.cy0) * sy, d.bitmap.width, (r1 - r0) * sy, dx * k, (r0 - top) * k, dw * k, (r1 - r0) * k);
              continue;
            }
            const t = new OffscreenCanvas(dw, r1 - r0), tx = t.getContext("2d");
            tx.drawImage(d.bitmap, 0, (r0 - d.cy0) * sy, d.bitmap.width, (r1 - r0) * sy, 0, 0, dw, r1 - r0);
            tx.globalCompositeOperation = "destination-in"; // (only where the mask is)
            tx.drawImage(d.mask, 0, r0 - d.cy0, dw, r1 - r0, 0, 0, dw, r1 - r0);
            x.drawImage(t, dx * k, (r0 - top) * k, dw * k, (r1 - r0) * k);
          }
          return cv.convertToBlob({ type: type || "image/webp", quality: 0.9 });
        }
      };
    }
  };

  const dataUrl = async (canvas, type) => {
    const blob = await canvas.convertToBlob({ type, quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return "data:" + type + ";base64," + btoa(s);
  };

  // opts: ask(kind "read" | "draw", body) -> the answer's JSON (the caller sends it, paid as it says); from / into (language names); glossary [{ source, en }];
  // cast [names]; onProgress({ step: "finding" | "reading" | "drawing", done, of }); method, detect (above); reference: the novel's translation of this part (its lines), followed where the comic says the same; drawStyle: "list" for the image model's plainer prompt (drawBody); drawModel, drawQuality (OpenAI's GPT Image: "low" | "medium" | "high"; DRAW_MODEL at DRAW_QUALITY when not given); onDrawn({ cy0, cy1, y0, y1, items, sent, answer }): each image
  // model answer as it came, uncut, with the picture it was sent (data: URLs; for a test to look at). Pictures are made again only where something was drawn (null: as it was).
  // A part the model will not draw (the image model's moderation refused a part of the test chapter) is tried again in halves, down to an item; what is still refused
  // stays as it was, and is in `skipped` ({ y0, y1, why }) with its items still read; an error the caller marks `fatal` (no key, no tickets) stops it all.
  async function translate(sources, opts) {
    const { ask } = opts;
    const progress = opts.onProgress || (() => {});
    // opts.signal (an AbortSignal): Stop, between one tile, reading or drawing and the next
    const stop = () => { if (opts.signal && opts.signal.aborted) throw Object.assign(new Error("Stopped"), { fatal: true, stopped: true }); };
    const strip = await Strip.of(sources);
    const flat = strip.flat();
    const list = chunks(flat, strip.width);
    let cost = 0;
    const counted = (a) => { cost += (a && a.usage && Number(a.usage.cost)) || 0; return a; };
    // "full": where the text is from the text detector, tile by tile (opts.detect)
    const full = opts.method === "full";
    let lines = [];
    const skipped = []; // ({ y0, y1, why }: a part not found, read or drawn)
    const used = new Set();
    if (full && typeof opts.detect !== "function" && opts.findModel) {
      // where the text is from a vision model, chunk by chunk, a few at once (a slow model, GLM 5.3 Flash, thinks for minutes); a chunk it could not do has no lines
      // (the reading still gives the text it sees there, with a rough box)
      const found = [];
      let next = 0, done = 0;
      progress({ step: "finding", done: 0, of: list.length });
      const worker = async () => {
        while (next < list.length) {
          stop();
          const k = next++;
          try {
            const picture = await dataUrl(strip.crop(list[k].y0, list[k].y1), "image/jpeg");
            found.push(...boxesOf(counted(await ask("find", findBody(picture, { model: opts.findModel, from: opts.from }))), list, k, strip.width));
          } catch (e) {
            if (e && e.fatal) throw e;
            skipped.push({ y0: list[k].y0, y1: list[k].y1, why: "find: " + String((e && e.message) || e) });
          }
          progress({ step: "finding", done: ++done, of: list.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(FIND_AT_ONCE, list.length) }, worker));
      lines = mergeLines(found);
    } else if (full) {
      if (typeof opts.detect !== "function") throw new Error("the full method needs a text finder (opts.detect, or opts.findModel)");
      const tiles = tilesOf(strip.width, strip.height), found = [];
      for (let t = 0; t < tiles.length; t++) {
        stop();
        progress({ step: "finding", done: t, of: tiles.length });
        const y0 = tiles[t], h = Math.min(strip.width, strip.height - y0), s = detectScale(strip.width), side = detectSideOf(strip.width);
        const cv = new OffscreenCanvas(side, side), x = cv.getContext("2d", { willReadFrequently: true });
        x.fillStyle = "#000";
        x.fillRect(0, 0, side, side);
        x.drawImage(strip.crop(y0, y0 + h), 0, 0, strip.width * s, h * s);
        const map = await opts.detect(x.getImageData(0, 0, side, side).data, side);
        found.push(...linesOfTile(map, side, s, y0, strip.width, h, { first: y0 === 0, last: y0 + h >= strip.height }));
      }
      lines = mergeLines(found);
      progress({ step: "finding", done: tiles.length, of: tiles.length });
    }
    // a chunk with its lines boxed and numbered on it, as the reading sees it
    const marked = (k) => {
      const c = list[k], cv = strip.crop(c.y0, c.y1), x = cv.getContext("2d");
      x.lineWidth = 2;
      x.font = "bold 15px Arial, sans-serif";
      x.textBaseline = "top";
      for (const l of lines) {
        const m = (l.y0 + l.y1) / 2, [top, bottom] = coreOf(list, k);
        if (m < top || m >= bottom) continue;
        x.strokeStyle = "rgba(255, 0, 200, 0.9)";
        x.strokeRect(l.x0, l.y0 - c.y0, l.x1 - l.x0, l.y1 - l.y0);
        // (its tag above its own first letter: a tag left of the box sat at the end of the box before it, and two buttons side by side were read swapped)
        const tag = String(l.n), tw = x.measureText(tag).width + 6, ty = Math.max(0, l.y0 - c.y0 - 17);
        x.fillStyle = "rgba(255, 0, 200, 0.95)";
        x.fillRect(l.x0, ty, tw, 17);
        x.fillStyle = "#fff";
        x.fillText(tag, l.x0 + 3, ty + 1);
      }
      return cv;
    };
    // reading, READ_BATCH chunks a request; the speakers and terms found so far go with the next one
    const items = [], terms = [], cast = new Set(opts.cast || []);
    const glossary = (opts.glossary || []).slice();
    for (let i = 0; i < list.length; i += READ_BATCH) {
      stop();
      progress({ step: "reading", done: i, of: list.length });
      const ids = list.slice(i, i + READ_BATCH).map((_, j) => i + j);
      const pictures = [];
      for (const k of ids) pictures.push(await dataUrl(full ? marked(k) : strip.crop(list[k].y0, list[k].y1), "image/jpeg"));
      let got;
      const say = { from: opts.from, into: opts.into, glossary, cast: [...cast], model: opts.readModel, reference: opts.reference };
      const readOnce = async () => full
        ? readMarked(counted(await ask("read", markedReadBody(pictures, ids.map((k) => linesIn(list, k, lines, strip.width)), say))), list, ids, strip.width, lines, used)
        : readItems(counted(await ask("read", readBody(pictures, say))), list, ids, strip.width);
      try {
        got = await readOnce().catch((e) => { if (e && e.fatal) throw e; return readOnce(); }); // (an answer that was not JSON: once more)
      } catch (e) {
        if (e && e.fatal) throw e;
        skipped.push({ y0: list[ids[0]].y0, y1: list[ids[ids.length - 1]].y1, why: "read: " + String((e && e.message) || e) });
        continue;
      }
      items.push(...got.items);
      for (const t of got.terms) if (!terms.some((x) => x.source === t.source)) { terms.push(t); glossary.push(t); }
      for (const it of got.items) if (it.speaker) cast.add(it.speaker);
    }
    progress({ step: "reading", done: list.length, of: list.length });
    const drawn = [];
    // the tiers (the default): a plain item lettered here; text over art and sound effects drawn by the image model, taken back only around those items.
    // "all-flux": every section with text drawn by the image model and taken back whole (the first method, kept to compare with).
    const tiers = opts.method !== "all-flux";
    let toDraw = items;
    if (tiers) {
      toDraw = [];
      loaded = new Set();
      for (const f of opts.fonts || []) {
        try {
          const face = new FontFace(f.family, "url(" + f.url + ")", { weight: String(f.weight || 400) });
          (typeof document !== "undefined" ? document.fonts : self.fonts).add(await face.load());
          loaded.add(f.family);
        } catch (e) { /* the fallback fonts letter it */ }
      }
      const pen = new OffscreenCanvas(8, 8).getContext("2d");
      for (const it of items) {
        if (it.keep || !it.en || it.en.replace(/\s+/g, " ").trim() === it.text.replace(/\s+/g, " ").trim()) continue; // (nothing to change: "tls123", "0", a watermark)
        // lettered here: speech, thought, narration; with the detector's exact lines, a screen's too (its numbers then stay as they were written, not as the image
        // model redraws them); sound effects always go to the image model
        const here = it.kind === "speech" || it.kind === "thought" || it.kind === "narration" || (it.located && it.kind === "screen");
        const piece = here && (await letterHere(strip, it, pen, opts));
        if (piece) drawn.push(piece);
        else toDraw.push(it);
      }
    }
    // drawing, a few sections at once
    const secs = sections(flat, strip.width, toDraw);
    let next = 0, done = 0;
    progress({ step: "drawing", done: 0, of: secs.length });
    const worker = async () => {
      while (next < secs.length) {
        stop();
        const s = secs[next++];
        try {
          const sent = await dataUrl(strip.crop(s.cy0, s.cy1), "image/png");
          const answer = counted(await ask("draw", drawBody(s, sent, { width: strip.width, from: opts.from, into: opts.into, model: opts.drawModel, style: opts.drawStyle, quality: opts.drawQuality })));
          const url = drawnOf(answer);
          if (!url) throw new Error("the drawing came back with no picture");
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          if (opts.onDrawn) opts.onDrawn({ cy0: s.cy0, cy1: s.cy1, y0: s.y0, y1: s.y1, items: s.items.map((it) => ({ x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1, text: it.text, en: it.en })), sent, answer: url });
          drawn.push({ y0: s.y0, y1: s.y1, cy0: s.cy0, cy1: s.cy1, bitmap, ...(tiers ? { mask: aroundItems(s, strip.width), layer: 0 } : {}) });
        } catch (e) {
          if (e && e.fatal) throw e;
          // refused as a whole: in halves, with less of the art round each (the test chapter's refused part was a phone screen and a bubble that passed alone)
          if (s.items.length > 1) secs.push(...halvesOf(s, strip.width, strip.height)); // (and each half in two again, if refused)
          else skipped.push({ y0: s.y0, y1: s.y1, why: "draw: " + String((e && e.message) || e) });
        }
        progress({ step: "drawing", done: ++done, of: secs.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(DRAW_AT_ONCE, secs.length) }, worker));
    // the parts still in the original language because drawing did not do them (speech, thoughts, narration and screens; a sound effect is art, and is left): lettered over
    if (tiers) {
      const pen2 = new OffscreenCanvas(8, 8).getContext("2d");
      for (const it of toDraw) {
        if (it.kind === "sfx" || !skipped.some((k) => /^draw:/.test(k.why) && it.y0 < k.y1 && it.y1 > k.y0)) continue;
        const piece = await letterFallback(strip, it, pen2).catch(() => null);
        if (piece) { drawn.push(piece); it.fallback = true; }
      }
    }
    const pictures = [];
    for (let i = 0; i < sources.length; i++) pictures.push(strip.touches(i, drawn) ? await strip.picture(i, drawn) : null); // (null: as it was)
    return { pictures, items, terms, cost, skipped, lettered: drawn.filter((d) => d.layer === 1).length };
  }

  // Where a section's drawing is taken back: each of its items' boxes grown by a third across and half down (at least 16 px), with soft edges, in the rows
  // sent. (Grown by a quarter, the old letters showed below a box the reading drew too tight.)
  function aroundItems(s, width) {
    const m = new OffscreenCanvas(width, s.cy1 - s.cy0), x = m.getContext("2d");
    x.filter = "blur(5px)";
    x.fillStyle = "#000";
    // (an item's whole box, not each of its lines: the English is laid out anew, wider and elsewhere than the old lines, and taken back line by line it was cut
    // off, or the old text was what was taken back. With the detector the box is exact, so the margin round it is too.)
    for (const it of s.items) {
      const gx = Math.max(16, (it.x1 - it.x0) * 0.35), gy = Math.max(16, (it.y1 - it.y0) * 0.5);
      x.fillRect(it.x0 - gx, it.y0 - gy - s.cy0, it.x1 - it.x0 + 2 * gx, it.y1 - it.y0 + 2 * gy);
    }
    return m;
  }

  // Komika Text Bold (Apostrophic Labs, freeware) letters speech and thought in capitals when the caller gave it (opts.fonts, weight 700) and it loaded; without
  // it they are lettered in Comic Neue as the table below says
  const CAPS = "Komika Text", CAPS_KINDS = ["speech", "thought"];
  let loaded = new Set(); // the families translate() loaded
  const faceOf = (kind) => {
    const [weight, family] = FONT[kind] || FONT.speech;
    return loaded.has(CAPS) && CAPS_KINDS.includes(kind) ? { weight: 700, family: '"' + CAPS + '", ' + family, caps: true } : { weight, family, caps: false };
  };
  const FONT = { speech: [400, '"Comic Neue", "Comic Sans MS", sans-serif'], thought: [400, '"Comic Neue", "Comic Sans MS", sans-serif'], narration: [400, '"Comic Neue", "Comic Sans MS", sans-serif'], screen: [400, "Arial, Helvetica, sans-serif"] };
  // One plain item lettered here: its letters painted over with the paper's colour and the English written in the bubble's shape. -> a drawn piece (layer 1:
  // over the image model's), its mask the pixels that changed; or null when it is not plain or the English does not fit (the image model draws it then).
  // A part the image model did not draw (refused, or drawing could not be paid for) and that letterHere could not letter (its paper is mixed with something: a site's watermark
  // laid over the bubble): the English put over the item's box on a patch of the colour round it. Not as clean as a part drawn again, but nothing is left in the original language.
  // -> a piece as letterHere's, or null (it does not fit)
  async function letterFallback(strip, it, pen) {
    const gx = Math.max(8, Math.round((it.x1 - it.x0) * 0.06)), gy = Math.max(8, Math.round((it.y1 - it.y0) * 0.1));
    const r = { x0: Math.max(0, it.x0 - gx), y0: Math.max(0, it.y0 - gy), x1: Math.min(strip.width, it.x1 + gx), y1: Math.min(strip.height, it.y1 + gy) };
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w < 16 || h < 12) return null;
    const rows = strip.crop(r.y0, r.y1), cv = new OffscreenCanvas(w, h), x = cv.getContext("2d", { willReadFrequently: true });
    x.drawImage(rows, -r.x0, 0);
    const d = x.getImageData(0, 0, w, h).data;
    // the colour round the box: the commonest of the outer 3 pixels (a bubble's paper, or the art's flat colour), averaged
    const bins = new Map();
    const ring = (px, py) => { const i = (py * w + px) * 4, k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); const e = bins.get(k) || { n: 0, c: [0, 0, 0] }; e.n++; e.c[0] += d[i]; e.c[1] += d[i + 1]; e.c[2] += d[i + 2]; bins.set(k, e); };
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) if (px < 3 || py < 3 || px >= w - 3 || py >= h - 3) ring(px, py);
    const top = [...bins.values()].sort((a, b) => b.n - a.n)[0];
    const paper = top.c.map((v) => Math.round(v / top.n));
    const dark = 0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2] < 128;
    x.fillStyle = "rgb(" + paper.join(",") + ")";
    x.fillRect(0, 0, w, h);
    const { weight, family, caps } = faceOf(it.kind);
    const measure = (t, size) => { pen.font = weight + " " + size + "px " + family; return pen.measureText(t).width; };
    const lines = Math.max(1, it.text.split("\n").length);
    const area = new Uint8Array(w * h).fill(1);
    const fit = layout(area, w, h, { x: w / 2, y: h / 2 }, (caps ? it.en.toUpperCase() : it.en).replace(/\n+/g, " ").split(/\s+/).filter(Boolean), measure,
      { maxSize: Math.min(48, ((it.y1 - it.y0) / lines) * 0.95), minSize: 8, maxWidth: w });
    if (!fit) return null;
    x.font = weight + " " + fit.size + "px " + family;
    x.textAlign = "center";
    x.fillStyle = dark ? "#fff" : "#111";
    for (const l of fit.lines) x.fillText(l.text, l.x, l.y);
    const mask = new OffscreenCanvas(w, h), mx = mask.getContext("2d");
    mx.fillStyle = "#000";
    mx.fillRect(0, 0, w, h);
    return { cy0: r.y0, cy1: r.y1, x0: r.x0, w, bitmap: cv, mask, layer: 2, item: it };
  }

  async function letterHere(strip, it, pen, opts) {
    const gx = Math.max(24, Math.round((it.x1 - it.x0) * 0.4)), gy = Math.max(24, Math.round((it.y1 - it.y0) * 0.4));
    const r = { x0: Math.max(0, it.x0 - gx), y0: Math.max(0, it.y0 - gy), x1: Math.min(strip.width, it.x1 + gx), y1: Math.min(strip.height, it.y1 + gy) };
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const rows = strip.crop(r.y0, r.y1), cv = new OffscreenCanvas(w, h), x = cv.getContext("2d", { willReadFrequently: true });
    x.drawImage(rows, -r.x0, 0);
    const before = x.getImageData(0, 0, w, h);
    const found = letters(before.data, w, h, { x0: it.x0 - r.x0, y0: it.y0 - r.y0, x1: it.x1 - r.x0, y1: it.y1 - r.y0 });
    if (!found.plain || found.lines < it.text.split("\n").filter((l) => l.trim()).length) return null; // (fewer lines than the text has: some are on other paper)
    const { weight, family, caps } = faceOf(it.kind);
    const measure = (t, size) => { pen.font = weight + " " + size + "px " + family; return pen.measureText(t).width; };
    const b = found.bbox, lines = Math.max(1, it.text.split("\n").length);
    const was = Math.min(48, ((b.y1 - b.y0) / lines) * 0.95); // (about the old letters' size)
    const fit = layout(found.area, w, h, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }, (caps ? it.en.toUpperCase() : it.en).replace(/\n+/g, " ").split(/\s+/).filter(Boolean), measure,
      { maxSize: was, minSize: 9, maxWidth: found.open ? Math.max(b.x1 - b.x0, (it.x1 - it.x0)) * 1.15 : Infinity, lines: it.kind === "screen" ? lines : 0 }); // (a screen's rows as many as they were)
    if (!fit || fit.size < was * 0.55) return null; // (far smaller than the old letters: the area is not what it seems)
    // erase: the paper's colour over the letters
    const after = new ImageData(new Uint8ClampedArray(before.data), w, h), d = after.data;
    // (the letters' soft edges, a JPEG's ringing, are within the ink's tolerance of the paper and not in the mask: left alone they show as a ghost of the old
    // text, so everything near the paper's colour round the letters goes to it)
    const gx0 = Math.max(0, b.x0 - 8), gx1 = Math.min(w, b.x1 + 8), gy0 = Math.max(0, b.y0 - 8), gy1 = Math.min(h, b.y1 + 8);
    for (let p = 0; p < w * h; p++) {
      const px = p % w, py = (p - px) / w;
      if (found.mask[p] || (px >= gx0 && px < gx1 && py >= gy0 && py < gy1 && near(before.data, p * 4, found.paper, INK))) { d[p * 4] = found.paper[0]; d[p * 4 + 1] = found.paper[1]; d[p * 4 + 2] = found.paper[2]; }
    }
    x.putImageData(after, 0, 0);
    x.font = weight + " " + fit.size + "px " + family;
    x.textAlign = "center";
    x.fillStyle = "rgb(" + found.ink.join(",") + ")";
    for (const l of fit.lines) x.fillText(l.text, l.x, l.y);
    // the mask: the pixels that changed and the bubble's inside round the letters, grown by 3 (over its outline's inner edge), so that this piece puts back the
    // whole bubble over an image model's drawing of the rows around it (a phone screen behind a bubble is drawn by the model, the bubble lettered here)
    const now = x.getImageData(0, 0, w, h).data, keep = new Uint8Array(w * h);
    const ax = Math.max(12, (b.x1 - b.x0) * 0.2), ay = Math.max(12, (b.y1 - b.y0) * 0.2);
    for (let p = 0; p < w * h; p++) {
      const px = p % w, py = (p - px) / w;
      const changed = now[p * 4] !== before.data[p * 4] || now[p * 4 + 1] !== before.data[p * 4 + 1] || now[p * 4 + 2] !== before.data[p * 4 + 2];
      if (changed || (found.area[p] && px >= b.x0 - ax && px < b.x1 + ax && py >= b.y0 - ay && py < b.y1 + ay)) keep[p] = 1;
    }
    const mask = new OffscreenCanvas(w, h), mx = mask.getContext("2d"), md = mx.createImageData(w, h);
    for (let p = 0; p < w * h; p++) if (keep[p]) {
      const px = p % w, py = (p - px) / w;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const nx = px + dx, ny = py + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h) md.data[(ny * w + nx) * 4 + 3] = 255; }
    }
    mx.putImageData(md, 0, 0);
    return { cy0: r.y0, cy1: r.y1, x0: r.x0, w, bitmap: cv, mask, layer: 1, item: it };
  }

  // The lines a translated chapter keeps: each item said (not one kept as it was), in reading order, with the picture it is on (the one that holds its centre), its
  // box there in parts of that picture's width and height (0-1: a box across the site's cut runs past them), and notDrawn where the image model drew nothing.
  // sizes: the site's pictures ({ width, height } each, as given to translate); r: translate's answer
  function linesOf(sizes, r) {
    const widths = new Map();
    for (const s of sizes) widths.set(s.width, (widths.get(s.width) || 0) + 1);
    const width = [...widths.entries()].sort((a, b) => b[1] - a[1])[0][0]; // (the strip's, as Strip.of has it)
    const heights = sizes.map((s) => Math.round((s.height * width) / s.width));
    const tops = [];
    let y = 0;
    for (const h of heights) { tops.push(y); y += h; }
    const part = (v) => Math.round(v * 10000) / 10000;
    return r.items.filter((it) => !it.keep && it.en && it.en.trim()).map((it) => {
      const mid = (it.y0 + it.y1) / 2;
      let page = 0;
      while (page + 1 < tops.length && tops[page + 1] <= mid) page++;
      const top = tops[page], h = heights[page] || 1;
      const notDrawn = !it.fallback && r.skipped.some((s) => /^draw:/.test(s.why) && it.y0 < s.y1 && it.y1 > s.y0);
      return { en: it.en.trim(), text: it.text, kind: it.kind, ...(it.speaker ? { speaker: it.speaker } : {}), page,
        box: [part(it.x0 / width), part((it.y0 - top) / h), part(it.x1 / width), part((it.y1 - top) / h)], ...(notDrawn ? { notDrawn: true } : {}) };
    });
  }

  const api = { READ_MODEL, DRAW_MODEL, DRAW_QUALITY, READ_BATCH, MIN_DRAW, flatRows, gutters, chunks, coreOf, readPrompt, readBody, readItems, tilesOf, detectScale, detectSideOf, detectInput, linesOfTile, mergeLines, findPrompt, findBody, boxesOf, linesIn, markedReadBody, readMarked, DETECT_SIZE, sections, partOf, halvesOf, drawBody, drawnOf, letters, layout, letterFallback, Strip, translate, linesOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ComicTranslate = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
