// Is a text already in the language to translate into? Used by the extension (original-translate.js) and the library site (profiles.js), so a chapter on an
// English site is not sent to a translator to come back as English.
var LangDetect = (function () {
  // Is this text already English? A page in any other script has letters Latin text does not; a Latin-script language that is not English (Spanish,
  // French...) is told apart by how little of it is the commonest English words (about 40% of English prose, a few percent of other languages).
  const NON_LATIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Devanagari}]/gu;
  const COMMON = new Set("the and of to a in that it is was he she you i for with his her on as at be had not but they this have from by or one all were we there what so said an are him them would their me my no if out up about who just when could into like then than now over only your how".split(" "));
  function isEnglish(text) {
    const t = String(text || "");
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters < 200) return false; // too little to be sure: leave it to the translator
    if (((t.match(NON_LATIN) || []).length) / letters > 0.02) return false;
    const words = t.toLowerCase().match(/[a-z']+/g) || [];
    if (words.length < 40) return false;
    return words.filter((w) => COMMON.has(w)).length / words.length >= 0.22;
  }
  
  // Is this text already in the language `lang` (a code)? English as above; a language in its own script (Russian, Thai, Chinese, Japanese, Korean, Arabic,
  // Hebrew, Hindi) by the share of letters in that script; the Latin-script ones named below by the share of their commonest words. Any other language: false
  // (the translator decides).
  const SCRIPTS = {
    ru: /\p{Script=Cyrillic}/gu, uk: /\p{Script=Cyrillic}/gu, th: /\p{Script=Thai}/gu, ko: /\p{Script=Hangul}/gu, ar: /\p{Script=Arabic}/gu,
    he: /\p{Script=Hebrew}/gu, hi: /\p{Script=Devanagari}/gu, zh: /\p{Script=Han}/gu, ja: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
  };
  const COMMON_BY_LANG = {
    es: "de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o fue este ha sí porque esta son entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante".split(" "),
    pt: "de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos".split(" "),
    fr: "de la le et les des en un du une que est pour qui dans a par plus pas au sur ne se ce il sont la avec son mais comme ou si leur y elle ont aux été cette nous vous je tout être fait ses deux".split(" "),
    de: "der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde".split(" "),
    id: "yang dan di dengan untuk dari dalam tidak ini itu akan pada juga saya ke karena ada mereka dia sudah bisa oleh atau tetapi seperti lebih kami kita telah apa hanya jika saat sebuah para harus banyak".split(" "),
    tr: "ve bir bu da de için ile o çok daha ne gibi ama en kadar sonra var olarak her ben sen biz onu ki mi değil şey ya ise bu kendi çünkü sadece bütün olan".split(" "),
    it: "di che e la il un a per in è non una con sono da i le si ma lo come più del dei al ha anche della gli nel suo questo era se ci mi tutto ho molto o lei lui sua".split(" ")
  };
  function isLanguage(text, lang) {
    const code = String(lang || "en").split("-")[0].toLowerCase();
    if (code === "en") return isEnglish(text);
    const t = String(text || "");
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters < 200) return false;
    if (SCRIPTS[code]) return ((t.match(SCRIPTS[code]) || []).length) / letters >= (code === "zh" || code === "ja" ? 0.5 : 0.8) && (code !== "zh" || !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t));
    const common = COMMON_BY_LANG[code];
    if (!common) return false;
    if (((t.match(NON_LATIN) || []).length) / letters > 0.02) return false;
    const words = t.toLowerCase().match(/[\p{L}']+/gu) || [];
    if (words.length < 40) return false;
    const set = new Set(common);
    const share = words.filter((w) => set.has(w)).length / words.length;
    // (it must also not be more English than the language)
    return share >= 0.3 && words.filter((w) => COMMON.has(w)).length / words.length < share;
  }

  return { isEnglish, isLanguage };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LangDetect;
