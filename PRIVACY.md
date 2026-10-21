# Privacy policy

heavenlydao.com Reader is a browser extension. This page says what it does with your data. Questions: support@heavenlydao.com

Last updated: 2026-10-21

## Summary

- There is no account, no analytics and no telemetry. The developer runs no server that stores your chapters, glossaries, settings or API key.
- Everything the extension keeps (chapters, glossaries, your library, settings, your Gemini API key) stays in your browser's local storage and
  on your own other devices.
- Text leaves your browser only to the services listed below, and only for the feature that needs it.

## What is kept on your device

Chapters you fetch or translate, novel records (title, author, synopsis, cover, chapter list), glossaries and terms, site rules you wrote,
your library's settings and device list, and your Gemini API key. This is stored in the browser (`storage`, `unlimitedStorage`). Removing
the extension deletes it.

## What is sent, and to whom

| To | What | When |
|---|---|---|
| Google Gemini (`generativelanguage.googleapis.com`) | The chapter text you translate, the glossary terms found in it, and their notes if Gemini notes are on. *Detect with AI* sends short snippets of a page's elements, not the whole page. | When you translate or use *Detect with AI*. The requests use your own API key, which is sent only to Google. Google's terms and privacy policy apply to what it receives. |
| Google Translate (`translate.googleapis.com`) | Titles and book details. | When title translation uses Google Translate (the default). |
| Novel sites (the built-in list, and any site you add a rule for) | Requests for the pages you ask for or that your watches check, made with your browser's own cookies for that site. | When you fetch chapters or a watch runs. |
| Trackers (`tracker.heavenlydao.com`, `tracker.webtorrent.dev`) | An identifier derived from your library's secret, so your devices can find each other. No chapter text. | While sync is on. |
| Your other devices, and readers of anything you choose to share | Chapters, glossaries and library records, directly over WebRTC. Only devices that have proved they belong to your library receive your library; readers receive only what you share. | While sync is on. |
| The public pool (`pool.heavenlydao.com`) | **Downloads:** once a day the extension downloads the public pool of terms, with no cookies and no referrer, and nothing about you. **Uploads:** only if you turn on *Settings > Translation > Add my terms to the public pool*, which first shows you exactly what would be added. Only terms (a source term and its rendering) are sent, with a proof of work in place of a login. No names of novels, characters, sentences, addresses or identifiers are kept. | Uploads are off until you agree and stop when you turn them off. Terms already added become public domain (CC0) and cannot be taken back. |

The extension makes no other requests.

## Why each permission is requested

See the Permissions table in the [README](README.md#permissions).

## What the developer receives

Nothing from the extension itself. The servers the extension contacts (`tracker.heavenlydao.com` and `pool.heavenlydao.com`) see the request
they receive, such as your IP address, as any web server does, and keep no record of it beyond what is described above for the pool.

## Children

The extension is not directed at children.

## Changes

If this policy changes, the new text is published here with a new date.

## Contact

support@heavenlydao.com
