// How much of the comics' pictures this browser keeps (the popup's Library tab: GB, 10 by default); the ones read longest ago go first.
//
//   settings()       { maxGB }: what the popup saved (Chrome's offscreen page has no storage of its own: it asks the worker)
//   forgetSettings() read them again next time (the popup, after saving)
(function (root) {
  const MAX_KEY = "picturesMaxGB";
  const DEFAULT_MAX_GB = 10;
  const extOf = () => (typeof browser !== "undefined" && browser.runtime ? browser : typeof chrome !== "undefined" && chrome.runtime ? chrome : null);

  let cached = null;
  let cachedAt = 0;
  async function settings() {
    if (cached && Date.now() - cachedAt < 5000) return cached;
    const ext = extOf();
    let raw = null;
    if (ext && ext.storage && ext.storage.local) {
      const s = await ext.storage.local.get([MAX_KEY]);
      raw = { maxGB: s[MAX_KEY] };
    } else if (ext) {
      raw = await ext.runtime.sendMessage({ type: "pictures:settings" }).catch(() => null);
    }
    const max = Number(raw && raw.maxGB);
    cached = { maxGB: max > 0 ? max : DEFAULT_MAX_GB };
    cachedAt = Date.now();
    return cached;
  }
  const forgetSettings = () => { cached = null; };

  const api = { MAX_KEY, DEFAULT_MAX_GB, settings, forgetSettings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PictureLimit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
