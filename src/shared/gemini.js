const GEMINI_MODEL = "gemini-3.5-flash-lite";
// The model list when the live models.list call fails.
const GEMINI_MODELS_FALLBACK = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.5-pro"];

// The languages chapters, titles and details can be translated into (Settings › Translation › Translate into, the library's setting targetLanguage;
// [code, name]). English is the default. The site's own come first (en, tr, es, id, pt, th, ru), then the rest by name: every language Google Translate and
// Gemini both work in.
const GEMINI_LANGUAGES = [
  ["en", "English"], ["tr", "Turkish"], ["es", "Spanish"], ["id", "Indonesian"], ["pt", "Portuguese"], ["th", "Thai"], ["ru", "Russian"],
  ["af", "Afrikaans"], ["sq", "Albanian"], ["am", "Amharic"], ["ar", "Arabic"], ["hy", "Armenian"],
  ["az", "Azerbaijani"], ["eu", "Basque"], ["be", "Belarusian"], ["bn", "Bengali"], ["bs", "Bosnian"],
  ["bg", "Bulgarian"], ["my", "Burmese"], ["ca", "Catalan"], ["ceb", "Cebuano"], ["zh", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"], ["hr", "Croatian"], ["cs", "Czech"], ["da", "Danish"], ["nl", "Dutch"],
  ["et", "Estonian"], ["tl", "Filipino"], ["fi", "Finnish"], ["fr", "French"], ["gl", "Galician"],
  ["ka", "Georgian"], ["de", "German"], ["el", "Greek"], ["gu", "Gujarati"], ["ht", "Haitian Creole"],
  ["ha", "Hausa"], ["he", "Hebrew"], ["hi", "Hindi"], ["hu", "Hungarian"], ["is", "Icelandic"],
  ["ig", "Igbo"], ["ga", "Irish"], ["it", "Italian"], ["ja", "Japanese"], ["jv", "Javanese"],
  ["kn", "Kannada"], ["kk", "Kazakh"], ["km", "Khmer"], ["ko", "Korean"], ["ku", "Kurdish"],
  ["ky", "Kyrgyz"], ["lo", "Lao"], ["la", "Latin"], ["lv", "Latvian"], ["lt", "Lithuanian"],
  ["mk", "Macedonian"], ["ms", "Malay"], ["ml", "Malayalam"], ["mt", "Maltese"], ["mi", "Maori"],
  ["mr", "Marathi"], ["mn", "Mongolian"], ["ne", "Nepali"], ["no", "Norwegian"], ["ps", "Pashto"],
  ["fa", "Persian"], ["pl", "Polish"], ["pt-BR", "Portuguese (Brazil)"], ["pa", "Punjabi"], ["ro", "Romanian"],
  ["sr", "Serbian"], ["si", "Sinhala"], ["sk", "Slovak"], ["sl", "Slovenian"], ["so", "Somali"],
  ["sw", "Swahili"], ["sv", "Swedish"], ["tg", "Tajik"], ["ta", "Tamil"], ["te", "Telugu"],
  ["uk", "Ukrainian"], ["ur", "Urdu"], ["uz", "Uzbek"], ["vi", "Vietnamese"], ["cy", "Welsh"],
  ["yo", "Yoruba"], ["zu", "Zulu"]
];
function geminiLanguageName(code) {
  const found = GEMINI_LANGUAGES.find((l) => l[0] === code);
  return found ? found[1] : String(code || "English");
}

// The person's own Gemini API key: the one typed in the library's Settings › Translation › Paid by, which the library's page in this browser hands over
// (site-bridge.js "access", kept in storage.local.profileKeys by Google's address), else the one typed in the popup before it had no place for it
// (storage.local.geminiApiKey). None is built in: without one every Gemini request fails with GEMINI_NO_KEY (translateByMode then gives titles and book
// details Google's translation in the "gemini-google" mode, or leaves them as they are).
const GEMINI_NO_KEY = "No Gemini API key: add yours in the library's Settings › Translation › Paid by, then open the library in this browser";
const GEMINI_KEY_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
async function getApiKey() {
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const { profileKeys, geminiApiKey } = await ext.storage.local.get(["profileKeys", "geminiApiKey"]);
  const key = (profileKeys && profileKeys[GEMINI_KEY_BASE]) || geminiApiKey;
  if (!key) throw new Error(GEMINI_NO_KEY);
  return key;
}

// Gemini takes so many requests a minute for a key, whatever they are for: every request made here (a chapter of any novel, from any tab or device
// that asked, a page being read, a book's details, notes on terms) waits for its turn in the same count. At most geminiRate() in any minute: the
// library's setting (Settings, Translation, on the library page), 12 by default.
// The prompts sent to Gemini: their instructions, which the library's Settings › Translation can change (the library's setting promptSets: for each of
// translate, notes and detect, the one in use, one of those that come with the extension (GEMINI_PROMPT_PRESETS) or one the person saved; GlossaryServer.promptSettings
// reads it, geminiPromptFrom picks). What goes with them is added whatever they say: the glossary and the chapter (translate), the terms' notes so far (notes:
// where {terms} is, or after the text if it is not there), the page's elements (detect). {language} (translate), {chapter}, {how}, {host} and {title} are filled in.
const GEMINI_PROMPTS = {
  translate:
    "Translate the following text to {language}, keeping the original formatting and line breaks. " +
    "Also identify recurring proper nouns (character/place names) or invented cultivation/genre " +
    "terminology in the source text that are not already covered by the glossary above, and " +
    "suggest a {language} translation for each. Keep the suggestion list short (only clearly " +
    "recurring or significant terms).",
  notes:
    "This text is chapter {chapter} of a novel{how}you keep short notes on the novel's terms for the reader, so that a name " +
    "they have forgotten can be looked up: who or what it is, and how it relates to the other terms (the members of a sect, a character's master " +
    "or family, where a place is, a cultivation rank's place among the others). These are the terms of this chapter with their notes so far, as " +
    "JSON: term is the term's source word, english how the glossary renders it, note your note so far, yours the reader's own note (context only: " +
    "never repeat it in your note):\n{terms}\n" +
    "In the field \"notes\", answer with the whole new note of each of these terms about which this chapter tells something new that matters " +
    "(not terms it only mentions in passing): keep every point of its note that is still true, add what this chapter tells, one point per line, " +
    "as \"- point (ch{chapter})\", correct a point this chapter shows is wrong, and keep each note short (at most about 12 lines). Name other terms " +
    "in English exactly as the glossary renders them. Leave out the terms whose note does not change; a term with no note yet gets one only when " +
    "this chapter tells enough about it. Use \"term\" exactly as given.",
  detect:
    "You are given the elements of one page of a web novel site ({host}, titled \"{title}\"): either a book's own page, " +
    "with its details and its list of chapters, or one chapter's page. Each element has an id. Say which element is which part, answering with ids only. " +
    "title: the book's own title (not the site's name, not a chapter title, not a menu item). " +
    "author: the element that holds just the author's name (prefer the link or label with the name itself, not a line like Author: plus other text). " +
    "description: the synopsis, the element that holds the whole description of the story. " +
    "cover: the book's cover picture (kind img or meta), not a logo, banner or advertisement. " +
    "genre: the group of genre or category labels of this book (kind group: links or badges). " +
    "chapterList: the list of this book's chapter links (kind list): the one whose entries are the chapters, not a menu, not a list of other books, not only the latest few chapters if a longer list is there. " +
    "A list marked partial only holds the latest chapters. " + "pager: the pagination bar of THAT chapter list, the page links that lead to the other pages of the same list (kind pager); not the pages of comments or of a list of other books; null if the whole chapter list is on this one page. " + "listOrder: for that list, asc if its first entries are the first chapters (lowest numbers) or desc if the newest chapter comes first; null if you cannot tell. " +
    "next: on a chapter's page, the link to the NEXT chapter (kind link). Not a link to the next page of a list, not a first, last or latest chapter link, not the table of contents. " +
    "A link may have a delta, how much the chapter number in its address differs from this page's: the nearest positive delta (usually +1) is the next chapter, the nearest negative one (usually -1) the previous chapter; " +
    "an icon class (arrow, chevron, angle, left, right) or a class like next or prev says the same. " +
    "prev: on a chapter's page, the link to the PREVIOUS chapter (kind link), with the same limits. " +
    "If the page has no such element (a book's page has no next or previous chapter link; a chapter's page has no details), answer null for that field. Never invent an id."
};
// The prompts that come with the extension, to pick from in Settings › Translation › Gemini prompts beside the ones the person saves: [{ id, name, about,
// text }] for each of the three. The translation ones are the prompts tried while finding a novel's terms (8 chapters of one novel, gemini-3.5-flash-lite,
// each chapter given the terms found in the ones before it); what each found is in `about`.
const GEMINI_TERM_RULES =
  "Names and terms must read the same all through the novel, so list every term of this chapter that has to be rendered the same way each time it comes up " +
  "and is not already in the glossary. Cover all of these: people (names, nicknames, titles used as a name), places (countries, cities, towns, mountains, regions, " +
  "worlds), organizations (sects, clans, families, schools, guilds, shops, auction houses), techniques (skills, spells, martial arts, formations, bloodlines, constitutions), " +
  "realms and ranks (cultivation stages, grades, titles of rank, tiers), items (pills, weapons, treasures, herbs, artifacts, currencies), creatures, and any invented or " +
  "genre-specific word. List all of them, however many there are; a name that comes up once still counts; leave out ordinary words and everyday objects. " +
  "term: the source text exactly as written in the chapter, as short as it can be while still the whole name (without a number, a particle or a measure word that is " +
  "not part of it: the stage 斗之气 and not 斗之气八段; the person 药老 and not 药老说). " +
  "translation: its translation, the way it will be written every time: names of people and places in pinyin (surname first, as in the original), " +
  "techniques, realms, ranks, items and organizations by their meaning, title-cased, in the style web-novel sites use; related terms follow one pattern " +
  "(the stages of one realm, the members of one family, the grades of one kind of item). kind: person, place, organization, technique, realm, item, creature or other.";
const GEMINI_EVERY_TERM =
  "Translate the following chapter of a web novel to {language}, keeping the original formatting and line breaks. Translate all of it: if the author wrote notes, an " +
  "afterword or a glossary or explanation of the novel's terms (often at the chapter's end or start), translate it in its place, in full, and take the terms it explains " +
  "to mean what the author says; never drop or shorten any of it. " + GEMINI_TERM_RULES;
const GEMINI_PROMPT_PRESETS = {
  translate: [
    { id: "default", name: "Default", about: "Translates the chapter and suggests the names and invented terms that come up again and again: about 9 new terms a chapter.", text: GEMINI_PROMPTS.translate },
    { id: "every-term", name: "Every term", about: "Lists every name, place, technique, rank and item, by kind, and translates an author's glossary inside a chapter instead of dropping it: about 12 to 20 new terms a chapter.", text: GEMINI_EVERY_TERM },
    {
      id: "one-name", name: "Every term, one name each", about: "As Every term, and asks for each term as one name, without its number or stage. Found more terms, but also pieces like a star count or a stage number.",
      text: GEMINI_EVERY_TERM + " Keep each term to one name: never join a term to a number, stage, grade, star, rank or other qualifier (list 斗者 and not 斗者三星, 黄阶 and 玄阶 and not 黄阶低阶, 炼药师 and not 二品炼药师, 魔兽 and not 四阶魔兽), " +
        "and never list two terms as one; list a full name and the short form people call the person by as two terms. A word counted by a number (品, 阶, 星, 段) is one term of its own, written the same way everywhere (for example 三品 is always Grade 3)."
    },
    {
      id: "no-everyday", name: "Every term, no everyday words", about: "As Every term, and asks to leave out sentences and everyday words. Still found about 65 terms, some of them ordinary words.",
      text: GEMINI_EVERY_TERM + " A term is a name or a fixed expression of this novel (something a reader could want to look up later), never a sentence or a part of one, never an everyday object or an ordinary word " +
        "(a door, a cave, a coin, a scroll, a young master); when in doubt, leave it out."
    }
  ],
  notes: [{ id: "default", name: "Default", about: "", text: GEMINI_PROMPTS.notes }],
  detect: [{ id: "default", name: "Default", about: "", text: GEMINI_PROMPTS.detect }]
};
// The prompt in use for one of the three, from the library's settings: `sets` is its promptSets ({ [name]: { active, mine: [{ id, name, text }] } }: active is
// the id of one of the person's own or of one that comes with the extension), `legacy` its geminiPrompts ({ [name]: text }, from before there were sets).
function geminiPromptFrom(name, sets, legacy) {
  const entry = sets && sets[name];
  if (entry && typeof entry.active === "string") {
    const mine = (Array.isArray(entry.mine) ? entry.mine : []).find((p) => p && p.id === entry.active);
    if (mine && typeof mine.text === "string" && mine.text.trim()) return mine.text;
    const built = (GEMINI_PROMPT_PRESETS[name] || []).find((p) => p.id === entry.active);
    if (built) return built.text;
  }
  const old = legacy && legacy[name];
  return typeof old === "string" && old.trim() ? old : GEMINI_PROMPTS[name];
}
async function geminiPrompt(name) {
  try {
    if (typeof GlossaryServer !== "undefined" && GlossaryServer.promptSettings) {
      const { sets, legacy } = await GlossaryServer.promptSettings();
      return geminiPromptFrom(name, sets, legacy);
    }
  } catch (e) {
    // (the library cannot be reached: the default)
  }
  return GEMINI_PROMPTS[name];
}
// {name} -> its value; a name not given is left as it is
const fillPrompt = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));

