// bixiange.xyz. No WebToEpub parser: the layout was read off the site (pages are GBK and say so).
(function (R) {
  const { JUNK } = R.helpers;
  R.register("bixiange.xyz", { selector: "div.article div.content", junk: JUNK });
})(RawSources);
