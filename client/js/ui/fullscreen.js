// Optional "always full-screen" behaviour, gated behind a per-device preference.
//
// When the preference is ON, the app re-enters full-screen on any user
// interaction, so it stays chrome-free: browsers only allow requesting
// full-screen from a user gesture, and a dialog / tab-switch / Escape silently
// drops it — so we simply request it again on the next tap/click/keypress
// whenever we're not already full-screen. When OFF, nothing happens and the app
// behaves like a normal page (browser bars visible).
//
// The preference is local to this device (localStorage), never synced. On
// browsers without the Fullscreen API (e.g. iOS Safari) or when already running
// as an installed PWA (standalone), the request is a no-op — the toggle still
// remembers the choice.

import { registerVersion } from "../version.js";
registerVersion("js/ui/fullscreen.js", 1);

const KEY = "siano:fullscreen";
const root = document.documentElement;

let pref = false;
try {
  pref = localStorage.getItem(KEY) === "1";
} catch {
  /* private mode — default off */
}

const supported = () => typeof root.requestFullscreen === "function";

function isStandalone() {
  try {
    return (
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  } catch {
    return false;
  }
}

function enter() {
  if (!supported() || isStandalone() || document.fullscreenElement) return;
  root.requestFullscreen().catch(() => {});
}

function leave() {
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

// Re-enter on any gesture while the preference is on. `document.fullscreenElement`
// makes enter() a no-op once we're already full-screen, so this only fires a
// real request when full-screen has been lost.
function onGesture() {
  if (pref) enter();
}

export function fullscreenPreferred() {
  return pref;
}

/** Flip the preference. Called from a click handler, so it counts as a gesture:
 *  turning it on enters full-screen immediately; turning it off leaves it. */
export function setFullscreenPreferred(on) {
  pref = !!on;
  try {
    localStorage.setItem(KEY, pref ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (pref) enter();
  else leave();
}

/** Wire the gesture listeners once, at boot. Bubble phase, so a control's own
 *  click handler (e.g. the toggle) runs first and sets the preference before we
 *  read it here. */
export function installFullscreen() {
  document.addEventListener("click", onGesture, { passive: true });
  document.addEventListener("touchend", onGesture, { passive: true });
  document.addEventListener("keydown", (e) => {
    // Escape is how the browser LEAVES full-screen; don't fight it on that key.
    if (e.key !== "Escape") onGesture();
  });
}
