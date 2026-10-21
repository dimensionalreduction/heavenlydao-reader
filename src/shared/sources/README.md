# Source sites

One small description per site, like WebToEpub's one parser per site. A site listed here can be read by the extension: its chapter text
fetched and translated, its next chapter followed, its chapter list read, and new chapters looked for ("New chapters" tab). It is also a
site a "Raw" link in the library can lead to.

| File | What it is |
|---|---|
| `_generated.js` | every site WebToEpub has a parser for (526 of them), **made by `node tools/gen-sources.js`** from `reference/WebToEpub/plugin/js/parsers/`. Do not edit it by hand. |
| `families.js` | the chapter lists of **families of sites that share a layout** (NovelFull's 36 domains, Readwn's 22, LightNovelWorld's 14, 88xiaoshuo, Fictioneer, FreeWebNovel/Novellive, NovelOnlineFree, Novelbin, Ranobes). Their parsers count pages up, build an address or read a list from a script, which the generator does not guess at, so each is written out once here and added (`RawSources.extend`) to every site the generator found for that parser (`RawSources.hostsOf("NovelfullParser")`), keeping the text selector and book details it read. |
| `<site>.js` | a site that needed more than the generator could read, or that was checked by hand. Loaded after `_generated.js`, so it replaces that site's entry. |

The engine (`../raw-sources.js`) holds only the logic. The build joins it with every file here into the one `raw-sources.js` the extension
loads, and adds each listed site to the manifests' permissions, so adding a site is adding a file, nothing else.

## Rules you add yourself

The files here are the **built-in** sites. A person can add their own rule for any other site in the extension (popup > + Rule for this site): a
small data-only rule (`../user-rules.js`), kept in the extension's storage, that wins over a built-in rule for the same site. See the extension's README.

## Adding a site

Look at the site's parser in WebToEpub (`plugin/js/parsers/<Name>Parser.js`) and copy the facts into a file here:

```js
// example.com. WebToEpub: ExampleParser.js.
RawSources.register("example.com", {
  selector: "div.chapter-content",          // ExampleParser.findContent: dom.querySelector("div.chapter-content")
  junk: "script, style, ins, iframe, .ad",  // removeUnwantedElementsFromContentElement (keep "script, style, ins, iframe")
  charset: "gbk",                           // only if its pages are not UTF-8 and do not say so (a TextDecoder in the parser)
  toc: { list: "ul.chapters a" },           // getChapterUrls: the links of the chapter list; add reverse: true if it lists newest first
  from: "ExampleParser.js"
});
```

Then `node build.js`. Run `node test/sources.test.js` to check the registry (it fails on an unusable selector).

Only `selector` is required (unless the rule has `fromHtml`, below). What each field gives:

| Field | WebToEpub's parser | Used for |
|---|---|---|
| `selector` | `findContent(dom)` | the chapter's text |
| `junk` | `removeUnwantedElementsFromContentElement` | elements inside the text that are not story |
| `charset` | `new TextDecoder("gbk")` | pages that do not say their encoding |
| `toc.list` | `getChapterUrls(dom)` | the whole chapter list in one request: the library lists every chapter, and the watcher sees new ones |
| `toc.pages` | `getChapterUrlsFromMultipleTocPages(.., getUrlsOfTocPages)` | the list runs over several pages: `{ options: "#indexselect option", attr: "data-url" }` (elements whose attribute holds each page's address) or `{ links: "ul.pager a" }`. The extension reads the pages one after another, a second apart (at most 150) and joins them. Sites that count page numbers up in code are not covered |
| `toc.boxes` + `toc.pick` | `getChapterUrls(dom)` | instead of `toc.list`: the elements that hold the links, and which one (`"first"`, `"last"`, or an index) the chapters are under (a page with several lists, or a list inside the content box) |
| `book` | `extractTitleImpl`, `extractAuthor`, `extractDescription`, `findCoverImageUrl`, `extractSubject` | where the site's book page says what the book is: `{ title, author, description, cover, genre }`, each a CSS selector. The script that records a book when its page is open (`book-capture.js`) reads it; a page with the standard `og:novel:*` metadata needs none |
| `toc.list(doc, base, html)`, `toc.pages(doc, base, html)` as functions | `extractPartialChapterList`, `getUrlsOfTocPages` | the same, written out: `html` is the page's raw text (its scripts are removed before it is parsed), for a list a script holds as data (ranobes.top's `window.__DATA__`) |
| `book.titleDrop` | `removeChildElementsMatchingSelector(title, ...)` | elements inside the title that are not part of it (ranobes.top's original-language subtitle) |
| `parser` | | the WebToEpub class the rule was made from (the generator adds it); `RawSources.hostsOf(name)` finds the sites of one |
| `toc.url(address)` | (WebToEpub starts from the list page, we start from a chapter) | the list page from any address of the novel; without it the page is found through the chapter's own "目录" / "Table of Contents" link |
| `next(doc, url)` | `walkPagesOfChapter` / `moreChapterTextUrl` | a chapter split over several pages: the address of the next page of the same chapter |
| `clean(box)` | `customRawDomToContentStep` | clean-up a selector cannot express |
| `fromHtml(html, url)` | (a parser that decodes the page itself) | a site whose text is not in the page's elements (encrypted, built by a script): it gives `{ text }` from the page's HTML; see `tomatomtl.com.js` |
| `toc.parse(text, listUrl)` | | a chapter list that is JSON rather than a page (with `toc.url` giving where it is) |
| `registerMirror(host, fn)` | | a site that cannot be read but has a mirror that can (fanqienovel.com -> tomatomtl.com): `fn(url, html)` gives the mirror's address of that chapter. The build gives the extension permission for the mirrored site too |

A parser that does more than that (fetches several list pages, runs scripts, builds the text from data) cannot be generated; give it a file
here with whatever functions it needs (see `uuread.tw.js`, `novel543.com.js`). Any site, with or without a list rule, still gets the page's
own "next chapter" link followed.

## Not here, on purpose

`fanqienovel.com` draws its text with a scrambled font (the HTML is gibberish), so it is read through its mirror `tomatomtl.com` (which needs a signed-in browser). `tadu.com`, `qimao.com`, `book.qq.com` build their pages
with JavaScript and need a login: a plain fetch cannot read a chapter from them.

## Updating from WebToEpub

`reference/WebToEpub` is a git submodule pinned to one WebToEpub commit (`git submodule update --init` fetches it). Move it to a newer one
(`git -C reference/WebToEpub pull origin master`, or check out a commit) and run `node tools/gen-sources.js`. `git diff sources/_generated.js`
shows what the sites changed; commit it with the submodule's new commit. The test fails if `_generated.js` is not what the generator makes
from the parsers checked out.
