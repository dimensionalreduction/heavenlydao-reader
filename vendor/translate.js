// What the playground page does besides drawing: reading a glossary, building the prompt the way the extension does (extension/src/shared/gemini.js translateText), the two ways to
// call a model (the person's own key straight to the provider, or the playground server with the Patreon credit), and checking how many glossary terms a translation kept.
// No DOM here. `TermMatch` is the extension's term-match.js (a global in the page, vendor/term-match.js).

export const DEFAULT_PROMPT = "Translate the following text to {language}, keeping the original formatting and line breaks. Output only the translation.";

// ---------- glossaries ----------
// "source = English" lines (or a tab, or a comma), a JSON list of { source, english } / [source, english], or a JSON object { source: english } -> [{ term, translation }]
export function parseGlossary(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  const out = [];
  const add = (a, b) => { a = String(a == null ? "" : a).trim(); b = String(b == null ? "" : b).trim(); if (a && b) out.push({ term: a, translation: b }); };
  if (s[0] === "[" || s[0] === "{") {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) for (const e of j) Array.isArray(e) ? add(e[0], e[1]) : e && add(e.source || e.term || e.s, e.english || e.translation || e.en || e.e);
      else for (const k of Object.keys(j)) add(k, typeof j[k] === "string" ? j[k] : j[k] && (j[k].english || j[k].translation));
      return dedupe(out);
    } catch (e) { /* not JSON: read it as lines */ }
  }
  for (const line of s.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*(?:=|\t|,|＝|：)\s*(.+?)\s*$/.exec(line);
    if (m) add(m[1], m[2]);
  }
  return dedupe(out);
}
const dedupe = (list) => { const seen = new Map(); for (const e of list) seen.set(e.term, e); return [...seen.values()]; };

// ---------- the prompt ----------
const fill = (prompt, language) => String(prompt).replace(/\{language\}/g, language) + (language !== "English" && !/\{language\}/.test(prompt) ? " Write the translation in " + language + "." : "");

// { prompt, sent }: `sent` the glossary entries chosen for this text (those the translation is told to use), as the extension chooses them: longest first, a one-character term only
// where it is a name, the parts of a person's name with the full name.
export function buildPrompt({ instruction, language = "English", text, glossary = [] }) {
  const TM = globalThis.TermMatch;
  const chosen = TM ? TM.select(text, glossary, {}).entries : glossary.filter((e) => text.includes(e.term));
  const rendered = chosen.filter((e) => e.translation);
  const lines = rendered.map((e) => `${(e.terms || [e.term]).join(" / ")} = ${e.translation}` + (e.gender ? ` (${e.gender})` : "") + (e.forms && e.forms.length ? ` (the same person, when written alone: ${e.forms.join("; ")})` : "")).join("\n");
  const block = lines ? "Use these exact translations whenever these terms appear, for consistency:\n" + lines + "\n\n" : "";
  return { prompt: fill(instruction || DEFAULT_PROMPT, language) + "\n\n" + block + text, sent: rendered };
}

// Of the terms sent, how many have their English in the translation (a rendering "A / B" counts when either is there; capitals, plurals and 's do not matter).
export function termsKept(sent, output) {
  const hay = " " + String(output).toLowerCase().replace(/[-–—]/g, " ") + " ";
  let kept = 0;
  const missed = [];
  for (const e of sent) {
    const alts = String(e.translation).split(" / ").map((a) => a.toLowerCase().replace(/[-–—]/g, " ").trim()).filter(Boolean);
    if (alts.some((a) => hay.includes(a))) kept++; else missed.push(e);
  }
  return { kept, sent: sent.length, missed };
}

// Pasted text as chapters: a line that is a chapter heading (第12章 …, Chapter 12 …) starts the next one; with fewer than two headings it is one chapter.
export function splitChapters(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const head = /^\s*(第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章回节節]|chapter\s+\d+)/i;
  const marks = lines.map((l, k) => (head.test(l) && l.trim().length <= 80 ? k : -1)).filter((k) => k >= 0);
  const whole = String(text || "").trim();
  if (marks.length < 2) return whole ? [{ title: "", text: whole }] : [];
  const out = [];
  marks.forEach((m, k) => {
    const body = lines.slice(m + 1, k + 1 < marks.length ? marks[k + 1] : lines.length).join("\n").trim();
    if (body) out.push({ title: lines[m].trim(), text: body });
  });
  return out;
}

