// A chapter's text put into another language by Google Translate's free endpoint (the one the titles use: translate.googleapis.com, client=gtx; no key, nothing to pay):
// the Translation rule's last row (Settings › Model rules, site/pay.js "google/translate"), used when nothing above it can be paid for.
// The endpoint takes no glossary. docs/MODEL-TESTS.md §10 tried a novel's glossary with it: its proper names (a place, a sect, a person: capitalised English, of 3 characters or
// more or a person's name) put in as made-up names (TermAB) come back as they went, with the sentence built round them as round any name, and are put back as the glossary's English;
// a person's name followed by how they are called (齐原师弟) goes as one name in English order (Junior Brother Qi Yuan). The rest of the glossary (words like 无法 = unable to) is left to
// Google: forced in, it built the sentences round them wrong. A paragraph whose names did not all come back is asked again as it is.
// No who speaks, no cues, no notes on terms: those are a model's, and none is asked.
//   await GoogleChapter.translate(text, { lang, glossary, fetch, sleep, onProgress })   -> the text in `lang`, its paragraphs a blank line apart (as the models answer)
//     glossary: [{ terms | term, translation, kind }] (the entries chosen for the chapter: translate.js buildPrompt's `sent`); onProgress(done, of): the requests made
//     throws an Error with `status` when Google refuses (429: its "unusual traffic" page) or answers what is not a translation; fetch's own TypeError when it cannot be reached
//   GoogleChapter.MODEL         "google/translate"
//   GoogleChapter.is(model)     a chapter's model (its entry's `model`) says it was translated this way
// Runs in a page (the library site, from vendor/) and in the extension's background script, after term-match.js.
(function (root) {
  const MODEL = "google/translate";
  const ENDPOINT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=";
  const CHUNK_CHARS = 1500; // the characters sent in one request (the paragraphs one a line), as §10 sent them
  const LONG = 4000; // a paragraph longer than this is sent in pieces cut at its sentences' ends (the endpoint takes about 5,000 characters)
  const GAP_MS = 250; // between two requests
  const ADDRESS = new Set(["师兄", "师弟", "师妹", "师姐", "师尊", "师父", "师傅", "师叔", "师伯", "师祖", "长老", "前辈", "道友", "大哥", "姐姐", "妹妹", "公子", "小姐", "少爷", "姑娘"]);
  const CODES = { zh: "zh-CN" }; // (the library's language codes Google names otherwise)
  const is = (model) => typeof model === "string" && (model === MODEL || model.startsWith(MODEL + " "));

  // ----- the glossary's proper names in a paragraph, as made-up names -----
  const firstEn = (e) => String(e.translation || "").split(" / ")[0].trim();
  const sourcesOf = (e) => (Array.isArray(e.terms) ? e.terms : [e.term]).map((s) => String(s || "")).filter(Boolean);
  const TM = () => root.TermMatch || null;
  function isPersonEntry(e, source) {
    const tm = TM();
    return !!(tm && ((tm.isPerson && tm.isPerson(e)) || (tm.splitName && tm.splitName(source, firstEn(e)))));
  }
  // a name Google is to keep: capitalised English, and 3 characters or more, or a person's name (Seven-Colored Peak, Divine Radiance Sect, Qi Yuan; not Cultivator, Qi Refining)
  const proper = (e, source) => /^[A-Z]/.test(firstEn(e)) && !/\s\/\s/.test(firstEn(e)) && (Array.from(source).length >= 3 || isPersonEntry(e, source));
  // Where each term goes in a paragraph: longest first, a place no longer term has taken (齐原 in 齐原师兄 is not a term of its own there); two terms of one length that
  // cross (大师|师兄 in 大师兄) are both left as they are. -> [{ start, end, e, source }] in order
  function spans(text, list) {
    const all = [];
    for (const e of list) for (const source of sourcesOf(e)) all.push({ e, source });
    all.sort((a, b) => b.source.length - a.source.length);
    const taken = [];
    for (let k = 0; k < all.length; ) {
      const n = all[k].source.length, group = [];
      for (; k < all.length && all[k].source.length === n; k++) {
        const t = all[k];
        for (let i = text.indexOf(t.source); i !== -1; i = text.indexOf(t.source, i + 1))
          if (!taken.some((s) => i < s.end && s.start < i + n)) group.push({ start: i, end: i + n, e: t.e, source: t.source });
      }
      for (const s of group) if (!group.some((o) => o !== s && o.start < s.end && s.start < o.end) && !taken.some((o) => o.start === s.start)) taken.push(s);
    }
    return taken.sort((a, b) => a.start - b.start);
  }
  const letters = (n) => String.fromCharCode(65 + (Math.floor(n / 26) % 26)) + String.fromCharCode(65 + (n % 26));
  const NAME_BACK = /Term([A-Z])([A-Z])/g;
  // A paragraph with its proper names as made-up names: { sent, names: { TermAB: English } } (names empty: the paragraph as it is)
  function withNames(text, list, names, english) {
    const ss = spans(text, list);
    let out = "", at = 0;
    const here = {};
    for (let k = 0; k < ss.length; k++) {
      const s = ss[k], n = ss[k + 1];
      if (!proper(s.e, s.source)) continue;
      let en = firstEn(s.e), end = s.end;
      if (n && n.start === s.end && ADDRESS.has(n.source) && isPersonEntry(s.e, s.source) && firstEn(n.e)) { en = firstEn(n.e) + " " + en; end = n.end; k++; }
      if (!english.has(en)) { english.set(en, "Term" + letters(english.size)); names[english.get(en)] = en; }
      const token = english.get(en);
      here[token] = en;
      out += text.slice(at, s.start) + token;
      at = end;
    }
    return { sent: out + text.slice(at), names: here };
  }
  // the made-up names in a line, sorted (to see that a line has every one it was sent with)
  const tokensIn = (line) => (String(line).match(NAME_BACK) || []).sort().join();
  // the made-up names put back as their English, a space where a word touches one
  const putBack = (line, names) => String(line).replace(NAME_BACK, (m, a, b, off, s) => {
    const en = names[m];
    if (!en) return m;
    const before = s[off - 1], after = s[off + m.length];
    return (before && /[\p{L}\p{N}]/u.test(before) ? " " : "") + en + (after && /[\p{L}\p{N}]/u.test(after) ? " " : "");
  }).replace(/ {2,}/g, " ").trim();

  // a paragraph too long for one request, in pieces cut after its sentences' ends
  function pieces(p) {
    if (p.length <= LONG) return [p];
    const parts = p.split(/(?<=[。！？!?.…」』”])/);
    const out = [];
    let cur = "";
    for (const part of parts) {
      if (cur && cur.length + part.length > CHUNK_CHARS) { out.push(cur); cur = ""; }
      cur += part;
      while (cur.length > LONG) { out.push(cur.slice(0, CHUNK_CHARS)); cur = cur.slice(CHUNK_CHARS); }
    }
    if (cur) out.push(cur);
    return out;
  }

  async function translate(text, opts = {}) {
    const doFetch = opts.fetch || root.fetch.bind(root);
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const lang = CODES[opts.lang] || opts.lang || "en";
    const glossary = (Array.isArray(opts.glossary) ? opts.glossary : []).filter((e) => e && firstEn(e) && sourcesOf(e).length);
    const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    const paras = String(text || "").split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) return "";

    let made = 0, planned = 0, last = 0;
    // one request: the lines (one a line); -> the lines in `lang`, one for one (a request whose lines do not come back one for one is asked again in halves)
    async function ask(lines) {
      for (let tries = 0; ; tries++) {
        const wait = last + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        const res = await doFetch(ENDPOINT + encodeURIComponent(lang), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "q=" + encodeURIComponent(lines.join("\n")) });
        if (res.ok) {
          let data = null;
          try { data = await res.json(); } catch (e) { data = null; }
          if (!Array.isArray(data) || !Array.isArray(data[0])) throw Object.assign(new Error("Google Translate did not answer with a translation"), { status: 503 });
          return data[0].map((seg) => (seg && seg[0]) || "").join("");
        }
        if (!(res.status === 429 || res.status >= 500) || tries >= 2) throw Object.assign(new Error("Google Translate said " + res.status + (res.status === 429 ? " (too many requests: try again later)" : "")), { status: res.status });
        await sleep(5000 * (tries + 1));
      }
    }
    async function lines(list) {
      const out = new Array(list.length).fill("");
      async function part(idx) {
        const joined = await ask(idx.map((i) => list[i]));
        const got = joined.replace(/\n+$/, "").split("\n");
        if (got.length === idx.length) { idx.forEach((i, k) => { out[i] = got[k].trim(); }); return; }
        if (idx.length === 1) { out[idx[0]] = got.join(" ").replace(/\s+/g, " ").trim(); return; }
        const mid = Math.ceil(idx.length / 2);
        await part(idx.slice(0, mid));
        await part(idx.slice(mid));
      }
      const groups = [];
      let cur = [], len = 0;
      list.forEach((t, i) => {
        if (cur.length && len + t.length > CHUNK_CHARS) { groups.push(cur); cur = []; len = 0; }
        cur.push(i);
        len += t.length + 1;
      });
      if (cur.length) groups.push(cur);
      planned += groups.length;
      for (const g of groups) { await part(g); made++; progress(made, planned); }
      return out;
    }

    // the paragraphs (in pieces where too long), with the proper names as made-up names
    const units = []; // { p (its paragraph), plain, sent, names }
    const english = new Map(), names = {};
    paras.forEach((p, i) => { for (const piece of pieces(p)) { const w = glossary.length ? withNames(piece, glossary, names, english) : { sent: piece, names: {} }; units.push({ p: i, plain: piece, sent: w.sent, names: w.names }); } });
    const got = await lines(units.map((u) => u.sent));
    // a piece whose names did not all come back (one changed: TermAX as TermMAX, or lost) is asked again as it is
    const again = units.map((u, i) => i).filter((i) => Object.keys(units[i].names).length && tokensIn(got[i]) !== tokensIn(units[i].sent));
    if (again.length) {
      const plain = await lines(again.map((i) => units[i].plain));
      again.forEach((i, k) => { got[i] = plain[k]; units[i].names = {}; });
    }
    const out = paras.map(() => []);
    units.forEach((u, i) => { const line = Object.keys(u.names).length ? putBack(got[i], u.names) : String(got[i] || "").trim(); if (line) out[u.p].push(line); });
    return out.map((parts) => parts.join(" ")).filter(Boolean).join("\n\n");
  }

  const api = { MODEL, is, translate, _spans: spans, _withNames: withNames, _putBack: putBack };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.GoogleChapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
