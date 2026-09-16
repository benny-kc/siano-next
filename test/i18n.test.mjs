// Localization engine + catalog consistency.
//
// The engine (client/js/ui/i18n.js) touches document/navigator/localStorage
// only inside functions and guards for their absence, so it imports cleanly
// under plain node — these tests exercise the pure pieces (translate / resolve)
// and guard that every t("…") key the UI uses actually exists in the English
// source-of-truth catalog (a misspelled or removed key would otherwise render
// the raw key string to users, which nothing else catches).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate, resolve, t, activeLocale, localePref, LOCALES } from "../client/js/ui/i18n.js";
import { CATALOGS, DEFAULT_LOCALE } from "../client/js/i18n/index.js";
import en from "../client/js/i18n/en.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("translate: active wins, English is the fallback, key is the last resort", () => {
  const fr = { greeting: "Bonjour" };
  const fallback = { greeting: "Hello", only: "English only" };
  assert.equal(translate(fr, fallback, "greeting"), "Bonjour");
  assert.equal(translate(fr, fallback, "only"), "English only"); // falls back to English
  assert.equal(translate(fr, fallback, "missing"), "missing"); // neither has it
});

test("translate: fills {placeholders} and calls function values", () => {
  const cat = { hi: "Hi {name}", n: ({ count }) => `${count} item${count === 1 ? "" : "s"}` };
  assert.equal(translate(cat, {}, "hi", { name: "Ada" }), "Hi Ada");
  assert.equal(translate(cat, {}, "n", { count: 1 }), "1 item");
  assert.equal(translate(cat, {}, "n", { count: 3 }), "3 items");
  // A missing placeholder is left visible rather than becoming "undefined".
  assert.equal(translate(cat, {}, "hi"), "Hi {name}");
});

test("resolve: exact code, base-language match, and English fallback", () => {
  assert.equal(resolve("fr"), "fr"); // an explicit choice
  assert.equal(resolve("auto", ["fr-CA", "en"]), "fr"); // fr-CA -> fr by base
  assert.equal(resolve("auto", ["EN-us"]), "en"); // case-insensitive
  assert.equal(resolve("auto", ["xx", "de"]), "de"); // skips an unshipped tag
  assert.equal(resolve("auto", ["xx", "yy"]), DEFAULT_LOCALE); // nothing matches
  assert.equal(resolve("auto", []), DEFAULT_LOCALE);
  assert.equal(resolve("zz"), DEFAULT_LOCALE); // an unshipped explicit code
});

test("defaults to English with no browser/localStorage (node import)", () => {
  assert.equal(localePref(), "auto");
  assert.equal(activeLocale(), DEFAULT_LOCALE);
  assert.equal(t("common.on"), "On");
  assert.equal(t("bills.people", { n: 2 }), "2 people");
});

test("LOCALES and CATALOGS are consistent", () => {
  const codes = LOCALES.map((l) => l.code);
  assert.ok(codes.includes(DEFAULT_LOCALE), "English must be shipped");
  assert.equal(new Set(codes).size, codes.length, "no duplicate locale codes");
  // Every listed locale has a catalog and vice versa.
  for (const l of LOCALES) {
    assert.ok(l.endonym && l.label, `${l.code} needs a name`);
    assert.ok(["ltr", "rtl"].includes(l.dir), `${l.code} dir must be ltr|rtl`);
    assert.ok(CATALOGS[l.code], `catalog missing for ${l.code}`);
  }
  for (const code of Object.keys(CATALOGS)) {
    assert.ok(codes.includes(code), `catalog ${code} not listed in LOCALES`);
  }
  assert.ok(LOCALES.some((l) => l.dir === "rtl"), "RTL scaffold present (Arabic)");
});

test("English catalog values are all strings or functions and non-empty", () => {
  const keys = Object.keys(en);
  assert.ok(keys.length > 100, "English catalog should be populated");
  for (const [k, v] of Object.entries(en)) {
    const kind = typeof v;
    assert.ok(kind === "string" || kind === "function", `${k} must be string|function`);
    if (kind === "string") assert.ok(v.length > 0, `${k} must not be empty`);
  }
});

test("every t() key used in the UI exists in the English catalog", () => {
  const files = [
    "../client/js/ui/board.js",
    "../client/js/app.js",
    "../client/js/ui/interactions.js",
    "../client/js/ui/onboarding.js",
  ];
  const missing = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*"([a-z][\w.]+)"/gi)) {
      const key = m[1];
      if (key.includes(".") && !(key in en)) missing.push(`${f}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], "unknown i18n keys would render raw to users");
});

test("non-English catalogs only carry known keys (no orphaned/misspelt entries)", () => {
  // A key is legitimate if it's a JS-string key (in en.js) or a static-chrome
  // key tagged in index.html (data-i18n / data-i18n-html / data-i18n-attr).
  const html = read("../client/index.html");
  const staticKeys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html)?="([\w.]+)"/g)) staticKeys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(";")) {
      const key = pair.split(":")[1];
      if (key) staticKeys.add(key.trim());
    }
  }
  const known = new Set([...Object.keys(en), ...staticKeys]);
  assert.ok(staticKeys.size > 10, "index.html should tag static chrome with data-i18n");
  for (const [code, cat] of Object.entries(CATALOGS)) {
    if (code === DEFAULT_LOCALE) continue;
    for (const key of Object.keys(cat)) {
      assert.ok(known.has(key), `${code}.js has unknown key "${key}"`);
    }
  }
});
