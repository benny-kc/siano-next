// End-to-end tests of Phase 2 hub-to-hub replication (hub/peer.js): ONE always-on
// multiplexed link per peer that carries EVERY trip. Two real hubs on two ports,
// real WebSocket framing. Verifies: many trips over a single link, bidirectional
// convergence over one dial, that a backlog created while the link is down
// flushes on reconnect (no data ever stuck), and shared-token auth.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHub } from "../hub/server.js";
import { Clock, opId } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mkHub(t, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siano-p2-"));
  const hub = createHub({ dataDir: dir, ...opts });
  return new Promise((resolve) => {
    hub.httpServer.listen(0, () => {
      const port = hub.httpServer.address().port;
      t.after(async () => {
        await hub.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      resolve({ hub, port, dir, url: `ws://127.0.0.1:${port}` });
    });
  });
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}
function nextMsg(ws, pred) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
    ws.addEventListener("message", function h(ev) {
      const m = JSON.parse(ev.data);
      if (!pred || pred(m)) {
        clearTimeout(to);
        ws.removeEventListener("message", h);
        resolve(m);
      }
    });
  });
}

// Write ops into `trip` on the hub at `port` via an ordinary leaf connection.
async function leafSend(port, trip, opList) {
  const ws = await wsOpen(`ws://127.0.0.1:${port}`);
  ws.send(JSON.stringify({ t: "hello", trip, have: [] }));
  await nextMsg(ws, (m) => m.t === "sync");
  for (const op of opList) ws.send(JSON.stringify({ t: "op", op }));
  await delay(60); // let the frames reach + append on the hub before closing
  ws.close();
}

// Poll a hub (via short-lived leaf hellos) until `trip`'s log contains all of
// `wantIds`, or time out. Returns the trip's ops. Deterministic regardless of
// reconciliation timing.
async function pollTrip(port, trip, wantIds, timeout = 5000) {
  const want = new Set(wantIds);
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    const ws = await wsOpen(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ t: "hello", trip, have: [] }));
    const sync = await nextMsg(ws, (m) => m.t === "sync");
    ws.close();
    last = sync.ops || [];
    const ids = new Set(last.map(opId));
    if ([...want].every((id) => ids.has(id))) return last;
    await delay(100);
  }
  throw new Error(`trip ${trip} on :${port} never got ${[...want]} — had ${last.map(opId)}`);
}

const countInboundPeers = (hub) => [...hub.wss.connections].filter((c) => c.isPeer).length;

test("one always-on link multiplexes many trips, both directions", async (t) => {
  const token = "s3cret";
  const A = await mkHub(t, { peerToken: token }); // passive listener
  const B = await mkHub(t, { peerUrls: [A.url], peerToken: token }); // dials A

  // Seed TWO different trips on A.
  const ca = new Clock("A");
  const t1 = "trip-one", t2 = "trip-two";
  const a1 = ops.setTripName(ca, "Rome");
  const a2 = ops.addMember(ca, "m1", { name: "Ann" });
  await leafSend(A.port, t1, [a1]);
  await leafSend(A.port, t2, [a2]);

  // Both trips reach B over the single multiplexed link.
  await pollTrip(B.port, t1, [opId(a1)]);
  await pollTrip(B.port, t2, [opId(a2)]);

  // Reverse direction on a THIRD trip: created on B, must reach A live.
  const cb = new Clock("B");
  const t3 = "trip-three";
  const b3 = ops.setTripName(cb, "Oslo");
  await leafSend(B.port, t3, [b3]);
  await pollTrip(A.port, t3, [opId(b3)]);

  // All three trips crossed ONE inbound peer connection on A — not one per trip.
  assert.equal(countInboundPeers(A.hub), 1, "a single multiplexed peer link carries every trip");
});

test("a backlog created while the link is down flushes on reconnect", async (t) => {
  const token = "s3cret";
  const A = await mkHub(t, { peerToken: token });
  const B = await mkHub(t, { peerUrls: [A.url], peerToken: token });

  // Wait for the always-on link to establish.
  const upBy = Date.now() + 4000;
  while (countInboundPeers(A.hub) === 0 && Date.now() < upBy) await delay(50);
  assert.equal(countInboundPeers(A.hub), 1, "link came up on its own (active, not lazy)");

  // Sever the link from A's side (a transient network drop). B's dialer will
  // reconnect on its own.
  for (const c of A.hub.wss.connections) if (c.isPeer) c.terminate();

  // Create data on B *while the link is down*. It can't be sent now — it must
  // sit in B's log and flush when the link returns. This is the core guarantee:
  // no situation where a hub has data but can't ever deliver it.
  const cb = new Clock("B");
  const trip = "trip-offline-hub";
  const b1 = ops.setTripName(cb, "Reykjavik");
  await leafSend(B.port, trip, [b1]);

  // Without any manual nudge, A eventually receives it once B reconnects and
  // reconciles.
  await pollTrip(A.port, trip, [opId(b1)], 8000);
  assert.ok(countInboundPeers(A.hub) >= 1, "link re-established");
});

test("no token configured: peer links are accepted (open default)", async (t) => {
  const A = await mkHub(t, {}); // no token
  const B = await mkHub(t, { peerUrls: [A.url] }); // no token
  const ca = new Clock("A");
  const trip = "trip-open";
  const a1 = ops.setTripName(ca, "Rome");
  await leafSend(A.port, trip, [a1]);
  await pollTrip(B.port, trip, [opId(a1)]);
});

test("a mismatched peer token blocks replication", async (t) => {
  const A = await mkHub(t, { peerToken: "right" });
  const B = await mkHub(t, { peerUrls: [A.url], peerToken: "wrong" });

  const ca = new Clock("A");
  const trip = "trip-token-bad";
  const a1 = ops.setTripName(ca, "Rome");
  await leafSend(A.port, trip, [a1]);

  // Give the (rejected) link a couple of dial attempts, then assert nothing
  // crossed and no inbound peer link is registered.
  await delay(1500);
  const wsB = await wsOpen(`ws://127.0.0.1:${B.port}`);
  wsB.send(JSON.stringify({ t: "hello", trip, have: [] }));
  const sync = await nextMsg(wsB, (m) => m.t === "sync");
  wsB.close();
  assert.equal(sync.ops.length, 0, "no ops cross a mismatched-token link");
  assert.equal(A.hub.metrics.peerAuthFailures > 0, true, "A recorded the auth failure");
});
