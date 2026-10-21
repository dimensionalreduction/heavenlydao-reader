// What a release build asks for at install, and what it leaves for later (build.js, takeOutSites; site-access.js): no novel site, only the AI services and the library's
// own site; the scripts for the novel sites go to SITE_SCRIPTS (the background adds them once a site is allowed). A dev build keeps everything in the manifest.
// Run: node test/optional-sites.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

function build(args) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "build-"));
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "build.js"), ...args], { encoding: "utf8", env: { ...process.env, BUILD_OUT: out } });
  assert.strictEqual(run.status, 0, "the build ran: " + run.stderr);
  const read = (target, file) => fs.readFileSync(path.join(out, target, file), "utf8");
  const manifest = (target) => JSON.parse(read(target, "manifest.json"));
  const matches = {};
  vm.runInNewContext(read("chrome", "site-matches.js"), matches);
  return { out, read, manifest, matches, exists: (target, file) => fs.existsSync(path.join(out, target, file)) };
}

const hostsOf = (m) => (m.host_permissions || m.permissions).filter((p) => /^https?:\/\//.test(p));

// ---- a release build ----
const rel = build([]);
for (const target of ["chrome", "firefox"]) {
  const m = rel.manifest(target);
  assert.deepStrictEqual(hostsOf(m), ["https://generativelanguage.googleapis.com/*", "https://translate.googleapis.com/*"], target + ": only the AI services are asked for at install");
  assert.deepStrictEqual((m.optional_host_permissions || m.optional_permissions), ["https://*/*"], target + ": any other site can be asked for later, one at a time");
  assert.deepStrictEqual(m.content_scripts.map((c) => c.js.join("+")), ["site-bridge.js"], target + ": the only script in the manifest is the library site's");
  assert.ok(m.content_scripts[0].matches.every((x) => /heavenlydao\.com|p2p-library\.pages\.dev/.test(x)), target + ": and it runs on the library's own site");
  assert.ok(rel.exists(target, "site-access.js"), target + ": the module that asks is shipped");
}
const plain = (v) => JSON.parse(JSON.stringify(v)); // (made in another context: compared by value)
const groups = plain(rel.matches.SITE_SCRIPTS);
assert.deepStrictEqual(groups.map((g) => g.js.join("+")), ["wtr-terms.js+wtr-capture.js", "chapter-index.js", "book-rules.js+user-rules.js+book-capture.js"], "the novel sites' scripts wait for the site to be allowed");
assert.ok(groups.every((g) => g.runAt === "document_idle" && g.matches.length), "each is added at idle, with its sites");
assert.ok(groups[2].matches.length > 500 && groups[2].matches.includes("https://*.69shuba.com/*"), "the book recorder is for every built-in site");
assert.ok(plain(rel.matches.SITE_BRIDGE_MATCHES).includes("https://heavenlydao.com/*"), "the bridge's addresses are still listed");

// ---- a dev build ----
const dev = build(["--dev"]);
for (const target of ["chrome", "firefox"]) {
  const m = dev.manifest(target);
  assert.ok(hostsOf(m).length > 500 && hostsOf(m).includes("https://*.69shuba.com/*") && hostsOf(m).includes("https://wtr-lab.com/*"), target + ": a dev build has every site in the manifest, as before");
  assert.ok(m.content_scripts.length >= 4, target + ": and their scripts");
}
assert.deepStrictEqual(plain(dev.matches.SITE_SCRIPTS), [], "so nothing is added by the background");
console.log("OK — optional-sites checks passed");
