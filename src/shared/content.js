(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const cacheKey = "translation:" + location.origin + location.pathname;
  // A chapter in another language than English is its own entry beside the chapter's ("#lang=<code>": a version of the same chapter, see P2PCore.langKey);
  // the language is the one the library says chapters are translated into.
  const keyIn = (key, lang) => key + (lang && lang !== "en" ? "#lang=" + lang : "");
  let pageLang = "en";
  const langReady = Promise.resolve(ext.runtime.sendMessage({ type: "target:language" })).then((r) => { pageLang = (r && r.lang) || "en"; }, () => {});
  const GLOSSARY_KEY = "glossary";
  // Translate from the popup on a chapter's page (docs/ADD-BOOK.md): nothing is kept (no saved translation, no chapters ahead, no terms offered), paid as picked there
  const KEEP_NOTHING = window.__P2PREAD_KEEP_NOTHING__ === true;
  // ("rules": by the Translation rule's rows, Settings › Model rules, as the popup asks now)
  const PAY = ["tickets", "openrouter", "rules"].includes(window.__P2PREAD_PAY__) ? window.__P2PREAD_PAY__ : "key";
  // Translate ahead (the popup's switch, translate-ahead.js): count, the next pages translated before they are opened; auto, a page the tab went on to (translated only
  // when it has a chapter's text, not a book's page or the site's home)
  const AHEAD_OPTS = window.__P2PREAD_AHEAD__ || {};
  const AHEAD = KEEP_NOTHING ? Math.max(0, Math.min(5, Number(AHEAD_OPTS.count) || 0)) : 0;
  const AUTO = AHEAD > 0 && !!AHEAD_OPTS.auto;
  // From the popup (nothing kept): the page shows how it goes in the same pill as a comic's (comic-page.js, put in first: its status, Show original / translated, Listen,
  // Stop, ✕), and the popup follows it as it follows a comic ("text:status", and window.__p2preadText.state() when it opens again). The library's own: the bar at the top.
  const PAGE = KEEP_NOTHING && window.__p2preadComicPage && typeof window.__p2preadComicPage.text === "function" ? window.__p2preadComicPage : null;

  if (document.getElementById("gemini-translate-toolbar") || (window.__p2preadText && window.__p2preadTextAt === location.href)) {
    // already active on this page — use its buttons (Translate ahead turned on after it was translated: the next pages now). From the popup: one that failed or was
    // stopped is translated again (its pill has no Translate: the popup's Translate is pressed again)
    if (!AHEAD || window.__p2preadTextAt === location.href) {
      if (window.__p2preadText) window.__p2preadText.wake(AHEAD);
      else if (AHEAD && window.__p2preadTextAhead) window.__p2preadTextAhead(AHEAD);
      return;
    }
    // (a site that shows its next chapter in the same page, at another address: this one's translation starts over)
    for (const el of document.querySelectorAll("[data-p2pread-text]")) el.remove();
  }

  const RAW_TEXT_VAR_CANDIDATES = ["txt_content"];

  function getRawSourceText() {
    if (typeof window.__GEMINI_PRECOLLECTED_TEXT__ === "string" && window.__GEMINI_PRECOLLECTED_TEXT__.trim()) {
      return window.__GEMINI_PRECOLLECTED_TEXT__;
    }
    const pageWindow = window.wrappedJSObject;
    if (pageWindow) {
      for (const name of RAW_TEXT_VAR_CANDIDATES) {
        try {
          const value = pageWindow[name];
          if (typeof value === "string" && value.trim()) return value;
        } catch (e) {
          // not accessible, skip
        }
      }
    }
    return null;
  }

  const GENERIC_SELECTORS = [
    "article",
    "main",
    "#content",
    ".content",
    ".chapter-content",
    ".read-content",
    ".readcontent",
    "#chaptercontent"
  ];
  const MIN_CONTENT_LENGTH = 200;

  // Where a site keeps its chapter text: the site rules (raw-sources.js, one per site WebToEpub has a parser for, plus the hand-written ones)
  // first, then the older list in site-selectors.js.
  function siteSelector(hostname) {
    if (typeof RawSources !== "undefined") {
      const rule = RawSources.ruleFor("https://" + hostname + "/");
      if (rule && rule.selector) return rule.selector;
    }
    return (window.SITE_CONTENT_SELECTORS || {})[hostname];
  }

  function findTarget() {
    const hostname = location.hostname.replace(/^www\./, "");
    const contentOverride = window.__GEMINI_CONTENT_SELECTOR_OVERRIDE__;
    if (contentOverride) {
      let overrideEl;
      try {
        overrideEl = document.querySelector(contentOverride);
      } catch (e) {
        overrideEl = null;
      }
      // A user-picked selector is trusted even below MIN_CONTENT_LENGTH — it was chosen by hand.
      if (overrideEl) return overrideEl;
    }
    const mappedSelector = siteSelector(hostname);
    const candidates = mappedSelector ? [mappedSelector, ...GENERIC_SELECTORS] : GENERIC_SELECTORS;
    for (const selector of candidates) {
      let el;
      try {
        el = document.querySelector(selector);
      } catch (e) {
        continue;
      }
      if (el && el.innerText.trim().length >= MIN_CONTENT_LENGTH) {
        return el;
      }
    }
    return document.body;
  }

  const target = findTarget();
  const isBodyFallback = target === document.body;
  if (AUTO && isBodyFallback && !getRawSourceText()) return; // (a page of the site with no chapter's text on it)
  window.__p2preadTextAt = location.href;
  // the chapter's own text as the page had it (a translation shown in its place is not what is translated again, or kept as its original)
  const originalText = (getRawSourceText() || target.innerText || "").slice(0, 20000);

  function currentHostname() {
    return location.hostname.replace(/^www\./, "");
  }

  // Mirrors the heuristic popup.js uses to resolve/display a novel name, so cache entries can be
  // grouped by novel later. Overrides are precollected by background.js (picked selector / typed text).
  function resolveNovelName() {
    const overrideText = window.__GEMINI_NOVEL_NAME_OVERRIDE__;
    if (overrideText) return overrideText;
    const overrideSelector = window.__GEMINI_NOVEL_SELECTOR_OVERRIDE__;
    if (overrideSelector) {
      try {
        const el = document.querySelector(overrideSelector);
        if (el && el.innerText.trim()) return el.innerText.trim();
      } catch (e) {
        // invalid/stale selector, fall through to the default heuristic
      }
    }
    const og =
      document.querySelector('meta[property="og:novel:book_name"]')?.content ||
      document.querySelector('meta[property="og:title"]')?.content;
    if (og && og.trim()) return og.trim();
    const h1 = document.querySelector("h1");
    if (h1 && h1.innerText.trim()) return h1.innerText.trim();
    return (
      document.title.replace(/[-–—:|]?\s*(chapter|ch\.?|第)\s*\d+[^-–—|]*$/i, "").trim() || location.hostname
    );
  }

  // --- Prefetch: translate the next N chapters ahead in the background ---
  const NEXT_LINK_SELECTORS = [
    'link[rel="next"]',
    'a[rel="next"]',
    "a.next-chapter",
    "a.next_chapter",
    "#next_chapter a",
    ".next-chap a",
    "a#next",
    "a.next"
  ];
  const NEXT_LINK_TEXT_HINTS = ["next chapter", "next page", "next", "下一章", "下一页", "下一节"];

  // Works on both the live document and a detached DOMParser doc (fetched chapters aren't rendered,
  // so this only ever looks at href/textContent, never layout-dependent properties like innerText).
  function findNextChapterUrl(doc, baseUrl) {
    if (typeof NextPage !== "undefined") return NextPage.find(doc, baseUrl) || null; // (next-page.js: the same, and a link with the page's number one more, a "next" class, an arrow)
    if (typeof RawSources !== "undefined") {
      const rule = RawSources.ruleFor(baseUrl);
      if (rule) {
        const next = RawSources.nextChapter(doc, baseUrl);
        if (next || rule.next) return next; // a site that splits chapters: the generic search below would pick the next PART
      }
    }
    for (const selector of NEXT_LINK_SELECTORS) {
      let el;
      try {
        el = doc.querySelector(selector);
      } catch (e) {
        continue;
      }
      const href = el && (el.getAttribute("href") || el.href);
      if (href) {
        try {
          return new URL(href, baseUrl).href;
        } catch (e) {
          // malformed href, keep looking
        }
      }
    }
    const anchors = doc.querySelectorAll("a[href]");
    for (const a of anchors) {
      const text = (a.textContent || "").trim().toLowerCase();
      if (!text || text.length > 20) continue; // skip long/unrelated links, keep this a targeted match
      if (NEXT_LINK_TEXT_HINTS.some((hint) => text === hint || text.includes(hint))) {
        try {
          return new URL(a.getAttribute("href"), baseUrl).href;
        } catch (e) {
          // malformed href, keep looking
        }
      }
    }
    return null;
  }

  // Detached docs have no layout, so use textContent (not innerText) here.
  function extractTextFromDoc(doc, hostname) {
    const override = window.__GEMINI_CONTENT_SELECTOR_OVERRIDE__;
    const mappedSelector = siteSelector(hostname);
    const candidates = [override, mappedSelector, ...GENERIC_SELECTORS].filter(Boolean);
    for (const selector of candidates) {
      let el;
      try {
        el = doc.querySelector(selector);
      } catch (e) {
        continue;
      }
      const text = el && (el.textContent || "").trim();
      if (text && text.length >= MIN_CONTENT_LENGTH) return text;
    }
    return null;
  }

  function resolveNovelNameForDoc(doc, urlObj) {
    const overrideText = window.__GEMINI_NOVEL_NAME_OVERRIDE__;
    if (overrideText) return overrideText;
    const overrideSelector = window.__GEMINI_NOVEL_SELECTOR_OVERRIDE__;
    if (overrideSelector) {
      try {
        const el = doc.querySelector(overrideSelector);
        if (el && el.textContent.trim()) return el.textContent.trim();
      } catch (e) {
        // invalid/stale selector, fall through
      }
    }
    const og =
      doc.querySelector('meta[property="og:novel:book_name"]')?.content ||
      doc.querySelector('meta[property="og:title"]')?.content;
    if (og && og.trim()) return og.trim();
    const h1 = doc.querySelector("h1");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    return (
      (doc.title || "").replace(/[-–—:|]?\s*(chapter|ch\.?|第)\s*\d+[^-–—|]*$/i, "").trim() ||
      urlObj.hostname.replace(/^www\./, "")
    );
  }

  // fetch().text() always decodes as UTF-8, which turns GBK/Big5 pages (e.g. 69shuba) into mojibake —
  // both the title and the body text that gets sent to Gemini. Decode with the page's real charset instead.
  async function fetchHtml(url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    let charset = (/charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") || "") || [])[1];
    if (!charset) {
      const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
      charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
    }
    try {
      return new TextDecoder(charset || "utf-8").decode(buf);
    } catch (e) {
      return new TextDecoder("utf-8").decode(buf); // unknown charset label
    }
  }

  // Titles are stored in English so every reader (the popup list, the P2P site) can show them as-is.
  async function englishLabel(text) {
    if (!text) return text;
    const r = await ext.runtime.sendMessage({ type: "translateTitle", text }).catch(() => null);
    return (r && r.text) || text;
  }

  // Earlier prefetch runs saved GBK pages decoded as UTF-8; their titles contain U+FFFD replacement chars.
  function isGarbled(entry) {
    return !!entry && /�/.test((entry.pageTitle || "") + (entry.novelName || ""));
  }

  // Where the next chapter is, when this page says so itself ("next chapter" link of a site raw-sources.js knows), saved with the
  // translation so the reader's Next button can follow it. Only this page is looked at: what gets translated is what the page shows
  // (a chapter that a site splits over several pages is translated one page at a time, as it is read). On the first page of such a
  // chapter the link only leads to the second page, so there is none to save and the reader looks it up when asked.
  function nextChapterLink() {
    if (typeof RawSources === "undefined" || !RawSources.ruleFor(location.href)) return null;
    try {
      const doc = new DOMParser().parseFromString(RawSources.stripScripts(document.documentElement.outerHTML), "text/html");
      return RawSources.nextChapter(doc, location.href);
    } catch (e) {
      return null;
    }
  }

  // Fetches and translates up to `storage.local.prefetchAhead` chapters after this one, following
  // each page's own "next chapter" link. Same-site fetches only (no navigation, so no rendering —
  // sites whose text is injected by JS after load, like tomatomtl's raw-text-variable trick, can't be
  // prefetched this way and are silently skipped once their extracted text falls short).
  async function prefetchAhead() {
    const { prefetchAhead: rawCount } = await ext.storage.local.get("prefetchAhead");
    const count = Math.max(0, Math.min(20, Number(rawCount) || 0));
    if (count === 0) return;

    await freshenGlossary();
    const glossary = effectiveGlossary(await loadGlossary());
    const glossaryForPrompt = glossary.filter((e) => e.source !== "replace");

    let currentDoc = document;
    let currentUrl = location.href;

    for (let i = 0; i < count; i++) {
      const nextUrl = findNextChapterUrl(currentDoc, currentUrl);
      if (!nextUrl) break;

      let nextDoc;
      try {
        const html = await fetchHtml(nextUrl);
        if (!html) break;
        nextDoc = new DOMParser().parseFromString(html, "text/html");
      } catch (e) {
        break;
      }

      const nextUrlObj = new URL(nextUrl);
      await langReady;
      const nextCacheKey = keyIn("translation:" + nextUrlObj.origin + nextUrlObj.pathname, pageLang);
      const existing = await ext.storage.local.get(nextCacheKey);
      if (!existing[nextCacheKey] || isGarbled(existing[nextCacheKey])) {
        const text = extractTextFromDoc(nextDoc, nextUrlObj.hostname.replace(/^www\./, ""));
        if (text) {
          const response = await ext.runtime
            .sendMessage({ type: "translate", text: text.slice(0, 20000), glossary: glossaryForPrompt, url: nextUrl, title: nextDoc.title || "" })
            .catch(() => null);
          if (response && !response.error) {
            const [pageTitle, novelName] = await Promise.all([
              englishLabel(nextDoc.title || nextUrl),
              englishLabel(resolveNovelNameForDoc(nextDoc, nextUrlObj))
            ]);
            await ext.storage.local.set({
              [keyIn(nextCacheKey.replace(/#lang=[^#]*$/, ""), response.language || pageLang)]: {
                translated: response.translated,
                suggestions: response.suggestions || [],
                savedAt: Date.now(),
                model: response.model || null,
                pageTitle,
                novelName
              }
            });
          }
        }
      }

      currentDoc = nextDoc;
      currentUrl = nextUrl;
    }
  }

  // --- Term/glossary data model ---
  // Each entry: { terms: [string,...], translation, scope: "global"|"site", hostname, source: "manual"|"suggested"|"starter" }
  const SOURCE_COLORS = { manual: "#4288c9", suggested: "#e08a2e", starter: "#2f9e5c", pending: "#8a8f98", replace: "#9456c4", wtr: "#1a9a8f" };
  const SOURCE_LABELS = { manual: "Your term", suggested: "Suggested", starter: "Starter pack", pending: "Pending", replace: "Correction", wtr: "Site" };

  // Shared design tokens, in the spirit of the site's UI (clean rounded cards, subtle borders,
  // muted section labels, one accent blue) without reusing any of its actual code or assets.
  const UI = {
    font: "'Segoe UI', 'Nunito Sans', ui-sans-serif, system-ui, -apple-system, Roboto, sans-serif",
    radius: "10px",
    radiusSm: "6px",
    radiusPill: "999px",
    primary: "#4288c9",
    primaryDark: "#3574ac",
    danger: "#d84c4c",
    text: "#1c2026",
    muted: "#767c88",
    border: "rgba(20,25,35,0.12)",
    borderSoft: "rgba(20,25,35,0.07)",
    bg: "#ffffff",
    bgMuted: "#f4f5f7",
    shadow: "0 10px 28px rgba(20,25,35,0.16), 0 2px 6px rgba(20,25,35,0.08)",
    shadowSm: "0 4px 14px rgba(20,25,35,0.14)"
  };

  function fieldStyle(extra) {
    return (
      "width:100%;font-family:" + UI.font + ";font-size:12.5px;color:" + UI.text + ";" +
      "padding:7px 9px;border:1px solid " + UI.border + ";border-radius:" + UI.radiusSm + ";" +
      "box-sizing:border-box;background:" + UI.bg + ";outline:none;transition:border-color .15s;" +
      (extra || "")
    );
  }

  function buttonStyle(kind) {
    const base =
      "cursor:pointer;font-family:" + UI.font + ";font-size:12px;font-weight:600;" +
      "padding:6px 14px;border-radius:" + UI.radiusSm + ";border:1px solid transparent;transition:background .15s,opacity .15s;";
    if (kind === "primary") {
      return base + "background:" + UI.primary + ";color:#fff;";
    }
    if (kind === "danger") {
      return base + "background:transparent;color:" + UI.danger + ";border-color:" + UI.border + ";";
    }
    // secondary
    return base + "background:transparent;color:" + UI.text + ";border-color:" + UI.border + ";";
  }

  function styleButtonHover(btn, kind) {
    const hoverBg = kind === "primary" ? UI.primaryDark : UI.bgMuted;
    btn.onmouseenter = () => (btn.style.background = kind === "primary" ? hoverBg : hoverBg);
    btn.onmouseleave = () => (btn.style.background = kind === "primary" ? UI.primary : "transparent");
  }

  let lastTranslatedText = "";
  let lastSuggestions = [];

  function normalizeEntry(e) {
    return {
      terms: e.terms && e.terms.length ? e.terms : e.term ? [e.term] : [],
      translation: e.translation || "",
      scope: e.scope === "site" ? "site" : "global",
      hostname: e.scope === "site" ? e.hostname || currentHostname() : null,
      source: ["suggested", "starter", "pending", "replace", "wtr"].includes(e.source) ? e.source : "manual",
      // Set on terms that come from a bound library glossary (or your terms from the library's reader): read-only here and never saved into your own list.
      ...(e.lib ? { lib: String(e.lib) } : {}),
      // what kind of term (person, place, technique... as Gemini said), and "always" for a one-character term that is meant wherever it is (TermMatch)
      ...(e.kind ? { kind: String(e.kind) } : {}),
      ...(e.match === "always" ? { match: "always" } : {}),
      // your terms from the library's reader: found at a word's edge, and whatever the case when `ci` (see WtrTerms.myTermEntries)
      ...(e.mine ? { mine: true, ci: !!e.ci } : {})
    };
  }

  // Pulls the latest glossaries from your library into the local cache before a translation. Best effort:
  // if the library is slow to answer we just use the cache we already have.
  async function freshenGlossary() {
    const pull = ext.runtime.sendMessage({ type: "glossary:pull" }).catch(() => null);
    await Promise.race([pull, new Promise((resolve) => setTimeout(resolve, 2500))]);
  }

  // Your own terms first (so array indices stay stable for edit/delete), then the terms you picked in the library's reader, then terms from
  // any library glossaries bound to this novel (see wtr-terms.js). Library terms are appended read-only and stripped again on save.
  async function loadGlossary() {
    const stored = await ext.storage.local.get([GLOSSARY_KEY, "glossaryLibrary", "glossaryBindings", "myTerms"]);
    const own = (stored[GLOSSARY_KEY] || []).map(normalizeEntry);
    const mine = WtrTerms.myTermEntries(stored.myTerms, location.href, stored.glossaryBindings).map(normalizeEntry);
    const bound = WtrTerms.boundEntries({
      library: stored.glossaryLibrary,
      bindings: stored.glossaryBindings,
      url: location.href,
      ownEntries: own,
      hostname: currentHostname()
    }).map(normalizeEntry);
    return own.concat(mine, bound);
  }

  async function saveGlossary(entries) {
    await ext.storage.local.set({ [GLOSSARY_KEY]: entries.filter((e) => !e.lib) });
  }

  function effectiveGlossary(all) {
    const host = currentHostname();
    return all.filter((e) => e.scope === "global" || e.hostname === host);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Deterministic post-processing pass: Glossary + Raw text -> AI -> AI translated text -> Replacement -> You.
  // "replace" entries store the exact (undesired) text seen in AI output and the exact fix, so this is a
  // literal find/replace on the AI's output rather than a translation hint sent back to the model.
  const applyReplacements = (text, glossary) => WtrTerms.applyReplacements(text, glossary);

  // --- Toolbar ---
  const toolbar = document.createElement("div");
  toolbar.id = "gemini-translate-toolbar";
  toolbar.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;background:" + UI.bg + ";color:" + UI.text + ";" +
    "border:1px solid " + UI.border + ";border-radius:" + UI.radiusPill + ";box-shadow:" + UI.shadowSm + ";" +
    "padding:5px 6px;display:flex;align-items:center;gap:2px;font-family:" + UI.font + ";";

  const statusEl = document.createElement("span");
  statusEl.style.cssText = "font-size:11px;color:" + UI.muted + ";padding:0 8px;white-space:nowrap;";
  toolbar.appendChild(statusEl);

  function makeIconBtn(label, title) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText =
      "cursor:pointer;width:28px;height:28px;border:none;border-radius:50%;" +
      "background:transparent;font-size:13px;flex:none;transition:background .15s;";
    btn.onmouseenter = () => (btn.style.background = UI.bgMuted);
    btn.onmouseleave = () => (btn.style.background = "transparent");
    return btn;
  }

  const retranslateBtn = makeIconBtn("↻", "Re-translate (ignore cache)");
  const glossaryBtn = makeIconBtn("📖", "Terms");
  const primaryBtn = makeIconBtn(
    isBodyFallback ? "✕" : "↺",
    isBodyFallback ? "Close panel" : "Restore original text"
  );

  toolbar.append(primaryBtn, retranslateBtn, glossaryBtn);
  toolbar.dataset.p2preadText = "1";
  if (!PAGE) document.body.appendChild(toolbar);

  // ----- how it goes, said in one place: the bar's line, or the pill (PAGE), and to the popup -----
  // step: "finding" | "translating" | "done" | "failed" | "stopped"; showing: "made" (the translation) | "original"
  const textState = { step: "finding", status: "", error: "", words: 0, tickets: 0, showing: "original", made: false };
  let textRun = 0; // (each translation has a number: Stop, or another one begun, makes the one going on stale)
  function say(status, o = {}) {
    Object.assign(textState, o, { status });
    statusEl.textContent = textState.error ? "Error: " + textState.error : status;
    if (PAGE) PAGE.text({ status: textState.error ? "" : status, error: textState.error, made: textState.made, showing: textState.showing, running: /^(finding|translating)$/.test(textState.step), hooks: { toggle: showText, stop: stopText } });
    ext.runtime.sendMessage({ type: "text:status", ...textState }).catch(() => {});
  }
  // the translation or the page's own text, shown in place (the side panel of a page with no chapter's box: shown or not)
  function showText(which) {
    const want = which || (textState.showing === "made" ? "original" : "made");
    if (want === "made" && !lastTranslatedText) return;
    if (panelContentEl) panelContentEl.hidden = want !== "made";
    else if (want === "original" && target.__geminiOriginal) target.replaceChildren(...target.__geminiOriginal.map((n) => n.cloneNode(true)));
    else if (want === "made") displayTranslation(lastTranslatedText, lastSuggestions).catch(() => {});
    say(textState.status, { showing: want });
  }
  function stopText() {
    if (!/^(finding|translating)$/.test(textState.step)) return;
    textRun++;
    retranslateBtn.disabled = false;
    say("Stopped", { step: "stopped" });
  }
  window.__p2preadText = {
    state: () => ({ ...textState }),
    // the popup's Translate pressed again on this page (it injects this again): one that failed or was stopped is translated again; Translate ahead turned on: the next pages now
    wake: (ahead) => { if (/^(failed|stopped)$/.test(textState.step)) runTranslation(false); else if (ahead && window.__p2preadTextAhead) window.__p2preadTextAhead(ahead); },
    again: () => runTranslation(true),
    // what the popup's Save to library keeps: the page's text and its translation
    saved: () => ({ original: originalText, translated: lastTranslatedText, model: textState.model || "", lang: textState.lang || pageLang }),
    show: showText,
    stop: stopText
  };
  // the popup's buttons: Show original / translated, Translate again, Stop (to this page's translator: not one of a page the site showed before in place)
  const textAt = location.href;
  ext.runtime.onMessage.addListener((m) => {
    if (!m || location.href !== textAt || window.__p2preadTextAt !== textAt) return;
    if (m.type === "text:toggle") showText();
    else if (m.type === "text:again") runTranslation(true);
    else if (m.type === "text:stop") stopText();
  });

  // --- Fallback side panel (only used when no specific content container was found) ---
  let panelContentEl = null;
  if (isBodyFallback) {
    const panel = document.createElement("div");
    panel.id = "gemini-translate-panel";
    panel.style.cssText =
      "position:fixed;top:0;right:0;width:420px;max-width:90vw;height:100vh;" +
      "background:" + UI.bg + ";color:" + UI.text + ";z-index:2147483646;overflow-y:auto;" +
      "padding:56px 20px 20px;box-shadow:-6px 0 24px rgba(20,25,35,0.16);" +
      "font-family:" + UI.font + ";font-size:14px;line-height:1.65;white-space:pre-wrap;";
    panel.dataset.p2preadText = "1";
    document.body.appendChild(panel);
    panelContentEl = panel;
  }

  primaryBtn.onclick = () => {
    if (isBodyFallback) {
      panelContentEl.remove();
      toolbar.remove();
      glossaryPanel.remove();
    } else if (target.__geminiOriginal) {
      target.replaceChildren(...target.__geminiOriginal.map((n) => n.cloneNode(true)));
      statusEl.textContent = "Original restored";
    }
  };

  // --- Terms panel (floating, toggled) — modeled on the site's term editor ---
  const glossaryPanel = document.createElement("div");
  glossaryPanel.hidden = true;
  glossaryPanel.style.cssText =
    "position:fixed;top:54px;right:12px;width:320px;max-height:75vh;overflow-y:auto;" +
    "background:" + UI.bg + ";color:" + UI.text + ";border:1px solid " + UI.border + ";border-radius:" + UI.radius + ";" +
    "box-shadow:" + UI.shadow + ";padding:14px;font-size:12.5px;" +
    "z-index:2147483647;font-family:" + UI.font + ";white-space:normal;";
  glossaryPanel.dataset.p2preadText = "1";
  document.body.appendChild(glossaryPanel);

  glossaryBtn.onclick = () => {
    glossaryPanel.hidden = !glossaryPanel.hidden;
    if (!glossaryPanel.hidden) renderGlossary();
  };

  const suggestionsSection = document.createElement("div");
  glossaryPanel.appendChild(suggestionsSection);

  const glossaryHeading = document.createElement("div");
  glossaryHeading.textContent = "TERMS";
  glossaryHeading.style.cssText =
    "font-size:10.5px;font-weight:700;letter-spacing:.05em;color:" + UI.muted + ";margin-bottom:8px;";
  glossaryPanel.appendChild(glossaryHeading);

  const listControls = document.createElement("div");
  listControls.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;";
  const selectModeBtn = document.createElement("button");
  selectModeBtn.textContent = "Select";
  selectModeBtn.style.cssText = buttonStyle("secondary") + "font-size:11px;padding:3px 10px;";
  styleButtonHover(selectModeBtn, "secondary");
  const deleteSelectedBtn = document.createElement("button");
  deleteSelectedBtn.textContent = "Delete selected";
  deleteSelectedBtn.hidden = true;
  deleteSelectedBtn.style.cssText = buttonStyle("danger") + "font-size:11px;padding:3px 10px;";
  styleButtonHover(deleteSelectedBtn, "danger");
  listControls.append(selectModeBtn, deleteSelectedBtn);
  glossaryPanel.appendChild(listControls);

  const glossaryList = document.createElement("div");
  glossaryList.style.cssText = "margin-bottom:10px;";
  glossaryPanel.appendChild(glossaryList);

  const otherSitesToggle = document.createElement("button");
  otherSitesToggle.hidden = true;
  otherSitesToggle.style.cssText =
    "cursor:pointer;font-size:11px;font-weight:600;padding:2px 0;color:" + UI.primary + ";background:none;border:none;font-family:" + UI.font + ";";
  glossaryPanel.appendChild(otherSitesToggle);
  const otherSitesList = document.createElement("div");
  otherSitesList.hidden = true;
  otherSitesList.style.cssText = "margin-top:6px;margin-bottom:10px;";
  glossaryPanel.appendChild(otherSitesList);

  const importedToggle = document.createElement("button");
  importedToggle.hidden = true;
  importedToggle.style.cssText = otherSitesToggle.style.cssText;
  glossaryPanel.appendChild(importedToggle);
  const importedList = document.createElement("div");
  importedList.hidden = true;
  importedList.style.cssText = "margin-top:6px;margin-bottom:10px;";
  glossaryPanel.appendChild(importedList);

  let selectMode = false;
  const selectedIndices = new Set();
  let showOtherSites = false;
  let showImported = false;
  let editingKey = null; // "terms|translation" of the row currently in edit mode

  selectModeBtn.onclick = () => {
    selectMode = !selectMode;
    selectedIndices.clear();
    deleteSelectedBtn.hidden = !selectMode;
    selectModeBtn.textContent = selectMode ? "Cancel" : "Select";
    renderGlossary();
  };

  deleteSelectedBtn.onclick = async () => {
    const all = await loadGlossary();
    const remaining = all.filter((_, i) => !selectedIndices.has(i));
    await saveGlossary(remaining);
    selectMode = false;
    selectedIndices.clear();
    deleteSelectedBtn.hidden = true;
    selectModeBtn.textContent = "Select";
    renderGlossary();
  };

  otherSitesToggle.onclick = () => {
    showOtherSites = !showOtherSites;
    otherSitesList.hidden = !showOtherSites;
    renderGlossary();
  };

  importedToggle.onclick = () => {
    showImported = !showImported;
    importedList.hidden = !showImported;
    renderGlossary();
  };

  const addRow = document.createElement("div");
  addRow.style.cssText =
    "display:flex;flex-direction:column;gap:6px;margin-bottom:10px;padding:10px;" +
    "background:" + UI.bgMuted + ";border-radius:" + UI.radiusSm + ";";
  const termInput = document.createElement("input");
  termInput.placeholder = "term1|term2 (variants, optional)";
  termInput.style.cssText = fieldStyle();
  const translationInput = document.createElement("input");
  translationInput.placeholder = "translation";
  translationInput.style.cssText = fieldStyle();
  const scopeAndAddRow = document.createElement("div");
  scopeAndAddRow.style.cssText = "display:flex;gap:6px;";
  const scopeSelect = document.createElement("select");
  scopeSelect.style.cssText = fieldStyle("flex:1;width:auto;padding:6px 8px;font-size:11.5px;");
  [
    ["global", "Global"],
    ["site", "This site only"]
  ].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    scopeSelect.appendChild(opt);
  });
  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add";
  addBtn.style.cssText = buttonStyle("primary");
  styleButtonHover(addBtn, "primary");
  addBtn.onclick = async () => {
    const terms = termInput.value.split("|").map((t) => t.trim()).filter(Boolean);
    const translation = translationInput.value.trim();
    if (terms.length === 0 || !translation) return;
    const glossary = await loadGlossary();
    glossary.push(
      normalizeEntry({
        terms,
        translation,
        scope: scopeSelect.value,
        hostname: scopeSelect.value === "site" ? currentHostname() : null,
        source: "manual"
      })
    );
    await saveGlossary(glossary);
    termInput.value = "";
    translationInput.value = "";
    renderGlossary();
  };
  scopeAndAddRow.append(scopeSelect, addBtn);
  addRow.append(termInput, translationInput, scopeAndAddRow);
  glossaryPanel.appendChild(addRow);

  const importDetails = document.createElement("details");
  importDetails.style.cssText = "margin-bottom:6px;";
  const importSummary = document.createElement("summary");
  importSummary.textContent = "Paste-import (one \"term = translation\" per line)";
  importSummary.style.cssText = "cursor:pointer;font-size:11.5px;color:" + UI.muted + ";font-weight:600;";
  importDetails.appendChild(importSummary);
  const importArea = document.createElement("textarea");
  importArea.rows = 4;
  importArea.style.cssText = fieldStyle("margin-top:6px;resize:vertical;");
  importDetails.appendChild(importArea);
  const importBtn = document.createElement("button");
  importBtn.textContent = "Import";
  importBtn.style.cssText = buttonStyle("secondary") + "margin-top:6px;";
  styleButtonHover(importBtn, "secondary");
  importBtn.onclick = async () => {
    const lines = importArea.value.split("\n");
    const parsed = [];
    for (const line of lines) {
      const match = line.match(/^\s*(.+?)\s*[=:]\s*(.+?)\s*$/);
      if (match) {
        parsed.push(
          normalizeEntry({
            terms: match[1].split("|").map((t) => t.trim()).filter(Boolean),
            translation: match[2],
            scope: "global",
            source: "manual"
          })
        );
      }
    }
    if (parsed.length === 0) return;
    const glossary = await loadGlossary();
    glossary.push(...parsed);
    await saveGlossary(glossary);
    importArea.value = "";
    renderGlossary();
  };
  importDetails.appendChild(importBtn);
  glossaryPanel.appendChild(importDetails);

  const starterBtn = document.createElement("button");
  starterBtn.textContent = "Load starter genre terms";
  starterBtn.title = "Adds common wuxia/xianxia/xuanhuan term conventions (won't duplicate existing terms)";
  starterBtn.style.cssText = buttonStyle("secondary") + "font-size:11px;width:100%;";
  styleButtonHover(starterBtn, "secondary");
  starterBtn.onclick = async () => {
    const glossary = await loadGlossary();
    const existingTerms = new Set(glossary.flatMap((e) => e.terms));
    const defaults = window.DEFAULT_GLOSSARY || [];
    for (const entry of defaults) {
      if (!existingTerms.has(entry.term)) {
        glossary.push(normalizeEntry({ terms: [entry.term], translation: entry.translation, scope: "global", source: "starter" }));
      }
    }
    await saveGlossary(glossary);
    renderGlossary();
  };
  glossaryPanel.appendChild(starterBtn);

  // --- Select-to-add, like the site's floating "Add Term" button ---
  const addTermFloatBtn = document.createElement("button");
  addTermFloatBtn.textContent = "+ Add Term";
  addTermFloatBtn.style.cssText =
    "position:fixed;display:none;z-index:2147483647;cursor:pointer;padding:6px 14px;" +
    "border:none;border-radius:" + UI.radiusPill + ";background:" + UI.primary + ";color:#fff;" +
    "font-size:12px;font-weight:600;box-shadow:" + UI.shadowSm + ";font-family:" + UI.font + ";" +
    "transition:background .15s;";
  addTermFloatBtn.onmouseenter = () => (addTermFloatBtn.style.background = UI.primaryDark);
  addTermFloatBtn.onmouseleave = () => (addTermFloatBtn.style.background = UI.primary);
  addTermFloatBtn.dataset.p2preadText = "1";
  document.body.appendChild(addTermFloatBtn);

  document.addEventListener("mouseup", (e) => {
    if (e.target === addTermFloatBtn) return;
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : "";
    const withinReadingArea =
      text &&
      selection.anchorNode &&
      (target.contains(selection.anchorNode) || (panelContentEl && panelContentEl.contains(selection.anchorNode)));
    if (withinReadingArea && text.length <= 80) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      addTermFloatBtn.style.top = Math.max(8, rect.top - 32) + "px";
      addTermFloatBtn.style.left = rect.left + "px";
      addTermFloatBtn.style.display = "block";
      addTermFloatBtn.onclick = () => {
        const btnRect = addTermFloatBtn.getBoundingClientRect();
        openTermPopup(
          normalizeEntry({ terms: [text], translation: "", scope: "site", hostname: currentHostname(), source: "replace" }),
          btnRect,
          -1
        );
        addTermFloatBtn.style.display = "none";
      };
    } else {
      addTermFloatBtn.style.display = "none";
    }
  });

  function entryKey(entry) {
    return entry.terms.join("|") + "::" + entry.translation;
  }

  function renderRow(entry, index, container, fullList) {
    const row = document.createElement("div");
    row.style.cssText = "padding:8px 4px;border-bottom:1px solid " + UI.borderSoft + ";";

    if (editingKey === entryKey(entry)) {
      const editTerms = document.createElement("input");
      editTerms.value = entry.terms.join("|");
      editTerms.style.cssText = fieldStyle("margin-bottom:4px;");
      const editTranslation = document.createElement("input");
      editTranslation.value = entry.translation;
      editTranslation.style.cssText = fieldStyle("margin-bottom:6px;");
      const editActions = document.createElement("div");
      editActions.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
      const saveEditBtn = document.createElement("button");
      saveEditBtn.textContent = "Save";
      saveEditBtn.style.cssText = buttonStyle("primary") + "font-size:11px;padding:4px 12px;";
      styleButtonHover(saveEditBtn, "primary");
      saveEditBtn.onclick = async () => {
        const terms = editTerms.value.split("|").map((t) => t.trim()).filter(Boolean);
        const translation = editTranslation.value.trim();
        if (terms.length === 0 || !translation) return;
        fullList[index] = normalizeEntry({ ...entry, terms, translation });
        await saveGlossary(fullList);
        editingKey = null;
        renderGlossary();
      };
      const cancelEditBtn = document.createElement("button");
      cancelEditBtn.textContent = "Cancel";
      cancelEditBtn.style.cssText = buttonStyle("secondary") + "font-size:11px;padding:4px 12px;";
      styleButtonHover(cancelEditBtn, "secondary");
      cancelEditBtn.onclick = () => {
        editingKey = null;
        renderGlossary();
      };
      editActions.append(cancelEditBtn, saveEditBtn);
      row.append(editTerms, editTranslation, editActions);
      container.appendChild(row);
      return row;
    }

    const topLine = document.createElement("div");
    topLine.style.cssText = "display:flex;align-items:center;gap:6px;";

    if (selectMode) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIndices.has(index);
      checkbox.onchange = () => {
        if (checkbox.checked) selectedIndices.add(index);
        else selectedIndices.delete(index);
      };
      topLine.appendChild(checkbox);
    }

    const label = document.createElement("span");
    label.style.cssText = "flex:1;font-size:12.5px;";
    label.textContent = entry.terms.join(" / ") + " → " + entry.translation;
    topLine.appendChild(label);

    function rowIconBtn(label, color) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "cursor:pointer;border:none;background:none;font-size:12px;color:" + color + ";" +
        "width:22px;height:22px;border-radius:50%;transition:background .15s;flex:none;";
      b.onmouseenter = () => (b.style.background = UI.bgMuted);
      b.onmouseleave = () => (b.style.background = "transparent");
      return b;
    }

    if (entry.lib) {
      // Library terms are managed from the popup's glossary library; add your own term to override one.
      topLine.title = "From a glossary library (add your own term to override it)";
    } else {
      const editBtn = rowIconBtn("✎", UI.muted);
      editBtn.title = "Edit";
      editBtn.onclick = () => {
        editingKey = entryKey(entry);
        renderGlossary();
      };

      const removeBtn = rowIconBtn("✕", UI.danger);
      removeBtn.title = "Delete";
      removeBtn.onclick = async () => {
        const current = await loadGlossary();
        current.splice(index, 1);
        await saveGlossary(current);
        renderGlossary();
      };

      topLine.append(editBtn, removeBtn);
    }
    row.appendChild(topLine);

    const badges = document.createElement("div");
    badges.style.cssText = "margin-top:4px;";
    const scopeText = entry.scope === "site" ? "This site" : "Global";
    const sourceText = entry.lib === "my-terms" ? "Your terms (library)" : entry.lib ? "Library" : SOURCE_LABELS[entry.source];
    const badge = document.createElement("span");
    badge.textContent = scopeText + " · " + sourceText;
    badge.style.cssText =
      "font-size:10px;font-weight:600;padding:2px 8px;border-radius:" + UI.radiusPill + ";" +
      "background:" + SOURCE_COLORS[entry.source] + "1a;color:" + SOURCE_COLORS[entry.source] + ";";
    badges.appendChild(badge);
    row.appendChild(badges);

    row.dataset.entryKey = entryKey(entry);
    container.appendChild(row);
    return row;
  }

  async function renderGlossary() {
    const all = await loadGlossary();
    const host = currentHostname();
    // Bulk-imported terms (hundreds) live in their own collapsed section so the main list stays usable.
    const imported = all.map((e, i) => [e, i]).filter(([e]) => e.source === "wtr");
    const relevant = all
      .map((e, i) => [e, i])
      .filter(([e]) => e.source !== "wtr" && (e.scope === "global" || e.hostname === host));
    const otherSites = all.map((e, i) => [e, i]).filter(([e]) => e.scope === "site" && e.hostname !== host);

    glossaryList.textContent = "";
    if (relevant.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:" + UI.muted + ";font-size:12px;padding:4px 0;";
      empty.textContent = "No terms yet.";
      glossaryList.appendChild(empty);
    } else {
      relevant.forEach(([entry, index]) => renderRow(entry, index, glossaryList, all));
    }

    importedList.textContent = "";
    if (imported.length === 0) {
      importedToggle.hidden = true;
      importedList.hidden = true;
    } else {
      importedToggle.hidden = false;
      importedToggle.textContent = (showImported ? "Hide" : "Show") + " glossary library terms (" + imported.length + ")";
      importedList.hidden = !showImported;
      if (showImported) imported.forEach(([entry, index]) => renderRow(entry, index, importedList, all));
    }

    otherSitesList.textContent = "";
    if (otherSites.length === 0) {
      otherSitesToggle.hidden = true;
      otherSitesList.hidden = true;
    } else {
      otherSitesToggle.hidden = false;
      otherSitesToggle.textContent = (showOtherSites ? "Hide" : "Show") + " terms from other sites (" + otherSites.length + ")";
      if (showOtherSites) {
        otherSites.forEach(([entry, index]) => renderRow(entry, index, otherSitesList, all));
      }
    }

    refreshHighlights();
  }

  async function refreshHighlights() {
    if (!lastTranslatedText) return;
    await displayTranslation(lastTranslatedText, lastSuggestions);
  }

  // --- In-place term popup (anchored at the clicked term), like the site's inline dialog ---
  const termPopup = document.createElement("div");
  termPopup.hidden = true;
  termPopup.style.cssText =
    "position:fixed;z-index:2147483647;width:250px;background:" + UI.bg + ";color:" + UI.text + ";" +
    "border:1px solid " + UI.border + ";border-radius:" + UI.radius + ";box-shadow:" + UI.shadow + ";" +
    "padding:12px;font-family:" + UI.font + ";font-size:12.5px;white-space:normal;";
  termPopup.dataset.p2preadText = "1";
  document.body.appendChild(termPopup);

  document.addEventListener("mousedown", (e) => {
    if (!termPopup.hidden && !termPopup.contains(e.target) && e.target.tagName !== "MARK") {
      termPopup.hidden = true;
    }
  });

  function positionPopupNear(rect) {
    const width = 240;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 16);
    let top = rect.bottom + 6;
    if (top + 160 > window.innerHeight) top = Math.max(8, rect.top - 166);
    termPopup.style.left = left + "px";
    termPopup.style.top = top + "px";
  }

  function openTermPopup(entry, rect, fullIndex) {
    termPopup.textContent = "";
    const isPending = entry.source === "pending";

    const isNew = fullIndex < 0 && !isPending;

    const badge = document.createElement("div");
    badge.style.cssText =
      "font-size:10px;font-weight:600;margin-bottom:8px;padding:2px 8px;display:inline-block;" +
      "border-radius:" + UI.radiusPill + ";background:" + SOURCE_COLORS[entry.source] + "1a;color:" + SOURCE_COLORS[entry.source] + ";";
    badge.textContent = isPending
      ? "Suggested — not yet added"
      : isNew
      ? "New correction — applied instantly"
      : (entry.scope === "site" ? "This site" : "Global") + " · " + SOURCE_LABELS[entry.source];

    const termsField = document.createElement("input");
    termsField.value = entry.terms.join("|");
    termsField.placeholder = entry.source === "replace" ? "text to replace" : "term1|term2";
    termsField.style.cssText = fieldStyle("margin-bottom:6px;");

    const translationField = document.createElement("input");
    translationField.value = entry.translation;
    translationField.placeholder = entry.source === "replace" ? "replace with…" : "translation";
    translationField.style.cssText = fieldStyle("margin-bottom:10px;");

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";

    if (isPending) {
      const dismissBtn = document.createElement("button");
      dismissBtn.textContent = "Dismiss";
      dismissBtn.style.cssText = buttonStyle("secondary");
      styleButtonHover(dismissBtn, "secondary");
      dismissBtn.onclick = () => {
        termPopup.hidden = true;
      };
      const addBtn = document.createElement("button");
      addBtn.textContent = "Add";
      addBtn.style.cssText = buttonStyle("primary");
      styleButtonHover(addBtn, "primary");
      addBtn.onclick = async () => {
        const terms = termsField.value.split("|").map((t) => t.trim()).filter(Boolean);
        const translation = translationField.value.trim();
        if (terms.length === 0 || !translation) return;
        const current = await loadGlossary();
        current.push(
          normalizeEntry({ terms, translation, scope: "site", hostname: currentHostname(), source: "suggested" })
        );
        await saveGlossary(current);
        termPopup.hidden = true;
        await renderGlossary();
        renderSuggestions(lastSuggestions);
      };
      actions.append(dismissBtn, addBtn);
    } else {
      if (fullIndex >= 0) {
        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "Delete";
        deleteBtn.style.cssText = buttonStyle("danger");
        styleButtonHover(deleteBtn, "danger");
        deleteBtn.onclick = async () => {
          const all = await loadGlossary();
          all.splice(fullIndex, 1);
          await saveGlossary(all);
          termPopup.hidden = true;
          renderGlossary();
        };
        actions.append(deleteBtn);
      } else {
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.cssText = buttonStyle("secondary");
        styleButtonHover(cancelBtn, "secondary");
        cancelBtn.onclick = () => {
          termPopup.hidden = true;
        };
        actions.append(cancelBtn);
      }
      const saveBtn = document.createElement("button");
      saveBtn.textContent = fullIndex >= 0 ? "Save" : "Add";
      saveBtn.style.cssText = buttonStyle("primary");
      styleButtonHover(saveBtn, "primary");
      saveBtn.onclick = async () => {
        const terms = termsField.value.split("|").map((t) => t.trim()).filter(Boolean);
        const translation = translationField.value.trim();
        if (terms.length === 0 || !translation) return;
        const all = await loadGlossary();
        if (fullIndex >= 0) {
          all[fullIndex] = normalizeEntry({ ...entry, terms, translation });
        } else {
          all.push(normalizeEntry({ ...entry, terms, translation }));
        }
        await saveGlossary(all);
        termPopup.hidden = true;
        renderGlossary();
      };
      actions.append(saveBtn);
    }

    termPopup.append(badge, termsField, translationField, actions);
    positionPopupNear(rect);
    termPopup.hidden = false;
  }

  async function openTermEditor(match, rect) {
    if (match.source === "pending") {
      openTermPopup(match, rect, -1);
      return;
    }
    const all = await loadGlossary();
    const idx = all.findIndex((e) => entryKey(e) === entryKey(match));
    openTermPopup(idx >= 0 ? all[idx] : match, rect, idx);
  }

  async function renderSuggestions(suggestions) {
    suggestionsSection.textContent = "";
    glossaryBtn.textContent = "📖";
    if (!suggestions || suggestions.length === 0 || KEEP_NOTHING) return;

    const glossary = await loadGlossary();
    const existingTerms = new Set(glossary.flatMap((e) => e.terms));
    const fresh = suggestions.filter((s) => !existingTerms.has(s.term));
    if (fresh.length === 0) return;

    glossaryBtn.textContent = "📖•";

    const header = document.createElement("div");
    header.style.cssText =
      "font-size:10.5px;font-weight:700;letter-spacing:.05em;color:" + UI.muted + ";margin-bottom:8px;";
    header.textContent = "SUGGESTED THIS CHAPTER";
    suggestionsSection.appendChild(header);

    fresh.forEach((s) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:6px;" +
        "padding:5px 8px;margin-bottom:4px;font-size:12px;background:" + UI.bgMuted + ";border-radius:" + UI.radiusSm + ";";
      const label = document.createElement("span");
      label.textContent = s.term + " → " + s.translation;
      const addSuggestionBtn = document.createElement("button");
      addSuggestionBtn.textContent = "+";
      addSuggestionBtn.title = "Add to terms (scoped to this site)";
      addSuggestionBtn.style.cssText =
        "cursor:pointer;border:none;background:" + UI.primary + ";color:#fff;border-radius:50%;" +
        "width:20px;height:20px;font-size:13px;line-height:1;flex:none;";
      addSuggestionBtn.onclick = async () => {
        const current = await loadGlossary();
        current.push(
          normalizeEntry({
            terms: [s.term],
            translation: s.translation,
            scope: "site",
            hostname: currentHostname(),
            source: "suggested",
            kind: s.kind
          })
        );
        await saveGlossary(current);
        row.remove();
        renderGlossary();
      };
      row.append(label, addSuggestionBtn);
      suggestionsSection.appendChild(row);
    });
  }

  // The terms found in the translation as the library's reader finds them (terms.js, the site's own code: at a word's edges, as the rendering is written, a plural ending
  // on a longer one, none shorter than 3 letters). Matched anywhere, "ore" lit up inside "more" and "Qi" inside "Qiong", and the page marked what the library did not.
  // -> the matcher, or null (no terms; or no terms.js, an older injection: every place the rendering is, as before)
  function termMatcher(terms) {
    if (typeof Terms === "undefined" || !terms.length) return null;
    return Terms.buildMatcher(terms.map((t) => ({ english: String(t.translation || ""), term: t })));
  }
  function highlightParagraph(pElement, text, terms, matcher) {
    if (terms.length === 0) {
      pElement.textContent = text;
      return;
    }
    let parts;
    if (typeof Terms !== "undefined") parts = Terms.split(text, matcher === undefined ? termMatcher(terms) : matcher).map((seg) => ({ text: seg.text, match: seg.entries ? seg.entries[0].term : null }));
    else {
      const sorted = [...terms].sort((a, b) => b.translation.length - a.translation.length);
      const re = new RegExp("(" + sorted.map((t) => escapeRegExp(t.translation)).join("|") + ")", "g");
      parts = text.split(re).map((part) => ({ text: part, match: sorted.find((t) => t.translation === part) || null }));
    }
    parts.forEach(({ text: part, match }) => {
      if (!part) return;
      if (match) {
        const mark = document.createElement("mark");
        mark.textContent = part;
        const isPending = match.source === "pending";
        mark.title = isPending ? "Click to add this suggested term" : "Click to edit this term";
        const color = SOURCE_COLORS[match.source];
        mark.style.cssText =
          "background:" + color + (isPending ? "14" : "1f") + ";font-weight:600;cursor:pointer;color:" + color + ";" +
          "border-radius:4px;padding:0 3px;margin:0 -1px;transition:background .15s;" +
          (isPending ? "border-bottom:1px dashed " + color + ";" : "");
        mark.onmouseenter = () => (mark.style.background = color + (isPending ? "26" : "33"));
        mark.onmouseleave = () => (mark.style.background = color + (isPending ? "14" : "1f"));
        mark.onclick = () => openTermEditor(match, mark.getBoundingClientRect());
        pElement.appendChild(mark);
      } else {
        pElement.appendChild(document.createTextNode(part));
      }
    });
  }

  async function displayTranslation(text, suggestions) {
    lastTranslatedText = text; // always the raw AI output; replacements are re-applied fresh each render
    lastSuggestions = suggestions || [];

    const glossary = effectiveGlossary(await loadGlossary());
    const displayText = applyReplacements(text, glossary);

    const knownTerms = new Set(glossary.flatMap((e) => e.terms));
    const pendingTerms = lastSuggestions
      .filter((s) => !knownTerms.has(s.term))
      .map((s) => normalizeEntry({ terms: [s.term], translation: s.translation, scope: "site", source: "pending" }));
    const forHighlight = [...glossary, ...pendingTerms];
    const matcher = termMatcher(forHighlight); // (built once for the chapter)

    if (panelContentEl) {
      panelContentEl.textContent = "";
      const p = document.createElement("p");
      p.style.margin = "0";
      highlightParagraph(p, displayText, forHighlight, matcher);
      panelContentEl.appendChild(p);
      return;
    }
    if (!target.__geminiOriginal) {
      target.__geminiOriginal = Array.from(target.childNodes).map((n) => n.cloneNode(true));
    }
    target.textContent = "";
    const paragraphs = displayText
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const para of paragraphs) {
      const p = document.createElement("p");
      highlightParagraph(p, para, forHighlight, matcher);
      target.appendChild(p);
    }
  }

  // how many words a text has, as the popup counts them (a Chinese or Japanese character is a word)
  const wordsIn = (text) => (String(text).match(/[\p{L}\p{N}]+/gu) || []).reduce((n, w) => n + (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(w) ? Array.from(w).length : 1), 0);
  async function runTranslation(forceRefresh) {
    const mine = ++textRun; // (Stop, or Translate again meanwhile: what comes back to this one is not shown)
    const stale = () => mine !== textRun;
    retranslateBtn.disabled = true;
    say("Finding text…", { step: "finding", error: "", tickets: 0 });

    await langReady;
    if (!forceRefresh) {
      const cached = await ext.storage.local.get(keyIn(cacheKey, pageLang));
      const entry = cached[keyIn(cacheKey, pageLang)];
      if (entry && !stale()) {
        await displayTranslation(entry.translated, entry.suggestions);
        retranslateBtn.disabled = false;
        window.__P2PREAD_TRANSLATED__ = entry.translated; // (before it is said: the pill offers Listen for it)
        say("Cached · " + new Date(entry.savedAt).toLocaleTimeString(), { step: "done", made: true, showing: "made" });
        renderSuggestions(entry.suggestions);
        if (!KEEP_NOTHING) prefetchAhead().catch(() => {});
        if (AHEAD) textAhead(AHEAD);
        return;
      }
      // Translate ahead: this page made before it was opened (or being made: waited for)
      if (AHEAD) {
        const made = await ext.runtime.sendMessage({ type: "ahead:textGet", url: location.href }).catch(() => null);
        if (stale()) return;
        if (made && made.translated) {
          await displayTranslation(made.translated, made.suggestions);
          retranslateBtn.disabled = false;
          window.__P2PREAD_TRANSLATED__ = made.translated;
          say("Translated ahead", { step: "done", made: true, showing: "made" });
          textAhead(AHEAD);
          return;
        }
      }
    }

    const nextLink = nextChapterLink();
    const text = (getRawSourceText() || originalText).slice(0, 20000);
    say("Translating…", { step: "translating", words: wordsIn(text) });
    await freshenGlossary();
    const glossary = effectiveGlossary(await loadGlossary());
    // "replace" entries are output-side corrections (old AI wording -> fixed wording), not source-language
    // translation hints, so they're applied locally in displayTranslation rather than sent to Gemini.
    const glossaryForPrompt = glossary.filter((e) => e.source !== "replace");
    // (Translate ahead: through the same place as the pages ahead, so a page asked for twice is translated once)
    const response = (AHEAD
      ? await ext.runtime.sendMessage({ type: "ahead:text", text, glossary: glossaryForPrompt, url: location.href, title: document.title, wait: true, fresh: !!forceRefresh })
      : await ext.runtime.sendMessage({ type: "translate", text, glossary: glossaryForPrompt, url: location.href, title: document.title, keepNothing: KEEP_NOTHING, pay: PAY })) || { error: "the extension did not answer" };
    if (stale()) return;
    retranslateBtn.disabled = false;
    if (response.error) {
      say("", { step: "failed", error: String(response.error) });
      return;
    }
    await displayTranslation(response.translated, response.suggestions);
    window.__P2PREAD_TRANSLATED__ = response.translated; // (the popup's Listen and the pill's read it)
    say("Translated" + (response.tickets ? " · " + Math.round(response.tickets) + " tickets" : ""), { step: "done", made: true, showing: "made", tickets: response.tickets || 0, model: response.model || "", lang: response.language || pageLang });
    renderSuggestions(response.suggestions);
    if (AHEAD) textAhead(AHEAD);
    if (KEEP_NOTHING) return;
    const [pageTitle, novelName] = await Promise.all([englishLabel(document.title), englishLabel(resolveNovelName())]);
    await ext.storage.local.set({
      [keyIn(cacheKey, response.language || pageLang)]: {
        translated: response.translated,
        suggestions: response.suggestions || [],
        savedAt: Date.now(),
        model: response.model || null,
        pageTitle,
        novelName,
        ...(nextLink ? { next: nextLink } : {}) // where the next chapter is, so the reader's Next button can follow it
      }
    });
    prefetchAhead().catch(() => {});
  }

  // Translate ahead (translate-ahead.js): the next `count` pages after this one (each page's Next link, fetched as the tab would), translated before they are opened and
  // kept for the session by the background; the toolbar says how many are ready. A page with no chapter's text ends it.
  let aheadRun = 0;
  async function textAhead(count) {
    const mine = ++aheadRun;
    const n = Math.max(0, Math.min(5, Number(count) || 0));
    if (!n) return;
    await freshenGlossary();
    const glossaryForPrompt = effectiveGlossary(await loadGlossary()).filter((e) => e.source !== "replace");
    const asked = [];
    let doc = document;
    let url = location.href;
    for (let i = 0; i < n && mine === aheadRun; i++) {
      const next = findNextChapterUrl(doc, url);
      if (!next) break;
      const have = await ext.runtime.sendMessage({ type: "ahead:textGet", url: next, peek: true }).catch(() => null);
      const nextDoc = typeof NextPage !== "undefined" ? await NextPage.fetchDoc(next) : await fetchHtml(next).then((h) => (h ? new DOMParser().parseFromString(h, "text/html") : null), () => null);
      if (!nextDoc) break;
      if (have && (have.translated || have.state === "running")) asked.push(ext.runtime.sendMessage({ type: "ahead:textGet", url: next }).catch(() => null));
      else {
        const text = extractTextFromDoc(nextDoc, new URL(next).hostname.replace(/^www\./, ""));
        if (!text) break;
        asked.push(ext.runtime.sendMessage({ type: "ahead:text", text: text.slice(0, 20000), glossary: glossaryForPrompt, url: next, title: nextDoc.title || "", wait: true }).catch((e) => ({ error: e.message })));
      }
      doc = nextDoc;
      url = next;
    }
    if (!asked.length || mine !== aheadRun) return;
    const said = textState.status.replace(/ · Next .*$/, "");
    let ready = 0;
    let failed = "";
    const tell = () => { if (mine === aheadRun && textState.step === "done") say(said + " · Next " + asked.length + ": " + (ready >= asked.length ? "ready" : ready ? ready + " ready" : "translating…") + (failed ? " (" + failed + ")" : "")); };
    tell();
    await Promise.all(asked.map((p) => p.then((r) => { if (r && r.translated) ready++; else failed = (r && r.error) || "not translated"; tell(); })));
  }
  window.__p2preadTextAhead = (count) => textAhead(count);

  retranslateBtn.onclick = () => runTranslation(true);

  runTranslation(false);
})();