const geminiSent = []; // when the requests of the last minute were sent
let geminiLine = Promise.resolve();
async function geminiRateNow() {
  try {
    return typeof GlossaryServer !== "undefined" && GlossaryServer.geminiRate ? await GlossaryServer.geminiRate() : 12;
  } catch (e) {
    return 15;
  }
}
function geminiTurn() {
  const turn = geminiLine.then(async () => {
    for (;;) {
      const rate = await geminiRateNow();
      const now = Date.now();
      while (geminiSent.length && now - geminiSent[0] >= 60000) geminiSent.shift();
      if (geminiSent.length < rate) {
        geminiSent.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60000 - (now - geminiSent[0]) + 50));
    }
  });
  geminiLine = turn.catch(() => {});
  return turn;
}

// Short strings (chapter/novel titles) go through Google Translate's public endpoint instead of Gemini:
// instant, free, and good enough for a title. Best-effort — returns the input on any failure.
async function googleTranslateShort(text, lang) {
  if (!text) return text;
  try {
    const res = await fetch(
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(lang || "en") + "&dt=t&q=" + encodeURIComponent(text)
    );
    const data = await res.json();
    return (data[0] || []).map((seg) => seg[0]).join("") || text;
  } catch (e) {
    return text;
  }
}

// Many short strings (the titles of a whole chapter list) in a handful of requests: one line per string, one request per ~900
// characters (POST, since Chinese text makes a long URL). The translator keeps lines apart, but if a chunk comes back with a
// different number of lines we never guess which is which: it is split in half and retried, down to single strings.
// Always returns an array the same length as the input; anything that could not be translated stays as it was.
// Google refusing (its "unusual traffic" page, a 429) or no network: nothing is asked for a few minutes (googlePausedUntil), so a refusal is not kept going.
let googlePausedUntil = 0;
async function googleTranslateMany(texts, lang) {
  const out = texts.slice();
  const CHUNK_CHARS = 900;
  const pause = () => { googlePausedUntil = Date.now() + 5 * 60 * 1000; };

  async function translateChunk(idxs) {
    if (Date.now() < googlePausedUntil) return;
    try {
      const body = "q=" + idxs.map((i) => encodeURIComponent(String(texts[i]).replace(/\s+/g, " ").trim())).join("%0A");
      const res = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(lang || "en") + "&dt=t", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!res.ok) return pause();
      const data = await res.json();
      const joined = (data[0] || []).map((seg) => seg[0]).join("");
      const lines = joined.replace(/\n+$/, "").split("\n");
      if (lines.length === idxs.length) {
        idxs.forEach((i, k) => {
          out[i] = lines[k].trim() || texts[i];
        });
        return;
      }
      if (idxs.length === 1) {
        out[idxs[0]] = joined.replace(/\s*\n\s*/g, " ").trim() || texts[idxs[0]];
        return;
      }
    } catch (e) {
      return pause(); // network trouble: leave this chunk untranslated
    }
    const mid = Math.ceil(idxs.length / 2);
    await translateChunk(idxs.slice(0, mid));
    await translateChunk(idxs.slice(mid));
  }

  const chunks = [];
  let cur = [];
  let len = 0;
  texts.forEach((t, i) => {
    if (!t || !String(t).trim()) return;
    if (cur.length && len + String(t).length > CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += String(t).length + 1;
  });
  if (cur.length) chunks.push(cur);
  for (const idxs of chunks) await translateChunk(idxs);
  return out;
}

