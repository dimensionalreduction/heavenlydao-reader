// tomatomtl.com: a reading site for fanqienovel.com novels (fanqienovel itself draws its text with a scrambled font, so it cannot be read; this
// site's pages carry the text, encrypted, and the page decrypts it for the signed-in person). Not in WebToEpub.
//   chapter   https://tomatomtl.com/book/<book id>/<chapter id>   (the chapter id is fanqienovel's own; a book id of 0 also opens it, but then
//             the page has no way on to the neighbouring chapters, so addresses here always carry the real book id)
//   text      the page's script holds { iv, enc } (AES-CBC, base64) and an `unlock_code` the site gives the signed-in session; the key is the
//             first 16 bytes of that code, as the page's own chapter_decrypt does. Without being signed in the page has no text at all.
//   list      https://tomatomtl.com/catalog/<book id>   JSON: [{ title, id }] in reading order (the page shows it through a script)
//   mirror    the site's Raw link for a fanqienovel novel lands on https://fanqienovel.com/reader/<chapter id>; that page says which book it is in
(function (R) {
  const SITE = "https://tomatomtl.com";
  const bookOf = (address) => (/^https:\/\/(?:www\.)?tomatomtl\.com\/(?:book|catalog)\/(\d+)/.exec(address) || [])[1] || "";
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function chapterText(html) {
    const code = /unlock_code\s*=\s*"([^"]+)"/.exec(html);
    const enc = /encryptedData\s*=\s*(\{[^}]*\})/.exec(html);
    if (!code || !enc) return null; // not signed in, or not a chapter page
    const data = JSON.parse(enc[1]);
    const key = await crypto.subtle.importKey("raw", bytes(code[1]).slice(0, 16), "AES-CBC", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: bytes(data.iv) }, key, bytes(data.enc)); // (PKCS7 padding is removed by it)
    return new TextDecoder().decode(plain).replace(/\r/g, "").split("\n").map((l) => l.replace(/　/g, " ").trim()).filter(Boolean).join("\n");
  }

  R.register("tomatomtl.com", {
    selector: "main", // not used: fromHtml reads the text
    fromHtml: async (html) => {
      const text = await chapterText(html);
      return text ? { text, next: null } : null;
    },
    toc: {
      url: (address) => (bookOf(address) && bookOf(address) !== "0" ? SITE + "/catalog/" + bookOf(address) : null),
      parse: (text, listUrl) => {
        const book = bookOf(listUrl);
        return JSON.parse(text)
          .filter((c) => c && /^\d+$/.test(String(c.id)))
          .map((c) => ({ title: String(c.title || "").trim(), url: SITE + "/book/" + book + "/" + c.id }));
      }
    },
    from: "(not in WebToEpub)"
  });

  R.registerMirror("fanqienovel.com", (url, html) => {
    const chapter = /^https:\/\/(?:www\.)?fanqienovel\.com\/reader\/(\d+)/.exec(url);
    const book = /bookId\\*"\s*:\s*\\*"(\d{6,})/.exec(html); // inside a JSON string, so the quotes may be escaped
    return chapter && book ? SITE + "/book/" + book[1] + "/" + chapter[1] : null;
  });
})(RawSources);
