// Reads a book's page the way a person does: the page is opened in a background tab, the recording script (book-capture.js) records the book from inside it
// (with the person's cookies and the browser's own headers, so a site that refuses the extension's own request, a 403 from its bot check, still answers), and
// the tab is closed. Used when "Refresh details" is refused by the site. Runs where tabs can be opened: Chrome's service worker, Firefox's background page.
// Also here: a page asked for from inside a tab of its site (fetchIn), for a site that refuses the extension's own requests.
//
// The tab's address carries "#p2pread-visit": the recording script, seeing it, says when it has finished ("bookcapture:done" with { saved, reason }).
var BookVisit = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const MARK = "#p2pread-visit";
  const WAIT_MS = 45 * 1000;
  const waiting = new Map(); // tab id -> the function that takes the recording script's answer

  ext.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === "bookcapture:done" && sender && sender.tab && waiting.has(sender.tab.id)) waiting.get(sender.tab.id)(msg);
  });

  // The recording script does not record a book twice within half a day: take back the note for this one, so this visit records it again.
  async function forget(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    const dot = path.lastIndexOf(".");
    if (dot > path.lastIndexOf("/")) path = path.slice(0, dot); // (the page's extension is not part of the book's id)
    const stamps = (await ext.storage.local.get("bookCapturedAt")).bookCapturedAt || {};
    for (const key of Object.keys(stamps)) if (key.startsWith(host + path)) delete stamps[key];
    await ext.storage.local.set({ bookCapturedAt: stamps });
  }

  // Opens the page, waits for the recording script, closes the tab. Resolves { ok: true, cover } when the book was recorded (cover: how its cover's copy
  // went, as copyCover answers); otherwise it throws what went wrong.
  async function visit(url) {
    const address = String(url).split("#")[0];
    if (!/^https:\/\//.test(address)) throw new Error("not an https address");
    await forget(address);
    const tab = await ext.tabs.create({ url: address + MARK, active: false });
    try {
      const done = await new Promise((resolve) => {
        waiting.set(tab.id, resolve);
        setTimeout(() => resolve({ timeout: true }), WAIT_MS);
      });
      if (done.timeout) throw new Error("the page did not finish loading in " + WAIT_MS / 1000 + " seconds (if the site is checking your browser, open " + new URL(address).hostname.replace(/^www\./, "") + " yourself once and try again)");
      if (!done.saved) throw new Error(done.reason || "the page was not recorded");
      return { ok: true, cover: done.cover || null };
    } finally {
      waiting.delete(tab.id);
      Promise.resolve(ext.tabs.remove(tab.id)).catch(() => {});
    }
  }

  // ---- a site that refuses the extension's own requests ----
  // A site behind a bot check (Cloudflare) answers the extension's own requests with HTTP 403 until the browser has passed the check, and after that too while
  // the pass is kept for pages of the site only (bringPass, below, brings it over; p2p-host.js tries that first). A request made from inside a tab of the site is
  // answered. So when there is no pass to bring, the page is opened in a background tab (most checks pass by themselves in a few seconds; one that needs a tick in a box brings its tab to the front and
  // waits for the person), the page is asked for from inside that tab, and the tab is kept for the requests that follow (a chapter list of 130 pages) and
  // closed when nothing has used it for a while.
  const CHECK_TITLE = /just a moment|attention required|checking your browser|verify you are human|security check|one more step|请稍候|請稍候|ddos protection/i;
  const REFUSED_TITLE = /^\s*(403|access denied|forbidden)|403 forbidden|access denied/i;
  const CHECK_WAIT_MS = 120 * 1000;
  const QUIET_MS = 8 * 1000; // a check that is still showing after this is probably waiting for the person
  const PAUSE_MS = 3 * 60 * 1000; // a site that refuses its own tab too (or whose check was not passed) is not asked again for a while
  const IDLE_MS = 15 * 1000; // the tab is closed when nothing has asked through it for this long
  const MAX_BODY = 8 * 1024 * 1024;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bare = (host) => String(host).replace(/^www\./, "");
  const refusedAt = new Map(); // origin -> when, and why
  const opening = new Map(); // origin -> the tab being opened (shared by everything that needs it at once)
  const carriers = new Map(); // origin -> { tabId, at: the origin the tab ended on, busy, timer }

  // The check's pass, brought to where the extension's own requests see it. Cloudflare keeps the cookie that says the browser passed (cf_clearance)
  // "partitioned": it is sent with requests made by the site's own pages, and not with an extension's. WebToEpub copies such cookies into the plain cookie jar
  // before it asks (setPartitionCookies in its HttpClient.js), which is why it goes on working after the site's tab is closed; this does the same, for the
  // cookies the site keeps under its own name only. { ok: true, copied: how many were new } (0: there was nothing to bring, asking again will not help).
  async function bringPass(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" || !ext.cookies || !ext.cookies.getAll) return { ok: false, copied: 0 };
      const all = await ext.cookies.getAll({ url: u.href, partitionKey: {} }); // (an empty key: the partitioned cookies as well as the plain ones)
      const plain = new Map(all.filter((c) => !c.partitionKey).map((c) => [c.name + "|" + c.domain + "|" + c.path, c.value]));
      const host = bare(u.hostname);
      let copied = 0;
      for (const c of all) {
        if (!c.partitionKey || !c.partitionKey.topLevelSite) continue;
        let top = "";
        try {
          top = bare(new URL(c.partitionKey.topLevelSite).hostname);
        } catch (e) {
          top = "";
        }
        if (!top || !(host === top || host.endsWith("." + top))) continue; // kept under another site's name (the site inside someone else's page): not its pass
        if (plain.get(c.name + "|" + c.domain + "|" + c.path) === c.value) continue; // already there
        const details = { url: "https://" + String(c.domain).replace(/^\./, "") + (c.path || "/"), name: c.name, value: c.value, path: c.path || "/", secure: true, httpOnly: !!c.httpOnly };
        if (!c.hostOnly) details.domain = c.domain;
        if (c.sameSite) details.sameSite = c.sameSite;
        if (c.expirationDate) details.expirationDate = c.expirationDate;
        try {
          await ext.cookies.set(details);
          copied++;
        } catch (e) {
          // a cookie the browser will not take: the others still count
        }
      }
      return { ok: true, copied };
    } catch (e) {
      return { ok: false, copied: 0 }; // (a browser that does not know partitioned cookies)
    }
  }

  // Opens the page and waits until it is there (the check passed). { ok: true, tabId, at } with the tab left open, else { ok: false, error } with it closed.
  async function pass(address) {
    const tab = await ext.tabs.create({ url: address, active: false });
    const started = Date.now();
    let asked = false;
    let result = { ok: false, error: "the site's check was not passed within " + CHECK_WAIT_MS / 1000 + " seconds" };
    try {
      while (Date.now() - started < CHECK_WAIT_MS) {
        await sleep(1000);
        let t = null;
        try {
          t = await ext.tabs.get(tab.id);
        } catch (e) {
          return (result = { ok: false, error: "the tab was closed before the site's check was passed" });
        }
        const title = t.title || "";
        const challenged = CHECK_TITLE.test(title) || /__cf_chl/.test(t.url || "");
        if (t.status === "complete" && !challenged && title) {
          if (REFUSED_TITLE.test(title)) return (result = { ok: false, error: "the site refuses the browser too (" + title.slice(0, 40) + ")" });
          await sleep(1500); // (the cookie that says the check is passed is set as the page loads)
          await bringPass(address); // ... and is brought to where the extension's own requests see it, so the next ones need no tab
          let at = "";
          try {
            at = new URL(t.url).origin;
          } catch (e) {
            at = "";
          }
          return (result = { ok: true, tabId: tab.id, at });
        }
        if (challenged && !asked && Date.now() - started > QUIET_MS) {
          asked = true;
          await ext.tabs.update(tab.id, { active: true }); // it needs the person: the tab comes to the front
        }
      }
      return result;
    } finally {
      if (!result.ok) Promise.resolve(ext.tabs.remove(tab.id)).catch(() => {});
    }
  }

  // Runs in the site's tab: the page, asked for as the site's own pages ask (its cookies, its bot-check pass). The bytes go back as base64, so a page in
  // another encoding (GBK) is decoded by the rule that knows it. (Firefox: content.fetch is the page's own fetch.)
  async function pageFetch(u, max) {
    try {
      const o = { credentials: "include" };
      const res = await (typeof content !== "undefined" && content.fetch ? content.fetch(u, o) : fetch(u, o));
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > max) return { ok: false, error: "the page is too large" };
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { ok: true, status: res.status, url: res.url, type: res.headers.get("content-type") || "", body: btoa(bin) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  async function runIn(tabId, address) {
    if (ext.scripting && ext.scripting.executeScript) {
      const [{ result } = {}] = await ext.scripting.executeScript({ target: { tabId }, func: pageFetch, args: [address, MAX_BODY] });
      return result;
    }
    const [result] = await ext.tabs.executeScript(tabId, { code: "(" + pageFetch + ")(" + JSON.stringify(address) + ", " + MAX_BODY + ")" }); // (Firefox)
    return result;
  }

  const close = (origin) => {
    const c = carriers.get(origin);
    if (!c) return;
    carriers.delete(origin);
    clearTimeout(c.timer);
    Promise.resolve(ext.tabs.remove(c.tabId)).catch(() => {});
  };
  // The site's tab, opened if it is not there (or was closed by the person): { ok: true, carrier } or { ok: false, error }.
  async function carrierFor(origin, address) {
    const have = carriers.get(origin);
    if (have) {
      try {
        await ext.tabs.get(have.tabId);
        return { ok: true, carrier: have };
      } catch (e) {
        carriers.delete(origin);
        clearTimeout(have.timer);
      }
    }
    if (!opening.has(origin)) {
      opening.set(origin, pass(address).catch((e) => ({ ok: false, error: (e && e.message) || String(e) })).then((r) => {
        opening.delete(origin);
        if (r.ok) carriers.set(origin, { tabId: r.tabId, at: r.at, busy: 0, timer: null });
        return r;
      }));
    }
    const r = await opening.get(origin);
    return r.ok ? { ok: true, carrier: carriers.get(origin) } : r;
  }

  // The page at `url`, asked for from inside a tab of its site: { ok: true, status, url, type, body (base64) }, else { ok: false, error }. Never throws.
  async function fetchIn(url) {
    let origin = "";
    let address = "";
    try {
      const u = new URL(url);
      origin = u.origin;
      address = u.protocol === "https:" ? u.href.split("#")[0] : "";
    } catch (e) {
      address = "";
    }
    if (!address) return { ok: false, error: "not an https address" };
    const refused = refusedAt.get(origin);
    if (refused && Date.now() - refused.at < PAUSE_MS) return { ok: false, error: refused.why + " (a moment ago: not asked again yet)" };
    const no = (why) => (refusedAt.set(origin, { at: Date.now(), why }), close(origin), { ok: false, error: why });
    try {
      const got = await carrierFor(origin, address);
      if (!got.ok || !got.carrier) return no(got.error || "the site's tab could not be opened");
      const c = got.carrier;
      clearTimeout(c.timer);
      c.busy++;
      let result = null;
      try {
        // (a site that moved the tab to its other name, www or not, is asked under that name: a page can only ask its own site)
        const target = c.at && c.at !== origin && bare(new URL(c.at).hostname) === bare(new URL(origin).hostname) ? c.at + address.slice(origin.length) : address;
        result = await runIn(c.tabId, target);
      } finally {
        c.busy--;
        if (!c.busy && carriers.get(origin) === c) c.timer = setTimeout(() => close(origin), IDLE_MS);
      }
      if (!result || !result.ok) return no("the page could not be read through the site's tab" + (result && result.error ? " (" + result.error + ")" : ""));
      if (result.status === 403) return no("the site refuses its own tab too (HTTP 403)");
      return result;
    } catch (e) {
      return no((e && e.message) || String(e));
    }
  }

  return { visit, fetchIn, bringPass, MARK };
})();
