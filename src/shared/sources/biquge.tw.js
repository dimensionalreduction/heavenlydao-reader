// biquge.tw. WebToEpub: BiqugetwParser.js. A chapter can continue on a "_2" page. The book page (/book/<id>/) lists every chapter; WebToEpub
// reaches it through a "chapter list" link, here it is built from any address of the novel.
(function (R) {
  const { JUNK, samePart } = R.helpers;
  R.register("biquge.tw", {
    selector: "#chaptercontent",
    junk: JUNK,
    next: (doc, url) => {
      const links = [...doc.querySelectorAll("a#next_url")].filter((a) => (a.getAttribute("href") || "").includes("_"));
      const a = links[links.length - 1];
      return a ? samePart(a.getAttribute("href"), url) : null;
    },
    toc: {
      list: "div.booklist ul a",
      url: (address) => {
        const m = /^(https:\/\/[^/]+\/book\/\d+\/)/.exec(address);
        return m ? m[1] : null;
      }
    },
    from: "BiqugetwParser.js"
  });
})(RawSources);
