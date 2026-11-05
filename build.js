const fs = require("fs");
const path = require("path");
const { bundleText, loadRegistry, loadMirrorHosts } = require("./tools/sources");
const { profileModelText } = require("./tools/profile-model");

const root = __dirname;
const targets = ["chrome", "firefox"];

function copyFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

// Every site in the rules (src/shared/sources/) is a site the extension may read pages from, so each one is added to the manifest's
// permissions here: adding a site's rule file is all it takes, the build gives the extension access to it. ("*." also covers the bare
// domain.) Chrome keeps them in host_permissions, Firefox (manifest v2) among its permissions.
function addSitePermissions(manifestFile, hosts) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const list = manifest.host_permissions || manifest.permissions;
  const have = new Set(list);
  for (const h of hosts) {
    const pattern = "https://*." + h + "/*";
    if (!have.has(pattern) && !have.has("https://www." + h + "/*")) list.push(pattern);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
}

// (The script that records a book, src/shared/book-capture.js, no longer runs on every site's pages: a book is added only when the person presses Import to library
// in the popup, which runs it in that tab, or Refresh details, which visits the book's page: docs/ADD-BOOK.md.)

// A release build asks for no novel site at install: each is an optional permission, asked for the first time the site is used (site-access.js), and the
// scripts that run on a site's pages (the book recorder, the site's, 69shuba's chapter index) are added by the background once the site is allowed (SITE_SCRIPTS,
// in site-matches.js, is what it adds). So the novel sites are taken out of the manifest here, and their content scripts too. Kept: the AI services and the
// library's own site (the site-bridge script). A dev build keeps them all in the manifest, as before: the e2e tests read sites that nobody clicked to allow.
const ALWAYS_HOSTS = /^https:\/\/(generativelanguage|translate)\.googleapis\.com\//;
function takeOutSites(manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const key = manifest.host_permissions ? "host_permissions" : "permissions";
  manifest[key] = manifest[key].filter((p) => !/^https?:\/\//.test(p) || ALWAYS_HOSTS.test(p));
  const scripts = [];
  manifest.content_scripts = (manifest.content_scripts || []).filter((c) => {
    if (c.js.includes("site-bridge.js")) return true;
    scripts.push({ matches: c.matches, js: c.js, runAt: c.run_at || "document_idle" });
    return false;
  });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return scripts;
}

// The library site on this computer (`node build.js --dev`: the e2e tests, and working on the site locally), and the dev site (p2p-library-dev.pages.dev, behind
// its password). A release build leaves them out: any program serving on that port would get what the site's tab gets from the
// extension (site-bridge.js).
const DEV = process.argv.includes("--dev");
const DEV_SITE = ["http://localhost:3000/*", "http://127.0.0.1:3000/*", "https://p2p-library-dev.pages.dev/*"];
// (Firefox ignores a port in a match pattern, and a pattern that names one matches nothing: its dev build names the hosts alone. Chrome's names the port.)
function addDevSite(manifestFile, target) {
  const sites = target === "firefox" ? ["http://localhost/*", "http://127.0.0.1/*", "https://p2p-library-dev.pages.dev/*"] : DEV_SITE;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const bridge = manifest.content_scripts.find((c) => c.js.includes("site-bridge.js"));
  bridge.matches = sites.concat(bridge.matches.filter((m) => !sites.includes(m)));
  // (the Allow card, a page of the extension shown in the site's tab, is for the same addresses: Chrome keeps the list in the manifest)
  for (const w of manifest.web_accessible_resources || []) if (w && w.matches) w.matches = bridge.matches.slice();
  // this computer's address too (the e2e tests' stand-in sites): the extension reads them as a site it has been allowed, and a Referer can be set for them
  const hostsKey = manifest.host_permissions ? "host_permissions" : "permissions";
  // (the library site on this computer as a permission too: a temporary add-on, as the Firefox tests install it, is not granted a content script's matches)
  for (const h of ["https://127.0.0.1/*", "http://127.0.0.1/*", ...sites]) if (!manifest[hostsKey].includes(h)) manifest[hostsKey].push(h);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
}
// The same addresses for the extension's pages that check who is asking (library-host.js, p2p-host.js, notice-bg.js): Chrome's offscreen page
// cannot read the manifest (its chrome.runtime has no getManifest), so they get it as a file.
function siteMatchesText(manifestFile, siteScripts) {
  // (what the extension's own pages check a sender's address against: the dev site with its port, in either browser)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const matches = manifest.content_scripts.find((c) => c.js.includes("site-bridge.js")).matches.concat(DEV ? DEV_SITE : []).filter((m, i, all) => all.indexOf(m) === i);
  return "// GENERATED by build.js from the manifest: the library site's addresses, where site-bridge.js runs; and, in a build that asks for no novel site at install,\n" +
    "// the scripts the background adds on a novel site's pages once the person has allowed the site (background.js, syncSiteScripts).\n" +
    "var SITE_BRIDGE_MATCHES = " + JSON.stringify(matches) + ";\nvar SITE_SCRIPTS = " + JSON.stringify(siteScripts) + ";\n";
}

// Where each site keeps a chapter's text, for that script (a page that has none of it is not a chapter).
function chapterSelectorsText() {
  const table = {};
  for (const [host, rule] of Object.entries(loadRegistry())) if (rule.selector && !rule.pictures) table[host] = rule.selector; // (a site whose chapters are pictures has no text for the page translator)
  return "// GENERATED by build.js from the site rules (src/shared/sources/): where each site's chapter page keeps the chapter's text.\nconst ChapterSelectors = " + JSON.stringify(table) + ";\n";
}

// The table the capture script reads: for each site that has book selectors, them and the chapter-text selector (a page that has it is a chapter, not a book).
function bookRulesText() {
  const table = {};
  for (const [host, rule] of Object.entries(loadRegistry())) if (rule.book) table[host] = { book: rule.book, selector: rule.selector };
  return "// GENERATED by build.js from the site rules (src/shared/sources/): where each site's book page says what the book is.\nconst BookRules = " + JSON.stringify(table) + ";\n";
}

const hosts = [...new Set([...Object.keys(loadRegistry()), ...loadMirrorHosts()])].sort();

for (const target of targets) {
  const distDir = path.join(process.env.BUILD_OUT || path.join(root, "dist"), target); // (BUILD_OUT: a test builds somewhere else)
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const srcDir = path.join(root, "src", target);
  for (const file of fs.readdirSync(srcDir)) {
    copyFile(path.join(srcDir, file), distDir);
  }

  const sharedDir = path.join(root, "src", "shared");
  for (const entry of fs.readdirSync(sharedDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue; // sources/ is bundled into raw-sources.js below
    if (entry.name === "raw-sources.js") continue;
    copyFile(path.join(sharedDir, entry.name), distDir);
  }
  // how chapters are put together into novels: the library site's own code (share-lists.js, the notifications)
  copyFile(path.join(root, "vendor", "chapters.js"), distDir);
  // how a translation profile translates (the playground's own code: profile-translate.js uses it for the chapters a watch fetches)
  fs.writeFileSync(path.join(distDir, "profile-model.js"), profileModelText());
  // the engine and every site's rules, as the one file the extension loads
  fs.writeFileSync(path.join(distDir, "raw-sources.js"), bundleText());
  fs.writeFileSync(path.join(distDir, "book-rules.js"), bookRulesText());
  fs.writeFileSync(path.join(distDir, "chapter-selectors.js"), chapterSelectorsText());
  const manifestFile = path.join(distDir, "manifest.json");
  addSitePermissions(manifestFile, hosts);
  const siteScripts = DEV ? [] : takeOutSites(manifestFile);
  if (DEV) addDevSite(manifestFile, target);
  fs.writeFileSync(path.join(distDir, "site-matches.js"), siteMatchesText(manifestFile, siteScripts));

  // the license and the notices of what is included go with the add-on
  copyFile(path.join(root, "LICENSE"), distDir);
  copyFile(path.join(root, "THIRD-PARTY-NOTICES.md"), distDir);

  // a comic's chapter translated in its page (comic-host.js): onnxruntime-web (MIT), PaddleOCR's text detector (Apache-2.0) and the lettering's font (OFL), the library
  // site's own copies (vendor/ort, models, fonts here)
  for (const [dir, from, files] of [
    ["ort", path.join(root, "vendor", "ort"), ["ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "README.md"]],
    ["models", path.join(root, "models"), ["ch_PP-OCRv4_det_infer.onnx", "README.md"]],
    ["fonts", path.join(root, "fonts"), ["comic-neue-400.woff2", "comic-neue-700.woff2", "OFL-comic-neue.txt", "komika-text-bold.ttf", "Apostrophic-Labs-License.txt"]]
  ]) {
    fs.mkdirSync(path.join(distDir, dir), { recursive: true });
    for (const f of files) copyFile(path.join(from, f), path.join(distDir, dir));
  }
  console.log(`Built dist/${target} (${hosts.length} source sites)` + (DEV ? " with the site on localhost:3000" : ""));
}

// --reload: the dev browser (Chrome with --remote-debugging-port=9222) reloads the extension from dist/chrome, so it runs this build at once
// (the VS Code tasks Build extension and Build extension (dev))
if (process.argv.includes("--reload") && !process.env.BUILD_OUT) {
  require("./tools/reload-dev").reloadDev().catch((e) => console.error("Not reloaded: " + e.message));
}
