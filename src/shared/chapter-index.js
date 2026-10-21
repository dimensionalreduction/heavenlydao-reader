// Runs on a reader site's chapter-index page (e.g. https://www.69shuba.com/book/77582/, which lists every chapter of the novel).
// It sends the full list to your library so the site's novel page can show every chapter, including the ones
// you have not translated yet, in chapter order. Titles are translated to English in one batch (through the background script).
//
// To support another site, add an entry to SITES: how to recognise its index page, the key it uses (the same site + directory key
// a glossary binding uses, so chapter URLs and this index line up), and how to read the chapter list from the page.
(function () {
  const isNode = typeof module !== "undefined" && module.exports;
  const FRESH_MS = 6 * 60 * 60 * 1000; // an index changes only when the author posts a new chapter

  const SITES = [
    {
      host: "69shuba.com",
      source: "69shuba",
      page: /^\/book\/(\d+)\/?$/, // /book/77582/ is the full list; /book/77582.htm is the info page (only the latest few)
      key: (m) => "69shuba.com/txt/" + m[1],
      // <li data-num="3"><a href="/txt/77582/38804614">第3章 次级龙血药剂</a></li>   (the first <li> repeats the latest chapter)
      items: (doc) =>
        [...doc.querySelectorAll("li[data-num]")].map((li) => {
          const a = li.querySelector("a[href*='/txt/']");
          return a ? { num: Number(li.getAttribute("data-num")), text: (a.textContent || "").trim(), href: a.getAttribute("href") } : null;
        })
    }
  ];

  // "10.第10章 这就是巫师吗" -> { prefixed: true, body: "这就是巫师吗" }; "后记" -> { prefixed: false, body: "后记" }.
  // Some titles carry a leading "10." before the chapter marker, and some have no title after the number at all.
  function splitTitle(text) {
    const t = String(text || "").replace(/^\d+[.．、]\s*/, "").trim();
    const m = /^第\s*\d+\s*[章节回]\s*(.*)$/.exec(t);
    return m ? { prefixed: true, body: m[1].trim() } : { prefixed: false, body: t };
  }

  // Resolves relative links, drops duplicates (the "latest chapter" entry repeats one) and entries without a usable number.
  function parseItems(items, baseUrl) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it || !Number.isInteger(it.num) || it.num < 0 || !it.href) continue;
      let url;
      try {
        url = new URL(it.href, baseUrl).href;
      } catch (e) {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(Object.assign({ url }, it, splitTitle(it.text)));
    }
    return out.sort((a, b) => a.num - b.num);
  }

  // "Chapter 10: <english>" (the number comes from the page's own numbering), or just the translation for extras like an afterword.
  function composeTitle(item, english) {
    const body = (english || "").trim();
    if (item.prefixed) return "Chapter " + item.num + (body ? ": " + body : "");
    return body || item.text;
  }

  if (isNode) module.exports = { splitTitle, parseItems, composeTitle, SITES };
  if (typeof document === "undefined" || typeof location === "undefined") return; // loaded by a test, not injected into a page

  const ext = typeof browser !== "undefined" ? browser : chrome;

  async function run() {
    const url = new URL(location.href);
    const host = url.hostname.replace(/^www\./, "");
    const site = SITES.find((s) => s.host === host && s.page.test(url.pathname));
    if (!site) return;
    const key = site.key(site.page.exec(url.pathname));

    const stamps = (await ext.storage.local.get("chapterIndexAt")).chapterIndexAt || {};
    if (Date.now() - (stamps[key] || 0) < FRESH_MS) return;

    const items = parseItems(site.items(document), location.href);
    if (!items.length) return;

    // One batch for all titles. If it fails the raw titles are kept, so the list is still complete.
    const reply = await ext.runtime.sendMessage({ type: "translateTitles", texts: items.map((i) => i.body) }).catch(() => null);
    const english = reply && Array.isArray(reply.texts) && reply.texts.length === items.length ? reply.texts : items.map((i) => i.body);

    const result = await ext.runtime.sendMessage({
      type: "chapterindex:save",
      record: {
        key,
        source: site.source,
        url: location.href,
        chapters: items.map((it, i) => [it.num, composeTitle(it, english[i]), it.url, it.text])
      }
    }).catch(() => null);
    if (result && result.ok) {
      stamps[key] = Date.now(); // only remember a successful hand-off, so a down server is retried on the next visit
      await ext.storage.local.set({ chapterIndexAt: stamps });
    }
  }

  // (nothing until this extension is a device of a library, nor with "Library copy" off in its popup: it records nothing then)
  (typeof browser !== "undefined" ? browser : chrome).storage.local.get(["libraryOn", "libraryCopy"]).then((r) => !!r.libraryOn && r.libraryCopy !== false, () => false).then((on) => on && run()).catch(() => {});
})();
