// A comic's chapter page translated in its pictures, from the popup (docs/COMICS.md, docs/ADD-BOOK.md): nothing is kept, the pictures made again are put in the page
// in place of the site's (comic-page.js in the tab), for as long as it is open. Runs where the text detector can (WebAssembly in an extension page): Chrome's offscreen
// page, Firefox's background page; with ComicTranslate (comic-translate.js), onnxruntime-web (ort/) and PaddleOCR's detector (models/, Apache-2.0).
// Paid as the popup says, "key" or "tickets" (the playground's /api/comic, with the sign-in the library's page handed over for this extension), and by the models the person's rules
// give (Settings › Model rules, handed over by the library's page: pay.js): the top row of each step that can be paid for, the next when it fails. With no rules, the defaults.
//   { target: "comic", op: "translate", tabId, urls, referer, pay, keys, token, rules, prompts, into, fresh }   -> { ok } when it has started; progress and pictures go to the tab
//        (the same pictures made already, or being made ahead, are shown as they are, unless fresh: Translate again)
//   { target: "comic", op: "ahead", tabId, pages: [{ url, pictures }], pay, keys, token, rules, prompts, into }   the next pages, made one after another while the tab is on this one
//        (Translate ahead, translate-ahead.js); what is no longer ahead stops
//   { target: "comic", op: "drop", tabId }   Translate ahead ended for the tab: what was made ahead of it is let go
//   { target: "comic", op: "stop", tabId }
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const PLAYGROUND = "https://playground.heavenlydao.com";
  const OPENROUTER = "https://openrouter.ai/api/v1";
  // (a dev build, whose library site is this computer, may be told to ask a stand-in on this computer instead: the e2e tests)
  const DEV = typeof SITE_BRIDGE_MATCHES !== "undefined" && SITE_BRIDGE_MATCHES.some((x) => /localhost|127\.0\.0\.1/.test(x));
  // (Komika Text Bold letters speech and thought in capitals; Comic Neue the rest, and those too when the Komika file is missing)
  const FONTS = [400, 700].map((weight) => ({ family: "Comic Neue", weight, url: ext.runtime.getURL("fonts/comic-neue-" + weight + ".woff2") }))
    .concat([{ family: "Komika Text", weight: 700, url: ext.runtime.getURL("fonts/komika-text-bold.ttf") }]);
  // to the tab: Firefox's background page has tabs; Chrome's offscreen page has only runtime, so the background passes it on
  const toTab = (tabId, msg) => (ext.tabs && ext.tabs.sendMessage ? ext.tabs.sendMessage(tabId, msg) : ext.runtime.sendMessage({ type: "comic:toTab", tabId, msg })).catch(() => {});
  // Each translation of a tab's pictures is a work kept here: the one its page shows (the popup's Translate), or one made ahead of the page (Translate ahead: the next pages,
  // before they are opened). { tabId, key, m (what was asked: the pictures, who pays), ac, pictures (made, by place), last (its last progress), done (its comic:done), failed,
  // record (for Save to library, Download zip), log, unread, running, queued, ahead }
  const works = new Map(); // tab -> [work], oldest first
  const shown = new Map(); // tab -> the work its page shows
  const aheadKeys = new Map(); // tab -> the keys of the pages ahead of it, nearest first
  // A tab keeps the page it shows, the pages ahead, and the one it was on before (going back a page is instant); that one goes too when the tab's pictures are over
  // MAX_TAB_BYTES (a webtoon's chapter is some 30 MB of pictures: the site's, the ones made, the model's own)
  const MAX_BEHIND = 1;
  const MAX_TAB_BYTES = 200 * 1024 * 1024;
  // the same pictures, wherever they are served from (nhentai.net gives a page's picture from i2. one time and i3. the next)
  const keyOf = (urls) => urls.map((u) => { try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return String(u); } }).join("\n");
  const isShown = (w) => shown.get(w.tabId) === w;
  const listOf = (tabId) => { if (!works.has(tabId)) works.set(tabId, []); return works.get(tabId); };
  const remove = (w) => {
    const list = works.get(w.tabId) || [];
    const i = list.indexOf(w);
    if (i >= 0) list.splice(i, 1);
    if (w.record && w.record.zipUrl && ![...made.values()].includes(w.record)) URL.revokeObjectURL(w.record.zipUrl); // (a Download zip made of it)
  };
  // to the tab in order: the pictures, then the end (a lane each tab)
  const lanes = new Map();
  const inLane = (tabId, fn) => { const p = (lanes.get(tabId) || Promise.resolve()).then(fn).catch(() => {}); lanes.set(tabId, p); return p; };
  const b64Of = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    return btoa(s);
  };
  const pictureToTab = (tabId, i, blob) => inLane(tabId, async () => toTab(tabId, { type: "comic:picture", i, b64: await b64Of(blob), mime: blob.type || "image/webp" }));
  const status = (tabId, msg) => ext.runtime.sendMessage({ type: "comic:status", tabId, ...msg }).catch(() => {}); // (the popup, when it is open)
  const listens = new Map(); // tab -> how its Listen is paid: { pay, key, token, openrouter }
  const logs = new Map(); // tab -> the error log of the last translation there: [{ t, step, model, payer, status, part, message, note }] (the popup shows it; pay.js logText)
  const unreadOf = new Map(); // tab -> the pictures its last translation could not read ("7–12, 30"; "" all read), for the popup opened again
  const made = new Map(); // tab -> what its last translation made, until the popup's Save to library keeps it in the library: { originals, pictures, lines, madeWith }
  // AI voices (Kokoro on OpenRouter, the library's usual): the narrator's, then one for each speaker in turn
  const SPEECH_MODEL = "hexgrad/kokoro-82m";
  const VOICES = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella", "am_adam", "bf_lily", "bm_lewis"];

  // The text finder's model, in a worker of its own (comic-detect-worker.js): on this page's thread its tiles held up the reading, the lettering and the messages until
  // every tile was done. A browser that will not start the worker has it here, as before, with the engine giving way between tiles.
  let detector = null;
  function detect() {
    if (!detector) detector = (async () => {
      const model = ext.runtime.getURL("models/ch_PP-OCRv4_det_infer.onnx");
      try {
        const worker = new Worker(ext.runtime.getURL("comic-detect-worker.js"));
        const asked = new Map();
        let seq = 0, idle = 0;
        const fail = (message) => { detector = null; worker.terminate(); for (const [, no] of asked.values()) no(new Error(message)); asked.clear(); };
        worker.onmessage = (ev) => {
          const got = asked.get(ev.data.id);
          if (!got) return;
          asked.delete(ev.data.id);
          if (ev.data.error) got[1](new Error(ev.data.error)); else got[0](ev.data.map);
        };
        worker.onerror = () => fail("The text finder could not be loaded");
        const rest = () => { clearTimeout(idle); idle = setTimeout(() => { if (!asked.size) { detector = null; worker.terminate(); } }, 60000); }; // (a minute with nothing to find: let go of)
        return (rgba, size) => new Promise((ok, no) => {
          const input = ComicTranslate.detectInput(rgba, size), id = ++seq;
          clearTimeout(idle);
          asked.set(id, [(map) => { rest(); ok(map); }, (e) => { rest(); no(e); }]);
          worker.postMessage({ id, model, input, size }, [input.buffer]);
        });
      } catch (e) { /* no worker here: on this page */ }
      ort.env.wasm.wasmPaths = ext.runtime.getURL("ort/");
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
      return async (rgba, size) => {
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", ComicTranslate.detectInput(rgba, size), [1, 3, size, size]) });
        const prob = out[session.outputNames[0]].data, map = new Uint8Array(size * size);
        for (let i = 0; i < map.length; i++) map[i] = Math.round(Math.max(0, Math.min(1, prob[i])) * 255);
        return map;
      };
    })().catch((e) => { detector = null; throw e; });
    return detector;
  }

  // ----- who pays and which model: the rules the person set in Settings › Model rules (pay.js, the library site's own code; the library's page hands them over, profile-translate.js keeps them) -----
  // The top row of a job that can be paid for is used; one that fails for who pays (a key refused, no credit, a limit, the provider down) is left out and the next is.
  const ITEM = { find: "comicFind", read: "comicRead", draw: "comicDraw" };
  // (OpenAI's quality setting is the only part of a drawing request that is theirs alone)
  const forModel = (kind, b) => { if (kind === "draw" && !/gpt-image/.test(b.model || "")) delete b.quality; return b; };
  const hasOf = (keys, token) => ({ patron: !!token, ticketsLeft: null, keys: Object.keys(keys || {}) });
  // who may pay: every row of the rules ("rules": the popup no longer picks), or, from an older popup, tickets only or none of them (this device finds the text either way)
  const payOk = (pay, c) => c.kind === "device" || pay === "rules" || (pay === "tickets" ? c.pay === "tickets" : c.pay !== "tickets");
  const payOf = (m) => (m === "tickets" || m === "rules" ? m : "key");
  const hostOf = (a) => { try { return new URL(a).host; } catch (e) { return String(a); } };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const payerOf = (c) => (c.pay === "tickets" ? "Tickets" : c.kind === "openrouter" ? "OpenRouter key" : c.kind === "gemini" ? "Gemini key" : hostOf(c.pay));
  // one line of the log: what failed, which model, who paid, what it said
  // the log the popup is given: every failure, and the newest of the rest (a line for each piece of text, the summary) up to 120 lines in all
  // (only the newest 120 were given: on a long chapter the pieces' lines pushed the reading's failures out)
  const logTail = (log) => {
    const errors = log.filter((l) => !l.method).slice(-120), kept = new Set(errors.concat(log.filter((l) => l.method).slice(-Math.max(1, 120 - errors.length))));
    return log.filter((l) => kept.has(l));
  };
  const logLine = (job, kind, pair, e) => ({ t: Date.now(), step: kind, model: pair ? pair.rule || pair.model : "", payer: pair ? payerOf(pair) : "", status: Number(e && e.status) || 0, message: String((e && e.message) || e).slice(0, 400) });

  // One request of a step to one payer's model. Throws with the status (Pay.skipFor says what a failure means)
  async function call(job, kind, pair, body) {
    let url, headers = { "Content-Type": "application/json" }, send;
    if (pair.pay === "tickets") {
      if (!job.token) throw Object.assign(new Error("No sign-in for tickets in this browser: open the library here while signed in"), { fatal: true });
      url = PLAYGROUND + "/api/comic";
      headers = Object.assign(headers, { Authorization: "Bearer " + job.token, "X-Playground": "1" });
      send = { kind, body: forModel(kind, Object.assign({}, body, { model: pair.rule || pair.model })) };
    } else {
      const key = job.keys[pair.pay];
      if (!key) throw Object.assign(new Error("Add your key for " + hostOf(pair.pay) + " in the library's Settings"), { status: 401 });
      url = (pair.pay === OPENROUTER ? job.openrouter : pair.pay) + (kind === "draw" ? "/images" : "/chat/completions");
      headers.Authorization = "Bearer " + key;
      send = forModel(kind, Object.assign({}, body, { model: pair.model }));
      if (pair.kind === "gemini") { send.reasoning_effort = "low"; delete send.usage; delete send.reasoning; delete send.temperature; }
      if (pair.kind === "other") { delete send.usage; delete send.reasoning; } // (a server of its own, an Ollama or LM Studio: only the standard parts of a chat request)
    }
    let r, j;
    for (let again = 0; ; again++) {
      r = await fetch(url, { method: "POST", headers, body: JSON.stringify(send), signal: job.signal });
      j = await r.json().catch(() => ({}));
      // (busy: the parts being drawn at once hold tickets, and the tickets are enough: asked again in a moment)
      if (pair.pay === "tickets" && r.status === 429 && j && (j.busy || /^(too many requests|six at once)/.test(String(j.error || ""))) && again < 40 && !job.signal.aborted) { await sleep(2500); continue; }
      // (a server that takes a schema and not "json_object", as LM Studio: the prompt asks for JSON already)
      if (pair.kind === "other" && r.status === 400 && send.response_format && /response_format|json_schema/i.test(JSON.stringify(j))) { send = Object.assign({}, send); delete send.response_format; continue; }
      if (kind === "draw" && r.status === 400 && pair.pay !== "tickets") { // (a model whose providers do not take the request as it is: made to fit, or, taking no picture in, left for the rules' next one)
        const said = ((j && j.error) || {}).message || JSON.stringify(j);
        const fit = ComicTranslate.fitDraw(send, said);
        if (fit && fit.body) { send = fit.body; continue; }
        if (fit && fit.unsupported) throw Object.assign(new Error(pair.model + " " + fit.unsupported + ": " + String(said).slice(0, 240)), { status: 400, unsupported: true });
      }
      break;
    }
    const err = Array.isArray(j) ? j[0] && j[0].error : j.error;
    if (!r.ok || err) {
      const e = new Error((err && (err.message || err)) || "The model said " + r.status);
      // (the playground answers 424 with what OpenRouter said: its 401-403, "Key limit exceeded", are the tickets' key out of money as well)
      e.status = [401, 402, 403].includes(Number(j && j.upstream)) ? 402 : r.status;
      throw e;
    }
    if (j.tickets) job.tickets += Number(j.tickets) || 0;
    return j;
  }

  // The steps' ask: the rules' first payer that works, the next when it fails; none left: reading stops the chapter, drawing leaves the parts as they are (with their English listed)
  function asker(job) {
    const skip = Pay.skipList(), waited = new Set();
    return async (kind, body) => {
      if (kind === "draw" && job.noDraw) throw Object.assign(new Error(job.noDraw), { repeat: true }); // (drawing could not be paid for: the parts stay as they are, with their English listed; said once, in the log)
      let last = null;
      for (let round = 0; round < 4; round++) {
        // (this device is no payer of a request: a vision model's are the rules' others)
        const pair = Pay.best(ITEM[kind], job.has, (c) => c.kind === "device" || !payOk(job.pay, c) || skip.has(c, "chapter"));
        if (!pair) break;
        try {
          const j = await call(job, kind, pair, body);
          Object.defineProperty(j, "_via", { value: { model: pair.rule || pair.model, payer: payerOf(pair) }, enumerable: false }); // (which model drew a part: the log says it)
          return j;
        } catch (e) {
          if (job.signal.aborted) throw e;
          const entry = logLine(job, kind, pair, e);
          job.log.push(entry);
          e.logEntry = entry; // (the engine says which picture it was, when it fails the part)
          if (e.fatal) throw e;
          last = e;
          const how = Pay.skipFor(e);
          if (how === "unsupported") { entry.note = "not used again in this chapter"; skip.add(pair, "chapter", "chapter"); continue; } // (this model cannot be asked this: the rules' next one)
          if (!how) throw e; // (a part the model will not draw: the engine tries it in halves)
          const once = kind + " " + pair.pay;
          if (how === "chapter" && !waited.has(once)) { waited.add(once); await sleep(6000); continue; } // (busy: once more)
          skip.add(pair, how, "chapter");
        }
      }
      if (kind === "draw") {
        job.noDraw = last ? "Drawing was not paid for: " + String((last && last.message) || last).replace(/[.\s]+$/, "") : "Drawing needs an OpenRouter key: add it in the library's Settings";
        if (!last) job.log.push(logLine(job, kind, null, new Error(job.noDraw)));
        throw Object.assign(new Error(job.noDraw), { logEntry: last && last.logEntry });
      }
      if (!last) job.log.push(logLine(job, kind, null, new Error("Nothing to pay for reading the pictures with")));
      throw Object.assign(last instanceof Error ? last : new Error("Add a Gemini or OpenRouter key in the library's Settings"), { fatal: true });
    };
  }

  // A line read aloud, paid as the popup said, by the rules' voice rows this can ask (OpenRouter's or an address's /audio/speech, the playground's /api/speech for tickets; a Gemini or
  // Fish Audio key's voice is the library page's own) -> { audio (base64 mp3), type } | { error }
  async function speechOf(tabId, text, voice) {
    const job = listens.get(tabId);
    if (!job) return { error: "Listen was not set up for this page" };
    const pairs = Pay.choices("voice", job.has).filter((c) => ["tickets", "openrouter", "other"].includes(c.kind) && payOk(job.pay, c));
    if (!pairs.length) return { error: job.pay === "tickets" ? "No sign-in for tickets in this browser: open the library here while signed in" : "Add an OpenRouter key in the library's Settings" };
    let last = "";
    for (const pair of pairs) {
      if (job.skip.has(pair, "listen")) continue;
      const kokoro = /kokoro/i.test(pair.model);
      const body = JSON.stringify({ model: pair.rule || pair.model, input: String(text || "").slice(0, 4000), voice: kokoro ? VOICES[Math.max(0, Number(voice) || 0) % VOICES.length] : "alloy", response_format: "mp3" });
      try {
        let r;
        if (pair.pay === "tickets") {
          r = await fetch(PLAYGROUND + "/api/speech", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + job.token, "X-Playground": "1" }, body });
        } else {
          const key = job.keys[pair.pay];
          if (!key) { last = "Add your key for " + hostOf(pair.pay) + " in the library's Settings"; continue; }
          r = await fetch((pair.pay === OPENROUTER ? job.openrouter : pair.pay) + "/audio/speech", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body });
        }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          const why = j && (j.error && j.error.message || j.error);
          last = String(why || "The voice's service said " + r.status).slice(0, 200);
          const how = Pay.skipFor({ status: r.status });
          if (how) { job.skip.add(pair, how, "listen"); continue; } // (refused, no credit, a limit: the rules' next voice)
          return { error: last };
        }
        const bytes = new Uint8Array(await r.arrayBuffer());
        let s = "";
        for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
        return { audio: btoa(s), type: r.headers.get("content-type") || "audio/mpeg" };
      } catch (e) {
        last = String((e && e.message) || e);
        if (Pay.skipFor(e)) { job.skip.add(pair, Pay.skipFor(e), "listen"); continue; }
        return { error: last };
      }
    }
    return { error: last || "No voice could be asked" };
  }

  // One of the page's pictures, as fetchPages asks for it: its bytes, or an error that says which picture (fatal, not asked again: a 404 or 410, or the work stopped)
  const PICTURE_MS = 45 * 1000;
  async function pictureOf(url, i, n, signal) {
    const stopped = () => Object.assign(new Error("Stopped"), { stopped: true, fatal: true });
    if (signal.aborted) throw stopped();
    const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(PICTURE_MS) : null;
    const either = timeout && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
    try {
      const res = await fetch(url, { credentials: "include", signal: either });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status + " for picture " + (i + 1) + " of " + n), { fatal: res.status === 404 || res.status === 410, said: true });
      return await res.blob(); // (the body too, under the same time)
    } catch (e) {
      if (e && e.said) throw e;
      if (signal.aborted) throw stopped();
      if (timeout && timeout.aborted) throw new Error("picture " + (i + 1) + " of " + n + " did not come in " + PICTURE_MS / 1000 + " seconds");
      let host = ""; try { host = new URL(url).host; } catch (e2) { /* not an address */ }
      throw new Error("Could not load picture " + (i + 1) + " of " + n + (host ? " from " + host + ": the extension is not allowed to read it, or it refused" : ""));
    }
  }

  async function run(w) {
    const m = w.m, tabId = w.tabId, signal = w.ac.signal;
    Pay.useRules(m.rules || {}); // (what the person set in Settings › Model rules; none: the defaults)
    const mode = Pay.drawMode(); // (the drawing's rows: Lettered here first, after the models, or not there; and whether a model is in them at all)
    const job = { pay: payOf(m.pay), keys: m.keys || {}, token: String(m.token || ""), signal, tickets: 0, log: [], has: hasOf(m.keys, m.token),
      openrouter: DEV && /^https:\/\/127\.0\.0\.1:\d+\/[\w/-]*$/.test(String(m.openrouter || "")) ? m.openrouter.replace(/\/$/, "") : OPENROUTER };
    w.log = job.log;
    if (isShown(w)) logs.set(tabId, job.log);
    // (its progress goes to the tab while the tab shows it; a page made ahead keeps its last, for when the tab gets to it)
    // (none once the work has failed or been stopped: its failure is the last thing the page and the popup are told)
    const tell = (msg) => { if (w.over || signal.aborted) return; w.last = msg; if (isShown(w)) { toTab(tabId, Object.assign({ type: "comic:progress" }, msg)); status(tabId, msg); } };
    tell({ step: "loading", done: 0, of: m.urls.length });
    const release = typeof Referer !== "undefined" ? await Referer.use(m.urls, m.referer || "").catch(() => () => {}) : () => {};
    const sources = [];
    const originals = []; // (the site's pictures as they came, for Save to library)
    // (the pictures decoded take far more memory than their files, a webtoon's 35 some 300 MB: let go of as soon as the translation is done, or failed)
    const freeSources = () => { for (const b of sources) { try { b.close(); } catch (e) { /* closed */ } } };
    try {
      // two at a time, gently, each tried again after 2, 4 and 8 seconds (not a 404 or 410: ImageChapter.fetchPages), and given PICTURE_MS: a picture server refuses one
      // now and then (mh160mh.com's answers 415 to about one picture in twenty, and sends it when asked again), or may hold a request open
      const blobs = await ImageChapter.fetchPages(m.urls, (url, i) => pictureOf(url, i, m.urls.length, signal), { parallel: 2, onProgress: (done, all) => tell({ step: "loading", done, of: all }) });
      for (const blob of blobs) {
        if (signal.aborted) throw Object.assign(new Error("Stopped"), { stopped: true });
        originals.push(blob);
        sources.push(await createImageBitmap(blob));
      }
    } catch (e) {
      freeSources();
      throw e;
    } finally {
      release();
    }
    // where the text is: the text detector on this device, or the vision model the rules give (its boxes, asked chunk by chunk)
    const finder = Pay.best("comicFind", job.has, (c) => !payOk(job.pay, c)) || Pay.best("comicFind", job.has);
    const onDevice = !finder || finder.pay === "device";
    // every failure the engine meets, with the picture it was on (the asker's own lines get it added; one it did not log, a drawing that came back with no picture, is a line of its own)
    const sizes = sources.map((b) => ({ width: b.width, height: b.height }));
    const onError = (p) => {
      if (p.error && p.error.repeat) return;
      const a = ComicTranslate.pageAt(sizes, p.y0), z = ComicTranslate.pageAt(sizes, p.y1 - 1), part = "picture " + (a + 1) + (z !== a ? "–" + (z + 1) : "");
      if (p.error && p.error.logEntry) { p.error.logEntry.part = part; p.error.logEntry.note = p.note; return; }
      job.log.push({ ...logLine(job, p.step, null, { message: p.message, status: p.status }), part, note: p.note });
    };
    // each picture made goes to the tab as soon as it is, one after another (base64: the tab makes its own address for it); the engine finds, reads and draws down the
    // strip at once, so the first pictures are in the page while the rest are still being read (a picture a later part reached after all comes again). A page made
    // ahead keeps them, and they go to the tab when it gets to that page.
    const send = (i, blob) => {
      w.pictures[i] = blob;
      if (isShown(w)) pictureToTab(tabId, i, blob);
    };
    let r;
    try {
      r = await ComicTranslate.translate(sources, { ask: asker(job), onError, keepRaw: m.urls.length <= 40, letter: mode.letter, draw: mode.models, method: "full", detect: onDevice ? await detect() : undefined, findModel: onDevice ? undefined : finder.rule || finder.model, fonts: FONTS, into: m.into || "English", prompts: m.prompts && typeof m.prompts === "object" ? m.prompts : undefined, signal,
        onPicture: send, onProgress: (p) => tell({ step: p.step, done: p.done, of: p.of, counts: p.counts }) });
    } finally {
      freeSources();
      await (lanes.get(tabId) || Promise.resolve()); // (what was made before a stop or a failure stays in the page)
    }
    const sent = w.pictures.filter(Boolean).length;
    // (each line with the picture it is on and its box there, as the library keeps them: the reader's overlay; their sizes are all it reads of the pictures)
    const kept = ComicTranslate.linesOf(sizes, r);
    const lines = kept.map((l) => ({ en: l.en, speaker: l.speaker || null, kind: l.kind, notDrawn: !!l.notDrawn }));
    // how each piece of text was done (lettered here, drawn by which model, over a patch, not drawn), for the log
    const how = ComicTranslate.methodsOf(sizes, r), at = Date.now();
    if (how.entries.length) job.log.push(...how.entries.map((e) => ({ t: at, ...e })), { t: at, step: "draw", method: "summary", message: how.summary });
    w.record = { originals, pictures: r.pictures, rawPictures: r.rawPictures, madeWith: ((Pay.best("comicRead", job.has, (c) => !payOk(job.pay, c)) || {}).rule || ComicTranslate.READ_MODEL) + " + " + ((Pay.best("comicDraw", job.has, (c) => c.kind === "device" || !payOk(job.pay, c)) || {}).rule || ComicTranslate.DRAW_MODEL), lines: kept };
    const rawKept = !!(r.rawPictures && r.rawPictures.some(Boolean));
    const unread = ComicTranslate.unreadOf(sizes, r); // (pictures whose reading failed even in parts: "7–12", said on the card and the pill, not left looking done)
    w.unread = unread;
    w.done = { type: "comic:done", log: logTail(job.log), rawKept, lines, pictures: sent, skipped: r.skipped.length, ...(unread ? { unread } : {}), ...(job.noDraw ? { note: job.noDraw } : {}), tickets: Math.round(job.tickets), usd: job.pay === "tickets" || job.tickets ? 0 : r.cost, ...(w.ahead ? { ahead: true } : {}) };
    if (isShown(w)) await finish(w);
  }

  // A work the tab shows is done: Save to library, Download zip and Model output use it, the tab and the popup are told
  function finish(w) {
    const tabId = w.tabId;
    made.set(tabId, w.record);
    while (made.size > 3) made.delete(made.keys().next().value);
    unreadOf.set(tabId, w.unread || "");
    logs.set(tabId, w.log || []);
    status(tabId, { step: "done", lines: w.done.lines.length, pictures: w.done.pictures, log: w.done.log, rawKept: w.done.rawKept, unread: w.unread || "" });
    return inLane(tabId, () => toTab(tabId, w.done));
  }

  // The tab shows this work now: what it has made goes to the page, then where it is (done, failed, or its last progress); one shown before that is still being made is stopped
  function show(w) {
    const tabId = w.tabId, before = shown.get(tabId);
    shown.set(tabId, w);
    w.at = Date.now(); // (the last shown is the one kept behind)
    if (before && before !== w && before.running) before.ac.abort();
    logs.set(tabId, w.log || []);
    w.pictures.forEach((b, i) => { if (b) pictureToTab(tabId, i, b); });
    if (w.done) finish(w);
    else if (w.failed) { inLane(tabId, () => toTab(tabId, Object.assign({ type: "comic:progress" }, w.failed))); status(tabId, w.failed); }
    else if (w.last) { inLane(tabId, () => toTab(tabId, Object.assign({ type: "comic:progress" }, w.last))); status(tabId, w.last); }
    if (w.queued) { w.queued = false; start(w); } // (a page ahead that had not started: now, as the page)
    trim(tabId);
    tellAhead(tabId);
  }

  function work(m, ahead) {
    return { tabId: m.tabId, key: keyOf(m.urls), m, ac: new AbortController(), pictures: [], log: [], running: false, queued: false, ahead: !!ahead, at: Date.now() };
  }
  function start(w) {
    w.running = true;
    run(w).catch((e) => {
      const stopped = w.ac.signal.aborted || (e && e.stopped);
      w.over = true; // (anything of it still under way says nothing more)
      w.failed = { step: stopped ? "stopped" : "failed", error: stopped ? "" : String((e && e.message) || e), log: logTail(w.log || []) };
      if (isShown(w)) { inLane(w.tabId, () => toTab(w.tabId, Object.assign({ type: "comic:progress" }, w.failed))); status(w.tabId, w.failed); }
      else remove(w); // (a page ahead that failed or was stopped: made again if the tab gets to it)
    }).finally(() => { w.running = false; tellAhead(w.tabId); pump(w.tabId); });
  }
  // the pages ahead are made one after another, and only while nothing else of the tab is being made (the page it shows comes first)
  function pump(tabId) {
    const list = works.get(tabId) || [];
    if (list.some((w) => w.running)) return;
    const next = list.find((w) => w.queued);
    if (next) { next.queued = false; start(next); }
  }
  // the page's pill says how many of the pages ahead are ready
  function tellAhead(tabId) {
    const keys = aheadKeys.get(tabId) || [];
    const list = works.get(tabId) || [];
    const ready = keys.filter((k) => list.some((w) => w.key === k && w.done)).length;
    toTab(tabId, { type: "comic:aheadState", ready, of: keys.length });
  }

  // The popup's Translate (or the tab gone on to a page, Translate ahead): the same pictures made already or being made are shown; else they are made now
  function translate(m) {
    const list = listOf(m.tabId);
    const key = keyOf(m.urls);
    for (const x of list.slice()) if (x.key === key && x.failed && !x.running) remove(x);
    const had = list.find((w) => w.key === key && !w.failed);
    if (had && !m.fresh) return show(had);
    if (had) { if (had.running || had.queued) had.ac.abort(); had.queued = false; remove(had); }
    const w = work(m, false);
    list.push(w);
    show(w);
    start(w);
    trim(m.tabId);
  }
  // The next pages (Translate ahead): each made unless it is already; what is no longer ahead and not made yet is stopped (the tab went elsewhere)
  function ahead(m) {
    const tabId = m.tabId, list = listOf(tabId);
    const pages = m.pages.filter((p) => Array.isArray(p.pictures) && p.pictures.length && p.pictures.length <= 400);
    const keys = pages.map((p) => keyOf(p.pictures));
    aheadKeys.set(tabId, keys);
    for (const w of list.slice()) {
      if (isShown(w) || keys.includes(w.key) || w.done) continue;
      if (w.running || w.queued) { w.queued = false; w.ac.abort(); remove(w); }
    }
    pages.forEach((p, i) => {
      if (list.some((w) => w.key === keys[i] && !w.failed)) return;
      const w = work(Object.assign({}, m, { urls: p.pictures, referer: p.url, pages: undefined }), true);
      w.queued = true;
      list.push(w);
    });
    trim(tabId);
    pump(tabId);
    tellAhead(tabId);
  }
  // The pages behind the one shown: at most MAX_BEHIND, the last shown kept, and none while the tab's pictures are over MAX_TAB_BYTES (the page shown and the ones ahead
  // are never let go of here)
  const bytesOf = (w) => [w.record ? w.record.originals : null, w.record ? w.record.pictures : w.pictures, w.record ? w.record.rawPictures : null]
    .reduce((n, list) => n + (list || []).reduce((k, b) => k + ((b && b.size) || 0), 0), 0);
  function trim(tabId) {
    const list = works.get(tabId) || [];
    const keys = aheadKeys.get(tabId) || [];
    const behind = list.filter((w) => !isShown(w) && !keys.includes(w.key) && !w.running && !w.queued).sort((a, b) => b.at - a.at);
    for (const w of behind.slice(MAX_BEHIND)) remove(w);
    let total = list.reduce((n, w) => n + bytesOf(w), 0);
    for (const w of behind.slice(0, MAX_BEHIND)) {
      if (total <= MAX_TAB_BYTES) break;
      total -= bytesOf(w);
      remove(w);
    }
  }
  // Translate ahead ended for the tab: the pages ahead stop, and what was made ahead of it goes (the page it shows stays)
  function drop(tabId) {
    aheadKeys.delete(tabId);
    for (const w of (works.get(tabId) || []).slice()) {
      if (isShown(w)) continue;
      if (w.running || w.queued) { w.queued = false; w.ac.abort(); }
      remove(w);
    }
    tellAhead(tabId);
  }
  // Stop (the pill, the popup): all that is being made for the tab
  function stop(tabId) {
    for (const w of (works.get(tabId) || []).slice()) {
      if (w.queued) { w.queued = false; remove(w); }
      else if (w.running) w.ac.abort();
    }
  }

  ext.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || m.target !== "comic" || (sender && sender.tab && !String(sender.url || "").startsWith(ext.runtime.getURL("")))) return; // (the popup only, never a site's page)
    if (m.op === "stop") { stop(m.tabId); sendResponse({ ok: true }); return; }
    if (m.op === "ahead" && Number.isInteger(m.tabId) && Array.isArray(m.pages)) { aheadChecked(m); sendResponse({ ok: true }); return; } // (the background: Translate ahead)
    if (m.op === "drop" && Number.isInteger(m.tabId)) { drop(m.tabId); sendResponse({ ok: true }); return; }
    // (what a tab keeps: its pages' pictures, by path, and where each is; the e2e tests read it)
    if (m.op === "works" && Number.isInteger(m.tabId)) { sendResponse({ works: (works.get(m.tabId) || []).map((w) => ({ key: w.key, shown: isShown(w), done: !!w.done, running: w.running, queued: w.queued, bytes: bytesOf(w) })) }); return; }
    if (m.op === "listen" && Number.isInteger(m.tabId)) { // (the popup: how this page's Listen is paid)
      Pay.useRules(m.rules || {});
      listens.set(m.tabId, { pay: payOf(m.pay), keys: m.keys || {}, has: hasOf(m.keys, m.token), skip: Pay.skipList(), token: String(m.token || ""),
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
    if (m.op === "saveText") { // (the popup's Save to library on a text chapter: the page's text and its translation, as the popup read them from the page)
      if (typeof P2PHostComic === "undefined" || !P2PHostComic.saveText) { sendResponse({ error: "the library is not running in this browser" }); return; }
      P2PHostComic.saveText({ url: String(m.url || ""), novelName: String(m.novelName || "").slice(0, 300), pageTitle: String(m.pageTitle || "").slice(0, 300), lang: String(m.lang || "en"),
        original: String(m.original || "").slice(0, 200000), translated: String(m.translated || "").slice(0, 200000), model: String(m.model || "").slice(0, 200) })
        .then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ error: String((e && e.message) || e) }));
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
    if (m.op === "log" && Number.isInteger(m.tabId)) { // (the popup opened again after a translation)
      const got = made.get(m.tabId);
      sendResponse({ log: logTail(logs.get(m.tabId) || []), rawKept: !!(got && got.rawPictures && got.rawPictures.some(Boolean)), unread: unreadOf.get(m.tabId) || "" });
      return;
    }
    if (m.op === "raw" && Number.isInteger(m.tabId)) { // (the popup's Model output: the pictures the image model made, no masks, put in the page in place of the translation)
      const got = made.get(m.tabId);
      if (!got || !got.rawPictures || !got.rawPictures.some(Boolean)) { sendResponse({ error: "the model's own pictures were not kept (a chapter of more than 40 pictures keeps none)" }); return; }
      (async () => {
        for (let i = 0; i < got.rawPictures.length; i++) {
          if (!got.rawPictures[i]) continue;
          const bytes = new Uint8Array(await got.rawPictures[i].arrayBuffer());
          let s = "";
          for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
          await toTab(m.tabId, { type: "comic:raw", i, b64: btoa(s), mime: got.rawPictures[i].type || "image/webp" });
        }
        await toTab(m.tabId, { type: "comic:showraw" });
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    }
    if (m.op === "speech" && Number.isInteger(m.tabId)) { speechOf(m.tabId, m.text, m.voice).then(sendResponse); return true; } // (passed on by the background from the page)
    sendResponse(translateChecked(m));
  });
  // (what is asked is checked: at most 400 pictures a page; the pages ahead, at most 5, are a site's pages' pictures)
  const okUrls = (urls) => Array.isArray(urls) && urls.length > 0 && urls.length <= 400 && urls.every((u) => typeof u === "string" && /^https?:\/\//.test(u));
  function translateChecked(m) {
    if (m.op !== "translate" || !Number.isInteger(m.tabId) || !Array.isArray(m.urls) || !m.urls.length || m.urls.length > 400 || !m.urls.every((u) => typeof u === "string")) return { error: "nothing to translate" };
    translate(m);
    return { ok: true };
  }
  function aheadChecked(m) {
    if (!m || !Number.isInteger(m.tabId) || !Array.isArray(m.pages)) return;
    ahead(Object.assign({}, m, { pages: m.pages.slice(0, 5).filter((p) => p && okUrls(p.pictures)).map((p) => ({ url: String(p.url || ""), pictures: p.pictures })) }));
  }
  // (Firefox: the background page is this page, and a page's own messages do not reach it: the pill's Stop, a voice, and Translate ahead are passed on here directly)
  globalThis.ComicHost = { stop, speech: speechOf, translate: (m) => translateChecked(Object.assign({}, m, { op: "translate" })), ahead: (m) => aheadChecked(m), drop };
})();