// The details of a book from a source site (its title, author, category, and synopsis lines) in English, by Gemini rather than Google: a short title
// sent to Google is taken for a name and comes back as pinyin ("Xian Gong Kaiwu"), where a title should say what it MEANS ("Immortal Creation").
// `texts` is [title, author, category, ...synopsis lines]; the answer is the same length and order, or null when it cannot be had (the caller
// then falls back to Google). Never merges or splits items.
async function geminiTranslateBook(texts, lang) {
  if (!Array.isArray(texts) || !texts.length) return null;
  const L = geminiLanguageName(lang || "en");
  try {
    const apiKey = await getApiKey();
    await geminiTurn();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text:
          "You translate the details of a web novel into " + L + ". The input is a JSON array of strings in this order: the title, the author, the genre, " +
          "then the synopsis paragraphs. Answer with the same number of strings, in the same order, in the JSON field \"translated\". " +
          "The title becomes a " + L + " title that says what it means, the way " + L + " web-novel sites title novels " +
          (L === "English" ? "(for example 仙工开物 becomes Immortal Creation and 咒术转盘 becomes Spell Wheel), " : ", ") + "never pinyin. " +
          "The author is a person's name: write it in pinyin, with no translation of its meaning. The genre is a label: translate it. " +
          "Translate the synopsis paragraphs faithfully. Never merge, split, drop or add items." + String.fromCharCode(10, 10) + JSON.stringify(texts) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: { type: "object", properties: { translated: { type: "array", items: { type: "string" } } }, required: ["translated"] } }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse((data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("") || "null");
    const out = parsed && parsed.translated;
    return Array.isArray(out) && out.length === texts.length && out.every((t) => typeof t === "string" && t.trim()) ? out.map((t) => t.trim()) : null;
  } catch (e) {
    return null;
  }
}

