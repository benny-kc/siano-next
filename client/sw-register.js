// Service-worker registration, kept as a SEPARATE same-origin file (not an
// inline <script>) on purpose: the app's CSP is `script-src 'self'` with no
// 'unsafe-inline' and no hash, so an inline registration block was silently
// REFUSED by the browser — the service worker never installed, the offline
// shell was never cached, and the installed PWA (Android *and* iOS "Add to
// Home Screen") had no offline support at all. A real `.js` file is `'self'`,
// so it runs under the tight CSP unchanged.
//
// Loaded `async` from the <head> so it registers as early as possible without
// blocking first paint — the same "install even if the user bails out mid-load
// on a bad link" intent as before, so the NEXT visit is fully offline-capable.
// `updateViaCache:"none"` stops the browser HTTP cache from pinning the SW
// script; the one-time reload when a NEW worker takes control (guarded against
// the first install) swaps the page onto the fresh shell. The hub also serves
// the SW `no-cache` (see hub/server.js).
if ("serviceWorker" in navigator) {
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (reloading || !hadController) return; // first install -> no reload
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" }).catch(function () {});
}
