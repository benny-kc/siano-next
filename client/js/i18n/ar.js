// Arabic (العربية) — a right-to-left language (LOCALES marks dir:"rtl", so the
// app sets <html dir="rtl"> when it's active). Translations pending — an empty
// catalog falls back to English. To ship Arabic, add the keys from en.js
// (JS-rendered strings) and the data-i18n keys from index.html (static chrome),
// keeping any {placeholder} tokens and HTML tags intact. NB: full RTL layout
// polish in css/app.css is a follow-up beyond this string scaffold.
import { registerVersion } from "../version.js";
registerVersion("js/i18n/ar.js", 1);

export default {};