// Short titles (a chapter list, a page's title) by Gemini: a JSON list in, the same list in English out, each title saying what it means (never
// pinyin). Only the ones not in a Latin script are sent, in chunks; each request waits its turn (geminiTurn: the library's requests a minute).
// Answers { out, missing }: the list (what could not be had stays as it was) and the places Gemini did not answer for.
const NON_LATIN_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Devanagari}]/u;
async function geminiTranslateTitles(texts, lang) {
  const L = geminiLanguageName(lang || "en");
  const out = texts.slice();
  const todo = texts.map((t, i) => i).filter((i) => NON_LATIN_TEXT.test(String(texts[i] || "")));
  const missing = [];
  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (e) {
    return { out, missing: todo };
  }
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const i of todo) {
    if (cur.length && (cur.length >= 100 || len + String(texts[i]).length > 4000)) { chunks.push(cur); cur = []; len = 0; }
    cur.push(i);
    len += String(texts[i]).length;
  }
  if (cur.length) chunks.push(cur);
  for (const idxs of chunks) {
    const list = idxs.map((i) => String(texts[i]).replace(/\s+/g, " ").trim());
    let got = null;
    try {
      await geminiTurn();
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text:
            "You translate the titles of a web novel and its chapters into " + L + ". The input is a JSON array of strings. Answer with the same number of " +
            "strings, in the same order, in the JSON field \"translated\". A title becomes a " + L + " title that says what it means, the way " + L + " " +
            "web-novel sites title novels and chapters " + (L === "English" ? "(for example 仙工开物 becomes Immortal Creation, 第十二章 风起 becomes Chapter 12: The Wind Rises), " : ", ") +
            "never pinyin. Keep chapter numbers. Never merge, split, drop or add items." + String.fromCharCode(10, 10) + JSON.stringify(list) }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: { type: "object", properties: { translated: { type: "array", items: { type: "string" } } }, required: ["translated"] } }
        })
      });
      if (res.ok) {
        const data = await res.json();
        const parsed = JSON.parse((data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join("") || "null");
        const t = parsed && parsed.translated;
        if (Array.isArray(t) && t.length === list.length && t.every((x) => typeof x === "string" && x.trim())) got = t.map((x) => x.trim());
      }
    } catch (e) {
      got = null;
    }
    if (got) idxs.forEach((i, k) => (out[i] = got[k]));
    else missing.push(...idxs);
  }
  return { out, missing };
}

