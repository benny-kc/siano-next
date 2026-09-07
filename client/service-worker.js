// Minimal offline shell cache. The app's DATA lives in IndexedDB (the op-log),
// so the service worker only needs to make the static shell available offline.
// Strategy: cache-first for our own GET assets, falling back to the network and
// caching what it fetches. WebSocket sync traffic is untouched.

const CACHE = "siano-shell-v32";

// The operator debug flag (/env.js) must stay live (never cached) when online,
// but it is a render-blocking classic <script> in index.html — so if it ever
// touches a dead/slow network the whole app boot freezes behind it (the reason
// an offline device used to sit on "0 bills" for ~10-20s before the local DB
// rendered). Race the network against a short timeout and fall back to a safe
// default so an offline / poor-coverage device boots instantly. Never cached.
const ENV_TIMEOUT_MS = 1500;
const ENV_FALLBACK = "window.__SIANO_DEBUG__=false;";
function envJs(req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENV_TIMEOUT_MS);
  return fetch(req, { cache: "no-store", signal: ctrl.signal })
    .then((res) => (res && res.ok ? res : Promise.reject()))
    .catch(() => new Response(ENV_FALLBACK, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    }))
    .finally(() => clearTimeout(timer));
}
const SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/sw-register.js",
  "/js/app.js",
  "/js/log.js",
  "/js/version.js",
  "/js/core/money.js",
  "/js/core/split.js",
  "/js/core/budgets.js",
  "/js/core/snapshot.js",
  "/js/core/lamport.js",
  "/js/core/ops.js",
  "/js/core/reducer.js",
  "/js/store/idb.js",
  "/js/store/oplog.js",
  "/js/store/trips.js",
  "/js/sync/client.js",
  "/js/ui/board.js",
  "/js/ui/boardview.js",
  "/js/ui/viewstate.js",
  "/js/ui/selection.js",
  "/js/ui/interactions.js",
  "/js/ui/typography.js",
  "/js/ui/fullscreen.js",
  "/js/ui/install.js",
  "/js/ui/onboarding.js",
  "/js/ui/debug.js",
  "/js/vendor/qrcode.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin
  // Operator debug flag: network-first (stays live, never cached) but with an
  // instant offline fallback so it can never stall the boot. See envJs() above.
  if (url.pathname === "/env.js") { e.respondWith(envJs(req)); return; }

  // A trip deep-link (/t/<id>) always resolves to the app shell.
  if (url.pathname.startsWith("/t/")) {
    e.respondWith(caches.match("/index.html").then((r) => r || fetch("/index.html")));
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached)),
  );
});
