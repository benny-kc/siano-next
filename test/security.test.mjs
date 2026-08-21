// Security-hardening tests for the hub: durable-log caps, oversized-message
// rejection, Origin allowlisting, trip-id validation, per-connection rate
// limiting, and security headers. Each test runs its own hub on an ephemeral
// port with a throwaway data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createHub } from "../hub/server.js";
import { TripLogs } from "../hub/log.js";
import { Clock } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "siano-sec-"));
}
async function startHub(t, opts) {
  const dataDir = tmpDir();
  const hub = createHub({ dataDir, ...opts });
  const port = await new Promise((r) => hub.httpServer.listen(0, "127.0.0.1", () => r(hub.httpServer.address().port)));
  t.after(async () => {
    await hub.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { hub, port, dataDir };
}
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e.error || new Error("ws error"));
  });
}
function waitClose(ws) {
  return new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
}
function tryUpgrade(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/", method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ upgraded: true, status: res.statusCode }); });
    req.on("response", (res) => { res.resume(); resolve({ upgraded: false, status: res.statusCode }); });
    req.on("error", () => resolve({ upgraded: false, status: 0 }));
    req.end();
  });
}

test("TripLogs enforces per-trip op cap and global trip cap", async () => {
  const dir = tmpDir();
  try {
    const logs = new TripLogs(path.join(dir, "logs"), { maxOpsPerTrip: 1, maxTrips: 1 });
    const A = new Clock("A");
    assert.equal(await logs.append("t1", ops.setTripName(A, "one")), true);
    // second op on same trip is refused by the op cap
    assert.equal(await logs.append("t1", ops.addMember(A, "m", {})), false);
    // a brand-new trip is refused by the trip cap
    assert.equal(await logs.append("t2", ops.setTripName(A, "two")), false);
    await logs.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized WebSocket message closes the connection (1009)", async (t) => {
  const { port } = await startHub(t, { maxMessageBytes: 1024 });
  const ws = await open(`ws://127.0.0.1:${port}`);
  const closed = waitClose(ws);
  ws.send("x".repeat(4096)); // > maxMessageBytes
  const code = await closed;
  assert.equal(code, 1009);
});

test("Origin allowlist rejects unexpected/missing origins at upgrade", async (t) => {
  const { port } = await startHub(t, { allowedOrigins: "https://good.example" });
  assert.deepEqual(await tryUpgrade(port, { Origin: "https://good.example" }), { upgraded: true, status: 101 });
  assert.equal((await tryUpgrade(port, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await tryUpgrade(port, {})).status, 403); // no Origin
});

test("invalid trip ids are rejected (1008)", async (t) => {
  const { port } = await startHub(t);
  for (const bad of ["../etc/passwd", "has space", "x".repeat(200)]) {
    const ws = await open(`ws://127.0.0.1:${port}`);
    const closed = waitClose(ws);
    ws.send(JSON.stringify({ t: "hello", trip: bad, have: [] }));
    assert.equal(await closed, 1008, `trip "${bad.slice(0, 12)}…" should be rejected`);
  }
});

test("per-connection rate limit closes a flooding client (1008)", async (t) => {
  const { port } = await startHub(t, { maxMsgsPerSec: 3 });
  const ws = await open(`ws://127.0.0.1:${port}`);
  const closed = waitClose(ws);
  const A = new Clock("A");
  ws.send(JSON.stringify({ t: "hello", trip: "trip-rl", have: [] })); // msg 1
  for (let i = 0; i < 6; i++) ws.send(JSON.stringify({ t: "op", op: ops.addMeal(A, "m" + i, {}) }));
  assert.equal(await closed, 1008);
});

test("static responses carry security headers", async (t) => {
  const { port } = await startHub(t);
  const res = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/" }, (r) => { r.resume(); resolve(r); }));
  assert.match(res.headers["content-security-policy"] || "", /default-src 'self'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
});

test("index.html has no inline <script> that the tight CSP would refuse", async (t) => {
  // Regression: the CSP is `script-src 'self'` with NO 'unsafe-inline' and NO
  // hash, so ANY inline <script> body is silently refused by the browser. The
  // service-worker registration used to live inline in <head> and was blocked —
  // the SW never installed and the PWA (Android + iOS) had no offline shell.
  // Every <script> must therefore be external (`src=…`) or empty. If a hash or
  // nonce is ever added to script-src, relax this to allow inline again.
  const { port } = await startHub(t);
  const body = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port, path: "/" }, (r) => {
      let b = ""; r.setEncoding("utf8"); r.on("data", (c) => (b += c)); r.on("end", () => resolve(b));
    }));

  // Strip HTML comments first — prose in a comment may mention "<script>".
  const html = body.replace(/<!--[\s\S]*?-->/g, "");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "index.html should have at least one <script> tag");
  for (const [, attrs, inner] of scripts) {
    const hasSrc = /\bsrc\s*=/.test(attrs);
    const hasBody = inner.trim() !== "";
    assert.ok(
      hasSrc || !hasBody,
      `inline <script> body found (\"${inner.trim().slice(0, 40)}…\") — CSP script-src 'self' will refuse it; move it to an external same-origin file`,
    );
  }
});

