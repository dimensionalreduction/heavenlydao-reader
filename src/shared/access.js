// The Allow card the library site's tab shows (site-bridge.js puts this page in a frame there) when the extension needs a site it has not been allowed to read: a click on
// Allow here is what the browser needs to ask the person (permissions.request is answered only to a click in one of the extension's own pages). It also opens on its own, with
// ?h=<host> for each site, as the popup's Allow does. It tells the page that holds it when it is done: { p2pread: "access", done: true, declined: [hosts], allowed: [hosts] }.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const q = new URLSearchParams(location.search);
  const hosts = q.getAll("h").filter((h) => /^[a-z0-9.-]{3,100}$/i.test(h)).slice(0, 5);
  document.documentElement.dataset.theme = q.get("t") === "dark" ? "dark" : "light";
  const $ = (id) => document.getElementById(id);
  const allowed = [];
  let at = 0;
  const tell = (m) => { try { parent.postMessage(Object.assign({ p2pread: "access" }, m), "*"); } catch (e) { /* not in a frame */ } };
  async function show() {
    while (at < hosts.length && (await SiteAccess.has("https://" + hosts[at] + "/", ext))) at++;
    if (at >= hosts.length) return tell({ done: true, allowed });
    $("title").textContent = "Allow " + hosts[at];
    $("more").textContent = hosts.length - at > 1 ? "+" + (hosts.length - at - 1) + " more" : "";
    $("yes").disabled = false;
  }
  $("yes").onclick = async () => {
    $("yes").disabled = true;
    const host = hosts[at];
    const ok = await SiteAccess.request([SiteAccess.patternOf("https://" + host + "/")], ext).catch(() => false);
    if (ok) { allowed.push(host); at++; } // (the next, if there is one: its own click)
    show();
  };
  $("no").onclick = () => tell({ done: true, allowed, declined: hosts.slice(at) });
  show();
})();