// ---------- what a text will cost, in tickets ----------
const CJK = /[㐀-鿿぀-ヿ가-힯]/g;
// the reader site's price (its FAQ): (characters + 500) x 0.0012 tickets, one at least; its characters are letters and numbers without punctuation or spaces (the server does the same count)
export const charsOf = (text) => (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length;
export const chapterTickets = (chars) => Math.max(1, (Number(chars) + 500) * 0.0012);
// How many English words the translation of a text will be: a Chinese, Japanese or Korean character is about two thirds of one, any other word is one.
export function wordsOf(text) {
  const t = String(text || "");
  const cjk = (t.match(CJK) || []).length;
  return Math.round(cjk * 0.67 + t.replace(CJK, " ").split(/\s+/).filter(Boolean).length);
}
// Tokens of a prompt: a CJK character is about 1.3, any other word about 1.4.
const tokensOf = (t) => Math.round(((String(t).match(CJK) || []).length) * 1.3 + String(t).replace(CJK, " ").split(/\s+/).filter(Boolean).length * 1.4);
// About how many tickets one translation uses: the reader site's price for the text, or what the model will cost in tickets when that is more (a ticket pays for `ticketUsd`; prices are dollars per
// million tokens: the prompt in, and as many English words out as the text has). With no price known, the site's alone.
// About what one translation costs in dollars at the model's listed prices (null when they are not known): what the person's own key pays.
export function estimateUsd({ model, prompt, text }) {
  if (!model || !Number.isFinite(model.promptPerM) || !Number.isFinite(model.completionPerM)) return null;
  return (tokensOf(prompt) * model.promptPerM + Math.round(wordsOf(text) * 1.4) * model.completionPerM) / 1e6;
}
export function estimateTickets({ model, prompt, text, ticketUsd }) {
  const flat = chapterTickets(charsOf(text));
  const usd = estimateUsd({ model, prompt, text });
  if (usd == null || !(ticketUsd > 0)) return flat;
  return Math.max(flat, usd / ticketUsd);
}

// ---------- calling a model ----------
// Server-sent events out of a fetch response's body: yields the parsed `data:` objects.
export async function* sseEvents(body) {
  const dec = new TextDecoder();
  let buf = "";
  const reader = body.getReader ? body.getReader() : null;
  const chunks = reader ? (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } })() : body;
  for await (const chunk of chunks) {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]") return;
        try { yield JSON.parse(d); } catch (e) { /* a comment or a cut line */ }
      }
    }
  }
}

