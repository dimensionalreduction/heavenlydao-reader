// The public pool, from this side: once a day it downloads the pool (what many people agreed on, and Gemini checked: a read of a file, nothing about this library goes with it) so
// translations can start from it (pool-hints.js), and, when the person agreed (Settings > Translation > Add my terms to the public pool: the library's setting sharePool, off until
// they say so), sends the terms they made that were not sent before. What is sent (TermPool.contribution): pairs [source term, rendering] they typed or kept from Gemini, of
// novels with a key that means the same on every device; no name, character or sentence, nothing from the site or a copy, no novel, no person, no time. Each pair goes once. A request
// carries a proof of work (a little work) in place of a login. The service is functions/_pool.js (docs/CENTRAL-POOL.md).
//
// Runs in the background script; never throws and never holds up a translation. Needs term-pool.js and glossary-server.js before it.
var PoolShare = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const BASE = "https://pool.heavenlydao.com/api/pool"; // (the VPS: turn-server/pool; the same routes are in site/functions/api/pool for Cloudflare)
  const POW_BITS = 14; // the same as the service asks (functions/_pool.js POW_BITS)
  const MAX_PAIRS = 200;
  const DAY = 24 * 60 * 60 * 1000;

  async function sha256Hex(text) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function zeroBits(hex, bits) {
    for (let i = 0, left = bits; left > 0; i++, left -= 4) {
      const nibble = parseInt(hex[i], 16);
      if (left >= 4 ? nibble !== 0 : nibble >> (4 - left) !== 0) return false;
    }
    return true;
  }
  const plain = { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }; // (no cookies, no page address, nothing kept)

  // One request: the pairs, the time, and the nonce that proves them. -> did the service count it
  async function post(pairs, fetcher = fetch) {
    const t = Date.now();
    const proven = JSON.stringify({ v: 1, t, pairs });
    let n = 0;
    while (!zeroBits(await sha256Hex(n + ":" + proven), POW_BITS)) n++;
    const res = await fetcher(BASE + "/contribute", { ...plain, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, t, pairs, n: String(n) }) });
    return res.ok;
  }

  // The terms made here that were not sent, sent in requests of 200; what was sent is remembered (a short hash of each pair, not the pairs), so each goes once.
  async function sendNew(fetcher) {
    const stored = await ext.storage.local.get(["glossaryLibrary", "poolSent"]);
    const sent = new Set(stored.poolSent || []);
    const glossaries = Object.entries(stored.glossaryLibrary || {}).filter(([id]) => !id.includes("@")).map(([id, g]) => ({ id, terms: (g && g.terms) || [] }));
    const fresh = [];
    for (const pair of TermPool.contribution(glossaries).pairs) {
      const key = (await sha256Hex(pair[0] + "|" + pair[1].toLowerCase())).slice(0, 12);
      if (!sent.has(key)) fresh.push([pair, key]);
    }
    let sentNow = 0;
    for (let i = 0; i < fresh.length; i += MAX_PAIRS) {
      const batch = fresh.slice(i, i + MAX_PAIRS);
      if (!(await post(batch.map(([p]) => p), fetcher))) break;
      for (const [, key] of batch) sent.add(key);
      sentNow += batch.length;
      await ext.storage.local.set({ poolSent: [...sent] });
    }
    return sentNow;
  }

  // The public pool, kept for translating: [[source, rendering]].
  async function download(fetcher = fetch) {
    const res = await fetcher(BASE + "/snapshot", plain);
    if (!res.ok) return 0;
    const data = await res.json();
    if (!data || data.v !== 1 || !Array.isArray(data.entries)) return 0;
    const entries = data.entries.filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string").slice(0, 100000).map((e) => [e[0], e[1]]);
    await ext.storage.local.set({ centralPool: { at: Date.now(), entries } });
    return entries.length;
  }

  // Once a day (or when forced): download the pool when the pool is on, and send what is new when the person agreed.
  async function maybeRun(options) {
    try {
      const o = options || {};
      const now = Date.now();
      const { poolShareAt } = await ext.storage.local.get("poolShareAt");
      if (!o.force && now - (poolShareAt || 0) < DAY) return { skipped: true };
      await ext.storage.local.set({ poolShareAt: now });
      const settings = await GlossaryServer.api("GET", "/api/settings").catch(() => null);
      if (!settings) return { skipped: true };
      const out = { downloaded: 0, sent: 0 };
      if (settings.poolHints !== false) out.downloaded = await download(o.fetcher).catch(() => 0);
      if (settings.sharePool === true) out.sent = await sendNew(o.fetcher).catch(() => 0);
      return out;
    } catch (e) {
      return { error: true };
    }
  }

  return { maybeRun, sendNew, download, post, zeroBits, sha256Hex };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PoolShare;
