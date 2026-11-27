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
//   blocksOf(lines) / lineOrder(lines) / claimLines(chunks, k, lines) / tagSpots(mine, near, tw, th, bounds, pad) / unclipOf(line)   a bubble's lines as one block,
//                                         the order lines are numbered in (block by block), a chunk taking the lines it shows (a bubble whole), where each line's number tag goes (on no text), how far the detector grew a line's box
//   sections(flat, width, items)          the parts of the strip to draw again: whole gutter-to-gutter spans holding text, joined up to MAX_CHUNK widths, cut
//                                         at a row no box crosses when one span is taller; [{ y0, y1 (taken back), cy0, cy1 (sent: at least MIN_DRAW), items }]
//   partOf(items, section, width, H) / halvesOf(section, width, H)   some of a section's items drawn on their own (a section refused as a whole: in two)
//   drawBody(section, picture, opts)      the request that draws one section with its items in English: OpenRouter's images API
//   drawnOf(answer)                       the picture an images API answer holds (a data: URL), or ""
//   letters(data, w, h, box, text)        an item's letters in the pixels around it: are they on one flat colour (plain), that colour, theirs, which pixels
//                                         are letters (mask) and the bubble's inside (area)
//   layout(area, w, h, centre, words, measure, opts)   the English in lines that follow the bubble's shape, at the largest size that fits
//   Strip.of(sources)                     (a browser) the pictures one under another at one width: width, height, heights, flat(), crop(y0, y1) -> canvas,
//                                         touches(i, drawn), picture(i, drawn) -> Blob (each drawn piece over the original, through its mask)
//   translate(sources, opts)              (a browser) all of it, the steps at once down the strip (onPicture: each picture as soon as it is made) -> { pictures: [Blob | null], items, terms, cost, skipped, lettered }. opts.method: "tiers" (the
//                                         default: plain items lettered here, the rest drawn and taken back only around them), "full" (the same, where the text is from a text
//                                         detector the caller runs: opts.detect(rgba, size) -> its map; or from a vision model, opts.findModel, asked as ask("find", findBody))
//                                         or "all-flux"
//   PROMPT_PRESETS / promptsFrom(promptSets)   the three prompts the person can change (comicFind, comicRead, comicDraw): the built-in ones, and the ones in use as translate's
//                                         opts.prompts { find, read, draw } takes them (text with {comic}, {language}, {count}; what the parser reads is added to it whatever it says)
//   findBody(picture, { model, from, prompts }) / boxesOf(answer, list, k, width)   where the text is, from a vision model: a chunk's request, and its boxes on the strip
//   linesOf(sizes, r)                     what a translated chapter keeps of translate's answer: its lines, each with its picture and its box there (the overlay)
//   unreadOf(sizes, r)                    the site's pictures whose text was not read (a reading request that failed, halves and all): "7–12, 30", or ""
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
  const READ_FIRST = 5; // chunks in the first reading request (the first pictures come sooner)
  const READ_FAILS = 4, READ_PAUSE = 2000; // (reading: the failed requests allowed beyond two for each first request; the wait before a part is asked again as it was)
  const MIN_DRAW = 256; // the smallest side the image model takes
  const DRAW_AT_ONCE = 3;
  // A part the model refuses is tried again in two parts, and each of those in two again, but only this many times down: a page it refuses everywhere cost 53 requests (every part
  // split to one bubble at a time); at 3 the whole, its halves, their halves and their halves again (opts.retries changes it). What is still refused is left as it was.
  const MAX_RETRIES = 3;
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

  // what each kind is: a sound a character makes in a bubble is that bubble's (a sigh "허어..." in a speech bubble was read as "sfx", which only the image model
  // draws, so with Lettered here first it stayed in Korean, "Not drawn")
  const KIND_RULE = `- "kind": "speech" | "thought" | "narration" | "screen" | "sfx". Text inside a speech or thought bubble is "speech" or "thought" even when it is a sound the character makes (a sigh, gasp, groan, laugh, scream or cry); "sfx" is only a sound lettered on the art itself, outside any bubble`;

  // ---------- the prompts ----------
  // Each of the three prompts (where the text is, the reading, the drawing) is text the person can change (Settings › Translation › Comics: PROMPT_PRESETS holds the built-in
  // ones, promptsFrom picks the one in use out of the library's promptSets, translate takes it as opts.prompts). {comic} ("Korean comic"), {language} and {count} are filled in.
  // What the parser depends on is added whatever the text says: the glossary, the cast and the novel's translation, the answer's JSON shape, KIND_RULE (where {kind} is, else
  // after the text) and, for any field it reads that the text never names, that field's line.
  const fillText = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  const promptVars = (count, { from, into }) => ({ count, comic: (from ? from + " " : "") + "comic", language: into || "English" });
  function promptText(text, vars, fields, kind = true) {
    let out = fillText(text, { ...vars, kind: KIND_RULE });
    if (kind && !/\{kind\}/.test(text)) out += "\n" + KIND_RULE;
    for (const [needle, line] of fields) if (!out.includes(needle)) out += "\n" + fillText(line, vars);
    return out;
  }
  const F_P = `- "p": the picture number`;
  const F_BOX = `- "box_2d": [ymin, xmin, ymax, xmax] on a 0-1000 scale of that picture: the whole bubble or box the text sits in (outline included); for text with no bubble, the text itself`;
  const F_TEXT = `- "text": the original text exactly, line breaks as \\n`;
  const F_LINES = `- "lines": the numbers of the lines the piece's text is in, in reading order. Give each line to one item at most. The lines of one bubble or box are numbered one after another: two bubbles side by side are two items, each with its own lines. A list (rows on a screen, a table, a menu) is one item for each row, never a whole column.`;
  const F_EN_PLAIN = `- "en": the {language} translation, natural comic {language}, about as long as the original so it fits the same bubble`;
  const F_EN = `- "en": the {language} translation, natural comic {language}, about as long as the original so it fits the same place`;
  // (the text finder boxes drawings as text too: a maple leaf, a leaf on a hair clip, a bubble's last dots. Told only "leave it out", Gemini 3.5 Flash Lite gave each an
  // item, a word for what is drawn ("단풍잎", "Maple leaf"; "꽃", "Fwip"); with a list to put them in it left them out, in 2 runs of 2: 2026-11-08)
  const F_NOT_TEXT = `- "not_text" (beside "items"): the numbers of the boxes on no writing (a drawn object such as a leaf or a flower, a pattern, a face, part of the art). Never write a word for what a drawing shows`;
  const READ_TEXT = `These {count} pictures are consecutive parts of one chapter of a {comic}, top to bottom (picture 1 is the top). Neighbouring pictures may overlap.
For every piece of text in every picture (speech bubbles, thought bubbles, narration boxes, text on screens, phones and signs, sound effects), return one item:
${F_P}
${F_BOX}
{kind}
${F_TEXT}
${F_EN_PLAIN}
- "speaker": who says it: a name if the chapter shows it, else a short description of the character ("the man in the suit"); null for narration, screens and sound effects
Text that appears in two overlapping pictures: give it in each picture where it is whole.
Also list "terms": names of people, places, skills, items, organisations and titles in the text, as {"source": the original, "en": the {language} you used, "kind": "person|place|skill|item|organisation|title"}.`;
  const OTHERS_GREY = "#8c8c8c"; // (what covers, in a chunk the reading sees, the lines another chunk reads)
  const MARKED_TEXT = `These {count} pictures are consecutive parts of one chapter of a {comic}, top to bottom (picture 1 is the top). Neighbouring pictures may overlap: text read with another picture is covered there by a plain grey box; never give it, and never give a grey box.
A text finder has drawn a numbered box round each line of text it found (the tag "12" is line 12; a tag is not part of the text: never copy its number into "text"); each picture's lines are also listed after it with their box_2d [ymin, xmin, ymax, xmax] on a 0-1000 scale of that picture. A box may be on something that is not writing (a drawn object such as a leaf or a flower, a pattern, a face, part of the art): list its number in "not_text", never in an item. Text is only letters actually written in the picture: never write a word for what a drawing shows.
Return one item for every piece of text: a whole speech bubble, thought bubble or narration box, a screen's or sign's text, a sound effect:
${F_LINES}
{kind}
${F_TEXT}
${F_EN}
- "speaker": who says it: a name if the chapter shows it, else a short description of the character; null for narration, screens and sound effects
- "keep": true only for a watermark or the address of the site the pictures come from, and for text that is not words (a phone's clock or battery, numbers alone) or is already in {language}; never for the comic's own text (titles, screens, signs and buttons in the story are translated); else false
Text you see that has no box (sound effects lettered as art, lettering the finder missed; letters you can read, not drawings): give it too, with "lines": [], "p": its picture number and "box_2d" round it on that picture's 0-1000 scale.
${F_NOT_TEXT}
Also list "terms": names of people, places, skills, items, organisations and titles in the text, as {"source": the original, "en": the {language} you used, "kind": "person|place|skill|item|organisation|title"}.`;
  const FIND_TEXT = `This picture is part of a {comic}. Find every piece of text in it: speech and thought bubbles, narration boxes, text on screens and signs, and sound effects, including big stylised sound effects drawn as part of the art.
For each give "x0", "y0", "x1", "y1": a tight box round the text itself: left, top, right, bottom on a 0-1000 scale of the picture's width and height (x0 = 0 is the left edge, y0 = 0 the top); "kind": "speech" | "thought" | "narration" | "screen" | "sfx"; "text": the text as it is written.`;
  const FIND_SCALE = `Give "x0", "y0", "x1", "y1" as a tight box round the text itself: left, top, right, bottom on a 0-1000 scale of the picture's width and height (x0 = 0 is the left edge, y0 = 0 the top).`;
  const DRAW_TEXT = `This picture is part of a {comic}. Replace the lettering listed below with the {language} given, each in the same place, lettered the same way: same colour, weight and style; dialogue centred in its bubble with natural line breaks, sound effects drawn as sound effects. Leave any other lettering and everything else in the picture exactly as it is.`;
  // The built-in prompts, for the three steps, in the shape Settings › Translation › Comics lists them ([{ id, name, about, text }], as gemini.js GEMINI_PROMPT_PRESETS has them).
  const PROMPT_PRESETS = {
    comicFind: [{ id: "default", name: "Default", about: "", text: FIND_TEXT }],
    comicRead: [{ id: "default", name: "Default", about: "", text: MARKED_TEXT }],
    comicDraw: [{ id: "default", name: "Default", about: "", text: DRAW_TEXT }]
  };
  // The prompts the person picked, from the library's promptSets (for each of comicFind, comicRead and comicDraw: { active, mine: [{ id, name, text }] }), as opts.prompts takes them:
  // { find?, read?, draw? }, only the steps where one other than the built-in default is in use.
  function promptsFrom(sets) {
    const out = {};
    for (const [kind, key] of [["comicFind", "find"], ["comicRead", "read"], ["comicDraw", "draw"]]) {
      const e = sets && sets[kind];
      if (!e || typeof e.active !== "string") continue;
      const mine = (Array.isArray(e.mine) ? e.mine : []).find((p) => p && p.id === e.active);
      if (mine) { if (typeof mine.text === "string" && mine.text.trim()) out[key] = mine.text; continue; }
      const built = PROMPT_PRESETS[kind].find((p) => p.id === e.active);
      if (built && built.id !== "default") out[key] = built.text;
    }
    return out;
  }

  function readPrompt(count, opts) {
    const { glossary, cast, reference } = opts;
    const terms = (glossary || []).filter((t) => t && t.source && t.en).slice(0, 300);
    const people = (cast || []).filter(Boolean).slice(0, 60);
    return promptText((opts.prompts && opts.prompts.readPlain) || READ_TEXT, promptVars(count, opts), [['"p"', F_P], ['"box_2d"', F_BOX], ['"text"', F_TEXT], ['"en"', F_EN_PLAIN]]) +
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
  // A reading answer's text; an empty one says why, for the log (a provider that stopped it: Gemini's "content_filter", a cut-off "length")
  function readText(answer) {
    if (typeof answer === "string") return answer;
    const c = answer && answer.choices && answer.choices[0], text = c && c.message ? c.message.content : "";
    if (text && String(text).trim()) return text;
    const why = (c && (c.native_finish_reason || c.finish_reason)) || (answer && answer.promptFeedback && answer.promptFeedback.blockReason) || "";
    throw new Error("the reading came back empty" + (why ? " (" + why + ")" : ""));
  }
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
    const data = parseJson(readText(answer));
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
  function findPrompt(from, text, into) {
    return promptText(text || FIND_TEXT, promptVars(1, { from, into }), [['1000', FIND_SCALE]], false) +
      `\nAnswer with JSON only: {"items": [{"x0": 0, "y0": 0, "x1": 0, "y1": 0, "kind": "", "text": ""}]}`;
  }
  function findBody(picture, opts = {}) {
    const model = opts.model || READ_MODEL;
    return { model, messages: [{ role: "user", content: [{ type: "text", text: findPrompt(opts.from, opts.prompts && opts.prompts.find, opts.into) }, { type: "image_url", image_url: { url: picture } }] }], temperature: 0,
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

  // the lines a chunk shows: those it took (claimLines: l.k), else those whose middle is in its core (so a line is shown in one chunk only), with their boxes on its 0-1000 scale
  function linesIn(list, k, lines, width) {
    const c = list[k], h = c.y1 - c.y0, [top, bottom] = coreOf(list, k);
    const at = (v, of) => Math.max(0, Math.min(1000, Math.round((v / of) * 1000)));
    return lines.filter((l) => (l.k !== undefined ? l.k === k : (l.y0 + l.y1) / 2 >= top && (l.y0 + l.y1) / 2 < bottom))
      .map((l) => ({ n: l.n, box_2d: [at(l.y0 - c.y0, h), at(l.x0, width), at(l.y1 - c.y0, h), at(l.x1, width)] }));
  }

  // The middle of each line's block: lines one over another (overlapping across, at most half a line apart, of about one size) or side by side (columns of text
  // set down the page) are one block, a bubble's text. -> [the block's middle row] in the lines' order
  function blocksOf(lines) {
    const ids = blockIdsOf(lines), span = new Map();
    lines.forEach((l, i) => { const s = span.get(ids[i]); span.set(ids[i], s ? [Math.min(s[0], l.y0), Math.max(s[1], l.y1)] : [l.y0, l.y1]); });
    return lines.map((_, i) => { const s = span.get(ids[i]); return (s[0] + s[1]) / 2; });
  }
  // The order lines are numbered in: block by block (each block's lines one after another), the blocks by their tops, then from the left; a block's lines top to bottom,
  // a block of columns right to left. -> the lines' indexes in that order. (Numbered by their tops alone, two bubbles side by side had their lines numbered in turn, 12 in one,
  // 13 in the other, 14 in the first...: the reading gave all six to the first bubble's text, lettered it over both, and the second bubble's text was lost: 2026-11-26)
  function lineOrder(lines) {
    const ids = blockIdsOf(lines), top = new Map(), left = new Map(), cols = new Map();
    lines.forEach((l, i) => {
      const id = ids[i];
      top.set(id, Math.min(top.has(id) ? top.get(id) : Infinity, l.y0));
      left.set(id, Math.min(left.has(id) ? left.get(id) : Infinity, l.x0));
      cols.set(id, (cols.has(id) ? cols.get(id) : true) && l.y1 - l.y0 > l.x1 - l.x0);
    });
    return lines.map((_, i) => i).sort((a, b) => {
      const A = ids[a], B = ids[b];
      if (A !== B) return top.get(A) - top.get(B) || left.get(A) - left.get(B) || A - B;
      return cols.get(A) ? lines[b].x0 - lines[a].x0 || lines[a].y0 - lines[b].y0 : lines[a].y0 - lines[b].y0 || lines[a].x0 - lines[b].x0;
    });
  }
  // Which block each line is in (the same number for a block's lines)
  function blockIdsOf(lines) {
    const up = lines.map((_, i) => i);
    const root = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
    const order = lines.map((_, i) => i).sort((a, b) => lines[a].y0 - lines[b].y0);
    for (let p = 0; p < order.length; p++) {
      const a = lines[order[p]], ha = a.y1 - a.y0, wa = a.x1 - a.x0;
      for (let q = p + 1; q < order.length; q++) {
        const b = lines[order[q]], hb = b.y1 - b.y0, wb = b.x1 - b.x0;
        if (b.y0 > a.y1 + ha) break; // (in order of their tops: none further down is near)
        const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), hm = Math.min(ha, hb), wm = Math.min(wa, wb);
        const stacked = ix > 0 && -iy <= 0.5 * hm && Math.max(ha, hb) <= 2.5 * hm;
        const beside = ha > wa && hb > wb && iy >= 0.3 * hm && -ix <= 0.8 * wm;
        if (stacked || beside) up[root(order[p])] = root(order[q]);
      }
    }
    return lines.map((_, i) => root(i));
  }

  // The lines chunk k shows (each marked l.k = k, for good): a bubble's lines all in one chunk, the one whose core holds the middle of their block, where that chunk
  // shows the line; a line that chunk does not show goes by its own middle. Called for the chunks in order, once the lines are known down to the chunk's end.
  // (By each line's own middle, a row of bubbles across the middle of an overlap had its upper lines in one chunk and the rest in the next; each chunk read the whole
  // bubble, and its English was lettered twice, once into each half: 2026-11-08.)
  function claimLines(list, k, lines) {
    const c = list[k], next = list[k + 1], [, bottom] = coreOf(list, k), mids = blocksOf(lines);
    lines.forEach((l, i) => {
      if (l.k !== undefined) return;
      const own = (l.y0 + l.y1) / 2;
      if (own >= c.y1) return;
      const take = !next || (mids[i] < bottom ? own < bottom || l.y1 <= c.y1 : own < bottom && l.y0 < next.y0);
      if (take) l.k = k;
    });
    return lines.filter((l) => l.k === k);
  }

  // How far the detector grew a line's box past its letters (linesOfTile: the box it found, grown by area x UNCLIP / perimeter), from the grown box
  function unclipOf(l) {
    const w = l.x1 - l.x0, h = l.y1 - l.y0, b = (2 * UNCLIP + 2) * (w + h), a = 4 * UNCLIP + 8;
    return Math.max(0, (b - Math.sqrt(Math.max(0, b * b - 4 * a * UNCLIP * w * h))) / (2 * a));
  }

  // Where each line's number tag goes on the picture the reading sees: above its first letter where that covers no text, else beside it at its middle (left, then right),
  // else below; where every place covers some, the one that covers least (letters first, then other lines' boxes). (Always above, a tag sat on the first letters of the
  // line over it, as a bubble's lines are closer together than a tag is tall: "가시가" was read "시가" and translated as a name, "뭐래!" not read at all: 2026-11-08.)
  // mine: the lines to tag; near: every line round them (mine too); tw(l): its tag's width; th: a tag's height; bounds: { x0, y0, x1, y1 } a tag stays in;
  // pad(l): how far a line's box reaches past its letters -> [{ x, y, w, h }] for mine, in the lines' coordinates
  function tagSpots(mine, near, tw, th, bounds, pad = () => 0) {
    const letters = near.map((l) => { const p = Math.max(0, Math.min(pad(l), (l.y1 - l.y0) / 2 - 1, (l.x1 - l.x0) / 2 - 1)); return { x0: l.x0 + p, y0: l.y0 + p, x1: l.x1 - p, y1: l.y1 - p }; });
    const over = (r, b) => Math.max(0, Math.min(r.x + r.w, b.x1) - Math.max(r.x, b.x0)) * Math.max(0, Math.min(r.y + r.h, b.y1) - Math.max(r.y, b.y0));
    const placed = [];
    return mine.map((l) => {
      const w = tw(l), mid = (l.y0 + l.y1) / 2;
      let best = null, least = Infinity;
      for (const [x, y] of [[l.x0, l.y0 - th], [l.x0 - w, mid - th / 2], [l.x1, mid - th / 2], [l.x0, l.y1], [l.x1 - w, l.y0 - th]]) {
        const r = { x: Math.max(bounds.x0, Math.min(bounds.x1 - w, x)), y: Math.max(bounds.y0, Math.min(bounds.y1 - th, y)), w, h: th };
        let cover = 0, touch = 0;
        near.forEach((o, i) => {
          cover += over(r, letters[i]);
          if (o !== l) touch += over(r, { x0: o.x0 - 3, y0: o.y0 - 3, x1: o.x1 + 3, y1: o.y1 + 3 });
        });
        for (const t of placed) cover += over(r, { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h });
        const cost = cover * 1e6 + touch;
        if (cost < least) { least = cost; best = r; }
      }
      placed.push(best);
      return best;
    });
  }

  function markedPrompt(count, opts) {
    const { glossary, cast, reference } = opts;
    const terms = (glossary || []).filter((t) => t && t.source && t.en).slice(0, 300);
    const people = (cast || []).filter(Boolean).slice(0, 60);
    return promptText((opts.prompts && opts.prompts.read) || MARKED_TEXT, promptVars(count, opts), [['"lines"', F_LINES], ['"text"', F_TEXT], ['"en"', F_EN], ['"not_text"', F_NOT_TEXT]]) +
      (terms.length ? `\nUse these renderings wherever the original appears:\n${terms.map((t) => t.source + " = " + t.en).join("\n")}` : "") +
      (people.length ? `\nCharacters already met in this chapter (use the same names for them): ${people.join(", ")}` : "") + referenceOf(reference) +
      `\nAnswer with JSON only: {"items": [...], "not_text": [...], "terms": [...]}`;
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
    const data = parseJson(readText(answer));
    if (!data || typeof data !== "object") throw new Error("the reading came back unreadable");
    const byN = new Map(lines.map((l) => [l.n, l]));
    const items = [];
    for (const it of Array.isArray(data.items) ? data.items : []) {
      if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
      const named = (Array.isArray(it.lines) ? it.lines : []).map((v) => Number(String(v).replace(/^L/i, "")));
      // (a tag beside its line was copied into the text: "전부 16", "올게. 25". Its own lines' numbers at either end of a row of the text, or a row of nothing else, come out)
      const tags = new Set(named.filter(Number.isFinite).map(String));
      const text = tags.size ? it.text.split("\n").map((row) => row.replace(/^\s*(\d+)\s+(?=\S)/, (m, d) => (tags.has(d) ? "" : m)).replace(/(\S)\s+(\d+)\s*$/, (m, a, d) => (tags.has(d) ? a : m)))
        .filter((row) => !tags.has(row.trim())).join("\n").trim() : it.text.trim();
      if (!text) continue;
      const base = { kind: KINDS.includes(it.kind) ? it.kind : "speech", text, en: String(it.en || "").trim(), speaker: typeof it.speaker === "string" && it.speaker.trim() ? it.speaker.trim() : null, keep: it.keep === true };
      const ns = named.filter((n) => byN.has(n) && !used.has(n));
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
    return [its.slice(0, at + 1), its.slice(at + 1)].map((part) => ({ ...partOf(part, section, width, H), depth: (section.depth || 0) + 1 })); // (depth: how many times it has been tried again)
  }
  // may a refused part be tried again in two parts: it has more than one item to split, and has not been tried again `retries` times already
  const splitsAgain = (section, retries = MAX_RETRIES) => section.items.length > 1 && (section.depth || 0) < retries;

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
      : fillText(opts.prompt || DRAW_TEXT, promptVars(section.items.length, opts)) + "\n" + list;
    const model = opts.model || DRAW_MODEL, quality = opts.quality || (model === DRAW_MODEL ? DRAW_QUALITY : "");
    return { model, prompt, input_references: [{ type: "image_url", image_url: { url: picture } }], aspect_ratio: "auto", resolution: opts.resolution || "1K", ...(quality ? { quality } : {}) };
  }

  // What an image model's answer says when it holds no picture (a refusal can come back as a 200 with its reason, or some text, where the picture should be)
  function noPictureWhy(answer) {
    if (!answer || typeof answer !== "object") return "";
    const bits = [];
    const e = answer.error;
    if (e) bits.push(typeof e === "string" ? e : e.message || JSON.stringify(e));
    const d = answer.data && answer.data[0];
    if (d && d.revised_prompt) bits.push("revised prompt: " + d.revised_prompt);
    const m = answer.choices && answer.choices[0];
    if (m) {
      if (m.finish_reason) bits.push("finish: " + m.finish_reason);
      const c = m.message && m.message.content;
      if (typeof c === "string" && c.trim()) bits.push(c.trim());
    }
    if (!bits.length) bits.push(JSON.stringify(answer, (k, v) => (typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v)).slice(0, 300));
    return ": " + bits.join(" · ").slice(0, 400);
  }

  // a PNG data: URL's width over its height (read from its header), or 0
  function pngRatio(url) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]{32,})/.exec(String(url || ""));
    if (!m) return 0;
    try {
      const s = atob(m[1].slice(0, 32));
      if (s.charCodeAt(1) !== 80) return 0;
      const u32 = (o) => ((s.charCodeAt(o) << 24) | (s.charCodeAt(o + 1) << 16) | (s.charCodeAt(o + 2) << 8) | s.charCodeAt(o + 3)) >>> 0;
      const w = u32(16), h = u32(20);
      return w && h ? w / h : 0;
    } catch (e) { return 0; }
  }
  // A drawing request that an image model's providers will not take as it is ("No provider for X supports the requested parameter(s): resolution "1K", aspect_ratio "auto",
  // input_references (1 items). Provider rejections: Krea: aspect_ratio: not supported. Accepted: 1:1, 4:3, ..."): OpenRouter lists a model as taking a picture in, but each model's
  // providers take their own parameters. -> { body }: the request without what they refuse (an aspect ratio they list is the nearest to the picture's own); { unsupported }: the picture
  // cannot be given to it, so it cannot draw on one (for the next model of the rules); null: not that error, or nothing to change.
  function fitDraw(send, message) {
    const m = String(message || "");
    if (!/supports? the requested parameter/i.test(m)) return null;
    const list = (/requested parameter\(s\):(.*?)(?:\.\s|\.$|$)/i.exec(m) || [])[1] || "";
    const names = [...list.matchAll(/([a-z_]+)\s*(?:"|\()/gi)].map((x) => x[1]);
    if (names.includes("input_references")) return { unsupported: "cannot draw on a picture (it takes no picture in)" };
    const out = Object.assign({}, send);
    let changed = false;
    for (const n of names) {
      if (!(n in out)) continue;
      if (n === "aspect_ratio") {
        const accepted = ((/Accepted:\s*([0-9:,\s]+)/i.exec(m) || [])[1] || "").split(",").map((x) => x.trim()).filter((x) => /^\d+:\d+$/.test(x));
        const first = send.input_references && send.input_references[0] && send.input_references[0].image_url;
        const ratio = pngRatio(first && first.url);
        if (accepted.length && ratio) out.aspect_ratio = accepted.map((a) => ({ a, d: Math.abs(Math.log(ratio / (a.split(":")[0] / a.split(":")[1]))) })).sort((p, q) => p.d - q.d)[0].a;
        else delete out.aspect_ratio;
      } else delete out[n];
      changed = true;
    }
    return changed ? { body: out } : null;
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
  // text (optional): { own, others }, boxes in the region: own, the item's lines (its letters are the groups whose middle is in one); others, the text of the other
  // items round it (a group whose middle is in one and in none of own is theirs, never taken: an item whose box ran over a bubble beside it erased that bubble's English)
  // The paper is the commonest colour in the box, unless that is the letters' own: big bold letters on a gradient or over art (a title on a shaded label, black letters in a
  // see-through bubble) fill more of a tight box than any one shade of what is behind them. Then the "letters" found were the holes in them (the insides of ㅇ, ㅁ, ㅎ),
  // filled with the letters' colour: the old text stayed, in blobs, under the English. The paper is the colour round the letters: most of it is one patch round them
  // (a bubble's inside, or the page round a caption), where the letters' colour is many small ones, a stroke each. So when most of the commonest colour in the box is in
  // small patches, the next colours are tried, and the one most in big patches is the paper.
  function letters(data, w, h, box, text = {}) {
    const bx0 = Math.max(0, box.x0), by0 = Math.max(0, box.y0), bx1 = Math.min(w, box.x1), by1 = Math.min(h, box.y1);
    const bins = new Map();
    let best = null;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const i = (y * w + x) * 4, k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      let e = bins.get(k);
      if (!e) bins.set(k, (e = { n: 0, sum: [0, 0, 0] }));
      e.n++; e.sum[0] += data[i]; e.sum[1] += data[i + 1]; e.sum[2] += data[i + 2];
      if (!best || e.n > best.n) best = e;
    }
    if (!best) return { plain: false };
    // (each colour: the mean of its bin)
    const colourOf = (e) => e.sum.map((v) => Math.round(v / e.n));
    const first = lettersOn(data, w, h, box, text, colourOf(best));
    if (first.round >= 0.5) return first.found;
    const others = [];
    for (const e of [...bins.values()].sort((a, b) => b.n - a.n)) {
      const c = colourOf(e);
      if ([colourOf(best), ...others].every((o) => Math.max(Math.abs(o[0] - c[0]), Math.abs(o[1] - c[1]), Math.abs(o[2] - c[2])) > INK)) others.push(c);
      if (others.length >= 2) break;
    }
    let pick = first;
    for (const c of others) {
      const got = lettersOn(data, w, h, box, text, c);
      if (got.found.mask && got.round >= 0.5 && (pick === first || got.round > pick.round)) pick = got;
    }
    return pick.found;
  }

  // letters with the paper given -> { found: what letters gives, round: how much of the paper in the box is in a big patch (one that reaches the region's edge, or is half
  // the box or more) }. With the item's lines given, a group of ink is not followed further than half a line's height from them: letters touching art a shade off the paper
  // (a cloud on a label under a title) were one group with it, reaching the region's edge, and were never taken
  function lettersOn(data, w, h, box, text, paper) {
    const own = text.own || [], others = text.others || [];
    const bx0 = Math.max(0, box.x0), by0 = Math.max(0, box.y0), bx1 = Math.min(w, box.x1), by1 = Math.min(h, box.y1);
    const N = w * h, ink = new Uint8Array(N), group = new Int32Array(N).fill(-1), keep = [], groups = [];
    for (let p = 0; p < N; p++) ink[p] = near(data, p * 4, paper, INK) ? 0 : 1;
    let zone = null;
    if (own.length) {
      zone = new Uint8Array(N);
      for (const l of own) {
        const g = Math.max(4, Math.round(Math.min(l.x1 - l.x0, l.y1 - l.y0) * 0.5));
        const zx0 = Math.max(0, Math.floor(l.x0 - g)), zx1 = Math.min(w, Math.ceil(l.x1 + g));
        if (zx1 > zx0) for (let y = Math.max(0, Math.floor(l.y0 - g)); y < Math.min(h, Math.ceil(l.y1 + g)); y++) zone.fill(1, y * w + zx0, y * w + zx1);
      }
    }
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
    // how much of the paper in the box is in a big patch
    const seaSize = new Map(), seaOut = new Set();
    for (let p = 0; p < N; p++) {
      if (sea[p] < 0) continue;
      seaSize.set(sea[p], (seaSize.get(sea[p]) || 0) + 1);
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) seaOut.add(sea[p]);
    }
    let inBoxPaper = 0, inBig = 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const s = sea[y * w + x];
      if (s < 0) continue;
      inBoxPaper++;
      if (seaOut.has(s) || seaSize.get(s) >= (bx1 - bx0) * (by1 - by0) * 0.5) inBig++;
    }
    const round = inBoxPaper ? inBig / inBoxPaper : 0;
    for (let p0 = 0; p0 < N; p0++) {
      if (!ink[p0] || group[p0] >= 0 || (zone && !zone[p0])) continue;
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
            if (ink[q] && group[q] < 0 && (!zone || zone[q])) { group[q] = g; stack.push(q); } else if (!ink[q]) around.set(sea[q], (around.get(sea[q]) || 0) + 1);
          }
        }
      }
      const main = [...around.entries()].sort((a, b) => b[1] - a[1])[0];
      const gx = (minx + maxx) / 2, gy = (miny + maxy) / 2, at = (b) => gx >= b.x0 - 2 && gx < b.x1 + 2 && gy >= b.y0 - 2 && gy < b.y1 + 2;
      const mine = own.length ? own.some(at) : null, theirs = !mine && others.some(at);
      if (mine !== null) { inBox = mine; inMiddle = mine; }
      groups.push({ minx, maxx, miny, maxy, inBox, inMiddle, sea: main ? main[0] : -1, ok: !theirs && !edge && maxx - minx < w * 0.8 && maxy - miny < h * 0.8 });
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
    if (!any) return { found: { plain: false, paper }, round };
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
    // the columns of letters: runs of columns that hold some, apart by 2 or more (Japanese set down the page is a few columns of glyphs stacked one on another)
    let columns = 0;
    for (let x = x0, gap = 2; x <= x1 + 1; x++) {
      let has = false;
      for (let y = y0; y <= y1 && !has && x <= x1; y++) if (core[y * w + x]) has = true;
      if (has) { if (gap >= 2) columns++; gap = 0; } else gap++;
    }
    return { found: { lines, columns, plain: other > 0 && flatN / other >= 0.95 && lettered < (bx1 - bx0) * (by1 - by0) * 0.55, paper, ink: inkColour, mask, area, open, bbox: { x0, y0, x1: x1 + 1, y1: y1 + 1 } }, round };
  }

  // About how big the old letters were (px), for the English to be sized by: text across the page is as tall as a line (the letters' height over their lines); text set down the page
  // (a tall narrow box of a few columns, its glyphs stacked: a Japanese bubble) is as wide as a column, not as tall as its whole height (which sized it at 48 and turned away every
  // English sentence that would not fit the bubble that large). -> { size, vertical }
  function letterSize(found, lines = 1) {
    const b = found.bbox, bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0), columns = Math.max(1, found.columns || 1);
    const vertical = bh > 1.5 * bw && (found.lines || 0) >= 4 && columns <= 4 && found.lines >= 2.5 * columns;
    return { size: Math.min(48, ((vertical ? bw / columns : bh / Math.max(1, lines)) * 0.95)), vertical };
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
        width, height, heights, tops,
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

  // a pause for the page's other work (a task, not a timer: a hidden page's timers are slowed)
  const giveWay = () => new Promise((ok) => { if (typeof MessageChannel === "undefined") return setTimeout(ok, 0); const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); ok(); }; ch.port2.postMessage(0); });

  const dataUrl = async (canvas, type) => {
    const blob = await canvas.convertToBlob({ type, quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return "data:" + type + ";base64," + btoa(s);
  };

  // opts: ask(kind "read" | "draw", body) -> the answer's JSON (the caller sends it, paid as it says); from / into (language names); glossary [{ source, en }];
  // cast [names]; method, detect (above); reference: the novel's translation of this part (its lines), followed where the comic says the same; drawStyle: "list" for the image model's plainer prompt (drawBody); drawModel, drawQuality (OpenAI's GPT Image: "low" | "medium" | "high"; DRAW_MODEL at DRAW_QUALITY when not given); prompts { find, read, draw } (promptsFrom: the person's own text for a step); onDrawn({ cy0, cy1, y0, y1, items, sent, answer }): each image
  // model answer as it came, uncut, with the picture it was sent (data: URLs; for a test to look at). Pictures are made again only where something was drawn (null: as it was).
  // A part the model will not draw (the image model's moderation refused a part of the test chapter) is tried again in halves, down to an item; what is still refused
  // stays as it was, and is in `skipped` ({ y0, y1, why }) with its items still read; an error the caller marks `fatal` (no key, no tickets) stops it all.
  //
  // The steps run at once, down the strip (2026-11-07; before, each ran over the whole chapter before the next began, and nothing was shown until all of it was done):
  // finding goes on tile by tile; a reading request goes as soon as the lines of its chunks are found (one at a time, so each is sent the terms and speakers of
  // those before it); each answer is lettered and drawn while the next is read; and each picture is made as soon as everything that can reach it is done.
  //   onProgress({ step, done, of, counts })   step: the first step not finished ("finding" | "reading" | "drawing"), with its counts; counts: { finding, reading,
  //                                            drawing, pictures } each { done, of } (finding in tiles or chunks, reading and drawing in chunks)
  //   onPicture(i, blob)                       picture i made, as soon as it is; again if a later part reached it after all. Not called for a picture left as it was
  async function translate(sources, opts) {
    const { ask } = opts;
    const report = opts.onProgress || (() => {});
    const retries = opts.retries == null ? MAX_RETRIES : Math.max(0, Math.floor(opts.retries));
    // every failure, as it happens (a part tried again in halves is one too), for the caller's log: { step, y0, y1 (the strip's rows), message, status, error, note }
    const problem = (step, y0, y1, e, note) => { if (opts.onError) try { opts.onError({ step, y0, y1, message: String((e && e.message) || e), status: (e && e.status) || 0, error: e, note: note || "" }); } catch (e2) { /* the log is not the chapter's business */ } };
    // the parts running at once (finding, reading, drawing) wait on one another; one that fails for good (an error the caller marks fatal, Stop, a finder that broke) stops them all
    let halt = null, waiters = [];
    const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
    const fail = (e) => { if (!halt) halt = e || new Error("Stopped"); wake(); };
    if (opts.signal) opts.signal.addEventListener("abort", wake, { once: true });
    const stop = () => {
      if (opts.signal && opts.signal.aborted && !halt) halt = Object.assign(new Error("Stopped"), { fatal: true, stopped: true });
      if (halt) throw halt;
    };
    const until = async (ready) => { for (stop(); !ready(); stop()) await new Promise((ok) => waiters.push(ok)); };
    const strip = await Strip.of(sources);
    const flat = strip.flat();
    const list = chunks(flat, strip.width);
    const W = strip.width, H = strip.height;
    let cost = 0;
    const counted = (a) => { cost += (a && a.usage && Number(a.usage.cost)) || 0; return a; };
    // "full": where the text is from the text detector, tile by tile (opts.detect), or from a vision model (opts.findModel)
    const full = opts.method === "full";
    if (full && typeof opts.detect !== "function" && !opts.findModel) throw new Error("the full method needs a text finder (opts.detect, or opts.findModel)");
    // the tiers (the default): a plain item lettered here; text over art and sound effects drawn by the image model, taken back only around those items.
    // "all-flux": every section with text drawn by the image model and taken back whole (the first method, kept to compare with).
    const tiers = opts.method !== "all-flux";
    const skipped = []; // ({ y0, y1, why }: a part not found, read or drawn)
    const used = new Set();
    const counts = { finding: { done: 0, of: 0 }, reading: { done: 0, of: list.length }, drawing: { done: 0, of: list.length }, pictures: { done: 0, of: sources.length } };
    const tell = () => {
      // (nothing more once it has failed or been stopped: the finder's tile under way when the reading failed told its count after the failure, which took the failure's
      // place on the page, and the page said "Finding text 12 of 211…" for good)
      if (halt || (opts.signal && opts.signal.aborted)) return;
      const step = ["finding", "reading", "drawing"].find((s) => counts[s].done < counts[s].of) || "drawing";
      report({ step, done: counts[step].done, of: counts[step].of, counts: JSON.parse(JSON.stringify(counts)) });
    };
    if (tiers) {
      loaded = new Set();
      for (const f of opts.fonts || []) {
        try {
          const face = new FontFace(f.family, "url(" + f.url + ")", { weight: String(f.weight || 400) });
          (typeof document !== "undefined" ? document.fonts : self.fonts).add(await face.load());
          loaded.add(f.family);
        } catch (e) { /* the fallback fonts letter it */ }
      }
    }

    // ----- finding: the lines, numbered as they are settled (top to bottom), and the row above which every line is known (`upTo`) -----
    const found = { lines: [], upTo: full ? 0 : H, done: !full };
    const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    const same = (k, l) => { const ix = Math.min(k.x1, l.x1) - Math.max(k.x0, l.x0), iy = Math.min(k.y1, l.y1) - Math.max(k.y0, l.y0); return ix > 0 && iy > 0 && ix * iy > 0.5 * Math.min(area(k), area(l)); };
    let raw = []; // (the detector's lines near the frontier, every tile's, before they are merged)
    const settle = (frontier, fresh) => {
      frontier = Math.min(H, Math.max(found.upTo, frontier));
      const add = fresh.filter((l) => { const m = (l.y0 + l.y1) / 2; return m >= found.upTo && m < frontier && !found.lines.some((k) => k.y1 > l.y0 - W && same(k, l)); });
      for (const i of lineOrder(add)) { const l = add[i]; found.lines.push({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, n: found.lines.length + 1 }); } // (a bubble's lines numbered one after another)
      found.upTo = frontier;
      wake();
    };
    const finder = async () => {
      if (!full) return;
      if (typeof opts.detect !== "function") {
        // a vision model, chunk by chunk, a few at once (a slow model, GLM 5.3 Flash, thinks for minutes); a chunk it could not do has no lines (the reading still gives
        // the text it sees there, with a rough box). A chunk's boxes are those whose middle is in its core: settled in order as the chunks before are done.
        const byChunk = new Array(list.length);
        let next = 0, settled = 0;
        counts.finding.of = list.length;
        tell();
        const worker = async () => {
          while (next < list.length) {
            stop();
            const k = next++;
            try {
              const picture = await dataUrl(strip.crop(list[k].y0, list[k].y1), "image/jpeg");
              byChunk[k] = boxesOf(counted(await ask("find", findBody(picture, { model: opts.findModel, from: opts.from, into: opts.into, prompts: opts.prompts }))), list, k, strip.width);
            } catch (e) {
              stop(); // (Stop while a request was out: not a failure of it)
              if (e && e.fatal) throw e;
              problem("find", list[k].y0, list[k].y1, e, "no boxes from this part");
              skipped.push({ y0: list[k].y0, y1: list[k].y1, why: "find: " + String((e && e.message) || e) });
              byChunk[k] = [];
            }
            counts.finding.done++;
            while (settled < list.length && byChunk[settled]) { settle(coreOf(list, settled)[1], mergeLines(byChunk[settled])); settled++; }
            tell();
          }
        };
        await Promise.all(Array.from({ length: Math.min(FIND_AT_ONCE, list.length) }, worker));
      } else {
        // the detector, tile by tile down the strip: after a tile, a line whose middle is above half way down it lies whole in a tile done (one up to a width tall)
        const tiles = tilesOf(W, H);
        counts.finding.of = tiles.length;
        tell();
        for (let t = 0; t < tiles.length; t++) {
          stop();
          const y0 = tiles[t], h = Math.min(W, H - y0), s = detectScale(W), side = detectSideOf(W);
          const cv = new OffscreenCanvas(side, side), x = cv.getContext("2d", { willReadFrequently: true });
          x.fillStyle = "#000";
          x.fillRect(0, 0, side, side);
          x.drawImage(strip.crop(y0, y0 + h), 0, 0, W * s, h * s);
          const map = await opts.detect(x.getImageData(0, 0, side, side).data, side);
          await giveWay(); // (a detector on this thread answers with no pause between tiles: the reading's answers, the lettering and the messages are let through)
          raw.push(...linesOfTile(map, side, s, y0, W, h, { first: y0 === 0, last: y0 + h >= H }));
          raw = raw.filter((l) => l.y1 > found.upTo - W); // (lines long settled are not looked at again)
          counts.finding.done = t + 1;
          settle(t + 1 < tiles.length ? y0 + W / 2 : H, mergeLines(raw));
          tell();
        }
      }
      settle(H, []);
      found.done = true;
      wake();
    };
    // a chunk with its lines boxed and numbered on it, as the reading sees it (its lines taken by claimLines first)
    const marked = (k) => {
      const c = list[k], cv = strip.crop(c.y0, c.y1), x = cv.getContext("2d");
      x.lineWidth = 2;
      x.font = "bold 15px Arial, sans-serif";
      x.textBaseline = "top";
      const mine = found.lines.filter((l) => l.k === k), near = found.lines.filter((l) => l.y1 > c.y0 && l.y0 < c.y1);
      // (each tag where it covers no letters, on the edge of its own box: preferably above its first letter. One left of the box with no check sat at the end of
      // the box before it, and two buttons side by side were read swapped; that place is now taken only where it touches no other box)
      const spots = tagSpots(mine, near, (l) => x.measureText(String(l.n)).width + 6, 17, { x0: 0, y0: c.y0, x1: W, y1: c.y1 }, typeof opts.detect === "function" ? unclipOf : undefined);
      // the lines another chunk reads (the overlap with the chunks before and after) covered with plain grey. Shown as text with no tag, a bubble was given as text the
      // finder missed, with a rough box of the reading's that was far off, and its tagged lines in the other chunk went unused: its English lettered over the art
      // somewhere else, the original left in the bubble (mh160mh.com, 2026-11-26)
      x.fillStyle = OTHERS_GREY;
      for (const l of near) if (l.k !== k) x.fillRect(l.x0, l.y0 - c.y0, l.x1 - l.x0, l.y1 - l.y0);
      x.strokeStyle = "rgba(255, 0, 200, 0.9)";
      for (const l of mine) x.strokeRect(l.x0, l.y0 - c.y0, l.x1 - l.x0, l.y1 - l.y0);
      mine.forEach((l, i) => {
        const s = spots[i];
        x.fillStyle = "rgba(255, 0, 200, 0.95)";
        x.fillRect(s.x, s.y - c.y0, s.w, s.h);
        x.fillStyle = "#fff";
        x.fillText(String(l.n), s.x + 3, s.y - c.y0 + 1);
      });
      return cv;
    };

    // ----- drawing: each part read is lettered and drawn while the next is read; a few sections at once, from every part -----
    const items = [], drawn = [];
    const drawQueue = [];
    let drawing = 0;
    const pump = () => {
      while (!halt && drawing < DRAW_AT_ONCE && drawQueue.length) {
        const task = drawQueue.shift();
        drawing++;
        drawOne(task).catch(fail).finally(() => { drawing--; if (--task.group.left === 0) task.group.done(); pump(); });
      }
    };
    const drawSections = (secs) => new Promise((done) => {
      if (!secs.length) return done();
      const group = { left: secs.length, done };
      for (const s of secs) drawQueue.push({ s, group });
      pump();
    });
    async function drawOne({ s, group }) {
      stop();
      try {
        const rows = strip.crop(s.cy0, s.cy1);
        const sent = await dataUrl(rows, "image/png");
        const answer = counted(await ask("draw", drawBody(s, sent, { width: W, from: opts.from, into: opts.into, model: opts.drawModel, style: opts.drawStyle, quality: opts.drawQuality, prompt: opts.prompts && opts.prompts.draw })));
        const url = drawnOf(answer);
        if (!url) throw new Error("the drawing came back with no picture" + noPictureWhy(answer));
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        if (opts.onDrawn) opts.onDrawn({ cy0: s.cy0, cy1: s.cy1, y0: s.y0, y1: s.y1, items: s.items.map((it) => ({ x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1, text: it.text, en: it.en })), sent, answer: url });
        drawn.push({ y0: s.y0, y1: s.y1, cy0: s.cy0, cy1: s.cy1, bitmap, ...(tiers ? { mask: aroundItems(s, rows, bitmap, W), layer: 0 } : {}) });
        for (const it of s.items) { it.method = "drawn"; it.via = answer && answer._via; } // (which model drew it: the caller's ask puts it on its answer, for the log)
      } catch (e) {
        stop();
        if (e && e.fatal) throw e;
        const again = splitsAgain(s, retries);
        problem("draw", s.y0, s.y1, e, again ? "tried again in two parts (retry " + ((s.depth || 0) + 1) + " of " + retries + ")" : s.items.length > 1 ? "gave up after " + retries + " retries; left as it was" : "left as it was");
        // refused as a whole: in halves, with less of the art round each (the test chapter's refused part was a phone screen and a bubble that passed alone)
        if (again) { const halves = halvesOf(s, W, H); group.left += halves.length; for (const h of halves) drawQueue.push({ s: h, group }); } // (and each half in two again, up to `retries` times)
        else skipped.push({ y0: s.y0, y1: s.y1, why: "draw: " + String((e && e.message) || e) });
      }
    }
    // one part's items: lettered here, the rest drawn, and what the drawing left lettered over
    async function drawPart(got) {
      const pen = new OffscreenCanvas(8, 8).getContext("2d");
      let toDraw = got;
      if (tiers) {
        toDraw = [];
        for (const it of got) {
          stop();
          if (it.keep || !it.en || it.en.replace(/\s+/g, " ").trim() === it.text.replace(/\s+/g, " ").trim()) { it.method = "kept"; continue; } // (nothing to change: "tls123", "0", a watermark)
          // lettered here: speech, thought, narration; with the detector's exact lines, a screen's too (its numbers then stay as they were written, not as the image
          // model redraws them); sound effects always go to the image model
          // (opts.letter: "first" (the default), "after" (a model draws everything, this only what it failed) or "never": Settings › Model rules, the drawing's Lettered here row)
          // ("after": made in this pass all the same, and held back: the model's drawing is what shows, this only where the model failed or refused)
          const here = opts.letter !== "never" && (it.kind === "speech" || it.kind === "thought" || it.kind === "narration" || (it.located && it.kind === "screen"));
          const piece = here && (await letterHere(strip, it, pen, opts));
          if (piece && opts.letter === "after") { it.held = piece; toDraw.push(it); }
          else if (piece) { drawn.push(piece); it.method = "lettered here"; }
          else toDraw.push(it);
        }
      }
      // (opts.draw false: no model is in the rules: none is asked; what was left for one is not drawn, and the lettering over a patch below may still do the text)
      if (opts.draw === false) for (const s of sections(flat, W, toDraw)) skipped.push({ y0: s.y0, y1: s.y1, why: "draw: no model asked (none in the rules, or Lettered here is first)" });
      else await drawSections(sections(flat, W, toDraw));
      stop();
      // the parts still in the original language because drawing did not do them (speech, thoughts, narration and screens; a sound effect is art, and is left): lettered over
      if (!tiers || opts.letter === "never") return;
      // the English of each bubble the drawing left, planned first, then kept off the others (a small bubble moves little, a big one most), then drawn
      const plans = [], patches = [];
      for (const it of toDraw) {
        if (it.kind === "sfx" || it.method === "drawn") continue;
        if (it.held) { drawn.push(it.held); it.method = "lettered here"; it.fallback = true; continue; } // (the lettering made in the first pass, kept for this)
        const plan = await planOver(strip, it, pen, items).catch(() => null);
        if (plan) plans.push(plan); else patches.push(it);
      }
      settlePlans(plans, items, strip);
      for (const plan of plans) {
        const piece = (await renderOver(plan, pen).catch(() => null)) || (await letterPatch(strip, plan.it, pen).catch(() => null));
        if (piece) { for (const pc of [].concat(piece)) drawn.push(pc); plan.it.fallback = true; plan.it.method = "patch"; }
      }
      for (const it of patches) {
        const piece = await letterPatch(strip, it, pen).catch(() => null);
        if (piece) { drawn.push(piece); it.fallback = true; it.method = "patch"; }
      }
    }

    // ----- the pictures, each made as soon as every part that can reach it is done: the parts are done in reading order down to a row, and a picture is made when
    // that row is a width below it (a bubble read in the next part reaches up into the picture above by less than that); one a later part reached all the same is made again at the end -----
    const parts = []; // (each part read, in reading order: { bottom, done })
    const given = new Array(sources.length).fill(null); // ({ pieces, blob }: what was made of picture i, and how many pieces reached it then)
    const piecesOn = (i) => drawn.filter((d) => strip.touches(i, [d])).length;
    const give = async (i) => {
      const pieces = piecesOn(i), blob = pieces ? await strip.picture(i, drawn) : null;
      const again = !!given[i];
      given[i] = { pieces, blob };
      if (!again) counts.pictures.done++;
      if (blob && opts.onPicture) try { opts.onPicture(i, blob); } catch (e) { /* the caller's business */ }
    };
    let giving = Promise.resolve();
    const giveReady = () => {
      giving = giving.then(async () => {
        let upTo = 0;
        for (const p of parts) { if (!p.done) break; upTo = p.bottom; }
        for (let i = 0; i < sources.length; i++) {
          if (given[i]) continue;
          if (strip.tops[i] + strip.heights[i] + W > upTo && upTo < H) break;
          await give(i);
        }
        tell();
      }).catch(fail);
      return giving;
    };

    // ----- reading, READ_BATCH chunks a request (the first READ_FIRST, so the first pictures come sooner), one at a time: the speakers and terms found so far go with the next one.
    // A request that fails (an answer that was not JSON or came back empty, a provider failing on a picture) is tried again in two halves, down `retries` times as a drawing is,
    // and a part that cannot be cut again once more after a pause; only what is still not read is left (in `skipped`, "read: ..."; unreadOf names its pictures). Past two
    // failed requests for each first one and READ_FAILS more, nothing is tried again. (Until 2026-11-07 a failed request was asked once more at once and then its 10
    // chunks, about 6 of a webtoon's pictures, were left with no text.)
    const terms = [], cast = new Set(opts.cast || []);
    const glossary = (opts.glossary || []).slice();
    const queue = [];
    for (let i = 0; i < list.length; ) { const n = i === 0 ? READ_FIRST : READ_BATCH; queue.push({ ids: list.slice(i, i + n).map((_, j) => i + j), depth: 0 }); i += n; }
    let readFails = 0;
    const readBudget = READ_FAILS + 2 * queue.length;
    const partDone = (ids, got) => {
      const part = { bottom: coreOf(list, ids[ids.length - 1])[1], done: false };
      parts.push(part);
      drawPart(got).then(() => { part.done = true; counts.drawing.done += ids.length; wake(); return giveReady(); }).catch(fail);
    };
    const reading = async () => {
      while (queue.length) {
        stop();
        const part = queue.shift(), ids = part.ids;
        // (the lines of its chunks all found, down to the last one's end: a bubble across its core's end goes whole to one chunk or the other)
        await until(() => found.done || found.upTo >= (full ? list[ids[ids.length - 1]].y1 : coreOf(list, ids[ids.length - 1])[1]));
        if (full) for (const k of ids) claimLines(list, k, found.lines);
        const pictures = [];
        for (const k of ids) pictures.push(await dataUrl(full ? marked(k) : strip.crop(list[k].y0, list[k].y1), "image/jpeg"));
        const say = { from: opts.from, into: opts.into, glossary, cast: [...cast], model: opts.readModel, reference: opts.reference, prompts: opts.prompts };
        let got;
        try {
          got = full
            ? readMarked(counted(await ask("read", markedReadBody(pictures, ids.map((k) => linesIn(list, k, found.lines, W)), say))), list, ids, W, found.lines, used)
            : readItems(counted(await ask("read", readBody(pictures, say))), list, ids, W);
        } catch (e) {
          stop();
          if (e && e.fatal) throw e;
          const y0 = coreOf(list, ids[0])[0], y1 = coreOf(list, ids[ids.length - 1])[1];
          const more = ++readFails < readBudget;
          const split = more && ids.length > 1 && part.depth < retries, again = more && !split && !part.again;
          problem("read", y0, y1, e, split ? "tried again in two parts (retry " + (part.depth + 1) + " of " + retries + ")" : again ? "tried again in a moment" : "these pictures were not read");
          if (split) { const h = Math.ceil(ids.length / 2); queue.unshift({ ids: ids.slice(0, h), depth: part.depth + 1 }, { ids: ids.slice(h), depth: part.depth + 1 }); }
          else if (again) { await new Promise((ok) => setTimeout(ok, READ_PAUSE)); queue.unshift(Object.assign({}, part, { again: true })); }
          else { skipped.push({ y0, y1, why: "read: " + String((e && e.message) || e) }); counts.reading.done += ids.length; partDone(ids, []); tell(); }
          continue;
        }
        counts.reading.done += ids.length;
        items.push(...got.items);
        for (const t of got.terms) if (!terms.some((x) => x.source === t.source)) { terms.push(t); glossary.push(t); }
        for (const it of got.items) if (it.speaker) cast.add(it.speaker);
        partDone(ids, got.items);
        tell();
      }
    };

    const finding = finder().catch((e) => { fail(e); throw e; });
    finding.catch(() => {}); // (its failure is the chapter's: thrown below)
    try {
      await reading();
      await finding;
      await until(() => parts.every((p) => p.done));
      await giveReady();
      stop();
    } catch (e) {
      fail(e);
      throw halt;
    }
    for (const it of items) if (!it.method) it.method = it.keep || !it.en ? "kept" : "not drawn"; // (how each piece of text was done: methodsOf says it for the log)
    // (a picture made before a later part reached it, made again: the caller is given it again)
    for (let i = 0; i < sources.length; i++) if (!given[i] || given[i].pieces !== piecesOn(i)) await give(i);
    tell();
    const pictures = given.map((g) => g.blob);
    // What the image model made, as it made it (opts.keepRaw): each part it drew, all the rows it was sent, over the original, with no mask and none of the lettering done here. To look at
    // what the model did (what it changed, what it refused) apart from how it was put back round the text. null where it drew nothing.
    let rawPictures = null;
    if (opts.keepRaw) {
      const rawDrawn = drawn.filter((d) => d.layer === 0 && d.mask && d.bitmap).map((d) => ({ cy0: d.cy0, cy1: d.cy1, y0: d.cy0, y1: d.cy1, bitmap: d.bitmap, layer: 0 }));
      rawPictures = [];
      for (let i = 0; i < sources.length; i++) rawPictures.push(strip.touches(i, rawDrawn) ? await strip.picture(i, rawDrawn) : null);
    }
    return { pictures, rawPictures, items, terms, cost, skipped, lettered: drawn.filter((d) => d.layer === 1).length };
  }

  // Where a section's drawing is taken back: only the pixels the drawing changed (the old letters gone, the English there), within a room round each item.
  // (Taking back the whole room put the model's redrawing of the art in it over the page's own: lines doubled and went soft across a building, a hallway, a sky;
  // and a room sized by the old letters cut the English off where it is wider, as a tall Japanese column gives a narrow room: "enior, how was it?".)
  // orig, drawn: RGBA of the rows sent and of the drawing taken to the same size; bound: 1 inside the rooms. A pixel changed is one that no pixel within `radius` of
  // the same place in the other picture is like (a line the model drew a pixel or two off is not a change; a letter where there was paper is); the changed
  // pixels grown by `grow`, for the letters' soft edges. -> Uint8Array, 1 where the drawing is taken back
  function changedPixels(orig, drawn, w, h, bound, opts = {}) {
    const radius = opts.radius || 2, tolerance = opts.tolerance || 48, grow = opts.grow == null ? 3 : opts.grow;
    const N = w * h, lo = new Uint8Array(N), ld = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      if (!bound[p]) continue;
      lo[p] = (orig[p * 4] * 77 + orig[p * 4 + 1] * 150 + orig[p * 4 + 2] * 29) >> 8;
      ld[p] = (drawn[p * 4] * 77 + drawn[p * 4 + 1] * 150 + drawn[p * 4 + 2] * 29) >> 8;
    }
    // is a pixel of `a` (at x, y) unlike every pixel of `b` within the radius
    const unlike = (a, b, x, y) => {
      const v = a[y * w + x];
      for (let dy = Math.max(0, y - radius); dy <= Math.min(h - 1, y + radius); dy++) for (let dx = Math.max(0, x - radius); dx <= Math.min(w - 1, x + radius); dx++) {
        if (Math.abs(v - b[dy * w + dx]) <= tolerance) return false;
      }
      return true;
    };
    const hit = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (bound[p] && Math.abs(lo[p] - ld[p]) > tolerance && (unlike(ld, lo, x, y) || unlike(lo, ld, x, y))) hit[p] = 1;
    }
    if (!grow) return hit;
    // grown by `grow` (a square, across and then down)
    const across = new Uint8Array(N), out = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hit[y * w + x]) for (let k = Math.max(0, x - grow); k <= Math.min(w - 1, x + grow); k++) across[y * w + k] = 1;
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (across[y * w + x]) for (let k = Math.max(0, y - grow); k <= Math.min(h - 1, y + grow); k++) out[k * w + x] = 1;
    return out;
  }

  // the rooms an item's English may be drawn in: its box grown across by a third (by most of its height when it is a tall column, Japanese set down the page:
  // the English runs across) and down by half; a sound effect, drawn bigger than it was, by more
  function roomsOf(items, w, h, top) {
    const bound = new Uint8Array(w * h);
    for (const it of items) {
      const bw = it.x1 - it.x0, bh = it.y1 - it.y0, big = it.kind === "sfx" ? 1.6 : 1;
      const gx = Math.round(Math.max(24, bw * 0.35 * big, bh > bw ? (bh - bw) * 0.6 : 0)), gy = Math.round(Math.max(16, bh * 0.5 * big));
      const x0 = Math.max(0, it.x0 - gx), x1 = Math.min(w, it.x1 + gx), y0 = Math.max(0, it.y0 - gy - top), y1 = Math.min(h, it.y1 + gy - top);
      for (let y = y0; y < y1; y++) bound.fill(1, y * w + x0, y * w + x1);
    }
    return bound;
  }

  // in a browser: a section's drawing as a mask canvas over the rows sent (cy0 to cy1), `rows` being those rows of the strip
  function aroundItems(s, rows, bitmap, width) {
    const h = s.cy1 - s.cy0;
    const o = rows.getContext("2d").getImageData(0, 0, width, h).data;
    const dc = new OffscreenCanvas(width, h), dx = dc.getContext("2d", { willReadFrequently: true });
    dx.drawImage(bitmap, 0, 0, width, h);
    const took = changedPixels(o, dx.getImageData(0, 0, width, h).data, width, h, roomsOf(s.items, width, h, s.cy0), { radius: Math.max(2, Math.round(width / 400)) });
    const m = new OffscreenCanvas(width, h), mx = m.getContext("2d"), md = mx.createImageData(width, h);
    for (let p = 0; p < width * h; p++) if (took[p]) md.data[p * 4 + 3] = 255;
    mx.putImageData(md, 0, 0);
    const soft = new OffscreenCanvas(width, h), sx = soft.getContext("2d");
    sx.filter = "blur(1px)";
    sx.drawImage(m, 0, 0);
    return soft;
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
  // Break words into lines no wider than maxW, the lines as even as they can be (the least slack squared over every line but the last): a block that fills its box as the old
  // text did, not one line as long as it can be and the next a word. widths: each word's width; space: a space's. -> [[word index, ...], ...] or null (a word wider than maxW)
  function balancedLines(widths, space, maxW) {
    const n = widths.length;
    if (!n || widths.some((w) => w > maxW)) return null;
    const best = new Array(n + 1).fill(Infinity), next = new Array(n + 1).fill(n);
    best[n] = 0;
    for (let i = n - 1; i >= 0; i--) {
      let width = -space;
      for (let j = i; j < n; j++) {
        width += space + widths[j];
        if (width > maxW) break;
        const cost = (j === n - 1 ? 0 : (maxW - width) ** 2) + best[j + 1];
        if (cost < best[i]) { best[i] = cost; next[i] = j + 1; }
      }
    }
    const out = [];
    for (let i = 0; i < n; i = next[i]) out.push(words_range(i, next[i]));
    return out;
  }
  const words_range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

  // The English in a box: the largest size (maxSize down to minSize) whose balanced lines fit the box's width and height, lines `lead` apart. measure(text, size) -> width.
  // -> { size, lead, lines: [text] } or null when not even minSize fits
  function fitBoxText(words, w, h, measure, minSize, maxSize, lead = 1.16) {
    for (let size = Math.round(maxSize); size >= minSize; size--) {
      const widths = words.map((t) => measure(t, size)), space = measure(" ", size);
      const lines = balancedLines(widths, space, w);
      if (lines && lines.length * size * lead <= h) return { size, lead, lines: lines.map((ix) => ix.map((i) => words[i]).join(" ")) };
    }
    return null;
  }

  // Fill the masked pixels of RGBA data from the pixels round them, in rings from the edge in, each the mean of its known neighbours (8 round): the old letters taken out of the art
  // as a smooth patch of what was beside them. data is changed in place; mask: 1 where to fill.
  function fillMasked(data, w, h, mask) {
    const N = w * h, known = new Uint8Array(N), queued = new Uint8Array(N);
    for (let p = 0; p < N; p++) known[p] = mask[p] ? 0 : 1;
    const each = (p, f) => {
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) f(ny * w + nx);
      }
    };
    let ring = [];
    for (let p = 0; p < N; p++) {
      if (known[p]) continue;
      let touches = false;
      each(p, (q) => { if (known[q]) touches = true; });
      if (touches) { ring.push(p); queued[p] = 1; }
    }
    while (ring.length) {
      const vals = ring.map((p) => {
        let r = 0, g = 0, b = 0, n = 0;
        each(p, (q) => { if (known[q]) { r += data[q * 4]; g += data[q * 4 + 1]; b += data[q * 4 + 2]; n++; } });
        return [r / n, g / n, b / n];
      });
      ring.forEach((p, i) => { data[p * 4] = vals[i][0]; data[p * 4 + 1] = vals[i][1]; data[p * 4 + 2] = vals[i][2]; data[p * 4 + 3] = 255; });
      ring.forEach((p) => { known[p] = 1; });
      const next = [];
      ring.forEach((p) => each(p, (q) => { if (!known[q] && !queued[q]) { queued[q] = 1; next.push(q); } }));
      ring = next;
    }
  }

  // Move boxes apart that sit on one another, and cut back what cannot be moved. boxes: [{ cx, cy, w, h, m (mobility: 0 stays where it is, 1 moves most), reach: { x0, y0, x1, y1 } (the
  // box stays inside it) }]. Each pair that overlaps (with `gap` between) is pushed apart along the side it overlaps least, each by its share of the two mobilities (a small bubble gives
  // little, a big one most); what is still on another when a box is held by its reach is cut back, the more mobile one giving up the edge that faces the other. Changes the boxes in place.
  function separateBoxes(boxes, bounds, rounds = 80, gap = 6) {
    const pen = (a, b) => ({
      dx: Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2) + gap,
      dy: Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2) + gap
    });
    const keep = (b) => { // (inside its reach, and the strip)
      const lim = b.reach || { x0: 0, y0: 0, x1: bounds.w, y1: bounds.h };
      const x0 = Math.max(0, lim.x0), x1 = Math.min(bounds.w, lim.x1), y0 = Math.max(0, lim.y0), y1 = Math.min(bounds.h, lim.y1);
      b.cx = x1 - x0 <= b.w ? (x0 + x1) / 2 : Math.max(x0 + b.w / 2, Math.min(x1 - b.w / 2, b.cx));
      b.cy = y1 - y0 <= b.h ? (y0 + y1) / 2 : Math.max(y0 + b.h / 2, Math.min(y1 - b.h / 2, b.cy));
    };
    for (let k = 0; k < rounds; k++) {
      let moved = false;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j], total = a.m + b.m;
        if (!total) continue;
        const { dx, dy } = pen(a, b);
        if (dx <= 0 || dy <= 0) continue;
        const across = dx < dy, amount = across ? dx : dy, dir = (across ? a.cx >= b.cx : a.cy >= b.cy) ? 1 : -1;
        if (across) { a.cx += dir * amount * (a.m / total); b.cx -= dir * amount * (b.m / total); } else { a.cy += dir * amount * (a.m / total); b.cy -= dir * amount * (b.m / total); }
        moved = true;
      }
      for (const b of boxes) if (b.m) keep(b);
      if (!moved) break;
    }
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j], { dx, dy } = pen(a, b);
      if (dx <= 0 || dy <= 0) continue;
      const g = a.m >= b.m ? a : b, o = g === a ? b : a;
      if (!g.m) continue;
      if (dx < dy) { const cut = Math.min(dx, g.w - 40); if (cut > 0) { g.w -= cut; g.cx += (g.cx >= o.cx ? 1 : -1) * cut / 2; } }
      else { const cut = Math.min(dy, g.h - 30); if (cut > 0) { g.h -= cut; g.cy += (g.cy >= o.cy ? 1 : -1) * cut / 2; } }
    }
    for (const b of boxes) if (b.m) keep(b);
    return boxes;
  }

  // The English over the art where a bubble could not be lettered (not one flat colour: art, a screentone, a sign): only the old letters are taken out (filled from what is round them),
  // and the English is written with no background, an outline round it to be read on anything. Where it is wider than the bubble it covers nothing, as a patch would.
  // planOver finds the letters and the area the English fills (the old text's own, grown the least a readable size needs) -> a plan, or null when the letters cannot be found or the
  // English does not fit; renderOver draws it (once the plans of a page have been kept off one another: plan.rect may have moved or shrunk) -> two pieces (the erase, over the picture
  // through the letters' mask; the text, on a transparent background), or null
  // items: the page's others (their text is not this one's to erase; optional)
  async function planOver(strip, it, pen, items = []) {
    const gx = Math.max(24, Math.round((it.x1 - it.x0) * 0.4)), gy = Math.max(24, Math.round((it.y1 - it.y0) * 0.4));
    const r = { x0: Math.max(0, it.x0 - gx), y0: Math.max(0, it.y0 - gy), x1: Math.min(strip.width, it.x1 + gx), y1: Math.min(strip.height, it.y1 + gy) };
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w < 16 || h < 12) return null;
    const rows = strip.crop(r.y0, r.y1), cv = new OffscreenCanvas(w, h), x = cv.getContext("2d", { willReadFrequently: true });
    x.drawImage(rows, -r.x0, 0);
    const before = x.getImageData(0, 0, w, h);
    const found = letters(before.data, w, h, { x0: it.x0 - r.x0, y0: it.y0 - r.y0, x1: it.x1 - r.x0, y1: it.y1 - r.y0 }, textNear(it, items, r));
    if (!found.mask || !found.bbox) return null;
    const { weight, family, caps } = faceOf(it.kind);
    const lines = Math.max(1, it.text.split("\n").length), sized = letterSize(found, lines);
    const measure = (t, size) => { pen.font = weight + " " + size + "px " + family; return pen.measureText(t).width; };
    // The English fills the area the old text did (its box, a little over): the largest size whose balanced lines fit it. A box too narrow for a readable size (a column of vertical text)
    // is grown, the least that gives the size the old letters had (nothing is covered, so it may stick out); the strip's width at most.
    const b = found.bbox, cx = r.x0 + (b.x0 + b.x1) / 2, cy = r.y0 + (b.y0 + b.y1) / 2, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const words = (caps ? it.en.toUpperCase() : it.en).replace(/\n+/g, " ").split(/\s+/).filter(Boolean);
    const want = Math.min(32, Math.max(14, sized.size * 0.9));
    const tries = [];
    for (const wm of sized.vertical ? [1.06, 1.4, 1.8, 2.3, 3] : [1.06, 1.3, 1.6]) for (const hm of [1.06, 1.25, 1.5]) tries.push({ wm, hm, grow: wm * hm });
    tries.sort((p, q) => p.grow - q.grow);
    let best = null;
    for (const tr of tries) {
      const rw = Math.round(Math.min(strip.width, Math.max(60, bw * tr.wm))), rh = Math.round(Math.max(40, bh * tr.hm));
      const f = fitBoxText(words, rw, rh, measure, 10, 44);
      if (f && (!best || f.size > best.f.size)) best = { f, rw, rh };
      if (f && f.size >= want) { best = { f, rw, rh }; break; } // (the smallest growth that gives the size wanted)
    }
    if (!best) return null;
    // how far it may move to keep off the others: the old text's own box, and more of its own width than height (big ones have room to give)
    const reach = { x0: cx - bw * 0.9 - 10, x1: cx + bw * 0.9 + 10, y0: cy - bh * 0.5 - 10, y1: cy + bh * 0.5 + 10 };
    return { it, r, w, h, before, found, face: { weight, family, caps }, words, fit: best.f, rect: { cx, cy, w: best.rw, h: best.rh }, reach, refit: false, canvas: cv };
  }

  async function renderOver(plan, pen) {
    const { it, r, w, h, before, found, face, rect } = plan, { weight, family } = face;
    let fit = plan.fit;
    if (plan.refit) { // (its area was moved or cut back to keep off another: the English is fitted again to what is left)
      const measure = (t, size) => { pen.font = weight + " " + size + "px " + family; return pen.measureText(t).width; };
      fit = fitBoxText(plan.words, Math.round(rect.w), Math.round(rect.h), measure, 10, 44);
      if (!fit) return null;
    }
    const mgn = Math.ceil(Math.max(2.5, fit.size * 0.2)); // (room for the outline round the letters)
    const tw = Math.round(rect.w + 2 * mgn), th = Math.round(rect.h + 2 * mgn);
    const t = { x0: Math.round(Math.max(0, Math.min(plan.stripW - tw, rect.cx - tw / 2))), y0: Math.round(Math.max(0, rect.cy - th / 2)) };
    t.x1 = Math.min(plan.stripW, t.x0 + tw); t.y1 = Math.min(plan.stripH, t.y0 + th);
    const block = fit.lines.length * fit.size * fit.lead, top = (t.y1 - t.y0 - block) / 2;
    const lines = fit.lines.map((text, k) => ({ text, x: (t.x1 - t.x0) / 2, y: top + (k + 0.5) * fit.size * fit.lead + fit.size * 0.34 })); // (centred in the area, each line's middle on its row)
    // 1. the old letters out: filled from what is round them, through their mask (grown by 1 for their soft edges)
    const grown = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) if (found.mask[p]) {
      const px = p % w, py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = px + dx, ny = py + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h) grown[ny * w + nx] = 1; }
    }
    const filled = new Uint8ClampedArray(before.data);
    fillMasked(filled, w, h, grown);
    const cv = new OffscreenCanvas(w, h);
    cv.getContext("2d").putImageData(new ImageData(filled, w, h), 0, 0);
    const emask = new OffscreenCanvas(w, h), ex = emask.getContext("2d"), ed = ex.createImageData(w, h);
    for (let p = 0; p < w * h; p++) if (grown[p]) ed.data[p * 4 + 3] = 255;
    ex.putImageData(ed, 0, 0);
    // 2. the English, no background: the letters' colour with an outline of the other kind (light round dark letters, dark round light) so it reads over art
    const tc = new OffscreenCanvas(t.x1 - t.x0, t.y1 - t.y0), tx = tc.getContext("2d");
    const ink = found.ink || [17, 17, 17], dark = 0.299 * ink[0] + 0.587 * ink[1] + 0.114 * ink[2] < 128;
    tx.font = weight + " " + fit.size + "px " + family;
    tx.textAlign = "center";
    tx.lineJoin = "round";
    tx.miterLimit = 2;
    tx.lineWidth = Math.max(2.5, fit.size * 0.2);
    tx.strokeStyle = dark ? "#fff" : "#000";
    tx.fillStyle = "rgb(" + ink.join(",") + ")";
    for (const l of lines) { tx.strokeText(l.text, l.x, l.y); tx.fillText(l.text, l.x, l.y); }
    const tmask = new OffscreenCanvas(t.x1 - t.x0, t.y1 - t.y0), tmx = tmask.getContext("2d");
    tmx.fillStyle = "#000";
    tmx.fillRect(0, 0, t.x1 - t.x0, t.y1 - t.y0); // (the whole room: the picture's alpha is the text's own, so what is not text shows what is under)
    return [
      { cy0: r.y0, cy1: r.y1, x0: r.x0, w, bitmap: cv, mask: emask, layer: 2, item: it },
      { cy0: t.y0, cy1: t.y1, x0: t.x0, w: t.x1 - t.x0, bitmap: tc, mask: tmask, layer: 3, item: it, over: true }
    ];
  }

  // An item's own lines and the other items' text in region r, in its coordinates (letters' text). Another item's box stands for its text only where it has no
  // lines and this one has: a box the reading drew is rough, and could take this one's own letters from it.
  function textNear(it, items, r) {
    const rel = (b) => ({ x0: b.x0 - r.x0, y0: b.y0 - r.y0, x1: b.x1 - r.x0, y1: b.y1 - r.y0 });
    const own = (it.lines || []).map(rel), others = [];
    for (const o of items) {
      if (o === it || !(o.x1 > r.x0 && o.x0 < r.x1 && o.y1 > r.y0 && o.y0 < r.y1)) continue;
      if (o.lines && o.lines.length) for (const l of o.lines) others.push(rel(l));
      else if (own.length) others.push(rel(o));
    }
    return { own, others };
  }

  async function letterOver(strip, it, pen, items) {
    const plan = await planOver(strip, it, pen, items);
    if (!plan) return null;
    plan.stripW = strip.width; plan.stripH = strip.height;
    return renderOver(plan, pen);
  }

  // Keep the English of one bubble off another's (and off what stays where it was): the plans' areas are moved apart, a small bubble moving little and a big one most, cut back where they
  // cannot be (separateBoxes); every other piece of text on the page is a box that does not move. items: all of the page's
  function settlePlans(plans, items, strip) {
    if (!plans.length) return;
    for (const pl of plans) { pl.stripW = strip.width; pl.stripH = strip.height; }
    const mine = new Set(plans.map((pl) => pl.it)), maxArea = Math.max(...plans.map((pl) => pl.rect.w * pl.rect.h));
    const boxes = plans.map((pl) => ({ cx: pl.rect.cx, cy: pl.rect.cy, w: pl.rect.w, h: pl.rect.h, m: Math.max(0.1, (pl.rect.w * pl.rect.h) / maxArea), reach: pl.reach, plan: pl }));
    for (const it of items) if (!mine.has(it) && it.x1 > it.x0 && it.y1 > it.y0) boxes.push({ cx: (it.x0 + it.x1) / 2, cy: (it.y0 + it.y1) / 2, w: it.x1 - it.x0, h: it.y1 - it.y0, m: 0 });
    separateBoxes(boxes, { w: strip.width, h: strip.height });
    for (const b of boxes) if (b.plan) {
      const pl = b.plan;
      if (Math.abs(b.w - pl.rect.w) > 1 || Math.abs(b.h - pl.rect.h) > 1) pl.refit = true;
      pl.rect = { cx: b.cx, cy: b.cy, w: b.w, h: b.h };
    }
  }

  // (one bubble on its own: only the old letters out and the English over with no background and an outline; the rectangle only where that cannot be done)
  async function letterFallback(strip, it, pen, items) {
    return (await letterOver(strip, it, pen, items).catch(() => null)) || letterPatch(strip, it, pen);
  }
  // The last resort: the English on a patch of the colour round the box (a rectangle over what was there)
  async function letterPatch(strip, it, pen) {
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
    const was = letterSize(found, lines).size; // (about the old letters' size: by a line's height, or by a column's width for text set down the page)
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

  // the picture (0, 1, 2...) the strip's row y is in, as the site's pictures were given to translate ({ width, height } each)
  function pageAt(sizes, y) {
    const widths = new Map();
    for (const s of sizes) widths.set(s.width, (widths.get(s.width) || 0) + 1);
    const width = [...widths.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let top = 0, page = 0;
    for (let i = 0; i < sizes.length; i++) { top += Math.round((sizes[i].height * width) / sizes[i].width); if (y < top) return i; page = i; }
    return page;
  }

  // The site's pictures whose text was not read (the reading's parts left in `skipped`), as 1-based ranges: "7–12, 30"; "" when it was all read
  function unreadOf(sizes, r) {
    const seen = new Set();
    for (const s of (r && r.skipped) || []) if (/^read:/.test(s.why)) for (let p = pageAt(sizes, s.y0); p <= pageAt(sizes, Math.max(s.y0, s.y1 - 1)); p++) seen.add(p);
    const runs = [];
    for (const p of [...seen].sort((a, b) => a - b)) { const last = runs[runs.length - 1]; if (last && last[1] === p - 1) last[1] = p; else runs.push([p, p]); }
    return runs.map(([a, z]) => (a === z ? String(a + 1) : a + 1 + "–" + (z + 1))).join(", ");
  }

  // How each piece of text was done, for the log: lettered here (a plain bubble, no model), drawn by a model (it.via: { model, payer }, put on the ask's answer by the caller), lettered
  // over a patch (the drawing failed), or not drawn (left as it was). -> { entries: [{ step, method, model, payer, part, message }] (one for each piece), summary: "12 lettered here · 9 drawn by ..." }
  function methodsOf(sizes, r) {
    const NAMES = { "lettered here": "lettered here", drawn: "drawn by model", patch: "lettered over", "not drawn": "not drawn" };
    const entries = [], counts = new Map();
    for (const it of r.items) {
      if (!it.method || it.method === "kept") continue;
      const a = pageAt(sizes, it.y0), z = pageAt(sizes, Math.max(it.y0, it.y1 - 1)), via = it.method === "drawn" && it.via ? it.via : null;
      entries.push({ step: "draw", method: NAMES[it.method] || it.method, model: via ? via.model : "", payer: via ? via.payer : "", part: "picture " + (a + 1) + (z !== a ? "–" + (z + 1) : ""),
        message: "“" + String(it.en || it.text).replace(/\s+/g, " ").slice(0, 60) + "” (" + it.kind + ")" });
      const k = it.method + "|" + (via ? via.model + " · " + via.payer : "");
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const summary = [...counts.entries()].map(([k, n]) => { const [m, v] = k.split("|"); return n + " " + (NAMES[m] || m) + (v ? " (" + v + ")" : ""); }).join(" · ");
    return { entries, summary };
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
      // (translate gives each item how it was done; a part not drawn is rows of the strip, and a bubble lettered here beside one that went to the model shares them)
      const notDrawn = it.method ? it.method === "not drawn" : !it.fallback && r.skipped.some((s) => /^draw:/.test(s.why) && it.y0 < s.y1 && it.y1 > s.y0);
      return { en: it.en.trim(), text: it.text, kind: it.kind, ...(it.speaker ? { speaker: it.speaker } : {}), page,
        box: [part(it.x0 / width), part((it.y0 - top) / h), part(it.x1 / width), part((it.y1 - top) / h)], ...(notDrawn ? { notDrawn: true } : {}) };
    });
  }

  const api = { PROMPT_PRESETS, promptsFrom, READ_MODEL, DRAW_MODEL, DRAW_QUALITY, READ_BATCH, MIN_DRAW, MAX_RETRIES, splitsAgain, flatRows, gutters, chunks, coreOf, readPrompt, readBody, readItems, tilesOf, detectScale, detectSideOf, detectInput, linesOfTile, mergeLines, findPrompt, findBody, boxesOf, linesIn, blocksOf, lineOrder, claimLines, tagSpots, unclipOf, markedReadBody, readMarked, DETECT_SIZE, sections, partOf, halvesOf, drawBody, drawnOf, letters, letterSize, layout, fillMasked, balancedLines, fitBoxText, separateBoxes, changedPixels, roomsOf, letterFallback, letterPatch, Strip, translate, linesOf, pageAt, unreadOf, noPictureWhy, fitDraw, pngRatio, methodsOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ComicTranslate = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
