// Locale registry — the list of languages the app ships and the map from each
// language code to its message catalog. This is the ONE place to register a new
// language: add a `{ code, label, endonym, dir }` row to LOCALES, drop a
// `<code>.js` catalog beside this file, and import it into CATALOGS below.
//
// SCOPE / SOURCE OF TRUTH
//   • en.js is the source of truth for JS-rendered strings — every t("…") key
//     board.js / app.js / interactions.js / onboarding.js uses lives there.
//   • The static chrome in index.html carries its own English inline (tagged
//     with data-i18n / data-i18n-html / data-i18n-attr). ui/i18n.js snapshots
//     that English on boot and swaps in a translation for a non-English locale
//     (restoring the snapshot for English), so those strings are NOT duplicated
//     here — a translator provides them in their own catalog keyed by the same
//     data-i18n names.
//   • Every non-English catalog is currently an EMPTY object: a missing key
//     falls back to English, so shipping a language is purely additive — fill in
//     `<code>.js` (JS-string keys from en.js + the index.html data-i18n keys)
//     and nothing else changes.
//
// The catalogs are imported statically (not lazily) so the whole set is part of
// the offline shell and the buildless asset-hashing graph stays static — the
// stubs are near-empty, so the cost is negligible until they're translated.

import { registerVersion } from "../version.js";
import en from "./en.js";
import es from "./es.js";
import fr from "./fr.js";
import de from "./de.js";
import it from "./it.js";
import pt from "./pt.js";
import zh from "./zh.js";
import ja from "./ja.js";
import ko from "./ko.js";
import ar from "./ar.js";
registerVersion("js/i18n/index.js", 1);

export const DEFAULT_LOCALE = "en";

// `label` is the English name (for reference); `endonym` is the language's own
// name (what a speaker recognises in the picker); `dir` is the writing
// direction ("rtl" for Arabic — the app sets <html dir> from it).
export const LOCALES = [
  { code: "en", label: "English", endonym: "English", dir: "ltr" },
  { code: "es", label: "Spanish", endonym: "Español", dir: "ltr" },
  { code: "fr", label: "French", endonym: "Français", dir: "ltr" },
  { code: "de", label: "German", endonym: "Deutsch", dir: "ltr" },
  { code: "it", label: "Italian", endonym: "Italiano", dir: "ltr" },
  { code: "pt", label: "Portuguese", endonym: "Português", dir: "ltr" },
  { code: "zh", label: "Chinese", endonym: "中文", dir: "ltr" },
  { code: "ja", label: "Japanese", endonym: "日本語", dir: "ltr" },
  { code: "ko", label: "Korean", endonym: "한국어", dir: "ltr" },
  { code: "ar", label: "Arabic", endonym: "العربية", dir: "rtl" },
];

export const CATALOGS = { en, es, fr, de, it, pt, zh, ja, ko, ar };
