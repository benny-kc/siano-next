// Per-device typography preferences — font family, text size and boldness.
//
// Purely local and per-viewer (like the drawer state and the "me" ledger pick):
// stored in localStorage, applied as CSS custom properties / a data-attribute on
// <html> so a board repaint never disturbs them. Nothing here is synced — how
// big or bold YOUR phone renders the UI is nobody else's business.
//
//   --siano-font        the chosen font-family stack (body inherits it)
//   --siano-ui-scale    a multiplier on the root font-size (rem-based UI scales)
//   data-siano-bold     present when "Bold text" is on (normal-weight text -> 600)
//
// Fonts are SYSTEM stacks only — the app is offline-first behind a tight CSP, so
// no web fonts are loaded. The five options render distinctly on every device.

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

const THEMES = ["dark", "light"];
const DEFAULTS = { family: "system", scale: 1, bold: false, theme: "dark" };

const clampScale = (s) => {
  const n = Math.round((Number(s) || 1) * 100) / 100;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
};

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && typeof v === "object") {
      return {
        family: FONTS.some((f) => f.id === v.family) ? v.family : DEFAULTS.family,
        scale: clampScale(v.scale),
        bold: !!v.bold,
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
  if (state.bold) root.setAttribute("data-siano-bold", "");
  else root.removeAttribute("data-siano-bold");
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

export function toggleBold() {
  state.bold = !state.bold;
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
