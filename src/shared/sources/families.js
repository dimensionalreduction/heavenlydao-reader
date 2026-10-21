// Chapter lists for families of sites that share a layout (one WebToEpub parser class, many domains). The generator reads a list only when it is
// "the links under a selector"; these are the families whose parsers count pages up, build an address, or read a list from a script, so each is
// written out here, once, and applied to every site the generator found for that parser (R.hostsOf). R.extend adds the list to the generated
// rule, which keeps the site's text selector, junk and book details.
//
// Each rule says what WebToEpub's parser does (its file is named above it) in the engine's terms: toc.list reads one page's chapters,
// toc.pages names the other pages of a list that runs over several, toc.url (where it is possible) builds the list page from any address of the novel.
(function (R) {
  const { absolute, linksUnder } = R.helpers;

  const text = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const noInvisible = (s) => String(s || "").replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim(); // (ranobes titles are full of zero-width characters)
  // A page number from a link's address (?page=3), or NaN.
  const pageParam = (href, base, name) => {
    try {
      return parseInt(new URL(href, base).searchParams.get(name || "page"), 10);
    } catch (e) {
      return NaN;
    }
  };
  // The first balanced {...} that follows `marker` in a page's text (a list a script holds as data), parsed; null when there is none.
  function jsonAfter(html, marker) {
    const at = String(html || "").indexOf(marker);
    if (at < 0) return null;
    const open = html.indexOf("{", at + marker.length);
    if (open < 0) return null;
    let depth = 0;
    let quote = false;
    for (let i = open; i < html.length; i++) {
      const c = html[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === '"') quote = false;
      } else if (c === '"') quote = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(html.slice(open, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }
  const withoutTail = (url) => url.replace(/[?#].*$/, "");

  // ---- NovelfullParser.js: allnovelfull.com, novelbin.me, novelfull.com, novlove.com ... (the list runs over ?page=N pages) ----
  // The first page of the list is the book's page. ul.list-chapter holds the links (or a <template> does, when the page is built by a script).
  const novelfullLinks = (doc, base) => {
    if (!doc.querySelector("ul")) {
      const tpl = doc.querySelector("template");
      return tpl && tpl.content ? linksUnder(tpl.content, "li a", base) : [];
    }
    return linksUnder(doc, "ul.list-chapter a", base);
  };
  R.extend(R.hostsOf(["NovelfullParser", "NovelHyphenBinParser"]), {
    toc: {
      list: novelfullLinks,
      // "li.last a" is the link to the last page: its data-page (counting from 0), or its ?page= (from 1) or ?page_num= (from 0) says how many pages there are
      pages: (doc, base) => {
        const link = doc.querySelector("li.last a");
        if (!link) return [];
        let limit;
        let oneBased = false;
        if (link.getAttribute("data-page") != null) limit = parseInt(link.getAttribute("data-page"), 10);
        else if (!isNaN(pageParam(link.getAttribute("href"), base, "page"))) {
          limit = pageParam(link.getAttribute("href"), base, "page");
          oneBased = true;
        } else limit = pageParam(link.getAttribute("href"), base, "page_num");
        limit = oneBased ? limit || 0 : (isNaN(limit) ? -1 : limit) + 1;
        const urls = [];
        for (let i = 2; i <= limit; i++) {
          const u = new URL(link.getAttribute("href"), base);
          if (u.hostname === "novelfulll.com") u.search = "?page_num=" + i;
          else u.search = "?page=" + i + "&per-page=50";
          urls.push(u.href);
        }
        return urls;
      }
    }
  });
  // novelfull.net (NovelfullNetParser): the pages are an <option data-url> list
  R.extend(R.hostsOf("NovelfullNetParser"), {
    toc: {
      list: "ul#idData.ul-list5 a.con",
      pages: (doc, base) => {
        const con = doc.querySelector("a.con");
        let origin = "";
        try {
          origin = con ? new URL(con.getAttribute("href"), base).origin : new URL(base).origin;
        } catch (e) {
          return [];
        }
        return [...doc.querySelectorAll("select#indexselect option")].filter((o) => !o.selected && o.getAttribute("data-url")).map((o) => origin + o.getAttribute("data-url"));
      }
    }
  });
  // novelbin.com and novelping.com (NovelbinParser, NovelpingParser): the whole list is one ajax answer, /ajax/chapter-archive?novelId=<slug>
  R.extend(R.hostsOf(["NovelbinParser", "NovelpingParser"]), {
    toc: {
      // /b/<slug>, /novel/<slug>, /book/<slug> and /book/<slug>/<chapter>: the slug is the second part (a bare /<slug> has only one)
      url: (address) => {
        try {
          const u = new URL(address);
          const parts = u.pathname.split("/").filter(Boolean);
          const slug = parts.length >= 2 ? parts[1] : parts[0];
          return slug ? u.origin + "/ajax/chapter-archive?novelId=" + encodeURIComponent(slug) : null;
        } catch (e) {
          return null;
        }
      },
      // (the link's text also holds the comment count, so the title attribute is the chapter's name when there is one)
      list: (doc, base) => {
        const tpl = doc.querySelector("template");
        const root = tpl && tpl.content ? tpl.content : doc;
        const out = [];
        const seen = new Set();
        for (const a of root.querySelectorAll("ul.list-chapter a, li a")) {
          const url = absolute(a.getAttribute("href") || "", base);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          out.push({ title: (a.getAttribute("title") || text(a)).trim(), url });
        }
        return out;
      }
    }
  });

  // ---- ReadwnParser.js: readwn.com, wuxiabee.*, fanmtl.com, novelmtl.com ... (?page=N, the numbers are in the pagination bar) ----
  R.extend(R.hostsOf("ReadwnParser"), {
    toc: {
      gap: 3000, // (WebToEpub waits this long between its requests)
      list: (doc, base) => {
        const out = [];
        const seen = new Set();
        for (const a of doc.querySelectorAll("ul.chapter-list a")) {
          const url = absolute(a.getAttribute("href") || "", base);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const num = text(a.querySelector(".chapter-no"));
          const title = text(a.querySelector(".chapter-title"));
          out.push({ title: title.includes(num) ? title : num + ": " + title, url });
        }
        return out;
      },
      pages: (doc, base) => {
        const links = [...doc.querySelectorAll("ul.pagination li a")].map((a) => a.getAttribute("href")).filter((h) => h && /[?&]page=/.test(h));
        const max = Math.max(0, ...links.map((h) => pageParam(h, base)).filter((n) => !isNaN(n)));
        const urls = [];
        for (let i = 1; i <= max; i++) {
          const u = new URL(links[0], base);
          u.searchParams.set("page", i);
          if (u.href !== base) urls.push(u.href);
        }
        return urls;
      }
    }
  });

  // ---- LightNovelWorldParser.js: lightnovelpub.com, novelpub.com, lightnovelcave.com, webnovelpub.*, findnovel.net ... ----
  // The list is <book>/chapters, and runs over ?page=N pages; a title without the word "chapter" gets its number put in front.
  R.extend(R.hostsOf(["LightNovelWorldParser", "LightNovelPubParser", "FindNovelParser"]), {
    toc: {
      url: (address) => {
        try {
          const u = new URL(address);
          const parts = u.pathname.split("/").filter(Boolean);
          if (parts[0] !== "novel" || !parts[1]) return null;
          return u.origin + "/novel/" + parts[1] + "/chapters";
        } catch (e) {
          return null;
        }
      },
      list: (doc, base) => {
        const out = [];
        const seen = new Set();
        for (const a of doc.querySelectorAll("ul.chapter-list a")) {
          const url = absolute(a.getAttribute("href") || "", base);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const title = text(a.querySelector(".chapter-title"));
          const no = text(a.querySelector(".chapter-no"));
          out.push({ title: !/chapter/i.test(title) && no ? no + ": " + title : title, url });
        }
        return out;
      },
      pages: (doc, base) => {
        const hrefs = [...doc.querySelectorAll("ul.pagination li a")].map((a) => a.getAttribute("href")).filter(Boolean);
        if (!hrefs.length) return [];
        const max = Math.max(0, ...hrefs.map((h) => pageParam(h, base)).filter((n) => !isNaN(n)));
        const urls = [];
        for (let i = 2; i <= max; i++) {
          const u = new URL(hrefs[0], base);
          u.searchParams.set("page", i);
          urls.push(u.href);
        }
        return urls;
      }
    }
  });

  // ---- 88xiaoshuoParser.js: 88xiaoshuo.net, ilwxs.com, ttshu8.com, shuhaige.net ... (the pages are <list>_2, <list>_3 ...) ----
  R.extend(R.hostsOf("_88xiaoshuoParser"), {
    toc: {
      list: ".read a",
      pages: (doc, base) => {
        const last = [...doc.querySelectorAll(".caption > span > a")].filter((a) => /^(尾页|Last page)$/.test(text(a))).pop();
        if (!last) return [];
        const n = parseInt((/_(\d+)\/?$/.exec(last.getAttribute("href") || "") || [])[1], 10);
        if (!n) return [];
        const root = base.replace(/_\d+\/$/, "").replace(/\/$/, "");
        const urls = [];
        for (let i = 2; i <= n; i++) urls.push(root + "_" + i);
        return urls;
      }
    }
  });

  // ---- FictioneerParser.js: the WordPress theme many translators use. Published chapters only: the scheduled ones (._future) are not readable yet ----
  R.extend(R.hostsOf("FictioneerParser"), {
    toc: {
      list: (doc, base) => {
        const published = linksUnder(doc, ".chapter-group__list ._publish a", base);
        return published.length ? published : linksUnder(doc, ".chapter-group__list-item a", base);
      }
    }
  });

  // ---- NovelOnlineFreeParser.js: novelonlinefree.com, wuxiaworld.online ... (newest first) ----
  R.extend(R.hostsOf("NovelOnlineFreeParser"), { toc: { list: "div.chapter-list a", reverse: true } });

  // ---- FreeWebNovelParser.js: freewebnovel.com, libread.com ... the other pages are ?ajax=chapters&page=N, answered as JSON { code, html } ----
  R.extend(R.hostsOf(["FreeWebNovelParser", "FreeWebNovelComParser"]), {
    toc: {
      list: (doc, base, html) => {
        if (/[?&]ajax=chapters/.test(base) && html) {
          let json = null;
          try {
            json = JSON.parse(html);
          } catch (e) {
            return [];
          }
          if (!json || !json.html || typeof DOMParser === "undefined") return [];
          return linksUnder(new DOMParser().parseFromString(json.html, "text/html"), "a", base);
        }
        return linksUnder(doc, "ul#idData a", base);
      },
      pages: (doc, base, html) => {
        const select = doc.querySelector("#indexselect");
        const total = select ? select.querySelectorAll("option").length : parseInt((/totalPage:\s*(\d+)/.exec(html || "") || [])[1], 10) || 1;
        const root = withoutTail(base);
        const urls = [];
        for (let i = 2; i <= total; i++) urls.push(root + "?ajax=chapters&page=" + i);
        return urls;
      }
    }
  });
  // novellive.com and friends (NovelliveParser): <book>/<n> pages, the last one named by the paging bar
  R.extend(R.hostsOf("NovelliveParser"), {
    toc: {
      list: ".m-newest2 ul li a",
      pages: (doc, base) => {
        const last = [...doc.querySelectorAll(".page a.index-container-btn")].pop();
        const href = last && absolute(last.getAttribute("href") || "", base);
        if (!href) return [];
        const cut = href.lastIndexOf("/");
        const max = parseInt(href.slice(cut + 1), 10);
        if (isNaN(max)) return [];
        const urls = [];
        for (let i = 2; i <= max; i++) urls.push(href.slice(0, cut + 1) + i);
        return urls;
      }
    }
  });

  // ---- RanobesParser.js ----
  // ranobes.net, ranobes.top: the list is <site>/chapters/<book id>/ and its pages /page/N/. Each page holds its chapters as data in a script
  // (window.__DATA__ = { chapters: [{ title, link }], pages_count }), newest first. The book id is in the book's address (/novels/<id>-<name>.html)
  // and in a chapter's (/<name>-<id>/<chapter>.html).
  const ranobesData = (html) => jsonAfter(html, "window.__DATA__ =") || { chapters: [], pages_count: 0 };
  R.extend(["ranobes.net", "ranobes.top"], {
    toc: {
      url: (address) => {
        const m = /^(https:\/\/[^/]+)\/(?:novels\/(\d+)-|chapters\/(\d+)(?:\/|$)|[^/]+-(\d+)\/\d+\.html)/.exec(address || "");
        const id = m && (m[2] || m[3] || m[4]);
        return id ? m[1] + "/chapters/" + id + "/" : null;
      },
      list: (doc, base, html) =>
        ranobesData(html)
          .chapters.filter((c) => c && c.link)
          .map((c) => ({ title: noInvisible(c.title), url: absolute(c.link, base) })),
      pages: (doc, base, html) => {
        const root = (/^(.*\/chapters\/\d+\/)/.exec(withoutTail(base)) || [])[1];
        const n = parseInt(ranobesData(html).pages_count, 10) || 0;
        const urls = [];
        for (let i = 2; root && i <= n; i++) urls.push(root + "page/" + i + "/");
        return urls;
      },
      reverse: true,
      gap: 2000 // (WebToEpub waits 8s and the site answers 429 to a request a second; the reader starts here and slows down by itself if it is told to)
    },
    // the site's book page today: the author is a tag link, the genres sit in their own box, the title carries the original names in a subtitle
    book: {
      title: "h1.title",
      titleDrop: "span.subtitle, span[hidden]",
      author: "span[itemprop='creator'] a, a[href*='/tags/authors/']",
      description: "div.moreless__full",
      cover: "div.r-fullstory-poster",
      genre: "#mc-fs-genre a"
    }
  });
  // ranobes.com: a plain HTML list in #dle-content, the page numbers in a ".pages" bar
  R.extend("ranobes.com", {
    toc: {
      list: (doc, base) => {
        const box = doc.querySelector("#dle-content");
        if (!box) return [];
        const nav = box.querySelector(".navigation");
        if (nav) nav.remove();
        return linksUnder(box, "a", base);
      },
      pages: (doc, base) => {
        const max = Math.max(0, ...[...doc.querySelectorAll(".pages a")].map((a) => parseInt(text(a), 10)).filter((n) => !isNaN(n)));
        const root = withoutTail(base).replace(/page\/\d+\/?$/, "").replace(/\/?$/, "/");
        const urls = [];
        for (let i = 2; i <= max; i++) urls.push(root + "page/" + i + "/");
        return urls;
      },
      reverse: true
    }
  });

  // ---- EmpirenovelParser.js: empirenovel.com. The book's own page lists its chapters, newest first, 30 to a page (a.chapter_link, the date in a .small inside
  // it), and the other pages are ?page=N, up to the highest number in the pagination bar. The list page is /novel/<book>, from a chapter's address too. ----
  R.extend(R.hostsOf("EmpirenovelParser"), {
    toc: {
      url: (address) => {
        const m = /^(https:\/\/[^/]+\/novel\/[^/?#]+)/.exec(address || "");
        return m ? m[1] : null;
      },
      list: (doc, base) => {
        const out = [];
        const seen = new Set();
        for (const a of doc.querySelectorAll("a.chapter_link")) {
          const url = absolute(a.getAttribute("href") || "", base);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const copy = a.cloneNode(true);
          copy.querySelectorAll(".small").forEach((n) => n.remove()); // (the date)
          out.push({ title: text(copy), url });
        }
        return out;
      },
      pages: (doc, base) => {
        const max = Math.max(0, ...[...doc.querySelectorAll(".pagination a")].map((a) => pageParam(a.getAttribute("href"), base)).filter((n) => !isNaN(n)));
        const urls = [];
        for (let i = 2; i <= max; i++) {
          const u = new URL(base);
          u.searchParams.set("page", i);
          urls.push(u.href);
        }
        return urls;
      },
      reverse: true
    }
  });
})(RawSources);
