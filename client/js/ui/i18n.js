// Localization engine — per-device UI language, purely client-side.
//
// WHY CLIENT-SIDE (and never on the hub): siano is local-first — every device
// holds the whole trip and renders it offline, and the hub is a dumb relay with
// NO business logic (it can't even compute a balance, let alone pick a
// language). So the app ships EVERY language as static assets and each device
// chooses one from the browser's own language preference — nothing is ever sent
// to the hub to get translated, and the op-log (trip data: meal/member names)
// is never translated, only the app's own chrome.
//
// Like typography.js, the choice is per-viewer and local (localStorage), applied
// to <html> so a board repaint never disturbs it:
//   lang="<code>"   the active language (also helps the browser + a11y)
//   dir="rtl"       for a right-to-left language (Arabic); "ltr" otherwise
//
// TWO STRING SOURCES, ONE ENGINE:
//   • JS-rendered strings — board.js/app.js/etc. call t("key", params). The
//     board repaints on a language change, so those pick up the new language
//     automatically.
//   • Static chrome in index.html — tagged data-i18n / data-i18n-html /
//     data-i18n-attr. We SNAPSHOT its English on boot, then swap in a
//     translation for a non-English locale (and restore the snapshot for
//     English). See applyStatic() below.

import { registerVersion } from "../version.js";
import { CATALOGS, LOCALES, DEFAULT_LOCALE } from "../i18n/index.js";
registerVersion("js/ui/i18n.js", 1);

export { LOCALES };

const KEY = "siano:lang";
const EN = CATALOGS[DEFAULT_LOCALE] || {};
const CODES = new Set(LOCALES.map((l) => l.code));

// The stored preference: a locale code, or "auto" to follow the browser.
let pref = load();
// The resolved locale actually in effect (never "auto").
let active = resolve(pref);

function load() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "auto" || CODES.has(v)) return v;
  } catch {
    /* private mode — the preference is a convenience, not data */
  }
  return "auto";
}

function persist() {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
}

/**
 * Resolve a stored preference to an actual locale code. "auto" matches the
 * browser's ordered language list against the languages we ship (by base
 * language, so "fr-CA" picks "fr"), falling back to English. `langs` is
 * injectable so this stays a pure, testable function.
 */
export function resolve(p, langs) {
  if (p && p !== "auto" && CODES.has(p)) return p;
  const list = langs || (typeof navigator !== "undefined" && navigator.languages) ||
    (typeof navigator !== "undefined" && navigator.language ? [navigator.language] : []);
  for (const tag of list) {
    if (!tag) continue;
    const lc = String(tag).toLowerCase();
    if (CODES.has(lc)) return lc;
    const base = lc.split("-")[0];
    if (CODES.has(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** The stored preference ("auto" or a locale code) — for the picker's value. */
export function localePref() {
  return pref;
}

/** The locale actually in effect (a concrete code, never "auto"). */
export function activeLocale() {
  return active;
}

/** The writing direction of the active locale ("ltr" | "rtl"). */
export function activeDir() {
  return (LOCALES.find((l) => l.code === active) || {}).dir || "ltr";
}

// Fill {name}-style placeholders in a template from `params`. A missing
// placeholder is left as-is (visible, so it's caught in testing).
function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/**
 * Translate `key` in the active catalog, falling back to English, then to the
 * key itself. A catalog value may be a string (with {placeholders}) or a
 * function of `params` (for plurals / grammar the reducer can't express as a
 * template). Pure over (catalog, fallback) so it's unit-testable.
 */
export function translate(catalog, fallback, key, params) {
  let v = catalog && catalog[key];
  if (v == null) v = fallback && fallback[key];
  if (v == null) return key;
  if (typeof v === "function") return v(params || {});
  return interpolate(v, params);
}

/** Translate `key` in the locale currently in effect. */
export function t(key, params) {
  return translate(CATALOGS[active], EN, key, params);
}

// ── Static (index.html) chrome ────────────────────────────────────────────────
// The English inline in index.html is the source of truth for these keys; we
// snapshot it once (before the first swap) so switching back to English (or a
// locale that doesn't translate a given key) restores the original exactly.
const snap = new WeakMap(); // el -> { text?, html?, attrs?: {name: value} }

function snapshot(root) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    if (!snap.has(el)) snap.set(el, {});
    snap.get(el).text = el.textContent;
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    if (!snap.has(el)) snap.set(el, {});
    snap.get(el).html = el.innerHTML;
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    const spec = parseAttrSpec(el.getAttribute("data-i18n-attr"));
    if (!snap.has(el)) snap.set(el, {});
    const attrs = (snap.get(el).attrs = snap.get(el).attrs || {});
    for (const { attr } of spec) attrs[attr] = el.getAttribute(attr);
  });
}

// "placeholder:key; aria-label:key2" -> [{attr, key}, …]
function parseAttrSpec(spec) {
  return String(spec || "")
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(":");
      return { attr: pair.slice(0, i).trim(), key: pair.slice(i + 1).trim() };
    })
    .filter((p) => p.attr && p.key);
}

// A translated value for a static key, or null to keep the English snapshot.
// (English resolves to null so the snapshot is restored verbatim.)
function staticValue(key) {
  if (active === DEFAULT_LOCALE) return null;
  const v = CATALOGS[active] && CATALOGS[active][key];
  if (v == null) return null;
  return typeof v === "function" ? v({}) : v;
}

function applyStatic(root) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = staticValue(el.getAttribute("data-i18n"));
    if (v != null) el.textContent = v;
    else if (snap.has(el) && snap.get(el).text != null) el.textContent = snap.get(el).text;
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const v = staticValue(el.getAttribute("data-i18n-html"));
    if (v != null) el.innerHTML = v;
    else if (snap.has(el) && snap.get(el).html != null) el.innerHTML = snap.get(el).html;
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const { attr, key } of parseAttrSpec(el.getAttribute("data-i18n-attr"))) {
      const v = staticValue(key);
      if (v != null) el.setAttribute(attr, v);
      else if (snap.has(el) && snap.get(el).attrs && snap.get(el).attrs[attr] != null) {
        el.setAttribute(attr, snap.get(el).attrs[attr]);
      }
    }
  });
}

// Write the active language onto <html> so CSS, the browser and assistive tech
// all see it (dir drives right-to-left for Arabic).
function applyHtmlAttrs() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", active);
  root.setAttribute("dir", activeDir());
}

/**
 * Apply the current locale to the page: set <html lang/dir> and localize the
 * static chrome. Call once on boot (it snapshots the English first) and again
 * after every change.
 */
export function applyI18n() {
  if (typeof document === "undefined") return;
  snapshot(document); // no-op after the first pass (snapshots are kept)
  applyHtmlAttrs();
  applyStatic(document);
}

/**
 * Change the language preference ("auto" or a locale code), persist it and
 * re-apply. Returns the resolved active code. The caller repaints the board (its
 * JS-rendered strings re-read t() on the next paint).
 */
export function setLocalePref(p) {
  pref = p === "auto" || CODES.has(p) ? p : "auto";
  active = resolve(pref);
  persist();
  applyI18n();
  return active;
}