// How titles and details that are not in English are put into English, as the library's setting says (Settings › Translation on the site, for
// every device): "google" (Google Translate, the default; Gemini, with a key, while Google refuses), "gemini", "gemini-google" (Gemini, and Google Translate for what Gemini can't do:
// no key, no answer), "off" (left as they are). kind "book": a book's [title, author, genre, ...synopsis] (geminiTranslateBook); "titles": a
// list of titles. Gemini's requests count toward the library's requests a minute. Always the same length as `texts`.
async function titleModeNow() {
  try {
    return typeof GlossaryServer !== "undefined" && GlossaryServer.titleMode ? await GlossaryServer.titleMode() : "google";
  } catch (e) {
    return "google";
  }
}
// The language to translate into, as the library's setting says (its code; English when it has none or cannot be reached).
async function targetLanguageNow() {
  try {
    return typeof GlossaryServer !== "undefined" && GlossaryServer.targetLanguage ? await GlossaryServer.targetLanguage() : "en";
  } catch (e) {
    return "en";
  }
}
async function translateByMode(texts, kind) {
  if (!Array.isArray(texts) || !texts.length) return Array.isArray(texts) ? texts.slice() : [];
  const mode = await titleModeNow();
  if (mode === "off") return texts.slice();
  const lang = await targetLanguageNow();
  if (mode !== "gemini" && mode !== "gemini-google") {
    const out = await googleTranslateMany(texts, lang);
    if (!(Date.now() < googlePausedUntil)) return out;
    // Google refusing (its "unusual traffic" page, on some networks): Gemini with your key does it instead (nothing changes without a key)
    if (kind === "book") return (await geminiTranslateBook(texts, lang)) || out;
    const left = out.map((t, i) => (t === texts[i] && NON_LATIN_TEXT.test(String(t || "")) ? i : -1)).filter((i) => i >= 0);
    if (left.length) { const g = (await geminiTranslateTitles(left.map((i) => texts[i]), lang)).out; left.forEach((i, k) => (out[i] = g[k])); }
    return out;
  }
  if (kind === "book") {
    const got = await geminiTranslateBook(texts, lang);
    if (got) return got;
    return mode === "gemini-google" ? googleTranslateMany(texts, lang) : texts.slice();
  }
  const { out, missing } = await geminiTranslateTitles(texts, lang);
  if (missing.length && mode === "gemini-google") {
    const g = await googleTranslateMany(missing.map((i) => texts[i]), lang);
    missing.forEach((i, k) => (out[i] = g[k]));
  }
  return out;
}

