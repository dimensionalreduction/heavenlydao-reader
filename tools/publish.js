// Sends the packaged zips (npm run package) to the stores through their APIs, so nothing is uploaded by hand:
//   node tools/publish.js                      both stores
//   node tools/publish.js firefox | chrome     one
//   node tools/publish.js chrome-auth          once: gets the Chrome refresh token (opens a login in the browser, prints the token)
//   --notes "text" | --notes-file file         what's new (Firefox's release notes)
//   --no-submit                                Chrome: upload the draft only, don't submit it for review
//   --dry-run                                  say what would be sent, send nothing
//   --env path                                 the .env to read (default: the nearest one above this folder, else ../../p2p-read/.env)
// Credentials, in .env or the environment (docs/EXTENSION-RELEASES.md, "Store APIs", says where each comes from):
//   AMO-JWT-ISSUER, AMO-JWT-SECRET                                      addons.mozilla.org › Developer Hub › Manage API Keys
//   CHROME-CLIENT-ID, CHROME-CLIENT-SECRET, CHROME-REFRESH-TOKEN,       Google Cloud OAuth client + chrome-auth
//   CHROME-PUBLISHER-ID, CHROME-EXTENSION-ID                            Chrome Web Store dashboard (Account, and the item's page)
// The version is the one in the manifests; the zips are dist/package/heavenlydao-reader-<version>-{firefox,source,chrome}.zip.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DRY = flag("--dry-run");
const targets = ["firefox", "chrome"].filter((t) => flag(t));
const cmd = flag("chrome-auth") ? "auth" : "publish";

function readEnv() {
  let file = value("--env");
  if (!file) {
    for (let d = root; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, ".env"))) { file = path.join(d, ".env"); break; }
      if (path.dirname(d) === d) break;
    }
    file = file || path.join(root, "..", "..", "p2p-read", ".env");
  }
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return (k) => process.env[k] || process.env[k.replace(/-/g, "_")] || env[k] || "";
}
const get = readEnv();
const need = (...keys) => {
  const out = keys.map(get);
  const missing = keys.filter((_, i) => !out[i]);
  if (missing.length) { console.error("Missing in .env: " + missing.join(", ")); process.exit(1); }
  return out;
};

const manifest = (t) => JSON.parse(fs.readFileSync(path.join(root, "src", t, "manifest.json"), "utf8"));
const version = manifest("firefox").version;
const zipOf = (kind) => {
  const f = path.join(root, "dist", "package", `heavenlydao-reader-${version}-${kind}.zip`);
  if (!fs.existsSync(f)) { console.error(f + " is missing: run npm run package first"); process.exit(1); }
  return f;
};
const notes = value("--notes") || (value("--notes-file") && fs.readFileSync(value("--notes-file"), "utf8").trim()) || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString("base64url");

async function json(res, what) {
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${what}: ${res.status} ${typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body)}`);
  return body;
}

// ---- Firefox: addons.mozilla.org API v5 ----
async function firefox() {
  const guid = manifest("firefox").browser_specific_settings.gecko.id;
  const [iss, secret] = DRY ? ["", ""] : need("AMO-JWT-ISSUER", "AMO-JWT-SECRET");
  const files = { add_on: zipOf("firefox"), source: zipOf("source") };
  console.log(`Firefox ${version} (${guid}): upload ${path.basename(files.add_on)}, source ${path.basename(files.source)}, listed` + (notes ? ", with release notes" : ""));
  if (DRY) return;
  const API = "https://addons.mozilla.org/api/v5";
  const auth = () => { // a token lives 5 minutes at most, so one per call
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64u(JSON.stringify({ iss, jti: crypto.randomUUID(), iat: now, exp: now + 60 }));
    const sig = crypto.createHmac("sha256", secret).update(head + "." + body).digest("base64url");
    return { Authorization: `JWT ${head}.${body}.${sig}` };
  };
  const form = new FormData();
  form.set("channel", "listed");
  form.set("upload", new Blob([fs.readFileSync(files.add_on)]), path.basename(files.add_on));
  let up = await json(await fetch(API + "/addons/upload/", { method: "POST", headers: auth(), body: form }), "Firefox upload");
  for (let i = 0; !up.processed && i < 60; i++) {
    await sleep(5000);
    up = await json(await fetch(`${API}/addons/upload/${up.uuid}/`, { headers: auth() }), "Firefox upload status");
  }
  if (!up.processed) throw new Error("Firefox: the upload was not processed in 5 minutes (uuid " + up.uuid + ")");
  if (!up.valid) throw new Error("Firefox rejected the upload: " + JSON.stringify(up.validation, null, 1));
  console.log("  validated" + (up.validation && up.validation.warnings ? ` (${up.validation.warnings} warnings)` : ""));
  const make = { upload: up.uuid };
  if (notes) make.release_notes = { "en-US": notes };
  const v = await json(await fetch(`${API}/addons/addon/${encodeURIComponent(guid)}/versions/`, {
    method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify(make)
  }), "Firefox new version");
  const src = new FormData();
  src.set("source", new Blob([fs.readFileSync(files.source)]), path.basename(files.source));
  await json(await fetch(`${API}/addons/addon/${encodeURIComponent(guid)}/versions/${v.id}/`, { method: "PATCH", headers: auth(), body: src }), "Firefox source upload");
  console.log(`  version ${v.version} (id ${v.id}) is in review: https://addons.mozilla.org/developers/addon/${guid}/versions`);
}

