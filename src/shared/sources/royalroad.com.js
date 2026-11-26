// royalroad.com (and its old name, royalroadl.com). WebToEpub: RoyalRoadParser.js. The generated entry could not be used: its text selector took every
// querySelector in findContent, ".page-content-wrapper", ".author-note" and the "img" of the author notes' links among them, and the engine takes the first
// element of the page any of them finds (the site's logo, then the wrapper of the whole page); and getChapterUrls reads the list in code the generator does not guess.
// The list: the fiction's page holds every chapter as data in a script, window.chapters = [{ id, title, slug, url, ... }] (the table under it shows 20 at a time
// once the page's script runs; as sent it lists them all, the fallback here). A chapter's text is div.chapter-inner; the site hides a line in it naming where
// the chapter was taken from (a <span> or <p> whose made-up class a <style> of the page sets to display: none): it is taken out, as WebToEpub's removeWatermarks does.
(function (R) {
  const { JUNK, absolute } = R.helpers;
  // the fiction's page from any of its addresses (its page, with or without its name, or a chapter's)
  const FICTION = /^(https:\/\/(?:www\.)?royalroadl?\.com\/fiction\/\d+(?:\/(?!chapter\/)[^/?#]+)?)/;
  // the JSON array after `marker` in a page's text, or null
  function arrayAfter(html, marker) {
    const at = String(html || "").indexOf(marker);
    if (at < 0) return null;
    const open = html.indexOf("[", at + marker.length);
    if (open < 0) return null;
    let depth = 0;
    let quote = false;
    for (let i = open; i < html.length; i++) {
      const c = html[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === '"') quote = false;
      } else if (c === '"') quote = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        try {
          return JSON.parse(html.slice(open, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }
  const text = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const spec = {
    selector: "div.chapter-inner",
    junk: JUNK,
    // the classes a <style> of the page hides (display: none): the hidden line in the text
    clean: (box) => {
      const doc = box.ownerDocument;
      if (!doc) return;
      for (const style of doc.querySelectorAll("style")) {
        for (const m of String(style.textContent || "").matchAll(/\.([A-Za-z_][\w-]*)\s*\{[^}]*display\s*:\s*none/g)) {
          box.querySelectorAll("." + m[1]).forEach((n) => n.remove());
        }
      }
    },
    toc: {
      url: (address) => (FICTION.exec(String(address || "")) || [])[1] || null,
      list: (doc, base, html) => {
        const data = arrayAfter(html, "window.chapters =") || arrayAfter(html, "window.chapters=");
        const fiction = ((FICTION.exec(String(base || "")) || [])[1] || "").replace(/^https:\/\/[^/]+/, "");
        if (Array.isArray(data) && data.length) {
          return data
            .filter((c) => c && (c.url || (c.id && fiction)))
            .map((c) => ({ title: String(c.title || "").replace(/\s+/g, " ").trim(), url: absolute(c.url || fiction + "/chapter/" + c.id + "/" + (c.slug || ""), base) }))
            .filter((c) => c.url);
        }
        const seen = new Set();
        const out = [];
        for (const a of doc.querySelectorAll("table#chapters a[href*='/chapter/']")) {
          const url = absolute(a.getAttribute("href"), base);
          if (!url || seen.has(url)) continue; // (a row links its title and its date to the same chapter)
          seen.add(url);
          out.push({ title: text(a), url });
        }
        return out;
      }
    },
    book: {
      title: "div.fic-header div.col h1",
      author: "div.fic-header a[href^='/profile/']",
      description: "div.fiction-info div.description",
      cover: "meta[property='og:image'], meta[name='twitter:image']",
      genre: "a.fiction-tag, a[href*='tagsAdd='], div.fiction-info span.tags .label"
    },
    from: "RoyalRoadParser.js",
    parser: "RoyalRoadParser"
  };
  R.register("royalroad.com", spec);
  R.register("royalroadl.com", { ...spec });
})(RawSources);
