// End-to-end test of hub-to-hub replication (hub/peer.js): two real hubs on two
// ports, one dialing the other, with real WebSocket framing. Verifies lazy
// per-trip linking, convergence in BOTH directions (a single dial is
// bidirectional), durability of replicated ops, and shared-token auth.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHub } from "../hub/server.js";
import { Clock, opId } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";

function listen(httpServer) {
  return new Promise((resolve) => httpServer.listen(0, () => resolve(httpServer.address().port)));
}
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}
function next(ws, predicate) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
    ws.addEventListener("message", function handler(ev) {
      const msg = JSON.parse(ev.data);
      if (!predicate || predicate(msg)) {
        clearTimeout(to);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    });
  });
}
// Collect ops from any `op`/`sync`/`ops` frames until we've seen the wanted ids.
function collectOps(ws, wantIds) {
  const want = new Set(wantIds);
  const got = new Map();
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timed out; saw ${[...got.keys()]}`)), 4000);
    ws.addEventListener("message", function handler(ev) {
      const msg = JSON.parse(ev.data);
      const batch = msg.op ? [msg.op] : Array.isArray(msg.ops) ? msg.ops : [];
      for (const o of batch) if (want.has(opId(o))) got.set(opId(o), o);
      if ([...want].every((id) => got.has(id))) {
        clearTimeout(to);
        ws.removeEventListener("message", handler);
        resolve(got);
      }
    });
  });
}

function twoHubs(t, { token } = {}) {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "siano-peerA-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "siano-peerB-"));
  return (async () => {
    // Hub A accepts peers; hub B dials A. A single dial is bidirectional.
    const hubA = createHub({ dataDir: dirA, peerToken: token });
    const portA = await listen(hubA.httpServer);
    const hubB = createHub({
      dataDir: dirB,
      peerUrls: [`ws://127.0.0.1:${portA}`],
      peerToken: token,
    });
    const portB = await listen(hubB.httpServer);
    t.after(async () => {
      await hubB.shutdown();
      await hubA.shutdown();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });
    return { hubA, hubB, portA, portB };
  })();
}

test("two hubs converge in both directions over a single dial", async (t) => {
  const { portA, portB } = await twoHubs(t);
  const trip = "trip-peer";

  // A leaf on hub A creates an op the peer link should carry to hub B.
  const A = new Clock("A");
  const wsA = await open(`ws://127.0.0.1:${portA}`);
  wsA.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(wsA, (m) => m.t === "sync");
  const op1 = ops.setTripName(A, "Rome");
  wsA.send(JSON.stringify({ t: "op", op: op1 }));

  // A leaf joins hub B. That join lazily opens B's peer link to A, which pulls
  // op1 down and fans it out to this leaf.
  const wsB = await open(`ws://127.0.0.1:${portB}`);
  const gotByB = collectOps(wsB, [opId(op1)]);
  wsB.send(JSON.stringify({ t: "hello", trip, have: [] }));
  const b = await gotByB;
  assert.equal(b.get(opId(op1)).op, "set_trip_name", "op made on hub A reached hub B");

  // Reverse direction: an op on hub B must reach hub A over the same link.
  const B = new Clock("B");
  for (const o of b.values()) B.observe(o);
  const op2 = ops.addMember(B, "m1", { name: "Ann" });
  const gotByA = collectOps(wsA, [opId(op2)]);
  wsB.send(JSON.stringify({ t: "op", op: op2 }));
  const a = await gotByA;
  assert.equal(a.get(opId(op2)).memberId, "m1", "op made on hub B reached hub A");

  // Both ops are now durable on BOTH hubs: a fresh late joiner on each gets both.
  for (const port of [portA, portB]) {
    const wsC = await open(`ws://127.0.0.1:${port}`);
    wsC.send(JSON.stringify({ t: "hello", trip, have: [] }));
    const sync = await next(wsC, (m) => m.t === "sync" && m.ops.length >= 2);
    assert.deepEqual(
      sync.ops.map((o) => o.op).sort(),
      ["add_member", "set_trip_name"],
      `hub on :${port} durably holds both ops`,
    );
    wsC.close();
  }

  wsA.close();
  wsB.close();
});

test("a wrong peer token stops replication; a matching one allows it", async (t) => {
  // Hubs agree on a token; B dials A with it → replication works.
  const good = await twoHubs(t, { token: "s3cret" });
  const trip = "trip-token-ok";
  const A = new Clock("A");
  const wsA = await open(`ws://127.0.0.1:${good.portA}`);
  wsA.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(wsA, (m) => m.t === "sync");
  const op1 = ops.setTripName(A, "Rome");
  wsA.send(JSON.stringify({ t: "op", op: op1 }));

  const wsB = await open(`ws://127.0.0.1:${good.portB}`);
  const gotByB = collectOps(wsB, [opId(op1)]);
  wsB.send(JSON.stringify({ t: "hello", trip, have: [] }));
  assert.equal((await gotByB).get(opId(op1)).op, "set_trip_name", "matching token replicates");
  wsA.close();
  wsB.close();
});

test("a mismatched peer token blocks replication", async (t) => {
  // Hub A requires token "right"; hub B dials with "wrong" → A closes the peer
  // link 1008, so nothing crosses. The B leaf gets its own (empty) sync but
  // never receives A's op.
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "siano-peerA-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "siano-peerB-"));
  const hubA = createHub({ dataDir: dirA, peerToken: "right" });
  const portA = await listen(hubA.httpServer);
  const hubB = createHub({ dataDir: dirB, peerUrls: [`ws://127.0.0.1:${portA}`], peerToken: "wrong" });
  const portB = await listen(hubB.httpServer);
  t.after(async () => {
    await hubB.shutdown();
    await hubA.shutdown();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  const trip = "trip-token-bad";
  const A = new Clock("A");
  const wsA = await open(`ws://127.0.0.1:${portA}`);
  wsA.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(wsA, (m) => m.t === "sync");
  wsA.send(JSON.stringify({ t: "op", op: ops.setTripName(A, "Rome") }));

  const wsB = await open(`ws://127.0.0.1:${portB}`);
  wsB.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(wsB, (m) => m.t === "sync"); // B's own empty sync

  // Give the (rejected) peer link time to fail; assert B never got A's op.
  let leaked = false;
  wsB.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if ((m.op || m.ops) && (m.op?.op === "set_trip_name" || (m.ops || []).some((o) => o.op === "set_trip_name"))) leaked = true;
  });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(leaked, false, "no ops cross a mismatched-token peer link");

  wsA.close();
  wsB.close();
});
