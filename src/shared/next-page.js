// The next page of what is being read: a chapter's next chapter, or a comic reader's next page (nhentai.net/g/<id>/21/ -> /22/). For the popup's Translate ahead
// (translate-ahead.js): wherever a page has a Next link, whatever is behind it (one picture, a whole chapter of pictures, a chapter of text).
// Works on the live page and on one fetched and parsed (DOMParser: no layout, so only addresses, attributes and textContent are looked at).
//   NextPage.find(doc, baseUrl)   the next page's address (same site, not this page), or ""
//   NextPage.fetchDoc(url)        that page fetched as the tab would (its cookies: a site's bot check passed in the tab is passed here too), parsed; null when it fails
var NextPage = (function () {
  // what a site marks its next link with (the first ones: content.js's list before this file)
  const SELECTORS = ['link[rel="next"]', 'a[rel="next"]', "a.next-chapter", "a.next_chapter", "#next_chapter a", ".next-chap a", "a#next", "a.next"];
  // a link's own words (or title, or aria-label) that say it is the next one
  const SAYS = /^(next|next chapter|next page|next episode|next part|›|→|>|下一章|下一页|下一頁|下一节|下一節|下一话|下一話|下一回|下一篇|下一张|下一張|次へ|次のページ|次の話|다음|다음화|다음 화|다음 페이지|다음편|siguiente|suivant|próximo|weiter)$/i;
  const HAS = /next chapter|next page|next episode|下一章|下一页|下一頁|다음화|次の話/i;
  // a class that says it: "next", "btn-next", "next-page", "nav_next" (not "nextjs-…")
  const CLASS = /^(?:[a-z]+[-_])*next(?:[-_](?:page|chapter|chap|episode|ep|link|btn|button|post|nav))?$/i;

  const words = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  // the words without the arrows around them ("Next »" -> "Next"; an arrow alone stays)
  const plain = (t) => t.replace(/^[«»‹›<>←→\s]+|[«»‹›<>←→\s]+$/g, "").trim() || t;
  const bare = (u) => u.split("#")[0].replace(/\/+$/, "");
  // a link's address when it is a page of the same site that is not this one, else ""
  function address(href, baseUrl) {
    if (!href || /^(javascript|mailto|tel|data):/i.test(href.trim())) return "";
    try {
      const u = new URL(href, baseUrl), b = new URL(baseUrl);
      if (!/^https?:$/.test(u.protocol) || u.host !== b.host) return "";
      u.hash = "";
      return bare(u.href) === bare(b.href) ? "" : u.href;
    } catch (e) {
      return "";
    }
  }
  // the addresses this one would have with one of its numbers one more (the last first): /g/138938/21/ -> /g/138938/22, /chapter-9.html -> /chapter-10.html
  function plusOne(baseUrl) {
    const out = [];
    let u;
    try { u = new URL(baseUrl); } catch (e) { return out; }
    const tail = u.pathname + u.search;
    const runs = [...tail.matchAll(/\d+/g)].reverse().slice(0, 3);
    for (const m of runs) {
      const n = String(Number(m[0]) + 1).padStart(m[0].length, "0");
      out.push(bare(u.origin + tail.slice(0, m.index) + n + tail.slice(m.index + m[0].length)));
    }
    return out;
  }

  function find(doc, baseUrl) {
    if (!doc || !baseUrl) return "";
    // a site whose rule says where its next chapter is (raw-sources.js, where it is loaded): that, or none when the rule has a next of its own (a site that splits
    // chapters in parts: the links below would lead to the next part)
    if (typeof RawSources !== "undefined" && RawSources.ruleFor) {
      try {
        const rule = RawSources.ruleFor(baseUrl);
        if (rule) {
          const next = RawSources.nextChapter(doc, baseUrl);
          if (next || rule.next) return next || "";
        }
      } catch (e) { /* the generic search below */ }
    }
    for (const sel of SELECTORS) {
      let el = null;
      try { el = doc.querySelector(sel); } catch (e) { continue; }
      const u = el && address(el.getAttribute("href") || "", baseUrl);
      if (u) return u;
    }
    const links = [...doc.querySelectorAll("a[href]")];
    // a link to this page's address with its page or chapter number one more
    const wanted = plusOne(baseUrl);
    for (const want of wanted) {
      for (const a of links) {
        const u = address(a.getAttribute("href") || "", baseUrl);
        if (u && bare(u) === want) return u;
      }
    }
    // a link that says it is the next: its class or id, its title or label, its words
    for (const a of links) {
      const u = address(a.getAttribute("href") || "", baseUrl);
      if (!u) continue;
      const cls = String(a.getAttribute("class") || "").split(/\s+/).concat(a.id || "");
      const label = String(a.getAttribute("title") || a.getAttribute("aria-label") || "").trim();
      const text = words(a);
      if (cls.some((c) => c && CLASS.test(c)) || SAYS.test(plain(label)) || (text.length <= 24 && (SAYS.test(plain(text)) || HAS.test(text)))) return u;
    }
    return "";
  }

  // The bytes in the page's own encoding (a GBK or Big5 site read as UTF-8 is garbage)
  async function fetchDoc(url) {
    // (Firefox: content.fetch asks as the page does, with its cookies; a content script's own fetch is the extension's)
    const get = typeof content !== "undefined" && content && typeof content.fetch === "function" ? content.fetch.bind(content) : fetch;
    try {
      const res = await get(url, { credentials: "include" });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      let charset = (/charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") || "") || [])[1];
      if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(buf.slice(0, 4096))) || [])[1];
      let html;
      try { html = new TextDecoder(charset || "utf-8").decode(buf); } catch (e) { html = new TextDecoder("utf-8").decode(buf); }
      return new DOMParser().parseFromString(html, "text/html");
    } catch (e) {
      return null;
    }
  }

  const api = { find, fetchDoc, plusOne, address };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