// Which parts of a book's page, or of a chapter's page, are which, by Gemini. `candidates` are what book-detect.js found on the page: [{ id, kind, tag, text |
// texts, src, w, h, href, ... }] where kind is "text" (an element's text), "img" or "meta" (a picture), "group" (a set of short links, like genres), "list" (a
// container of many links: a chapter list, with its first and last entries), "pager" (the page links of a pagination bar) or "link" (a link that says next or previous). Gemini does not write selectors: it
// only says which candidate is which (by id), so nothing it answers can be anything but an element that is on the page. `page`: { host, title }.
// Answers { picks: { title, author, description, cover, genre, chapterList, pager, next, prev, listOrder } } (each a candidate id, or null when the page has none;
// listOrder "asc", "desc" or null) or { error }.
const DETECT_FIELDS = ["title", "author", "description", "cover", "genre", "chapterList", "pager", "next", "prev"];
async function geminiDetectBook(candidates, page) {
  if (!Array.isArray(candidates) || !candidates.length) return { error: "no candidates on the page" };
  try {
    const apiKey = await getApiKey();
    const nullableId = { type: "string", nullable: true };
    const prompt = fillPrompt(await geminiPrompt("detect"), { host: (page && page.host) || "unknown", title: (page && page.title) || "" }) + "\n\n" + JSON.stringify(candidates);
    await geminiTurn();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: { type: "object", properties: { ...Object.fromEntries(DETECT_FIELDS.map((f) => [f, nullableId])), listOrder: { type: "string", enum: ["asc", "desc"], nullable: true } }, required: DETECT_FIELDS } }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (data.error && data.error.message) || "Gemini answered HTTP " + res.status };
    const raw = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map((p) => p.text).join("");
    const parsed = JSON.parse(raw || "null");
    if (!parsed || typeof parsed !== "object") return { error: "Gemini's answer could not be read" };
    const known = new Set(candidates.map((c) => c.id));
    const picks = {};
    for (const f of DETECT_FIELDS) picks[f] = typeof parsed[f] === "string" && known.has(parsed[f]) ? parsed[f] : null; // (an id that is not on the page is no answer)
    picks.listOrder = parsed.listOrder === "asc" || parsed.listOrder === "desc" ? parsed.listOrder : null;
    return { picks };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

