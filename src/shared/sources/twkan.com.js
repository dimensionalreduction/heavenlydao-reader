// twkan.com. WebToEpub: TwkanParser.js. The whole chapter list comes from one AJAX address, not the book page's "load more" button.
(function (R) {
  const { JUNK, linksUnder } = R.helpers;
  R.register("twkan.com", {
    selector: "#txtcontent0",
    junk: JUNK,
    toc: {
      url: (url) => {
        const book = (/^https:\/\/[^/]+\/(?:txt|book)\/(\d+)/.exec(url) || [])[1];
        return book ? "https://twkan.com/ajax_novels/chapterlist/" + book + ".html" : null;
      },
      list: (doc, base) => linksUnder(doc, "ul li a", base, (u) => u.includes("/txt/"))
    },
    from: "TwkanParser.js"
  });
})(RawSources);
