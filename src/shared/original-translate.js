// Translates a chapter's original text the same way the in-page translator does (Gemini + your terms + the glossaries bound to the
// novel), but without a page: the text was already downloaded by p2p-host.js. The result is saved under the chapter's normal
// translation key, so it shows up everywhere (popup, reader site) like a chapter translated from its own page.
//
// Runs in the background script (it has storage, the library's client and Gemini). Needs gemini.js, glossary-server.js,
// wtr-terms.js, term-match.js and term-notes.js loaded before it.
var OriginalTranslate = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const MAX_CHARS = 20000; // what the in-page translator sends at most
  // (the requests here are to wtr-lab: the browser has to have allowed the site, site-access.js)
  const fetch = (url, options) => (typeof SiteAccess !== "undefined" ? SiteAccess.fetch(url, options) : globalThis.fetch(url, options));

  function ownEntry(e) {
    return {
      terms: e.terms && e.terms.length ? e.terms : e.term ? [e.term] : [],
      translation: e.translation || "",
      scope: e.scope === "site" ? "site" : "global",
      hostname: e.scope === "site" ? e.hostname || null : null,
      source: ["suggested", "starter", "pending", "replace", "wtr"].includes(e.source) ? e.source : "manual",
      // what kind of term it is (person, place, technique... as Gemini said) and whether it is always meant (TermMatch)
      ...(e.kind ? { kind: String(e.kind) } : {}),
      ...(e.match === "always" ? { match: "always" } : {}),
      ...(e.origin ? { origin: e.origin } : {})
    };
  }

  // The terms that apply to this chapter: yours, plus the library's glossaries of its novel, the lists ticked for it (WtrTerms.boundEntries). (The terms
  // picked in the library's reader change only what is shown, after the translation: none of them is sent.) book: the novel's, when the chapter is
  // saved as another's (a site chapter read from its source site).
  async function termsFor(url, book) {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const stored = await ext.storage.local.get(["glossary", "glossaryLibrary", "glossaryBindings"]);
    const own = (stored.glossary || []).map(ownEntry);
    const bound = WtrTerms.boundEntries({ library: stored.glossaryLibrary, bindings: stored.glossaryBindings, url, ownEntries: own, hostname, book }).map(ownEntry);
    // "replace" entries correct the AI's output afterwards; they are not hints for the model.
    return own.concat(bound).filter((e) => (e.scope === "global" || e.hostname === hostname) && e.source !== "replace");
  }

  // The English fixes that apply to a chapter: your own "replace" entries (for every site, or this one) and your terms from the library's reader (for every
  // novel, or this one).
  async function replacementsFor(url) {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const stored = await ext.storage.local.get(["glossary", "myTerms", "glossaryBindings"]);
    const own = (stored.glossary || []).map(ownEntry).filter((e) => e.source === "replace" && (e.scope === "global" || e.hostname === hostname));
    return own.concat(WtrTerms.myTermEntries(stored.myTerms, url, stored.glossaryBindings));
  }

  // The novel's index of mentions (TermMatch.record): which chapters have which terms, kept per novel in storage.local.termMentions. The terms are those of the
  // glossary the chapter was sent with, found the way they are chosen to be sent, and those Gemini suggested from it. A chapter's number is its title's (or its
  // address's); one with none is not recorded.
  async function noteMentions(job, glossary, response) {
    if (typeof TermMatch === "undefined") return;
    const no = TermNotes.chapterNumber(job.pageTitle, job.url);
    if (no == null) return;
    const text = String(job.text);
    const sources = new Set(TermMatch.select(text, glossary).found);
    for (const s of response.suggestions || []) if (s && s.term && text.includes(s.term)) sources.add(s.term);
    const key = WtrTerms.bindingKey(job.url);
    const { termMentions } = await ext.storage.local.get("termMentions");
    const all = Object.assign({}, termMentions);
    // (a term of this glossary that the chapter does not have is taken out of it, in case it was read before with other terms)
    all[key] = TermMatch.record(all[key], no, [...sources], (glossary || []).flatMap((e) => e.terms || []));
    await ext.storage.local.set({ termMentions: all });
  }

  // job: { url (the chapter's page), text (its original text), novelName, pageTitle, next, force (replace a chapter already translated: a re-fetch or a
  // re-translate), retranslate (send it to the translator even if it is English: only when asked for on purpose), notes (optional: 0 = no notes on terms
  // for this chapter, more = notes when they are switched on; not given: as the switch says), lang (optional: the language to translate it into, a code; not
  // given: the one the library says), custom (optional, the reader's Custom prompt: { prompt, notes, glossary, replace }, see TermNotes.translate; replace: your English fixes are done on the answer),
  // watched (a chapter a watch fetched: translated with its novel's profile when it has one) }
  // The result is kept under the chapter's key for English and under "<chapter key>#lang=<code>" for another language: versions of the same chapter.
  async function run(job) {
    const lang = job.lang || (typeof GlossaryServer !== "undefined" && GlossaryServer.targetLanguage ? await GlossaryServer.targetLanguage().catch(() => "en") : "en");
    // saveUrl: where the result is kept when it is not where the text came from (a site chapter translated from its source site's original)
    const key = "translation:" + (job.saveUrl || job.url) + (lang && lang !== "en" ? "#lang=" + lang : "");
    const have = (await ext.storage.local.get(key))[key];
    if (have && have.translated && have.model !== "original" && !job.force) return { ok: true, skipped: true };
    // A chapter that is already English is not sent to the translator: its text is kept as it is, as the chapter's own copy, so it opens like any other.
    // (a re-fetch replaces it with the fresh text, still untranslated; only an asked-for re-translate goes to the translator)
    // (the same for any language the text is already in, the library's Translate into: Spanish text on a Spanish site into Spanish; English text into another language is translated)
    if (!job.retranslate && LangDetect.isLanguage(job.text, lang)) {
      await ext.storage.local.set({
        [key]: { translated: String(job.text), suggestions: [], savedAt: Date.now(), model: lang === "en" ? "english source" : "source in " + lang, pageTitle: job.pageTitle || "", novelName: job.novelName || "", ...(job.next ? { next: job.next } : {}) }
      });
      return { ok: true, english: true };
    }
    // Best effort, like the in-page translator: a library that is slow to answer just means the cached terms are used.
    await Promise.race([GlossaryServer.pull().catch(() => null), new Promise((r) => setTimeout(r, 2500))]);
    const glossary = await termsFor(job.url, job.saveUrl ? WtrTerms.bookOf(job.saveUrl) : undefined);
    // A chapter a watch fetched (job.watched), of a novel translated with a profile (profile-translate.js): its model and prompt, as the library's page would
    // translate it; a profile paid by the extension is this Gemini with the profile's prompt (below, as a Custom prompt).
    const profile = job.watched && typeof ProfileTranslate !== "undefined" ? await ProfileTranslate.forChapter(job.saveUrl || job.url) : null;
    if (profile && profile.pay !== "extension") {
      const r = await ProfileTranslate.translate(job, profile, lang === "en" ? glossary : await ProfileTranslate.languageGlossary(job.url, lang, job.saveUrl ? WtrTerms.bookOf(job.saveUrl) : undefined), lang);
      if (r.error) return r;
      await noteMentions(job, glossary, {}).catch(() => {});
      await ext.storage.local.set({
        [key]: { translated: r.text, suggestions: [], savedAt: Date.now(), model: profile.model + " (" + profile.name + ")", pageTitle: job.pageTitle || "", novelName: job.novelName || "", ...(job.next ? { next: job.next } : {}) }
      });
      return { ok: true, lang, profile: profile.name };
    }
    const { selectedModel } = await ext.storage.local.get("selectedModel");
    // The reader's Custom prompt: the prompt chosen and what goes with it.
    const custom = job.custom && job.custom.prompt ? { prompt: job.custom.prompt, notes: !!job.custom.notes, glossary: job.custom.glossary !== false } : profile ? ProfileTranslate.customOf(profile) : null;
    const response = await TermNotes.translate({ text: String(job.text).slice(0, MAX_CHARS), glossary, model: selectedModel, url: job.url, title: job.pageTitle, novelName: job.novelName, notes: job.notes, lang, english: !!job.english, ...(custom ? { custom } : {}) });
    if (!response || response.error) return { error: (response && response.error) || "no answer from Gemini" };
    await noteMentions(job, glossary, response).catch(() => {});
    // "English glossary" of the Custom prompt: your English fixes (your terms, "Xia Kingdom" -> "China") are done on the answer; none of them is sent to Gemini
    if (custom && job.custom && job.custom.replace && lang === "en") response.translated = WtrTerms.applyReplacements(response.translated, await replacementsFor(job.url));
    await ext.storage.local.set({
      [key]: {
        translated: response.translated,
        suggestions: response.suggestions || [],
        savedAt: Date.now(),
        model: response.model || null,
        pageTitle: job.pageTitle || "",
        novelName: job.novelName || "",
        ...(job.next ? { next: job.next } : {}) // where the next chapter is on the source site
      }
    });
    return { ok: true, lang };
  }

  // The site's "Raw" link (/api/serie/go-to-raw) redirects to the chapter on the source site. Which site that is, for a novel: the
  // host of where chapter 1 leads. One lookup per novel (the caller remembers it). Returns the host, or "" if it is not a site
  // this extension can read.
  // `slug`: the raw source the site names in the novel's page data (serie.raws[].slug), when the caller has it. That already says which site it is
  // without any request, so a source this extension cannot read (fanqienovel) is answered at once, and for a readable one only chapter 1's
  // address is looked up (the site stays known even if that lookup fails, say behind a Cloudflare check).
  async function rawSourceOf(rawId, lang, slug) {
    const none = { host: "", first: "" };
    if (!/^\d+$/.test(String(rawId)) || !/^[a-z-]{2,8}$/.test(String(lang))) return none;
    const named = slug ? RawSources.hostForSlug(slug) : "";
    if (slug && !named) return none;
    try {
      const lookup = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ translate: "ai", language: lang, raw_id: Number(rawId), chapter_no: 1, retry: false, force_retry: false })
      });
      const chapter = ((await lookup.json()) || {}).chapter;
      if (!lookup.ok || !chapter || !Number.isInteger(chapter.id)) return { host: named, first: "" };
      const res = await fetch("https://wtr-lab.com/api/serie/go-to-raw?id=" + chapter.id, { credentials: "include" }); // follows the redirect
      // a site that cannot be read but has a mirror (fanqienovel -> tomatomtl.com): chapter 1's address there
      const mirror = await RawSources.mirrorUrl(res).catch(() => null);
      if (mirror) return RawSources.ruleFor(mirror) ? { host: RawSources.hostOf(mirror), first: mirror } : { host: named, first: "" };
      try {
        if (res.body && res.body.cancel) await res.body.cancel(); // only the address is wanted, not the page
      } catch (e) {
        // already closed
      }
      // Where the link lands is chapter 1 itself on the source site: the same address a table of contents (what WebToEpub reads from a
      // book page) would list first, so a novel can be started without ever opening the source site.
      return RawSources.ruleFor(res.url) ? { host: RawSources.hostOf(res.url), first: res.url } : { host: named, first: "" };
    } catch (e) {
      if (named) return { host: named, first: "" };
      throw e;
    }
  }
  const rawHostOf = async (rawId, lang) => (await rawSourceOf(rawId, lang)).host;

  // The chapters of a novel read from a new source use the site glossary of that novel, like a glossary bound by hand
  // ("Use here" in the popup): bound once, never over a binding that already exists for that novel on that site.
  async function bindSource(url, wtrRawId) {
    if (!/^\d+$/.test(String(wtrRawId))) return;
    const id = "wtr-lab:" + wtrRawId;
    const key = WtrTerms.bindingKey(url);
    const { glossaryBindings } = await ext.storage.local.get("glossaryBindings");
    const have = WtrTerms.bindingIds((glossaryBindings || {})[key]);
    if (have.some((x) => !String(x).startsWith("adopted:"))) return; // (a glossary the pool's terms were kept in is not one the person chose)
    await GlossaryServer.setBinding(key, [...have, id]);
  }

  return { run, isEnglish: LangDetect.isEnglish, isLanguage: LangDetect.isLanguage, rawHostOf, rawSourceOf, bindSource };
})();