// Only the notes on terms, for a chapter that is already English (see term-notes.js notesOnly): one request with the chapter's text and the notes of
// the terms in it. Answers { notes: [{ term, note }] } (the notes it changed) or { error }.
// prompt (optional): the instructions to use for this request, in place of the notes prompt in use
async function geminiTermNotes(text, notes, model, prompt) {
  try {
    const apiKey = await getApiKey();
    await geminiTurn();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: (await notesBlock(notes, true, prompt)) + "The chapter:\n" + text }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: { type: "object", properties: { notes: NOTES_SCHEMA }, required: ["notes"] } }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (data.error && data.error.message) || "Gemini answered HTTP " + res.status };
    const parsed = JSON.parse(((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map((p) => p.text).join("") || "null");
    return { notes: parsed && Array.isArray(parsed.notes) ? parsed.notes : [] };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

async function listGeminiModels() {
  try {
    const apiKey = await getApiKey();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.models)) return GEMINI_MODELS_FALLBACK;
    const names = data.models
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    return names.length > 0 ? names : GEMINI_MODELS_FALLBACK;
  } catch (e) {
    return GEMINI_MODELS_FALLBACK;
  }
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    translated: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          translation: { type: "string" },
          kind: { type: "string" } // (a prompt that asks for the kind of each term gets it: person, place, technique...)
        },
        required: ["term", "translation"]
      }
    }
  },
  required: ["translated", "suggestions"]
};

// The notes on the novel's terms, asked for beside a translation (see term-notes.js): what goes in the request about them, and what comes back.
const NOTES_SCHEMA = {
  type: "array",
  items: { type: "object", properties: { term: { type: "string" }, note: { type: "string" } }, required: ["term", "note"] }
};
// english: the text is already in English (a chapter the site translated, or one translated before without notes): only the notes are asked for.
// custom: a prompt chosen for this one request (the reader's Custom prompt), used in place of the one in use
async function notesBlock(notes, english, custom) {
  const text = custom || (await geminiPrompt("notes"));
  const terms = JSON.stringify(notes.items);
  const filled = fillPrompt(text, { chapter: notes.chapter, how: english ? ", already in English. " : ". Beside translating it, ", terms });
  return filled + (text.includes("{terms}") ? "" : "\n" + terms) + "\n\n"; // (the terms go with it, whatever the prompt says)
}

