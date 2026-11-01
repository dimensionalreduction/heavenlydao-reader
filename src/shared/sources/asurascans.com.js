// asurascans.com. No WebToEpub parser (it is a comics site): the layout was read off the site, and off how Keiyoushi's extension for Mihon reads it
// (src/en/asurascans in keiyoushi/extensions-source, Apache-2.0). Its pages are Astro: what a page shows is in the props of its <astro-island> elements,
// every value wrapped as [0, value] or [1, list] (RawSources.helpers.astroProps unwraps them).
//
//   a book (/comics/<slug>-<8 characters>):  ChapterListReact { chapters: [{ number, is_premium, ... }], publicUrl }  the chapter list
//   a chapter (.../chapter/<n>):             ChapterReader { pages: [{ url, width, height }], nextChapter, prevChapter, isLocked, isPremium }
//
// The pictures are read from the island by the extension itself (ImageChapter.urlsFromProps, for a rule with `pictures`), not by a selector. The 8 characters
// at the end of the book's address change from time to time; the site sends the address without them on to the right page, so chapters are kept without them
// (canonical), and their key stays the same. Premium chapters (is_premium) are left out of the list: their pictures are scrambled tiles that need the person's login.
(function (R) {
  const { astroProps, absolute } = R.helpers;
  const HOST = "https://asurascans.com";
  const TAIL = /-(?=[a-z]*\d)[a-z0-9]{8}$/;

  const short = (url) => {
    try {
      const u = new URL(url);
      u.pathname = u.pathname.split("/").map((part) => part.replace(TAIL, "")).join("/");
      return u.href;
    } catch (e) {
      return url;
    }
  };
  const chapterUrl = (publicUrl, number) => HOST + String(publicUrl).replace(/\/$/, "") + "/chapter/" + number;
  // the chapter the page's props name as next or previous: the same book's address with another number
  const neighbour = (which) => (doc, url) => {
    const reader = astroProps(doc, "ChapterReader");
    const n = reader && reader[which + "Chapter"] && reader[which + "Chapter"].number;
    return Number.isFinite(n) ? absolute("./" + n, url.replace(/\/[^/]*$/, "/")) : null;
  };

  R.register("asurascans.com", {
    // a chapter's page has this island; its text is pictures (so `pictures`), and a book's page does not (book-capture tells the two apart by it)
    selector: "astro-island[component-url*='ChapterReader']",
    pictures: true,
    // a premium chapter (early access) has no pictures in its page until it unlocks: the engine says why instead of "no pictures" (its pictures are scrambled tiles that need the
    // person's login on the site; they are not read)
    locked: (doc) => {
      const reader = astroProps(doc, "ChapterReader");
      if (!reader || !(reader.isLocked || (reader.isPremium && !(reader.pages || []).length))) return "";
      const at = Date.parse(reader.unlockTime || "");
      return "this chapter is premium on asurascans.com" + (at ? " until " + new Date(at).toLocaleString() : "") + ": it can be read here once the site makes it free";
    },
    canonical: short,
    nav: { next: neighbour("next"), prev: neighbour("prev") },
    toc: {
      // the book's page from any address of it (a chapter's, with or without the changing end: the site sends the short form on)
      url: (url) => {
        const m = /^https:\/\/(?:www\.)?asurascans\.com\/comics\/([^/?#]+)/.exec(url);
        return m ? HOST + "/comics/" + m[1] : null;
      },
      // the chapters in order, the premium ones left out
      list: (doc, base) => {
        const props = astroProps(doc, "ChapterListReact");
        if (!props || !Array.isArray(props.chapters)) return [];
        const publicUrl = props.publicUrl || new URL(base).pathname;
        return props.chapters
          .filter((c) => c && Number.isFinite(c.number) && !c.is_premium)
          .sort((a, b) => a.number - b.number)
          .map((c) => ({ title: "Chapter " + c.number, url: chapterUrl(publicUrl, c.number) }));
      }
    },
    // the details are in the DescriptionModal island: title, author, synopsis (HTML), cover, genres ({ name }), status
    book: { title: "h1", cover: "meta[property='og:image']", astro: { component: "DescriptionModal", title: "title", author: "author", description: "description", cover: "coverUrl", genre: "genres.name", status: "status" } }
  });
})(RawSources);
