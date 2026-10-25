// Fish Audio's speech for the library site's Listen tab. Fish Audio's API does not answer a web page's calls (it has no route for the browser's check
// before them), so the page asks this extension, which makes the call in its own name with the person's own key, and gives the audio back:
//   { type: "fish:speak", text, voice, model, key }  -> { audio (mp3, base64), type } | { error, needsAccess? }
//   { type: "fish:credit", key }                     -> { credit (dollars) } | { error, needsAccess? }
// The key is not kept: it comes with each ask. Only a tab of the library site may ask (site-bridge.js relays it), only api.fish.audio's speech and balance
// addresses are called, and only once the browser has let the extension talk to api.fish.audio (an optional permission, asked for in the popup: site-access.js).
// Runs in the background script, after site-matches.js and site-access.js.
var FishSpeech = (function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const API = "https://api.fish.audio";
  const MAX_TEXT = 5000;
  const VOICE = /^[0-9a-f]{32}$/;
  const MODEL = /^[a-z0-9][a-z0-9.\-]{0,40}$/;
  const KEY = /^[\x21-\x7e]{8,200}$/; // (visible characters only: it goes in a header)
  const SITE_MATCHES = typeof SITE_BRIDGE_MATCHES !== "undefined" ? SITE_BRIDGE_MATCHES : [];
  const onSite = (url) => typeof url === "string" && SITE_MATCHES.some((m) => url.startsWith(m.replace(/\*$/, "")));

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function fail(res) {
    let why = "";
    try { const j = JSON.parse(await res.text()); why = String(j.message || j.error || ""); } catch (e) { /* not JSON */ }
    if (res.status === 401) return "Fish Audio did not accept the key (401)";
    if (res.status === 402) return "No API credit on Fish Audio for this model (402): the free model needs none";
    if (res.status === 429) return "Fish Audio's limit for this key: wait a minute (429)";
    return "Fish Audio said " + res.status + (why ? ": " + why.slice(0, 160) : "");
  }
  // Fish Audio's address allowed for this extension, or the need is noted (the popup then has Allow): an error that says so.
  async function allowed(path) {
    try {
      await SiteAccess.guard(API + path);
      return null;
    } catch (e) {
      if (e && e.needsAccess) return { error: "Allow api.fish.audio: open the extension's popup and press Allow", needsAccess: true };
      throw e;
    }
  }

  async function speak(m, doFetch) {
    const text = typeof m.text === "string" ? m.text.trim() : "";
    if (!text || text.length > MAX_TEXT) return { error: "no text, or too long" };
    if (typeof m.key !== "string" || !KEY.test(m.key)) return { error: "no Fish Audio key" };
    if (typeof m.model !== "string" || !MODEL.test(m.model)) return { error: "no model" };
    if (m.voice && !(typeof m.voice === "string" && VOICE.test(m.voice))) return { error: "not a Fish Audio voice" };
    const no = await allowed("/v1/tts");
    if (no) return no;
    const body = Object.assign({ text, format: "mp3" }, m.voice ? { reference_id: m.voice } : {});
    const res = await doFetch(API + "/v1/tts", { method: "POST", headers: { Authorization: "Bearer " + m.key, "Content-Type": "application/json", model: m.model }, body: JSON.stringify(body) });
    if (!res.ok) return { error: await fail(res) };
    return { audio: b64(await res.arrayBuffer()), type: "audio/mpeg" };
  }
  async function credit(m, doFetch) {
    if (typeof m.key !== "string" || !KEY.test(m.key)) return { error: "no Fish Audio key" };
    const no = await allowed("/wallet/self/api-credit");
    if (no) return no;
    const res = await doFetch(API + "/wallet/self/api-credit", { headers: { Authorization: "Bearer " + m.key } });
    if (!res.ok) return { error: await fail(res) };
    const j = await res.json().catch(() => ({}));
    return { credit: Number(j.credit) || 0 };
  }

  // For the background's message listener: a promise of the reply, or null for a message that is not Fish Audio's.
  function answer(message, sender, doFetch = (u, o) => fetch(u, o)) {
    if (!message || (message.type !== "fish:speak" && message.type !== "fish:credit")) return null;
    if (!sender || sender.id !== ext.runtime.id || !sender.tab || !onSite(sender.url)) return Promise.resolve({ error: "not the library's site" });
    return (message.type === "fish:speak" ? speak(message, doFetch) : credit(message, doFetch)).catch((e) => ({ error: "Fish Audio could not be reached" + (e && e.message ? " (" + e.message + ")" : "") }));
  }

  const api = { answer, speak, credit, API };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
