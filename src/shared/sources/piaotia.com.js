// piaotia.com. WebToEpub: PtwxzParser.js. GBK, and the chapter text is the whole page body minus its furniture.
(function (R) {
  const { JUNK } = R.helpers;
  R.register("piaotia.com", { selector: "body", junk: JUNK + ", #guild, #shop, .toplink, table, #feit2, #Commenddiv, .bottomlink", charset: "gbk", from: "PtwxzParser.js" });
})(RawSources);
