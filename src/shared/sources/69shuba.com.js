// 69shuba.com. WebToEpub: 69shuParser.js. The site serves GBK without saying so.
(function (R) {
  const { JUNK } = R.helpers;
  // The list is the book's /book/<id>/ page: <li data-num="3"><a href="/txt/<id>/<chapter>">...</a></li>, which can also repeat the latest chapter.
  const bookId = (address) => (/^https:\/\/(?:www\.)?69shuba\.com\/(?:book|txt)\/(\d+)/.exec(address) || [])[1];
  R.register("69shuba.com", {
    wait: 1000, // (between two chapters fetched one after another: 69shuParser.js's minimumThrottle)
    selector: "div.txtnav",
    junk: JUNK + ", .txtinfo, #txtright, .bottom-ad, h1",
    charset: "gb18030",
    toc: {
      url: (address) => (bookId(address) ? "https://www.69shuba.com/book/" + bookId(address) + "/" : null),
      list: (doc, base) => {
        const rows = [...doc.querySelectorAll("li[data-num]")]
          .map((li) => ({ n: Number(li.getAttribute("data-num")), a: li.querySelector("a[href*='/txt/']") }))
          .filter((x) => x.a && x.n >= 1)
          .sort((a, b) => a.n - b.n);
        const seen = new Set();
        const out = [];
        for (const { a } of rows) {
          const url = R.helpers.absolute(a.getAttribute("href"), base);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          out.push({ title: String(a.textContent || "").replace(/\s+/g, " ").trim(), url });
        }
        return out;
      }
    },
    from: "69shuParser.js"
  });
})(RawSources);
