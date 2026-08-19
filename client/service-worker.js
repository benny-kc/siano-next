// Minimal offline shell cache. The app's DATA lives in IndexedDB (the op-log),
// so the service worker only needs to make the static shell available offline.
// Strategy: cache-first for our own GET assets, falling back to the network and
// caching what it fetches. WebSocket sync traffic is untouched.

const CACHE = "siano-shell-v4";
const SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/manifest.webmanifest",
  "/js/app.js",
  "/js/log.js",
  "/js/core/money.js",
  "/js/core/split.js",
  "/js/core/budgets.js",
  "/js/core/snapshot.js",
  "/js/core/lamport.js",
  "/js/core/ops.js",
  "/js/core/reducer.js",
  "/js/store/idb.js",
  "/js/store/oplog.js",
  "/js/sync/client.js",
  "/js/ui/board.js",
  "/js/ui/boardview.js",
  "/js/ui/viewstate.js",
  "/js/ui/selection.js",
  "/js/ui/interactions.js",
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
  if (url.pathname === "/env.js") return; // operator debug flag — always live, never cached

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
