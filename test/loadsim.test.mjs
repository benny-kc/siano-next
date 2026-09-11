// The load simulator (ops/loadsim/loadsim.js) driven against a REAL in-process
// hub — proving it connects, drives valid ops through the durable-append +
// fan-out path, measures relay latency, and correctly reports the hub's
// Cloudflare-facing guards (the Origin allowlist). Short durations keep it fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHub } from "../hub/server.js";
import { runLoad } from "../ops/loadsim/loadsim.js";

function listen(httpServer) {
  return new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port)));
}

test("loadsim drives ops through the hub and measures relay latency", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "siano-loadsim-"));
  const hub = createHub({ dataDir });
  const port = await listen(hub.httpServer);
  t.after(async () => {
    await hub.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const stats = await runLoad({
    url: `ws://127.0.0.1:${port}`,
    trips: 3,
    devicesPerTrip: 2,
    rate: 20,
    durationMs: 600,
    drainMs: 300,
  });

  // Every connection opened cleanly (no Origin allowlist here).
  assert.equal(stats.connections.attempted, 6);
  assert.equal(stats.connections.opened, 6, "all leaf connections opened");
  assert.equal(stats.connections.failed, 0);

  // Ops flowed and were durably appended. Count from DISK (the source of truth),
  // not the in-memory cache: idle trips are evicted from memory once their last
  // device disconnects (the load sim drains connections at the end), so
  // opCounts() legitimately drops them — durability lives in the JSONL.
  assert.ok(stats.ops.emitted > 0, "emitted some ops");
  await hub.logs.flush();
  let onDisk = 0;
  for (const trip of hub.logs.trips()) onDisk += hub.logs.all(trip).length;
  assert.ok(onDisk > 0, "hub durably appended ops");

  // The other device on each trip received relays → relay latency was measured.
  assert.ok(stats.ops.relayed > 0, "hub relayed ops to the peer device");
  assert.ok(stats.relayLatencyMs.count > 0, "collected relay-latency samples");
  assert.ok(stats.relayLatencyMs.p50 >= 0);

  // Clean teardown: our own close is 1000/1001, never an error code.
  assert.ok(!stats.closeCodes["1008"], "no rate-limit closes at 20 ops/s");
  assert.ok(!stats.closeCodes["1009"], "no oversized-frame closes");
});

test("loadsim satisfies the Origin allowlist when --origin matches (and fails when it doesn't)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "siano-loadsim-origin-"));
  const allowed = "https://siano.example.com";
  const hub = createHub({ dataDir, allowedOrigins: allowed });
  const port = await listen(hub.httpServer);
  t.after(async () => {
    await hub.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${port}`;

  // Matching Origin (what --origin does through Cloudflare) → connections open.
  const ok = await runLoad({ url, trips: 1, devicesPerTrip: 2, rate: 10, durationMs: 400, drainMs: 200, origin: allowed });
  assert.equal(ok.connections.opened, 2, "matching Origin is admitted");
  assert.ok(ok.ops.relayed > 0);

  // Wrong Origin → the hub refuses the upgrade (403); nothing opens.
  const bad = await runLoad({ url, trips: 1, devicesPerTrip: 2, rate: 10, durationMs: 400, drainMs: 200, origin: "https://evil.example.com" });
  assert.equal(bad.connections.opened, 0, "a mismatched Origin is rejected at upgrade");
});

test("loadsim --fixed-trips + device tags drive cross-hub replication over the peer link", async (t) => {
  // Two peered hubs: B dials A over the always-on peer link (shared token).
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "siano-loadsim-xa-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "siano-loadsim-xb-"));
  const hubA = createHub({ dataDir: dirA, peerToken: "shared-secret" });
  const portA = await listen(hubA.httpServer);
  const hubB = createHub({ dataDir: dirB, peerToken: "shared-secret", peerUrls: [`ws://127.0.0.1:${portA}`] });
  const portB = await listen(hubB.httpServer);
  t.after(async () => {
    await hubA.shutdown();
    await hubB.shutdown();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  // One run per hub, SHARING the same deterministic trip ("xhub-0") but with
  // distinct device tags so they don't collide.
  const common = { trips: 1, devicesPerTrip: 2, rate: 15, durationMs: 1500, drainMs: 400, nonce: "", tripPrefix: "xhub" };
  const [onA, onB] = await Promise.all([
    runLoad({ ...common, url: `ws://127.0.0.1:${portA}`, deviceTag: "a" }),
    runLoad({ ...common, url: `ws://127.0.0.1:${portB}`, deviceTag: "b" }),
  ]);
  assert.ok(onA.ops.emitted > 0 && onB.ops.emitted > 0, "both runs emitted");

  // Give the peer link a beat to flush any last reconciliation, then assert BOTH
  // hubs hold ops authored by BOTH tags — i.e. ops crossed the link both ways.
  await new Promise((r) => setTimeout(r, 500));
  const authorsOn = (hub) => {
    const set = new Set();
    for (const op of hub.logs.all("xhub-0")) set.add(op.device.split(".").pop().replace(/[0-9]+$/, ""));
    return set;
  };
  const a = authorsOn(hubA);
  const b = authorsOn(hubB);
  assert.ok(a.has("a") && a.has("b"), `hub A holds both tags' ops (saw ${[...a]})`);
  assert.ok(b.has("a") && b.has("b"), `hub B holds both tags' ops (saw ${[...b]})`);
});

test("loadsim surfaces the hub's rate-limit close (1008) as a close-code stat", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "siano-loadsim-rl-"));
  // Tiny per-connection rate limit so a modest emit rate trips it deterministically.
  const hub = createHub({ dataDir, maxMsgsPerSec: 2 });
  const port = await listen(hub.httpServer);
  t.after(async () => {
    await hub.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const stats = await runLoad({
    url: `ws://127.0.0.1:${port}`,
    trips: 1,
    devicesPerTrip: 2,
    rate: 40, // well over the cap of 2/s
    durationMs: 800,
    drainMs: 200,
  });
  assert.ok(stats.closeCodes["1008"] > 0, "over-rate connections are closed 1008 and reported");
});
