// A comic's chapter page translated in its pictures, from the popup (docs/COMICS.md, docs/ADD-BOOK.md): nothing is kept, the pictures made again are put in the page
// in place of the site's (comic-page.js in the tab), for as long as it is open. Runs where the text detector can (WebAssembly in an extension page): Chrome's offscreen
// page, Firefox's background page; with ComicTranslate (comic-translate.js), onnxruntime-web (ort/) and PaddleOCR's detector (models/, Apache-2.0).
// Paid as the popup says: "key" (reading with the Gemini key the library's page handed over, else the OpenRouter key; drawing with the OpenRouter key) or "tickets"
// (the playground's /api/comic, with the sign-in the library's page handed over for this extension).
//   { target: "comic", op: "translate", tabId, urls, referer, pay, keys, token, into }   -> { ok } when it has started; progress and pictures go to the tab
//   { target: "comic", op: "stop", tabId }
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const PLAYGROUND = "https://playground.heavenlydao.com";
  const OPENROUTER = "https://openrouter.ai/api/v1";
  // (a dev build, whose library site is this computer, may be told to ask a stand-in on this computer instead: the e2e tests)
  const DEV = typeof SITE_BRIDGE_MATCHES !== "undefined" && SITE_BRIDGE_MATCHES.some((x) => /localhost|127\.0\.0\.1/.test(x));
  const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
  const FONTS = [400, 700].map((weight) => ({ family: "Comic Neue", weight, url: ext.runtime.getURL("fonts/comic-neue-" + weight + ".woff2") }));
  // to the tab: Firefox's background page has tabs; Chrome's offscreen page has only runtime, so the background passes it on
  const toTab = (tabId, msg) => (ext.tabs && ext.tabs.sendMessage ? ext.tabs.sendMessage(tabId, msg) : ext.runtime.sendMessage({ type: "comic:toTab", tabId, msg })).catch(() => {});
  const jobs = new Map(); // tab -> AbortController of the chapter being translated there
  const listens = new Map(); // tab -> how its Listen is paid: { pay, key, token, openrouter }
  const made = new Map(); // tab -> what its last translation made, until the popup's Save to library keeps it in the library: { originals, pictures, lines, madeWith }
  // AI voices (Kokoro on OpenRouter, the library's usual): the narrator's, then one for each speaker in turn
  const SPEECH_MODEL = "hexgrad/kokoro-82m";
  const VOICES = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella", "am_adam", "bf_lily", "bm_lewis"];

  let detector = null;
  function detect() {
    if (!detector) detector = (async () => {
      ort.env.wasm.wasmPaths = ext.runtime.getURL("ort/");
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(ext.runtime.getURL("models/ch_PP-OCRv4_det_infer.onnx"), { executionProviders: ["wasm"] });
      return async (rgba, size) => {
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", ComicTranslate.detectInput(rgba, size), [1, 3, size, size]) });
        const prob = out[session.outputNames[0]].data, map = new Uint8Array(size * size);
        for (let i = 0; i < map.length; i++) map[i] = Math.round(Math.max(0, Math.min(1, prob[i])) * 255);
        return map;
      };
    })().catch((e) => { detector = null; throw e; });
    return detector;
  }

  // One request of the steps, paid as the popup said. -> the answer's JSON; a refused key or no tickets is fatal (the chapter stops)
  function asker(job) {
    return async (kind, body) => {
      if (kind === "draw" && job.noDraw) throw new Error(job.noDraw); // (drawing could not be paid for: the parts stay as they are, with their English listed)
      let url, headers = { "Content-Type": "application/json" }, send = body;
      if (job.pay === "tickets") {
        if (!job.token) throw Object.assign(new Error("No sign-in for tickets in this browser: open the library here while signed in"), { fatal: true });
        url = PLAYGROUND + "/api/comic";
        headers = Object.assign(headers, { Authorization: "Bearer " + job.token, "X-Playground": "1" });
        send = { kind, body };
      } else {
        const gemini = kind !== "draw" && job.keys[GEMINI];
        const base = gemini ? GEMINI : OPENROUTER;
        const key = job.keys[base];
        if (!key) throw Object.assign(new Error(kind === "draw" ? "Drawing needs an OpenRouter key: add it in the library's Settings" : "Add a Gemini or OpenRouter key in the library's Settings"), { fatal: true });
        url = (base === OPENROUTER ? job.openrouter : base) + (kind === "draw" ? "/images" : "/chat/completions");
        headers.Authorization = "Bearer " + key;
        if (gemini) { send = Object.assign({}, body, { model: String(body.model).replace(/^google\//, ""), reasoning_effort: "low" }); delete send.usage; delete send.reasoning; delete send.temperature; }
      }
      let r, j;
      for (let again = 0; ; again++) {
        r = await fetch(url, { method: "POST", headers, body: JSON.stringify(send), signal: job.signal });
        j = await r.json().catch(() => ({}));
        // (busy: the parts being drawn at once hold tickets, and the tickets are enough: asked again in a moment)
        if (job.pay === "tickets" && r.status === 429 && j && (j.busy || /^(too many requests|six at once)/.test(String(j.error || ""))) && again < 40 && !job.signal.aborted) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
        break;
      }
      const err = Array.isArray(j) ? j[0] && j[0].error : j.error;
      if (!r.ok || err) {
        const e = new Error((err && (err.message || err)) || "The model said " + r.status);
        // (the playground answers 424 with what OpenRouter said: its 401-403, "Key limit exceeded", are the tickets' key out of money as well)
        const status = [401, 402, 403].includes(Number(j && j.upstream)) ? 402 : r.status;
        if (status === 401 || status === 402 || status === 403) {
          // drawing refused for want of money (a key without the balance OpenRouter wants before it makes pictures, no tickets left) does not stop the chapter
          if (kind === "draw") job.noDraw = "Drawing was not paid for: " + String(e.message).replace(/[.\s]+$/, "");
          else e.fatal = true;
        }
        throw e;
      }
      if (j.tickets) job.tickets += Number(j.tickets) || 0;
      return j;
    };
  }

  // A line read aloud, paid as the popup said (tickets: the playground's /api/speech with the sign-in handed over; key: OpenRouter's /audio/speech) -> { audio (base64 mp3), type } | { error }
  async function speechOf(tabId, text, voice) {
    const job = listens.get(tabId);
    if (!job) return { error: "Listen was not set up for this page" };
    const body = JSON.stringify({ model: SPEECH_MODEL, input: String(text || "").slice(0, 4000), voice: VOICES[Math.max(0, Number(voice) || 0) % VOICES.length], response_format: "mp3" });
    try {
      let r;
      if (job.pay === "tickets") {
        if (!job.token) return { error: "No sign-in for tickets in this browser: open the library here while signed in" };
        r = await fetch(PLAYGROUND + "/api/speech", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + job.token, "X-Playground": "1" }, body });
      } else {
        if (!job.key) return { error: "Add an OpenRouter key in the library's Settings" };
        r = await fetch(job.openrouter + "/audio/speech", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + job.key }, body });
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const why = j && (j.error && j.error.message || j.error);
        return { error: String(why || "The voice's service said " + r.status).slice(0, 200) };
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      let s = "";
      for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
      return { audio: btoa(s), type: r.headers.get("content-type") || "audio/mpeg" };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  async function run(m, signal) {
    const tabId = m.tabId;
    const job = { pay: m.pay === "tickets" ? "tickets" : "key", keys: m.keys || {}, token: String(m.token || ""), signal, tickets: 0,
      openrouter: DEV && /^https:\/\/127\.0\.0\.1:\d+\/[\w/-]*$/.test(String(m.openrouter || "")) ? m.openrouter.replace(/\/$/, "") : OPENROUTER };
    const tell = (msg) => { toTab(tabId, Object.assign({ type: "comic:progress" }, msg)); ext.runtime.sendMessage({ type: "comic:status", tabId, ...msg }).catch(() => {}); };
    tell({ step: "loading", done: 0, of: m.urls.length });
    const release = typeof Referer !== "undefined" ? await Referer.use(m.urls, m.referer || "").catch(() => () => {}) : () => {};
    const sources = [];
    const originals = []; // (the site's pictures as they came, for Save to library)
    try {
      for (let i = 0; i < m.urls.length; i++) {
        if (signal.aborted) throw Object.assign(new Error("Stopped"), { stopped: true });
        const res = await fetch(m.urls[i], { credentials: "include", signal }).catch((e) => {
          if (signal.aborted) throw e;
          let host = ""; try { host = new URL(m.urls[i]).host; } catch (e2) { /* not an address */ }
          throw new Error("Could not load picture " + (i + 1) + " of " + m.urls.length + (host ? " from " + host + ": the extension is not allowed to read it, or it refused" : ""));
        });
        if (!res.ok) throw new Error("HTTP " + res.status + " for picture " + (i + 1) + " of " + m.urls.length);
        const blob = await res.blob();
        originals.push(blob);
        sources.push(await createImageBitmap(blob));
        tell({ step: "loading", done: i + 1, of: m.urls.length });
      }
    } finally {
      release();
    }
    const r = await ComicTranslate.translate(sources, { ask: asker(job), method: "full", detect: await detect(), fonts: FONTS, into: m.into || "English", signal,
      onProgress: (p) => tell({ step: p.step, done: p.done, of: p.of }) });
    // each picture made again goes to the tab as it is (base64: the tab makes its own address for it)
    let sent = 0;
    for (let i = 0; i < r.pictures.length; i++) {
      if (!r.pictures[i]) continue;
      const bytes = new Uint8Array(await r.pictures[i].arrayBuffer());
      let s = "";
      for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
      await toTab(tabId, { type: "comic:picture", i, b64: btoa(s), mime: r.pictures[i].type || "image/webp" });
      sent++;
    }
    // (each line with the picture it is on and its box there, as the library keeps them: the reader's overlay)
    const kept = ComicTranslate.linesOf(sources, r);
    const lines = kept.map((l) => ({ en: l.en, speaker: l.speaker || null, kind: l.kind, notDrawn: !!l.notDrawn }));
    made.set(m.tabId, { originals, pictures: r.pictures, madeWith: ComicTranslate.READ_MODEL + " + " + ComicTranslate.DRAW_MODEL, lines: kept });
    while (made.size > 3) made.delete(made.keys().next().value);
    const done = { type: "comic:done", lines, pictures: sent, skipped: r.skipped.length, ...(job.noDraw ? { note: job.noDraw } : {}), tickets: Math.round(job.tickets), usd: job.pay === "key" ? r.cost : 0 };
    await toTab(tabId, done);
    ext.runtime.sendMessage({ type: "comic:status", tabId, step: "done", lines: lines.length, pictures: sent }).catch(() => {});
  }

  ext.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || m.target !== "comic" || (sender && sender.tab && !String(sender.url || "").startsWith(ext.runtime.getURL("")))) return; // (the popup only, never a site's page)
    if (m.op === "stop") { const j = jobs.get(m.tabId); if (j) j.abort(); sendResponse({ ok: true }); return; }
    if (m.op === "listen" && Number.isInteger(m.tabId)) { // (the popup: how this page's Listen is paid)
      const key = m.keys && m.keys[OPENROUTER];
      listens.set(m.tabId, { pay: m.pay === "tickets" ? "tickets" : "key", key: typeof key === "string" ? key : "", token: String(m.token || ""),
        openrouter: DEV && /^https:\/\/127\.0\.0\.1:\d+\/[\w/-]*$/.test(String(m.openrouter || "")) ? m.openrouter.replace(/\/$/, "") : OPENROUTER });
      sendResponse({ ok: true });
      return;
    }
    if (m.op === "save" && Number.isInteger(m.tabId)) { // (the popup's Save to library: the last translation of that tab into the library)
      const got = made.get(m.tabId);
      if (!got) { sendResponse({ error: "nothing translated to save: translate it first" }); return; }
      (async () => {
        const bytes = async (b) => (b ? { bytes: new Uint8Array(await b.arrayBuffer()) } : null);
        const originals = [];
        for (const b of got.originals) originals.push(await bytes(b));
        const pics = [];
        for (const b of got.pictures) pics.push(await bytes(b));
        if (typeof P2PHostComic === "undefined") throw new Error("the library is not running in this browser");
        return P2PHostComic.save({ url: String(m.url || ""), novelName: String(m.novelName || "").slice(0, 300), pageTitle: String(m.pageTitle || "").slice(0, 300), lang: "en", originals, made: pics, lines: got.lines, madeWith: got.madeWith });
      })().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    }
    if (m.op === "zip" && Number.isInteger(m.tabId)) { // (the popup's Download zip: the translated pictures of that tab as one ZIP, in order; the popup downloads it from the address)
      const got = made.get(m.tabId);
      if (!got) { sendResponse({ error: "nothing translated to download: translate it first" }); return; }
      (async () => {
        const ext2 = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
        const files = [];
        for (let i = 0; i < got.originals.length; i++) {
          const b = got.pictures[i] || got.originals[i]; // (a picture nothing was drawn on is as it was)
          files.push({ name: String(i + 1).padStart(3, "0") + "." + (ext2[b.type] || "jpg"), data: new Uint8Array(await b.arrayBuffer()) });
        }
        const lines = got.lines.map((l) => (l.speaker ? l.speaker + ": " : "") + l.en).join("\n\n");
        files.push({ name: "lines.txt", data: new TextEncoder().encode(lines) });
        if (got.zipUrl) URL.revokeObjectURL(got.zipUrl);
        got.zipUrl = URL.createObjectURL(new Blob([ImageChapter.zip(files)], { type: "application/zip" }));
        return { url: got.zipUrl, count: got.originals.length };
      })().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    }
    if (m.op === "speech" && Number.isInteger(m.tabId)) { speechOf(m.tabId, m.text, m.voice).then(sendResponse); return true; } // (passed on by the background from the page)
    if (m.op !== "translate" || !Number.isInteger(m.tabId) || !Array.isArray(m.urls) || !m.urls.length || m.urls.length > 400) { sendResponse({ error: "nothing to translate" }); return; }
    const had = jobs.get(m.tabId);
    if (had) had.abort();
    const ac = new AbortController();
    jobs.set(m.tabId, ac);
    run(m, ac.signal).catch((e) => {
      const stopped = ac.signal.aborted || (e && e.stopped);
      const msg = { step: stopped ? "stopped" : "failed", error: stopped ? "" : String((e && e.message) || e) };
      toTab(m.tabId, Object.assign({ type: "comic:progress" }, msg));
      ext.runtime.sendMessage({ type: "comic:status", tabId: m.tabId, ...msg }).catch(() => {});
    }).finally(() => { if (jobs.get(m.tabId) === ac) jobs.delete(m.tabId); });
    sendResponse({ ok: true });
  });
  // (Firefox: the background page is this page, and a page's own messages do not reach it: the pill's Stop is passed on here directly)
  globalThis.ComicHost = { stop: (tabId) => { const j = jobs.get(tabId); if (j) j.abort(); }, speech: speechOf };
})();
