// The Referer a site's pictures are asked for with. A browser sends the page that shows a picture as its Referer, and some sites refuse a picture without it
// (Mihon's Madara sources send the chapter's page for every picture). An extension page's fetch cannot set that header, so while a chapter's pictures are being
// fetched a declarativeNetRequest session rule sets it for the picture hosts, for requests the extension itself makes.
//
//   use(urls, referer)   sets the Referer for the hosts of these addresses; resolves a function that takes it away again (call it when the fetching is done)
//   answerMessage(msg)   for the extension's service worker: Chrome's offscreen page has no declarativeNetRequest, so it asks the worker (referer:set, referer:clear)
//
// Two chapters of one site fetched together: the latest Referer is the one set, and when it is released the one before it is set again. A browser without the API,
// or without the permission for a host, goes on without: the pictures are then asked for as before.
(function (root) {
  const extOf = () => (typeof browser !== "undefined" && browser.runtime ? browser : typeof chrome !== "undefined" && chrome.runtime ? chrome : null);
  const dnrOf = () => {
    const ext = extOf();
    return ext && ext.declarativeNetRequest && ext.declarativeNetRequest.updateSessionRules ? ext.declarativeNetRequest : null;
  };

  // one session rule per host: its id from the host's name, so a worker that forgot what it set can still replace or remove it
  function ruleId(host) {
    let h = 5381;
    for (let i = 0; i < host.length; i++) h = ((h * 33) ^ host.charCodeAt(i)) >>> 0;
    return 100000 + (h % 800000);
  }
  // initiator: the extension's own id (Chrome: its pages' requests come from there); Firefox's pages have an address of their own per install, so none is named
  function ruleFor(host, referer, initiator) {
    return {
      id: ruleId(host),
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: referer }] },
      condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"], ...(initiator ? { initiatorDomains: [initiator] } : {}) }
    };
  }

  async function setHere(host, referer) {
    const dnr = dnrOf();
    if (!dnr) throw new Error("no declarativeNetRequest");
    const ext = extOf();
    const initiator = typeof browser !== "undefined" ? "" : ext.runtime.id;
    await dnr.updateSessionRules({ removeRuleIds: [ruleId(host)], addRules: [ruleFor(host, referer, initiator)] });
  }
  async function clearHere(host) {
    const dnr = dnrOf();
    if (dnr) await dnr.updateSessionRules({ removeRuleIds: [ruleId(host)] });
  }

  // Sets (referer given) or removes the rule: here, or by asking the service worker when this page has no such API.
  async function apply(host, referer) {
    if (dnrOf()) return referer ? setHere(host, referer) : clearHere(host);
    const ext = extOf();
    const r = await ext.runtime.sendMessage(referer ? { type: "referer:set", host, referer } : { type: "referer:clear", host });
    if (r && r.error) throw new Error(r.error);
  }

  const held = new Map(); // host -> the Referers set for it, in the order asked
  const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ""; } };

  async function use(urls, referer) {
    if (!/^https?:\/\//.test(String(referer || ""))) return () => {};
    const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
    const mine = [];
    for (const host of hosts) {
      const stack = held.get(host) || [];
      stack.push(referer);
      held.set(host, stack);
      try {
        await apply(host, referer);
        mine.push(host);
      } catch (e) {
        stack.pop(); // (no API, or no permission for the host: the pictures are asked for without it)
        if (!stack.length) held.delete(host);
      }
    }
    return () => {
      for (const host of mine) {
        const stack = held.get(host) || [];
        const at = stack.lastIndexOf(referer);
        if (at >= 0) stack.splice(at, 1);
        if (stack.length) apply(host, stack[stack.length - 1]).catch(() => {});
        else { held.delete(host); apply(host, "").catch(() => {}); }
      }
    };
  }

  // The service worker's side of apply(): the message, or null when it is not one of ours.
  function answerMessage(msg) {
    if (!msg || (msg.type !== "referer:set" && msg.type !== "referer:clear")) return null;
    const host = String(msg.host || "").toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) return Promise.resolve({ error: "not a host" });
    const done = msg.type === "referer:set" ? (/^https?:\/\//.test(String(msg.referer || "")) ? setHere(host, String(msg.referer).slice(0, 2000)) : Promise.reject(new Error("not an address"))) : clearHere(host);
    return done.then(() => ({ ok: true }), (e) => ({ error: String((e && e.message) || e) }));
  }

  const api = { use, answerMessage, ruleFor, ruleId };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Referer = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
