// The site rules (src/shared/sources/) as one script, and the list of sites they cover. Used by the build, and by tests so they run the
// same code the extension runs.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shared = path.join(__dirname, "..", "src", "shared");
const engineFile = path.join(shared, "raw-sources.js");
const dataDir = path.join(shared, "sources");

// The files of rules in the order they are loaded. A later registration of a site replaces an earlier one, so the generated file (named
// with a leading "_") goes first and every hand-written file after it overrides it.
function dataFiles() {
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith(".js"))
    .sort((a, b) => (a.startsWith("_") === b.startsWith("_") ? a.localeCompare(b) : a.startsWith("_") ? -1 : 1))
    .map((f) => path.join(dataDir, f));
}

// The engine and every site file, one after the other: this is what ships as raw-sources.js.
function bundleText() {
  const parts = [fs.readFileSync(engineFile, "utf8")];
  for (const f of dataFiles()) parts.push("\n// ---- sources/" + path.basename(f) + " ----\n" + fs.readFileSync(f, "utf8"));
  return parts.join("");
}

// Runs the bundle once: its RawSources.
function load() {
  const ctx = { TextDecoder, TextEncoder, URL, console, atob, btoa, crypto: require("crypto").webcrypto };
  ctx.globalThis = ctx;
  vm.runInNewContext(bundleText(), ctx, { filename: "raw-sources.js" });
  return ctx.RawSources;
}

// The registry: { "host": rule, ... }.
const loadRegistry = () => load().SOURCES;
// Sites the extension fetches only to find a mirror's address (fanqienovel.com): it needs permission for them too.
const loadMirrorHosts = () => Object.keys(load().MIRRORS);

// Every site the extension can read, for the library's settings page: [{ host, text, list, book: [fields], via?, note? }], sorted by host.
//   text   its chapter text is fetched (and translated)       list   its chapter list is read       book   which details its book page gives
// (a site with no book fields still gets the standard og:novel:* page metadata, when the page has it). The site is read through its own API
// rather than by a rule; a mirrored site (fanqienovel.com) is read through its mirror.
const BOOK_FIELDS = ["title", "author", "cover", "description", "genre"];
function supportedSites() {
  const R = load();
  const rows = Object.entries(R.SOURCES).map(([host, r]) => ({
    host,
    text: !!(r.selector || r.fromHtml),
    list: !!r.toc,
    book: BOOK_FIELDS.filter((k) => r.book && r.book[k])
  }));
  for (const host of Object.keys(R.MIRRORS)) {
    const via = Object.keys(R.SOURCES).find((h) => h.split(".")[0] === "tomatomtl") || "";
    rows.push({ host, text: true, list: true, book: [], via, note: "read through " + via });
  }
  rows.push({ host: "wtr-lab.com", text: true, list: true, book: BOOK_FIELDS.slice(), note: "English text, chapter list and details through the site's own API" });
  return rows.sort((a, b) => a.host.localeCompare(b.host));
}

// The code behind each site, for the settings page. { code: { host: text }, fns: { hash: source }, files: { name: text }, filesOf: { host: [name] } }
//   code     the site's rule as it is registered, written out as an object; a function in it is the token @@fn:<hash>@@ (fns holds its source,
//            shared by every site that has the same function: a family's list reader is one function for dozens of sites)
//   filesOf  the hand-written files (sources/<name>.js) that register or extend the site; files holds their text. The generated rule has no file of its own.
// The data files are run one by one, noting which one registers each site.
function siteCode() {
  const ctx = { TextDecoder, TextEncoder, URL, console, atob, btoa, crypto: require("crypto").webcrypto };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(engineFile, "utf8"), ctx, { filename: "raw-sources.js" });
  const R = ctx.RawSources;
  const filesOf = {};
  const files = {};
  const generated = new Set(); // the sites the generated file has a rule for (before anything hand-written)
  let current = "";
  const name = (h) => String(h).replace(/^www\./, "").toLowerCase();
  const note = (h) => {
    if (current.startsWith("_")) {
      generated.add(name(h));
      return;
    }
    const list = (filesOf[name(h)] = filesOf[name(h)] || []);
    if (!list.includes(current)) list.push(current);
  };
  const { register, extend, registerAll } = R;
  R.register = (hosts, rule) => ([].concat(hosts).forEach(note), register(hosts, rule));
  R.extend = (hosts, patch) => ([].concat(hosts).filter((h) => R.rawRule(h)).forEach(note), extend(hosts, patch));
  R.registerAll = (table) => (Object.keys(table).forEach(note), registerAll(table));
  for (const f of dataFiles()) {
    current = path.basename(f);
    const text = fs.readFileSync(f, "utf8");
    if (!current.startsWith("_")) files[current] = text.replace(/\r\n/g, "\n");
    vm.runInContext(text, ctx, { filename: current });
  }

  const fns = {};
  const fnToken = (fn) => {
    const lines = String(fn).replace(/\r\n/g, "\n").split("\n");
    const rest = lines.slice(1).filter((l) => l.trim());
    const indent = rest.length ? Math.min(...rest.map((l) => l.match(/^ */)[0].length)) : 0; // the file's own indentation, taken off
    const text = [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(indent, l.match(/^ */)[0].length)))].join("\n");
    const hash = require("crypto").createHash("md5").update(text).digest("hex").slice(0, 8);
    fns[hash] = text;
    return "@@fn:" + hash + "@@";
  };
  const plainKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
  const write = (v, pad) => {
    if (typeof v === "function") return fnToken(v);
    if (Array.isArray(v)) return v.length ? "[" + v.map((x) => write(x, pad)).join(", ") + "]" : "[]";
    if (v && typeof v === "object") {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return "{}";
      const inner = pad + "  ";
      return "{\n" + keys.map((k) => inner + plainKey(k) + ": " + write(v[k], inner)).join(",\n") + "\n" + pad + "}";
    }
    return JSON.stringify(v);
  };
  const code = {};
  for (const host of Object.keys(R.SOURCES)) code[host] = "RawSources.register(" + JSON.stringify(host) + ", " + write(R.rawRule(host), "") + ");";
  for (const [host, fn] of Object.entries(R.MIRRORS)) code[host] = "// " + host + " draws its text with a scrambled font, so a chapter is read from its mirror instead.\n// This says which page of the mirror a chapter is (url: the chapter's address, html: its page).\nRawSources.registerMirror(" + JSON.stringify(host) + ", " + fnToken(fn) + ");";
  code["wtr-lab.com"] = "// The site is read through its own API, not by a rule: its chapter list is /api/chapters/<novel id>, its chapter text comes from\n// /api/reader/get, and its raw-source links lead to the original sites above. That code is in extension/src/shared/p2p-host.js\n// (wtrChapterList, saveWtrSource), with the page capture in extension/src/shared/wtr-capture.js.";
  const mirrorFiles = Object.keys(R.MIRRORS).length ? Object.keys(files).filter((f) => files[f].includes("registerMirror")) : [];
  for (const host of Object.keys(R.MIRRORS)) filesOf[host] = mirrorFiles;
  return { code, fns, files, filesOf, generated };
}

module.exports = { supportedSites, siteCode, BOOK_FIELDS,  shared, engineFile, dataDir, dataFiles, bundleText, load, loadRegistry, loadMirrorHosts };
