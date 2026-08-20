// The Siano sync hub: a dumb, durable relay + static file server.
//
// Run it with nothing but `node hub/server.js`. It:
//   1. serves the static client from ../client (so one process is the whole app), and
//   2. relays ops between devices on the same trip over WebSocket, persisting
//      every op to a durable append-only log (see log.js).
//
// There is deliberately NO business logic here — the hub cannot compute a
// balance and doesn't try to. Two hubs behind one shared log directory would be
// active-active; a single one is plenty for a trip splitter.
//
// Hardening (it sits behind a Cloudflare Tunnel, but abusive traffic still
// reaches it through the tunnel — see docs/security.md):
//   - binds to 127.0.0.1 by default (only cloudflared should reach it);
//   - bounded WebSocket messages + connection cap + heartbeat reaper (ws.js);
//   - per-connection message rate limiting;
//   - security headers + method + path-traversal checks on static responses;
//   - async, non-blocking op persistence with per-trip disk caps (log.js);
//   - graceful shutdown that flushes pending writes.
//
// Env (all optional): HOST, PORT, SIANO_DATA_DIR, SIANO_MAX_MSG_BYTES,
//   SIANO_MAX_CONNECTIONS, SIANO_MAX_MSGS_PER_SEC, SIANO_ALLOWED_ORIGINS,
//   SIANO_MAX_OPS_PER_TRIP, SIANO_MAX_TRIPS, SIANO_HEARTBEAT_MS, SIANO_TRIP_ID_MAX.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "./ws.js";
import { TripLogs, isValidOp } from "./log.js";
import { buildAssets } from "./assets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, "../client");

const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

// ---- Logging ---------------------------------------------------------------
// Concise, always-on operational logs; verbose per-request/per-op logs behind
// SIANO_DEBUG=1. Op payloads are NEVER fully dumped (they carry trip data) —
// only the op type + ids + lamport, so logs stay privacy-safe.
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.SIANO_DEBUG || "");
const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), "WARN", ...a);
const debug = DEBUG ? (...a) => console.log(ts(), "DEBUG", ...a) : () => {};
const opBrief = (op) =>
  `${op.op}${op.mealId ? " meal=" + op.mealId : ""}${op.memberId ? " member=" + op.memberId : ""} @${op.lamport}.${op.device}`;
const clientIp = (req) => req.headers["cf-connecting-ip"] || req.socket?.remoteAddress || "?";

// ---- Static client ---------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// A tight CSP for a fully self-contained app: only same-origin scripts/styles,
// WebSocket back to the same origin, and inline styles (the board sets element
// style attributes). No third-party anything.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(self)");
}

