// novel543.com and twbook.cc (the same layout). WebToEpub: Novel543Parser.js.
(function (R) {
  const { JUNK, absolute, linksUnder } = R.helpers;
  R.register(["novel543.com", "twbook.cc"], {
    selector: "div.chapter-content",
    junk: JUNK + ", div.adBlock, div.gadBlock, h1",
    clean: (box) => {
      for (const tip of box.querySelectorAll("p span[style*='ff6666']")) if (tip.closest("p")) tip.closest("p").remove(); // the "溫馨提示" notice
      for (const img of box.querySelectorAll("img[src*='vip.png']")) if (img.closest("div")) img.closest("div").remove(); // the VIP banner
    },
    // the novel's list is /<book>/dir: the second list on that page
    toc: {
      url: (url) => {
        const book = (/^https:\/\/[^/]+\/(\d+)(?:\/|$)/.exec(url) || [])[1];
        return book ? new URL("/" + book + "/dir", url).href : null;
      },
      list: (doc, base) => linksUnder(doc, "div.chaplist ul:nth-of-type(2) a", base)
    },
    // 8096_1.html continues in 8096_1_2.html: the last link of the footer bar, when it still belongs to this chapter
    next: (doc, url) => {
      const base = (/\/(\d+_\d+)(?:_\d+)?\.html/.exec(url) || [])[1];
      const links = [...doc.querySelectorAll(".foot-nav a")];
      const last = links[links.length - 1];
      const href = last && last.getAttribute("href");
      const next = href && absolute(href, url);
      return base && next && next.includes("/" + base + "_") && next !== url ? next : null;
    },
    from: "Novel543Parser.js"
  });
})(RawSources);
