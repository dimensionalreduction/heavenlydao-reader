// In a chapter's page, from the popup (docs/ADD-BOOK.md): nothing here is kept. Run in the tab before a comic's chapter is translated (comic-host.js does the work):
// the made pictures are put in place of the site's own (<img> by <img>, the same order as the addresses the popup found), Show original puts the site's back, and a small
// pill says how far it is. Listen reads a translated text chapter's paragraphs aloud (content.js leaves them in window.__P2PREAD_TRANSLATED__); a comic has no Listen.
//   window.__P2PREAD_COMIC_URLS__   the chapter's pictures' addresses, set by the popup before this runs (null: Translate ahead puts this in a page it went on to, which
//                                   finds its pictures itself: "comic:continue")
// Translate ahead (translate-ahead.js, the popup's switch): "comic:ahead" finds the next pages (their Next links, fetched as the tab would) and their pictures, which the
// extension makes before they are opened; "comic:continue" (the tab went on to another page of the site, loaded or shown in place) shows that page's pictures as made, or
// being made, and goes on ahead from there.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  if (window.__p2preadComicPage) { if (window.__P2PREAD_COMIC_URLS__ !== null) window.__p2preadComicPage.reset(window.__P2PREAD_COMIC_URLS__ || []); return; }
  const STEP = { loading: "Loading pictures", finding: "Finding text", reading: "Reading", drawing: "Drawing" };
  const state = { imgs: [], made: [], raw: [], urls: [], showing: "original", lines: [], status: "", error: "", voiceError: "", voice: "browser", at: "", where: "" };
  let textMode = null; // (a text chapter's translator, content.js: api.text)
  const aheadNow = { ready: 0, of: 0 }; // (the pages ahead and how many of them are made: the pill says so)
  let aheadRun = 0; // (each look ahead has a number: one started after it, or ✕, makes it stale)
  const here = () => location.href.split("#")[0];

  // the page's <img> for each address (its lazy-load attribute first, as ImageChapter.imgUrl reads it); `taken`: <img> already given to an address
  function imagesFor(urls, taken) {
    const abs = (v) => { try { return new URL(v, location.href).href; } catch (e) { return ""; } };
    const srcOf = (img) => abs(img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.currentSrc || img.getAttribute("src") || "");
    const used = new Set(taken || []); // (the same picture twice on a page: each address is given its own <img>, in order)
    // (each <img> read once, under each address it has: a strip of 132 pictures, matched each time the site adds some, is not 132 x 132 addresses read)
    const byAddress = new Map();
    for (const img of document.images) {
      if (used.has(img)) continue;
      for (const a of new Set([srcOf(img), img.currentSrc, img.src])) if (a) (byAddress.get(a) || byAddress.set(a, []).get(a)).push(img);
    }
    return urls.map((u) => { const img = (byAddress.get(u) || []).find((i) => !used.has(i)) || null; if (img) used.add(img); return img; });
  }

  // the pill, bottom right: how far it is, Show original / translated, Listen, Stop
  const pill = document.createElement("div");
  pill.id = "p2pread-pill";
  pill.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483646;display:flex;gap:6px;align-items:center;padding:8px 10px;border-radius:12px;" +
    "background:#1c2027;color:#d6dae0;font:13px/1.3 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:min(92vw,420px)";
  const text = document.createElement("span");
  const btn = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.style.cssText = "font:inherit;padding:5px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#14171c;color:inherit;cursor:pointer"; b.onclick = fn; return b; };
  // (a text chapter's: its translator's own, content.js: textMode)
  const toggle = btn("Show original", () => (textMode ? textMode.toggle() : show(state.showing === "made" ? "original" : "made")));
  const listen = btn("▶ Listen", () => (speaking ? stopSpeaking() : speak()));
  const stop = btn("Stop", () => (textMode ? textMode.stop() : ext.runtime.sendMessage({ type: "comic:stop" }).catch(() => {})));
  // (✕ also ends Translate ahead in this tab: the next page is the site's own again)
  const close = btn("✕", () => { stopSpeaking(); if (textMode) { textMode.stop(); textMode.toggle("original"); } else show("original"); pill.remove(); aheadRun++; ext.runtime.sendMessage({ type: "ahead:stop" }).catch(() => {}); });
  pill.append(text, toggle, listen, stop, close);

  function paint() {
    const next = aheadNow.of && !state.error && !state.voiceError ? " · Next " + aheadNow.of + ": " + (aheadNow.ready >= aheadNow.of ? "ready" : aheadNow.ready + " ready") : "";
    text.textContent = (state.voiceError ? "Couldn't read aloud: " + state.voiceError : state.error ? "Couldn't translate: " + state.error : state.status) + next;
    toggle.hidden = textMode ? !state.textMade : !state.made.some(Boolean);
    toggle.textContent = state.showing === "made" ? "Show original" : "Show translated";
    listen.hidden = state.imgs.length > 0 || !window.__P2PREAD_TRANSLATED__; // (a comic has no Listen)
    stop.hidden = textMode ? !state.textRunning : !/…$/.test(state.status);
    if (!pill.isConnected) document.documentElement.append(pill);
  }
  // A site that loads its pictures as they come into view keeps the real address in an attribute and a placeholder in src (wfwf528.com: data-src and sprite.png), and its
  // script puts the real one in src when the picture is near the screen. So: the original is the real address (not the placeholder), those attributes are taken off while
  // the pictures made are shown (else the site's script puts its own back), and a src the site changes meanwhile is put back to ours.
  const LAZY = ["data-src", "data-lazy-src", "data-original"];
  const absolute = (v) => { try { return new URL(v, location.href).href; } catch (e) { return v; } };
  function originalOf(img) {
    if (!img.__p2preadOriginal) {
      const lazy = {};
      for (const a of LAZY) if (img.hasAttribute(a)) lazy[a] = img.getAttribute(a);
      const real = Object.values(lazy).find(Boolean);
      img.__p2preadOriginal = { src: real ? absolute(real) : img.getAttribute("src"), srcset: img.getAttribute("srcset"), lazy, placeholder: real ? img.getAttribute("src") : null };
    }
    return img.__p2preadOriginal;
  }
  // What the picture shows now: the translation (or the model's own), when one of those is the view
  const ours = (i) => (state.showing === "raw" ? state.raw[i] || state.made[i] : state.showing === "made" ? state.made[i] : "");
  // A site that shows its next page in the same <img> (nhentai's reader: /g/1/1, then /g/1/2, with no new page loaded) puts a picture there that is not the one translated: the
  // translation was of the other page, so it is let go (not put over this one), and the pill goes. The site's own picture again (its lazy loader's real address or placeholder) is put back to ours.
  function watch(img, i) {
    if (img.__p2preadWatch) return;
    img.__p2preadWatch = new MutationObserver(() => {
      if (!state.made[i] || img.__p2preadSetting) return;
      const was = originalOf(img), now = absolute(img.getAttribute("src") || "");
      const known = [was.src, was.placeholder, state.made[i], state.raw[i]].filter(Boolean).map(absolute);
      if (now && !known.includes(now)) return forget();
      const want = ours(i);
      if (!want || img.src === want) return;
      img.__p2preadSetting = true;
      img.removeAttribute("srcset");
      for (const a of LAZY) img.removeAttribute(a);
      img.src = want;
      img.__p2preadSetting = false;
    });
    img.__p2preadWatch.observe(img, { attributes: true, attributeFilter: ["src", "srcset", ...LAZY] });
  }
  // A strip the site adds to as it is read (mh160mh.com: its script puts the next pictures in a few at a time, as the page is scrolled): a picture of the chapter that was
  // not on the page yet is taken when it comes, and shows the one made for it as soon as there is one.
  let late = null;
  function fillLate() {
    if (!state.urls.length || state.imgs.every(Boolean)) return;
    let added = false;
    imagesFor(state.urls, state.imgs.filter(Boolean)).forEach((img, i) => {
      if (img && !state.imgs[i]) { state.imgs[i] = img; added = true; }
    });
    if (added && state.showing !== "original") show(state.showing);
  }
  function watchLate() {
    if (late || typeof MutationObserver === "undefined") return;
    let timer = 0;
    late = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(fillLate, 150); });
    late.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", ...LAZY] });
  }
  function show(which) {
    state.showing = which;
    state.imgs.forEach((img, i) => {
      if (!img || !state.made[i]) return;
      const was = originalOf(img);
      watch(img, i);
      img.__p2preadSetting = true; // (our own changes are not the site's)
      if (which === "made" || which === "raw") {
        img.removeAttribute("srcset");
        for (const a of LAZY) img.removeAttribute(a);
        img.src = which === "raw" ? state.raw[i] || state.made[i] : state.made[i];
      } else {
        for (const [a, v] of Object.entries(was.lazy)) img.setAttribute(a, v);
        img.src = was.src || "";
        if (was.srcset) img.setAttribute("srcset", was.srcset);
      }
      setTimeout(() => { img.__p2preadSetting = false; }, 0);
    });
    paint();
  }

  // ----- Listen: the browser's own voices (free), or an AI voice paid as the popup said (the extension makes the call: comic-host.js) -----
  let speaking = false;
  let run = 0; // (each Listen has a number; Stop makes the one going on stale)
  let playing = null; // the sound being played
  let audio = null;
  // how Listen goes: "loading" (its first line not heard yet), "playing", "" (not on). The pill's button and the popup's say it ("listen:status"; the popup opened
  // again asks api.listening()): Stop while loading too, so a press there stops it
  let listenIs = "";
  const LISTEN_LABEL = { "": "▶ Listen", loading: "■ Stop · Loading…", playing: "■ Stop" };
  function listenSay(st) {
    listenIs = st;
    listen.textContent = LISTEN_LABEL[st];
    ext.runtime.sendMessage({ type: "listen:status", state: st, error: state.voiceError || "" }).catch(() => {});
  }
  const decode = async (b64) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    audio = audio || new (window.AudioContext || window.webkitAudioContext)(); // (not an <audio> element: the page's own rules about media do not apply to it)
    if (audio.state === "suspended") await audio.resume().catch(() => {});
    return audio.decodeAudioData(bytes.buffer);
  };
  async function speakAi(lines, speakers) {
    const mine = ++run;
    speaking = true;
    state.voiceError = "";
    listenSay("loading");
    const ask =(i) => ext.runtime.sendMessage({ type: "listen:speech", text: lines[i].text, voice: lines[i].who ? 1 + speakers.indexOf(lines[i].who) : 0 }).catch((e) => ({ error: e.message }));
    let next = ask(0);
    for (let i = 0; i < lines.length && run === mine; i++) {
      const r = await next;
      if (i + 1 < lines.length) next = ask(i + 1); // (the next line is made while this one is said)
      if (run !== mine) return;
      if (!r || !r.audio) { state.voiceError = (r && r.error) || "the extension did not answer"; break; }
      try {
        const buffer = await decode(r.audio);
        if (run !== mine) return;
        await new Promise((done) => {
          playing = audio.createBufferSource();
          playing.buffer = buffer;
          playing.connect(audio.destination);
          playing.onended = done;
          playing.start();
          if (listenIs !== "playing") listenSay("playing");
        });
      } catch (e) { state.voiceError = e.message; break; }
    }
    if (run === mine) stopSpeaking();
  }
  function speak() {
    // a comic's English lines; a text chapter's translation (content.js); else the page's own text, as it is
    const own = () => { const n = document.querySelector("article, main, #content, .chapter-content, .read-content, #chaptercontent"); return n ? n.innerText : ""; };
    const lines = state.lines.length ? state.lines.map((l) => l.en) : String(window.__P2PREAD_TRANSLATED__ || own()).split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (state.voice === "ai" && lines.length) {
      const speakers = [...new Set(state.lines.map((l) => l.speaker).filter(Boolean))];
      return speakAi(lines.map((text, i) => ({ text, who: state.lines[i] && state.lines[i].speaker })), speakers);
    }
    if (!lines.length || !("speechSynthesis" in window)) return listenSay("");
    speechSynthesis.cancel();
    const mine = ++run;
    speaking = true;
    state.voiceError = "";
    listenSay("loading");
    const voices = state.lines.length || window.__P2PREAD_TRANSLATED__ ? speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)) : []; // (the page's own text: the browser's voice for it)
    const pick = (i) => (voices.length ? voices[i % voices.length] : null);
    const speakers = [...new Set(state.lines.map((l) => l.speaker).filter(Boolean))];
    lines.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      const who = state.lines[i] && state.lines[i].speaker;
      const v = who ? pick(1 + speakers.indexOf(who)) : pick(0); // (a voice for each speaker, the first for narration)
      if (v) u.voice = v;
      if (i === 0) u.onstart = () => { if (run === mine) listenSay("playing"); };
      if (i === lines.length - 1) u.onend = () => { if (run === mine) stopSpeaking(); };
      // (Stop cancels the lines left, which end "interrupted" or "canceled": not a failure)
      u.onerror = (e) => { if (run !== mine || /interrupted|canceled/.test(e.error)) return; state.voiceError = e.error || "the browser's voice failed"; stopSpeaking(); };
      speechSynthesis.speak(u);
    });
  }
  function stopSpeaking() {
    speaking = false;
    run++;
    if (playing) { try { playing.onended = null; playing.stop(); } catch (e) { /* already over */ } playing = null; }
    listenSay("");
    paint();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  ext.runtime.onMessage.addListener((m) => {
    if (!m || typeof m.type !== "string" || !m.type.startsWith("comic:") && m.type !== "page:listen") return;
    if (m.type === "comic:progress") {
      state.error = m.error || "";
      // (the steps run at once down the strip: the pictures done so far, then the first step not finished)
      const pics = m.counts && m.counts.pictures && m.counts.pictures.done ? m.counts.pictures.done + " of " + m.counts.pictures.of + " pictures · " : "";
      state.status = m.step === "stopped" ? "Stopped" : m.step === "failed" ? "" : pics + (STEP[m.step] || "Translating") + (m.of ? " " + m.done + " of " + m.of : "") + "…";
    } else if (m.type === "comic:picture") {
      const bytes = Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0));
      state.made[m.i] = URL.createObjectURL(new Blob([bytes], { type: m.mime || "image/webp" }));
      state.showing = "made";
      show("made");
      return;
    } else if (m.type === "comic:raw") { // (the image model's own picture, no masks: the popup's Model output)
      const bytes = Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0));
      if (state.raw[m.i]) URL.revokeObjectURL(state.raw[m.i]);
      state.raw[m.i] = URL.createObjectURL(new Blob([bytes], { type: m.mime || "image/webp" }));
      return;
    } else if (m.type === "comic:showraw") {
      return show("raw");
    } else if (m.type === "comic:done") {
      state.lines = m.lines || [];
      state.status = (m.unread ? "Partly translated: picture" + (/[,–]/.test(m.unread) ? "s " : " ") + m.unread + " not read" : m.note ? "Translated, not drawn: " + m.note.replace(/^Drawing was not paid for: /, "") : "Translated") + (m.tickets ? " · " + m.tickets + " tickets" : m.usd ? " · $" + m.usd.toFixed(3) : "");
      show("made");
      return;
    } else if (m.type === "comic:toggle") return textMode ? textMode.toggle() : show(state.showing === "made" ? "original" : "made");
    // (the popup: stop: true while it shows Stop; else Listen, which a Listen already going does not start again)
    else if (m.type === "page:listen") { if (state.imgs.length) return; if (m.stop) return stopSpeaking(); state.voice = m.voice === "ai" ? "ai" : "browser"; return speaking ? (m.start ? undefined : stopSpeaking()) : speak(); }
    else if (m.type === "comic:aheadState") { aheadNow.ready = Number(m.ready) || 0; aheadNow.of = Number(m.of) || 0; if (!pill.isConnected && !state.status) return; }
    else if (m.type === "comic:ahead") { lookAhead(m, ++aheadRun); return; }
    else if (m.type === "comic:continue") { goOn(m); return; }
    paint();
  });

  // ----- Translate ahead -----
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const same = (a, b) => a.length === b.length && a.every((u, k) => absolute(u) === absolute(b[k]));
  // a page's pictures, fetched (no layout): the site's rule, the page's own list, else where they were on the page Translate was pressed on
  function picturesIn(doc, url, o) {
    let urls = o.images ? ImageChapter.urlsOf(doc, o.images, url) : [];
    if (!urls.length) urls = ImageChapter.urlsFromProps(doc, url);
    if (!urls.length && (o.where || state.where)) urls = ImageChapter.urlsOf(doc, o.where || state.where, url);
    return urls;
  }
  // this page's, as the tab lays it out (the pictures made here have blob: addresses, which are not counted)
  function picturesHere(o) {
    let urls = picturesIn(document, location.href, o);
    if (!urls.length) {
      const box = document.querySelector("article, main, #content, .chapter-content, .read-content, #chaptercontent");
      const found = ImageChapter.livePictures(document, "", location.href, box ? box.innerText.trim().length : 0);
      urls = found.pictures.length ? found.pictures : found.lone;
    }
    return urls;
  }
  const fetched = new Map(); // a page ahead's address -> { pictures, next } (fetched once in this page)
  // The next pages after this one, as many as asked (their Next links, each page fetched as the tab would), sent to be made; a page with no pictures ends it
  async function lookAhead(o, mine) {
    const n = Math.max(0, Math.min(5, Number(o.count) || 0));
    if (!n || typeof NextPage === "undefined") return;
    if (!state.where && state.imgs.some(Boolean)) state.where = ImageChapter.whereOf(state.imgs, document);
    const pages = [];
    let next = NextPage.find(document, location.href);
    for (let i = 0; i < n && next && mine === aheadRun; i++) {
      let page = fetched.get(next);
      if (!page) {
        const doc = await NextPage.fetchDoc(next);
        if (!doc) break;
        page = { pictures: picturesIn(doc, next, o), next: NextPage.find(doc, next) };
        fetched.set(next, page);
        if (fetched.size > 30) fetched.delete(fetched.keys().next().value);
      }
      if (!page.pictures.length || same(page.pictures, state.urls)) break;
      pages.push({ url: next, pictures: page.pictures });
      next = page.next;
    }
    if (mine !== aheadRun) return;
    aheadNow.of = pages.length;
    aheadNow.ready = 0;
    if (pages.length || state.status) paint();
    ext.runtime.sendMessage({ type: "ahead:pictures", pages, where: state.where }).catch(() => {});
  }
  // The tab is on another page of the site (loaded, or shown in place by the site's script): its pictures, once there, are shown as made (or being made), then the ones ahead
  async function goOn(o) {
    const mine = ++aheadRun;
    if (o.where && !state.where) state.where = o.where;
    if (state.at === here() && state.urls.length) return lookAhead(o, mine); // (this page is the one shown already)
    let urls = [];
    for (let t = 0; t < 40 && mine === aheadRun; t++) { // (a site that shows its next page in place puts its pictures there a moment after its address changes)
      urls = picturesHere(o);
      if (urls.length && !same(urls, state.urls)) break;
      urls = [];
      await sleep(250);
    }
    if (!urls.length || mine !== aheadRun) return;
    api.reset(urls);
    ext.runtime.sendMessage({ type: "ahead:show", urls, referer: location.href }).catch(() => {});
    return lookAhead(o, mine);
  }

  const api = {
    // what the popup shows when it opens again: still running, or pictures made
    // urls: the pictures the page has now (the popup finds them): a translation made for other pictures is not this page's (the site went on to its next page in place)
    info: (urls) => {
      const same = !urls || !state.urls.length || (urls.length === state.urls.length && urls.every((u, k) => absolute(u) === state.urls[k]));
      if (!same) { if (state.made.some(Boolean) && !/…$/.test(state.status)) forget(); return { running: false, made: 0, lines: 0, stale: true }; }
      return { running: /…$/.test(state.status), made: state.made.filter(Boolean).length, lines: state.lines.length };
    },
    reset(urls) {
      state.made.forEach((u) => u && URL.revokeObjectURL(u));
      state.raw.forEach((u) => u && URL.revokeObjectURL(u));
      show("original");
      Object.assign(state, { imgs: imagesFor(urls), made: [], raw: [], urls: urls.map(absolute), showing: "original", lines: [], status: "Starting…", error: "", at: here() });
      if (!state.where && state.imgs.some(Boolean) && typeof ImageChapter !== "undefined" && ImageChapter.whereOf) state.where = ImageChapter.whereOf(state.imgs, document);
      if (!state.imgs.every(Boolean)) watchLate();
      paint();
    },
    // the pictures of the page the tab is on, when this is where they were translated (the popup opened again reads them here: the page shows the ones made, with blob:
    // addresses); null on another page (a site that shows its next page in place, at another address)
    urlsHere: () => (state.at === here() && state.urls.length ? state.urls.slice() : null),
    // how Listen goes, for the popup opened again: { state: "loading" | "playing" | "", error }
    listening: () => ({ state: listenIs, error: state.voiceError || "" }),
    // A text chapter translated from the popup (content.js says how it goes here): { status, error, made (a translation to show), showing ("made" | "original"),
    // running (Stop is offered), hooks: { toggle(which), stop() } }. The same pill as a comic's, with the translator's own Show original and Stop.
    text(o) {
      textMode = Object.assign(textMode || {}, o.hooks || {});
      Object.assign(state, { status: o.status || "", error: o.error || "", textMade: !!o.made, textRunning: !!o.running, showing: o.showing || "original" });
      paint();
    }
  };
  // Let go of a translation that is not of what the page shows now: no more watching its pictures, their blobs freed, the pill gone
  function forget() {
    state.imgs.forEach((img) => {
      if (!img) return;
      if (img.__p2preadWatch) { img.__p2preadWatch.disconnect(); delete img.__p2preadWatch; }
      delete img.__p2preadOriginal;
    });
    [...state.made, ...state.raw].forEach((u) => u && URL.revokeObjectURL(u));
    Object.assign(state, { imgs: [], made: [], raw: [], urls: [], showing: "original", lines: [], status: "", error: "" });
    stopSpeaking();
    pill.remove();
  }
  window.__p2preadComicPage = api;
  if (window.__P2PREAD_COMIC_URLS__ !== null) api.reset(window.__P2PREAD_COMIC_URLS__ || []);
})();