// Caching policy for static responses — env-controlled.
//
// The client is a buildless app: filenames are NOT content-hashed, so a deploy
// reuses the same URLs (`/js/app.js`, `/css/app.css`, `/index.html`,
// `/service-worker.js`). With no cache headers at all, a CDN in front — this hub
// is meant to sit behind a Cloudflare Tunnel — edge-caches `.js`/`.css` by
// extension and can pin the service worker, so a browser keeps being handed the
// OLD bundle / OLD service worker and never sees a new release. That is the
// "old interface is still served" symptom.
//
// The headers are configurable so you can pick the policy per environment:
//
//   • SIANO_CACHE_CONTROL      Cache-Control for static assets + the HTML shell.
//                              Default "no-cache" (store but always revalidate —
//                              ideal for development: a Cloudflare "Purge
//                              Everything" always suffices and every deploy shows
//                              up at once). For production set your caching
//                              policy, e.g. "public, max-age=300" or
//                              "public, max-age=31536000, immutable", to let
//                              Cloudflare serve from its edge.
//   • SIANO_CDN_CACHE_CONTROL  CDN-Cache-Control (the CDN-scoped directive
//                              Cloudflare and others honour independently of the
//                              browser's Cache-Control). Defaults to the same
//                              value as SIANO_CACHE_CONTROL. Set it to cache at
//                              the edge while telling browsers something else.
//   • SIANO_SW_CACHE_CONTROL   Cache-Control (and CDN-Cache-Control) for
//                              /service-worker.js ONLY. Default "no-cache", and
//                              you almost never want anything else: a cached
//                              service worker never updates, so its cache-first
//                              shell would serve the old UI forever regardless of
//                              how the other assets are cached. Its own knob so
//                              you can cache everything else aggressively in
//                              production while the SW stays fresh.
//
// An EMPTY value (e.g. `SIANO_CACHE_CONTROL=`) omits that header entirely, so
// Cloudflare falls back to its own extension-based default caching.
//
// A strong `ETag` (a hash of the bytes) is always sent and conditional GETs are
// answered with 304 in every mode, so `no-cache` revalidation is a tiny empty
// round-trip and even a `max-age` asset revalidates cheaply once it goes stale.
// `/env.js` is always `no-store` (it carries the live debug flag).
// `SIANO_ASSET_HASHING=1` turns on content-hashed asset URLs (see assets.js):
// the JS/CSS/manifest are served at fingerprinted URLs that change when their
// bytes do, so they can be cached FOREVER and a new release is picked up with no
// purge. That flips the sensible defaults below — fingerprinted assets default
// to `immutable`, while a stable-URL asset (hashing off) defaults to `no-cache`.
// The HTML shell and the service worker stay the small `no-cache` bootstrap
// layer either way. Any explicit env value still overrides the default.
function resolveCacheConfig(opts = {}, hashing = false) {
  // undefined (unset) → the default; an explicit value (including "") wins.
  const pick = (optVal, envKey, dflt) => {
    if (optVal !== undefined) return optVal;
    const e = process.env[envKey];
    return e === undefined ? dflt : e;
  };
  const assetDefault = hashing ? "public, max-age=31536000, immutable" : "no-cache";
  const asset = pick(opts.cacheControl, "SIANO_CACHE_CONTROL", assetDefault);
  const cdn = pick(opts.cdnCacheControl, "SIANO_CDN_CACHE_CONTROL", asset);
  const sw = pick(opts.swCacheControl, "SIANO_SW_CACHE_CONTROL", "no-cache");
  // The HTML shell must revalidate when hashing is on (it names the current
  // hashed asset URLs); without hashing it follows the asset policy, as before.
  const entry = hashing ? "no-cache" : asset;
  const entryCdn = hashing ? "no-cache" : cdn;
  // Unhashed originals still reachable via the disk fallback while hashing is on
  // have stable URLs, so they must never be cached; without hashing they simply
  // are the assets.
  const disk = hashing ? "no-cache" : asset;
  const diskCdn = hashing ? "no-cache" : cdn;
  return {
    hashing,
    raw: { asset, cdn, sw },
    policy: {
      asset: { cc: asset, cdn },
      sw: { cc: sw, cdn: sw },
      entry: { cc: entry, cdn: entryCdn },
      disk: { cc: disk, cdn: diskCdn },
    },
  };
}

// Apply the resolved policy for a tag ("asset" | "sw" | "entry" | "disk").
// Empty strings omit the header (CDN falls back to its own defaults).
function setCacheHeaders(res, cfg, tag, etag) {
  const p = cfg.policy[tag] || cfg.policy.disk;
  if (p.cc) res.setHeader("Cache-Control", p.cc);
  if (p.cdn) res.setHeader("CDN-Cache-Control", p.cdn);
  if (etag) res.setHeader("ETag", etag);
}

const etagOf = (data) => `"${createHash("sha1").update(data).digest("base64")}"`;

// Serve one buffer with the right cache tag + conditional-GET (304) support.
function sendBuffer(req, res, cfg, tag, servedPath, buf) {
  const etag = etagOf(buf);
  setCacheHeaders(res, cfg, tag, etag);
  if (req.headers["if-none-match"] === etag) { res.writeHead(304).end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(servedPath)] || "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : buf);
}

