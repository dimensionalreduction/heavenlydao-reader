// In a chapter's page, from the popup (docs/ADD-BOOK.md): nothing here is kept. Run in the tab before a comic's chapter is translated (comic-host.js does the work):
// the made pictures are put in place of the site's own (<img> by <img>, the same order as the addresses the popup found), Show original puts the site's back, and a small
// pill says how far it is. Listen reads a translated text chapter's paragraphs aloud (content.js leaves them in window.__P2PREAD_TRANSLATED__); a comic has no Listen.
//   window.__P2PREAD_COMIC_URLS__   the chapter's pictures' addresses, set by the popup before this runs
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  if (window.__p2preadComicPage) { window.__p2preadComicPage.reset(window.__P2PREAD_COMIC_URLS__ || []); return; }
  const STEP = { loading: "Loading pictures", finding: "Finding text", reading: "Reading", drawing: "Drawing" };
  const state = { imgs: [], made: [], showing: "original", lines: [], status: "", error: "", voiceError: "", voice: "browser" };

  // the page's <img> for each address (its lazy-load attribute first, as ImageChapter.imgUrl reads it)
  function imagesFor(urls) {
    const abs = (v) => { try { return new URL(v, location.href).href; } catch (e) { return ""; } };
    const srcOf = (img) => abs(img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.currentSrc || img.getAttribute("src") || "");
    const all = [...document.images];
    const used = new Set(); // (the same picture twice on a page: each address is given its own <img>, in order)
    return urls.map((u) => { const img = all.find((i) => !used.has(i) && (srcOf(i) === u || i.currentSrc === u || i.src === u)) || null; if (img) used.add(img); return img; });
  }

  // the pill, bottom right: how far it is, Show original / translated, Listen, Stop
  const pill = document.createElement("div");
  pill.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483646;display:flex;gap:6px;align-items:center;padding:8px 10px;border-radius:12px;" +
    "background:#1c2027;color:#d6dae0;font:13px/1.3 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:min(92vw,420px)";
  const text = document.createElement("span");
  const btn = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.style.cssText = "font:inherit;padding:5px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:#14171c;color:inherit;cursor:pointer"; b.onclick = fn; return b; };
  const toggle = btn("Show original", () => show(state.showing === "made" ? "original" : "made"));
  const listen = btn("▶ Listen", () => (speaking ? stopSpeaking() : speak()));
  const stop = btn("Stop", () => ext.runtime.sendMessage({ type: "comic:stop" }).catch(() => {}));
  const close = btn("✕", () => { stopSpeaking(); show("original"); pill.remove(); });
  pill.append(text, toggle, listen, stop, close);

  function paint() {
    text.textContent = state.voiceError ? "Couldn't read aloud: " + state.voiceError : state.error ? "Couldn't translate: " + state.error : state.status;
    toggle.hidden = !state.made.some(Boolean);
    toggle.textContent = state.showing === "made" ? "Show original" : "Show translated";
    listen.hidden = state.imgs.length > 0 || !window.__P2PREAD_TRANSLATED__; // (a comic has no Listen)
    stop.hidden = !/…$/.test(state.status);
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
      img.__p2preadOriginal = { src: real ? absolute(real) : img.getAttribute("src"), srcset: img.getAttribute("srcset"), lazy };
    }
    return img.__p2preadOriginal;
  }
  function watch(img, i) {
    if (img.__p2preadWatch) return;
    img.__p2preadWatch = new MutationObserver(() => {
      if (state.showing !== "made" || !state.made[i] || img.src === state.made[i] || img.__p2preadSetting) return;
      img.__p2preadSetting = true;
      img.removeAttribute("srcset");
      for (const a of LAZY) img.removeAttribute(a);
      img.src = state.made[i];
      img.__p2preadSetting = false;
    });
    img.__p2preadWatch.observe(img, { attributes: true, attributeFilter: ["src", "srcset", ...LAZY] });
  }
  function show(which) {
    state.showing = which;
    state.imgs.forEach((img, i) => {
      if (!img || !state.made[i]) return;
      const was = originalOf(img);
      watch(img, i);
      img.__p2preadSetting = true; // (our own changes are not the site's)
      if (which === "made") {
        img.removeAttribute("srcset");
        for (const a of LAZY) img.removeAttribute(a);
        img.src = state.made[i];
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
    listen.textContent = "■ Stop";
    state.voiceError = "";
    const ask = (i) => ext.runtime.sendMessage({ type: "listen:speech", text: lines[i].text, voice: lines[i].who ? 1 + speakers.indexOf(lines[i].who) : 0 }).catch((e) => ({ error: e.message }));
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
    if (!lines.length || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    speaking = true;
    listen.textContent = "■ Stop";
    const voices = state.lines.length || window.__P2PREAD_TRANSLATED__ ? speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)) : []; // (the page's own text: the browser's voice for it)
    const pick = (i) => (voices.length ? voices[i % voices.length] : null);
    const speakers = [...new Set(state.lines.map((l) => l.speaker).filter(Boolean))];
    lines.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      const who = state.lines[i] && state.lines[i].speaker;
      const v = who ? pick(1 + speakers.indexOf(who)) : pick(0); // (a voice for each speaker, the first for narration)
      if (v) u.voice = v;
      if (i === lines.length - 1) u.onend = stopSpeaking;
      speechSynthesis.speak(u);
    });
  }
  function stopSpeaking() {
    speaking = false;
    run++;
    if (playing) { try { playing.onended = null; playing.stop(); } catch (e) { /* already over */ } playing = null; }
    listen.textContent = "▶ Listen";
    paint();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  ext.runtime.onMessage.addListener((m) => {
    if (!m || typeof m.type !== "string" || !m.type.startsWith("comic:") && m.type !== "page:listen") return;
    if (m.type === "comic:progress") {
      state.error = m.error || "";
      state.status = m.step === "stopped" ? "Stopped" : m.step === "failed" ? "" : (STEP[m.step] || "Translating") + (m.of ? " " + m.done + " of " + m.of : "") + "…";
    } else if (m.type === "comic:picture") {
      const bytes = Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0));
      state.made[m.i] = URL.createObjectURL(new Blob([bytes], { type: m.mime || "image/webp" }));
      state.showing = "made";
      show("made");
      return;
    } else if (m.type === "comic:done") {
      state.lines = m.lines || [];
      state.status = (m.note ? "Translated, not drawn: " + m.note.replace(/^Drawing was not paid for: /, "") : "Translated") + (m.tickets ? " · " + m.tickets + " tickets" : m.usd ? " · $" + m.usd.toFixed(3) : "");
      show("made");
      return;
    } else if (m.type === "comic:toggle") return show(state.showing === "made" ? "original" : "made");
    else if (m.type === "page:listen") { if (state.imgs.length) return; state.voice = m.voice === "ai" ? "ai" : "browser"; return speaking ? stopSpeaking() : speak(); }
    paint();
  });

  const api = {
    // what the popup shows when it opens again: still running, or pictures made
    info: () => ({ running: /…$/.test(state.status), made: state.made.filter(Boolean).length, lines: state.lines.length }),
    reset(urls) {
      state.made.forEach((u) => u && URL.revokeObjectURL(u));
      show("original");
      Object.assign(state, { imgs: imagesFor(urls), made: [], showing: "original", lines: [], status: "Starting…", error: "" });
      paint();
    }
  };
  window.__p2preadComicPage = api;
  api.reset(window.__P2PREAD_COMIC_URLS__ || []);
})();
