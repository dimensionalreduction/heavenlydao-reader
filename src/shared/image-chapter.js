// A chapter that is pictures (a comic, a manhwa): its page addresses, the bundle it is kept as, and the store that keeps the bundles.
// Design: docs/IMAGE-CHAPTERS.md. Used by the extension (fetching a chapter's pictures: p2p-host.js) and by the library site (reading one: reader.js).
//
//   urlsOf(doc, selector, baseUrl)   the pictures of a chapter's page, in order: absolute https addresses (lazy-load attributes first)
//   imgUrl(img, baseUrl)            one <img>'s address (lazy-load attribute first, https only), or ""
//   mark(n) / illustrationNo(line)   a text chapter's picture as a line of its text ("⟦image:3⟧"), and the number a line is one of (0: not one)
//   splitIllustrations(text) / joinIllustrations(text, split) / stripIllustrations(text)   the text without those lines and where they were, put back after the words
//                                    were translated, and the words alone
//   urlsFromProps(doc, baseUrl)     the same from the page's own data (an Astro page keeps its list of pictures in an island's props attribute)
//   fetchPages(urls, fetchOne, opts) the pictures fetched a few at a time, a pause between starts, each retried; a failure keeps the ones fetched
//   sizeOf(bytes, type)              { w, h } read from the picture's header (no decoding), or null
//   kindOf(bytes)                    "image/webp" | "image/png" | "image/jpeg" | "image/gif" | "image/avif", from the bytes themselves, else ""
//   packBundle(manifest, pages)      the chapter as one file: a zip with no compression (the pictures are compressed already), manifest.json
//                                    first, then p001.webp ... pages: [{ bytes, type }]
//   indexBundle(bytes)               the files in a bundle: { manifest, pages: [{ name, start, length, type }] } (where each page is in the bytes)
//   pageBytes(bytes, entry)          one page's bytes
//   squeeze(bytes, type)             a JPEG or PNG as WebP when that is smaller (a browser page only; anything else comes back as it was)
//   toB64 / fromB64                  bytes <-> text, for the pages sent between the extension and the library site's tab
//   planTrim(rows, max, keep)        which bundles to drop to get under `max` bytes: the least recently read first, never one in `keep`
//   openStore(name)                  the bundles on this device (IndexedDB): put, has, info, touch, pin, page, bundle, remove, keys, usage, trim
//                                    (a pinned chapter, "Keep on this device", is never dropped by trim, whatever the limit)
(function (root) {
  const VERSION = 1;
  const MAX_PAGES = 400; // pictures in one chapter
  const MAX_PAGE_BYTES = 40 * 1024 * 1024; // one picture
  const MAX_BUNDLE_BYTES = 300 * 1024 * 1024; // a whole chapter
  const LAZY = ["data-src", "data-lazy-src", "data-original", "data-url", "src"]; // where a lazy-loading page keeps the real address

  // ---------- the pictures on a chapter's page ----------
  function largestOf(srcset) {
    let best = "";
    let width = -1;
    for (const part of String(srcset || "").split(",")) {
      const [url, size] = part.trim().split(/\s+/);
      const w = parseFloat(size) || 0;
      if (url && w > width) { best = url; width = w; }
    }
    return best;
  }

  // One <img>'s address: its lazy-load attribute before src, the largest of a srcset, made absolute; "" for a data: picture, a plain http one, or none.
  function imgUrl(img, baseUrl) {
    let raw = "";
    for (const attr of LAZY) {
      const v = String(img.getAttribute(attr) || "").trim();
      if (v && !/^data:/i.test(v)) { raw = v; break; }
    }
    if (!raw) raw = largestOf(img.getAttribute("data-srcset") || img.getAttribute("srcset"));
    if (!raw) return "";
    try {
      const url = new URL(raw, baseUrl);
      return url.protocol === "https:" ? url.href : "";
    } catch (e) {
      return "";
    }
  }

  function urlsOf(doc, selector, baseUrl) {
    const out = [];
    const seen = new Set();
    let found = [];
    try {
      found = selector ? [...doc.querySelectorAll(selector)] : [];
    } catch (e) {
      return []; // a selector the browser cannot use finds nothing rather than failing the chapter
    }
    const imgs = [];
    for (const el of found) {
      if (String(el.tagName || "").toLowerCase() === "img") imgs.push(el);
      else imgs.push(...el.querySelectorAll("img"));
    }
    for (const img of imgs) {
      const href = imgUrl(img, baseUrl);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push(href);
      if (out.length >= MAX_PAGES) break;
    }
    return out;
  }

  // An Astro page (asurascans.com) keeps what its reader shows in an island's props attribute, every value wrapped as [0, value] (a plain value) or [1, [...]] (a list):
  // { pages: [1, [[0, { url: [0, "https://…"], width: [0, 800], height: [0, 15000] }], …]] }. The list of pictures is there even when the page draws no <img> until a script runs.
  function unwrap(v) {
    if (Array.isArray(v)) {
      if (!v.length) return null;
      if (v.length === 2 && Number.isInteger(v[0])) return unwrap(v[1]);
      if (v.length === 1 && Number.isInteger(v[0])) return null;
      return v.map(unwrap);
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
    return v;
  }
  function pagesIn(v, depth) {
    if (!v || typeof v !== "object" || depth > 8) return null;
    if (Array.isArray(v)) {
      for (const x of v) { const found = pagesIn(x, depth + 1); if (found) return found; }
      return null;
    }
    if (Array.isArray(v.pages) && v.pages.length && v.pages.every((p) => p && typeof p.url === "string")) return v.pages;
    for (const x of Object.values(v)) { const found = pagesIn(x, depth + 1); if (found) return found; }
    return null;
  }
  function urlsFromProps(doc, baseUrl) {
    let islands = [];
    try {
      islands = [...doc.querySelectorAll("[props]")];
    } catch (e) {
      return [];
    }
    for (const island of islands) {
      let pages = null;
      try {
        pages = pagesIn(unwrap(JSON.parse(island.getAttribute("props"))), 0);
      } catch (e) {
        continue; // not JSON
      }
      if (!pages) continue;
      const out = [];
      const seen = new Set();
      for (const p of pages) {
        let url;
        try { url = new URL(p.url, baseUrl); } catch (e) { continue; }
        if (url.protocol === "https:" && !seen.has(url.href)) { seen.add(url.href); out.push(url.href); }
        if (out.length >= MAX_PAGES) break;
      }
      if (out.length) return out;
    }
    return [];
  }

  // The pictures fetched with fetchOne(url, i) -> { bytes, type, ... }, in order. At most opts.parallel at once (3), two starts at least opts.gap ms apart (the sites ask
  // for a gentle pace), each retried opts.retries times (3) after the waits in opts.backoff ([2000, 4000, 8000] ms) unless the error says fatal. opts.have: pictures
  // already fetched (by place; a hole is fetched), opts.onProgress(done, total). When one still fails the others in flight finish and the error comes with
  // `partial` (the pictures fetched, holes for the rest), so asking again carries on from there.
  async function fetchPages(urls, fetchOne, opts = {}) {
    const parallel = opts.parallel || 3;
    const gap = opts.gap == null ? 400 : opts.gap;
    const retries = opts.retries == null ? 3 : opts.retries;
    const backoff = opts.backoff || [2000, 4000, 8000];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pages = urls.map((_, i) => (opts.have && opts.have[i]) || undefined);
    let done = pages.filter(Boolean).length;
    let next = 0;
    let startAt = 0;
    let failure = null;
    if (opts.onProgress) opts.onProgress(done, urls.length);
    async function one(i) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fetchOne(urls[i], i);
        } catch (e) {
          if ((e && e.fatal) || attempt >= retries || failure) throw e;
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
        }
      }
    }
    async function worker() {
      while (!failure) {
        while (next < urls.length && pages[next]) next++;
        if (next >= urls.length) return;
        const i = next++;
        const wait = startAt - Date.now();
        startAt = Math.max(Date.now(), startAt) + gap;
        if (wait > 0) await sleep(wait);
        if (failure) return;
        try {
          pages[i] = await one(i);
          done++;
          if (opts.onProgress) opts.onProgress(done, urls.length);
        } catch (e) {
          failure = failure || e;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, urls.length) }, worker));
    if (failure) throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { partial: pages });
    return pages;
  }

  function kindOf(b) {
    if (!b || b.length < 12) return "";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66) return "image/avif";
    return "";
  }
  // The size of a picture from its header, without decoding it: { w, h } or null (AVIF, or something cut short). PNG and GIF have it at fixed places; JPEG in the first
  // frame header; WebP in one of three chunks (VP8 lossy, VP8L lossless, VP8X extended).
  function sizeOf(b, type) {
    if (!b || b.length < 30) return null;
    const u16 = (i) => b[i] | (b[i + 1] << 8);
    const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    try {
      if (type === "image/png") return { w: be32(16), h: be32(20) };
      if (type === "image/gif") return { w: u16(6), h: u16(8) };
      if (type === "image/jpeg") {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
          i += 2 + ((b[i + 2] << 8) | b[i + 3]);
        }
        return null;
      }
      if (type === "image/webp") {
        const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (tag === "VP8 ") return { w: u16(26) & 0x3fff, h: u16(28) & 0x3fff };
        if (tag === "VP8L") {
          const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
          return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (tag === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  const EXT = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif" };
  const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

  // ---------- the bundle: a zip with nothing compressed ----------
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true); // names are UTF-8
      head.setUint16(8, 0, true); // stored
      head.setUint16(10, 0, true);
      head.setUint16(12, 0x21, true); // 1980-01-01
      head.setUint32(14, crc, true);
      head.setUint32(18, f.data.length, true);
      head.setUint32(22, f.data.length, true);
      head.setUint16(26, name.length, true);
      head.setUint16(28, 0, true);
      parts.push(new Uint8Array(head.buffer), name, f.data);
      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(14, 0x21, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, f.data.length, true);
      dir.setUint32(24, f.data.length, true);
      dir.setUint16(28, name.length, true);
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    let dirSize = 0;
    for (const c of central) dirSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, dirSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  // The files in a zip made by zip() (stored, no zip64): [{ name, start, length }], where each file's bytes are in the zip
  function unzipIndex(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error("not a chapter bundle");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("not a chapter bundle");
      const method = view.getUint16(at + 10, true);
      const length = view.getUint32(at + 24, true);
      const nameLen = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const commentLen = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
      if (method !== 0) throw new Error("not a chapter bundle");
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("not a chapter bundle");
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + length > bytes.length) throw new Error("not a chapter bundle");
      out.push({ name, start, length });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  // manifest: { key, title }; pages: [{ bytes, type, w?, h? }]
  function packBundle(manifest, pages) {
    if (!pages.length || pages.length > MAX_PAGES) throw new Error("a chapter has 1 to " + MAX_PAGES + " pictures");
    const files = pages.map((p, i) => ({ name: "p" + String(i + 1).padStart(3, "0") + "." + (EXT[p.type] || "bin"), data: p.bytes }));
    const info = {
      v: VERSION,
      key: String(manifest.key || ""),
      title: String(manifest.title || ""),
      pages: pages.map((p, i) => ({ file: files[i].name, type: p.type, bytes: p.bytes.length, ...(p.w ? { w: p.w, h: p.h } : {}) }))
    };
    const out = zip([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(info)) }, ...files]);
    if (out.length > MAX_BUNDLE_BYTES) throw new Error("this chapter's pictures are over " + Math.round(MAX_BUNDLE_BYTES / 1048576) + " MB");
    return out;
  }

  function indexBundle(bytes) {
    const files = unzipIndex(bytes);
    const first = files.find((f) => f.name === "manifest.json");
    if (!first) throw new Error("not a chapter bundle");
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(first.start, first.start + first.length)));
    if (!manifest || manifest.v !== VERSION || !Array.isArray(manifest.pages)) throw new Error("not a chapter bundle");
    const pages = manifest.pages.map((p) => {
      const f = files.find((x) => x.name === p.file);
      if (!f) throw new Error("not a chapter bundle");
      return { name: f.name, start: f.start, length: f.length, type: TYPE[String(p.file).split(".").pop()] || "application/octet-stream", ...(p.w ? { w: p.w, h: p.h } : {}) };
    });
    return { manifest, pages };
  }
  const pageBytes = (bytes, entry) => bytes.subarray(entry.start, entry.start + entry.length);

  // ---------- smaller pictures ----------
  // A JPEG or PNG over 100 KB becomes WebP when that is at least 15% smaller (and not wider than 1200 px, nor taller than WebP allows). A WebP, a GIF
  // (it may move) and anything this page cannot decode stay as they were. { bytes, type, w, h }
  async function squeeze(bytes, type) {
    const same = { bytes, type };
    if ((type !== "image/jpeg" && type !== "image/png") || bytes.length < 100 * 1024) return same;
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return same;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], { type }));
      const scale = Math.min(1, 1200 / bitmap.width);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      if (!w || !h || h > 16383) return { ...same, w: bitmap.width, h: bitmap.height };
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
      if (blob.type !== "image/webp" || blob.size > bytes.length * 0.85) return { ...same, w: bitmap.width, h: bitmap.height };
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: "image/webp", w, h };
    } catch (e) {
      return same;
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
    }
  }

  // ---------- bytes <-> text ----------
  function toB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- pictures inside a text chapter ----------
  // A text chapter keeps its illustrations as lines of its text, "⟦image:3⟧" (the third picture of the chapter), and the pictures themselves as a bundle under the
  // chapter's "#original" key, like a chapter of pictures. The reader puts the picture where the line is. Nothing that reads the text as words sees the lines: they
  // are taken out before the text goes to the translator (or for notes) and put back after the same number of lines.
  const MARK_LINE = /^\s*\u27e6image:(\d{1,4})\u27e7\s*$/;
  const mark = (n) => "\u27e6image:" + n + "\u27e7";
  const illustrationNo = (line) => { const m = MARK_LINE.exec(String(line == null ? "" : line)); return m ? Number(m[1]) : 0; };
  function splitIllustrations(text) {
    const keep = [];
    const marks = [];
    for (const line of String(text == null ? "" : text).split("\n")) {
      const n = illustrationNo(line);
      if (n) marks.push({ after: keep.length, n });
      else keep.push(line);
    }
    return { text: keep.join("\n"), marks, count: keep.length };
  }
  // The words (translated: a different number of lines is possible) with the pictures put back, each after as many lines as it had before it (scaled to the new count)
  function joinIllustrations(text, split) {
    if (!split || !split.marks.length) return text;
    const out = String(text == null ? "" : text).split("\n");
    const total = out.length;
    let shift = 0;
    for (const m of split.marks) {
      const at = split.count === total ? m.after : Math.min(total, Math.round((m.after * total) / Math.max(1, split.count)));
      out.splice(at + shift, 0, mark(m.n));
      shift++;
    }
    return out.join("\n");
  }
  const stripIllustrations = (text) => splitIllustrations(text).text;

  // ---------- keeping to a limit ----------
  // rows: [{ key, size, readAt }]. The keys to remove so the rest is at most `max` bytes: the least recently read first, never one of `keep`
  // (a chapter being read or sent). Nothing is removed when the rows already fit, or when only kept ones are left.
  function planTrim(rows, max, keep) {
    const kept = new Set(keep || []);
    let total = rows.reduce((n, r) => n + r.size, 0);
    const drop = [];
    for (const r of rows.filter((x) => !kept.has(x.key)).sort((a, b) => a.readAt - b.readAt || a.key.localeCompare(b.key))) {
      if (total <= max) break;
      drop.push(r.key);
      total -= r.size;
    }
    return drop;
  }

  // ---------- the bundles on this device ----------
  // One record per chapter key: { key, blob (the bundle), size, pages (entries: where each page is in the blob), manifest, savedAt, readAt }.
  // The site's page and the extension each have one of their own (an IndexedDB is the page's, or the extension's).
  function openStore(name) {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name || "p2p-images", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("bundles", { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const run = async (mode, fn) => {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction("bundles", mode);
        const req = fn(t.objectStore("bundles"));
        t.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    };
    const read = async (key) => (await run("readonly", (st) => st.get(String(key)))) || null;
    // Reads a record and writes it back changed in ONE transaction: fn(record) -> the new record, or null to leave it; resolves whether there was one. (Two transactions, a read and a
    // write, let a pin and a "read just now" overwrite each other.)
    const modify = async (key, fn) => {
      const d = await db();
      return new Promise((resolve, reject) => {
        const t = d.transaction("bundles", "readwrite");
        const st = t.objectStore("bundles");
        let found = false;
        const g = st.get(String(key));
        g.onsuccess = () => {
          if (!g.result) return;
          found = true;
          const next = fn(g.result);
          if (next) st.put(next);
        };
        t.oncomplete = () => resolve(found);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    };
    return {
      // the bundle (bytes) of a chapter, kept
      async put(key, bytes) {
        const { manifest, pages } = indexBundle(bytes);
        const now = Date.now();
        const d = await db();
        await new Promise((resolve, reject) => {
          const t = d.transaction("bundles", "readwrite");
          const st = t.objectStore("bundles");
          const g = st.get(String(key));
          g.onsuccess = () => st.put({ key: String(key), blob: new Blob([bytes], { type: "application/zip" }), size: bytes.length, pages, manifest, savedAt: now, readAt: now, ...(g.result && g.result.pinned ? { pinned: true } : {}) }); // (a pinned chapter stays pinned)
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        });
        return { pages: pages.length, size: bytes.length };
      },
      async has(key) { return !!(await read(key)); },
      // read just now (a chapter being opened or sent): the last to be dropped when the store is trimmed
      async touch(key) {
        await modify(key, (r) => ({ ...r, readAt: Date.now() }));
      },
      // what is kept of a chapter, without its pictures: { pages, size, savedAt, title } or null
      async info(key) {
        const r = await read(key);
        return r ? { pages: r.pages.length, size: r.size, savedAt: r.savedAt, title: r.manifest.title || "", pinned: !!r.pinned } : null;
      },
      // one picture: { bytes, type } or null
      async page(key, i) {
        const r = await read(key);
        const e = r && r.pages[i];
        if (!e) return null;
        return { bytes: new Uint8Array(await r.blob.slice(e.start, e.start + e.length).arrayBuffer()), type: e.type, ...(e.w ? { w: e.w, h: e.h } : {}) };
      },
      // the whole bundle as bytes, or null
      async bundle(key) {
        const r = await read(key);
        return r ? new Uint8Array(await r.blob.arrayBuffer()) : null;
      },
      remove: (key) => run("readwrite", (st) => st.delete(String(key))),
      async keys() { return (await run("readonly", (st) => st.getAllKeys())) || []; },
      // Keep this chapter's pictures on this device (pinned: trim never drops it) or let it go back to the cache
      async pin(key, on) {
        return modify(key, (r) => ({ ...r, pinned: !!on }));
      },
      // Drops the bundles least recently read until what is kept fits `max` bytes; `keep`: keys not to drop (the pinned ones are never dropped). Returns the keys dropped.
      async trim(max, keep) {
        const all = (await run("readonly", (st) => st.getAll())) || [];
        const drop = planTrim(all.map((r) => ({ key: r.key, size: r.size, readAt: r.readAt || 0 })), max, [...(keep || []), ...all.filter((r) => r.pinned).map((r) => r.key)]);
        for (const key of drop) await run("readwrite", (st) => st.delete(key));
        return drop;
      },
      async usage() {
        const all = (await run("readonly", (st) => st.getAll())) || [];
        return { chapters: all.length, bytes: all.reduce((n, r) => n + r.size, 0) };
      }
    };
  }

  const api = { VERSION, MAX_PAGES, MAX_PAGE_BYTES, MAX_BUNDLE_BYTES, urlsOf, imgUrl, sizeOf, mark, illustrationNo, splitIllustrations, joinIllustrations, stripIllustrations, urlsFromProps, fetchPages, kindOf, crc32, zip, packBundle, indexBundle, pageBytes, squeeze, toB64, fromB64, planTrim, openStore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ImageChapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
