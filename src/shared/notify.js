// What the notifications are made from, with no page around it (tests: test/notify.test.js), the same for the extension (notice-host.js,
// with no page of the site open) and the site (vendor/notify.js: bell.js has the header's bell, the Settings tab and what watches for events).
//
//   KINDS          the kinds of events, each switched on or off in Settings › Notifications
//   SNOOZES        how long notifications can be turned off for: [id, ms, label]
//   snoozed()      whether notifications are turned off for a while now (settings.until, a time in ms)
//   allowed()      whether an event is told: notifications on and not turned off for a while, its kind on
//   add()          a notification put first in the list (one with the same id replaced), the list kept to MAX
//   newChapters()  your novels with chapters past the last one they had (by chapter number)
(function (root) {
  const KINDS = [
    ["chapters", "New chapters in your library", "Chapters past the last one a novel had (the extension fetched and translated them)"]
  ];
  const SNOOZES = [["30m", 30 * 60 * 1000, "30 minutes"], ["1h", 60 * 60 * 1000, "1 hour"], ["2h", 2 * 60 * 60 * 1000, "2 hours"]];
  const MAX = 100;
  const OWN = "own"; // the library key of your own library's events (whichever library that is)

  // settings: { on, until, kinds: { <kind>: false } } (what is not there is on); until: the time
  // (ms) notifications are off until; "off until turned on" is `on` false
  const snoozed = (settings, at = Date.now()) => !!(settings && settings.until > at);
  function allowed(settings, kind, at) {
    const s = settings || {};
    if (s.on === false || snoozed(s, at)) return false;
    if (s.kinds && s.kinds[kind] === false) return false;
    return true;
  }

  function add(list, n, max = MAX) {
    return [n].concat((list || []).filter((x) => x.id !== n.id)).slice(0, max);
  }

  // prev: { <novel>: last chapter number }, next the same now. -> [{ name, from, to }] for the novels whose last chapter is a later one.
  // A novel not in prev is new to the library: not counted (an EPUB uploaded, a novel the extension sent), it is only noted.
  function newChapters(prev, next) {
    if (!prev) return [];
    const out = [];
    for (const [name, last] of Object.entries(next || {})) {
      if (!(name in prev)) continue;
      if (last > prev[name]) out.push({ name, from: prev[name], to: last });
    }
    return out;
  }

  const api = { KINDS, SNOOZES, MAX, OWN, snoozed, allowed, add, newChapters };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Notify = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
