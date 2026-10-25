<a id="readme-top"></a>

<div align="center">

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![GPLv3 License][license-shield]][license-url]

</div>

<br />
<div align="center">
  <a href="https://github.com/dimensionalreduction/heavenlydao-reader">
    <img src="doc/logo.png" alt="Logo" width="80" height="80">
  </a>

  <h3 align="center">heavenlydao.com Reader</h3>

  <p align="center">
    Extension that fetches web novels from the sites that publish them, translates them with Gemini, and keeps them in your own library on all your devices.
    <br />
    <br />
    <a href="https://addons.mozilla.org/en-US/firefox/addon/heavenlydao-com-reader/">Firefox Add-ons</a>
    ·
    <a href="https://chromewebstore.google.com/detail/eikfhkpfjchhcnfbjigjlefgnhfbmjba">Chrome Web Store</a>
    ·
    <a href="https://github.com/dimensionalreduction/heavenlydao-reader/releases/latest">Latest release</a>
    ·
    <a href="https://github.com/dimensionalreduction/heavenlydao-reader/issues/new">Report an issue</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li>
      <a href="#installation">Installation</a>
      <ul>
        <li>
          <a href="#firefox">Firefox</a>
          <ul>
            <li><a href="#from-firefox-add-ons">From Firefox Add-ons</a></li>
            <li><a href="#from-source-firefox">From Source (Firefox)</a></li>
          </ul>
        </li>
        <li>
          <a href="#chrome">Chrome</a>
          <ul>
            <li><a href="#from-chrome-web-store">From Chrome Web Store</a></li>
            <li><a href="#from-source-chrome">From Source (Chrome)</a></li>
          </ul>
        </li>
        <li><a href="#from-source-developers">From Source (Developers)</a></li>
      </ul>
    </li>
    <li><a href="#set-up">Set up</a></li>
    <li><a href="#the-popup">The popup</a></li>
    <li><a href="#permissions">Permissions</a></li>
    <li><a href="#privacy">Privacy</a></li>
    <li><a href="#development">Development</a></li>
    <li><a href="#credits">Credits</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#support">Support</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->

## About The Project

