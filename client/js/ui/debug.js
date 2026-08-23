// Per-device "Debug" preference (localStorage `siano:debug`, default off).
//
// A purely client-side aid, toggled from the Settings drawer. When on, the
// Settings drawer lists each JS module's embedded version (see ../version.js)
// so you can confirm a device isn't serving a stale cached build. Local to this
// device, never synced. This is deliberately SEPARATE from the operator-only
// SIANO_CLIENT_DEBUG flag / window.__SIANO_DEBUG__ gating in js/log.js — that
// one stays not-user-switchable; this only controls the version readout.

import { registerVersion } from "../version.js";
registerVersion("js/ui/debug.js", 1);

const KEY = "siano:debug";

let on = false;
try {
  on = localStorage.getItem(KEY) === "1";
} catch {
  /* private mode / storage disabled — default off */
}

export function debugEnabled() {
  return on;
}

export function setDebugEnabled(value) {
  on = !!value;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* ignore — the flag is a convenience, not data */
  }
}