// Build the static-file handler bound to a resolved cache config and, when asset
// hashing is enabled, the in-memory fingerprinted assets (else `null`).
function makeServeStatic(cfg, assets) {
  return function serveStatic(req, res) {
    setSecurityHeaders(res);

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD" }).end("method not allowed");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    debug(`http ${req.method} ${url.pathname} from ${clientIp(req)}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    // Operator-controlled client debug flag. Never cached, so flipping
    // SIANO_CLIENT_DEBUG and restarting the hub takes effect on the next load.
    if (url.pathname === "/env.js") {
      const on = /^(1|true|yes|on)$/i.test(process.env.SIANO_CLIENT_DEBUG || "");
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "cdn-cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : `window.__SIANO_DEBUG__=${on};`);
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    // A trip deep-link (/t/<id>) is a client route — serve the app shell.
    if (rel.startsWith("/t/")) rel = "/index.html";

    // Fingerprinted serving (in memory): the rewritten shell + service worker
    // (stable URLs, no-cache) and the content-hashed assets (immutable). Anything
    // else drops through to the disk server below.
    if (assets) {
      if (rel === "/index.html") return sendBuffer(req, res, cfg, "entry", rel, assets.entry);
      if (rel === "/service-worker.js" && assets.sw) return sendBuffer(req, res, cfg, "sw", rel, assets.sw);
      const hashed = assets.hashedContent.get(rel);
      if (hashed) return sendBuffer(req, res, cfg, "asset", rel, hashed);
    }

    const full = path.join(CLIENT_DIR, path.normalize(rel));
    // Must resolve to a file strictly inside CLIENT_DIR (the trailing separator
    // check stops a sibling like `<dir>-evil` from matching startsWith).
    if (full !== CLIENT_DIR && !full.startsWith(CLIENT_DIR + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      // index.html / SW keep their own policy; other disk hits are the assets
      // (hashing off) or unhashed originals nothing references (hashing on).
      const tag = rel === "/service-worker.js" ? "sw"
        : rel === "/index.html" ? "entry"
        : assets ? "disk" : "asset";
      sendBuffer(req, res, cfg, tag, full, data);
    });
  };
}

// ---- Validation & rate limiting --------------------------------------------

function tripIdValidator(maxLen) {
  const re = new RegExp(`^[A-Za-z0-9._~-]{1,${maxLen}}$`);
  return (id) => typeof id === "string" && re.test(id);
}

// Fixed-window per-connection message rate limiter.
function rateLimiter(maxPerSec) {
  return (conn) => {
    const now = Date.now();
    if (!conn._rl || now >= conn._rl.reset) conn._rl = { count: 0, reset: now + 1000 };
    conn._rl.count += 1;
    return conn._rl.count <= maxPerSec;
  };
}

// ---- Hub factory -----------------------------------------------------------

/**
 * Build a hub. Returns the http.Server (call `.listen()` yourself) plus the
 * TripLogs and a `shutdown()`, so tests and callers can manage lifecycle.
 * @param {{dataDir?: string} & Record<string, any>} [opts]
 */
export function createHub(opts = {}) {
  const dataDir = opts.dataDir || process.env.SIANO_DATA_DIR ||
    path.resolve(__dirname, "../siano_data");

  const maxMessageBytes = opts.maxMessageBytes ?? num(process.env.SIANO_MAX_MSG_BYTES, 256 * 1024);
  const maxConnections = opts.maxConnections ?? num(process.env.SIANO_MAX_CONNECTIONS, 500);
  const maxMsgsPerSec = opts.maxMsgsPerSec ?? num(process.env.SIANO_MAX_MSGS_PER_SEC, 50);
  const heartbeatMs = opts.heartbeatMs ?? num(process.env.SIANO_HEARTBEAT_MS, 30000);
  const tripIdMax = opts.tripIdMax ?? num(process.env.SIANO_TRIP_ID_MAX, 128);
  const originsEnv = opts.allowedOrigins ?? process.env.SIANO_ALLOWED_ORIGINS;
  const allowedOrigins = originsEnv
    ? new Set(String(originsEnv).split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const logs = new TripLogs(path.join(dataDir, "logs"), {
    maxOpsPerTrip: opts.maxOpsPerTrip ?? num(process.env.SIANO_MAX_OPS_PER_TRIP, 0),
    maxTrips: opts.maxTrips ?? num(process.env.SIANO_MAX_TRIPS, 0),
  });

  const isValidTripId = tripIdValidator(tripIdMax);
  const allow = rateLimiter(maxMsgsPerSec);

  // Optional content-hashed asset URLs (see assets.js). Built once at startup;
  // if the client can't be fingerprinted (e.g. an import cycle), fall back to
  // serving unhashed files rather than failing to start.
  const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v));
  const wantHashing = opts.assetHashing !== undefined
    ? !!opts.assetHashing
    : (process.env.SIANO_ASSET_HASHING !== undefined && truthy(process.env.SIANO_ASSET_HASHING));
  let assets = null;
  if (wantHashing) {
    try {
      assets = buildAssets(CLIENT_DIR);
    } catch (e) {
      warn(`asset hashing disabled — serving unhashed files: ${e.message}`);
    }
  }
  const cacheCfg = resolveCacheConfig(opts, !!assets);
  const httpServer = http.createServer(makeServeStatic(cacheCfg, assets));
  // Slowloris / stuck-request guards (belt-and-braces behind Cloudflare).
  httpServer.headersTimeout = 15000;
  httpServer.requestTimeout = 30000;
  httpServer.keepAliveTimeout = 20000;
  httpServer.maxConnections = maxConnections;

  const rooms = new Map(); // trip -> Set<Conn>
  const join = (trip, conn) => {
    if (!rooms.has(trip)) rooms.set(trip, new Set());
    rooms.get(trip).add(conn);
  };
  const leave = (conn) => {
    const room = conn.trip && rooms.get(conn.trip);
    if (!room) return;
    room.delete(conn);
    if (room.size === 0) rooms.delete(conn.trip);
  };
  const fanout = (trip, obj, except) => {
    const room = rooms.get(trip);
    if (!room) return;
    const str = JSON.stringify(obj);
    for (const c of room) if (c !== except) c.send(str);
  };

  const wss = new WebSocketServer(httpServer, { maxMessageBytes, maxConnections, allowedOrigins });

  // Log every refused upgrade — this is where "why can't anyone connect?"
  // usually gets answered (Origin allowlist, connection cap, bad request).
  wss.on("reject", ({ status, reason, detail, origin }) => {
    warn(`ws upgrade rejected ${status} ${reason}${detail ? " — " + detail : ""}${origin ? " (origin " + origin + ")" : ""}`);
  });

  wss.on("connection", (conn, req) => {
    conn.ip = clientIp(req);
    debug(`ws open from ${conn.ip} (origin ${req.headers.origin || "none"}); ${wss.connections.size} live`);

    conn.on("message", async (data) => {
      if (!allow(conn)) {
        warn(`ws rate limit hit (${maxMsgsPerSec}/s) trip=${conn.trip || "?"} ip=${conn.ip} — closing 1008`);
        conn.close(1008); // policy violation — too chatty
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        debug(`ws bad JSON (${data.length} bytes) from ${conn.ip} — ignored`);
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.t === "hello") {
        if (!isValidTripId(msg.trip)) {
          warn(`ws invalid trip id from ${conn.ip}: ${JSON.stringify(msg.trip)?.slice(0, 40)} — closing 1008`);
          conn.close(1008);
          return;
        }
        conn.trip = msg.trip;
        join(msg.trip, conn);
        const delta = logs.missing(msg.trip, msg.have);
        // The other direction: op-ids the leaf says it has that we don't. These
        // are ops it created while offline (they only ever hit its IndexedDB);
        // ask it to push them so they reach the durable log + the other leaves.
        // Without this, a device that made bills offline stays the only copy of
        // them — the reported "one phone has 8 bills, the other only 4" bug.
        const want = logs.wanted(msg.trip, msg.have);
        debug(`ws hello trip=${msg.trip} have=${Array.isArray(msg.have) ? msg.have.length : 0} -> sync ${delta.length} ops, want ${want.length}`);
        // Hand the newcomer everything it's missing (delta on reconnect) and ask
        // for anything we're missing from it (its offline-made ops).
        conn.send(JSON.stringify({ t: "sync", ops: delta, want }));
        return;
      }

      if (!conn.trip) {
        debug(`ws message ${msg.t} before hello from ${conn.ip} — ignored`);
        return; // must say hello first
      }

      if (msg.t === "op" && isValidOp(msg.op)) {
        if (await logs.append(conn.trip, msg.op)) {
          debug(`ws op trip=${conn.trip} ${opBrief(msg.op)} -> fanout`);
          fanout(conn.trip, { t: "op", op: msg.op }, conn);
        } else {
          debug(`ws op trip=${conn.trip} ${opBrief(msg.op)} -> dup/capped (no fanout)`);
        }
      } else if (msg.t === "ops" && Array.isArray(msg.ops)) {
        const added = [];
        for (const op of msg.ops) {
          if (isValidOp(op) && (await logs.append(conn.trip, op))) added.push(op);
        }
        debug(`ws ops trip=${conn.trip} received=${msg.ops.length} new=${added.length}`);
        if (added.length) fanout(conn.trip, { t: "ops", ops: added }, conn);
      } else {
        debug(`ws unknown message t=${msg.t} trip=${conn.trip} — ignored`);
      }
    });

    conn.on("close", () => {
      leave(conn);
      debug(`ws close trip=${conn.trip || "?"} ip=${conn.ip}; ${wss.connections.size} live`);
    });
  });

  // Surface low-level HTTP client errors (malformed requests, early hangups)
  // instead of Node swallowing them.
  httpServer.on("clientError", (err, socket) => {
    debug(`http clientError: ${err.code || err.message}`);
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } catch {
      /* already gone */
    }
  });

  // Heartbeat: ping every connection each interval; reap any that missed the
  // previous pong (dead or wedged peers otherwise leak sockets/memory forever).
  const heartbeat = setInterval(() => {
    for (const conn of wss.connections) {
      if (conn.isAlive === false) {
        conn.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    wss.closeAll(1001);
    await new Promise((resolve) => httpServer.close(resolve));
    await logs.flush();
  }

  return { httpServer, wss, logs, dataDir, cacheCfg, assets, shutdown };
}

// Auto-start only when run directly (`node hub/server.js`), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const HOST = process.env.HOST || "127.0.0.1";
  const PORT = num(process.env.PORT, 4000);
  const hub = createHub();
  hub.httpServer.listen(PORT, HOST, () => {
    log(`siano hub listening on http://${HOST}:${PORT}`);
    log(`  client dir : ${CLIENT_DIR}`);
    log(`  op logs    : ${path.join(hub.dataDir, "logs")}`);
    log(`  limits     : msg=${num(process.env.SIANO_MAX_MSG_BYTES, 256 * 1024)}B` +
      ` conns=${num(process.env.SIANO_MAX_CONNECTIONS, 500)}` +
      ` rate=${num(process.env.SIANO_MAX_MSGS_PER_SEC, 50)}/s` +
      ` ops/trip=${num(process.env.SIANO_MAX_OPS_PER_TRIP, 0) || "∞"}` +
      ` trips=${num(process.env.SIANO_MAX_TRIPS, 0) || "∞"}`);
    log(`  origins    : ${process.env.SIANO_ALLOWED_ORIGINS || "(any — allowlist off)"}`);
    const cc = hub.cacheCfg.raw;
    const show = (v) => (v === "" ? "(omitted)" : v);
    log(`  asset hashing: ${hub.assets ? `on (${hub.assets.count} fingerprinted — cache immutable, no purge needed)` : "off (set SIANO_ASSET_HASHING=1)"}`);
    log(`  static cache: assets="${show(cc.asset)}" cdn="${show(cc.cdn)}" sw="${show(cc.sw)}"` +
      `${!hub.assets && cc.asset === "no-cache" ? " (dev default — revalidate always)" : ""}`);
    log(`  debug logs : ${DEBUG ? "on" : "off (set SIANO_DEBUG=1 for per-request/op logs)"}`);
    if (HOST === "127.0.0.1" || HOST === "localhost") {
      // The bind default changed to loopback during hardening. If cloudflared
      // (or any proxy) reaches this over a network — a separate container, a
      // different host, a non-host Docker network — loopback refuses it and the
      // app "stops working" with a 502 at the edge. Make that impossible to miss.
      log("  ⚠ bound to LOOPBACK only. If your tunnel/proxy connects over a network");
      log("    (e.g. cloudflared in another container), set HOST=0.0.0.0 and keep");
      log("    the port private via the tunnel + firewall.");
    } else {
      warn("bound to a non-loopback address — make sure only your tunnel/proxy can reach this port.");
    }
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`\n${sig} received — shutting down…`);
      hub.shutdown().then(() => process.exit(0));
    });
  }
}
