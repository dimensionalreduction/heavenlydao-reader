# Privacy policy

heavenlydao.com Reader is a browser extension. This page says what it does with your data. Questions: support@heavenlydao.com

Last updated: 2026-11-26

## Summary

- The extension has no account of its own, no analytics and no telemetry. The developer runs no server that stores your chapters, glossaries, settings or API keys.
- Everything the extension keeps (chapters, glossaries, your library, settings, your API keys) stays in your browser's local storage. The
  library site's tab in the same browser reads your library through the extension, on your computer.
- Text leaves your browser only to the services listed below, and only for the feature that needs it.

## What is kept on your device

Chapters you fetch or translate, novel records (title, author, synopsis, cover, chapter list), glossaries and terms, site rules you wrote,
your library's settings, and your Gemini API key (typed on the library site, which gives it to the extension in the same browser; a key typed in an older popup stays too). If a novel is translated with a translation profile, the library's page in this browser also
gives the extension the API keys you saved there for your profiles and, for a profile paid with tickets, a sign-in for the playground of its own. This is stored in the browser (`storage`, `unlimitedStorage`). Removing
the extension deletes it.

## What is sent, and to whom

| To | What | When |
|---|---|---|
| Google Gemini (`generativelanguage.googleapis.com`) | The chapter text you translate, the glossary terms found in it, and their notes if additional notes are on. *Detect with AI* sends short snippets of a page's elements, not the whole page. | When you translate or use *Detect with AI*. The requests use your own API key, which is sent only to Google. Google's terms and privacy policy apply to what it receives. |
| The provider of a model paid with your own key (OpenRouter, Google's Gemini, or an address you entered), as your library's *Settings > Model rules* or a translation profile names it | The text of the chapters the extension translates (the popup's *Translate*, *Translate ahead*, the chapters a watch fetches) and the glossary terms found in it; a comic's pictures and the text found in them (the popup's *Translate* on a comic); the lines read aloud with an AI voice (*Listen*); with no Gemini key, the snippets *Detect with AI* sends. | When you use these. The requests use your own key for that provider, which is sent only to it. |
| Fish Audio (`api.fish.audio`) | The text of a chapter you listen to with a Fish Audio key, and the voice and model you picked; and your account balance. | Only when you read aloud with a Fish Audio key you added on the library site, and after you allow the extension to talk to `api.fish.audio` (popup: Allow). The key is sent only to Fish Audio, and the extension does not keep it. Fish Audio's terms and privacy policy apply. |
| The playground (`playground.heavenlydao.com`) | The same, for a model paid with tickets, with the sign-in the library site gave the extension. The playground passes it to the model (through OpenRouter) and keeps no text or pictures. | When a model your rules or profile pay with tickets is used. |
| Google Translate (`translate.googleapis.com`) | Titles and book details; and the text of a chapter, its glossary names swapped for stand-ins first. | Titles: when title translation uses Google Translate (the default). A chapter: when nothing before Google Translate in your *Translation* rule can be paid for (no key and no tickets). |
| Novel sites (the built-in list, and any site you add a rule for) | Requests for the pages (and a comic's pictures) you ask for or that your watches check, made with your browser's own cookies for that site. | When you fetch chapters or a watch runs. |
| The public pool (`pool.heavenlydao.com`) | **Switched off for now: nothing is downloaded or sent.** When it opens: **Downloads:** once a day the extension downloads the public pool of terms, with no cookies and no referrer, and nothing about you. **Uploads:** only if you turn on *Settings > Translation > Add my terms to the public pool*, which first shows you exactly what would be added. Only terms (a source term and its rendering) are sent, with a proof of work in place of a login. No names of novels, characters, sentences, addresses or identifiers are kept. | Uploads are off until you agree and stop when you turn them off. Terms already added become public domain (CC0) and cannot be taken back. |

The extension makes no other requests.

## Why each permission is requested

See the Permissions table in the [README](README.md#permissions).

## What the developer receives

Nothing from the extension itself. The servers the extension contacts (`pool.heavenlydao.com` and, for a profile paid with tickets,
`playground.heavenlydao.com`) see the request they receive, such as your IP address, as any web server does, and keep no record of it beyond what is described
above for the pool and, for the playground, the tickets used (its own privacy page: heavenlydao.com/privacy.html).

## Children

The extension is not directed at children.

## Changes

If this policy changes, the new text is published here with a new date.

## Contact

support@heavenlydao.com
