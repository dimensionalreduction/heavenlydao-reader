// Builds the extension and makes the zips to upload, from the files on disk (nothing needs to be committed or added to git first):
//   npm run package      -> dist/package/heavenlydao-reader-<version>-firefox.zip   the Firefox add-on (the upload)
//                           dist/package/heavenlydao-reader-<version>-source.zip    its source, which addons.mozilla.org asks for
//                           dist/package/heavenlydao-reader-<version>-chrome.zip    the Chrome build
// The source zip holds the repository (without node_modules, dist and the WebToEpub submodule), so `npm ci && npm run build` in it makes dist/firefox.
// BUILD.txt in it says so.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist", "package");

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// A zip from [{ name, data }] (names with "/", as zip wants them, whatever the system).
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const date = new Date();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data);
    const method = packed.length < data.length ? 8 : 0;
    const body = method ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // (names are UTF-8)
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(dosTime, 12);
    head.writeUInt16LE(dosDate, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// Every file under dir as { name: prefix + path inside dir, data }, in a fixed order; skip(relative path) leaves one out.
function filesOf(dir, prefix, skip) {
  const list = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (skip && skip(r)) continue;
      if (e.isDirectory()) walk(r);
      else list.push({ name: prefix + r, data: fs.readFileSync(path.join(dir, r)) });
    }
  };
  walk("");
  return list;
}

const build = spawnSync(process.execPath, [path.join(root, "build.js")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);

const version = JSON.parse(fs.readFileSync(path.join(root, "src", "firefox", "manifest.json"), "utf8")).version;
const chromeVersion = JSON.parse(fs.readFileSync(path.join(root, "src", "chrome", "manifest.json"), "utf8")).version;
if (version !== chromeVersion) console.warn("The manifests differ: Firefox " + version + ", Chrome " + chromeVersion);

const buildText = [
  "heavenlydao.com Reader " + version + " — source",
  "",
  "This is the extension's source: the repository without node_modules, dist and reference (the WebToEpub submodule).",
  "Everything the add-on loads is built from it; nothing in the add-on is minified or generated except as below.",
  "",
  "To build (Node.js 20 or later):",
  "  npm ci            (installs webtorrent from package-lock.json; its prebuilt browser bundle, webtorrent.min.js, is copied into the add-on)",
  "  npm run build     (writes dist/firefox and dist/chrome)",
  "",
  "dist/firefox is the add-on. These files are made by build.js:",
  "  raw-sources.js, book-rules.js, chapter-selectors.js, site-matches.js   joined or generated from src/shared/ and src/shared/sources/",
  "  manifest.json                                                           src/firefox/manifest.json with each source site's permission added",
  "  webtorrent.min.js                                                       node_modules/webtorrent/webtorrent.min.js, unchanged",
  "The other files are copied from src/firefox/ and src/shared/ as they are.",
  "",
  "Tests: npm test (the one that checks the site rules against WebToEpub's parsers needs the reference/WebToEpub submodule of the repository).",
  ""
].join("\n");

fs.mkdirSync(out, { recursive: true });
const base = "heavenlydao-reader-" + version;
const write = (name, entries) => {
  const file = path.join(out, base + "-" + name + ".zip");
  fs.writeFileSync(file, zip(entries));
  console.log(path.relative(root, file) + "  (" + entries.length + " files, " + Math.round(fs.statSync(file).size / 1024) + " KB)");
};

write("firefox", filesOf(path.join(root, "dist", "firefox"), ""));
write("chrome", filesOf(path.join(root, "dist", "chrome"), ""));
write("source", [
  { name: "BUILD.txt", data: Buffer.from(buildText) },
  ...filesOf(root, "", (r) => r === "node_modules" || r === "dist" || r === ".git" || r === "reference" || r.endsWith(".zip"))
]);