// ---- Chrome Web Store API v2 ----
async function chromeToken() {
  const [id, secret, refresh] = need("CHROME-CLIENT-ID", "CHROME-CLIENT-SECRET", "CHROME-REFRESH-TOKEN");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" })
  });
  return (await json(res, "Chrome sign-in")).access_token;
}

async function chrome() {
  const zip = zipOf("chrome");
  const cv = manifest("chrome").version;
  console.log(`Chrome ${cv}: upload ${path.basename(zip)}` + (flag("--no-submit") ? " (draft only)" : ", then submit for review"));
  if (DRY) return;
  const [pub, item] = need("CHROME-PUBLISHER-ID", "CHROME-EXTENSION-ID");
  const name = `publishers/${pub}/items/${item}`;
  const headers = { Authorization: "Bearer " + await chromeToken() };
  const up = await json(await fetch(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: fs.readFileSync(zip)
  }), "Chrome upload");
  let state = up.uploadState;
  for (let i = 0; state === "IN_PROGRESS" && i < 30; i++) {
    await sleep(5000);
    const st = await json(await fetch(`https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`, { headers }), "Chrome status");
    state = st.lastAsyncUploadState || "SUCCEEDED";
  }
  if (state !== "SUCCEEDED") throw new Error("Chrome upload " + state + ": " + JSON.stringify(up));
  console.log("  uploaded");
  if (flag("--no-submit")) return console.log("  left as a draft in the dashboard");
  const pubRes = await json(await fetch(`https://chromewebstore.googleapis.com/v2/${name}:publish`, { method: "POST", headers }), "Chrome submit");
  console.log("  submitted for review: " + (pubRes.state || JSON.stringify(pubRes)));
}

// ---- Chrome: the one-time refresh token (a Desktop-app OAuth client, answered on a localhost port) ----
async function auth() {
  const [id, secret] = need("CHROME-CLIENT-ID", "CHROME-CLIENT-SECRET");
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: id, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent",
    scope: "https://www.googleapis.com/auth/chromewebstore"
  });
  console.log("Open this in the browser signed in to the Chrome Web Store account, and allow it:\n\n" + url + "\n");
  const code = await new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      res.end(q.get("code") ? "Done: back to the terminal." : "No code: " + (q.get("error") || ""));
      q.get("code") ? resolve(q.get("code")) : reject(new Error(q.get("error") || "no code"));
    });
  });
  server.close();
  const t = await json(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" })
  }), "Chrome token");
  console.log("Add to .env:\nCHROME-REFRESH-TOKEN=" + t.refresh_token);
}

(async () => {
  if (cmd === "auth") return auth();
  const run = targets.length ? targets : ["firefox", "chrome"];
  let failed = false;
  for (const t of run) {
    try { await (t === "firefox" ? firefox() : chrome()); }
    catch (e) { failed = true; console.error(e.message); }
  }
  if (failed) process.exit(1);
})();
