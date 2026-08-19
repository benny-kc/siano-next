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

test("non-GET methods are rejected (405)", async (t) => {
  const { port } = await startHub(t);
  const status = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST" }, (r) => { r.resume(); resolve(r.statusCode); });
    req.end();
  });
  assert.equal(status, 405);
});
