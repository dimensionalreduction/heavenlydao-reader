// Runs on the site. While you read a novel there it:
//  1. sends that novel's glossaries (all three lists) to your library, through the background script, so
//     they can be searched and imported on other sites (the library works out what changed);
//  2. sends the novel's display info (cover, synopsis, author, tags) for the site's novel page, once a day, with its full chapter list
//     (one request to the site's own chapter list, the first time the novel is visited; later refreshes are the person's choice, see watcher.js);
//  3. saves the chapters you read here (the site's own English text) into the same cache as your Gemini translations, so they
//     are seeded over P2P and listed next to the other source's chapters;
//  4. when you click a term, fetches how many readers chose each English rendering (that one term only, once a week at most;
//     nothing is requested in the background) and keeps the numbers, never other users' account IDs.
// The site is a single-page app (chapters load without a page reload), so everything here re-checks the page periodically.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  // Bump when the data sent to the library changes shape, so everything is re-sent once (e.g. when origins were added).
  const CAPTURE_VERSION = 4; // (3: the person's own terms on the site go with the glossary; 4: and the ones that fix its English go to the library's terms)
  const FRESH_MS = 6 * 60 * 60 * 1000; // re-send glossaries at most this often
  const RETRY_MS = 60 * 1000;
  const NOVEL_INFO_FRESH_MS = 24 * 60 * 60 * 1000;
  const COUNT_STALE_MS = 7 * 24 * 60 * 60 * 1000; // counts older than this are fetched again
  const CHAPTER_MIN_CHARS = 300; // shorter than this is a placeholder (locked / still loading), not a chapter
  const CHAPTER_MIN_LINES = 3;
  const BACKOFF_MS = 10 * 60 * 1000;


  let lastId = null;
  let lastTry = 0;
  let busy = false;

  // ---- 1. the glossaries ----
  // The person's own terms on the site (what they changed to read the novel there), for this novel and for every novel: { pairs, replace, ok }. pairs:
  // the ones with a source in the novel's language (they go with the glossary); replace: the ones that fix the site's English (they go to the terms of the
  // library's reader, shown after the translation). When the site does not give them (signed out, not answering) ok is false: the glossary goes up all the
  // same, and the library keeps the ones it has.
  async function personalTerms(info) {
    try {
      const res = await fetch("/api/v2/user/config", { credentials: "same-origin" });
      if (!res.ok) return { pairs: [], replace: [], ok: false };
      const json = await res.json();
      return { pairs: WtrTerms.personalPairs(json, info.rawId), replace: WtrTerms.personalReplacements(json, info.rawId), ok: true };
    } catch (e) {
      return { pairs: [], replace: [], ok: false };
    }
  }
  async function sendGlossary(info) {
    const res = await fetch("/api/v2/reader/terms/" + info.rawId + ".json", { credentials: "same-origin" });
    if (!res.ok) return false;
    const personal = await personalTerms(info);
    const entry = WtrTerms.toLibraryEntry(await res.json(), info.rawId, info.slug, personal.pairs);
    if (!entry) return false;
    if (!personal.ok) entry.keepYours = true;
    else await ext.runtime.sendMessage({ type: "wtr:myterms", rawId: info.rawId, novel: await novelTitleFor(info), terms: personal.replace }).catch(() => null); // (before the import, which brings the cache up to date)
    const reply = await ext.runtime.sendMessage({ type: "glossary:import", record: entry });
    if (!reply || !reply.ok) return false;
    const stamps = (await ext.storage.local.get("wtrCapturedAt")).wtrCapturedAt || {};
    stamps[info.rawId] = { at: Date.now(), v: CAPTURE_VERSION }; // only a successful hand-off counts, so a down server is retried
    await ext.storage.local.set({ wtrCapturedAt: stamps });
    return true;
  }

  // ---- 2. the novel's display info ----
  // The page's own data file is /_next/data/<buildId>/<lang>/novel/<id>/<slug>.json; the build id is in the page's
  // __NEXT_DATA__ (it only changes when the site deploys), so this works however you navigated to the novel.
  async function sendNovelInfo(info) {
    if (!info.slug) return false;
    let buildId = null;
    try {
      const el = document.getElementById("__NEXT_DATA__");
      buildId = el ? JSON.parse(el.textContent).buildId : null;
    } catch (e) {
      buildId = null;
    }
    if (!buildId) return false;
    const lang = (/^https:\/\/wtr-lab\.com\/([^/]+)\//.exec(location.href) || [])[1] || "en";
    const res = await fetch(
      "/_next/data/" + buildId + "/" + lang + "/novel/" + info.rawId + "/" + info.slug + ".json?locale=" + lang + "&raw_id=" + info.rawId + "&serie_slug=" + info.slug,
      { credentials: "same-origin" }
    );
    if (!res.ok) return false;
    const novel = WtrTerms.toNovelInfo(await res.json(), info.rawId, info.slug, "https://wtr-lab.com/" + lang);
    if (!novel) return false;
    const source = await rawSourceFor(info, lang, novel.rawSlug); // the source is named in this very data; only chapter 1's address needs a lookup
    delete novel.rawSlug;
    novel.rawHost = source.host || undefined;
    novel.rawFirst = source.first || undefined;
    const reply = await ext.runtime.sendMessage({ type: "novel:save", info: novel });
    if (!reply || !reply.ok) return false;
    if (novel.cover) ext.runtime.sendMessage({ type: "cover:copy", id: novel.id, url: novel.cover }).catch(() => {}); // (a copy in the library)
    const stored = await ext.storage.local.get(["wtrNovelInfoAt", "wtrNovelTitles"]);
    const stamps = stored.wtrNovelInfoAt || {};
    const titles = stored.wtrNovelTitles || {};
    stamps[info.rawId] = Date.now();
    titles[info.rawId] = novel.title;
    await ext.storage.local.set({ wtrNovelInfoAt: stamps, wtrNovelTitles: titles });
    return true;
  }

  // ---- 2b. the novel's full chapter list ----
  // The site serves every chapter of a novel (number, English title, original title) from one request, /api/chapters/<id>: the same list its
  // own "Chapters" tab shows (and what WebToEpub reads from a book's table of contents). It goes to the library as the novel's chapter index,
  // so the library can list every chapter, downloaded or not. One request per novel, the first time it is visited.
  const MAX_LIST = 10000;
  async function sendChapterList(info) {
    if (!info.slug) return false;
    const lang = (/^https:\/\/wtr-lab\.com\/([^/]+)\//.exec(location.href) || [])[1] || "en";
    const res = await fetch("/api/chapters/" + info.rawId, { credentials: "same-origin" });
    if (!res.ok) return false;
    const list = (((await res.json().catch(() => null)) || {}).chapters || []).slice(0, MAX_LIST);
    const base = "https://wtr-lab.com/" + lang + "/novel/" + info.rawId + "/" + info.slug + "/chapter-";
    const chapters = list
      .filter((c) => c && Number.isInteger(c.order) && c.order >= 0 && typeof c.title === "string")
      .map((c) => [c.order, c.title.trim().slice(0, 300), base + c.order, String(c.name || "").trim().slice(0, 300)]);
    if (!chapters.length) return false;
    const reply = await ext.runtime.sendMessage({
      type: "chapterindex:save",
      record: { key: "wtr-lab:" + info.rawId, source: "wtr-lab", url: "https://wtr-lab.com/" + lang + "/novel/" + info.rawId + "/" + info.slug, chapters }
    });
    if (!reply || !reply.ok) return false;
    const stamps = (await ext.storage.local.get("wtrChapterListAt")).wtrChapterListAt || {};
    stamps[info.rawId] = Date.now(); // only a successful hand-off counts, so a down server is retried
    await ext.storage.local.set({ wtrChapterListAt: stamps });
    return true;
  }

  // The site the site's "Raw" link leads to, so the library can offer "read from <that site>". One lookup per novel, remembered
  // (a failed lookup is tried again after a week). The extension's background does it: it can follow the redirect across sites.
  const RAW_HOST_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
  const RAW_HOST_V = 3; // bumped when what is captured about a novel changes (v2: fanqienovel through tomatomtl.com; v3: status, genres, titles), so older captures are redone once
  async function rawSourceFor(info, lang, slug) {
    const stored = (await ext.storage.local.get("wtrRawHost")).wtrRawHost || {};
    const known = stored[info.rawId];
    // (a host with no first-chapter address, or no host, is looked up again only after a week)
    if (known && known.v === RAW_HOST_V && (known.first || Date.now() - known.at < RAW_HOST_RETRY_MS)) return { host: known.host, first: known.first || "" };
    const reply = await ext.runtime.sendMessage({ type: "wtr:rawhost", rawId: info.rawId, lang, slug }).catch(() => null);
    const source = { host: (reply && reply.host) || "", first: (reply && reply.first) || "" };
    stored[info.rawId] = { host: source.host, first: source.first, at: Date.now(), v: RAW_HOST_V };
    await ext.storage.local.set({ wtrRawHost: stored });
    return source;
  }

  async function glossaryIsOnServer(rawId) {
    const s = ((await ext.storage.local.get("wtrCapturedAt")).wtrCapturedAt || {})[rawId];
    return !!s && typeof s === "object" && s.v === CAPTURE_VERSION;
  }

  async function capture() {
    const info = WtrTerms.parseWtrUrl(location.href);
    if (!info || busy) return;
    if (lastId === info.rawId && Date.now() - lastTry < RETRY_MS) return;
    lastId = info.rawId;
    lastTry = Date.now();
    const stored = await ext.storage.local.get(["wtrCapturedAt", "wtrNovelInfoAt", "wtrRawHost", "wtrChapterListAt"]);
    const s = (stored.wtrCapturedAt || {})[info.rawId];
    const glossaryFresh = !!s && typeof s === "object" && s.v === CAPTURE_VERSION && Date.now() - s.at < FRESH_MS;
    // A novel whose raw source site has not been looked up yet is sent again right away, so the library can offer that source.
    const rawKnown = (stored.wtrRawHost || {})[info.rawId];
    const infoFresh = Date.now() - ((stored.wtrNovelInfoAt || {})[info.rawId] || 0) < NOVEL_INFO_FRESH_MS && !!rawKnown && rawKnown.v === RAW_HOST_V && (!!rawKnown.first || Date.now() - rawKnown.at < RAW_HOST_RETRY_MS);
    // The chapter list is fetched once, the first time a novel is visited (the library needs it to show every chapter); after that it only
    // gets refreshed by a watch the person switched on for that source ("New chapters" tab), never on a timer of its own.
    const listFresh = !!(stored.wtrChapterListAt || {})[info.rawId];
    if (glossaryFresh && infoFresh && listFresh) return;
    busy = true;
    try {
      // A bare number in wtrCapturedAt is the old format (sent before origins existed), so it counts as stale.
      if (!glossaryFresh) await sendGlossary(info);
      if (!infoFresh) await sendNovelInfo(info);
      if (!listFresh) await sendChapterList(info);
    } catch (e) {
      // best effort; the next tick retries
    } finally {
      busy = false;
    }
  }

  // ---- 3. the chapters themselves ----
  // The site's reader is one page that keeps loading the next chapters. Each chapter is
  //   <div class="chapter-tracker" data-chapter-no="2" data-raw-id="8053"> ... <div class="chapter-container"> ...
  //     <div class="separator">gemini-3.5-flash-lite</div>  (the AI model the site used)
  //     <div class="wtr-line">Chapter 2: The Illusory Legend</div>  (first line: the title, then one line per paragraph)
  // They are saved under the chapter's own URL, exactly like a translated 69shuba chapter, so the P2P sync publishes them
  // and the site lists them as another source for the same chapter number.
  const chapterSeen = new Map(); // key -> text last seen (a chapter is only saved once its text has stopped changing)
  const chapterSaved = new Map(); // key -> text already saved this session
  let savingChapters = false;

  async function novelTitleFor(info) {
    const titles = (await ext.storage.local.get("wtrNovelTitles")).wtrNovelTitles || {};
    return titles[info.rawId] || (/^(.*?)\s+Chapter\s+\d+/i.exec(document.title || "") || [])[1] || info.slug;
  }

  function readChapters(info) {
    const lang = (/^https:\/\/wtr-lab\.com\/([^/]+)\//.exec(location.href) || [])[1] || "en";
    const out = [];
    for (const tracker of document.querySelectorAll(".chapter-tracker[data-chapter-no][data-raw-id]")) {
      const no = tracker.getAttribute("data-chapter-no");
      if (!/^\d+$/.test(no) || tracker.getAttribute("data-raw-id") !== info.rawId) continue;
      const container = tracker.querySelector(".chapter-container");
      if (!container) continue;
      const lines = [...container.querySelectorAll(".wtr-line")].map((l) => String(l.innerText || l.textContent || "").trim()).filter(Boolean);
      if (lines.length < CHAPTER_MIN_LINES) continue;
      const hasTitle = /^Chapter\s+\d+/i.test(lines[0]);
      // Some chapters have no title: the site's "title" is then a copy of the first paragraph, shown as a first line and again as the paragraph.
      if (!hasTitle && lines.length > 1 && lines[0] === lines[1]) lines.shift();
      // Some chapters (e.g. chapter 1) repeat the title as the first body line; drop any such repeats.
      let body = hasTitle ? lines.slice(1) : lines;
      while (hasTitle && body.length && body[0] === lines[0]) body = body.slice(1);
      const text = body.join("\n");
      if (text.length < CHAPTER_MIN_CHARS) continue;
      const badge = container.querySelector(".separator");
      out.push({
        no,
        lang,
        key: "translation:https://wtr-lab.com/" + lang + "/novel/" + info.rawId + "/" + info.slug + "/chapter-" + no,
        title: hasTitle ? lines[0] : "Chapter " + no,
        text,
        model: badge ? String(badge.innerText || badge.textContent || "").trim() : ""
      });
    }
    return out;
  }

  async function saveChapters() {
    const info = WtrTerms.parseWtrUrl(location.href);
    if (!info || !info.slug || savingChapters) return;
    savingChapters = true;
    try {
      let novelTitle = null;
      for (const c of readChapters(info)) {
        if (chapterSaved.get(c.key) === c.text) continue;
        if (chapterSeen.get(c.key) !== c.text) { chapterSeen.set(c.key, c.text); continue; } // still changing: look again next time
        const stored = (await ext.storage.local.get(c.key))[c.key];
        if (!stored || stored.translated !== c.text) {
          if (novelTitle === null) novelTitle = await novelTitleFor(info);
          await ext.storage.local.set({
            [c.key]: {
              translated: c.text,
              suggestions: [],
              savedAt: Date.now(),
              model: "wtr-lab" + (c.model ? " · " + c.model : ""),
              pageTitle: c.title,
              novelName: novelTitle
            }
          });
        }
        chapterSaved.set(c.key, c.text);
      }
    } catch (e) {
      // best effort: it is tried again on the next pass
    } finally {
      savingChapters = false;
    }
  }

  // ---- 4. usage counts, when you click a term ----
  // The site shows how many readers chose each English rendering when you open a term on its page. That number is only available one
  // term at a time (/api/v2/term-preferences), so nothing is requested in the background: when you click a marked term
  // (<span class="text-patch" data-hash="银月花">) the extension asks about that one term, at most once a week per term, and keeps
  // the numbers. Only the counts are kept, never other users' account IDs.
  const counting = new Set(); // terms being asked about right now
  let doneFor = null; // { rawId, map: { term: timestamp } } kept in memory, persisted when counts are uploaded
  let backoffUntil = 0;

  // One shared copy per novel, loaded once: clicks that arrive together must all see (and update) the same map.
  function loadDone(rawId) {
    if (!doneFor || doneFor.rawId !== rawId) {
      const entry = { rawId };
      entry.promise = ext.storage.local.get("wtrVotesDone").then((stored) => (entry.map = (stored.wtrVotesDone || {})[rawId] || {}));
      doneFor = entry;
    }
    return doneFor.promise;
  }

  async function countTerm(term) {
    const info = WtrTerms.parseWtrUrl(location.href);
    if (!info || counting.has(term) || Date.now() < backoffUntil) return;
    const { rawId } = info;
    const lang = (/^https:\/\/wtr-lab\.com\/([^/]+)\//.exec(location.href) || [])[1] || "en";
    counting.add(term); // before any await, so a double click cannot start two requests
    try {
      const done = await loadDone(rawId);
      if (done[term] > Date.now() - COUNT_STALE_MS) return; // counted this week already
      // The library has to hold the glossary before it can take counts for it.
      if (!(await glossaryIsOnServer(rawId)) && !(await sendGlossary(info))) {
        backoffUntil = Date.now() + RETRY_MS;
        return;
      }
      let res = null;
      try {
        res = await fetch(
          "/api/v2/term-preferences?source_id=id.raw." + rawId + "&hash=" + encodeURIComponent(term) + "&lang=" + encodeURIComponent(lang),
          { credentials: "same-origin" }
        );
      } catch (e) {
        res = null;
      }
      if (!res || res.status === 429 || res.status === 403 || res.status >= 500) {
        backoffUntil = Date.now() + BACKOFF_MS; // The site pushed back: leave it alone for a while (the next click after that tries again)
        return;
      }
      const votes = res.ok ? WtrTerms.parseVotes(await res.json().catch(() => null)) : null;
      if (votes) await uploadCounts(rawId, [[term, votes]], done);
      else done[term] = Date.now(); // some other 4xx: don't keep asking about this one for a while
    } catch (e) {
      // best effort: clicking the term again tries again
    } finally {
      counting.delete(term);
    }
  }

  async function uploadCounts(rawId, batch, done) {
    const reply = await ext.runtime.sendMessage({ type: "glossary:votes", id: "wtr-lab:" + rawId, votes: batch });
    if (!reply || !reply.ok) {
      // e.g. the library lost the glossary: re-send it first next time
      const stamps = (await ext.storage.local.get("wtrCapturedAt")).wtrCapturedAt || {};
      delete stamps[rawId];
      await ext.storage.local.set({ wtrCapturedAt: stamps });
      backoffUntil = Date.now() + RETRY_MS;
      return;
    }
    const all = (await ext.storage.local.get("wtrVotesDone")).wtrVotesDone || {};
    for (const [term] of batch) done[term] = Date.now(); // remembered only once the library has the numbers
    all[rawId] = Object.assign(all[rawId] || {}, Object.fromEntries(batch.map((b) => [b[0], done[b[0]]])));
    await ext.storage.local.set({ wtrVotesDone: all });
    ext.runtime.sendMessage({ type: "glossary:pull" }).catch(() => {}); // bring the new numbers into the local cache
  }

  function onPageClick(ev) {
    const el = ev && ev.target && ev.target.closest ? ev.target.closest("span.text-patch[data-hash]") : null;
    const term = el ? String(el.getAttribute("data-hash") || "").trim() : "";
    if (term && term.length <= 200) countTerm(term);
  }
  // (nothing until this extension is a device of a library, nor with "Library copy" off in its popup: it records nothing then)
  (typeof browser !== "undefined" ? browser : chrome).storage.local.get(["libraryOn", "libraryCopy"]).then((r) => !!r.libraryOn && r.libraryCopy !== false, () => false).then((on) => {
    if (!on) return;
    document.addEventListener("click", onPageClick, true); // capture phase: counted even if the page stops the click
    capture();
    setInterval(capture, 3000);
    setInterval(saveChapters, 2000);
  });
})();
