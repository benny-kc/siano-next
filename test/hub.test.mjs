// End-to-end test of the dependency-free hub: real WebSocket framing (via
// Node's built-in WebSocket client), fan-out between two devices on the same
// trip, and delta-on-reconnect for a late joiner. Uses an ephemeral port and a
// throwaway data dir so it leaves nothing behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHub } from "../hub/server.js";
import { Clock } from "../client/js/core/lamport.js";
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

test("hub relays ops between devices and delta-syncs a late joiner", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "siano-hub-"));
  const { httpServer } = createHub({ dataDir });
  const port = await listen(httpServer);
  t.after(() => {
    httpServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const url = `ws://127.0.0.1:${port}`;
  const A = new Clock("A");
  const trip = "trip-xyz";

  // Device A connects and creates a couple of ops.
  const wsA = await open(url);
  wsA.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await next(wsA, (m) => m.t === "sync"); // empty sync back

  const op1 = ops.setTripName(A, "Rome");
  const op2 = ops.addMember(A, "m1", { name: "Ann" });
  wsA.send(JSON.stringify({ t: "op", op: op1 }));
  wsA.send(JSON.stringify({ t: "op", op: op2 }));

  // Device B joins late with nothing — it must be handed both ops in the sync.
  const wsB = await open(url);
  wsB.send(JSON.stringify({ t: "hello", trip, have: [] }));
  const sync = await next(wsB, (m) => m.t === "sync");
  assert.equal(sync.ops.length, 2, "late joiner receives the full delta");
  const names = sync.ops.map((o) => o.op).sort();
  assert.deepEqual(names, ["add_member", "set_trip_name"]);

  // A live op from B is fanned out to A (but not echoed to B).
  const B = new Clock("B");
  for (const o of sync.ops) B.observe(o);
  const op3 = ops.addMember(B, "m2", { name: "Bob" });
  const gotByA = next(wsA, (m) => m.t === "op" && m.op.op === "add_member");
  wsB.send(JSON.stringify({ t: "op", op: op3 }));
  const relayed = await gotByA;
  assert.equal(relayed.op.memberId, "m2");

  // A reconnecting device that already has op1/op2 only gets the delta (op3).
  const { opId } = await import("../client/js/core/lamport.js");
  const wsC = await open(url);
  wsC.send(JSON.stringify({ t: "hello", trip, have: [opId(op1), opId(op2)] }));
  const syncC = await next(wsC, (m) => m.t === "sync");
  assert.equal(syncC.ops.length, 1, "reconnect gets only the missing op");
  assert.equal(syncC.ops[0].memberId, "m2");

  wsA.close();
  wsB.close();
  wsC.close();
});
