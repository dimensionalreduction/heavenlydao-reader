// How p2p-host.js fetches and translates chapters on request, with the network stubbed:
//   a site chapter, from the novel's own source site: look up the chapter id, follow go-to-raw to the source page, decode it, keep
//     the original text under "<source chapter key>#original", bind the novel's glossary, and hand the text to the translator
//   a chapter of a supported site you read directly: fetch the chapter page itself
// Run: node test/p2p-host-wtr.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shared = path.join(__dirname, "..", "src", "shared");
const store = new Map();
let onConnect = null; // the host's listener for links from the library site's tab
const sent = []; // runtime messages that are not storage calls: the translator and the glossary binding
let calls = [];
let finalUrl = "https://www.69shuba.com/txt/77582/38804612";
const html = '<div class="txtnav"><h1>t</h1>第一章<br><br>x<br>y</div><a href="/txt/77582/38804613">下一章</a>';
const gb = (s) => {
  // GB18030 bytes for the test page (Node's TextDecoder can decode but not encode, so the few Chinese characters are hard-coded)
  const known = { "第": [0xb5, 0xda], "一": [0xd2, 0xbb], "章": [0xd5, 0xc2], "下": [0xcf, 0xc2] };
  return Uint8Array.from([...s].flatMap((ch) => known[ch] || (ch.charCodeAt(0) < 128 ? [ch.charCodeAt(0)] : [0x3f])));
};

