// What the notifications are made from, with no page around it (tests: test/notify.test.js), the same for the extension (notice-host.js,
// with no page of the site open) and the site (vendor/notify.js: bell.js has the header's bell, the Settings tab and what watches for events).
//
//   KINDS          the kinds of events, each switched on or off in Settings › Notifications
//   SNOOZES        how long notifications can be turned off for: [id, ms, label]
//   snoozed()      whether notifications are turned off for a while now (settings.until, a time in ms)
//   allowed()      whether an event is told: notifications on and not turned off for a while, its kind on, its library on
//   add()          a notification put first in the list (one with the same id replaced), the list kept to MAX
//   newInLibrary() what a followed library's list of novels has that it had not before: new novels, novels with more chapters
//   newChapters()  your novels with chapters past the last one they had (by chapter number)
(function (root) {
  const KINDS = [
    ["join", "Requests to join your library", "A device asks to join: Allow or Refuse it from the notification"],
    ["devices", "Your devices", "A device joined your library, or was taken off it"],
    ["pr", "Pull requests", "Readers' changes to the novels you share, in your Inbox"],
    ["chapters", "New chapters in your library", "Chapters past the last one a novel had (the extension fetched and translated them)"],
    ["follow", "Libraries you follow", "Their new novels, and new chapters of their novels"],
    ["editions", "Other editions", "Chapters other editions of your novels have past yours (for those set to “Tell me about new chapters”)"]
  ];
  const SNOOZES = [["30m", 30 * 60 * 1000, "30 minutes"], ["1h", 60 * 60 * 1000, "1 hour"], ["2h", 2 * 60 * 60 * 1000, "2 hours"]];
  const MAX = 100;
  const OWN = "own"; // the library key of your own library's events (whichever library that is)

  // settings: { on, until, kinds: { <kind>: false }, libs: { <library id or "own">: false } } (what is not there is on); until: the time
  // (ms) notifications are off until; "off until turned on" is `on` false
  const snoozed = (settings, at = Date.now()) => !!(settings && settings.until > at);
  function allowed(settings, kind, lib, at) {
    const s = settings || {};
    if (s.on === false || snoozed(s, at)) return false;
    if (s.kinds && s.kinds[kind] === false) return false;
    if (lib && s.libs && s.libs[lib] === false) return false;
    return true;
  }

  function add(list, n, max = MAX) {
    return [n].concat((list || []).filter((x) => x.id !== n.id)).slice(0, max);
  }

  // prev: { <book id>: chapters in its list } as last seen; next: { <book id>: { title, n } } now. -> [{ type: "novel" | "chapters", id, title,
  // added }]. prev null: nothing is new yet (the first look at the library).
  function newInLibrary(prev, next) {
    if (!prev) return [];
    const out = [];
    for (const [id, b] of Object.entries(next || {})) {
      const n = Number(b.n) || 0;
      if (!(id in prev)) out.push({ type: "novel", id, title: b.title || id, added: n });
      else if (n > (Number(prev[id]) || 0)) out.push({ type: "chapters", id, title: b.title || id, added: n - (Number(prev[id]) || 0) });
    }
    return out;
  }

  // prev: { <novel>: last chapter number }, next the same now. -> [{ name, from, to }] for the novels whose last chapter is a later one.
  // A novel not in prev is new to the library: not counted (an EPUB uploaded, a novel your devices sent), it is only noted.
  function newChapters(prev, next) {
    if (!prev) return [];
    const out = [];
    for (const [name, last] of Object.entries(next || {})) {
      if (!(name in prev)) continue;
      if (last > prev[name]) out.push({ name, from: prev[name], to: last });
    }
    return out;
  }

  const api = { KINDS, SNOOZES, MAX, OWN, snoozed, allowed, add, newInLibrary, newChapters };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Notify = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
