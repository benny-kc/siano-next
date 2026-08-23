// Client logging — OPERATOR-controlled, not user-controlled.
//
// Verbose logs are gated by `window.__SIANO_DEBUG__`, which the hub sets from
// the SIANO_CLIENT_DEBUG environment variable (served as /env.js). This mirrors
// SIANO_DEBUG on the hub: the operator turns client logging on to troubleshoot,
// and a normal user has no way to enable it and never sees it. There is
// deliberately no `?debug` switch and no runtime toggle.
//
// Errors always print — they surface only in devtools, never to the user, and
// swallowing a genuine fault would defeat the point of having logs at all.

import { registerVersion } from "./version.js";
registerVersion("js/log.js", 1);

export const DEBUG = typeof window !== "undefined" && window.__SIANO_DEBUG__ === true;

const stamp = () => new Date().toISOString().slice(11, 23);

export const dlog = DEBUG ? (...a) => console.log(`[siano ${stamp()}]`, ...a) : () => {};
export const dwarn = DEBUG ? (...a) => console.warn(`[siano ${stamp()}]`, ...a) : () => {};
export const derror = (...a) => console.error(`[siano ${stamp()}]`, ...a);
