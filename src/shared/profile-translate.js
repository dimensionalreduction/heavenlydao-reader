// A novel's translation profile (docs/PROFILES.md: a name and a prompt, chosen for the library or for one novel) used for the chapters a watch fetches
// (watcher.js, then: "fetch" or "all") while no page of the library is open. The library's page translates the chapters it opens itself (site/profiles.js);
// these would wait for it, untranslated. They are translated the same way, with the playground's own code (profile-model.js, made from its translate.js: the
// prompt, the novel's glossary terms found in the chapter, the model's answer). The profile gives the prompt only; the model and who pays are the person's
// Settings › Model rules, the Translation card (pay.js, the library site's own code; the library's page hands the rules over), the rows in the order they are tried:
//   tickets    the playground's server, with the sign-in this browser's library page handed over (a token of its own for this extension, not the cookie)
//   a key      the provider's address, with the key this browser's library page keeps for it (handed over too; never in the library)
// A row that fails for who pays (a key refused, no tickets, a limit, the provider down: Pay.skipFor) or answers with nothing is left out and the next is asked, as the
// comic host does (comic-host.js asker); the chapter fails only when every row has.
// What the page hands over (site-bridge.js "access") is kept in storage.local: profileKeys ({ <provider's address>: key }), playgroundToken, modelRules and comicPrompts.
//
// The rule's last row, Google Translate, is no one's to pay (google-chapter.js): with no key and no sign-in handed over, a chapter is still translated.
// Runs in the background script, after pay.js, site-matches.js, term-match.js, google-chapter.js, gemini.js, glossary-server.js, wtr-terms.js and profile-model.js.
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
  const hostOf = (a) => { try { return new URL(a).host; } catch (e) { return String(a); } };
  const payerName = (pair) => (pair.pay === "tickets" ? "tickets" : pair.pay === "free" ? "free" : hostOf(pair.pay) + " key");
  // The pairs that failed for who pays, kept while this background page lives: a key refused or tickets run out ("visit") is not asked again by the next chapter; a limit or a busy
  // provider ("chapter") only for that chapter. What the library's page hands over (a key, a sign-in, the rules) can change that, so it clears them.
  const skipped = Pay.skipList();
  // One request of the prompt to one pair of the rules: { text, tickets }. Throws with the status (Pay.skipFor says what a failure means); an answer with nothing has refused: true
  async function attempt(job, instruction, glossary, lang, pair, stored) {
    const M = ProfileModel;
    if (pair.kind === "free") { // (Google Translate, the rule's last row: free, no prompt, the glossary's proper names kept: google-chapter.js)
      const text = String(job.text || "");
      const out = await GoogleChapter.translate(text, { lang, glossary: M.buildPrompt({ instruction: "", language: geminiLanguageName(lang), text, glossary }).sent });
      if (!out.trim()) throw Object.assign(new Error("Google Translate answered with nothing"), { refused: true });
      return { text: out, tickets: 0 };
    }
    const patron = pair.pay === "tickets";
    const token = patron ? String(stored[TOKEN] || "") : "";
    const key = patron ? null : { base: pair.pay, key: (stored[KEYS] || {})[pair.pay] || "" };
    if (patron && !token) throw Object.assign(new Error("No sign-in for tickets in this browser: open the library here while signed in"), { status: 401, said: true });
    if (key && !key.key && /openrouter\.ai|generativelanguage\.googleapis\.com/.test(key.base)) throw Object.assign(new Error("No key for " + hostOf(key.base) + " in this browser: add it in the library's Settings › Translation"), { status: 401, said: true });
    const text = String(job.text || "");
    const built = M.buildPrompt({ instruction: instruction || M.DEFAULT_PROMPT, language: geminiLanguageName(lang), text, glossary });
    const google = !!key && M.isGoogle(key.base);
    for (let tries = 0; ; tries++) {
      if (google) await geminiTurn(); // (the person's own Gemini key: held to the library's Gemini requests a minute, with the extension's own calls)
      try {
        const r = await M.runModel({ model: pair.model, prompt: built.prompt, chars: M.charsOf(text), key, patron, token, server: PLAYGROUND });
        if (!r.text.trim()) throw Object.assign(new Error("The model answered with nothing"), { refused: true });
        return { text: r.text.trim(), tickets: r.tickets };
      } catch (e) {
        if (google && e.status === 429 && tries < 2) { await sleep(20000 * waitScale); continue; } // (a limit of the key's own, lower than the library's: wait and ask again)
        throw e;
      }
    }
  }
  // What a failure says, for the person
  function said(e, pair) {
    if (e.said) return e.message;
    if (e.status === 401) return pair.pay === "tickets" ? "The playground did not take this browser's sign-in: open the library here while signed in" : "Your key for " + hostOf(pair.pay) + " was refused";
    return e.message || "The model could not be reached";
  }
  // One chapter's text translated with the profile's prompt (profile.prompt; blank: the default prompt) by the Translation rule's rows, best first, the next when one fails for who
  // pays or has nothing to say. glossary: the terms that apply to it (entries with terms and translation, as the extension's own); lang: the language it goes into.
  // -> { text, tickets, used (the row that translated it: { model, pay, kind, rule }) } or { error, stop }
  // stop (asking again cannot help until something is changed here: a key, a sign-in, tickets): nothing could pay for any row, or every row that was asked was refused for who pays
  async function translate(job, profile, glossary, lang) {
    const stored = await ext.storage.local.get([KEYS, TOKEN, RULES]);
    const has = { patron: !!stored[TOKEN], ticketsLeft: null, keys: Object.keys(stored[KEYS] || {}) };
    const chapter = String(job.url || "");
    const asked = []; // [pair, error] of the rows that failed
    for (;;) {
      Pay.useRules(stored[RULES] || {}); // (Pay is the page's: the rules are set again right before they are read, nothing waits in between)
      const pair = Pay.best("translate", has, (c) => c.kind === "device" || skipped.has(c, chapter));
      if (!pair) break;
      try {
        const r = await attempt(job, profile && profile.prompt, glossary, lang, pair, stored);
        return { text: r.text, tickets: r.tickets, used: pair };
      } catch (e) {
        asked.push([pair, e]);
        const how = e.refused ? "chapter" : Pay.skipFor(e);
        if (!how) break; // (the text, not the payer: the next row would fail as well)
        skipped.add(pair, how, chapter);
      }
    }
    if (!asked.length) {
      Pay.useRules(stored[RULES] || {});
      const unskipped = Pay.best("translate", has, (c) => c.kind === "device");
      return failure(unskipped
        ? "Every model of the Translation rule was refused earlier (a key, a sign-in or no tickets): fix it in the library's Settings › Model rules, then open the library here"
        : "Nothing to pay for the Translation rule with in this browser: open the library here while signed in, or add a key in its Settings › Model rules", true);
    }
    const stop = asked.every(([, e]) => [401, 402, 403].includes(Number(e.status)));
    const lines = asked.map(([pair, e]) => (asked.length > 1 ? (pair.rule || pair.model) + " (" + payerName(pair) + "): " : "") + said(e, pair));
    return failure(lines.join("; "), stop);
  }

  // What the library's page in this browser hands over (site-bridge.js): keys, the ones it keeps ({ <address>: key }: all of them, so one removed there is gone
  // here too); token, the playground's sign-in for this extension ("" signed out; left out: as it was).
  // The rules the person set in Settings › Model rules ({ <job>: [{ model, kind, base? }] }, only the jobs changed): what is plausible is kept, the rest dropped (Pay.useRules checks again).
  const RULES = "modelRules", RULE_KINDS = ["tickets", "device", "free", "openrouter", "gemini", "fish", "other"];
  function cleanRules(rules) {
    const out = {};
    for (const [item, rows] of Object.entries(rules).slice(0, 20)) {
      if (item === "v") { if (Number.isInteger(rows) && rows >= 1 && rows <= 99) out.v = rows; continue; } // (the version of the rules: Pay.useRules)
      if (!/^[A-Za-z]{1,30}$/.test(item) || !Array.isArray(rows)) continue;
      const kept = rows.slice(0, 30).filter((r) => r && typeof r.model === "string" && r.model.length > 0 && r.model.length <= 200 && RULE_KINDS.includes(r.kind)
        && (r.kind !== "other" || (typeof r.base === "string" && /^https?:\/\/[^\s"'<>]{3,200}$/.test(r.base)))).map((r) => (r.kind === "other" ? { model: r.model, kind: r.kind, base: r.base } : { model: r.model, kind: r.kind }));
      if (kept.length) out[item] = kept;
    }
    return out;
  }
  async function keep(msg) {
    const patch = {};
    if (msg.keys && typeof msg.keys === "object") {
      const keys = {};
      for (const [base, k] of Object.entries(msg.keys).slice(0, 50)) if (/^https?:\/\/[^\s"'<>]{3,200}$/.test(base) && typeof k === "string" && k && k.length <= 400) keys[base] = k;
      patch[KEYS] = keys;
    }
    if (typeof msg.token === "string" && msg.token.length <= 600) patch[TOKEN] = msg.token;
    if (msg.rules && typeof msg.rules === "object" && !Array.isArray(msg.rules)) patch[RULES] = cleanRules(msg.rules);
    if (msg.comicPrompts && typeof msg.comicPrompts === "object" && !Array.isArray(msg.comicPrompts)) { // (the comic prompts the person changed: { find?, read?, draw? } text; none: the built-in ones)
      const prompts = {};
      for (const k of ["find", "read", "draw"]) if (typeof msg.comicPrompts[k] === "string" && msg.comicPrompts[k].trim()) prompts[k] = msg.comicPrompts[k].slice(0, 20000);
      patch.comicPrompts = prompts;
    }
    if (Object.keys(patch).length) { await ext.storage.local.set(patch); skipped.clear(); } // (a key, a sign-in or a rule changed: what failed may work now)
  }
  if (ext && ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, sender) => {
      if (msg && msg.type === "profile:access" && sender && sender.tab && onSite(sender.url)) keep(msg).catch(() => {});
    });
  }

  // The popup's Translate on a chapter's page paid with tickets (docs/ADD-BOOK.md): the text with the playground's Gemini 3.5 Flash Lite, as the in-page translator answers
  // (content.js: { translated, suggestions, language, model, tickets } or { error }). Nothing is kept.
  const TICKETS_MODEL = "google/gemini-3.5-flash-lite";
  // (one pair, not the rules' rows: the popup says which way to pay)
  async function pageWith(pair, text, glossary, lang) {
    const stored = await ext.storage.local.get([KEYS, TOKEN]);
    try {
      const r = await attempt({ text }, "", glossary || [], lang || "en", pair, stored);
      return { translated: r.text, suggestions: [], language: lang || "en", model: TICKETS_MODEL, tickets: pair.pay === "tickets" ? r.tickets : 0 };
    } catch (e) {
      return { error: said(e, pair) };
    }
  }
  const pageWithTickets = (text, glossary, lang) => pageWith({ model: TICKETS_MODEL, pay: "tickets", kind: "tickets", rule: TICKETS_MODEL }, text, glossary, lang);

  // The same with the person's OpenRouter key (the popup's Translate on a text chapter, no Gemini key): the model tickets use, straight to OpenRouter
  const pageWithKey = (text, glossary, lang) => pageWith({ model: TICKETS_MODEL, pay: OPENROUTER, kind: "openrouter", rule: TICKETS_MODEL }, text, glossary, lang);

  // The popup's Translate on a text chapter, by the Translation rule's rows (Settings › Model rules): the first that can be paid for, the next when one fails for who pays, as a
  // watch's chapter is (translate). Nothing kept. -> as the in-page translator answers ({ translated, suggestions, language, model, tickets }) or { error }
  async function pageByRules(text, glossary, lang, url) {
    const r = await translate({ text, url: url || "" }, null, glossary || [], lang || "en");
    if (r.error) return { error: r.error };
    return { translated: r.text, suggestions: [], language: lang || "en", model: (r.used && (r.used.rule || r.used.model)) || "", tickets: r.used && r.used.pay === "tickets" ? r.tickets : 0 };
  }

  // Who can pay for a question of the extension's own (Detect with AI) without a Gemini key: the OpenRouter key the library's page handed over, else tickets
  // (the sign-in it handed over). "key", "tickets" or "" (neither).
  const OPENROUTER = "https://openrouter.ai/api/v1";
  async function payer() {
    const stored = await ext.storage.local.get([KEYS, TOKEN]);
    if ((stored[KEYS] || {})[OPENROUTER]) return "key";
    return stored[TOKEN] ? "tickets" : "";
  }
  // A question answered by the model of Tickets (as pageWithTickets), paid by payer(). -> { text, tickets } or { error }
  async function ask(prompt, maxTokens) {
    const way = await payer();
    if (!way) return { error: "No key or tickets in this browser: add a key in the library's Settings › Translation, or open the library here while signed in" };
    const M = ProfileModel;
    const stored = await ext.storage.local.get([KEYS, TOKEN]);
    try {
      const r = await M.runModel({ model: TICKETS_MODEL, prompt, maxTokens: maxTokens || 2000, chars: M.charsOf(prompt), key: way === "key" ? { base: OPENROUTER, key: stored[KEYS][OPENROUTER] } : null, patron: way === "tickets", token: way === "tickets" ? String(stored[TOKEN]) : "", server: PLAYGROUND });
      return r.text.trim() ? { text: r.text.trim(), tickets: r.tickets } : { error: "The model answered with nothing" };
    } catch (e) {
      if (e.status === 401) return { error: way === "tickets" ? "The playground did not take this browser's sign-in: open the library here while signed in" : "Your key for OpenRouter was refused" };
      return { error: e.message || "The model could not be reached" };
    }
  }

  return { profileOf, booksOf, forChapter, languageGlossary, translate, pageWithTickets, pageWithKey, pageByRules, payer, ask, keep, KEYS, TOKEN, _waitScale: (x) => { waitScale = x; } };
})();
