// Tries how the extension reads a page that says no encoding (raw-sources.js charsetOf) on the sites WebToEpub has had to hard-code one for: each of its parsers
// that decodes with a fixed TextDecoder("gbk" / "gb2312" / "gb18030" / ...) names its sites. Their pages are fetched now (the home page, and up to three book or
// chapter pages it links to: the ones WebToEpub decodes), read with no rule (as a site added with Detect with AI is), and the reading is compared with
// WebToEpub's: the same encoding, or one that reads at least as well (no more broken characters, as many of the most common Chinese characters: a site that
// has moved to UTF-8 since its parser was written is read right by us and wrong by it). Needs the internet; a site that does not answer is said, not failed.
// node tools/check-encodings.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PARSERS = path.join(__dirname, "..", "reference", "WebToEpub", "plugin", "js", "parsers");
const ctx = { console, URL, TextDecoder };
vm.createContext(ctx);
vm.runInContext(require("./sources").bundleText() + ";this.RawSources = RawSources;", ctx);
const RS = ctx.RawSources;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const COMMON = new Set("的一是不了人我在有他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日這個們來為國說時會對發後過裡經學現當沒動開從實");

// [{ parser, charset, hosts }] from WebToEpub's parsers
function forced() {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".js")) {
        const src = fs.readFileSync(p, "utf8");
        const m = /new TextDecoder\("([^"]+)"\)/i.exec(src);
        if (!m) continue;
        const hosts = [...src.matchAll(/parserFactory\.register\w*\(\s*"([^"]+)"/g)].map((x) => x[1]);
        if (hosts.length) out.push({ parser: f, charset: m[1].toLowerCase(), hosts });
      }
    }
  };
  walk(PARSERS);
  return out;
}

const family = (cs) => (/^(gbk|gb2312|gb18030|x-gbk)$/i.test(cs) ? "gb" : /^(utf-?8)$/i.test(cs) ? "utf-8" : cs.toLowerCase());
// how well a text reads: its broken characters, its Chinese characters, and the share of those that are the most common ones
function quality(text) {
  const han = text.match(/[一-鿿]/g) || [];
  let common = 0;
  for (const c of han) if (COMMON.has(c)) common++;
  return { broken: (text.match(/�/g) || []).length, han: han.length, common: han.length ? common / han.length : 0 };
}
async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (res.ok && !/html|text\/plain|^$/i.test(res.headers.get("content-type") || "")) return { status: "not a page (" + res.headers.get("content-type") + ")" }; // (a font, a picture)
    return res.ok ? { url: res.url || url, bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") || "" } : { status: res.status };
  } catch (e) {
    return { status: "no answer" };
  }
}

(async () => {
  let pass = 0;
  let fail = 0;
  let away = 0;
  for (const { parser, charset, hosts } of forced()) {
    for (const host of hosts) {
      const home = await get("https://" + host + "/");
      if (!home.bytes) {
        away++;
        console.log("  -   " + host + ": " + (typeof home.status === "number" ? "HTTP " + home.status : home.status) + "  (" + parser + ")");
        continue;
      }
      // the book and chapter pages it links to (an address with a long number in it), as WebToEpub's parser would read them
      const html = new TextDecoder(charset).decode(home.bytes);
      const links = [...new Set([...html.matchAll(/href=["']([^"'#]+)["']/g)].map((m) => { try { return new URL(m[1], home.url).href; } catch (e) { return ""; } })
        .filter((u) => u && new URL(u).hostname.replace(/^www\./, "") === new URL(home.url).hostname.replace(/^www\./, "") && /\d{4,}/.test(new URL(u).pathname)))].slice(0, 3);
      for (const page of [home, ...(await Promise.all(links.map(get))).filter((p) => p.bytes)]) {
        const said = (/charset=["']?([\w-]+)/i.exec(page.type) || [])[1] || (/<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(page.bytes.subarray(0, 4096))) || [])[1] || "nothing";
        const ours = RS.charsetOf(page.bytes, page.type, null);
        const q = quality(RS.decode(page.bytes, page.type, null));
        const w = quality(new TextDecoder(charset).decode(page.bytes));
        const ok = family(ours) === family(charset) || (q.broken <= w.broken && q.common >= w.common - 0.02);
        // the built-in rule of the site, when it names an encoding (copied from WebToEpub's parser): does it read the page as well?
        const rule = RS.ruleFor(page.url);
        const r = rule && rule.charset ? quality(RS.decode(page.bytes, page.type, rule)) : null;
        const ruleNote = r ? " | built-in rule " + rule.charset + ": broken " + r.broken + ", common " + r.common.toFixed(2) + (r.broken > q.broken || r.common < q.common - 0.02 ? " WORSE" : "") : "";
        if (ok) pass++;
        else fail++;
        const where = page.url.replace(/^https?:\/\/[^/]+/, "") || "/";
        console.log((ok ? "PASS " : "FAIL ") + (host + where).slice(0, 50).padEnd(50) + " says " + said.padEnd(8) + " ours " + ours.padEnd(8) + " WebToEpub " + charset.padEnd(8) +
          " broken " + q.broken + "/" + w.broken + ", common " + q.common.toFixed(2) + "/" + w.common.toFixed(2) + " of " + q.han + " han" + ruleNote);
      }
    }
  }
  console.log("\n" + pass + " pages read at least as well as WebToEpub reads them, " + fail + " not, " + away + " sites did not answer");
  process.exit(fail ? 1 : 0);
})();
