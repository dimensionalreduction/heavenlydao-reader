// The extension's notifications as the system shows them (Chrome's service worker, Firefox's background page): what notice-host.js tells.
// One is shown only while no page of the library site is open in this browser: an open page tells you itself (its bell, bell.js). Clicking it
// opens the site on what it is about (a page of it already open is brought to the front).
// The site's address is the one last opened in this browser (site-bridge.js says it), else the project's.
(function (root) {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const firefox = typeof browser !== "undefined";
  // the site's addresses: where site-bridge.js runs (site-matches.js, from the manifest; a --dev build adds localhost:3000)
  const SITE_MATCHES = typeof SITE_BRIDGE_MATCHES !== "undefined" ? SITE_BRIDGE_MATCHES : [];
  const onSite = (url) => typeof url === "string" && SITE_MATCHES.some((m) => url.startsWith(m.replace(/\*$/, "")));
  const DEFAULT_SITE = "https://heavenlydao.com/";
  const TARGETS = "noticeTargets"; // notification id -> { href } (kept in storage: Chrome's service worker sleeps in between)

  const siteTabs = () => Promise.resolve(ext.tabs.query({ url: SITE_MATCHES })).catch(() => []);
  async function targets() {
    return (await ext.storage.local.get(TARGETS))[TARGETS] || {};
  }

  // -> whether it was shown
  async function show(item) {
    if (!ext.notifications || !item || !item.id) return false;
    if ((await siteTabs()).length) return false;
    const opts = { type: "basic", iconUrl: ext.runtime.getURL("icon-128.png"), title: String(item.title || "heavenlydao.com").slice(0, 200), message: String(item.text || "").slice(0, 300) };
    if (!firefox) opts.priority = 0;
    await ext.notifications.create(item.id, opts);
    const t = await targets();
    t[item.id] = { href: item.href || "#/", at: Date.now() };
    for (const id of Object.keys(t).sort((a, b) => t[a].at - t[b].at).slice(0, -50)) delete t[id]; // (the last 50)
    await ext.storage.local.set({ [TARGETS]: t });
    return true;
  }

  // The site on `href`: a page of it already open, brought to the front; else a new tab of the address last used.
  async function openSite(href) {
    const tabs = await siteTabs();
    if (tabs.length) {
      const t = tabs.find((x) => x.active) || tabs[0];
      await ext.tabs.update(t.id, { active: true, url: t.url.split("#")[0] + href });
      if (ext.windows) await Promise.resolve(ext.windows.update(t.windowId, { focused: true })).catch(() => {});
      return;
    }
    const site = (await ext.storage.local.get("siteAddress")).siteAddress || DEFAULT_SITE;
    await ext.tabs.create({ url: site + href });
  }

  if (ext.notifications) {
    ext.notifications.onClicked.addListener(async (id) => {
      const t = (await targets())[id];
      ext.notifications.clear(id);
      if (t) openSite(t.href).catch(() => {});
    });
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    // the offscreen page asks for one to be shown (Chrome)
    if (msg.type === "notice:show") {
      show(msg.item).then((shown) => sendResponse({ shown }), () => sendResponse({ shown: false }));
      return true;
    }
    // a page of the site opened in this browser (site-bridge.js): where clicking a notification goes when none is open
    if (msg.type === "site:seen" && sender && sender.tab && onSite(sender.url) && onSite(msg.url) && msg.url.length < 300) {
      ext.storage.local.set({ siteAddress: msg.url.split("#")[0] }).catch(() => {});
    }
  });

  const NoticeBg = { show, openSite };
  root.NoticeBg = NoticeBg;
})(typeof self !== "undefined" ? self : this);
