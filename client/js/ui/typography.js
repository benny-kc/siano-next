// Per-device typography preferences — font family, text size and boldness.
//
// Purely local and per-viewer (like the drawer state and the "me" ledger pick):
// stored in localStorage, applied as CSS custom properties / a data-attribute on
// <html> so a board repaint never disturbs them. Nothing here is synced — how
// big or bold YOUR phone renders the UI is nobody else's business.
//
//   --siano-font        the chosen font-family stack (body inherits it)
//   --siano-ui-scale    a multiplier on the root font-size (rem-based UI scales)
//   --siano-weight      an offset added to every font-weight tier (the "Font
//                       weight" stepper), so text across the whole app gets
//                       lighter/heavier — see the --fw-* tokens in app.css
//   data-siano-theme    "light" for the warm-beige theme (absent = dark)
//
// Fonts are SYSTEM stacks only — the app is offline-first behind a tight CSP, so
// no web fonts are loaded. The five options render distinctly on every device.

import { registerVersion } from "../version.js";
registerVersion("js/ui/typography.js", 1);

const KEY = "siano:type";

export const FONTS = [
  { id: "system", label: "System", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "sans", label: "Sans", stack: 'Arial, "Helvetica Neue", Helvetica, sans-serif' },
  { id: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", Times, serif' },
  { id: "mono", label: "Mono", stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: "wide", label: "Wide", stack: 'Verdana, Tahoma, Geneva, sans-serif' },
];

export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.4;
export const SCALE_STEP = 0.1;

// Weight is stored as an offset added to every tier (0 = the app's defaults),
// so the stepper shifts the whole scale. Bounds keep the lightest tier readable
// and the heaviest tier within real font-weight range.
export const WEIGHT_MIN = -200;
export const WEIGHT_MAX = 300;
export const WEIGHT_STEP = 100;

const THEMES = ["dark", "light"];
const DEFAULTS = { family: "system", scale: 1, weight: 0, theme: "dark" };

const clampScale = (s) => {
  const n = Math.round((Number(s) || 1) * 100) / 100;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
};
const clampWeight = (w) => {
  const n = Math.round((Number(w) || 0) / WEIGHT_STEP) * WEIGHT_STEP;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, n));
};

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && typeof v === "object") {
      return {
        family: FONTS.some((f) => f.id === v.family) ? v.family : DEFAULTS.family,
        scale: clampScale(v.scale),
        // Back-compat: an old { bold: true } pref maps to a heavier offset.
        weight: v.weight != null ? clampWeight(v.weight) : v.bold ? 200 : 0,
        theme: THEMES.includes(v.theme) ? v.theme : DEFAULTS.theme,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

let state = load();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — preference is a convenience, not data */
  }
}

/** A copy of the current preferences (for the renderer to reflect selection). */
export function getTypography() {
  return { ...state };
}

/** Write the current preferences onto <html>. Call on boot and after any change. */
export function applyTypography() {
  const root = document.documentElement;
  const font = (FONTS.find((f) => f.id === state.family) || FONTS[0]).stack;
  root.style.setProperty("--siano-font", font);
  root.style.setProperty("--siano-ui-scale", String(state.scale));
  root.style.setProperty("--siano-weight", String(state.weight));
  if (state.theme === "light") root.setAttribute("data-siano-theme", "light");
  else root.removeAttribute("data-siano-theme");
  // Keep the browser UI (PWA title bar / address bar tint) in step with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", state.theme === "light" ? "#f3ead3" : "#020617");
}

export function setFont(id) {
  if (!FONTS.some((f) => f.id === id)) return;
  state.family = id;
  persist();
  applyTypography();
}

export function stepScale(delta) {
  state.scale = clampScale(state.scale + delta);
  persist();
  applyTypography();
}

export function stepWeight(delta) {
  state.weight = clampWeight(state.weight + delta);
  persist();
  applyTypography();
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  state.theme = theme;
  persist();
  applyTypography();
}

export function resetTypography() {
  state = { ...DEFAULTS };
  persist();
  applyTypography();
}
