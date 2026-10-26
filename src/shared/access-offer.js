// The Allow card in the library site's tab: when something asks for a site the browser has not let the extension read (site-access.js notes it), the card is put
// in the tab of the library site that is open and showing (site-bridge.js: the message "site:allow"), where the person is looking, not only on the icon's "!". A
// card answered "Not now" is not shown again for that site for a quarter of an hour. Runs in the background, after site-access.js and site-matches.js.
(function (root) {
  const MUTE_KEY = "accessMuted";
  const MUTE_MS = 15 * 60 * 1000;
  const REOFFER_MS = 15 * 1000; // the same sites are not offered again at once
  const extOf = () => (typeof browser !== "undefined" && browser.runtime ? browser : chrome);
  let last = { at: 0, sig: "" };

  async function muted(ext) {
    const got = (await ext.storage.local.get(MUTE_KEY).catch(() => ({})))[MUTE_KEY] || {};
    const now = Date.now();
    return new Set(Object.keys(got).filter((h) => got[h] > now));
  }
  async function mute(hosts, ext = extOf()) {
    const got = (await ext.storage.local.get(MUTE_KEY).catch(() => ({})))[MUTE_KEY] || {};
    const now = Date.now();
    for (const h of Object.keys(got)) if (got[h] <= now) delete got[h];
    for (const h of hosts) got[h] = now + MUTE_MS;
    await ext.storage.local.set({ [MUTE_KEY]: got }).catch(() => {});
  }
  // -> how many tabs were told
  async function offer(force, ext = extOf()) {
    if (typeof SiteAccess === "undefined") return 0;
    const skip = await muted(ext);
    const hosts = (await SiteAccess.pending(ext).catch(() => [])).map((p) => p.host).filter((h) => !skip.has(h)).slice(0, 5);
    if (!hosts.length) return 0;
    const sig = hosts.join(",");
    if (!force && sig === last.sig && Date.now() - last.at < REOFFER_MS) return 0;
    last = { at: Date.now(), sig };
    const tabs = await Promise.resolve(ext.tabs.query({ url: root.SITE_BRIDGE_MATCHES || [], active: true })).catch(() => []);
    let told = 0;
    for (const t of tabs) {
      try { await ext.tabs.sendMessage(t.id, { type: "site:allow", hosts }); told++; } catch (e) { /* the tab has no bridge (yet) */ }
    }
    return told;
  }
  // messages from the site's tab (a content script of this extension)
  function answerMessage(message, sender, ext = extOf()) {
    if (!message || !sender || sender.id !== ext.runtime.id) return null;
    if (message.type === "access:muted" && Array.isArray(message.hosts)) return mute(message.hosts.filter((h) => /^[a-z0-9.-]{3,100}$/i.test(h)).slice(0, 5), ext).then(() => ({ ok: true }));
    if (message.type === "access:check") return offer(true, ext).then((told) => ({ told }));
    return null;
  }

  const api = { offer, answerMessage, mute };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AccessOffer = api;
})(typeof self !== "undefined" ? self : globalThis);
