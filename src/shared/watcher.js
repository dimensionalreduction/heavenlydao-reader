// "New chapters": looks for new chapters of the novels and source sites the person switched on, on the schedule they chose.
//
// The switches live in your library (the site's "New chapters" tab sets them, one per novel and source site, off by default), so
// this does nothing at all until one is on. Once a minute the background script calls tick(): it asks the library for the switched-on
// watches, works out which are due, has the extension page that can reach the source sites do the looking (p2p-host.js, checkWatch), and
// writes the result back: a notice for the novel page ("3 new chapters on uuread.tw"), the updated watch (when it last looked and what it
// knew then) and, for the site, the refreshed chapter list so the library shows the new chapters. A watch whose `then` is "fetch" also has the
// new chapters fetched (and, from a source site, translated) by the extension; one whose `then` is "all" has every chapter of the source's
// list that is not here fetched, a batch at a time, the new ones with them; as the novel page's Triggers tab says.
//
// A watch: { id, novel, name, source, on, mode: "every" | "daily", hours, at: "HH:MM", days, tz, then, from, known, url, lastCheck, lastResult }
//   every  look again once `hours` hours have passed since the last look
//   daily  look at `at` o'clock in the person's own time (`tz` is their offset from UTC, as getTimezoneOffset() gives it), on each of the
//          `days` of the week (0 = Sunday ... 6 = Saturday; none chosen: every day)
//   then   "tell" (the default): the new chapters are listed and announced; "fetch": and those of the list numbered past `above` (its last
//          chapter when "fetch" was chosen) are fetched; "all": every chapter of the source's list not on this device is fetched. Both a batch
//          at a time, each batch once the one before it is done (looked at every pass, so a batch a minute at most), so what you open yourself
//          waits behind a few chapters at most. (A source followed page by page has no list: what a look finds is fetched, FETCH_MAX at most.)
//
// One extension does all this: the library's triggerDevice (settings), the one in the browser where the triggers were last changed; with none
// chosen, or one no longer in the library, every extension of the library does (mayRun).
//   name   the novel's name in the library, which the chapters fetched are saved under
(function (root) {
  const MINUTE = 60 * 1000;
  const FETCH_MAX = 50; // new chapters fetched after one look; more than that is left to "Download missing" on the novel's page
  // "all": chapters asked for at once. The site's come in English (one request each); a source site's are translated too, in Gemini's turn.
  const BATCH = { "wtr-lab.com": 5 }; // (the site asks for its bot check after a few dozen chapters at once: p2p-host.js then pauses)
  const BATCH_TRANSLATED = 3;
  const batchOf = (w) => BATCH[w.source] || BATCH_TRANSLATED;
  const complete = new Set(); // watches ("all") whose list had nothing left to fetch: not looked through again before their next look

  const DAY = 24 * 60 * MINUTE;
  // The days of the week a "daily" watch looks on (0 = Sunday ... 6 = Saturday, on the person's own clock): every day when none are chosen.
  const daysOf = (w) => {
    const d = Array.isArray(w.days) ? w.days.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6) : [];
    return d.length ? d : [0, 1, 2, 3, 4, 5, 6];
  };
  // The scheduled moment `k` days from today (the person's today), or 0 when that weekday is not one of the watch's.
  function slotOn(w, now, k) {
    const [h, m] = String(w.at || "09:00").split(":").map(Number);
    const tz = Number(w.tz) || 0;
    const local = new Date(now - tz * MINUTE); // the person's wall clock, read with the UTC getters
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + k * DAY;
    if (!daysOf(w).includes(new Date(day).getUTCDay())) return 0;
    return day + (h * 60 + m) * MINUTE + tz * MINUTE;
  }

  // The most recent moment this watch was meant to run, or 0 if it has no schedule.
  function lastScheduled(w, now) {
    if (w.mode !== "daily") return 0;
    for (let k = 0; k >= -7; k--) {
      const at = slotOn(w, now, k);
      if (at && at <= now) return at;
    }
    return 0;
  }
  // The first moment after `now` that this watch is meant to run.
  function followingSlot(w, now) {
    for (let k = 0; k <= 8; k++) {
      const at = slotOn(w, now, k);
      if (at > now) return at;
    }
    return 0;
  }

  // When a switched-on watch is due: a moment at or before `now` if it is due already (the extension looks within the minute), 0 when it is off.
  // "every": `hours` after the last look. "daily": the scheduled time (on the chosen days), the one that has passed since the last look, else the next.
  function nextDue(w, now) {
    if (!w || !w.on) return 0;
    const last = Number(w.lastCheck) || 0;
    if (w.mode === "daily") {
      const slot = lastScheduled(w, now);
      return slot && last < slot ? slot : followingSlot(w, now);
    }
    return last + Math.max(1, Number(w.hours) || 12) * 60 * MINUTE;
  }
  // Is a switched-on watch due? "every": the interval has passed since the last look. "daily": the scheduled time has passed since it.
  const isDue = (w, now) => !!(w && w.on) && nextDue(w, now) <= now;

  let running = false;

  // Does this extension do the triggers? settings: the library's (/api/settings); me: this device's library status (library.js status()).
  function mayRun(settings, me) {
    const t = settings && settings.triggerDevice;
    if (!t || !t.id || !me || !me.device) return true;
    if (t.id === me.device.id) return true;
    return !(me.devices || []).some((d) => d.id === t.id); // (the one chosen was taken off the library)
  }

  // One pass. `deps` exists so tests can stand in for the library and the page that does the looking.
  async function tick(deps, now = Date.now()) {
    if (running) return { skipped: true };
    running = true;
    const out = [];
    const filling = [];
    try {
      if (deps.settings && deps.me && !mayRun(await deps.settings(), await deps.me())) return { checked: out, filling, notMine: true };
      const all = await deps.listWatches();
      for (const w of all.filter((x) => isDue(x, now))) {
        let update = { ...w, lastCheck: now };
        try {
          const found = await deps.check(w);
          update = { ...update, ...(await apply(deps, w, found, now)) };
        } catch (e) {
          update.lastResult = "failed: " + String((e && e.message) || e).slice(0, 150);
        }
        await deps.saveWatch(update);
        out.push(update);
        complete.delete(w.id); // (its list may have more now)
      }
      // then: "fetch" or "all": the next batch of each one's chapters to fetch that are not here (none while the last batch is still being fetched)
      for (const w of all) {
        if (!w.on || (w.then !== "all" && w.then !== "fetch") || complete.has(w.id)) continue;
        try {
          filling.push({ id: w.id, ...(await fill(deps, w)) });
        } catch (e) {
          filling.push({ id: w.id, error: String((e && e.message) || e) }); // (tried again at the next pass)
        }
      }
    } finally {
      running = false;
    }
    return { checked: out, filling };
  }

  // Where a watch's source keeps its chapter list in the library: the site's under the novel's id, a source site's under the key its chapters'
  // site and folder share (as applyList saves it). "" when there is none yet.
  const listKey = (deps, w) => (w.source === "wtr-lab.com" ? w.novel : w.from && deps.bindingKey ? deps.bindingKey(w.from) : "");
  // then: "all" or "fetch": the list as the library has it, its chapters in order ("fetch": those numbered past `above`, the new ones), handed over
  // with how many to ask for at once. p2p-host.js fetchFound leaves out those here and those being fetched, and asks for nothing while the batch
  // before is not done. -> { asked, busy, complete }
  async function fill(deps, w) {
    const key = listKey(deps, w);
    if (!key || !deps.chapterList || !deps.fetchChapters) return { asked: 0 };
    const above = w.then === "fetch" ? (Number.isFinite(Number(w.above)) ? Number(w.above) : Number(w.known) || 0) : -Infinity;
    const list = ((await deps.chapterList(key)) || []).filter((c) => c[0] > above);
    if (!list.length) { complete.add(w.id); return { asked: 0, complete: true }; }
    const r = (await deps.fetchChapters(list.map((c) => ({ num: c[0], title: c[1], url: c[2] })), w, { missing: true, batch: batchOf(w), paced: w.source === "wtr-lab.com" })) || {};
    if (r.complete) complete.add(w.id);
    return r;
  }

  // "第12章 Title" -> { prefixed, body }: the site's own number is dropped and the words are what gets translated. A leading list number
  // before Chinese words ("001傅家三爷...") is a number too.
  function splitTitle(text) {
    const t = String(text || "").replace(/^\d+[.．、]\s*/, "").replace(/^\d{3,5}(?=[㐀-鿿（(])/, "").trim();
    const m = /^第\s*\d+\s*[章节節回]\s*(.*)$/.exec(t);
    return m ? { prefixed: true, body: m[1].trim() } : { prefixed: false, body: t };
  }
  // The title the library shows: "Chapter <index>: <english>", where the index is the chapter's place in the site's list, so every chapter of
  // a source has an index followed by its name (an afterword is "Chapter 120: Afterword").
  // (a title that already begins "Chapter 12" or "Chapter 12: " has that dropped: the index is the number the library shows, so it would be said twice)
  const noChapterWord = (t) => String(t || "").replace(/^chapter\s*\d+(?:\.\d+)?\s*[:\uff1a.\-\u2013\u2014]?\s*/i, "").trim();
  function composeTitle(num, original, english) {
    const body = noChapterWord(String(english || "").trim() || splitTitle(original).body);
    return "Chapter " + num + (body ? ": " + body : "");
  }


  // Titles in English, each translated once: `cache` (an extension storage area) remembers them, so a list that is looked at again only
  // asks for the titles it has not seen. `translate` is the extension's own batch translator (texts in, same-length array out).
  async function cachedTitles(cache, translate, texts) {
    const stored = (await cache.get("titleCache")).titleCache || {};
    const missing = [...new Set(texts.filter((t) => t && !(t in stored)))];
    if (missing.length) {
      const out = await translate(missing);
      missing.forEach((t, i) => { stored[t] = (out && out[i]) || t; });
      const keys = Object.keys(stored);
      if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete stored[k]; // the oldest go first
      await cache.set({ titleCache: stored });
    }
    return texts.map((t) => stored[t] || t);
  }

  // A source followed page by page (it has no list for fill): the new chapters a look found, fetched when the watch says so (then: "fetch" or
  // "all"): [{ num, title, url }], the first FETCH_MAX. `deps.fetchChapters` only asks for them (the extension fetches them one after another,
  // and translates them in Gemini's turn): the look does not wait for that. What it adds to the result: " · fetching them", or why not.
  async function fetchFound(deps, w, items) {
    if ((w.then !== "fetch" && w.then !== "all") || !items.length || !deps.fetchChapters) return "";
    const some = items.slice(0, FETCH_MAX);
    try {
      await deps.fetchChapters(some, w);
    } catch (e) {
      return " · not fetched: " + String((e && e.message) || e).slice(0, 100);
    }
    return " · fetching " + (some.length < items.length ? "the first " + some.length : some.length === 1 ? "it" : "them") + (w.source === "wtr-lab.com" ? "" : " to translate");
  }

  // What the page that looked found -> notice, chapter list, and the fields the watch should now carry.
  async function apply(deps, w, found, now) {
    const patch = {};
    if (found.kind === "list") {
      // a source that lists its chapters (the site): the new ones are those after the highest number known
      const fresh = found.chapters.filter((c) => c[0] > w.known);
      const top = found.chapters[found.chapters.length - 1][0];
      if (!(w.known > 0)) {
        // nothing was known (no list had been saved when it was switched on): this look is the baseline, so everything already there is
        // not announced as new. The list is kept so the library can show it.
        await deps.saveChapterIndex({ key: w.novel, source: "wtr-lab", url: w.url, chapters: found.chapters });
        return { known: top, lastResult: "watching: " + found.chapters.length + " chapters so far" };
      }
      if (!fresh.length) return { lastResult: "no new chapters" };
      await deps.saveChapterIndex({ key: w.novel, source: "wtr-lab", url: w.url, chapters: found.chapters });
      await deps.addNotice({ novel: w.novel, source: w.source, count: fresh.length, firstNum: fresh[0][0], lastNum: fresh[fresh.length - 1][0], first: fresh[0][2], latest: fresh[fresh.length - 1][2] });
      patch.known = fresh[fresh.length - 1][0];
      patch.lastResult = fresh.length + " new chapter" + (fresh.length === 1 ? "" : "s"); // (fetched, when it is to be, by fill)
      return patch;
    }
    if (found.kind === "toc") return applyList(deps, w, found);
    // a source followed page by page: the pages found after the latest known one
    if (!found.urls.length) return { lastResult: "no new chapters" };
    await deps.addNotice({ novel: w.novel, source: w.source, count: found.urls.length, first: found.urls[0], latest: found.urls[found.urls.length - 1] });
    const fetching = await fetchFound(deps, w, found.urls.map((url) => ({ num: null, title: "", url })));
    return { from: found.urls[found.urls.length - 1], lastResult: found.urls.length + " new chapter" + (found.urls.length === 1 ? "" : "s") + (found.more ? " (and more)" : "") + fetching };
  }

  // A source with a chapter-list page: found.chapters = [[num, original title, address]] in the site's order. The first look (nothing known yet) is
  // the baseline: the whole list goes to the library, with titles in English, and nothing is announced. Later looks announce the chapters after
  // the one the watch has got to (`from`; if that chapter is no longer on the list, those numbered above `known`).
  async function applyList(deps, w, found) {
    const list = found.chapters;
    const top = list[list.length - 1];
    const baseline = !(w.known > 0);
    let fresh = [];
    if (!baseline) {
      const at = list.findIndex((c) => c[2] === w.from);
      fresh = at >= 0 ? list.slice(at + 1) : list.filter((c) => c[0] > w.known);
    }
    let titles = [];
    if (baseline || fresh.length) {
      let english = list.map((c) => splitTitle(c[1]).body);
      // found.quick: a list asked for by a person is saved at once with the site's own titles (translating thousands of them takes minutes);
      // the same list is then applied again without `quick`, which saves it with the titles in English.
      if (!found.quick) {
        try {
          english = await deps.translateTitles(english); // one batch; failing leaves the original titles, the list is still complete
        } catch (e) {
          // keep the originals
        }
      }
      titles = list.map((c, i) => composeTitle(c[0], c[1], english[i]));
      await deps.saveChapterIndex({
        key: deps.bindingKey(list[0][2]), source: w.source, url: found.tocUrl,
        chapters: list.map((c, i) => [c[0], titles[i], c[2], c[1]])
      });
    }
    if (baseline) return { known: top[0], from: top[2], lastResult: "watching: " + list.length + " chapters so far" };
    if (!fresh.length) return { lastResult: "no new chapters" };
    await deps.addNotice({ novel: w.novel, source: w.source, count: fresh.length, firstNum: fresh[0][0], lastNum: fresh[fresh.length - 1][0], first: fresh[0][2], latest: fresh[fresh.length - 1][2] });
    return { known: top[0], from: top[2], lastResult: fresh.length + " new chapter" + (fresh.length === 1 ? "" : "s") }; // (fetched, when it is to be, by fill)
  }

  const api = { isDue, nextDue, lastScheduled, tick, apply, splitTitle, composeTitle, cachedTitles, FETCH_MAX, BATCH, BATCH_TRANSLATED, listKey, mayRun };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Watcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
