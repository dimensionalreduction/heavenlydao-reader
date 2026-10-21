// Minimal element picker, in the spirit of uBlock Origin's element picker
// (hover-highlight / click-to-lock / Esc-to-cancel) but scoped to a single
// job: let the user point at the element that holds the chapter title,
// novel name, or chapter content, and save a CSS selector for it. It also picks
// the parts of a book's page (cover, title, author, synopsis, genres): those are
// saved as a small rule of the person's own for this site (see user-rules.js),
// on top of the built-in one, and the book is recorded again from the page as it is (the page is not reloaded: a reload can send a page back to the
// server in a way it does not accept, like a page that came from a form).
// Which field is being picked is passed in via storage.local.__pickerField
// by background.js before this file is injected. Own implementation, not
// uBlock's code.
(async function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  if (document.getElementById("gemini-picker-overlay")) {
    return; // already active
  }

  const FIELD_CONFIG = {
    title: { bucket: "titleSelectors", label: "chapter title" },
    content: { bucket: "contentSelectors", label: "content area" },
    novel: { bucket: "novelSelectors", label: "novel name" },
    // the book's page (saved in the person's rule for the site, under book.<field>)
    bookcover: { book: "cover", label: "cover" },
    booktitle: { book: "title", label: "book title" },
    bookauthor: { book: "author", label: "author" },
    bookdescription: { book: "description", label: "synopsis" },
    bookgenre: { book: "genre", label: "genres" },
    // the chapter list (saved in the person's rule for the site as toc.list: the links' selector; its other list settings are kept)
    toclist: { toc: true, label: "chapter list" }
  };
  const { __pickerField } = await ext.storage.local.get("__pickerField");
  const field = FIELD_CONFIG[__pickerField] ? __pickerField : "title";
  const { bucket, label, book: bookField, toc: tocField } = FIELD_CONFIG[field];
  await ext.storage.local.remove("__pickerField");

  function currentHostname() {
    return location.hostname.replace(/^www\./, "");
  }

  function computeSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(part);
      if (!parent || parent === document.body) break;
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  const highlight = document.createElement("div");
  highlight.id = "gemini-picker-overlay";
  highlight.style.cssText =
    "position:fixed;z-index:2147483646;pointer-events:none;" +
    "border:2px solid #4288c9;background:rgba(66,136,201,0.15);" +
    "border-radius:3px;transition:all .05s ease-out;display:none;";
  document.body.appendChild(highlight);

  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
    "background:#1c2026;color:#fff;font-family:'Segoe UI',ui-sans-serif,system-ui,sans-serif;" +
    "font-size:12.5px;padding:10px 14px;display:flex;align-items:center;gap:10px;" +
    "box-shadow:0 -4px 14px rgba(0,0,0,.3);";
  // The bar is built with textContent, never innerHTML: the selectors in it come from the page's own ids and classes.
  function barSpan(text, css) {
    const span = document.createElement("span");
    span.style.cssText = css;
    span.textContent = text;
    return span;
  }
  const previewEl = barSpan("", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aab;");
  bar.append(barSpan("Pick the " + label, "font-weight:600;"), previewEl, barSpan("Click to select · Esc to cancel", "color:#aab;"));
  document.body.appendChild(bar);
  const showSaved = (text) => bar.replaceChildren(barSpan(text, "font-weight:600;color:#7ed17e;"));
  let hovered = null;

  function onMouseMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hovered || el === highlight || bar.contains(el)) return;
    hovered = el;
    const rect = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = rect.left + "px";
    highlight.style.top = rect.top + "px";
    highlight.style.width = rect.width + "px";
    highlight.style.height = rect.height + "px";
    const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    previewEl.textContent = text || "(no text)";
  }

  // The person's rule for this site gets the part of the book's page they picked: { host, book: { cover: "..." } }, on top of the built-in rule (anything
  // else stays the built-in one's). The note that this book was recorded is taken back, so the recording is done again with the new selector.
  async function saveBookSelector(field, selector) {
    const host = currentHostname();
    const saved = (await ext.storage.local.get("userRules")).userRules || {};
    const entry = saved[host] || { spec: { host }, enabled: true };
    entry.spec = { ...entry.spec, host, book: { ...((entry.spec && entry.spec.book) || {}), [field]: selector } };
    entry.enabled = true;
    entry.updatedAt = Date.now();
    saved[host] = entry;
    await ext.storage.local.set({ userRules: saved });
    const stamps = (await ext.storage.local.get("bookCapturedAt")).bookCapturedAt || {};
    for (const k of Object.keys(stamps)) if (k.startsWith(host + "/")) delete stamps[k];
    await ext.storage.local.set({ bookCapturedAt: stamps });
  }

  // The chapter list: the links under what was clicked (a link itself: the links like it), saved as the rule's list. A list read from a box
  // before is replaced by this one; where the list's pages are and the pause between them stay.
  async function saveListSelector(el) {
    const host = currentHostname();
    const link = el.closest("a");
    const selector = link ? computeSelector(link.parentElement || link).replace(/:nth-of-type\(\d+\)$/, "") + " > a" : computeSelector(el) + " a";
    const saved = (await ext.storage.local.get("userRules")).userRules || {};
    const entry = saved[host] || { spec: { host }, enabled: true };
    const toc = { ...((entry.spec && entry.spec.toc) || {}), list: selector };
    delete toc.boxes;
    delete toc.pick;
    entry.spec = { ...entry.spec, host, toc };
    entry.enabled = true;
    entry.updatedAt = Date.now();
    saved[host] = entry;
    await ext.storage.local.set({ userRules: saved });
    return { selector, count: document.querySelectorAll(selector).length };
  }

  async function onClick(e) {
    if (bar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!hovered) return;

    if (tocField) {
      const { selector, count } = await saveListSelector(hovered);
      showSaved("Saved as the chapter list for " + currentHostname() + ": " + selector + " (" + count + " links)");
      setTimeout(cleanup, 1800);
      return;
    }
    const selector = computeSelector(hovered);
    if (bookField) {
      await saveBookSelector(bookField, selector);
      showSaved("Saved as the " + label + " for " + currentHostname() + ": " + selector + " · recording the book again…");
      ext.runtime.sendMessage({ type: "bookcapture:run" }).catch(() => {}); // the background runs the book-recording script in this tab once more
      setTimeout(cleanup, 1800);
      return;
    }
    const stored = await ext.storage.local.get(bucket);
    const selectors = stored[bucket] || {};
    selectors[currentHostname()] = selector;
    await ext.storage.local.set({ [bucket]: selectors });

    showSaved("Saved as " + label + " selector: " + selector);
    setTimeout(cleanup, 900);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") cleanup();
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    highlight.remove();
    bar.remove();
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
})();