test("static responses are revalidated (no-cache + ETag), so a CDN never pins a stale shell", async (t) => {
  const { port } = await startHub(t);
  const head = (path, headers = {}) =>
    new Promise((resolve) => http.get({ host: "127.0.0.1", port, path, headers }, (r) => { r.resume(); resolve(r); }));

  // The shell + assets must be revalidated every load (unhashed filenames behind
  // a CDN like Cloudflare, which honours these): browser AND CDN scope.
  for (const p of ["/", "/index.html", "/js/app.js", "/service-worker.js", "/css/app.css"]) {
    const r = await head(p);
    assert.equal(r.headers["cache-control"], "no-cache", `${p} must be no-cache`);
    assert.equal(r.headers["cdn-cache-control"], "no-cache", `${p} must be no-cache for the CDN`);
    assert.ok(r.headers["etag"], `${p} must carry an ETag`);
  }

  // A conditional GET with the current ETag revalidates cheaply as a 304.
  const first = await head("/service-worker.js");
  const again = await head("/service-worker.js", { "If-None-Match": first.headers["etag"] });
  assert.equal(again.statusCode, 304);

  // The operator debug flag must never be cached at all.
  const env = await head("/env.js");
  assert.equal(env.headers["cache-control"], "no-store");
});

test("static cache policy is configurable, but the service worker stays no-cache", async (t) => {
  // Production-style: cache assets aggressively at the edge…
  const { port } = await startHub(t, { cacheControl: "public, max-age=31536000, immutable" });
  const head = (path) =>
    new Promise((resolve) => http.get({ host: "127.0.0.1", port, path }, (r) => { r.resume(); resolve(r); }));

  const asset = await head("/js/app.js");
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(asset.headers["cdn-cache-control"], "public, max-age=31536000, immutable");

  // …but the service worker must NOT inherit that — a cached SW never updates,
  // so its cache-first shell would serve the old UI forever.
  const sw = await head("/service-worker.js");
  assert.equal(sw.headers["cache-control"], "no-cache", "the service worker must stay no-cache");
});

test("an empty cache-control config omits the header (CDN falls back to its defaults)", async (t) => {
  const { port } = await startHub(t, { cacheControl: "", cdnCacheControl: "" });
  const res = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port, path: "/css/app.css" }, (r) => { r.resume(); resolve(r); }));
  assert.equal(res.headers["cache-control"], undefined);
  assert.equal(res.headers["cdn-cache-control"], undefined);
  assert.ok(res.headers["etag"], "an ETag is still sent so conditional GETs work");
});

test("asset hashing serves fingerprinted, immutable URLs and rewrites the import graph", async (t) => {
  const { port } = await startHub(t, { assetHashing: true });
  const get = (path) =>
    new Promise((resolve) => http.get({ host: "127.0.0.1", port, path }, (r) => {
      let body = ""; r.setEncoding("utf8"); r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ res: r, body }));
    }));

  // The shell is served no-cache and points at hashed asset URLs (not the plain
  // /js/app.js), so a returning browser always resolves the current bundle.
  const home = await get("/");
  assert.equal(home.res.headers["cache-control"], "no-cache");
  const m = home.body.match(/\/js\/app\.[0-9a-f]{6,}\.js/);
  assert.ok(m, "index.html must reference a content-hashed app.js");
  assert.doesNotMatch(home.body, /["']\/js\/app\.js["']/, "no un-hashed app.js reference remains");

  // The hashed module is immutable (cache forever, never purge) and its own
  // relative imports were rewritten to hashed names — so the whole graph loads.
  const app = await get(m[0]);
  assert.equal(app.res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.match(app.body, /from ["']\.\/ui\/board\.[0-9a-f]{6,}\.js["']/, "imports must be rewritten to hashed URLs");

  // A trip deep-link also serves the shell.
  const trip = await get("/t/abc123");
  assert.match(trip.body, /\/js\/app\.[0-9a-f]{6,}\.js/);
});

test("non-GET methods are rejected (405)", async (t) => {
  const { port } = await startHub(t);
  const status = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST" }, (r) => { r.resume(); resolve(r.statusCode); });
    req.end();
  });
  assert.equal(status, 405);
});
