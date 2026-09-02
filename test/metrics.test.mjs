// Tests for the token-gated Prometheus metrics endpoint (hub/metrics.js +
// GET /metrics in hub/server.js). Each test runs its own hub on an ephemeral
// port with a throwaway data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHub } from "../hub/server.js";
import { Clock } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "siano-metrics-"));
}
async function startHub(t, opts) {
  const dataDir = tmpDir();
  const hub = createHub({ dataDir, ...opts });
  const port = await new Promise((r) => hub.httpServer.listen(0, "127.0.0.1", () => r(hub.httpServer.address().port)));
  t.after(async () => {
    await hub.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { hub, port };
}
function get(port, path, headers = {}) {
  return new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port, path, headers }, (r) => {
      let body = ""; r.setEncoding("utf8"); r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body }));
    }));
}
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e.error || new Error("ws error"));
  });
}
function next(ws, predicate) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timed out")), 3000);
    ws.addEventListener("message", function handler(ev) {
      const msg = JSON.parse(ev.data);
      if (!predicate || predicate(msg)) {
        clearTimeout(to); ws.removeEventListener("message", handler); resolve(msg);
      }
    });
  });
}

test("/metrics is 404 (off) when no token is configured", async (t) => {
  const { port } = await startHub(t);
  const r = await get(port, "/metrics");
  assert.equal(r.status, 404, "unauthed hubs must not expose trip ids / volume");
});

test("/metrics requires a matching bearer token", async (t) => {
  const { port } = await startHub(t, { metricsToken: "s3cret" });
  assert.equal((await get(port, "/metrics")).status, 401, "no auth → 401");
  assert.equal((await get(port, "/metrics", { authorization: "Bearer wrong" })).status, 401, "wrong token → 401");
  const ok = await get(port, "/metrics", { authorization: "Bearer s3cret" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers["content-type"] || "", /text\/plain/);
  assert.equal(ok.headers["cache-control"], "no-store", "a scrape must never be cached");
  assert.match(ok.body, /^# HELP siano_up /m);
  assert.match(ok.body, /^siano_up 1$/m);
});

test("/metrics reports live connections and per-trip series", async (t) => {
  const { port } = await startHub(t, { metricsToken: "tok" });
  const A = new Clock("A");
  const trip = "trip-metrics";

  const ws = await open(`ws://127.0.0.1:${port}`);
  ws.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(ws, (m) => m.t === "sync");
  ws.send(JSON.stringify({ t: "op", op: ops.setTripName(A, "Rome") }));
  ws.send(JSON.stringify({ t: "op", op: ops.addMember(A, "m1", { name: "Ann" }) }));
  // Give the hub a tick to append + fan out.
  await new Promise((r) => setTimeout(r, 100));

  const r = await get(port, "/metrics", { authorization: "Bearer tok" });
  assert.equal(r.status, 200);
  // Global gauges/counters.
  assert.match(r.body, /^siano_ws_connections 1$/m);
  assert.match(r.body, /^siano_ops_appended_total 2$/m);
  // Per-trip series carry the trip label.
  assert.match(r.body, new RegExp(`^siano_trip_connections\\{trip="${trip}"\\} 1$`, "m"));
  assert.match(r.body, new RegExp(`^siano_trip_ops\\{trip="${trip}"\\} 2$`, "m"));
  assert.match(r.body, new RegExp(`^siano_trip_ops_appended_total\\{trip="${trip}"\\} 2$`, "m"));

  ws.close();
});

test("a duplicate op is counted as rejected, not appended", async (t) => {
  const { port } = await startHub(t, { metricsToken: "tok" });
  const A = new Clock("A");
  const trip = "trip-dup";
  const op = ops.setTripName(A, "Rome");

  const ws = await open(`ws://127.0.0.1:${port}`);
  ws.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(ws, (m) => m.t === "sync");
  ws.send(JSON.stringify({ t: "op", op }));
  ws.send(JSON.stringify({ t: "op", op })); // exact same op — a duplicate
  await new Promise((r) => setTimeout(r, 100));

  const r = await get(port, "/metrics", { authorization: "Bearer tok" });
  assert.match(r.body, /^siano_ops_appended_total 1$/m);
  assert.match(r.body, /^siano_ops_rejected_total 1$/m);
  ws.close();
});
