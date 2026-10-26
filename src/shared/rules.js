// The page where the person adds, edits and tries their own site rules (see user-rules.js for what a rule is). It runs inside the extension, so it
// is the one place a rule can be saved: a website cannot reach it.
(function () {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const UR = UserRules;

  // The form: each field, where its value goes in a rule, and what to tell the person about it.
  const SECTIONS = [
    ["The site", [
      { id: "host", label: "Site", hint: "Just the name, like example.com", mono: true },
      { id: "name", label: "Label", hint: "Anything that helps you tell rules apart (optional)" }
    ]],
    ["Chapter text", [
      { id: "selector", label: "The chapter's text", hint: "The element that holds it, like div.content or #chapter-body. For a built-in site, leave it empty to keep the built-in one", mono: true, wide: true },
      { id: "junk", label: "Remove from the text", hint: "Elements inside it that are not story (ads, notices), like .ad, #share", mono: true, wide: true },
      { id: "charset", label: "Text encoding", hint: "Leave on automatic unless the text comes out as garbage", select: [["", "Automatic"], ...UR.CHARSETS.map((c) => [c, c])] }
    ]],
    ["Moving between chapters (optional)", [
      { id: "nav.next", label: "The link to the next chapter", hint: "On a chapter's page, like a#next or .nav-next a. Leave empty to let the extension look for it", mono: true },
      { id: "nav.prev", label: "The link to the previous chapter", hint: "Like a#prev or .nav-prev a", mono: true }
    ]],
    ["Chapter list (optional)", [
      { id: "toc.list", label: "The links to the chapters", hint: "On the list page, like ul.chapters a", mono: true },
      { id: "toc.boxes", label: "…or the box that holds them", hint: "Use this when a page has several lists; then say which one", mono: true },
      { id: "toc.pick", label: "Which box", hint: "first, last, or a number (0 is the first)", select: [["first", "the first"], ["last", "the last"], ["1", "the second"], ["2", "the third"]] },
      { id: "toc.reverse", label: "The list shows the newest chapter first", check: true },
      { id: "toc.titleDrop", label: "Leave out of each chapter's title", hint: "Parts of a link that are not the title, like the date: .small, time", mono: true },
      { id: "toc.pagesKind", label: "The list runs over several pages", select: [["", "No"], ["numbered", "Yes: a bar of page numbers (…?page=2 … ?page=76): every page up to the highest"], ["options", "Yes: a page selector names them (<option>)"], ["links", "Yes: links lead to the other pages"]] },
      { id: "toc.pagesSelector", label: "The page selector or links", hint: "Like #pages option, ul.pager a or ul.pagination a", mono: true },
      { id: "toc.pagesAttr", label: "Attribute holding each page's address", hint: "For a page selector: value or data-url", mono: true },
      { id: "toc.gap", label: "Pause between list pages (ms)", hint: "500 to 30000; leave blank for 1000", number: true },
      { id: "toc.listMatch", label: "The list's address: when an address looks like", hint: "A pattern with a group, like ^https://example\\.com/book/(\\d+)", mono: true, wide: true },
      { id: "toc.listTo", label: "…the list is at", hint: "Like https://example.com/list/$1/ ($1 is the group above)", mono: true, wide: true }
    ]],
    ["Chapter list from the site's data (optional)", [
      { id: "toc.json.items", label: "Where the chapters are in the data", hint: "Like items or data.chapters; empty when the data is the list", mono: true },
      { id: "toc.json.title", label: "Each chapter's title", hint: "Like title", mono: true },
      { id: "toc.json.link", label: "Each chapter's address", hint: "Like https://example.com/novel/$1/{number}", mono: true, wide: true },
      { id: "toc.json.page", label: "The part of the list's address that moves through it", hint: "Like offset or page", mono: true },
      { id: "toc.json.count", label: "How many chapters there are", hint: "Like total", mono: true },
      { id: "toc.json.pages", label: "…or how many parts", hint: "Like last_page", mono: true }
    ]],
    ["Chapter text from the site's data (optional)", [
      { id: "json.match", label: "When a chapter's address looks like", hint: "Like ^https://example\\.com/novel/([^/?#]+)/(\\d+)", mono: true, wide: true },
      { id: "json.to", label: "…its data is at", hint: "Like https://example.com/api/novel/$1/chapters/$2", mono: true, wide: true },
      { id: "json.text", label: "The text", hint: "Like body or data.content", mono: true },
      { id: "json.next", label: "The next chapter's address", hint: "Like https://example.com/novel/$1/{next_number}", mono: true, wide: true }
    ]],
    ["Book page (optional)", [
      { id: "book.title", label: "Title", hint: "On the book's own page", mono: true },
      { id: "book.author", label: "Author", mono: true },
      { id: "book.description", label: "Synopsis", mono: true },
      { id: "book.cover", label: "Cover", hint: "The element that holds the image", mono: true },
      { id: "book.genre", label: "Genres", hint: "Links or tags, one element each", mono: true }
    ]]
  ];
  const ERROR_FIELD = { "toc.pages": "toc.pagesSelector", "toc.listUrl": "toc.listMatch" };
  const inputs = {};
  const errs = {};

  function buildForm() {
    const root = $("formHost");
    for (const [title, fields] of SECTIONS) {
      root.append(el("h3", { textContent: title }));
      const grid = el("div", { className: "grid" });
      for (const f of fields) {
        let input;
        if (f.select) {
          input = el("select", { id: "f-" + f.id }, ...f.select.map(([v, t]) => el("option", { value: v, textContent: t })));
        } else if (f.check) input = el("input", { type: "checkbox", id: "f-" + f.id });
        else input = el("input", { type: f.number ? "number" : "text", id: "f-" + f.id, className: f.mono ? "mono" : "", autocomplete: "off", spellcheck: false });
        inputs[f.id] = input;
        const err = el("div", { className: "err" });
        errs[f.id] = err;
        const label = el("label", { htmlFor: "f-" + f.id, textContent: f.label });
        const box = el("div", { className: "field" + (f.check ? " check" : "") + (f.wide ? " wide" : "") });
        if (f.check) box.append(input, label);
        else box.append(label, input);
        if (f.hint) box.append(el("div", { className: "hint", textContent: f.hint }));
        box.append(err);
        grid.append(box);
        input.addEventListener("input", syncJson);
        input.addEventListener("change", syncJson);
      }
      root.append(grid);
    }
  }

  const val = (id) => {
    const i = inputs[id];
    return i.type === "checkbox" ? i.checked : String(i.value || "").trim();
  };
  const setVal = (id, v) => {
    const i = inputs[id];
    if (i.type === "checkbox") i.checked = !!v;
    else i.value = v == null ? "" : String(v);
  };

  // A spec checked against the built-in rule of its site, if it has one (then the chapter text selector may be left out: the built-in one is kept).
  const baseOf = (spec) => UR.baseFor(UR.cleanHost(spec && spec.host));
  const check = (spec) => UR.validate(spec, baseOf(spec));

  // the form -> a spec (not yet checked)
  function specFromForm() {
    const spec = { host: val("host"), name: val("name"), selector: val("selector"), junk: val("junk"), charset: val("charset") };
    const toc = {
      list: val("toc.list"), boxes: val("toc.boxes"), pick: val("toc.pick"), reverse: val("toc.reverse"), gap: val("toc.gap"), titleDrop: val("toc.titleDrop"),
      pages: { kind: val("toc.pagesKind"), selector: val("toc.pagesSelector"), attr: val("toc.pagesAttr") },
      listUrl: { match: val("toc.listMatch"), to: val("toc.listTo") },
      json: { items: val("toc.json.items"), title: val("toc.json.title"), link: val("toc.json.link"), page: val("toc.json.page"), count: val("toc.json.count"), pages: val("toc.json.pages") }
    };
    if (toc.list || toc.boxes || toc.pages.selector || toc.gap || toc.listUrl.match || toc.listUrl.to || toc.reverse || toc.json.title || toc.json.link || toc.json.items) spec.toc = toc;
    const json = { match: val("json.match"), to: val("json.to"), text: val("json.text"), next: val("json.next") };
    if (json.match || json.to || json.text) spec.json = json;
    const nav = { next: val("nav.next"), prev: val("nav.prev") };
    if (nav.next || nav.prev) spec.nav = nav;
    const book = { title: val("book.title"), author: val("book.author"), description: val("book.description"), cover: val("book.cover"), genre: val("book.genre") };
    if (Object.values(book).some(Boolean)) spec.book = book;
    return spec;
  }

  // a spec -> the form
  function fillForm(spec) {
    const s = spec || {};
    const t = s.toc || {};
    setVal("host", s.host);
    setVal("name", s.name);
    setVal("selector", s.selector);
    setVal("junk", s.junk);
    setVal("charset", s.charset);
    setVal("toc.list", t.list);
    setVal("toc.boxes", t.boxes);
    setVal("toc.pick", t.pick || "first");
    setVal("toc.reverse", t.reverse);
    setVal("toc.titleDrop", t.titleDrop);
    setVal("toc.gap", t.gap);
    setVal("toc.pagesKind", t.pages ? t.pages.kind : "");
    setVal("toc.pagesSelector", t.pages ? t.pages.selector : "");
    setVal("toc.pagesAttr", t.pages ? t.pages.attr : "");
    setVal("toc.listMatch", t.listUrl ? t.listUrl.match : "");
    setVal("toc.listTo", t.listUrl ? t.listUrl.to : "");
    for (const f of ["items", "title", "link", "page", "count", "pages"]) setVal("toc.json." + f, t.json ? t.json[f] : "");
    for (const f of ["match", "to", "text", "next"]) setVal("json." + f, s.json ? s.json[f] : "");
    for (const f of UR.BOOK_FIELDS) setVal("book." + f, s.book ? s.book[f] : "");
    setVal("nav.next", s.nav ? s.nav.next : "");
    setVal("nav.prev", s.nav ? s.nav.prev : "");
    showErrors([]);
    syncJson();
  }

  function showErrors(list) {
    for (const k of Object.keys(errs)) errs[k].textContent = "";
    for (const e of list) {
      const target = errs[ERROR_FIELD[e.field] || e.field];
      if (target) target.textContent = e.message;
    }
  }

  function syncJson() {
    const v = check(specFromForm());
    $("json").value = JSON.stringify(v.spec, null, 2);
  }

  // ---------- the saved rules ----------
  let stored = {};
  let editing = ""; // the host being edited ("" for a new rule)

  async function load() {
    stored = (await ext.storage.local.get(UR.KEY))[UR.KEY] || {};
    paintList();
  }
  const save = () => ext.storage.local.set({ [UR.KEY]: stored });

  function paintList() {
    const hosts = Object.keys(stored).sort();
    $("emptyNote").hidden = hosts.length > 0;
    $("rulesTable").hidden = hosts.length === 0;
    $("rulesBody").replaceChildren(...hosts.map((host) => {
      const e = stored[host];
      const spec = e.spec || {};
      const on = el("input", { type: "checkbox", checked: e.enabled !== false, title: "Use this rule" });
      on.onchange = async () => {
        stored[host] = { ...e, enabled: on.checked };
        await save();
      };
      const del = el("button", { className: "danger", textContent: "Delete" });
      del.onclick = () => {
        if (del.dataset.sure) return remove(host);
        del.dataset.sure = "1";
        del.textContent = "Sure?";
        setTimeout(() => { delete del.dataset.sure; del.textContent = "Delete"; }, 3000);
      };
      const edit = el("button", { textContent: "Edit" });
      edit.onclick = () => open(host);
      const also = [spec.toc ? "chapter list" : "", spec.book ? "book details" : "", spec.json || (spec.toc && spec.toc.json) ? "site's data" : ""].filter(Boolean);
      return el("tr", {},
        el("td", {}, el("strong", { textContent: host }), spec.name ? el("div", { className: "hint", textContent: spec.name, style: "color:var(--muted)" }) : null),
        el("td", { className: "sel", textContent: spec.selector || (spec.json ? "(the site's data)" : "(the built-in one)") }),
        el("td", {}, ...(also.length ? also.map((a) => el("span", { className: "chip", textContent: a, style: "margin-right:4px" })) : [el("span", { style: "color:var(--muted)", textContent: "–" })])),
        el("td", {}, on), el("td", {}, el("div", { className: "bar" }, edit, del)));
    }));
  }

  async function remove(host) {
    delete stored[host];
    await save();
    try {
      await ext.permissions.remove({ origins: ["https://*." + host + "/*"] }); // (a built-in site keeps its own permission; this only takes back the one that was asked for)
    } catch (e) {
      // nothing to take back
    }
    if (editing === host) closeEditor();
    paintList();
  }

  function open(host, prefill) {
    editing = host || "";
    $("editor").hidden = false;
    $("editorTitle").textContent = host ? "Edit " + host : "Add a site";
    fillForm(host ? stored[host].spec : prefill || {});
    $("tryOut").hidden = true;
    $("saveNote").textContent = "";
    $("saveNote").className = "";
    $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function closeEditor() {
    editing = "";
    $("editor").hidden = true;
  }

  const originsOf = (host) => ["https://*." + host + "/*"];

  // Saving: the rule is checked, the browser is asked for permission to read that site (this has to happen in answer to the click), then it is kept.
  $("saveBtn").onclick = async () => {
    const note = $("saveNote");
    const v = check(specFromForm());
    showErrors(v.errors);
    if (!v.ok) {
      note.className = "note bad";
      note.textContent = "Not saved: " + v.errors.length + (v.errors.length === 1 ? " thing needs" : " things need") + " fixing.";
      return;
    }
    let granted = false;
    try {
      granted = await ext.permissions.request({ origins: originsOf(v.spec.host) });
    } catch (e) {
      granted = false;
    }
    if (!granted) {
      note.className = "note bad";
      note.textContent = "Not saved: the browser did not give permission to read " + v.spec.host + ".";
      return;
    }
    if (editing && editing !== v.spec.host) delete stored[editing];
    stored[v.spec.host] = { spec: v.spec, enabled: true, updatedAt: Date.now() };
    await save();
    editing = v.spec.host;
    $("editorTitle").textContent = "Edit " + editing;
    note.className = "note ok";
    note.textContent = "Saved. The extension uses this rule now.";
    paintList();
  };

  $("addBtn").onclick = () => open("");
  $("cancelBtn").onclick = closeEditor;
  $("loadJson").onclick = () => {
    try {
      const parsed = JSON.parse($("json").value);
      fillForm(parsed);
      showErrors(check(parsed).errors);
    } catch (e) {
      $("saveNote").className = "note bad";
      $("saveNote").textContent = "That is not JSON.";
    }
  };
  $("copyJson").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("json").value);
      $("copyJson").textContent = "Copied";
    } catch (e) {
      $("json").select();
    }
  };

  // ---------- trying a rule on a real page ----------
  const out = $("tryOut");
  const say = (text) => {
    out.hidden = false;
    out.textContent = text;
  };
  const clip = (t, n) => (t.length > n ? t.slice(0, n) + "…" : t);

  // The address typed in, fetched the way the extension fetches (with the person's cookies), read with the rule being edited.
  async function fetchForTrial(rule, host, address) {
    if (!UR.sameSite(address, host)) throw new Error("That address is not on " + host + " (a rule only reads its own site, over https).");
    const res = await fetch(address, { credentials: "include" });
    if (!res.ok) throw new Error("The site answered HTTP " + res.status + ".");
    const html = RawSources.decode(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type"), rule);
    return { html, url: res.url || address, doc: new DOMParser().parseFromString(RawSources.stripScripts(html), "text/html") };
  }

  async function trial(kind) {
    const v = check(specFromForm());
    showErrors(v.errors);
    if (!v.ok) return say("Fix the rule first: " + v.errors.map((e) => e.message).join(" "));
    const address = $("tryUrl").value.trim();
    if (!address) return say("Paste the address of a page of " + v.spec.host + " above.");
    say("Reading…");
    try {
      const granted = await ext.permissions.request({ origins: originsOf(v.spec.host) }); // (in answer to the click)
      if (!granted) return say("The browser did not give permission to read " + v.spec.host + ".");
      // the rule as the engine runs it (this page's own copy of the registry: nothing else here reads it)
      RawSources.setUserRules({ [v.spec.host]: UR.toRule(v.spec, baseOf(v.spec)) });
      const rule = RawSources.ruleFor("https://" + v.spec.host + "/");
      if (kind === "chapter" && rule.textUrl && rule.textUrl(address)) {
        // the chapter's text from the site's data
        const page = await fetchForTrial(rule, v.spec.host, rule.textUrl(address));
        const read = await rule.fromHtml(page.html, page.url);
        if (!read) return say("Nothing found: the data at " + page.url + " has no text at " + v.spec.json.text + ".");
        say(read.text.split("\n").length + " paragraphs, " + read.text.length + " characters.\nThe chapter's data: " + page.url + "\nThe next chapter's address: " + (read.next || "not found") + "\n\n" + clip(read.text, 900));
      } else if (kind === "chapter") {
        const page = await fetchForTrial(rule, v.spec.host, address);
        const text = RawSources.textOf(page.doc, rule);
        if (!text) return say("Nothing found: the page has no element matching " + v.spec.selector + ".\nCheck the selector, or whether the site needs you to be logged in.");
        const lines = text.split("\n");
        const next = RawSources.nextChapter(page.doc, page.url);
        const prev = RawSources.prevChapter(page.doc, page.url);
        const toc = RawSources.tocLinkOf(page.doc, page.url);
        say(lines.length + " paragraphs, " + text.length + " characters.\nThe next chapter's link: " + (next || "not found") + "\nThe previous chapter's link: " + (prev || "not found") + "\nThe list's link: " + (toc || "not found") + "\n\n" + clip(text, 900));
      } else if (kind === "list") {
        if (!rule.toc) return say("This rule has no chapter list part yet.");
        const first = (rule.toc.url && rule.toc.url(address)) || address;
        const page = await fetchForTrial(rule, v.spec.host, first);
        const chapters = typeof rule.toc.list === "function" ? RawSources.tocChapters(page.doc, { rule, url: page.url }, page.html) : [];
        const more = RawSources.tocPageUrls(page.doc, { rule, url: page.url }, page.html);
        if (!chapters.length) return say("No chapters found on " + page.url + ".\nCheck the links' selector (or, if the list is on another page, the list's address).");
        const show = (c) => c.num + ". " + clip(c.title, 60) + "  " + c.url;
        const lines = [chapters.length + " chapters on the first page" + (more.length ? ", and " + more.length + " more page(s) to read" : "") + ".\nThe list page: " + page.url + "\n"];
        const head = chapters.slice(0, 3);
        const tail = chapters.slice(3).slice(-3); // (what is left after the first three: never the same chapter twice)
        lines.push(...head.map(show), chapters.length > 6 ? "…" : "", ...tail.map(show));
        say(lines.join("\n"));
      } else {
        const page = await fetchForTrial(rule, v.spec.host, address);
        const book = window.BookCapture && window.BookCapture.readBookByRule(page.doc, page.url, { book: rule.book, selector: rule.selector });
        if (!rule.book) return say("This rule has no book page part yet.");
        if (!book) return say("Not a book page, or too little found: a title and one of author, cover or synopsis are needed.\n(A page that also has the chapter text is taken for a chapter.)");
        say(["Title: " + book.rawTitle, "Author: " + (book.authorRaw || "–"), "Cover: " + (book.cover || "–"), "Genres: " + (book.category || "–"), "Synopsis: " + (clip(book.synopsis.join(" "), 300) || "–")].join("\n"));
      }
    } catch (e) {
      say("That did not work: " + ((e && e.message) || e));
    }
  }
  $("tryChapter").onclick = () => trial("chapter");
  $("tryList").onclick = () => trial("list");
  $("tryBook").onclick = () => trial("book");

  // ---------- start ----------
  buildForm();
  load().then(() => {
    // opened from the popup on a page: ?url=<the page's address> starts a rule for that site (or edits the one it has)
    const url = new URLSearchParams(location.search).get("url");
    if (!url) return;
    const host = UR.cleanHost(url);
    if (!host) return;
    if (stored[host]) open(host);
    else open("", { host });
    $("tryUrl").value = url;
  });
})();
