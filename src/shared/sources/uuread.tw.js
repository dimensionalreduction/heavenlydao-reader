// uuread.tw. No WebToEpub parser: the layout was read off the site. A chapter is split over pages ("1 / 2"), and the book page
// https://www.uuread.tw/<book> lists every chapter in ul#newlist (a short "latest" list above it is left out).
(function (R) {
  const { JUNK, samePart, linksUnder } = R.helpers;
  R.register("uuread.tw", {
    selector: "div.txt_tcontent",
    junk: JUNK,
    toc: {
      url: (url) => {
        const book = (/^https:\/\/[^/]+\/(?:chapter\/)?(\d+)(?:\/|$|\.)/.exec(url) || [])[1];
        return book ? new URL("/" + book, url).href : null;
      },
      list: (doc, base) => linksUnder(doc, "ul#newlist li a", base)
    },
    next: (doc, url) => {
      const a = [...doc.querySelectorAll("a")].find((x) => /下一[頁页]/.test(x.textContent || ""));
      return a ? samePart(a.getAttribute("href"), url) : null;
    }
  });
})(RawSources);