A browser extension for Chrome and Firefox that works with your [heavenlydao.com](https://p2p-library.pages.dev/) library. It fetches
web-novel chapters from the sites that publish them, translates them with Gemini, and keeps them in your library on all your devices.

The extension is one more device of your library. Your chapters, glossaries and settings live on your own devices and pass between them
peer-to-peer. There is no account and no central server that holds them.

### Features

- **Fetch chapters** from over 500 novel sites, either the next few from the chapter you are on or a novel's whole list.
- **Translate with Gemini** using your own API key. Glossaries keep names and terms consistent from chapter to chapter, and chapters can be
  translated into about 90 languages.
- **Record the novels you open**: their title, author, synopsis, cover and full chapter list.
- **Teach it a new site.** *Detect with AI* finds a page's title, chapter list and next-chapter links. You can also pick the parts with the
  element picker or write the site's rule by hand.
- **Watch for new chapters** on a schedule and fetch them as they come out. You get notifications even with the library site closed.
- **Sync between your own devices** over WebRTC, and keep the libraries you follow available for other readers.

## Installation

### Firefox

#### From Firefox Add-ons

Open Firefox and visit [heavenlydao.com Reader on Firefox Add-ons][firefox-add-ons], then press **Add to Firefox**.

#### From Source (Firefox)

1. Download `heavenlydao-reader-<version>-firefox.zip` from the [latest release](https://github.com/dimensionalreduction/heavenlydao-reader/releases/latest).
2. Open Firefox and type `about:debugging#/runtime/this-firefox` into the URL bar.
3. Click **Load Temporary Add-on…**.
4. Pick the zip file you downloaded in step 1.

A temporary add-on is removed when Firefox closes. A permanent install has to be signed through
[addons.mozilla.org](https://addons.mozilla.org/developers/), so use the store version for everyday use.

### Chrome

#### From Chrome Web Store

Open Chrome (or any Chromium-based browser like Edge, Brave, Opera, etc.) and go to [heavenlydao.com Reader on Chrome Web Store][chrome-web-store], then press **Add to Chrome**.

#### From Source (Chrome)

1. Download `heavenlydao-reader-<version>-chrome.zip` from the [latest release](https://github.com/dimensionalreduction/heavenlydao-reader/releases/latest).
2. Unpack the zip file.
3. Open Chrome and type `chrome://extensions` into the address bar.
4. Make sure **Developer mode** at the top of the page is turned on.
5. Press the **Load unpacked** button and browse to the unpacked directory from step 2.

### From Source (Developers)

1. Clone this repo.

   ```sh
   git clone https://github.com/dimensionalreduction/heavenlydao-reader.git
   cd heavenlydao-reader
   ```

2. Build the extension.

   ```sh
   npm ci
   npm run build        # creates dist/chrome and dist/firefox
   ```

3. Load `dist/chrome` (Chrome) or `dist/firefox/manifest.json` (Firefox) as described above.

**To upload to addons.mozilla.org** (or the Chrome Web Store): `npm run package` builds and writes `dist/package/heavenlydao-reader-<version>-firefox.zip`
(the add-on), `-source.zip` (the source the add-ons site asks for, with a BUILD.txt) and `-chrome.zip`, from the files on disk: nothing has to
be committed first. The version is in `src/firefox/manifest.json`, `src/chrome/manifest.json` and `package.json` (change all three). The
Extension workflow makes the same zips as the `heavenlydao-reader-zips` artifact.

Every push also builds both extensions in GitHub Actions. Each run has them as the `heavenlydao-reader-chrome` and
`heavenlydao-reader-firefox` artifacts.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Set up

The extension does nothing until it has joined your library.

1. Open the [library site](https://p2p-library.pages.dev/). Your library is created on your first visit.
2. On the site, go to **Settings › Library › Passphrase** and press **Copy**.
3. Click the extension's toolbar icon, paste the passphrase and press **Join**.
4. The site shows "… asks to join". Press **Allow**.
5. For *Detect with AI*, add a key from [Google AI Studio](https://aistudio.google.com/apikey) on the site, in **Settings › Translation › Paid by › Gemini**. The site hands it to the extension in the same browser.
   Without a key, everything except that still works.

## The popup

| Tab | What it is for |
|---|---|
| **Novel** | What the extension found on this page (title, chapter list, cover, author, synopsis), with *Detect with AI*, the element picker and the site's rule. |
| **Library** | Your library's devices, letting a new one in, and how much it holds. |

The extension's options page (**My site rules**) lists the rules you wrote for sites it does not know.

## Permissions

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Chapters, glossaries and your library are kept in the browser. |
| `tabs`, `activeTab`, `scripting` | To read the page in front of you, translate it in place, and run the element picker and *Detect with AI* on it. |
| `cookies` | Sites behind a bot check (Cloudflare) refuse the extension until the browser's pass for that site is copied over. |
| `offscreen` (Chrome) | WebRTC sync cannot run in a Manifest V3 service worker, so it runs in an offscreen page. |
| `alarms` | A once-a-minute tick for scheduled checks of new chapters, and to keep the sync running. |
| `notifications` | Join requests and new chapters while no page of the site is open. |
| `background` (Chrome) | Lets the browser keep the extension running with every window closed, if you turn that on in the browser. |
| `generativelanguage.googleapis.com` | Gemini, with your key. |
| `translate.googleapis.com` | Google Translate, for titles and book details. |
| `heavenlydao.com` (the library site) | The script that lets the library site talk to the extension. |
| The built-in novel sites (optional) | To read their chapters, chapter lists and book pages. Nothing is asked at install: each site is asked for the first time you use it (the popup's **Allow** button, or **Fetch** on its page). The scripts that record a book on a site's pages are added once the site is allowed. |
| Any other `https://` site (optional) | Asked for one site at a time, when you save a rule of your own for it. |

## Privacy

- **What reaches Gemini:** the chapter text you translate, the glossary terms found in it, and their notes if Gemini notes are on.
  *Detect with AI* sends short snippets of the page's elements, not the whole page. Requests are made with your own key, which never
  leaves your browser except to call Gemini.
- **What reaches Google Translate:** titles and book details, when your library's title translation uses it (the default).
- **What reaches novel sites:** requests for the pages you ask for or that your watches check, made with your browser's own cookies for
  that site.
- **What reaches the trackers** (`tracker.heavenlydao.com`, `tracker.webtorrent.dev`): an id derived from your passphrase, so your devices
  can find each other. Chapters go directly between devices over WebRTC. Only devices that have proved they belong to your library get them,
  plus the readers of anything you choose to share.
- **The public pool** (`pool.heavenlydao.com`): the extension downloads it once a day, with no cookies and no referrer. It sends terms to it only if you
  turn on *Add my terms to the public pool* in the library's settings, after it has shown you exactly what would be added.
- There is no analytics or telemetry, and the extension makes no other requests. The full policy is in [PRIVACY.md](PRIVACY.md).

## Development

```sh
npm run build:dev    # also lets a copy of the site on localhost:3000 talk to the extension and keeps every novel site in the manifest (for local work; never ship it)
npm test             # every test in test/, one after the other
node test/<name>.test.js
```

```
  src/shared/         code used by both browsers: the popup, the library (library-host.js), sync (p2p-core.js, p2p-host.js),
                      Gemini (gemini.js), the site engine (raw-sources.js) and the site rules (sources/)
  src/chrome/         Manifest V3: manifest, service worker, offscreen page
  src/firefox/        Manifest V2: manifest, background page
  tools/              gen-sources.js (makes site rules from WebToEpub's parsers), test.js
  test/               unit and integration tests (plain Node, no framework)
  vendor/             chapters.js, shared with the library site (how chapters are put together into novels)
  reference/          WebToEpub, a git submodule
  build.js            joins src/shared and src/<browser> into dist/<browser> and adds every site's permission
```

- **Adding a site:** add a file to [`src/shared/sources/`](src/shared/sources/README.md). The build adds its permission and capture script.
- **Regenerating the rules from WebToEpub:** `git submodule update --init` fetches `reference/WebToEpub`, then run `node tools/gen-sources.js`.
  Building and testing do not need the submodule.

## Credits

- Most built-in site rules are generated from the parsers of [WebToEpub](https://github.com/dteviot/WebToEpub) (GPL-3.0) by
  `tools/gen-sources.js`.
- Sync finds peers through [WebTorrent](https://github.com/webtorrent/webtorrent) (MIT) trackers.
- The element picker's interaction follows [uBlock Origin](https://github.com/gorhill/uBlock)'s, without its code.

## License

Copyright (C) 2026 dimensionalreduction (heavenlydao.com)

GPL-3.0, see [LICENSE](LICENSE). The site rules are generated from [WebToEpub](https://github.com/dteviot/WebToEpub)'s parsers, which are GPL-3.0
as well; [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists what else is included.

## Support

support@heavenlydao.com

<!-- MARKDOWN LINKS & IMAGES -->

[contributors-shield]: https://img.shields.io/github/contributors/dimensionalreduction/heavenlydao-reader.svg?style=for-the-badge
[contributors-url]: https://github.com/dimensionalreduction/heavenlydao-reader/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/dimensionalreduction/heavenlydao-reader.svg?style=for-the-badge
[forks-url]: https://github.com/dimensionalreduction/heavenlydao-reader/network/members
[stars-shield]: https://img.shields.io/github/stars/dimensionalreduction/heavenlydao-reader.svg?style=for-the-badge
[stars-url]: https://github.com/dimensionalreduction/heavenlydao-reader/stargazers
[issues-shield]: https://img.shields.io/github/issues/dimensionalreduction/heavenlydao-reader.svg?style=for-the-badge
[issues-url]: https://github.com/dimensionalreduction/heavenlydao-reader/issues
[license-shield]: https://img.shields.io/badge/LICENSE-GPLv3-%23555555?style=for-the-badge&label=LICENSE&color=285959
[license-url]: LICENSE

<!-- Store Links -->

[firefox-add-ons]: https://addons.mozilla.org/en-US/firefox/addon/heavenlydao-com-reader/
[chrome-web-store]: https://chromewebstore.google.com/detail/eikfhkpfjchhcnfbjigjlefgnhfbmjba
