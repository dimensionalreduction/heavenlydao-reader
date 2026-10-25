// A novel's translation profile (docs/PROFILES.md: a model and a prompt, chosen for the library or for one novel) used for the chapters a watch fetches
// (watcher.js, then: "fetch" or "all") while no page of the library is open. The library's page translates the chapters it opens itself (site/profiles.js);
// these would wait for it, untranslated. They are translated the same way, with the playground's own code (profile-model.js, made from its translate.js: the
// prompt, the novel's glossary terms found in the chapter, the model's answer), and paid as the profile says:
//   tickets    the playground's server, with the sign-in this browser's library page handed over (a token of its own for this extension, not the cookie)
//   key        the provider's address, with the key this browser's library page keeps for it (handed over too; never in the library)
//   extension  not here: the extension's own Gemini, with the profile's prompt (OriginalTranslate.run, as the reader's Custom prompt)
// What the page hands over (site-bridge.js "access") is kept in storage.local: profileKeys ({ <provider's address>: key }) and playgroundToken.
//
// Runs in the background script, after site-matches.js, term-match.js, gemini.js, glossary-server.js, wtr-terms.js and profile-model.js.
var ProfileTranslate = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const PLAYGROUND = "https://playground.heavenlydao.com";
  const KEYS = "profileKeys";
  const TOKEN = "playgroundToken";
  // the library site's addresses (site-matches.js): only a tab of it hands anything over
  const SITE_MATCHES = typeof SITE_BRIDGE_MATCHES !== "undefined" ? SITE_BRIDGE_MATCHES : [];
  const onSite = (url) => typeof url === "string" && SITE_MATCHES.some((m) => url.startsWith(m.replace(/\*$/, "")));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let waitScale = 1; // (tests: shorter waits)

  // The books a chapter belongs to, as the library names novels (Chapters: a site novel "wtr-lab:<id>", else the chapter's site and folder)
  function booksOf(url) {
    const w = WtrTerms.parseWtrUrl(url);
    if (w) return ["wtr-lab:" + w.rawId];
    try {
      return [WtrTerms.bindingKey(url)];
    } catch (e) {
      return [];
    }
  }
  // The profile a novel is translated with: its own choice (novelProfiles, by its book: one of `books`), else the library's default; null for the extension's
  // Gemini (a novel's "gemini", or no profile at all), as before profiles. s: the library's settings.
  function profileOf(s, books) {
    const list = (s && Array.isArray(s.translateProfiles) ? s.translateProfiles : []).filter((p) => p && p.id);
    const novels = (s && s.novelProfiles) || {};
    const id = books.map((b) => novels[b]).find(Boolean) || (s && s.translateProfile);
    return (id && id !== "gemini" && list.find((p) => p.id === id)) || null;
  }
  // The profile for a chapter at `url`, from the library's settings (read at most once a minute: GlossaryServer.profileSettings); null when it has none
  async function forChapter(url) {
    const s = await GlossaryServer.profileSettings().catch(() => null);
    return profileOf(s, booksOf(url));
  }
  // The reader's Custom prompt that a profile paid by the extension is (its own Gemini key and model, the profile's prompt)
  const customOf = (profile) => ({ prompt: profile.prompt || ProfileModel.DEFAULT_PROMPT, notes: false, glossary: true });

  // Into another language than English: the novel's glossaries in that language ("<glossary>@<code>", as the library's page sends them), not the English ones:
  // of the lists ticked for it, in their order, the terms of each list (WtrTerms.novelLists).
  async function languageGlossary(url, lang, book) {
    const { glossaryLibrary, glossaryBindings } = await ext.storage.local.get(["glossaryLibrary", "glossaryBindings"]);
    const novel = book || WtrTerms.bookOf(url);
    let key = "";
    try { key = WtrTerms.bindingKey(url); } catch (e) { /* not a page address */ }
    const lists = WtrTerms.novelLists({ glossaries: glossaryLibrary, bindings: glossaryBindings, keys: [key, novel].filter(Boolean), book: novel, implicit: /^wtr-lab:\d+$/.test(novel) ? [novel] : [] });
    const out = [];
    const seen = new Set();
    const made = new Map(); // glossary id -> its glossary in that language
    for (const l of lists.filter((x) => x.on)) {
      if (!made.has(l.gid)) made.set(l.gid, await GlossaryServer.api("GET", "/api/glossaries/" + encodeURIComponent(l.gid + "@" + lang)).catch(() => null)); // (none in this language yet)
      const g = made.get(l.gid);
      const mine = new Set(l.rows.map((r) => r[0]));
      for (const row of (g && g.terms) || []) {
        if (!row || !row[0] || !row[1] || seen.has(row[0]) || !mine.has(row[0])) continue;
        seen.add(row[0]);
        out.push({ terms: [String(row[0])], translation: String(row[1]) });
      }
    }
    return out;
  }

  // Why it could not be translated, and whether asking again can help (stop: not until something is changed here: a key, a sign-in, tickets)
  const failure = (error, stop) => ({ error, stop: !!stop });
  // One chapter's text translated with the profile. glossary: the terms that apply to it (entries with terms and translation, as the extension's own);
  // lang: the language it goes into. -> { text, tickets } or { error, stop }
  async function translate(job, profile, glossary, lang) {
    const M = ProfileModel;
    const stored = await ext.storage.local.get([KEYS, TOKEN]);
    const patron = profile.pay === "tickets";
    const token = patron ? String(stored[TOKEN] || "") : "";
    const key = profile.pay === "key" ? { base: profile.base, key: (stored[KEYS] || {})[profile.base] || "" } : null;
    if (patron && !token) return failure("No sign-in for tickets in this browser: open the library here while signed in", true);
    if (key && !key.key && /openrouter\.ai|generativelanguage\.googleapis\.com/.test(key.base)) return failure("No key for " + profile.name + " in this browser: add it in the library's Settings › Translation", true);
    const text = String(job.text || "");
    const built = M.buildPrompt({ instruction: profile.prompt || M.DEFAULT_PROMPT, language: geminiLanguageName(lang), text, glossary });
    const google = !!key && M.isGoogle(key.base);
    for (let tries = 0; ; tries++) {
      if (google) await geminiTurn(); // (the person's own Gemini key: held to the library's Gemini requests a minute, with the extension's own calls)
      try {
        const r = await M.runModel({ model: profile.model, prompt: built.prompt, chars: M.charsOf(text), key, patron, token, server: PLAYGROUND });
        if (!r.text.trim()) return failure("The model answered with nothing");
        return { text: r.text.trim(), tickets: r.tickets };
      } catch (e) {
        if (google && e.status === 429 && tries < 2) { await sleep(20000 * waitScale); continue; } // (a limit of the key's own, lower than the library's: wait and ask again)
        if (e.status === 401) return failure(patron ? "The playground did not take this browser's sign-in: open the library here while signed in" : "Your key for " + profile.name + " was refused", true);
        if (e.status === 402) return failure(e.message || "No tickets left", true);
        return failure(e.message || "The model could not be reached");
      }
    }
  }

  // What the library's page in this browser hands over (site-bridge.js): keys, the ones it keeps ({ <address>: key }: all of them, so one removed there is gone
  // here too); token, the playground's sign-in for this extension ("" signed out; left out: as it was).
  async function keep(msg) {
    const patch = {};
    if (msg.keys && typeof msg.keys === "object") {
      const keys = {};
      for (const [base, k] of Object.entries(msg.keys).slice(0, 50)) if (/^https?:\/\/[^\s"'<>]{3,200}$/.test(base) && typeof k === "string" && k && k.length <= 400) keys[base] = k;
      patch[KEYS] = keys;
    }
    if (typeof msg.token === "string" && msg.token.length <= 600) patch[TOKEN] = msg.token;
    if (Object.keys(patch).length) await ext.storage.local.set(patch);
  }
  if (ext && ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === "profile:access" && sender && sender.tab && onSite(sender.url)) keep(msg).catch(() => {});
    });
  }

  return { profileOf, booksOf, forChapter, customOf, languageGlossary, translate, keep, KEYS, TOKEN, _waitScale: (x) => { waitScale = x; } };
})();