// notes (optional): { chapter, items } from term-notes.js: the notes of the terms in this text, for Gemini to bring up to date. The answer then also
// has `notes`: [{ term, note }], the notes it changed.
// language: the code of the language to translate into (the library's Translate into; English when none). An entry of the glossary with no `translation` is a
// term the novel has but has no rendering in that language yet: Gemini is asked to translate it and to list it in the suggestions, which is how a language's
// glossary is built over time.
// extra (optional, the reader's Custom prompt): { prompt (the instructions, in place of the translation prompt in use) }
async function translateText(text, glossary, model, notes, language, extra) {
  const languageName = geminiLanguageName(language || "en");
  const useModel = model || GEMINI_MODEL;
  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (e) {
    return { error: e.message };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${apiKey}`;

  // Large glossaries (e.g. imported from SITE) would bloat every request, so only send the entries
  // whose source term really occurs in this text.
  // (term-match.js picks them when it is loaded: longest first, a term of one character only where it is a name, the parts of a person's name with the full
  // name. `extra.singles` is the benchmark's switch: "always" is the plain text.includes.)
  const relevantGlossary = typeof TermMatch !== "undefined"
    ? TermMatch.select(text, glossary, { singles: extra && extra.singles }).entries
    : (Array.isArray(glossary) ? glossary : []).filter((e) => (e.terms || [e.term]).some((t) => t && text.includes(t)));

  let glossaryBlock = "";
  const rendered = relevantGlossary.filter((e) => e.translation);
  const wanting = relevantGlossary.filter((e) => !e.translation);
  if (rendered.length > 0) {
    const lines = rendered
      .map((e) => `${(e.terms || [e.term]).join(" / ")} = ${e.translation}` + (e.gender ? ` (${e.gender})` : "") + (e.forms && e.forms.length ? ` (the same person, when written alone: ${e.forms.join("; ")})` : ""))
      .join("\n");
    glossaryBlock =
      "Use these exact translations whenever these terms appear, for consistency:\n" + lines + "\n\n";
  }
  if (wanting.length > 0) {
    glossaryBlock +=
      "These terms are in the novel's glossary but have no " + languageName + " translation yet: translate each into " + languageName + ", the same way every time it appears " +
      "in this novel, and list each of them in the suggestions with its translation:\n" + wanting.map((e) => (e.terms || [e.term]).join(" / ")).join("\n") + "\n\n";
  }
  const rawPrompt = (extra && extra.prompt) || (await geminiPrompt("translate"));
  const prompt = fillPrompt(rawPrompt, { language: languageName }) + (languageName !== "English" && !rawPrompt.includes("{language}") ? " Write the translation in " + languageName + "." : "");

  const body = {
    contents: [
      {
        parts: [
          {
            text: prompt + "\n\n" + glossaryBlock + (notes && notes.items && notes.items.length ? await notesBlock(notes) : "") + text
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: notes ? { ...RESPONSE_SCHEMA, properties: { ...RESPONSE_SCHEMA.properties, notes: NOTES_SCHEMA } } : RESPONSE_SCHEMA
    }
  };

  try {
    await geminiTurn();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      return { error: data.error?.message || `Gemini API error (${res.status})` };
    }
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (!raw) {
      return { error: "empty response from Gemini" };
    }
    try {
      const parsed = JSON.parse(raw);
      const existingTerms = new Set((glossary || []).filter((e) => e.translation).flatMap((e) => e.terms || [e.term]));
      const suggestions = (parsed.suggestions || []).filter((s) => !existingTerms.has(s.term));
      return { translated: parsed.translated || "(empty translation)", suggestions, model: useModel, ...(notes && Array.isArray(parsed.notes) ? { notes: parsed.notes } : {}) };
    } catch (e) {
      return { translated: raw, suggestions: [], model: useModel };
    }
  } catch (e) {
    return { error: e.message };
  }
}
