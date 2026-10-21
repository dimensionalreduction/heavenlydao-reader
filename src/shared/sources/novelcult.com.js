// novelcult.com. No WebToEpub parser: the layout was read off the site. The novel page (/novels/<slug>) links only its first chapter, the whole
// list is on /novels/<slug>/chapters (every chapter in one page, in order), and a chapter's address is /novels/<slug>/chapters/<uuid>.
(function (R) {
  const { JUNK, linksUnder } = R.helpers;
  R.register("novelcult.com", {
    selector: "article.chapter-content",
    junk: JUNK,
    toc: {
      url: (url) => {
        const slug = (/^https:\/\/[^/]+\/novels\/([^/?#]+)/.exec(url) || [])[1];
        return slug ? "https://novelcult.com/novels/" + slug + "/chapters" : null;
      },
      list: (doc, base) => linksUnder(doc, "a[href*='/chapters/']", base, (u) => /\/novels\/[^/]+\/chapters\/[^/?#]+$/.test(u))
    },
    book: { title: "h1.novel-detail-title" }
  });
})(RawSources);
