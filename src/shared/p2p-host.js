// Runs the P2P core inside an extension page that is allowed to use WebRTC:
//   Firefox (MV2): the background page, which also has storage access -> "direct" adapter.
//   Chrome (MV3):  an offscreen document, which has NO chrome.storage -> "proxy" adapter that asks the
//                  service worker (background.js) to do storage calls and forwards cache writes back.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const PREFIX = "translation:";
  const CONFIG_KEYS = ["p2pEnabled", "p2pPassphrase", "p2pTrackers"];
  const INDEX_KEY = "p2pIndex";
  const direct = !!(ext.storage && ext.storage.local);
  // Every request in this page is to a novel site (or the site): the browser has to have allowed the site (site-access.js; the person's click in the popup). A site
  // not allowed yet is noted for the popup and refused here with an error that says so, instead of failing like a network error.
  const fetch = (url, options) => (typeof SiteAccess !== "undefined" ? SiteAccess.fetch(url, options) : globalThis.fetch(url, options));

  const log = (...a) => console.debug("[p2p]", ...a);
  if (typeof UserRules !== "undefined") UserRules.start(ext); // the rules the person added (this page has no storage in Chrome: it asks the service worker)

  function light(entry) {
    return { savedAt: (entry && entry.savedAt) || 0, translated: !!(entry && entry.translated) };
  }

  // (the index in parts: a change saves its part, not the whole index; P2PCore.bucketedIndex)
  const storedIndex = direct ? P2PCore.bucketedIndex({ get: (k) => ext.storage.local.get(k), set: (o) => ext.storage.local.set(o), remove: (k) => ext.storage.local.remove(k), base: INDEX_KEY }) : null;
  const directAdapter = {
    async getConfig() {
      const c = await ext.storage.local.get(CONFIG_KEYS);
      // the passphrase typed in the popup (none: only the library site's tab in this browser is reached)
      return { enabled: c.p2pEnabled !== false, passphrase: c.p2pPassphrase || "", trackers: c.p2pTrackers };
    },
    getIndex: () => storedIndex.getIndex(),
    setIndex: (index) => storedIndex.setIndex(index),
    putIndex: (changes) => storedIndex.putIndex(changes),
    async getTranslation(key) {
      return (await ext.storage.local.get(key))[key];
    },
    async setTranslation(key, entry) {
      await ext.storage.local.set({ [key]: entry });
    },
    async listTranslations() {
      const all = await ext.storage.local.get(null);
      return Object.keys(all)
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => [k, light(all[k])]);
    }
  };

  function call(op, ...args) {
    return ext.runtime.sendMessage({ target: "p2p-bg", op, args }).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r && r.result;
    });
  }
  const proxyAdapter = {
    getConfig: () => call("getConfig"),
    getIndex: () => call("getIndex"),
    setIndex: (i) => call("setIndex", i),
    putIndex: (c) => call("putIndex", c),
    getTranslation: (k) => call("getTranslation", k),
    setTranslation: (k, e) => call("setTranslation", k, e),
    listTranslations: () => call("listTranslations")
  };

  // ---------- original (untranslated) chapter text ----------
  // The site cannot download from a reader site (no CORS, and Cloudflare challenges anything but a real browser), but this extension
  // can: it runs in the browser that passed the challenge. The text is stored under "<chapter key>#original" so it never gets mistaken
  // for a translation of the chapter itself. Which sites can be read, and how, is in raw-sources.js.
  const inflight = new Set();
  // One download at a time with a pause between them (the sources ask for a gentle pace), so asking for a few chapters stays polite.
  let lastFetch = Promise.resolve();
  const RAW_GAP_MS = 1000;
  const MAX_PARTS = 12; // some sites split a chapter into several pages
  const turn = (gap) => {
    const mine = lastFetch.then(() => new Promise((r) => setTimeout(r, gap || RAW_GAP_MS)));
    lastFetch = mine.catch(() => {});
    return mine;
  };

  // A source site's page. A site behind a bot check (Cloudflare) answers the extension's own request with HTTP 403. When the browser has passed the check, the
  // pass is often kept where only the site's own pages send it: it is brought over (BookVisit.bringPass, what WebToEpub does) and the request made again, with
  // no tab at all. When there is no pass yet, the page is asked for from inside a tab of the site (BookVisit.fetchIn: the tab opens in the background, the person
  // may be asked to tick a box in it; passing brings the pass over too, so the requests after it are the extension's own again). A site that refuses even then
  // has its pages asked for through its tab for the next half hour, without asking in vain first. onCheck is told when a tab is needed. A 403 that nothing got
  // round comes back with why (res.refusal).
  const VIA_TAB_MS = 30 * 60 * 1000;
  const TAB_AGAIN_MS = 2 * 60 * 1000;
  const viaTab = new Map(); // host -> until when its pages are asked for through its tab
  const tabHelped = new Map(); // host -> when its tab last got a page the extension was refused
  const bringPass = (url) => Promise.resolve(direct && typeof BookVisit !== "undefined" ? BookVisit.bringPass(url) : ext.runtime.sendMessage({ type: "site:pass", url })).then((r) => !!(r && r.copied), () => false);
  const bytesOf = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  // { res } (what fetch would have given, as far as the readers here use it) or { error }
  async function tabFetch(url) {
    const r = await Promise.resolve(direct && typeof BookVisit !== "undefined" ? BookVisit.fetchIn(url) : ext.runtime.sendMessage({ type: "site:fetch", url })).catch((e) => ({ ok: false, error: e && e.message }));
    if (!r || !r.ok || typeof r.status !== "number") return { error: (r && r.error) || "the site's tab did not answer" };
    const bytes = bytesOf(r.body || "");
    const type = r.type || "";
    return { res: { ok: r.status >= 200 && r.status < 300, status: r.status, url: r.url || url, headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? type : null) }, arrayBuffer: async () => bytes.buffer, text: async () => new TextDecoder().decode(bytes) } };
  }
  async function fetchSite(url, options, onCheck) {
    const host = RawSources.hostOf(url);
    if ((viaTab.get(host) || 0) > Date.now()) {
      const got = await tabFetch(url);
      if (got.res) return got.res;
      viaTab.delete(host); // the tab did not help this time: the extension asks by itself again
    }
    const res = await fetch(url, options);
    if (res.status !== 403) return res;
    if (await bringPass(url)) {
      const again = await fetch(url, options); // the browser had passed the check: with the pass, the site answers
      if (again.status !== 403) return again;
    }
    if (onCheck) await onCheck();
    const got = await tabFetch(url);
    if (got.res) {
      // (the tab passed the check and the pass came over: the next request is the extension's own again. Refused again so soon, the tab it is.)
      if (Date.now() - (tabHelped.get(host) || 0) < TAB_AGAIN_MS) viaTab.set(host, Date.now() + VIA_TAB_MS);
      tabHelped.set(host, Date.now());
      return got.res;
    }
    res.refusal = got.error;
    return res;
  }
  const said = (res) => "HTTP " + res.status + (res.refusal ? " (" + res.refusal + ")" : "");

  // The text of a chapter, from the response for its first page; follows the "next part" links of sites that split chapters.
  async function readChapter(res) {
    const parts = [];
    let next = null; // the next chapter, from the last part's own link
    let url = res.url;
    const rule = RawSources.ruleFor(url);
    if (!rule) throw new Error("the source is " + (RawSources.hostOf(url) || "unknown") + ", which this extension cannot read yet");
    for (let n = 0; n < MAX_PARTS; n++) {
      if (!res.ok) throw new Error(said(res));
      const html = RawSources.decode(new Uint8Array(await res.arrayBuffer()), res.headers && res.headers.get && res.headers.get("content-type"), rule);
      if (rule.fromHtml) { // the text is not in the page's elements (encrypted, built by a script): the rule reads it from the HTML itself
        const read = await rule.fromHtml(html, url);
        if (!read || !read.text) throw new Error("no chapter text on the page (is this browser signed in to " + RawSources.hostOf(url) + "? open the chapter there once)");
        return { text: read.text, next: read.next || null };
      }
      const doc = new DOMParser().parseFromString(RawSources.stripScripts(html), "text/html");
      const text = RawSources.textOf(doc, rule);
      if (!text) {
        if (!parts.length) throw new Error("no chapter text on the page (open it once in the browser to pass the site's check)");
        break;
      }
      parts.push(text);
      const part = RawSources.nextPart(doc, url, rule);
      if (!part || !RawSources.ruleFor(part)) {
        next = RawSources.nextChapter(doc, url);
        break;
      }
      await turn();
      res = await fetchSite(part, { credentials: "include" });
      url = res.url || part;
    }
    return { text: parts.join("\n"), next };
  }

  // When a chapter is asked for together with the ones after it, the next one is requested here, as soon as this one has told us where it
  // is. Its title is only a number until it has been read ("Chapter 3: X" -> "Chapter 4").
  function askAhead(next, meta) {
    if (!next || !(meta.ahead > 0)) return;
    const n = /(\d+)/.exec(meta.pageTitle || "");
    const nextMeta = { ...meta, ahead: meta.ahead - 1, pageTitle: n ? (meta.pageTitle || "").replace(/^(\D*)\d+.*$/, "$1" + (Number(n[1]) + 1)) : "" };
    if (Number.isFinite(meta.notes)) nextMeta.notes = Math.max(0, meta.notes - 1); // the notes reach as far as they were asked for
    saveOriginal("translation:" + next + "#original", nextMeta).catch((e) => log("chapter ahead failed", next, e && e.message));
  }

  // A chapter of a site novel, read from the novel's own source site: the site's "Raw" link (/api/serie/go-to-raw) redirects to
  // that chapter on the source site. This extension runs in the browser that is signed in to the site, so it follows the link,
  // keeps the page's original text under "<source chapter key>#original" (what is sent to Gemini; "Show original text" on the site),
  // and translates it with your terms and the novel's site glossary. The result is saved as that source's own chapter, named
  // like the site one so the two line up by chapter number. Only done when someone asks for that source.
  const WTR_KEY = /^translation:https:\/\/wtr-lab\.com\/([a-z-]{2,8})\/novel\/(\d+)\/[^/?#]+\/chapter-(\d+)#original$/;
  // The site's own text of a chapter: the page's reader loads it from /api/reader/get -> content_url, with the site's glossary terms as
  // numbered placeholders ("※0⛬" is terms[0]'s English; WebToEpub's WtrlabParser does the same). Saved under the chapter's own the site
  // address, exactly like a chapter captured while reading on the site. One chapter, only when someone opens it (never ahead).
  const WTR_OWN = "wtr-lab.com";
  async function saveWtrOwn(key, meta) {
    const m = WTR_KEY.exec(key);
    const [, lang, rawId, chapterNo] = m;
    const ownKey = key.replace(/#original$/, "");
    const store = direct ? directAdapter : proxyAdapter;
    inflight.add(key);
    try {
      const existing = await store.getTranslation(ownKey);
      if (existing && existing.translated) return report(key, "done", meta);
      report(key, "queued", meta);
      await turn();
      report(key, "downloading", meta);
      const lookup = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ translate: "ai", language: lang, raw_id: Number(rawId), chapter_no: Number(chapterNo), retry: false, force_retry: false })
      });
      // What the site answered, said as it is: a browser that has never opened the site (a new profile) is often stopped by its bot check
      // (an HTML page, not JSON) until the site is opened in it once.
      const found = await lookup.json().catch(() => null);
      if (!found) throw new Error("The site did not answer as it should (HTTP " + lookup.status + "): open the site once in the browser that has this extension, then try again");
      // (as WebToEpub's WtrlabParser reads them: its bot check, after too many chapters too fast; a chapter the site has not translated)
      if (found.requireTurnstile || Number(found.code) === 1401) throw new Error("The site asks for its Turnstile check (too many chapters too fast): open a chapter on the site in this browser and pass it");
      if (found.code === "CHAPTER_LOCKED") throw new Error("chapter " + chapterNo + " is not AI-translated on the site yet (it answered CHAPTER_LOCKED)");
      if (!lookup.ok || !found.content_url || !/^\/api\//.test(found.content_url)) {
        const why = String(found.error || found.message || (found.data && found.data.message) || "").slice(0, 200);
        throw new Error("The site gave no text for chapter " + chapterNo + (why ? ": " + why : " (HTTP " + lookup.status + ")") + ". If the site was never opened in the browser that has this extension, open it once and try again");
      }
      const res = await fetch("https://wtr-lab.com" + found.content_url, { credentials: "include" });
      const data = (((await res.json()) || {}).data || {}).data;
      if (!res.ok || !data || !Array.isArray(data.body)) throw new Error("The site did not give this chapter's text");
      const terms = (data.glossary_data && data.glossary_data.terms) || [];
      const fill = (line) => {
        let t = String(line);
        terms.forEach((term, i) => { t = t.split("※" + i + "⛬").join(term[0] || "").split("※" + i + "〓").join(term[0] || ""); });
        for (const p of data.patch || []) if (p && p.zh) t = t.split(p.zh).join(" " + (p.en || ""));
        return t.trim();
      };
      let lines = data.body.filter((l) => l !== "[image]").map(fill).filter(Boolean);
      // The site's title is sometimes not one (a copy of the first paragraph): then the chapter has none, and the library's list names it
      const named = fill(data.title || "");
      const hasTitle = /^Chapter\s+\d+/i.test(named) && named.length <= 200;
      const title = hasTitle ? named : "Chapter " + chapterNo;
      while (hasTitle && lines.length && (lines[0] === named || /^Chapter\s+\d+/i.test(lines[0]))) lines = lines.slice(1); // the title is not a paragraph
      if (!lines.length) throw new Error("The site's text for this chapter is empty");
      await store.setTranslation(ownKey, {
        translated: lines.join("\n"),
        suggestions: [],
        savedAt: Date.now(),
        model: "wtr-lab" + (data.model ? " · " + data.model : ""),
        pageTitle: title,
        novelName: meta.novelName
      });
      report(key, "done", meta);
    } catch (e) {
      log("The site chapter failed", key, e && e.message);
      report(key, "failed", meta, e && e.message);
      throw e;
    } finally {
      inflight.delete(key);
    }
  }

  // A site novel's whole chapter list from one request, /api/chapters/<id> (WebToEpub's getChapterUrls reads the same): [[number, English
  // title, address, original title]] in order. Needs only the novel's id; the slug is for the addresses.
  async function wtrChapterList(lang, rawId, slug) {
    await turn();
    const res = await fetch("https://wtr-lab.com/api/chapters/" + rawId, { credentials: "include" });
    if (!res.ok) throw new Error("The site answered HTTP " + res.status);
    const list = (((await res.json().catch(() => null)) || {}).chapters || []).slice(0, 10000);
    const base = "https://wtr-lab.com/" + lang + "/novel/" + rawId + "/" + slug + "/chapter-";
    const chapters = list
      .filter((c) => c && Number.isInteger(c.order) && c.order >= 0 && typeof c.title === "string")
      .map((c) => [c.order, c.title.trim().slice(0, 300), base + c.order, String(c.name || "").trim().slice(0, 300)])
      .sort((a, b) => a[0] - b[0]);
    if (!chapters.length) throw new Error("The site returned no chapters");
    return chapters;
  }

  // The library asked for this novel's chapter list now (a new chapter came out, or the list was never read): it goes to the library
  // as the novel's chapter index, where every device's library reads it. Asked by a person (the novel page's "Refresh chapters", or Next
  // at the end of the known list), never on a timer.
  async function refreshWtrList(key, meta) {
    const m = WTR_KEY.exec(key);
    const [, lang, rawId] = m;
    const slug = /\/novel\/\d+\/([^/?#]+)/.exec(key)[1];
    inflight.add(key);
    try {
      report(key, "downloading", meta);
      const chapters = await wtrChapterList(lang, rawId, slug);
      const record = { key: "wtr-lab:" + rawId, source: "wtr-lab", url: "https://wtr-lab.com/" + lang + "/novel/" + rawId + "/" + slug, chapters };
      const reply = await Promise.resolve(direct ? GlossaryServer.saveChapterIndex(record) : ext.runtime.sendMessage({ type: "chapterindex:save", record }));
      if (!reply || !reply.ok) throw new Error("the library did not take the chapter list" + (reply && reply.error ? " (" + reply.error + ")" : ""));
      report(key, "done", meta);
    } catch (e) {
      log("chapter list failed", key, e && e.message);
      report(key, "failed", meta, e && e.message);
      throw e;
    } finally {
      inflight.delete(key);
    }
  }

  // The source site a site novel's "Raw" link leads to, as the library knows it (the novel's rawHost, kept when its details were read), or "".
  async function rawHostOf(rawId, meta) {
    if (meta && meta.source && meta.source !== WTR_OWN) return meta.source;
    const id = "wtr-lab:" + rawId;
    const novel = await Promise.resolve(direct ? GlossaryServer.getNovel(id) : ext.runtime.sendMessage({ type: "novel:get", id }).then((r) => (r && r.novel) || null)).catch(() => null);
    return (novel && novel.rawHost) || "";
  }

  async function saveWtrSource(key, meta) {
    const m = WTR_KEY.exec(key);
    if (!m || inflight.has(key)) return;
    if (meta.findNext) return refreshWtrList(key, meta); // for a site chapter, "find the next chapter" is: read the novel's list again
    if (meta.source === WTR_OWN) return saveWtrOwn(key, meta);
    const [, lang, rawId, chapterNo] = m;
    const store = direct ? directAdapter : proxyAdapter;
    // Into another language than English the result is a version of the site chapter itself ("<its key>#lang=<code>"), listed with it: the source site's own
    // copy is another book's chapter, which the site chapter's page would not find. (English keeps being the source's own copy.) The text is the source's
    // original, translated with the novel's glossary; when the source cannot be read, the chapter's own English text is translated instead.
    const target = await langOf(meta);
    const ownKey = key.replace(/#original$/, "");
    const ownUrl = target !== "en" ? ownKey.replace(/^translation:/, "") : undefined;
    inflight.add(key);
    try {
      if (ownUrl && !meta.force && !meta.retranslate) {
        const have = await store.getTranslation(withLang(ownKey, target));
        if (have && have.translated) return report(key, "done", meta);
      }
      report(key, "queued", meta);
      await turn();
      report(key, "downloading", meta);
      const lookup = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ translate: "ai", language: lang, raw_id: Number(rawId), chapter_no: Number(chapterNo), retry: false, force_retry: false })
      });
      const chapter = ((await lookup.json()) || {}).chapter;
      if (!lookup.ok || !chapter || !Number.isInteger(chapter.id)) throw new Error("The site did not give this chapter's id");
      // follows the redirect; the browser refuses (a bare "Failed to fetch") when it leads to a site this extension has no permission for
      const rawLink = "https://wtr-lab.com/api/serie/go-to-raw?id=" + chapter.id;
      let res = await fetchSite(rawLink, { credentials: "include" }).catch(async (e) => {
        // (a bare "Failed to fetch" is usually the browser refusing the redirect to a site this extension may not read yet: when the novel's source site is known and not
        // allowed, that is said, and noted for the popup's Allow, rather than a bot check that was never the trouble)
        const host = await rawHostOf(rawId, meta);
        if (host && typeof SiteAccess !== "undefined") await SiteAccess.guard("https://" + host + "/");
        throw new Error("could not follow the site's Raw link" + (e && e.message ? " (" + e.message + ")" : "") + ". The site it leads to may be showing a Cloudflare check, may not be supported, or did not answer. Open " + rawLink + " once in this browser (it passes the check), then try again");
      });
      // a novel of a site that cannot be read but has a mirror (fanqienovel -> tomatomtl.com): the mirror's page for the same chapter
      const mirror = await RawSources.mirrorUrl(res);
      if (mirror) {
        await turn();
        res = await fetchSite(mirror, { credentials: "include" });
      }
      const sourceUrl = mirror || res.url;
      // no site named (the novel's source is not known yet): whichever site the Raw link leads to, if it can be read
      if (meta.source ? RawSources.hostOf(sourceUrl) !== meta.source : !RawSources.ruleFor(sourceUrl)) throw new Error("this chapter's source is " + (RawSources.hostOf(sourceUrl) || "unknown") + (meta.source ? ", not " + meta.source : ", which this extension cannot read"));
      const sourceKey = "translation:" + sourceUrl;
      // already translated from that source (maybe by another device): nothing to do
      const existing = ownUrl ? null : await store.getTranslation(sourceKey);
      if (existing && existing.translated && existing.model !== "original") return report(key, "done", meta, undefined, sourceUrl);
      let raw = await store.getTranslation(sourceKey + "#original");
      if (!raw || !raw.translated) {
        const read = await readChapter(res);
        raw = { translated: read.text, suggestions: [], savedAt: Date.now(), model: "original", pageTitle: meta.pageTitle, novelName: meta.novelName, next: read.next || undefined };
        await store.setTranslation(sourceKey + "#original", raw);
      } else if (res.body && res.body.cancel) {
        res.body.cancel().catch(() => {});
      }
      // the new source's chapters use the novel's site glossary, as if you had pressed "Use here" for it
      const bind = direct ? OriginalTranslate.bindSource(sourceUrl, rawId) : ext.runtime.sendMessage({ type: "wtr:bindsource", url: sourceUrl, rawId });
      Promise.resolve(bind).catch((e) => log("could not bind the glossary", e && e.message));
      queueTranslation(key, sourceUrl, raw.translated, { ...meta, next: raw.next, lang: target, ...(ownUrl ? { saveUrl: ownUrl } : {}) });
      askAhead(raw.next, meta);
    } catch (e) {
      // (into another language, with the source out of reach: its bot check, no chapter there: the site's own English text of the chapter is translated)
      if (ownUrl) {
        const english = await store.getTranslation(ownKey).catch(() => null);
        if (english && english.translated) {
          log("source chapter not read, translating the chapter's English instead", key, e && e.message);
          queueTranslation(key, ownUrl, english.translated, { ...meta, lang: target, saveUrl: ownUrl, english: true, next: undefined });
          return;
        }
      }
      log("source chapter failed", key, e && e.message);
      report(key, "failed", meta, e && e.message);
      throw e; // the core tells the device that asked
    } finally {
      inflight.delete(key);
    }
  }

  // Translating goes through the background script (Gemini, your terms, the novel's bound glossaries), one chapter at a time in the
  // order they were asked for. The result is saved as the chapter's normal translation, which then syncs like any other.
  // (a chapter in another language than English is its own entry, "<chapter key>#lang=<code>": a version of the same chapter, translated apart)
  const translating = new Set();
  let lastTranslation = Promise.resolve();
  const withLang = (key, lang) => key + (lang && lang !== "en" ? "#lang=" + lang : "");
  // The language a chapter asked for is translated into: the one the request says, else the library's
  async function langOf(meta) {
    if (meta && meta.lang) return meta.lang;
    try {
      return direct ? await GlossaryServer.targetLanguage() : ((await ext.runtime.sendMessage({ type: "target:language" })) || {}).lang || "en";
    } catch (e) {
      return "en";
    }
  }
  function queueTranslation(key, url, text, meta) {
    const tk = withLang(meta.saveUrl || url, meta.lang);
    if (translating.has(tk)) return;
    translating.add(tk);
    const job = { url, text, pageTitle: meta.pageTitle, novelName: meta.novelName, next: meta.next, force: !!meta.force, retranslate: !!meta.retranslate, ...(meta.lang ? { lang: meta.lang } : {}), ...(meta.saveUrl ? { saveUrl: meta.saveUrl } : {}), ...(meta.english ? { english: true } : {}), ...(Number.isFinite(meta.notes) ? { notes: meta.notes } : {}), ...(meta.custom ? { custom: meta.custom } : {}), ...(meta.watched ? { watched: true } : {}) };
    report(key, "translate-queued", meta);
    lastTranslation = lastTranslation
      .then(() => {
        report(key, "translating", meta);
        return direct ? OriginalTranslate.run(job) : ext.runtime.sendMessage({ type: "original:translate", job });
      })
      .then((r) => {
        if (r && r.error) { log("translation failed", url, r.error); report(key, "failed", meta, r.error); if (meta.watched) untranslated.set(key, { error: String(r.error), stop: !!r.stop }); }
        else { report(key, "done", meta, undefined, meta.saveUrl ? undefined : url); untranslated.delete(key); }
      })
      .catch((e) => { log("translation failed", url, e && e.message); report(key, "failed", meta, e && e.message); if (meta.watched) untranslated.set(key, { error: String((e && e.message) || e) }); })
      .finally(() => translating.delete(tk));
  }
  // Gemini's notes on terms, alone, for a chapter that is already English ("<chapter key>#notes", from the library's reader): taken in the same line
  // as the translations, so a novel's notes are made in the order its chapters were asked for.
  async function queueNotes(key, meta) {
    const url = key.replace(/^translation:/, "").replace(/#notes$/, "");
    if (translating.has(key)) return;
    const store = direct ? directAdapter : proxyAdapter;
    const entry = await store.getTranslation("translation:" + url);
    if (!entry || !entry.translated || entry.model === "original") throw new Error("this chapter's English text is not on this device");
    translating.add(key);
    const job = { url, title: entry.pageTitle || meta.pageTitle, text: entry.translated, novelName: meta.novelName || entry.novelName, ...(Number.isFinite(meta.notes) ? { notes: meta.notes } : {}), force: !!meta.force, ...(meta.custom ? { custom: meta.custom } : {}) };
    report(key, "notes-queued", meta);
    lastTranslation = lastTranslation
      .then(() => {
        report(key, "writing-notes", meta);
        return direct ? TermNotes.notesOnly(job) : ext.runtime.sendMessage({ type: "original:notes", job });
      })
      .then((r) => {
        if (r && r.error) { log("notes failed", url, r.error); report(key, "failed", meta, r.error); }
        else report(key, "done", meta, undefined, undefined, r && r.skipped ? r.skipped : r && r.saved ? r.saved + " notes" : "no change");
      })
      .catch((e) => { log("notes failed", url, e && e.message); report(key, "failed", meta, e && e.message); })
      .finally(() => translating.delete(key));
    // the chapters after it too, as far as asked (the popup's "Gemini notes" for the next ones): those of them translated here
    if (meta.ahead > 0 && entry.next) queueNotes("translation:" + entry.next + "#notes", { ...meta, ahead: meta.ahead - 1, pageTitle: "" }).catch((e) => log("notes ahead stopped", entry.next, e && e.message));
  }

  // Lets the device that asked (the site) show what the extension is doing with each chapter.
  // `url`: where the finished chapter is saved, when that is not the key (a site chapter read from its source site), so the asker can open it
  // `note`: a few words on how far along it is ("list page 12 of 80"), shown next to the state
  const report = (key, state, meta, error, url, note) => core.announceRaw(key, state, { pageTitle: meta && meta.pageTitle, error, url, note });

  // Lists the library said to stop reading (its "Stop" button, while a list that runs over many pages is being read): the reader looks here before
  // each page, and ends with "stopped". What it has read by then is kept, like a list that failed part way.
  const stopped = new Set();
  const STOPPED = "stopped";

  // The library asked for a source site's chapter list now ("<a chapter's address>#list"): read the list page once, number the chapters by their
  // place in it, and hand it over like the first look of a watch does (titles in English, saved as the novel's chapter list, nothing announced
  // as new). Asked by a person (opening a novel with no list yet, or "Refresh chapters"), never on a timer.
  async function refreshSourceList(key, meta) {
    const chapterUrl = key.replace(/^translation:/, "").replace(/#list$/, "");
    const toc = RawSources.tocFor(chapterUrl);
    if (!toc) throw new Error((RawSources.hostOf(chapterUrl) || "that site") + " has no chapter list reader in this extension");
    if (inflight.has(key)) {
      stopped.delete(key); // asked for again while it is being read: a stop that has not been acted on yet is taken back
      return;
    }
    inflight.add(key);
    let saving = Promise.resolve(); // the saves of the list so far, one after the other
    try {
      report(key, "downloading", meta, undefined, undefined, "reading the list");
      const watch = { source: RawSources.hostOf(chapterUrl), novel: "", known: 0 }; // known 0: a baseline, so nothing is announced
      const apply = (f) => Promise.resolve(direct ? Watcher.apply(watchDeps, watch, f, Date.now()) : ext.runtime.sendMessage({ type: "list:apply", watch, found: f }));
      // A list over many pages is saved as it grows (with the site's own titles, every couple of seconds, without holding up the next page), so the
      // library shows chapters while it is still being read; and when it fails part way, what was read is kept (see the catch below).
      let savedAt = 0;
      let savedCount = 0;
      const chapters = await readList(toc, chapterUrl, async (p) => {
        report(key, "downloading", meta, undefined, undefined, "list page " + p.done + " of " + p.total + " · " + p.count + " chapters" + (p.wait ? " · the site asked to wait, " + p.wait + "s" : "") + (p.check ? " · the site is checking the browser: a tab of the site opened (tick its box if it asks)" : ""));
        if (p.wait || p.check || p.done >= p.total || Date.now() - savedAt < LIST_SAVE_MS) return;
        const part = p.partial();
        if (part.length <= savedCount) return; // (a newest-first list has nothing to show until its second page is in)
        savedAt = Date.now();
        savedCount = part.length;
        const found = { kind: "toc", tocUrl: part.tocUrl || chapterUrl, chapters: part.map((c) => [c.num, c.title, c.url]), quick: true };
        saving = saving.then(() => apply(found)).then((reply) => { if (reply && reply.error) log("partial chapter list not saved", chapterUrl, reply.error); }, () => {});
      }, () => stopped.has(key));
      await saving; // (so a partial list can never land after the whole one)
      if (!chapters.length) throw new Error("the chapter list page had no chapters");
      const found = { kind: "toc", tocUrl: chapters.tocUrl, chapters: chapters.map((c) => [c.num, c.title, c.url]) };
      // first with the site's own titles, so the list is in the library at once; then again with the titles translated (minutes for a long list)
      const reply = await apply({ ...found, quick: true });
      if (reply && reply.error) throw new Error(reply.error);
      report(key, "done", meta);
      apply(found).then((r) => { if (r && r.error) log("chapter list titles not translated", chapterUrl, r.error); }, (e) => log("chapter list titles not translated", chapterUrl, e && e.message));
    } catch (e) {
      log("chapter list failed", key, e && e.message);
      let message = e && e.message;
      await saving;
      if (e && e.partial && e.partial.length) {
        // what was read before it failed is still the start of the list: keep it, so the library shows it
        const watch = { source: RawSources.hostOf(chapterUrl), novel: "", known: 0 };
        const found = { kind: "toc", tocUrl: e.partial.tocUrl || chapterUrl, chapters: e.partial.map((c) => [c.num, c.title, c.url]), quick: true };
        const saved = await Promise.resolve(direct ? Watcher.apply(watchDeps, watch, found, Date.now()) : ext.runtime.sendMessage({ type: "list:apply", watch, found })).catch(() => null);
        if (saved && !saved.error) message += " (the " + e.partial.length + " chapters read so far are in the library; refresh again to read the rest)";
      }
      report(key, "failed", meta, message);
      throw e;
    } finally {
      inflight.delete(key);
      stopped.delete(key);
    }
  }

  // ---------- a novel's details and cover, read again ----------
  // The library asked for a book's details now ("<the book's address>#details"): its page is read again, the way the recording script does when you open
  // it, and the result is kept as the novel's record in the library (title, author, cover, synopsis, genres; titles in English). A person
  // asks by pressing "Refresh details" on the novel's page.

  // The titles and the synopsis in English (one batch, as the library's setting says: translateByMode; what cannot be translated stays as it is).
  async function englishOf(texts) {
    const usable = (r) => r && Array.isArray(r.texts) && r.texts.length === texts.length;
    const reply = await (direct && typeof translateByMode === "function" ? translateByMode(texts, "book").then((t) => ({ texts: t }), () => null) : ext.runtime.sendMessage({ type: "translateBook", texts }).catch(() => null));
    return usable(reply) ? reply.texts : texts;
  }

  // A book on a source site, from its page: the page's standard metadata completed through the site's selectors (the built-in ones fill what it
  // leaves empty, the person's own picks win), or the selectors alone for a page with no metadata.
  async function sourceDetails(url) {
    if (typeof BookCapture === "undefined") throw new Error("this extension build cannot read book pages");
    // (a site with only book parts saved for it, from "Detect with AI" on its book's page, has no chapter rule but is read for its details all the same)
    const rule = RawSources.ruleFor(url);
    const hasBook = typeof UserRules !== "undefined" && !!UserRules.bookTable(UserRules.current())[RawSources.hostOf(url)];
    if (!rule && !hasBook) throw new Error((RawSources.hostOf(url) || "that site") + " is not a site this extension reads (add a rule for it from its popup first)");
    await turn();
    let res = null;
    try {
      res = await fetch(url, { credentials: "include" });
    } catch (e) {
      res = null; // (a bare network failure: the site may refuse requests that are not a page visit)
    }
    if (!res || res.status === 403 || res.status === 429 || res.status === 503) {
      // A site that refuses the extension's own request (a bot check answers 403) still answers the browser's: the page is opened in a background tab and the
      // recording script records the book there, then the tab is closed. The record, and the cover copy, are made by that script.
      log("details: the site refused the request, visiting the page instead", url, res && res.status);
      const reply = await Promise.resolve(direct && typeof BookVisit !== "undefined" ? BookVisit.visit(url).then((r) => r, (e) => ({ error: e.message })) : ext.runtime.sendMessage({ type: "book:visit", url }));
      if (!reply || !reply.ok) throw new Error((res ? "the site answered HTTP " + res.status : "the site could not be reached") + "; opening the page instead did not work either" + (reply && reply.error ? " (" + reply.error + ")" : ""));
      return { recorded: true, cover: reply.cover || null };
    }
    if (!res.ok) throw new Error("the site answered HTTP " + res.status);
    const html = RawSources.decode(new Uint8Array(await res.arrayBuffer()), res.headers && res.headers.get && res.headers.get("content-type"), rule);
    const at = res.url || url;
    const doc = new DOMParser().parseFromString(RawSources.stripScripts(html), "text/html");
    const host = RawSources.hostOf(at);
    const base = RawSources.rawRule(host);
    const builtin = (base && base.book) || null;
    const mine = typeof UserRules !== "undefined" ? UserRules.bookTable(UserRules.current())[host] || null : null;
    const together = { selector: (mine && mine.selector) || (rule && rule.selector), book: { ...(builtin || {}), ...((mine && mine.book) || {}) }, fallback: builtin };
    const book = BookCapture.fillGaps(BookCapture.readBook(doc, at), doc, at, builtin, mine && mine.book) || BookCapture.readBookByRule(doc, at, together);
    if (!book) throw new Error("this page does not look like a book's page (it needs a title and an author, a cover or a synopsis)");
    return BookCapture.toNovelInfo(book, await englishOf(BookCapture.textsOf(book)));
  }

  // A site novel, from the page data the site itself serves (the build id is in the novel's page, the data file is named from it).
  async function wtrDetails(url) {
    const found = typeof WtrTerms !== "undefined" ? WtrTerms.parseWtrUrl(url) : null;
    if (!found || !found.slug) throw new Error("that is not the address of a site novel");
    const lang = new URL(url).pathname.split("/")[1] || "en";
    const site = "https://wtr-lab.com/" + lang;
    await turn();
    const page = await fetch(site + "/novel/" + found.rawId + "/" + found.slug, { credentials: "include" });
    if (!page.ok) throw new Error("The site answered HTTP " + page.status);
    const build = /"buildId":"([^"]+)"/.exec(await page.text());
    if (!build) throw new Error("The site's page did not name its data (it may have changed)");
    await turn();
    const res = await fetch("https://wtr-lab.com/_next/data/" + build[1] + "/" + lang + "/novel/" + found.rawId + "/" + found.slug + ".json?locale=" + lang + "&raw_id=" + found.rawId + "&serie_slug=" + found.slug, { credentials: "include" });
    if (!res.ok) throw new Error("The site's data answered HTTP " + res.status);
    const novel = WtrTerms.toNovelInfo(await res.json(), found.rawId, found.slug, site);
    if (!novel) throw new Error("The site's data had no novel in it");
    // The site the site's "Raw" link leads to is named in the same data; chapter 1's address needs a lookup, and what the record already knows is kept if it fails
    const lookup = await Promise.resolve(direct ? OriginalTranslate.rawSourceOf(found.rawId, lang, novel.rawSlug) : ext.runtime.sendMessage({ type: "wtr:rawhost", rawId: found.rawId, lang, slug: novel.rawSlug })).catch(() => null);
    const before = await Promise.resolve(direct ? GlossaryServer.getNovel(novel.id) : ext.runtime.sendMessage({ type: "novel:get", id: novel.id }).then((r) => (r && r.novel) || null)).catch(() => null);
    delete novel.rawSlug;
    novel.rawHost = (lookup && lookup.host) || (before && before.rawHost) || undefined;
    novel.rawFirst = (lookup && lookup.first) || (before && before.rawFirst) || undefined;
    return novel;
  }

  async function refreshBookDetails(key, meta) {
    const url = key.replace(/^translation:/, "").replace(/#details$/, "");
    if (inflight.has(key)) return;
    inflight.add(key);
    try {
      report(key, "downloading", meta, undefined, undefined, "reading the book's page");
      const info = RawSources.hostOf(url) === "wtr-lab.com" ? await wtrDetails(url) : await sourceDetails(url);
      // what became of the cover, said with "done": a copy is kept in your library, whatever the setting says, since
      // the details were asked for now; a site that refuses the download leaves the cover as its address, and says why
      const coverNote = (c) => (!c ? "" : c.ok ? "cover copied" : "cover not copied: " + String(c.error || "it could not be had").slice(0, 80));
      if (info.recorded) { // the page was visited, and the recording script kept the record (and the cover's copy) itself
        report(key, "done", meta, undefined, undefined, coverNote(info.cover));
        return;
      }
      const saved = await Promise.resolve(direct ? GlossaryServer.saveNovel(info) : ext.runtime.sendMessage({ type: "novel:save", info }));
      if (!saved || !saved.ok) throw new Error("the library did not take the details" + (saved && saved.error ? " (" + saved.error + ")" : ""));
      let copied = null;
      if (info.cover) {
        copied = await Promise.resolve(direct ? GlossaryServer.copyCover(info.id, info.cover, null, { force: true }) : ext.runtime.sendMessage({ type: "cover:copy", id: info.id, url: info.cover, force: true })).catch((e) => ({ ok: false, error: e.message }));
        if (copied && !copied.ok) log("cover not copied", info.id, copied.error);
      }
      report(key, "done", meta, undefined, undefined, coverNote(copied));
    } catch (e) {
      log("book details failed", key, e && e.message);
      report(key, "failed", meta, e && e.message);
      throw e;
    } finally {
      inflight.delete(key);
    }
  }

  // ---------- what this extension does for your other devices ----------
  // Another device of your library may ask it for chapters (their original text and those ahead, a chapter list, a book's details: "fetch") and for
  // translations with this extension's Gemini ("translate"). Each is done only once switched on in this browser (the site's Settings › Library:
  // helpDevices, kept in this extension and not in the library, so another device cannot switch it on). The library's tab in this browser, and this
  // extension's own work (its watches, its popup, the editions of your novels), are not held to them; neither is sync.
  const HELP_KEY = "helpDevices";
  const helpOf = (v) => ({ fetch: !!(v && v.fetch), translate: !!(v && v.translate) });
  const getHelp = async () => helpOf(direct ? (await ext.storage.local.get(HELP_KEY))[HELP_KEY] : await call("getHelp"));
  async function setHelp(v) {
    const h = helpOf(v);
    if (direct) await ext.storage.local.set({ [HELP_KEY]: h });
    else await call("setHelp", h);
    return h;
  }
  async function deviceName() {
    try {
      const lib = typeof LibraryHost !== "undefined" ? await LibraryHost.ready : null;
      const me = lib && lib.status().device;
      return (me && me.name) || "your computer";
    } catch (e) {
      return "your computer";
    }
  }
  const declined = (why) => Object.assign(new Error(why), { declined: true });
  const notFetching = (name) => "The extension on " + name + " doesn't fetch chapters for your other devices: switch it on in Settings › Library in that browser";
  const notTranslating = (name) => "The extension on " + name + " doesn't translate for your other devices: switch it on in Settings › Library in that browser";
  // A request from another device, as far as this extension does it for them: -> the request to do (with only translating off, a chapter's text is still
  // fetched, and the asker told it is not translated: from.decline); throws a declined error when none of it is done.
  async function forOtherDevice(key, meta, from) {
    const h = await getHelp();
    if (h.fetch && h.translate) return meta;
    const name = await deviceName();
    if (key.endsWith("#notes")) {
      if (!h.translate) throw declined(notTranslating(name));
      return meta;
    }
    if (key.endsWith("#details") || key.endsWith("#list") || meta.findNext) {
      if (!h.fetch) throw declined(notFetching(name));
      return meta;
    }
    if (WTR_KEY.test(key)) {
      if (!h.fetch) throw declined(notFetching(name));
      if (meta.source !== WTR_OWN && !h.translate) throw declined(notTranslating(name)); // (from the novel's source site it is translated as it comes)
      return meta;
    }
    const store = direct ? directAdapter : proxyAdapter;
    const here = !meta.force && !!((await store.getTranslation(key)) || {}).translated;
    if (!here && !h.fetch) throw declined(notFetching(name));
    if (!meta.translate || h.translate) return meta;
    if (here) throw declined(notTranslating(name));
    if (from && from.decline) from.decline(notTranslating(name));
    return { ...meta, translate: false, retranslate: false };
  }

  // from: { decline } when another device asked (p2p-core.js), else nothing
  async function saveOriginal(key, meta, from) {
    if (meta.remote) meta = await forOtherDevice(key, meta, from); // (the chapters ahead keep `remote`, so they are held to the same)
    if (key.endsWith("#notes")) return queueNotes(key, meta);
    if (key.endsWith("#details")) return refreshBookDetails(key, meta);
    if (key.endsWith("#list")) return refreshSourceList(key, meta);
    if (WTR_KEY.test(key)) return saveWtrSource(key, meta);
    const baseUrl = key.replace(/^translation:/, "").replace(/#original$/, "");
    if (!key.endsWith("#original") || inflight.has(key)) return;
    if (!RawSources.ruleFor(baseUrl)) throw new Error("this extension cannot download from " + (RawSources.hostOf(baseUrl) || "that address"));
    const store = direct ? directAdapter : proxyAdapter;
    inflight.add(key);
    try {
      if (meta.findNext) {
        // A chapter translated before links were kept: read its page once for the address of the next chapter and add it to the
        // saved chapter (a newer version, so it reaches the other devices). The translation itself is not touched.
        report(key, "queued", meta);
        await turn();
        report(key, "downloading", meta);
        const read = await readChapter(await fetchSite(baseUrl, { credentials: "include" }));
        if (!read.next) throw new Error("the page has no next-chapter link (this may be the last chapter)");
        const saved = await store.getTranslation("translation:" + baseUrl);
        if (saved && saved.translated) await store.setTranslation("translation:" + baseUrl, { ...saved, next: read.next, savedAt: Date.now() });
        const original = await store.getTranslation(key);
        if (original && original.translated) await store.setTranslation(key, { ...original, next: read.next, savedAt: Date.now() });
        report(key, "done", meta);
        return;
      }
      if (meta.translate && !meta.force && !meta.retranslate) {
        // already translated (say by another device): nothing to do here, but the chapters after it may still be wanted
        const done = await store.getTranslation(withLang("translation:" + baseUrl, await langOf(meta)));
        if (done && done.translated && done.model !== "original") {
          report(key, "done", meta);
          askAhead(done.next, meta);
          return;
        }
      }
      let entry = await store.getTranslation(key);
      // meta.force: read the chapter again from its first page, whatever is saved (a chapter saved with only its first page of several)
      if (!entry || meta.force) {
        report(key, "queued", meta);
        await turn();
        report(key, "downloading", meta);
        const read = await readChapter(await fetchSite(baseUrl, { credentials: "include" }));
        entry = { translated: read.text, suggestions: [], savedAt: Date.now(), model: "original", pageTitle: meta.pageTitle, novelName: meta.novelName, next: read.next || undefined };
        await store.setTranslation(key, entry);
      }
      // a chapter asked for on behalf of a site novel: that novel's glossary applies to this site's chapters too (bound once)
      if (meta.translate && /^\d+$/.test(String(meta.wtrRawId || ""))) {
        const bind = direct ? OriginalTranslate.bindSource(baseUrl, meta.wtrRawId) : ext.runtime.sendMessage({ type: "wtr:bindsource", url: baseUrl, rawId: meta.wtrRawId });
        await Promise.resolve(bind).catch((e) => log("could not bind the glossary", e && e.message));
      }
      // retranslate: translate the saved original text again (no download unless it was never saved); force (re-fetch) also downloaded again above
      if (meta.translate) queueTranslation(key, baseUrl, entry.translated, { ...meta, next: entry.next, force: !!(meta.force || meta.retranslate) });
      else report(key, "done", meta);
      askAhead(entry.next, meta); // (the chapters after it: translated too when asked, else only their text fetched)
    } catch (e) {
      log("original text failed", key, e && e.message);
      report(key, "failed", meta, e && e.message);
      throw e; // the core tells the device that asked
    } finally {
      inflight.delete(key);
    }
  }

  // ---------- looking for new chapters (the novel page's "New chapters" tab; scheduled by watcher.js) ----------
  // Done here because this page can fetch from the source sites with the person's cookies and has a DOM to read their pages with.
  const MAX_FOLLOW = 25; // new chapters followed in one look, a second apart; the rest is picked up by the next look

  // The next chapter after the one at `url`, as a reader finds it: the link on the last page of that chapter.
  async function nextChapterOf(url) {
    let res = await fetchSite(url, { credentials: "include" });
    let at = res.url || url;
    const rule = RawSources.ruleFor(at);
    if (!rule) throw new Error("this extension cannot read " + (RawSources.hostOf(at) || "that site"));
    let doc = null;
    for (let n = 0; n < MAX_PARTS; n++) {
      if (!res.ok) throw new Error(said(res));
      const html = RawSources.decode(new Uint8Array(await res.arrayBuffer()), res.headers && res.headers.get && res.headers.get("content-type"), rule);
      doc = new DOMParser().parseFromString(RawSources.stripScripts(html), "text/html");
      const part = RawSources.nextPart(doc, at, rule);
      if (!part || !RawSources.ruleFor(part)) break;
      await turn();
      res = await fetchSite(part, { credentials: "include" });
      at = res.url || part;
    }
    return doc ? RawSources.nextChapter(doc, at) : null;
  }

  // The chapters of a novel's list: [{ num, title, url }] (with .tocUrl set to where the list was). The list page is where the rule says, or, for a
  // site whose rule cannot tell from an address, found through the "目录" / "Table of Contents" link on the chapter's own page, or the address itself
  // when it is the list (a book's own page). A list that runs over several pages (a page selector, pagination) is read page after page, one request
  // a second (rule.toc.gap: a site that wants longer, and one that answers 429 is slowed down by half again each time), the other pages named by the first (rule.toc.pages); at most MAX_TOC_PAGES of them. A site
  // that answers "too many requests" (429, 503) is waited for (its Retry-After, else longer each time) and asked again.
  // A newest-first list is read from its last (oldest) page back, so what has been read at any moment is the start of the novel, numbered right.
  const MAX_TOC_PAGES = 150;
  const LIST_SAVE_MS = 2500; // the list so far is saved this often while it is being read (in the background: the next page is not held up by it)
  const MAX_TOC_RETRIES = 5;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retryAfterMs = (res) => {
    const h = res.headers && res.headers.get && res.headers.get("retry-after");
    if (!h) return 0;
    const secs = Number(h);
    const ms = isNaN(secs) ? Date.parse(h) - Date.now() : secs * 1000;
    return ms > 0 ? ms : 0;
  };
  // `progress({ done, total, count, partial(), wait })` is called after each page of a list that runs over several (`partial()`: the chapters so far;
  // `wait`: seconds the site asked to wait; `check`: the site's bot check is being passed in a tab). A failure in the middle carries what was read: error.partial (the chapters so far, as partial() gives them).
  // `halted()`: true once the person said to stop: no further page is asked for, and it ends as a failure ("stopped") that carries what was read.
  async function readList(toc, chapterUrl, progress, halted) {
    const decoded = async (res) => RawSources.decode(new Uint8Array(await res.arrayBuffer()), res.headers && res.headers.get && res.headers.get("content-type"), toc.rule);
    const asDoc = (html) => new DOMParser().parseFromString(RawSources.stripScripts(html), "text/html");
    let gap = toc.rule.toc.gap || RAW_GAP_MS; // grows when the site says it is being asked too fast, and stays so for the rest of the list
    let status = { done: 0, total: 1, count: 0, partial: () => [] };
    const halt = () => { if (halted && halted()) throw new Error(STOPPED); };
    const fetchPage = async (u) => {
      for (let attempt = 0; ; attempt++) {
        await turn(gap);
        halt();
        const res = await fetchSite(u, { credentials: "include" }, () => progress && progress({ ...status, check: true }));
        if ((res.status !== 429 && res.status !== 503) || attempt >= MAX_TOC_RETRIES) return res;
        const ms = Math.min(retryAfterMs(res) || 15000 * 2 ** attempt, 180000);
        gap = Math.min(Math.round(gap * 1.5), 10000);
        log("chapter list: the site asked to slow down", u, Math.round(ms / 1000) + "s");
        if (progress) await progress({ ...status, wait: Math.max(1, Math.ceil(ms / 1000)) });
        for (let left = ms; left > 0; left -= 500) { // (a wait can be minutes: a stop is noticed during it)
          halt();
          await sleep(Math.min(left, 500));
        }
      }
    };
    let tocUrl = toc.url;
    let first = null; // the list's first page, when the address turned out to be the list itself
    if (!tocUrl) {
      const page = await fetchPage(chapterUrl);
      if (!page.ok) throw new Error("the page answered " + said(page));
      const pageHtml = await decoded(page); // (scripts are taken out of the document, but a list a script holds as data is read from the text)
      const pageDoc = asDoc(pageHtml);
      tocUrl = RawSources.tocLinkOf(pageDoc, page.url || chapterUrl); // a chapter's own link to the list wins ...
      if (!tocUrl) {
        // ... and without one, the page may be the list itself (a book's own page): if the rule finds chapters on it, that is the list
        let own = [];
        try {
          own = typeof toc.rule.toc.parse === "function" ? [] : RawSources.tocChapters(pageDoc, { rule: toc.rule, url: page.url || chapterUrl }, pageHtml);
        } catch (e) {
          own = [];
        }
        if (own.length < 3) throw new Error("the chapter has no link to the chapter list"); // (a chapter page may have a link or two that look like entries; a list has more)
        first = { doc: pageDoc, url: page.url || chapterUrl, html: pageHtml };
      }
    }
    if (!first) {
      const res = await fetchPage(tocUrl);
      if (!res.ok) throw new Error("the chapter list answered " + said(res));
      const html = await decoded(res);
      if (typeof toc.rule.toc.parse === "function") { // a list that is JSON, not a page
        const listed = RawSources.tocChaptersFromText(html, { rule: toc.rule, url: res.url || tocUrl });
        listed.tocUrl = res.url || tocUrl;
        return listed;
      }
      first = { doc: asDoc(html), url: res.url || tocUrl, html };
    }
    const here = { rule: toc.rule, url: first.url };
    const more = RawSources.tocPageUrls(first.doc, here, first.html).slice(0, MAX_TOC_PAGES);
    let chapters;
    if (!more.length) {
      chapters = RawSources.tocChapters(first.doc, here, first.html);
    } else {
      const read = toc.rule.toc.read || toc.rule.toc.list;
      const newestFirst = !!toc.rule.toc.reverse;
      const got = new Map([[0, read(first.doc, first.url, first.html)]]); // the pages read, by their place in the site's order (0 is the first)
      // In the site's order. A newest-first list leaves its first page out until the rest is in: it is the newest end, so without the pages between
      // it and the others the numbers would be wrong.
      const sofar = (all) => [...got.keys()].filter((k) => all || !newestFirst || k > 0).sort((x, y) => x - y).map((k) => got.get(k));
      const count = () => new Set([...got.values()].flat().map((c) => c.url)).size;
      status = { done: 1, total: more.length + 1, count: count(), partial: () => RawSources.tocJoin(sofar(false), here) };
      const note = async () => progress && (await progress(status));
      await note();
      const order = more.map((u, i) => [i + 1, u]);
      if (newestFirst) order.reverse(); // the oldest page first
      try {
        for (const [at, u] of order) {
          const res = await fetchPage(u);
          if (!res.ok) throw new Error("list page " + u + " answered " + said(res));
          const html = await decoded(res);
          got.set(at, read(asDoc(html), res.url || u, html));
          status = { ...status, done: got.size, count: count() };
          await note();
        }
      } catch (e) {
        const part = RawSources.tocJoin(sofar(false), here);
        if (part.length) {
          part.tocUrl = first.url;
          e.partial = part;
        }
        throw e;
      }
      chapters = RawSources.tocJoin(sofar(true), here);
    }
    chapters.tocUrl = first.url;
    return chapters;
  }

  // watch -> what was found. A source that lists its chapters (the site) answers with the whole list; any other site is followed from the
  // latest chapter known there, page by page, and answers with the addresses found after it.
  async function checkWatch(w) {
    if (!w || !w.source) throw new Error("no source named");
    if (w.source === "wtr-lab.com") {
      const m = /^https:\/\/wtr-lab\.com\/([a-z-]{2,8})\/novel\/(\d+)\/([^/?#]+)/.exec(w.url || "");
      if (!m) throw new Error("the novel's site address is not known yet (open the novel on the site once)");
      return { kind: "list", chapters: await wtrChapterList(m[1], m[2], m[3]) };
    }
    if (!RawSources.ruleFor(w.from || "")) throw new Error("no chapter to start from yet: read one chapter of this source first");
    // A site with a chapter-list page (uuread.tw, twkan.com, and the ones WebToEpub reads a list from): one request gives every chapter,
    // instead of following the pages one by one. If the list cannot be found or read, the pages are followed after all.
    const toc = RawSources.tocFor(w.from);
    if (toc) {
      try {
        const chapters = await readList(toc, w.from);
        if (chapters.length) return { kind: "toc", tocUrl: chapters.tocUrl, chapters: chapters.map((c) => [c.num, c.title, c.url]) };
      } catch (e) {
        log("chapter list not read, following the pages instead", w.from, e && e.message);
      }
    }
    const urls = [];
    let at = w.from;
    let more = false;
    while (true) {
      await turn();
      const next = await nextChapterOf(at);
      if (!next || urls.includes(next)) break;
      urls.push(next);
      at = next;
      if (urls.length >= MAX_FOLLOW) {
        more = true;
        break;
      }
    }
    return { kind: "follow", urls, more };
  }
  // What a watch set to fetch found (watcher.js, then: "fetch"), or its whole list (then: "all", opts.batch): [{ num, title, url }], each chapter not
  // here asked for as a person's Download would ask, one after another (turn() spaces them out). A source site's chapter is translated in Gemini's
  // turn; a site one is the site's own English. Saved under the novel's name in the library (the watch's `name`), so they land in its list.
  // With opts.batch: at most that many, and none while the watch's batch before is still being fetched or translated (so what a person opens
  // waits behind a few at most); a chapter that batch did not get is left alone for FAILED_WAIT_MS. A site that refuses (a bot check, as the site's
  // Turnstile after a few dozen chapters; a limit) refuses every chapter, so its refusal pauses the watch's fetching instead, PAUSE_MS then twice
  // as long each time up to PAUSE_MAX_MS, and the same chapters are asked for after it; so does a run of EMPTY_RUN batches that brought nothing.
  // Not waited for: -> { asked, busy, complete, paused, reason }
  const FAILED_WAIT_MS = 6 * 3600 * 1000;
  const REFUSED = /turnstile|captcha|challenge|cloudflare|too many requests|rate.?limit|HTTP 429|did not answer as it should/i;
  // A batch's chapters are asked for one at a time, apart (so what a person opens meanwhile waits behind one of them at most), the wait between two
  // being: the novel's own for that source (the watch's `wait`, seconds: its Triggers tab), else the person's for the site (settings.siteWaits:
  // Settings › Limits), else the site's own (RawSources.waitFor: 12 seconds for the site); never below a second in a batch. For the site (nothing
  // to translate) a paced batch is as many as fit in a minute at that wait, so that it is done by the next pass.
  const isSeconds = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;
  async function waitOf(w) {
    if (isSeconds(w.wait)) return Number(w.wait) * 1000;
    try {
      const st = typeof LibraryHost !== "undefined" && LibraryHost.call ? await LibraryHost.call("api", ["GET", "/api/settings"]) : null;
      const site = st && st.siteWaits && st.siteWaits[w.source];
      if (isSeconds(site)) return Number(site) * 1000;
    } catch (e) {
      // (the settings could not be read: the site's own)
    }
    return RawSources.waitFor(w.source);
  }
  let bulkScale = 1; // (tests: shorter gaps)
  const pending = new Set(); // "<chapter key>#original" of a batch, not asked for yet
  const PAUSE_MS = 10 * 60 * 1000;
  const PAUSE_MAX_MS = 2 * 3600 * 1000;
  const EMPTY_RUN = 3;
  const fills = new Map(); // watch id -> { at, asked, got, empty, pause, pausedUntil, reason }: how its fetching goes (library-host.js "schedule")
  const lastError = new Map(); // "<chapter key>#original" -> why it did not come, until its batch is looked at
  // "<chapter key>#original" -> { error, stop } of a watch's chapter that came but was not translated (stop: its novel's profile cannot be used here until something is
  // changed: a key, the sign-in, tickets), until its batch is looked at
  const untranslated = new Map();
  const EXT_BUILD = 2; // said to the other devices (p2p-core.js "hi"): 2, the watches fetch what they find (then: "fetch", "all")
  const held = new Set(); // chapters known to be here (their translation), so the list is not read through again
  const fetchFailed = new Map(); // "<chapter key>#original" -> when it was asked for and did not come
  const batches = new Map(); // watch id -> the keys of its batch
  const working = (k) => {
    const url = k.replace(/^translation:/, "").replace(/#original$/, "");
    return pending.has(k) || inflight.has(k) || [...translating].some((t) => t === url || t.startsWith(url + "#lang="));
  };
  async function fetchFound(items, w, opts = {}) {
    if (typeof LibraryHost === "undefined" || !LibraryHost.isMember()) throw new Error("this extension is not in a library yet");
    const novelName = String((w && w.name) || (/^name:/.test((w && w.novel) || "") ? w.novel.slice(5) : "")).slice(0, 300);
    if (!novelName) throw new Error("the watch has no novel name yet: open the novel's page and set it again");
    const store = direct ? directAdapter : proxyAdapter;
    const isHere = async (k) => {
      const own = k.replace(/#original$/, "");
      if (held.has(own)) return true;
      const e = await store.getTranslation(own);
      if (e && e.translated && e.model !== "original") held.add(own);
      return held.has(own);
    };
    const gapMs = await waitOf(w);
    const wtrSource = w.source === WTR_OWN;
    let batch = Math.max(0, Math.min(50, Math.floor(Number(opts.batch) || 0)));
    if (batch && wtrSource && opts.paced) batch = Math.max(1, Math.min(50, Math.floor(60 * 1000 / Math.max(gapMs, 1000)))); // (watcher.js: as many as the pace fits in a pass)
    const f = batch ? fills.get(w.id) || fills.set(w.id, { at: 0, asked: 0, got: 0, empty: 0, pause: 0, pausedUntil: 0, reason: "", translating: false }).get(w.id) : null;
    if (batch) {
      const before = batches.get(w.id);
      if (before && [...before].some(working)) return { asked: 0, busy: true };
      if (before) {
        // how the batch before went: what did not come (fetching or translating it failed), and why
        const missed = [];
        for (const k of before) if (!(await isHere(k))) missed.push(k);
        const whys = missed.map((k) => lastError.get(k) || (untranslated.get(k) || {}).error || "");
        // (its novel's profile cannot be used here: no use asking again before something is changed)
        const stuck = missed.map((k) => untranslated.get(k)).find((x) => x && x.stop);
        for (const k of before) { lastError.delete(k); untranslated.delete(k); }
        batches.delete(w.id);
        f.got += before.size - missed.length;
        f.empty = missed.length === before.size ? f.empty + 1 : 0;
        const refused = whys.find((m) => REFUSED.test(m)) || "";
        if (refused || stuck || f.empty >= EMPTY_RUN) {
          f.pause = Math.min(f.pause ? f.pause * 2 : PAUSE_MS, PAUSE_MAX_MS);
          f.pausedUntil = Date.now() + f.pause;
          f.reason = (refused || (stuck && stuck.error) || whys.find(Boolean) || "nothing of the last " + EMPTY_RUN + " batches came").slice(0, 300);
          f.translating = !refused && !!stuck; // (the site's Triggers tab says it so: it is not the source that refused)
          f.empty = 0;
          // (refused, not missing: the same chapters are asked for after the pause; their text already here, only translated then)
          for (const k of missed) if (refused || stuck) fetchFailed.delete(k); else fetchFailed.set(k, Date.now());
          log("fetching paused for", w.id, "until", new Date(f.pausedUntil).toISOString(), f.reason);
        } else {
          for (const k of missed) fetchFailed.set(k, Date.now());
          if (missed.length < before.size) { f.pause = 0; f.reason = ""; f.translating = false; } // (it works again: the next refusal waits the shortest time)
        }
      }
      if (f.pausedUntil > Date.now()) return { asked: 0, paused: f.pausedUntil, reason: f.reason };
    }
    const wtr = w.source === WTR_OWN;
    const picked = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (picked.length >= (batch || 50)) break;
      const key = "translation:" + String((it && it.url) || "") + "#original";
      const m = WTR_KEY.exec(key);
      if (wtr ? !m : !RawSources.ruleFor(it.url)) continue;
      if (working(key) || Date.now() - (fetchFailed.get(key) || 0) < FAILED_WAIT_MS || (await isHere(key))) continue;
      picked.push({ key, m, pageTitle: String(it.title || "").slice(0, 300) });
    }
    if (batch && picked.length) {
      batches.set(w.id, new Set(picked.map((p) => p.key)));
      Object.assign(f, { at: Date.now(), asked: f.asked + picked.length });
    }
    const gap = (batch ? Math.max(gapMs, 1000) : gapMs) * bulkScale;
    picked.forEach(({ key, m, pageTitle }, i) => {
      const meta = wtr ? { novelName, pageTitle, source: WTR_OWN, wtrRawId: m[2] } : { novelName, pageTitle, translate: true, watched: true }; // (watched: with its novel's profile, OriginalTranslate.run)
      const ask = () => {
        pending.delete(key);
        saveOriginal(key, meta).catch((e) => {
          fetchFailed.set(key, Date.now());
          if (batch) lastError.set(key, String((e && e.message) || e));
          log("found chapter not fetched", key, e && e.message);
        });
      };
      if (!gap || !i) return ask();
      pending.add(key);
      setTimeout(ask, i * gap);
    });
    return { asked: picked.length, complete: !picked.length };
  }
  // (the site's Triggers tab: how each watch's fetching goes, and "Try again now" once the person passed the site's check)
  const fillsNow = () => Object.fromEntries([...fills].map(([id, x]) => [id, Object.assign({}, x)]));
  function resumeFill(id) {
    const x = fills.get(id);
    if (!x) return false;
    Object.assign(x, { pausedUntil: 0, pause: 0, empty: 0, reason: "", translating: false });
    return true;
  }
  // Firefox: the background page is this page, so the scheduler calls these directly; in Chrome it asks over a message (below).
  self.__checkWatch = checkWatch;
  self.__fetchFound = fetchFound;
  self.__fills = fillsNow; // (tests)
  self.__bulkScale = (x) => { bulkScale = x; };
  self.__resumeFill = resumeFill;
  // A source's chapter list read once, the way the library's "Refresh chapters" reads it, and kept as the novel's list (the editions of your novels: LibraryHost.readList).
  const readSourceList = (url) => refreshSourceList("translation:" + url + "#list", {});

  const core = P2PCore.createP2P({
    adapter: direct ? directAdapter : proxyAdapter,
    WebTorrent: self.WebTorrent,
    log,
    role: "extension",
    build: EXT_BUILD, // (what the site's Triggers tab asks of it: watcher.js then "fetch" and "all"; a device that says less is an older build)
    localOnly: true, // (with no passphrase it still answers the library site's tab in this browser)
    library: typeof LibraryHost !== "undefined" ? LibraryHost.roomLink : undefined, // your library's records, and devices asking to join it
    onRawRequest: saveOriginal,
    onRawStop: (key) => { if (inflight.has(key) && key.endsWith("#list")) stopped.add(key); },
    // a read of the library (what a page shows): not for another device (each device of the library keeps its own copy, and a device not in it is
    // answered nothing by p2p-core.js), only for this browser's tab
    answerApi: async (p, from) => {
      if (typeof LibraryHost === "undefined" || (from && from.remote)) return null;
      const lib = await LibraryHost.ready;
      if (!lib || lib.status().state !== "member") return null;
      return LibraryHost.call("api", ["GET", p]);
    }
  });

  if (typeof LibraryHost !== "undefined") {
    LibraryHost.room = core;
    LibraryHost.fetchChapter = saveOriginal; // (for the editions of your novels: a new chapter fetched and translated)
    LibraryHost.fills = fillsNow;
    LibraryHost.resumeFill = resumeFill;
    LibraryHost.readList = readSourceList;
    LibraryHost.helpDevices = (v) => (v && typeof v === "object" ? setHelp(v) : getHelp()); // (the site's Settings › Library: what this extension does for your other devices)
    // your library, published for readers once it is shared, from the chapters this device holds
    const chapters = direct ? directAdapter : proxyAdapter;
    chapters.getConfig().then((c) => LibraryHost.startPublishing(chapters, c && c.trackers)).catch((e) => log("publishing not started", e));
  }
  const chapterSaved = (key, entry) => { if (typeof LibraryHost !== "undefined") LibraryHost.chapterSaved(key, entry); };
  const restart = () => core.start().catch((e) => log("start failed", e));
  restart();

  if (direct) {
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let reconfigure = false;
      for (const key of Object.keys(changes)) {
        if (key.startsWith(PREFIX) && changes[key].newValue) { core.onLocalSave(key, changes[key].newValue); chapterSaved(key, changes[key].newValue); }
        if (CONFIG_KEYS.includes(key)) reconfigure = true;
      }
      if (reconfigure) restart();
    });
  }

  // The library site's own tab (through site-bridge.js) connects directly: one more peer for the sync, with no network between the two.
  ext.runtime.onConnect.addListener((port) => {
    if (port.name !== "p2p-local" || typeof LibraryHost === "undefined" || !LibraryHost.fromSite(port.sender)) return; // only site-bridge.js, in a tab of the library site
    // (the site in this browser: trusted once this extension is in a library, which the site's tab then uses as its own, and answers for in
    // its room: the records it takes there go into this library, and what it tells of them is passed on; before that it has nothing to say
    // to it but asking to join)
    const member = () => typeof LibraryHost !== "undefined" && LibraryHost.isMember();
    const link = core.addLocalPeer({ send: (obj) => port.postMessage(obj) }, { trusted: member, sameLibrary: member });
    const timer = setInterval(() => link.refresh(), 3000);
    port.onMessage.addListener((m) => link.receive(m));
    port.onDisconnect.addListener(() => { clearInterval(timer); link.close(); });
  });

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "p2p:status") {
      sendResponse(core.status());
      return; // sync response
    }
    if (msg.target === "p2p-host" && msg.type === "watch:check") {
      checkWatch(msg.watch).then((found) => sendResponse({ found }), (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true; // answered later
    }
    if (msg.target === "p2p-host" && msg.type === "watch:fetch") {
      fetchFound(msg.items, msg.watch || {}, msg.opts || {}).then((r) => sendResponse(r), (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true; // answered later
    }
    // The popup's Refresh details (and the same request the library site makes of a device): fetch a chapter's text, its notes or a novel's details. Only
    // once this extension is in a library (it does nothing before).
    if (msg.target === "p2p-host" && msg.type === "work") {
      const key = String(msg.key || "");
      const m = msg.meta || {};
      if (typeof LibraryHost === "undefined" || !LibraryHost.isMember()) { sendResponse({ error: "this extension is not in a library yet" }); return; }
      if (!P2PCore.kindOf(key)) { sendResponse({ error: "not a chapter's address" }); return; }
      const meta = { novelName: String(m.novelName || "").slice(0, 300), pageTitle: String(m.pageTitle || "").slice(0, 300), ahead: Math.max(0, Math.min(50, Math.floor(Number(m.ahead) || 0))),
        translate: !!m.translate, force: !!m.force, ...(Number.isFinite(m.notes) ? { notes: Math.max(0, Math.min(11, Math.floor(m.notes))) } : {}) };
      saveOriginal(key, meta).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true; // answered later
    }
    // Chrome only: the service worker forwards storage events here.
    if (msg.target === "p2p-host") {
      if (msg.type === "changed") { core.onLocalSave(msg.key, msg.entry); chapterSaved(msg.key, msg.entry); }
      else if (msg.type === "reconfigure") restart();
    }
  });
})();