const CHECK_LIST = '<ul class="paged"><a href="/r/1">第1章 a</a><a href="/r/2">第2章 b</a><a href="/r/3">第3章 c</a></ul>';
const ctx = {
  console, URL, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, crypto: require("crypto").webcrypto,
  File: class {}, atob,
  DOMParser: function () {
    this.parseFromString = (text) => ({
      // a stand-in for the real parser: the text of the page with its tags turned into line breaks
      querySelector: (sel) => ((sel === "div.txtnav" && /txtnav/.test(text)) || (sel === "div.txt_tcontent" && /txt_tcontent/.test(text)) ? { querySelectorAll: () => [], textContent: text.replace(/<[^>]+>/g, String.fromCharCode(10)) } : null),
      querySelectorAll: (sel) => (sel === 'meta[property^="og:"]' ? [...text.matchAll(/<meta property="([^"]*)" content="([^"]*)">/g)].map((m) => ({ getAttribute: (n) => (n === "property" ? m[1] : m[2]) })) : sel === "#pg option" ? [...text.matchAll(/<option data-url="([^"]*)"/g)].map((m) => ({ getAttribute: () => m[1], textContent: "" })) : sel === "a" || sel === "ul#newlist li a" || sel === "ul.chapters a" || sel === "ul.paged a" ? [...text.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => ({ textContent: m[2], getAttribute: () => m[1] })) : [])
    });
  },
  fetch: async (url) => {
    calls.push(String(url));
    if (/api\/reader\/get/.test(url)) (ctx.readerAt = ctx.readerAt || []).push(Date.now());
    if (/api\/reader\/get/.test(url) && ctx.wtrDown) return { ok: false, status: 500, json: async () => ({ error: "down" }) };
    // The site's bot check, as it answers after a few dozen chapters at once
    if (/api\/reader\/get/.test(url) && ctx.wtrTurnstile) return { ok: false, status: 403, json: async () => ({ success: false, requireTurnstile: true, code: 1401, error: "Please complete the Turnstile challenge to continue reading." }) };
    if (/api\/reader\/get/.test(url) && ctx.wtrLocked) return { ok: true, status: 200, json: async () => ({ success: false, code: "CHAPTER_LOCKED" }) };
    if (/api\/reader\/get/.test(url)) return { ok: true, json: async () => ({ success: true, chapter: { id: 8885200 }, content_url: "/api/v2/reader/content/x" }) };
    if (/api\/v2\/reader\/content\/x/.test(url)) return { ok: true, json: async () => ({ success: true, data: { data: { title: ctx.wtrTitle || "Chapter 9: Nine", model: "gem", body: ctx.wtrBody || ["Chapter 9: Nine", "※0⛬ met ※1⛬ and the 龙.", "[image]", "Second line"], glossary_data: { terms: [["Lei Wujie", "雷无桀"], ["Xiao Se", "萧瑟"]] }, patch: [{ zh: "龙", en: "dragon" }] } } }) };
    if (/go-to-raw/.test(url) && ctx.rawThrows) throw new TypeError("Failed to fetch"); // (the browser refuses the redirect to a site the extension may not read)
    if (/go-to-raw/.test(url)) return { ok: true, url: finalUrl, text: async () => ctx.rawBody || "", arrayBuffer: async () => gb(html).buffer, body: { cancel: async () => { ctx.cancelled = true; } } };
    if (/69shuba\.com\/txt\/77582\/3880461[2345]/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => gb(ctx.noNext ? html.replace(/<a [^>]*>[^<]*<\/a>/, "") : html).buffer };
    // fanqienovel's mirror: a chapter page with its text encrypted, and the book's list as JSON
    if (/^https:\/\/tomatomtl\.com\/book\/555000\/777$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode(ctx.tomatoHtml).buffer };
    if (/^https:\/\/tomatomtl\.com\/catalog\/555000$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify([{ title: "第1章 甲", id: "776" }, { title: "第2章 乙", id: "777" }])).buffer };
    if (/^https:\/\/www\.uuread\.tw\/1$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<ul id="newlist"><li><a href="/chapter/1/10.html">第10章 a</a></li><li><a href="/chapter/1/11.html">第11章 b</a></li><li><a href="/chapter/1/12.html">第12章 c</a></li></ul>').buffer };
    // a made-up site registered below, to try a rule that has a list selector but no way to tell the list's address from a chapter's
    if (/^https:\/\/fixture\.example\/book\/1$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<ul class="chapters"><a href="/read/1/4.html">第4章 a</a><a href="/read/1/5.html">第5章 b</a><a href="/read/1/6.html">第6章 c</a></ul>').buffer };
    // a made-up site whose list runs over seven pages (3 chapters each), the page selector on the first
    if (/^https:\/\/big(?:paged|rev)\.example\/bp\/(\d)$/.test(url)) {
      const n = Number(/bp\/(\d)$/.exec(url)[1]);
      // ctx.bpFail = { 5: { status: 429, times: 2, retryAfter: "0.05" } }: that page answers with the status that many times before it works
      const fail = ctx.bpFail && ctx.bpFail[n];
      if (fail && fail.times-- > 0) return { ok: false, status: fail.status, url: String(url), headers: { get: (k) => (/retry-after/i.test(k) ? fail.retryAfter || null : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
      const links = [1, 2, 3].map((k) => '<a href="/r/' + n + "-" + k + '">第' + ((n - 1) * 3 + k) + "章 x</a>").join("");
      const options = n === 1 ? "<select id=\"pg\">" + [1, 2, 3, 4, 5, 6, 7].map((i) => '<option data-url="/bp/' + i + '">' + i + "</option>").join("") + "</select>" : "";
      return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<ul class="paged">' + links + "</ul>" + options).buffer };
    }
    // a made-up site whose list runs over two pages, the second named by an <option data-url>
    if (/^https:\/\/paged\.example\/book\/9$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<ul class="paged"><a href="/r/1">第1章 a</a><a href="/r/2">第2章 b</a><a href="/r/3">第3章 c</a></ul><select id="pg"><option data-url="/book/9">1</option><option data-url="/book/9?page=2">2</option></select>').buffer };
    if (/^https:\/\/paged\.example\/book\/9\?page=2$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<ul class="paged"><a href="/r/4">第4章 d</a><a href="/r/5">第5章 e</a></ul>').buffer };
    if (/^https:\/\/fixture\.example\/read\/1\/5\.html$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode(ctx.fixtureLink ? '<div class="c">x</div><a href="/book/1">目录</a><a href="/read/1/6.html">下一章</a>' : '<div class="c">x</div><a href="/read/1/6.html">下一章</a>').buffer };
    if (/^https:\/\/fixture\.example\/read\/1\/6\.html$/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<div class="c">y</div>').buffer };
    if (/api\/chapters\/8053/.test(url)) return { ok: true, json: async () => ({ chapters: [
      { order: 2, title: "Chapter 2 Beta", name: "第2章" }, { order: 1, title: "Chapter 1 Alpha", name: "第1章" }, { order: "x", title: "no number", name: "" }, { order: 3, title: "Chapter 3 Gamma", name: "第3章" }] }) };
    if (/uuread\.tw\/chapter\/1\/11\.html/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<div class="txt_tcontent"><p>Eleven</p></div><a href="/chapter/1/12.html">下一章</a>').buffer };
    if (/uuread\.tw\/chapter\/1\/12\.html/.test(url)) return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<div class="txt_tcontent"><p>Twelve</p></div>').buffer };
    if (/uuread\.tw\/chapter\/1\/10(_2)?\.html/.test(url)) {
      const second = /10_2/.test(url);
      const page = second
        ? '<div class="txt_tcontent"><p>' + ctx.part2 + '</p></div><a href="/chapter/1/11.html">下一章</a>'
        : '<div class="txt_tcontent"><p>Part one line</p></div><a href="/chapter/1/10_2.html">下一頁</a><a href="/chapter/1/10_2.html">看下一章</a>';
      return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode(page).buffer };
    }
    // a book's page on a made-up site, with the standard metadata (the cover without a scheme, as 69shuba.tw has it)
    if (url === "https://details.example/book/5") return { ok: true, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<meta property="og:novel:book_name" content="Reverend Insanity"><meta property="og:novel:author" content="Gu Zhen Ren"><meta property="og:novel:category" content="Xianxia"><meta property="og:description" content="A demon is reborn."><meta property="og:image" content="//img.details.example/5.jpg"><meta property="og:novel:read_url" content="https://details.example/book/5/">').buffer };
    // a book's page with no standard metadata, on a site that has only its book parts saved (no chapter rule)
    if (url === "https://bookonly.example/novel/9") return { ok: true, status: 200, url: String(url), arrayBuffer: async () => new TextEncoder().encode('<h1>Lord of Mysteries</h1><span class="by">Cuttlefish</span><img class="cv" src="/c.jpg">').buffer };
    // a site behind a bot check: HTTP 403 to the extension's own request (unless ctx.unblocked), whatever the browser has passed
    if (/^https:\/\/(check|pass|tabonly)\.example\//.test(url)) return ctx.unblocked ? { ok: true, status: 200, url: String(url), arrayBuffer: async () => new TextEncoder().encode(CHECK_LIST).buffer } : { ok: false, status: 403, url: String(url), arrayBuffer: async () => new ArrayBuffer(0) };
    if (url === "https://details.example/book/8") throw new TypeError("Failed to fetch"); // (the site does not even answer the extension)
    if (url === "https://details.example/book/6") return { ok: false, status: 503, url: String(url), arrayBuffer: async () => new ArrayBuffer(0) };
    // wtr-lab: the novel's page names the build, and the build names the data file
    if (url === "https://wtr-lab.com/en/novel/8053/synthesis-wizard") return { ok: true, status: 200, text: async () => '<script id="__NEXT_DATA__">{"buildId":"b123","page":"x"}</script>' };
    if (String(url).startsWith("https://wtr-lab.com/_next/data/b123/en/novel/8053/synthesis-wizard.json")) return { ok: true, status: 200, json: async () => ({ pageProps: { serie: { serie_data: { slug: "synthesis-wizard", status: 0, genres: [], tags: [], data: { title: "Synthesis Wizard", author: "Someone", image: "https://img.wtr/8053.jpg", description: "A wizard." } }, raws: [{ slug: "69shu", default: true }], names: [] }, tags: [] } }) };
    throw new Error("unexpected fetch " + url);
  }
};
ctx.self = ctx;
ctx.globalThis = ctx;
ctx.chrome = {
  runtime: {
    sendMessage: (m) => {
      if (m.type) {
        sent.push(m);
        // (the site's tab answers with the page: its status, its address, its bytes as base64)
        // (the browser's pass for the site's check, brought to where the extension's requests see it: ctx.passCopied says how many cookies came over)
        if (m.type === "novel:get") return Promise.resolve(ctx.novelReply || { ok: true });
        if (m.type === "target:language") return Promise.resolve({ lang: ctx.targetLang || "en" });
        if (m.type === "original:translate" && ctx.translateReply) return Promise.resolve(ctx.translateReply); // (the background's answer: profile-translate.js)
        if (m.type === "site:pass") { if (ctx.passCopied) ctx.unblocked = true; return Promise.resolve({ ok: true, copied: ctx.passCopied || 0 }); }
        if (m.type === "site:fetch") return Promise.resolve(ctx.tabReply || { ok: true, status: 200, url: m.url, type: "text/html; charset=utf-8", body: Buffer.from(CHECK_LIST, "utf8").toString("base64") });
        return Promise.resolve(m.type === "book:visit" && ctx.visitReply ? ctx.visitReply : { ok: true });
      }
      // (what this extension does for your other devices: ctx.help, as the service worker keeps it)
      if (m.op === "getHelp") return Promise.resolve({ result: ctx.help || null });
      if (m.op === "setHelp") { ctx.help = m.args[0]; return Promise.resolve({ result: null }); }
      return Promise.resolve({ result: m.op === "getConfig" ? { enabled: false } : m.op === "getTranslation" ? store.get(m.args[0]) : m.op === "setTranslation" ? void store.set(m.args[0], m.args[1]) : null });
    },
    onMessage: { addListener: () => {} },
    onConnect: { addListener: (fn) => (onConnect = fn) }
  }
};
ctx.WebTorrent = class {};
ctx.BookCapture = require("../src/shared/book-capture.js"); // (the extension page gets these from book-capture.js)
ctx.WtrTerms = require("../src/shared/wtr-terms.js");
ctx.UserRules = require("../src/shared/user-rules.js");
vm.createContext(ctx);
for (const f of ["p2p-core.js"]) vm.runInContext(fs.readFileSync(path.join(shared, f), "utf8"), ctx, { filename: f });
// the host hands the core a function to call when another device asks for a chapter: keep hold of it
let onRawRequest = null;
let onRawStop = null; // and one for when that device says to stop
let answerApi = null; // and one for a read of the library
const realCreate = ctx.P2PCore.createP2P;
const announced = []; // what the host tells the devices that asked: [key, state, info]
ctx.P2PCore.createP2P = (opts) => {
  onRawRequest = opts.onRawRequest;
  onRawStop = opts.onRawStop;
  answerApi = opts.answerApi;
  const core = realCreate(opts);
  const realAnnounce = core.announceRaw;
  core.announceRaw = (key, state, info) => { announced.push([key, state, info]); return realAnnounce(key, state, info); };
  return core;
};
vm.runInContext(require("../tools/sources").bundleText(), ctx, { filename: "raw-sources.js" }); // the engine and every site's rules, as shipped
vm.runInContext(fs.readFileSync(path.join(shared, "p2p-host.js"), "utf8"), ctx, { filename: "p2p-host.js" });

ctx.part2 = "Part two line";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wtrKey = "translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-1#original";
const meta = { novelName: "Synthesis Wizard", pageTitle: "Chapter 1: Synthesis Cube", translate: true, source: "69shuba.com", ahead: 1 };
const SOURCE = "https://www.69shuba.com/txt/77582/38804612";

(async () => {
  assert.strictEqual(typeof onRawRequest, "function", "the host answers requests for chapters");

  // ---- a site chapter, read from the novel's source site ----
  await onRawRequest(wtrKey, meta);
  assert.deepStrictEqual(calls.map((u) => u.replace("https://wtr-lab.com", "")), ["/api/reader/get", "/api/serie/go-to-raw?id=8885200"]);
  const raw = store.get("translation:" + SOURCE + "#original");
  assert.ok(raw, "the original text is kept under the SOURCE chapter's key (what is sent to Gemini)");
  assert.deepStrictEqual([raw.model, raw.pageTitle, raw.novelName], ["original", "Chapter 1: Synthesis Cube", "Synthesis Wizard"]);
  assert.ok(raw.translated.includes("第一章"), "the text came from the source page, decoded as GB18030");
  assert.ok(!store.has(wtrKey), "nothing is stored under the wtr-lab key: wtr-lab has no original text");
  await sleep(100);
  const bind = sent.find((m) => m.type === "wtr:bindsource");
  assert.deepStrictEqual([bind.url, bind.rawId], [SOURCE, "8053"], "the novel's wtr-lab glossary is bound to the new source");
  const job = sent.find((m) => m.type === "original:translate").job;
  assert.deepStrictEqual([job.url, job.pageTitle, job.novelName], [SOURCE, "Chapter 1: Synthesis Cube", "Synthesis Wizard"], "translated under the source's URL, titled like the wtr-lab chapter so the two line up");
  assert.ok(job.text.includes("第一章"));
  assert.strictEqual(raw.next, "https://www.69shuba.com/txt/77582/38804613", "the page's own next-chapter link is kept with the text");
  assert.strictEqual(job.next, raw.next, "and goes on to the translation");

  // ---- ahead: 1 also fetches and translates the chapter after it, found through that link (no chapter list needed) ----
  await sleep(2500); // one download at a time, a second apart
  const next = store.get("translation:https://www.69shuba.com/txt/77582/38804613#original");
  assert.ok(next, "the next chapter's original text was fetched too");
  assert.strictEqual(next.pageTitle, "Chapter 2", "titled by number until it has been read");
  const jobs = sent.filter((m) => m.type === "original:translate").map((m) => m.job.url);
  assert.deepStrictEqual(jobs, [SOURCE, "https://www.69shuba.com/txt/77582/38804613"], "both are translated, in order");
  assert.ok(!store.has("translation:https://www.69shuba.com/txt/77582/38804614#original"), "and no further: ahead counts down to zero");

  // ---- the same chapter again: the original is kept, so only the lookup repeats (no second page download), then it is translated again ----
  sent.length = 0;
  calls = [];
  ctx.cancelled = false;
  await onRawRequest(wtrKey, meta);
  assert.ok(ctx.cancelled, "a page that is not needed is not downloaded");
  await sleep(3000); // let the translations that step queued finish, so the next step starts clean

  // ---- already translated from that source (say by another device): nothing is translated again ----
  store.set("translation:" + SOURCE, { translated: "English text", model: "gemini", savedAt: 1 });
  sent.length = 0;
  await onRawRequest(wtrKey, meta);
  await sleep(100);
  assert.ok(!sent.some((m) => m.type === "original:translate"), "an existing translation is left alone");
  store.delete("translation:" + SOURCE);

  // ---- the site's own text of a chapter (opened on the site, no source site involved) ----
  const ownKey = "translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-9";
  calls = [];
  await onRawRequest(ownKey + "#original", { ...meta, source: "wtr-lab.com" });
  const own = store.get(ownKey);
  assert.strictEqual(own.translated, "Lei Wujie met Xiao Se and the  dragon.\nSecond line", "the glossary placeholders and the patch are filled in; the title line and the image marker are not paragraphs");
  assert.strictEqual(own.pageTitle, "Chapter 9: Nine");
  assert.strictEqual(own.model, "wtr-lab · gem");
  assert.ok(!calls.some((c) => /go-to-raw/.test(c)), "no source site is looked up");
  calls = [];
  await onRawRequest(ownKey + "#original", { ...meta, source: "wtr-lab.com" });
  assert.strictEqual(calls.length, 0, "a chapter that is already here is not fetched again");
  store.delete(ownKey);
  // a chapter whose "title" is a copy of its first paragraph (and whose body has no title line) has no title: no paragraph is lost, no text is a title
  ctx.wtrTitle = "※0⛬ met ※1⛬.";
  ctx.wtrBody = ["※0⛬ met ※1⛬.", "Second line"];
  await onRawRequest(ownKey + "#original", { ...meta, source: "wtr-lab.com" });
  assert.strictEqual(store.get(ownKey).pageTitle, "Chapter 9", "a paragraph is not taken for the title");
  assert.strictEqual(store.get(ownKey).translated, "Lei Wujie met Xiao Se.\nSecond line", "and the first paragraph stays");
  ctx.wtrTitle = ctx.wtrBody = undefined;
  store.delete(ownKey);

  // ---- the novel's chapter list, read on request (what WebToEpub does: one request, /api/chapters/<id>) ----
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-0#original", { ...meta, source: "wtr-lab.com", findNext: true });
  assert.deepStrictEqual(calls, ["https://wtr-lab.com/api/chapters/8053"], "one request for the whole list, no page visit and no chapter fetched");
  const saved = sent.find((m) => m.type === "chapterindex:save");
  assert.ok(saved, "the list is handed to the library's chapter index");
  assert.strictEqual(saved.record.key, "wtr-lab:8053");
  assert.deepStrictEqual(Array.from(saved.record.chapters, (c) => c[0]), [1, 2, 3], "in chapter order, the unnumbered row left out");
  assert.strictEqual(saved.record.chapters[0][2], "https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-1", "each chapter's address is built from the novel's id and slug");

  // ---- a source site's chapter list, read once on request ("<a chapter's address>#list") ----
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://www.uuread.tw/chapter/1/10.html#list", { ...meta });
  assert.deepStrictEqual(calls, ["https://www.uuread.tw/1"], "the list page is read once; no chapter is fetched");
  const applied = sent.find((m) => m.type === "list:apply");
  assert.ok(applied, "the list goes to the extension's chapter-list keeper");
  assert.deepStrictEqual(Array.from(applied.found.chapters, (c) => c[0]), [1, 2, 3], "numbered by place in the list (the titles say 10, 11, 12)");
  assert.strictEqual(applied.found.chapters[0][2], "https://www.uuread.tw/chapter/1/10.html");
  assert.strictEqual(applied.watch.known, 0, "as a first look, so nothing is announced as new");
  const passes = sent.filter((m) => m.type === "list:apply");
  assert.deepStrictEqual(passes.map((m) => !!m.found.quick), [true, false], "first saved at once with the site's titles, then again to translate them");
  await assert.rejects(onRawRequest("translation:https://example.org/book/1/2.html#list", { ...meta }), /no chapter list reader/, "a site with no list rule");

  // ---- a list over several pages: the first names the others, they are read one after another, and the chapters are numbered across all of them ----
  ctx.RawSources.register("paged.example", { selector: "div.c", toc: { list: "ul.paged a", pages: { options: "#pg option", attr: "data-url" } } });
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://paged.example/book/9#list", { ...meta });
  assert.deepStrictEqual(calls, ["https://paged.example/book/9", "https://paged.example/book/9?page=2"], "the first page, then the page it names (not itself again)");
  const pagedSaves = sent.filter((m) => m.type === "list:apply");
  assert.deepStrictEqual(pagedSaves.map((m) => m.found.chapters.length), [3, 5, 5], "the first page is in the library at once (before the second is read), then the whole list, then again with the titles translated");
  const paged = pagedSaves[1];
  assert.deepStrictEqual(Array.from(paged.found.chapters, (c) => [c[0], c[2]]), [[1, "https://paged.example/r/1"], [2, "https://paged.example/r/2"], [3, "https://paged.example/r/3"], [4, "https://paged.example/r/4"], [5, "https://paged.example/r/5"]], "numbered across the pages, in order");

  // ---- progress: each list page is announced, and a long list is saved as it grows ----
  const listNotes = announced.filter(([k, s, i]) => /paged\.example\/book\/9#list$/.test(k) && s === "downloading" && i.note).map(([, , i]) => i.note);
  assert.deepStrictEqual(listNotes, ["reading the list", "list page 1 of 2 · 3 chapters", "list page 2 of 2 · 5 chapters"], "it says it has started, then how far it has got after each page");
  ctx.RawSources.register("bigpaged.example", { selector: "div.c", toc: { list: "ul.paged a", pages: { options: "#pg option", attr: "data-url" } } });
  sent.length = 0;
  announced.length = 0;
  await onRawRequest("translation:https://bigpaged.example/bp/1#list", { ...meta });
  const passes7 = sent.filter((m) => m.type === "list:apply").map((m) => [m.found.quick ? "quick" : "full", m.found.chapters.length]);
  assert.deepStrictEqual(passes7.slice(-2), [["quick", 21], ["full", 21]], "the whole list at once, then again with the titles translated");
  assert.ok(passes7.length >= 3 && passes7[0][1] === 3, "and before that the list as it stood: from the first page on");
  assert.ok(passes7.slice(0, -2).every((x, i, all) => x[0] === "quick" && (i === 0 || x[1] > all[i - 1][1]) && x[1] < 21), "each save along the way is quick (the site's own titles) and has more chapters than the one before");
  const states7 = announced.filter(([k]) => /bigpaged/.test(k)).map(([, s]) => s);
  assert.strictEqual(states7[states7.length - 1], "done", "and it ends by saying done");
  ctx.RawSources.register("bigrev.example", { selector: "div.c", toc: { list: "ul.paged a", reverse: true, pages: { options: "#pg option", attr: "data-url" } } });
  // a newest-first list is read from its last page back, so what is saved along the way is the start of the novel, numbered right
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://bigrev.example/bp/1#list", { ...meta });
  assert.deepStrictEqual(calls, [1, 7, 6, 5, 4, 3, 2].map((n) => "https://bigrev.example/bp/" + n), "the first page (it names the others), then the oldest page first");
  const revPasses = sent.filter((m) => m.type === "list:apply");
  assert.deepStrictEqual(revPasses.slice(-2).map((m) => [m.found.quick ? "quick" : "full", m.found.chapters.length]), [["quick", 21], ["full", 21]], "the whole list at the end");
  assert.ok(revPasses.length >= 3 && revPasses[0].found.chapters.length === 3, "the oldest page is in the library as soon as it is read (the newest, first page waits for the rest)");
  assert.deepStrictEqual(Array.from(revPasses[0].found.chapters, (c) => c[0]), [1, 2, 3], "numbered from the start of the novel");
  assert.ok(revPasses[0].found.chapters.every((c) => /\/r\/7-/.test(c[2])), "and they are the oldest page's chapters");

  // a failure part way keeps what was read, and says so; a "too many requests" answer is waited for and asked again
  ctx.bpFail = { 4: { status: 500, times: 99 } };
  sent.length = 0;
  announced.length = 0;
  await assert.rejects(onRawRequest("translation:https://bigrev.example/bp/1#list", { ...meta }), /answered HTTP 500/, "the refresh still fails");
  const kept = sent.filter((m) => m.type === "list:apply").pop();
  assert.ok(kept && kept.found.quick && kept.found.chapters.length === 9, "the nine chapters of the three pages read are saved");
  const failedNote = announced.filter(([k, s]) => /bigrev/.test(k) && s === "failed").map(([, , i]) => i.error).pop();
  assert.ok(/9 chapters read so far are in the library/.test(failedNote), "and the person is told");
  ctx.bpFail = { 5: { status: 429, times: 2, retryAfter: "0.05" } };
  sent.length = 0;
  calls = [];
  announced.length = 0;
  await onRawRequest("translation:https://bigpaged.example/bp/1#list", { ...meta });
  assert.strictEqual(calls.filter((u) => /bigpaged\.example\/bp\/5$/.test(u)).length, 3, "the page that said 429 twice is asked for again until it answers");
  assert.strictEqual(sent.filter((m) => m.type === "list:apply").pop().found.chapters.length, 21, "and the list is complete");
  assert.ok(announced.some(([k, s, i]) => /bigpaged/.test(k) && s === "downloading" && /asked to wait/.test(i.note || "")), "the wait is shown");
  ctx.bpFail = undefined;

  // ---- "Stop" while a list is being read: no further page is asked for, what was read is kept, and it ends by saying it was stopped ----
  const stopKey = "translation:https://bigpaged.example/bp/1#list";
  sent.length = 0;
  calls = [];
  announced.length = 0;
  const stoppedRun = assert.rejects(onRawRequest(stopKey, { ...meta }), /^Error: stopped$/, "the request ends as stopped");
  while (calls.length < 3) await sleep(20);
  onRawStop(stopKey);
  await stoppedRun;
  assert.strictEqual(calls.length, 3, "the pages after the stop are not asked for");
  const keptAtStop = sent.filter((m) => m.type === "list:apply").pop();
  assert.ok(keptAtStop && keptAtStop.found.quick && keptAtStop.found.chapters.length === 9, "the nine chapters of the three pages read are saved");
  const stopNote = announced.filter(([k, s]) => k === stopKey && s === "failed").map(([, , i]) => i.error).pop();
  assert.ok(/^stopped \(the 9 chapters read so far are in the library/.test(stopNote), "and the library is told it stopped, and what it has");
  // a stop that arrives when nothing is being read stops nothing: the next refresh reads the whole list
  onRawStop(stopKey);
  sent.length = 0;
  await onRawRequest(stopKey, { ...meta });
  assert.strictEqual(sent.filter((m) => m.type === "list:apply").pop().found.chapters.length, 21, "the list is read to its end again");

  // ---- a site that refuses the extension's own requests (a bot check: HTTP 403): its pages are asked for from inside a tab of the site ----
  for (const h of ["check.example", "pass.example", "tabonly.example"]) ctx.RawSources.register(h, { selector: "div.c", toc: { list: "ul.paged a" } });
  ctx.unblocked = false;
  ctx.tabReply = undefined;
  sent.length = 0;
  announced.length = 0;
  calls = [];
  await onRawRequest("translation:https://check.example/book/3#list", { ...meta });
  assert.deepStrictEqual(sent.filter((m) => m.type === "site:fetch").map((m) => m.url), ["https://check.example/book/3"], "the page was asked for through a tab of the site");
  assert.deepStrictEqual(calls.filter((u) => u.includes("check.example")), ["https://check.example/book/3"], "after the extension's own request was refused, once");
  const checked = sent.find((m) => m.type === "list:apply");
  assert.deepStrictEqual(Array.from(checked.found.chapters, (c) => c[2]), ["https://check.example/r/1", "https://check.example/r/2", "https://check.example/r/3"], "so the list was read (from the bytes the tab gave)");
  assert.ok(announced.some(([k, st, i]) => k.includes("check.example") && st === "downloading" && /a tab of the site opened/.test(i.note || "")), "and the status said what was going on");
  // refused again right after the tab helped: from then on the site's pages go through the tab at once, the extension does not ask in vain first
  await onRawRequest("translation:https://check.example/book/4#list", { ...meta });
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://check.example/book/5#list", { ...meta });
  assert.deepStrictEqual([sent.filter((m) => m.type === "site:fetch").map((m) => m.url), calls.filter((u) => u.includes("check.example"))], [["https://check.example/book/5"], []], "a site known to refuse is asked through its tab straight away");
  // when the tab stops helping, the extension asks by itself again, and what it is told is the error, with why the tab did not help
  ctx.tabReply = { ok: false, error: "the site's check was not passed within 120 seconds" };
  sent.length = 0;
  calls = [];
  await assert.rejects(onRawRequest("translation:https://check.example/book/3#list", { ...meta }), /the page answered HTTP 403 \(the site's check was not passed within 120 seconds\)/, "still 403: reported as it is, with the reason");
  assert.deepStrictEqual([sent.filter((m) => m.type === "site:fetch").length, calls.filter((u) => u.includes("check.example")).length], [2, 1], "(the tab, the extension itself, the tab once more)");
  // the browser has passed the site's check already, and the pass is kept where only the site's own pages send it (what Cloudflare does): it is brought
  // over and the request made again, with no tab at all (as WebToEpub does, which is why it works with the site's tab closed)
  ctx.tabReply = undefined;
  ctx.unblocked = false;
  ctx.passCopied = 1;
  sent.length = 0;
  calls = [];
  announced.length = 0;
  await onRawRequest("translation:https://pass.example/book/3#list", { ...meta });
  assert.deepStrictEqual(sent.filter((m) => m.type === "site:pass").map((m) => m.url), ["https://pass.example/book/3"], "asked to bring the pass over");
  assert.deepStrictEqual(calls.filter((u) => u.includes("pass.example")), ["https://pass.example/book/3", "https://pass.example/book/3"], "then the extension asks again itself");
  assert.ok(!sent.some((m) => m.type === "site:fetch"), "and no tab is opened");
  assert.strictEqual(sent.find((m) => m.type === "list:apply").found.chapters.length, 3, "the list is read");
  assert.ok(!announced.some(([, , i]) => /a tab of the site/.test((i && i.note) || "")), "nothing is said about a tab");
  ctx.passCopied = 0;
  // a tab that got a page, then the extension refused again at once: the pass does not come over on this site, so its pages go through the tab from then on
  ctx.unblocked = false;
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://tabonly.example/book/1#list", { ...meta });
  await onRawRequest("translation:https://tabonly.example/book/2#list", { ...meta });
  await onRawRequest("translation:https://tabonly.example/book/3#list", { ...meta });
  assert.deepStrictEqual(calls.filter((u) => u.includes("tabonly.example")), ["https://tabonly.example/book/1", "https://tabonly.example/book/2"], "the extension tries by itself once more after the tab helped, and not a third time");
  assert.strictEqual(sent.filter((m) => m.type === "site:fetch").length, 3);
  // a site that answers never opens a tab
  ctx.tabReply = undefined;
  ctx.unblocked = true;
  sent.length = 0;
  await onRawRequest("translation:https://check.example/book/3#list", { ...meta });
  assert.ok(!sent.some((m) => m.type === "site:fetch"), "no tab when the site answers");
  ctx.unblocked = false;

  // ---- a novel's details and cover, read again ("<the book's address>#details") ----
  // a book on a source site: its page is read, the cover address (no scheme) is made whole, and the record is kept
  ctx.RawSources.register("details.example", { selector: "div.c", book: { title: "h1" } });
  sent.length = 0;
  announced.length = 0;
  calls = [];
  await onRawRequest("translation:https://details.example/book/5#details", { ...meta, source: "details.example" });
  assert.deepStrictEqual(calls, ["https://details.example/book/5"], "the book's own page, read once");
  const detailsSaved = sent.find((m) => m.type === "novel:save");
  assert.ok(detailsSaved, "the record goes to the library");
  const rec = detailsSaved.info;
  assert.deepStrictEqual([rec.id, rec.source, rec.title, rec.author, rec.cover], ["details.example/book/5", "details.example", "Reverend Insanity", "Gu Zhen Ren", "https://img.details.example/5.jpg"], "title, author and the whole cover address");
  assert.strictEqual(rec.listUrl, "https://details.example/book/5/", "and where its chapters are");
  assert.ok(sent.some((m) => m.type === "translateBook"), "its titles are put into English (when that is possible)");
  assert.deepStrictEqual(announced.filter(([k]) => k.endsWith("details.example/book/5#details")).map(([, st]) => st), ["downloading", "done"], "the asker is told it started and when it is done");
  // a site that refuses, and one the extension does not read
  announced.length = 0;
  ctx.visitReply = { error: "the page did not finish loading in 45 seconds" };
  sent.length = 0;
  await assert.rejects(onRawRequest("translation:https://details.example/book/6#details", { ...meta }), (e) => e.message.includes("HTTP 503") && e.message.includes("opening the page instead did not work either") && e.message.includes("did not finish loading in 45 seconds"), "a refusal that the visit cannot get round is the error, with both reasons");
  assert.deepStrictEqual(sent.filter((m) => m.type === "book:visit").map((m) => m.url), ["https://details.example/book/6"], "the page was visited after the refusal");
  assert.strictEqual(announced.filter(([k, st]) => k.endsWith("book/6#details") && st === "failed").length, 1, "and the asker is told it failed");
  // a refusal (403, 429, 503) or no answer at all is got round by visiting the page: the recording script there makes the record
  ctx.visitReply = undefined;
  for (const [address, why] of [["https://details.example/book/6", "503"], ["https://details.example/book/8", "no answer"]]) {
    sent.length = 0;
    announced.length = 0;
    await onRawRequest("translation:" + address + "#details", { ...meta });
    assert.deepStrictEqual(sent.filter((m) => m.type === "book:visit").map((m) => m.url), [address], "the site said " + why + ": the page is visited in a tab");
    assert.ok(!sent.some((m) => m.type === "novel:save"), "the recording script saves the record, not the sync page (so it is not saved twice)");
    assert.deepStrictEqual(announced.filter(([k]) => k.endsWith(address.slice(8) + "#details")).map(([, st]) => st), ["downloading", "done"], "and the asker is told it is done");
  }
  await assert.rejects(onRawRequest("translation:https://unknown.example/book/1#details", { ...meta }), /not a site this extension reads/, "a site with no rule");
  // a site with only book parts saved from "Detect with AI" (no chapter rule) is read for its details all the same: its page is fetched
  // (the stand-in parser here cannot read selectors, so the page then "does not look like a book's"; the point is that the site is not refused)
  ctx.UserRules.apply({ "bookonly.example": { spec: { host: "bookonly.example", book: { title: "h1", author: ".by", cover: ".cv" } }, enabled: true } });
  calls = [];
  await assert.rejects(onRawRequest("translation:https://bookonly.example/novel/9#details", { ...meta, source: "bookonly.example" }), /does not look like a book's page/, "a site with book parts saved is not refused");
  assert.deepStrictEqual(calls, ["https://bookonly.example/novel/9"], "its page was read");
  ctx.UserRules.apply({});
  // a site novel: its page names the build, the build names the data
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard#details", { ...meta, source: "wtr-lab.com" });
  assert.deepStrictEqual(calls.map((u) => u.replace("https://wtr-lab.com", "").split("?")[0]), ["/en/novel/8053/synthesis-wizard", "/_next/data/b123/en/novel/8053/synthesis-wizard.json"], "the novel's page, then its data file");
  const wtrRec = sent.find((m) => m.type === "novel:save").info;
  assert.deepStrictEqual([wtrRec.id, wtrRec.title, wtrRec.cover, wtrRec.url], ["wtr-lab:8053", "Synthesis Wizard", "https://img.wtr/8053.jpg", "https://wtr-lab.com/en/novel/8053/synthesis-wizard"]);
  const rawLookup = sent.find((m) => m.type === "wtr:rawhost");
  assert.deepStrictEqual([rawLookup.rawId, rawLookup.lang, rawLookup.slug], ["8053", "en", "69shu"], "where its raw source is, looked up the way a visit to the page does");

  // ---- refusals: nothing saved, the asker is told (the promise rejects) ----
  const key2 = wtrKey.replace("chapter-1#", "chapter-2#");
  finalUrl = "https://fanqienovel.com/reader/9";
  await assert.rejects(onRawRequest(key2, meta), /could not tell which book/, "a fanqienovel page that does not say which book it is in: nothing to read");
  finalUrl = "https://www.69shuba.com/txt/77582/38804612";
  await assert.rejects(onRawRequest(key2, { ...meta, source: "uuread.tw" }), /source is 69shuba\.com, not uuread\.tw/, "the chapter is not on the source that was asked for");
  finalUrl = "https://fanqienovel.com/reader/9";
  await assert.rejects(onRawRequest(key2, { ...meta, source: "" }), /could not tell which book/, "no source named, and the Raw link leads to a page with no book");
  assert.ok(!store.has("translation:https://fanqienovel.com/reader/9#original"));

  // ---- a fanqienovel novel, read from its mirror (tomatomtl.com) ----
  const nodeCrypto = require("crypto");
  const key16 = nodeCrypto.randomBytes(16);
  const iv16 = nodeCrypto.randomBytes(16);
  const cipher = nodeCrypto.createCipheriv("aes-128-cbc", key16, iv16);
  const NL = String.fromCharCode(10);
  const encText = Buffer.concat([cipher.update(["第一行", "第二行"].join(NL), "utf8"), cipher.final()]).toString("base64");
  ctx.tomatoHtml = 'let unlock_code = "' + Buffer.concat([key16, nodeCrypto.randomBytes(8)]).toString("base64") + '"; let encryptedData = {"iv":"' + iv16.toString("base64") + '","enc":"' + encText + '"};';
  ctx.rawBody = String.raw`x,\"bookId\":\"\",y,\"bookId\":\"555000\",z`; // the fanqie page the Raw link lands on
  finalUrl = "https://fanqienovel.com/reader/777";
  calls = [];
  sent.length = 0;
  const keyF = wtrKey.replace("chapter-1#", "chapter-7#");
  await onRawRequest(keyF, { ...meta, source: "tomatomtl.com" });
  assert.ok(calls.includes("https://tomatomtl.com/book/555000/777"), "the mirror's page for the same chapter is fetched, with the book id the fanqie page named");
  assert.strictEqual(store.get("translation:https://tomatomtl.com/book/555000/777#original").translated, ["第一行", "第二行"].join(NL), "its text is decrypted and kept as the original text");
  assert.ok(sent.some((m) => m.type === "original:translate" && m.job.url === "https://tomatomtl.com/book/555000/777"), "and translated as the mirror's own chapter");
  store.delete("translation:https://tomatomtl.com/book/555000/777#original");
  sent.length = 0;
  calls = [];
  await onRawRequest("translation:https://tomatomtl.com/book/555000/777#list", { ...meta });
  assert.deepStrictEqual(calls, ["https://tomatomtl.com/catalog/555000"], "the book's list is one JSON request");
  const mirrorList = sent.find((m) => m.type === "list:apply");
  assert.deepStrictEqual(Array.from(mirrorList.found.chapters, (c) => [c[0], c[2]]), [[1, "https://tomatomtl.com/book/555000/776"], [2, "https://tomatomtl.com/book/555000/777"]], "numbered by place, with real book addresses");
  ctx.rawBody = "";

  // ---- a chapter of a supported site you read directly ----
  calls = [];
  sent.length = 0;
  const direct = "translation:https://www.69shuba.com/txt/77582/38804614#original";
  await onRawRequest(direct, { ...meta, translate: false });
  assert.deepStrictEqual(calls, ["https://www.69shuba.com/txt/77582/38804614"]);
  assert.ok(store.get(direct).translated.includes("第一章"));

  // ---- a chapter translated before links were kept: Next asks the extension to read the link from its page once ----
  const old = "translation:https://www.69shuba.com/txt/77582/38804612";
  store.set(old, { translated: "English text", suggestions: [], model: "gemini", savedAt: 1, pageTitle: "Chapter 1", novelName: "Synthesis Wizard" });
  sent.length = 0;
  await onRawRequest(old + "#original", { ...meta, translate: false, findNext: true });
  const upd = store.get(old);
  assert.strictEqual(upd.next, "https://www.69shuba.com/txt/77582/38804613", "the link was found and added to the saved chapter");
  assert.strictEqual(upd.translated, "English text", "the translation itself is untouched");
  assert.ok(upd.savedAt > 1, "as a newer version, so it reaches the other devices");
  assert.ok(!sent.some((m) => m.type === "original:translate"), "nothing is translated again");
  ctx.noNext = true; // the last chapter of a book has no next link
  store.set(old, { translated: "English text", suggestions: [], model: "gemini", savedAt: 1 });
  await assert.rejects(onRawRequest(old + "#original", { ...meta, translate: false, findNext: true }), /no next-chapter link/);
  assert.strictEqual(store.get(old).next, undefined, "nothing is added when there is no link");
  ctx.noNext = false;

  // ---- a chapter a site splits over two pages is read whole, and its next chapter is the last page's own link ----
  calls = [];
  sent.length = 0;
  const split = "translation:https://www.uuread.tw/chapter/1/10.html#original";
  await onRawRequest(split, { ...meta, translate: true, ahead: 0, source: "" });
  assert.deepStrictEqual(calls, ["https://www.uuread.tw/chapter/1/10.html", "https://www.uuread.tw/chapter/1/10_2.html"], "both pages were downloaded");
  const whole = store.get(split);
  assert.ok(whole.translated.includes("Part one line") && whole.translated.includes("Part two line"), "the saved text is the whole chapter");
  assert.strictEqual(whole.next, "https://www.uuread.tw/chapter/1/11.html", "the next chapter comes from the last page, not from page 1's 'next' link (which only leads to page 2)");
  await sleep(100);
  assert.ok(sent.find((m) => m.type === "original:translate").job.text.includes("Part two line"), "and the whole text goes to the translator");

  // ---- asked again: left alone; asked to redo it (force): every page is read again and the translation replaces the old one ----
  calls = [];
  sent.length = 0;
  await onRawRequest(split, { ...meta, translate: true, ahead: 0, source: "" });
  await sleep(100);
  assert.strictEqual(calls.length, 0, "an existing chapter is not downloaded again");
  ctx.part2 = "Part two edited";
  await onRawRequest(split, { ...meta, translate: true, ahead: 0, source: "", force: true });
  assert.ok(store.get(split).translated.includes("Part two edited"), "force reads the pages again");
  await sleep(100);
  assert.ok(sent.some((m) => m.type === "original:translate" && m.job.force === true), "and the translator is told to replace what it has");
  assert.ok(sent.filter((m) => m.type === "original:translate").every((m) => m.job.retranslate === false), "a re-fetch is not a re-translate (an English chapter is refreshed, not translated)");

  // ---- a chapter asked for on behalf of a site novel binds that novel's glossary to the chapter's site ----
  sent.length = 0;
  await onRawRequest("translation:https://www.uuread.tw/chapter/1/10.html#original", { ...meta, translate: true, ahead: 0, source: "", wtrRawId: "93016" });
  const binds = sent.filter((m) => m.type === "wtr:bindsource");
  assert.ok(binds.length === 1 && binds[0].rawId === "93016" && binds[0].url === "https://www.uuread.tw/chapter/1/10.html", "the novel's glossary is bound (once per request)");
  sent.length = 0;
  await onRawRequest("translation:https://www.uuread.tw/chapter/1/10.html#original", { ...meta, translate: true, ahead: 0, source: "", wtrRawId: "not-a-number" });
  assert.ok(!sent.some((m) => m.type === "wtr:bindsource"), "a bad novel id binds nothing");
  await sleep(1500); // let the translations those requests queued finish, so the next step starts clean

  // ---- re-translate: the saved original text is translated again, nothing is downloaded; re-fetch (force) is the one that downloads ----
  calls = [];
  sent.length = 0;
  const savedRaw = store.get(split).translated;
  await onRawRequest(split, { ...meta, translate: true, ahead: 0, source: "", retranslate: true });
  await sleep(100);
  assert.strictEqual(calls.length, 0, "re-translate downloads nothing");
  const rt = sent.filter((m) => m.type === "original:translate").map((m) => m.job);
  assert.ok(rt.length === 1 && rt[0].force === true && rt[0].text === savedRaw, "the saved original goes to the translator again, replacing the translation");
  assert.strictEqual(rt[0].retranslate, true, "and the translator is told it was asked for on purpose");
  assert.ok(!("custom" in rt[0]), "no custom prompt: none is sent");
  // with the reader's Custom prompt: it goes to the translator with the job
  await sleep(1500);
  sent.length = 0;
  const custom = { prompt: "Try this.", notes: true, glossary: false, replace: true };
  await onRawRequest(split, { ...meta, translate: true, ahead: 0, source: "", retranslate: true, custom });
  await sleep(100);
  assert.strictEqual(calls.length, 0, "and downloads nothing");
  const ct = sent.filter((m) => m.type === "original:translate").map((m) => m.job);
  assert.ok(ct.length === 1 && ct[0].force === true && JSON.stringify(ct[0].custom) === JSON.stringify(custom), "the prompt and what goes with it go to the translator");
  await sleep(1500);
  calls = [];
  sent.length = 0;

  // ---- anything else is refused without a request ----
  calls = [];
  for (const bad of ["translation:https://evil.example/x#original", "translation:https://wtr-lab.com/en/novel/8053; drop/x/chapter-1#original"]) {
    await assert.rejects(onRawRequest(bad, meta), /./, bad);
  }
  assert.strictEqual(await onRawRequest("translation:https://www.69shuba.com/x#original-not", meta), undefined, "a key that is not an original-text key is ignored");
  assert.strictEqual(calls.length, 0, "bad keys make no request");

  // ---- looking for new chapters (the "New chapters" tab): a source that lists its chapters answers with the whole list ----
  const found = await ctx.__checkWatch({ source: "wtr-lab.com", url: "https://wtr-lab.com/en/novel/8053/synthesis-wizard" });
  assert.strictEqual(found.kind, "list");
  assert.deepStrictEqual(found.chapters.map((c) => c[0]), [1, 2, 3], "sorted by number; the entry without a number is dropped");
  assert.deepStrictEqual(Array.from(found.chapters[1]), [2, "Chapter 2 Beta", "https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-2", "第2章"], "number, title, the chapter's own address, original title");
  await assert.rejects(ctx.__checkWatch({ source: "wtr-lab.com", url: "" }), /not known yet/, "wtr-lab needs the novel's address");

  // ---- a site with a chapter-list page (uuread): one request gives every chapter ----
  calls = [];
  const toc = await ctx.__checkWatch({ source: "uuread.tw", from: "https://www.uuread.tw/chapter/1/10.html" });
  assert.deepStrictEqual(calls, ["https://www.uuread.tw/1"], "just the list page, not the chapters");
  assert.strictEqual(toc.kind, "toc");
  assert.strictEqual(toc.tocUrl, "https://www.uuread.tw/1");
  assert.deepStrictEqual(Array.from(toc.chapters, (c) => Array.from(c)), [[1, "第10章 a", "https://www.uuread.tw/chapter/1/10.html"], [2, "第11章 b", "https://www.uuread.tw/chapter/1/11.html"], [3, "第12章 c", "https://www.uuread.tw/chapter/1/12.html"]], "number, title and address of every chapter, in order");

  // ---- a site whose rule has a list selector but no address: the list is found through the "目录" link on the chapter's own page ----
  vm.runInContext('RawSources.register("fixture.example", { selector: "div.c", toc: { list: "ul.chapters a" } })', ctx);
  ctx.fixtureLink = true;
  calls = [];
  const viaLink = await ctx.__checkWatch({ source: "fixture.example", from: "https://fixture.example/read/1/5.html" });
  assert.deepStrictEqual(calls, ["https://fixture.example/read/1/5.html", "https://fixture.example/book/1"], "the chapter page, then the list page it links to");
  assert.strictEqual(viaLink.kind, "toc");
  assert.strictEqual(viaLink.tocUrl, "https://fixture.example/book/1");
  assert.deepStrictEqual(Array.from(viaLink.chapters, (c) => c[0]), [1, 2, 3], "numbered by place in the list");
  // no such link on the page: the list cannot be found, so the pages are followed after all
  ctx.fixtureLink = false;
  const noLink = await ctx.__checkWatch({ source: "fixture.example", from: "https://fixture.example/read/1/5.html" });
  assert.deepStrictEqual([noLink.kind, Array.from(noLink.urls)], ["follow", ["https://fixture.example/read/1/6.html"]], "falls back to following the next-chapter links");

  // ---- a book's own page that is the list itself (no link to a list on it) ----
  sent.length = 0;
  calls = [];
  ctx.fixtureLink = false;
  await onRawRequest("translation:https://fixture.example/book/1#list", { ...meta });
  assert.deepStrictEqual(calls, ["https://fixture.example/book/1"], "the page is read once and is the list");
  const ownList = sent.find((m) => m.type === "list:apply");
  assert.deepStrictEqual(Array.from(ownList.found.chapters, (c) => c[0]), [1, 2, 3], "its chapters, in order");
  assert.strictEqual(ownList.found.tocUrl, "https://fixture.example/book/1");


  // ---- a site without a list page is followed page by page, from the latest chapter known ----
  const follow = await ctx.__checkWatch({ source: "69shuba.com", from: "https://www.69shuba.com/txt/77582/38804612" });
  assert.deepStrictEqual([follow.kind, Array.from(follow.urls), follow.more], ["follow", ["https://www.69shuba.com/txt/77582/38804613"], false], "chapter 612's page links to 613, whose page has no further chapter");
  await assert.rejects(ctx.__checkWatch({ source: "uuread.tw", from: "" }), /no chapter to start from/, "a source with no chapter read yet cannot be looked at");
  await assert.rejects(ctx.__checkWatch({ source: "fanqienovel.com", from: "https://fanqienovel.com/reader/1" }), /no chapter to start from/, "a site that cannot be read is refused");
  await assert.rejects(ctx.__checkWatch(null), /no source/);

  // ---- a watch set to every chapter (watcher.js then: "all"): the chapters of its list not here, a batch at a time ----
  ctx.LibraryHost = { isMember: () => true, call: async (op, args) => (op === "api" && args[1] === "/api/settings" ? ctx.settingsNow || {} : null) };
  ctx.__bulkScale(0.01); // (the site's 12 seconds between a batch's chapters, as 120 ms)
  const wl = (n) => ({ num: n, title: "Chapter " + n, url: "https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-" + n });
  const wlist = [20, 21, 22, 23].map(wl);
  store.set("translation:" + wl(20).url, { translated: "here", model: "wtr-lab" }); // one is here already
  const ww = { id: "wtr-lab:8053|wtr-lab.com", novel: "wtr-lab:8053", source: "wtr-lab.com", name: "Synthesis Wizard" };
  const savedWl = (n) => store.get("translation:" + wl(n).url);
  const ff = async (...a) => JSON.parse(JSON.stringify(await ctx.__fetchFound(...a))); // (the answer is made in the extension's realm)
  const waitSaved = async (ns) => { for (let i = 0; i < 100 && !ns.every(savedWl); i++) await sleep(100); assert.ok(ns.every(savedWl), "chapters " + ns + " saved"); };
  ctx.readerAt = [];
  assert.deepStrictEqual(await ff(wlist, ww, { missing: true, batch: 2 }), { asked: 2, complete: false }, "the first two not here");
  assert.deepStrictEqual(await ff(wlist, ww, { missing: true, batch: 2 }), { asked: 0, busy: true }, "nothing more while that batch is being fetched");
  await waitSaved([21, 22]);
  assert.ok(ctx.readerAt.length === 2 && ctx.readerAt[1] - ctx.readerAt[0] >= 100, "a batch's chapters are asked for apart, as WebToEpub spaces wtr-lab's: " + JSON.stringify(ctx.readerAt));
  assert.deepStrictEqual([savedWl(21).novelName, savedWl(21).model.startsWith("wtr-lab")], ["Synthesis Wizard", true], "wtr-lab's English, under the novel's name in the library");
  assert.deepStrictEqual(await ff(wlist, ww, { missing: true, batch: 2 }), { asked: 1, complete: false }, "then the rest");
  await waitSaved([23]);
  assert.deepStrictEqual(await ff(wlist, ww, { missing: true, batch: 2 }), { asked: 0, complete: true }, "every chapter is here");
  // one that does not come is not asked for again at once (a pass a minute would ask for it forever)
  ctx.wtrDown = true;
  const wl2 = [wl(24)];
  assert.strictEqual((await ff(wl2, ww, { missing: true, batch: 2 })).asked, 1);
  for (let i = 0; i < 50 && (await ff(wl2, ww, { missing: true, batch: 2 })).busy; i++) await sleep(100);
  assert.deepStrictEqual(await ff(wl2, ww, { missing: true, batch: 2 }), { asked: 0, complete: true }, "a chapter that failed is left alone for a while");
  ctx.wtrDown = false;
  await assert.rejects(ctx.__fetchFound(wlist, { ...ww, name: "", novel: "wtr-lab:8053" }), /no novel name/, "with no name, nothing is fetched (it would land in no novel)");

  // a site that refuses (the site's Turnstile check) refuses every chapter: the watch's fetching pauses, it does not go on down the list
  const notBusy = async (list, w) => { for (let i = 0; i < 80; i++) { const r = await ff(list, w, { missing: true, batch: 2 }); if (!r.busy) return r; await sleep(100); } return null; };
  ctx.wtrTurnstile = true;
  const wt = { ...ww, id: "turnstile|wtr-lab.com" };
  const tl = [30, 31, 32, 33, 34, 35].map(wl);
  assert.strictEqual((await ff(tl, wt, { missing: true, batch: 2 })).asked, 2, "a first batch");
  const p1 = await notBusy(tl, wt);
  assert.ok(p1 && !p1.asked && p1.paused > Date.now() + 9 * 60 * 1000 && /asks for its Turnstile check/.test(p1.reason), "refused (requireTurnstile): paused for 10 minutes, and nothing more asked: " + JSON.stringify(p1));
  assert.deepStrictEqual(await ff(tl, wt, { missing: true, batch: 2 }), { asked: 0, paused: p1.paused, reason: p1.reason }, "still paused at the next pass");
  const fl = JSON.parse(JSON.stringify(ctx.__fills()))[wt.id];
  assert.deepStrictEqual([fl.asked, fl.got, fl.pausedUntil, /Turnstile/.test(fl.reason)], [2, 0, p1.paused, true], "the extension's schedule says so (the site's Triggers tab)");
  // "Try again now", once the check is passed: the same chapters (refused, not missing)
  ctx.wtrTurnstile = false;
  assert.strictEqual(ctx.__resumeFill(wt.id), true);
  assert.deepStrictEqual(await ff(tl, wt, { missing: true, batch: 2 }), { asked: 2, complete: false }, "it goes on");
  await waitSaved([30, 31]);
  // a chapter the site has not translated (CHAPTER_LOCKED) is that chapter's failure, not a refusal: the next ones are asked for
  ctx.wtrLocked = true;
  const wk = { ...ww, id: "locked|wtr-lab.com" };
  const kl = [50, 51, 52].map(wl);
  assert.strictEqual((await ff(kl, wk, { missing: true, batch: 1 })).asked, 1);
  for (let i = 0; i < 50 && (await ff([], wk, { missing: true, batch: 1 })).busy; i++) await sleep(100);
  ctx.wtrLocked = false;
  const k2 = await ff(kl, wk, { missing: true, batch: 1 });
  assert.deepStrictEqual(k2, { asked: 1, complete: false }, "not paused: the next chapter is asked for");
  assert.ok(announced.some(([k, st, info]) => /chapter-50#original$/.test(k) && st === "failed" && /not AI-translated on the site/.test(info.error || "")), "and the locked one says why");
  await waitSaved([51]);
  // the wait between chapters: the novel's own for the source (the watch's `wait`), else the person's for the site (settings.siteWaits), else
  // The site's own (wtr-lab: 12 seconds); a paced batch is as many as that wait fits in a minute
  const pl = Array.from({ length: 55 }, (_, i) => wl(60 + i));
  ctx.settingsNow = {};
  assert.strictEqual((await ff(pl, { ...ww, id: "pace1|wtr-lab.com" }, { missing: true, batch: 5, paced: true })).asked, 5, "the site's own, 12 seconds: 5 a minute");
  ctx.settingsNow = { siteWaits: { "wtr-lab.com": 2 } };
  assert.strictEqual((await ff(pl.slice(40), { ...ww, id: "pace0|wtr-lab.com", wait: 6 }, { missing: true, batch: 5, paced: true })).asked, 10, "the novel's own (6 seconds) before the site's default: 10");
  for (let i = 0; i < 300 && (await ff([], { ...ww, id: "pace0|wtr-lab.com" }, { missing: true, batch: 5, paced: true })).busy; i++) await sleep(100);
  ctx.readerAt = [];
  assert.strictEqual((await ff(pl.slice(5, 40), { ...ww, id: "pace2|wtr-lab.com" }, { missing: true, batch: 5, paced: true })).asked, 30, "the person's default for wtr-lab, 2 seconds: 30 in a minute");
  for (let i = 0; i < 450 && !pl.slice(5, 35).every((c) => savedWl(c.num)); i++) await sleep(100); // (the 30, a second each: the extension's own turn between requests)
  assert.ok(pl.slice(5, 35).every((c) => savedWl(c.num)), "the 30 came");
  const steps = ctx.readerAt.slice(1).map((t, i) => t - ctx.readerAt[i]);
  assert.ok(steps.length >= 29 && steps.every((g) => g >= 15), "still one at a time: " + JSON.stringify(steps.slice(0, 5)));
  ctx.settingsNow = {};
  // three batches in a row that bring nothing (whatever the reason) pause it too
  ctx.wtrDown = true;
  const we = { ...ww, id: "empty|wtr-lab.com" };
  const el = [40, 41, 42, 43, 44, 45, 46, 47].map(wl);
  let r = await ff(el, we, { missing: true, batch: 2 });
  for (let n = 0; n < 3 && r && !r.paused; n++) r = await notBusy(el, we);
  assert.ok(r && r.paused > Date.now() && /down/.test(r.reason), "three empty batches: paused: " + JSON.stringify(r));
  assert.strictEqual(JSON.parse(JSON.stringify(ctx.__fills()))[we.id].asked, 6, "after three batches, no fourth");
  ctx.wtrDown = false;

  // a source site's chapters are translated with their novel's profile (watched: profile-translate.js, in the background); one that cannot be used here (no key in
  // this browser, no sign-in, no tickets) pauses the watch at once, saying why (the site's Triggers tab: it is not the source that refused); after the pause the
  // same chapters are translated, their text already here
  const sw = { id: "profile|69shuba.com", novel: "name:Martial Universe", source: "69shuba.com", name: "Martial Universe" };
  const sl = [14, 15].map((n) => ({ num: n, title: "Chapter " + n, url: "https://www.69shuba.com/txt/77582/388046" + n }));
  for (const c of sl) { store.delete("translation:" + c.url); store.delete("translation:" + c.url + "#original"); }
  sent.length = 0;
  ctx.translateReply = { error: "No key for Own mini in this browser: add it in the library's Settings › Translation", stop: true };
  assert.strictEqual((await ff(sl, sw, { missing: true, batch: 2 })).asked, 2, "a batch of the source's chapters");
  const sp = await notBusy(sl, sw);
  assert.ok(sp && sp.paused > Date.now() + 9 * 60 * 1000 && /No key for Own mini/.test(sp.reason), "paused at once, with why: " + JSON.stringify(sp));
  const jobs2 = sent.filter((m) => m.type === "original:translate").map((m) => m.job);
  assert.ok(jobs2.length === 2 && jobs2.every((j) => j.watched === true), "each handed to the translator as a watch's chapter: " + JSON.stringify(jobs2.map((j) => j.watched)));
  assert.strictEqual(JSON.parse(JSON.stringify(ctx.__fills()))[sw.id].translating, true, "said as translating's");
  ctx.translateReply = null;
  ctx.__resumeFill(sw.id);
  calls = [];
  sent.length = 0;
  assert.deepStrictEqual(await ff(sl, sw, { missing: true, batch: 2 }), { asked: 2, complete: false }, "Try again now: the same chapters");
  for (let i = 0; i < 50 && sent.filter((m) => m.type === "original:translate").length < 2; i++) await sleep(100);
  assert.strictEqual(sent.filter((m) => m.type === "original:translate").length, 2, "translated");
  assert.ok(!calls.some((u) => /69shuba/.test(u)), "from the text kept, not downloaded again: " + JSON.stringify(calls));
  assert.strictEqual(JSON.parse(JSON.stringify(ctx.__fills()))[sw.id].translating, false, "no longer paused");

  // ---- links from the library site's own tab (through site-bridge.js): only a "p2p-local" port from a tab of the site is taken ----
  // (which addresses are the site is LibraryHost.fromSite's to say: library-host.test.js)
  assert.strictEqual(typeof onConnect, "function", "the host listens for local links");
  ctx.LibraryHost.fromSite = (s) => !!(s && s.tab && /^https:\/\/p2p-library\.pages\.dev\//.test(s.url || ""));
  const fakePort = (over) => { const p = { name: "p2p-local", sender: { tab: { id: 1 }, url: "https://p2p-library.pages.dev/#/" }, registered: 0, onMessage: { addListener: () => p.registered++ }, onDisconnect: { addListener: () => p.registered++ }, postMessage: () => {}, ...over }; return p; };
  const okPort = fakePort({});
  onConnect(okPort);
  assert.strictEqual(okPort.registered, 2, "a content script's p2p-local port is wired up (messages and disconnect)");
  for (const bad of [fakePort({ name: "something-else" }), fakePort({ sender: {} }), fakePort({ sender: undefined }), fakePort({ sender: { tab: { id: 2 }, url: "http://heavenlydao.com/" } })]) {
    onConnect(bad);
    assert.strictEqual(bad.registered, 0, "any other connection is ignored");
  }

  // ---- another language: a version of the site chapter itself, translated from the source's original ----
  const OWN_URL = "https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-1";
  await sleep(3000); // (what the steps before queued is done)
  finalUrl = SOURCE; // (the raw link leads to the novel's source again)
  sent.length = 0;
  calls = [];
  store.set("translation:" + OWN_URL, { translated: "wtr-lab's English text of the chapter, long enough.", model: "wtr-lab", savedAt: 1, pageTitle: "Chapter 1: Synthesis Cube", novelName: "Synthesis Wizard" });
  await onRawRequest(wtrKey, { ...meta, ahead: 0, lang: "si" });
  await sleep(200);
  const si = sent.find((m) => m.type === "original:translate");
  assert.ok(si, "asked for Sinhala: the chapter is handed to the translator");
  assert.deepStrictEqual([si.job.url, si.job.saveUrl, si.job.lang], [SOURCE, OWN_URL, "si"], "its text is the source's original; the result is kept under the wtr-lab chapter's own address, in that language");
  assert.ok(si.job.text.includes("第一章"));
  assert.ok(announced.some((a) => a[0] === wtrKey && a[1] === "done" && !a[2].url), "done is told without the source's address: the chapter stays the wtr-lab one");
  // a version that is there is not made again, and the source is not asked
  sent.length = 0;
  calls = [];
  store.set("translation:" + OWN_URL + "#lang=si", { translated: "සිංහල", model: "gemini", savedAt: 2 });
  await onRawRequest(wtrKey, { ...meta, ahead: 0, lang: "si" });
  await sleep(100);
  assert.ok(!sent.some((m) => m.type === "original:translate") && calls.length === 0, "nothing is translated or fetched again");
  // the library's language when the request names none
  store.delete("translation:" + OWN_URL + "#lang=si");
  ctx.targetLang = "si";
  await onRawRequest(wtrKey, { ...meta, ahead: 0 });
  await sleep(200);
  assert.strictEqual(sent.find((m) => m.type === "original:translate").job.lang, "si", "the language the library says");
  ctx.targetLang = "";
  // the source out of reach: the chapter's own English text is translated instead
  sent.length = 0;
  ctx.wtrDown = true;
  await onRawRequest(wtrKey, { ...meta, ahead: 0, lang: "si" }).catch(() => {});
  ctx.wtrDown = false;
  await sleep(200);
  const viaEnglish = sent.find((m) => m.type === "original:translate");
  assert.ok(viaEnglish, "the source could not be read: still translated");
  assert.deepStrictEqual([viaEnglish.job.url, viaEnglish.job.saveUrl, viaEnglish.job.lang, viaEnglish.job.text], [OWN_URL, OWN_URL, "si", "wtr-lab's English text of the chapter, long enough."], "from wtr-lab's English, kept under the chapter's own address");
  store.delete("translation:" + OWN_URL);

  // ---- the Raw link cannot be followed: a source site the extension may not read yet is named (and noted for the popup's Allow), not blamed on a bot check ----
  const noRaw = "translation:https://wtr-lab.com/en/novel/8053/synthesis-wizard/chapter-77#original";
  const noRawMeta = { novelName: "Synthesis Wizard", pageTitle: "Chapter 77", translate: true };
  const failureOf = () => announced.filter(([k, st]) => k === noRaw && st === "failed").map(([, , i]) => i.error).pop();
  const guarded = [];
  ctx.rawThrows = true;
  ctx.novelReply = { novel: { rawHost: "69shuba.com" } };
  await onRawRequest(noRaw, noRawMeta).catch(() => {});
  assert.ok(/could not follow the site's Raw link \(Failed to fetch\)/.test(failureOf()), "with no way to ask about access, the failure is as it was, with the browser's own words");
  ctx.SiteAccess = { fetch: (u, o) => ctx.fetch(u, o), guard: async (u) => { guarded.push(u); if (ctx.denied) throw new Error("not allowed to read 69shuba.com yet: open the extension's popup and press Allow"); } };
  ctx.denied = true;
  await onRawRequest(noRaw, noRawMeta).catch(() => {});
  assert.deepStrictEqual(guarded, ["https://69shuba.com/"], "the novel's source site (the library's rawHost) is the one asked about");
  assert.ok(/not allowed to read 69shuba\.com yet.*press Allow/.test(failureOf()), "and the failure says to allow it, not to pass a bot check");
  ctx.denied = false;
  await onRawRequest(noRaw, noRawMeta).catch(() => {});
  assert.ok(/Cloudflare check/.test(failureOf()), "a site that is allowed keeps the bot-check advice");
  ctx.novelReply = null;
  guarded.length = 0;
  await onRawRequest(noRaw, noRawMeta).catch(() => {});
  assert.strictEqual(guarded.length, 0, "a novel whose source site is not known is not guessed at");
  ctx.rawThrows = false;
  delete ctx.SiteAccess;

  // ---- another device of the library asks (remote): nothing is fetched or translated for it unless switched on in this browser (helpDevices) ----
  await sleep(3000); // (what the steps before queued is done)
  const OTHER = (n) => "translation:https://www.69shuba.com/txt/77582/388046" + n + "#original";
  for (const n of [14, 15]) { store.delete(OTHER(n)); store.delete(OTHER(n).replace(/#original$/, "")); }
  const told = [];
  const from = { decline: (why) => told.push(why) };
  const remoteMeta = { remote: true, novelName: "Martial Universe", pageTitle: "Chapter 14", translate: true, ahead: 0 };
  const ask = (key, m) => onRawRequest(key, m, from).then(() => "done", (e) => (e && e.declined ? "declined: " + e.message : "failed: " + (e && e.message)));
  ctx.help = null;
  calls = [];
  sent.length = 0;
  announced.length = 0;
  let got = await ask(OTHER(14), remoteMeta);
  assert.ok(/^declined: The extension on your computer doesn't fetch chapters for your other devices/.test(got), "off by default: declined, saying why: " + got);
  assert.ok(!calls.some((u) => /69shuba/.test(u)) && !store.has(OTHER(14)), "nothing fetched");
  assert.ok(!announced.some(([k]) => k === OTHER(14)), "and nothing told to the other devices (another extension may be doing it)");
  for (const k of ["translation:https://www.69shuba.com/txt/77582/38804614#list", "translation:https://www.69shuba.com/txt/77582/38804614#details"]) {
    assert.ok(/^declined: .*doesn't fetch/.test(await ask(k, { remote: true })), "nor a chapter list or a book's details: " + k);
  }
  assert.ok(/^declined: .*doesn't fetch/.test(await ask(wtrKey, { ...meta, remote: true })), "nor a site chapter from its source");
  assert.ok(/^declined: .*doesn't fetch/.test(await ask(OTHER(14), { ...remoteMeta, findNext: true })), "nor the next chapter's link");
  // fetching on, translating off: the text is fetched, the asker is told it is not translated
  ctx.help = { fetch: true, translate: false };
  got = await ask(OTHER(14), remoteMeta);
  assert.strictEqual(got, "done");
  assert.ok(store.get(OTHER(14)) && store.get(OTHER(14)).translated, "the chapter's text is fetched");
  assert.ok(told.length === 1 && /doesn't translate for your other devices/.test(told[0]), "the asker is told it is not translated: " + JSON.stringify(told));
  await sleep(200);
  assert.ok(!sent.some((m) => m.type === "original:translate"), "and it is not");
  assert.ok(/^declined: .*doesn't translate/.test(await ask(OTHER(14), { ...remoteMeta, retranslate: true })), "a re-translate of a chapter whose text is here: declined");
  assert.ok(/^declined: .*doesn't translate/.test(await ask(wtrKey, { ...meta, remote: true })), "a site chapter from its source (translated as it comes): declined");
  assert.ok(/^declined: .*doesn't translate/.test(await ask("translation:https://www.69shuba.com/txt/77582/38804614#notes", { remote: true })), "Gemini's notes: declined");
  assert.strictEqual(await ask(OTHER(14), { ...remoteMeta, translate: false }), "done", "only its text (a device that translates itself, with a profile): done");
  // both on: as before
  ctx.help = { fetch: true, translate: true };
  told.length = 0;
  sent.length = 0;
  got = await ask(OTHER(15), { ...remoteMeta, pageTitle: "Chapter 15" });
  assert.strictEqual(got, "done");
  await sleep(200);
  assert.ok(sent.some((m) => m.type === "original:translate" && m.job.url === OTHER(15).replace(/^translation:|#original$/g, "")) && !told.length, "fetched and translated, nothing declined");
  // this browser's own tab (a local link) and this extension's own work are never held to it
  ctx.help = null;
  sent.length = 0;
  store.delete(OTHER(15).replace(/#original$/, ""));
  assert.strictEqual(await ask(OTHER(15), { ...remoteMeta, remote: false, retranslate: true }), "done", "the tab in this browser asks for anything");
  await sleep(200);
  assert.ok(sent.some((m) => m.type === "original:translate"), "and it is translated");
  // a read of the library: never for another device, as before for this browser's tab
  assert.strictEqual(await answerApi("/api/novels", { remote: true }), null, "another device's read of the library is not answered");
  // the switches are kept in this extension (the service worker's storage, in Chrome)
  ctx.help = null;

  console.log("OK — chapter fetching checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e && e.stack);
  process.exit(1);
});