// One model's translation, streamed: calls onText(textSoFar) and returns { text, promptTokens, completionTokens, costUsd (null when not told), ms }.
//   key: { base, key }  the person's own: straight to base + "/chat/completions"
//   patron: true        through the playground server with the Patreon credit (the cookie); server: its address, from another page (the library's: docs/PROFILES.md);
//                       token: the sign-in the library's page handed the extension (/api/extension-token), sent instead of the cookie
export async function runModel({ model, prompt, maxTokens = 8000, chars, key, patron, token = "", server = "", onText, signal, fetchFn = fetch, now = () => Date.now() }) {
  const t0 = now();
  let res;
  if (patron) {
    res = await fetchFn(server + "/api/translate", { method: "POST", signal, credentials: token ? "omit" : server ? "include" : "same-origin", headers: { "Content-Type": "application/json", "X-Playground": "1", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ model, prompt, max_tokens: maxTokens, chars }) });
  } else {
    if (!key || !key.base) throw new Error("add a key first");
    const base = String(key.base).replace(/\/+$/, "");
    // Google's address refuses a field it does not know (OpenRouter's usage), and its ids are OpenRouter's without google/ (its list says models/...)
    const google = isGoogle(base);
    const openrouter = /openrouter\.ai/.test(base);
    // OpenRouter: no thinking (a model that thinks by default, like Claude Haiku 5.5, spends most of its tokens on it, which are billed and count against max_tokens); a model that cannot do
    // without it says so, and is asked again without
    const send = (thinkingOff) => fetchFn(base + "/chat/completions", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", ...(key.key ? { Authorization: "Bearer " + key.key } : {}) },
      body: JSON.stringify({ model: google ? model.replace(/^(google|models)\//, "") : model, stream: true, max_tokens: maxTokens, ...(openrouter ? { usage: { include: true }, ...(thinkingOff ? { reasoning: { effort: "none" } } : {}) } : {}), stream_options: { include_usage: true }, messages: [{ role: "user", content: prompt }] }),
    });
    res = await send(true);
    if (openrouter && res.status === 400) {
      let said = "";
      try { said = JSON.stringify(await res.clone().json()); } catch (e) { /* no message */ }
      if (/reason/i.test(said)) res = await send(false);
    }
  }
  if (!res.ok) {
    let msg = "";
    try { let j = await res.json(); if (Array.isArray(j)) j = j[0] || {}; msg = (j.error && (j.error.message || j.error)) || ""; } catch (e) { /* no message */ }
    const err = new Error(typeof msg === "string" && msg ? msg : "the model's service said " + res.status);
    err.status = res.status;
    throw err;
  }
  let text = "", usage = null, left = null, tickets = null, leftTickets = null;
  for await (const ev of sseEvents(res.body)) {
    if (ev.error) throw new Error(typeof ev.error === "string" ? ev.error : ev.error.message || "the model stopped");
    const t = patron ? ev.t : ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
    if (t) { text += t; if (onText) onText(text); }
    if (patron && ev.done) { usage = { prompt_tokens: ev.usage.promptTokens, completion_tokens: ev.usage.completionTokens, cost: ev.usage.costUsd }; left = ev.leftUsd; tickets = ev.usage.tickets; leftTickets = ev.leftTickets; }
    else if (ev.usage) usage = ev.usage;
  }
  return { text, promptTokens: usage ? usage.prompt_tokens : null, completionTokens: usage ? usage.completion_tokens : null, costUsd: usage && typeof usage.cost === "number" ? usage.cost : null, leftUsd: left, tickets, leftTickets, ms: now() - t0 };
}

// ---------- files ----------
// The text of a dropped .txt / .md / .html / .epub (read in the browser).
export async function readFileText(file) {
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".epub")) return epubText(new Uint8Array(await file.arrayBuffer()));
  const text = await file.text();
  return name.endsWith(".html") || name.endsWith(".htm") ? htmlText(text) : text;
}
export function htmlText(html) {
  const d = new DOMParser().parseFromString(html, "text/html");
  d.querySelectorAll("script,style,head").forEach((e) => e.remove());
  return [...d.body.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,div")].filter((e) => !e.querySelector("p,h1,h2,h3,h4,li,blockquote,div")).map((e) => e.textContent.trim()).filter(Boolean).join("\n");
}

// A .epub is a zip: read its central directory and inflate the chapters' files (DecompressionStream), in the book's reading order.
async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let end = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("that is not a zip");
  const n = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = new Map();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(off + 26, true), lxlen = dv.getUint16(off + 28, true);
    const start = off + 30 + lnlen + lxlen;
    out.set(name, { method, data: u8.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return { get: async (name) => { const e = out.get(name); if (!e) return null; return new TextDecoder().decode(e.method === 0 ? e.data : await inflateRaw(e.data)); }, names: [...out.keys()] };
}
// { title, chapters: [{ title, text }] }: a chapter for each file of the book's reading order that has text (a cover or a contents page with next to none is left out); a chapter's title is its first line.
export async function epubBook(u8) {
  const zip = await zipEntries(u8);
  const container = await zip.get("META-INF/container.xml");
  const opfPath = container && (/full-path="([^"]+)"/.exec(container) || [])[1];
  const opf = opfPath && (await zip.get(opfPath));
  if (!opf) throw new Error("that epub has no book in it");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [(/\bid="([^"]+)"/.exec(m[0]) || [])[1], (/\bhref="([^"]+)"/.exec(m[0]) || [])[1]]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((m) => manifest.get(m[1])).filter(Boolean);
  const chapters = [];
  for (const href of spine) {
    const h = await zip.get(dir + decodeURIComponent(href));
    const text = h ? htmlText(h) : "";
    if (text.replace(/\s/g, "").length >= 10) chapters.push({ title: text.split("\n")[0].slice(0, 80), text });
  }
  const title = (/<dc:title\b[^>]*>([^<]+)</.exec(opf) || [])[1];
  return { title: title ? title.trim() : "", chapters };
}
export async function epubText(u8) {
  return (await epubBook(u8)).chapters.map((c) => c.text).join("\n\n");
}

// ---------- the person's own key ----------
// Gemini's OpenAI-compatible address: a key from Google AI Studio (free, with its limits) works there as an OpenRouter key does at OpenRouter
export const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
export const isGoogle = (base) => /^https:\/\/generativelanguage\.googleapis\.com\//.test(String(base));
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// OpenRouter's sign-in (PKCE): { url, verifier } to go to and to keep until the person is back with ?code=...
export async function openRouterSignIn(callbackUrl) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, url: "https://openrouter.ai/auth?" + new URLSearchParams({ callback_url: callbackUrl, code_challenge: challenge, code_challenge_method: "S256" }) };
}
export async function openRouterKey(code, verifier, fetchFn = fetch) {
  const res = await fetchFn("https://openrouter.ai/api/v1/auth/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
  if (!res.ok) throw new Error("OpenRouter did not give a key");
  return (await res.json()).key;
}
