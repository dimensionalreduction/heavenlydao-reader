// Who pays for a model, and which model is used when none is picked (docs/UNIFIED-PAY.md). A payer is "tickets" (the playground's, with a Patreon membership) or a key kept in
// this browser, by its provider's address. The rules: for each item the models best first, each with who may pay for it (keys first, then tickets); the default is the first
// model and payer this person has, and when one fails the next is tried. A model picked by hand is not the rules' business.
//   Pay.choices(item, has, skipped)   the rules' pairs this person can use, best first: [{ model (the payer's own id), pay, kind, rule (OpenRouter's id) }]
//   Pay.best(item, has, skipped)      the first of them, or null
//   Pay.skipFor(error)                how long a failure keeps that pair out: "visit", "chapter", or "" (no other is tried)
//   Pay.skipList()                    the pairs that failed: add(pair, how, chapter), has(pair, chapter)
// has: { patron (a Patreon member), ticketsLeft (null: not known), keys: [the addresses of the keys kept here] }
// A payer "free" is no one: Google Translate's free endpoint (GOOGLE), which every person can use; the Translation rule's last row (vendor/google-chapter.js).
(function (root) {
  const BASE = { openrouter: "https://openrouter.ai/api/v1", gemini: "https://generativelanguage.googleapis.com/v1beta/openai", fish: "https://api.fish.audio" };
  const RULES = {
    // an AI voice with nothing ticked
    voice: [
      { model: "hexgrad/kokoro-82m", pay: ["openrouter", "tickets"] },
      { model: "google/gemini-3.8-flash-tts", pay: ["gemini"] },
      { model: "fish-audio/s2.1-pro-free:free", pay: ["fish"] }
    ],
    // the voice while delivery cues or a voice for each speaker are on (Fish Audio's voices act the cues); the free model only when every payer of Drama 3 failed
    acting: [
      { model: "fish-audio/drama-3", pay: ["fish", "openrouter", "tickets"] },
      { model: "fish-audio/s2.1-pro-free:free", pay: ["fish", "openrouter", "tickets"] }
    ],
    // the model that writes the cues and finds who speaks
    writer: [
      { model: "google/gemini-3.5-flash-lite", pay: ["gemini", "openrouter", "tickets"] }
    ],
    // a chapter's text translated (the novel's profile gives the prompt, these give the model): Gemini with a key of its own, else the same model through OpenRouter or tickets;
    // when it fails or refuses, GLM 5.3 Flash; with no key and no tickets (or every one of those failed), Google Translate, free (no prompt, and no who speaks with it)
    translate: [
      { model: "google/gemini-3.5-flash-lite", pay: ["gemini", "openrouter", "tickets"] },
      { model: "z-ai/glm-5.3-flash", pay: ["openrouter", "tickets"] },
      { model: "google/translate", pay: ["free"] }
    ],
    // a character's picture (made when the person presses the button): the cheapest image model for now (2026-10-28: about $0.034, 67 tickets); an OpenRouter key or tickets
    image: [
      { model: "google/gemini-3.1-flash-lite-image", pay: ["openrouter", "tickets"] }
    ],
    // a chapter of pictures translated in its pictures (docs/COMICS.md, comics.js): where its text is (the text detector on this device, free; or a vision model's boxes),
    // its text read (what it says, the English, who says it), then the parts over art drawn again with the English (OpenAI's images API: OpenRouter or tickets, not Google's)
    comicFind: [
      { model: "device/paddleocr-det", pay: ["device"] },
      { model: "z-ai/glm-5.3-flashx", pay: ["openrouter", "tickets"] },
      { model: "z-ai/glm-5.3-flash", pay: ["openrouter", "tickets"] },
      { model: "google/gemini-3.5-flash-lite", pay: ["gemini", "openrouter", "tickets"] }
    ],
    comicRead: [
      { model: "google/gemini-3.5-flash-lite", pay: ["gemini", "openrouter", "tickets"] }
    ],
    // (a row of this device is the engine lettering a plain bubble itself: its letters erased and the English written in, no model, free. Above the models it is the first pass, the
    // models draw what is left (text over art, sound effects); below them it is the fallback for what a model failed or refused; taken out, no bubble is lettered here)
    comicDraw: [
      { model: "device/lettering", pay: ["device"] },
      { model: "openai/gpt-image-2.5-flare", pay: ["openrouter", "tickets"] }
    ]
  };
  // ----- the rules as the person has changed them (Settings › Model rules, site/rules.js) -----
  // RULES is the live list every feature reads; DEFAULTS is what comes with the site. A change is kept per item as rows, one for each model and payer in order:
  // [{ model, kind }]; an item that is as it came is not kept (so a better default reaches those who never changed it). useRules(saved) puts the changes over the defaults.
  const DEFAULTS = JSON.parse(JSON.stringify(RULES));
  // A payer in a rule is one of KINDS, or the address of a key kept here (a local model's server, or any OpenAI-compatible provider): a row of that is { kind: "other", base }
  const KINDS = ["tickets", "device", "free", "openrouter", "gemini", "fish"];
  const GOOGLE = "google/translate";
  const GOOGLE_ROW = { model: GOOGLE, kind: "free" };
  const isAddress = (v) => typeof v === "string" && /^https?:\/\/\S+$/.test(v);
  const flat = (list) => list.flatMap((r) => r.pay.map((p) => (isAddress(p) ? { model: r.model, kind: "other", base: p } : { model: r.model, kind: p })));
  const nested = (rows) => rows.map((r) => ({ model: r.model, pay: [r.kind === "other" ? r.base : r.kind] }));
  const cleanRows = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.model === "string" && r.model && (KINDS.includes(r.kind) || (r.kind === "other" && isAddress(r.base))))
    .map((r) => (r.kind === "other" ? { model: r.model, kind: "other", base: r.base } : { model: r.model, kind: r.kind }));
  const rowsOf = (item) => flat(RULES[item] || []);
  const defaultRows = (item) => flat(DEFAULTS[item] || []);
  const sameRows = (a, b) => a.length === b.length && a.every((r, i) => r.model === b[i].model && r.kind === b[i].kind && (r.base || "") === (b[i].base || ""));
  const LETTERING = { model: "device/lettering", kind: "device" };
  // (2: a drawing's rows may hold Lettered here; rules kept before it had none and are given it, at the top, as the engine always did.
  //  3: the Translation rule ends with Google Translate; a Translation kept before it is given it, at the end)
  const RULES_VERSION = 3;
  function useRules(saved) {
    const v = (saved && Number(saved.v)) || 0;
    for (const item of Object.keys(DEFAULTS)) {
      let rows = cleanRows(saved && saved[item]);
      if (item === "comicDraw" && rows.length && v < 2 && !rows.some((r) => r.kind === "device")) rows = [LETTERING, ...rows];
      if (item === "translate" && rows.length && v < 3 && !rows.some((r) => r.kind === "free")) rows = [...rows, GOOGLE_ROW];
      RULES[item] = rows.length ? nested(rows) : JSON.parse(JSON.stringify(DEFAULTS[item]));
    }
  }
  // what to keep: the items that are not as they came (and the version of the rules they were made under, once something is kept)
  const savedOf = () => {
    const out = {};
    for (const item of Object.keys(DEFAULTS)) if (!sameRows(rowsOf(item), defaultRows(item))) out[item] = rowsOf(item);
    return Object.keys(out).length ? { v: RULES_VERSION, ...out } : out;
  };
  // How the drawing is done, from its rows: letter: "first" (lettered here above the models), "after" (below them: the lettering is made in the first pass and held, used only where a model failed), "never" (not in the rules);
  // models: whether a model is asked. A row first is the one in use and the rows under it are not tried (as for any item): none is asked when Lettered here is first or no model is in the rules
  function drawMode() {
    const rows = rowsOf("comicDraw"), l = rows.findIndex((r) => r.kind === "device"), m = rows.findIndex((r) => r.kind !== "device");
    return { letter: l < 0 ? "never" : m < 0 || l < m ? "first" : "after", models: m >= 0 && !(l >= 0 && l < m) };
  }
  // The quick switch: Standard is the defaults; Adult content puts a drawing model that does not refuse first (the others stay under it for when it fails)
  const FLUX = "black-forest-labs/flux-3-image-klein", GPT_IMAGE = "openai/gpt-image-2.5-flare";
  const PRESETS = {
    standard: {},
    adult: { comicDraw: [LETTERING].concat(["openrouter", "tickets"].map((kind) => ({ model: FLUX, kind })), ["openrouter", "tickets"].map((kind) => ({ model: GPT_IMAGE, kind }))) }
  };
  const presetOf = (saved) => {
    const changed = Object.keys(saved || {}).filter((item) => DEFAULTS[item] && !sameRows(cleanRows(saved[item]), defaultRows(item)));
    if (!changed.length) return "standard";
    for (const name of Object.keys(PRESETS)) {
      const want = PRESETS[name];
      if (changed.length === Object.keys(want).length && changed.every((item) => want[item] && sameRows(cleanRows(saved[item]), want[item]))) return name;
    }
    return "custom";
  };

  // ----- the error log: what failed, which model, who paid, what it said (site/rules.js keeps and shows it; the extension's popup shows its own) -----
  // an entry: { t, step: "find" | "read" | "draw" | "voice", model, payer, status, part ("picture 2"), message, note }
  const STEP_NAMES = { find: "Find text", read: "Read", draw: "Draw", voice: "Voice", translate: "Translate" };
  function logText(e) {
    const d = new Date(e.t || Date.now()), at = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    return [at, STEP_NAMES[e.step] || e.step, e.method ? "[" + e.method + "]" : "", e.model, e.payer, e.status ? "HTTP " + e.status : "", e.part, e.message, e.note ? "(" + e.note + ")" : ""].filter(Boolean).join(" · ");
  }

  // "tickets", "device" (this device itself: free, nothing sent), "free" (Google Translate), "openrouter", "gemini", "fish", or "other" (a key at another address)
  const kindOf = (pay) => (pay === "tickets" || pay === "device" || pay === "free" ? pay : Object.keys(BASE).find((k) => BASE[k] === pay) || "other");
  const own = (kind) => kind === "tickets" || kind === "device" || kind === "free"; // (a payer that is not a key's address)
  // A rule's model (OpenRouter's id) as the payer asks for it: Fish Audio's own API and Gemini's have no provider before the name (and Fish Audio's free model no ":free")
  const idFor = (kind, model) => (kind === "fish" ? model.replace(/^fish-audio\//, "").replace(/:free$/, "") : kind === "gemini" ? model.replace(/^google\//, "") : model);
  const isFree = (model) => /:free$/.test(model);
  // tickets: a Patreon member with tickets left (a free model: any member, it costs none); a key: one kept here for that provider
  // (a key at an address of its own, a local server's: base)
  const canPay = (kind, model, has, base) => (kind === "device" || kind === "free" ? true : kind === "tickets" ? !!has.patron && (isFree(model) || has.ticketsLeft == null || has.ticketsLeft > 0) : (has.keys || []).includes(kind === "other" ? base : BASE[kind]));
  // does the rule r name this payer (a way: "tickets", a key's address...)
  const allows = (r, pay) => r.pay.includes(kindOf(pay)) || r.pay.includes(pay);
  function choices(item, has, skipped = () => false) {
    const out = [];
    for (const r of RULES[item] || []) for (const p of r.pay) {
      const kind = isAddress(p) ? "other" : p;
      if (!canPay(kind, r.model, has, p)) continue;
      const c = { model: idFor(kind, r.model), pay: own(kind) ? kind : isAddress(p) ? p : BASE[kind], kind, rule: r.model };
      if (!skipped(c)) out.push(c);
    }
    return out;
  }
  const best = (item, has, skipped) => choices(item, has, skipped)[0] || null;
  // The key refused, no credit or no tickets: not tried again this visit. A limit, the provider busy or down, no answer: not again in this chapter. Anything else (a request
  // that is wrong, a text too long): the next one would fail as well, so none other is tried. The status is the error's, else one its message names ("Fish said 402").
  function skipFor(err) {
    if (err && err.unsupported) return "unsupported"; // (the model cannot take this kind of request: not again this chapter, no waiting; the next row)
    const st = Number(err && err.status) || Number((/\b(40[123]|429|5\d\d)\b/.exec(String((err && err.message) || err || "")) || [])[1]) || 0;
    if (st === 401 || st === 402 || st === 403) return "visit";
    if (st === 429 || st >= 500) return "chapter";
    if (err && err.name === "TypeError") return "chapter"; // (fetch could not reach it)
    return "";
  }
  function skipList() {
    const out = new Map(); // payer + model -> "visit", or the chapter it is out for
    const id = (c) => c.pay + "\n" + c.model;
    return {
      add(c, how, chapter) { if (how) out.set(id(c), how === "visit" ? "visit" : "ch:" + chapter); },
      has: (c, chapter) => { const v = out.get(id(c)); return v === "visit" || v === "ch:" + chapter; },
      clear: () => out.clear()
    };
  }
  // A pair as a select's value, and back
  const keyOf = (c) => (c ? c.pay + "\n" + c.model : "");
  const fromKey = (v) => { const i = String(v || "").indexOf("\n"); return i > 0 ? { pay: v.slice(0, i), model: v.slice(i + 1) } : null; };

  const api = { BASE, RULES, DEFAULTS, KINDS, GOOGLE, PRESETS, FLUX, GPT_IMAGE, kindOf, idFor, isFree, isAddress, canPay, allows, choices, logText, STEP_NAMES, drawMode, RULES_VERSION, best, skipFor, skipList, keyOf, fromKey, rowsOf, defaultRows, sameRows, cleanRows, useRules, savedOf, presetOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Pay = api;
  // (in the page: the person's changes from the last visit, and again whenever they are made)
  if (typeof store !== "undefined" && typeof bus !== "undefined") {
    useRules(store.get("modelRules", {}));
    bus.on("setting:modelRules", (v) => useRules(v || {}));
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
