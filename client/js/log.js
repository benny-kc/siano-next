// Tiny client logger for troubleshooting.
//
// Verbose logs are OFF by default (no console spam for normal users) and turn ON
// via `?debug` in the URL (sticky — remembered in localStorage) or by setting
// localStorage `siano:debug` to "1". Warnings and errors ALWAYS print, because
// the things that make the app "stop working" (a WebSocket that won't open, a
// render that throws) must never be silent.
//
// Toggle from the console:  siano.debug(true)  /  siano.debug(false)

function readFlag() {
  try {
    if (/[?&]debug\b/.test(location.search)) {
      localStorage.setItem("siano:debug", "1");
      return true;
    }
    return localStorage.getItem("siano:debug") === "1";
  } catch {
    return false;
  }
}

export let DEBUG = readFlag();

const stamp = () => new Date().toISOString().slice(11, 23);

export const dlog = (...a) => {
  if (DEBUG) console.log(`[siano ${stamp()}]`, ...a);
};
export const dwarn = (...a) => console.warn(`[siano ${stamp()}]`, ...a);
export const derror = (...a) => console.error(`[siano ${stamp()}]`, ...a);

// Expose a runtime toggle so a user can turn logging on/off from the console
// without editing anything.
if (typeof window !== "undefined") {
  window.siano = window.siano || {};
  window.siano.debug = (on = true) => {
    DEBUG = !!on;
    try {
      localStorage.setItem("siano:debug", on ? "1" : "0");
    } catch {
      /* private mode */
    }
    console.log(`[siano] debug logging ${on ? "ON" : "OFF"}`);
    return DEBUG;
  };
}
