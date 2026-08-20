// PWA install helper — powers the "Install app" section at the top of the
// Settings drawer. There is deliberately no way to force-install from a tab, so
// this only:
//   • detects whether we're already running as an installed app (standalone),
//   • captures Chromium's `beforeinstallprompt` so we can replay it from a click
//     (Android / desktop Chrome / Edge → a real "Install" button),
//   • recognises iOS (Safari has no prompt API) so we can show the manual
//     "Add to Home Screen" instructions instead.
//
// The listeners are attached at import time so the browser's one-shot
// `beforeinstallprompt` is never missed; `initInstall(onChange)` wires a repaint
// so an open drawer updates the moment the event lands.

let deferredPrompt = null; // the stashed beforeinstallprompt event (Chromium)
let onChange = null; // repaint hook (set by initInstall)

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Stop Chrome's default mini-infobar; we surface our own button instead.
    e.preventDefault();
    deferredPrompt = e;
    if (onChange) onChange();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    try { localStorage.setItem("siano:installed", "1"); } catch { /* private mode */ }
    if (onChange) onChange();
  });
}

// Register the repaint callback so the Settings section refreshes when the
// install state changes (prompt captured, or app installed) while it's open.
export function initInstall(repaint) { onChange = repaint; }

// Are we running inside the installed app rather than a browser tab?
export function isStandalone() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.navigator.standalone === true // iOS Safari
    );
  } catch { return false; }
}

// iOS (incl. iPadOS 13+, which masquerades as a Mac with a touch screen).
function isIOS() {
  const ua = navigator.userAgent || "";
  const iPhoneish = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
  return iPhoneish || iPadOS;
}

/**
 * What the install UI should show right now:
 *   "standalone"  — already installed / launched as an app → render nothing
 *   "installable" — Chromium gave us a prompt (Android/desktop) → show a button
 *   "ios"         — iOS browser → show manual Add-to-Home-Screen instructions
 *   "none"        — nothing useful to offer (e.g. desktop Firefox) → render nothing
 */
export function installState() {
  if (isStandalone()) return "standalone";
  if (deferredPrompt) return "installable";
  if (isIOS()) return "ios";
  return "none";
}

// Replay the stashed prompt. MUST be called from a user gesture (a click).
// Returns "accepted" | "dismissed" | "unavailable".
export async function promptInstall() {
  if (!deferredPrompt) return "unavailable";
  const e = deferredPrompt;
  deferredPrompt = null; // the event is single-use
  e.prompt();
  let outcome = "dismissed";
  try { ({ outcome } = await e.userChoice); } catch { /* ignore */ }
  if (onChange) onChange();
  return outcome;
}
