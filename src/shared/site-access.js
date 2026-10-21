// Which sites the browser has let the extension read. The novel sites are optional permissions: none is asked for at install, each is asked for
// the first time it is used (the popup's Allow button, or the first Fetch on its page), so the install shows only what the extension always needs.
//
//   patternOf(url)      the permission a site's address needs: https://*.<host>/* (the same one the popup asks for)
//   has(url)            whether the browser has given it (sites the extension always reads, and a browser with no such question, say yes)
//   guard(url)          has(), or the need is noted (for the popup) and an error thrown that says what to do
//   fetch(url, opts)    guard(url), then fetch
//   pending()           the sites something asked for that are not allowed yet: [{ host, pattern, at }]
//   covered(origins, match)  whether one of the granted origins (permissions.getAll) covers a content script's match pattern
//   request(patterns)   asks the browser (only from a click: the popup, the access page); the answer is whether it was given
//   forget(patterns)    drops the notes of sites that are allowed now
//
// Chrome's offscreen page (where the sync and the fetching run) has no permissions or storage API: there the questions go to the background
// (messages access:has and access:note, answered by answerMessage below, which the background calls).
(function (root) {
  const KEY = "accessNeeded";
  // read with no question: the AI services, the library's own site, and this computer (tests, the e2e site)
  const ALWAYS = /^(generativelanguage|translate)\.googleapis\.com$|(^|\.)heavenlydao\.com$|^p2p-library\.pages\.dev$|^localhost$|^127\.0\.0\.1$/;
  const KNOWN_MS = 30 * 1000; // an answer "yes" is kept this long (the questions come in bursts)
  const NOTE_MS = 60 * 1000; // a site's need is written to storage at most this often

  const extOf = () => (typeof browser !== "undefined" && browser.runtime ? browser : typeof chrome !== "undefined" && chrome.runtime ? chrome : null);

  function partsOf(url) {
    let u;
    try { u = new URL(String(url)); } catch (e) { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const full = u.hostname.toLowerCase();
    return { host: full.replace(/^www\./, ""), full };
  }
  const patternOf = (url) => { const p = partsOf(url); return p ? "https://*." + p.host + "/*" : ""; };
  const hostOfPattern = (pattern) => String(pattern).replace(/^https:\/\/\*\./, "").replace(/\/\*$/, "");

  const known = new Map(); // host -> time until which "yes" holds
  const noted = new Map(); // host -> time of the last note

  // the question itself, where the permissions API is
  async function ask(ext, pattern) {
    return !!(await ext.permissions.contains({ origins: [pattern] }).catch(() => false));
  }

  async function has(url, ext = extOf()) {
    const p = partsOf(url);
    if (!p || ALWAYS.test(p.host) || !ext) return true;
    if ((known.get(p.full) || 0) > Date.now()) return true;
    // (asked for this very host: a grant of the site's own address, https://host/*, or of the whole site, https://*.host/*, both cover it)
    const pattern = "https://" + p.full + "/*";
    let yes;
    if (ext.permissions && ext.permissions.contains) yes = await ask(ext, pattern);
    else if (ext.runtime && ext.runtime.sendMessage) {
      const r = await Promise.resolve(ext.runtime.sendMessage({ type: "access:has", pattern })).catch(() => null);
      if (!r || typeof r.yes !== "boolean") return true; // (nobody answered: not this module's place to stop the request)
      yes = r.yes;
    } else return true;
    if (yes) known.set(p.full, Date.now() + KNOWN_MS);
    else known.delete(p.full);
    return yes;
  }

  async function note(host, ext = extOf(), always = false) {
    if (!ext || (!always && (noted.get(host) || 0) > Date.now() - NOTE_MS)) return;
    noted.set(host, Date.now());
    const pattern = "https://*." + host + "/*";
    if (ext.storage && ext.storage.local) {
      const got = (await ext.storage.local.get(KEY).catch(() => ({})))[KEY] || {};
      got[host] = Date.now();
      await ext.storage.local.set({ [KEY]: got }).catch(() => {});
    } else if (ext.runtime && ext.runtime.sendMessage) {
      await Promise.resolve(ext.runtime.sendMessage({ type: "access:note", pattern })).catch(() => {});
    }
  }

  async function guard(url, ext = extOf()) {
    if (await has(url, ext)) return;
    const p = partsOf(url);
    await note(p.host, ext);
    const err = new Error("not allowed to read " + p.host + " yet: open the extension's popup and press Allow");
    err.needsAccess = p.host;
    throw err;
  }

  async function guardedFetch(url, opts) {
    await guard(typeof url === "string" ? url : url && url.url ? url.url : String(url));
    return globalThis.fetch(url, opts);
  }

  async function pending(ext = extOf()) {
    if (!ext || !ext.storage || !ext.storage.local) return [];
    const got = (await ext.storage.local.get(KEY).catch(() => ({})))[KEY] || {};
    const out = [];
    for (const [host, at] of Object.entries(got)) {
      if (ext.permissions && (await ask(ext, "https://" + host + "/*"))) continue;
      out.push({ host, pattern: "https://*." + host + "/*", at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async function forget(patterns, ext = extOf()) {
    if (!ext || !ext.storage || !ext.storage.local) return;
    const got = (await ext.storage.local.get(KEY).catch(() => ({})))[KEY] || {};
    for (const p of patterns) delete got[hostOfPattern(p)];
    known.clear();
    await ext.storage.local.set({ [KEY]: got }).catch(() => {});
  }

  async function request(patterns, ext = extOf()) {
    const yes = !!(await ext.permissions.request({ origins: patterns }).catch(() => false));
    if (yes) await forget(patterns, ext);
    return yes;
  }

  // For the background: the answers the offscreen page asks for. Returns a promise of the reply, or null for a message that is not one of these.
  function answerMessage(message, ext = extOf()) {
    if (!message) return null;
    if (message.type === "access:has") return ask(ext, String(message.pattern)).then((yes) => ({ yes }));
    if (message.type === "access:note") return note(hostOfPattern(message.pattern), ext, true).then(() => ({ ok: true }));
    return null;
  }

  // Whether the browser's granted origins ("https://*.host/*", "https://host/*", "https://*/*", "<all_urls>") cover a match pattern like
  // "https://www.69shuba.com/book/*": the scripts of a site are added once it is allowed (one question for all of them: permissions.getAll).
  function covered(origins, match) {
    const m = /^(\*|https?):\/\/([^/]+)\//.exec(String(match));
    if (!m) return false;
    const host = m[2].toLowerCase();
    return (origins || []).some((o) => {
      if (o === "<all_urls>" || o === "https://*/*" || o === "*://*/*") return true;
      const g = /^(\*|https?):\/\/([^/]+)\//.exec(String(o));
      if (!g) return false;
      const gh = g[2].toLowerCase();
      if (gh === host) return true;
      const base = gh.startsWith("*.") ? gh.slice(2) : "";
      const bare = host.startsWith("*.") ? host.slice(2) : host;
      return !!base && (bare === base || bare.endsWith("." + base));
    });
  }

  const api = { KEY, covered, ALWAYS, patternOf, hostOfPattern, has, guard, fetch: guardedFetch, pending, forget, request, answerMessage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SiteAccess = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
