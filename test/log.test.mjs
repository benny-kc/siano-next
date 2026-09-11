// TripLogs memory-bounding tests: the in-memory op cache is bounded (an LRU cap
// + an explicit evict) so a burst of trips can't pin every trip's op set in the
// heap forever, while the durable JSONL on disk stays the source of truth — a
// dropped trip re-hydrates on its next access with nothing lost.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { TripLogs } from "../hub/log.js";
import { Clock } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "siano-log-"));
}

test("LRU cap bounds the number of trips held in memory", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const logs = new TripLogs(dir, { maxTripsInMemory: 2 });
  // Append one op to each of five distinct trips.
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const C = new Clock("D" + i);
    const op = ops.setTripName(C, "Trip " + i);
    await logs.append("trip-" + i, op);
    ids.push(op);
  }

  // At most two trips stay hydrated even though five were written.
  assert.ok(logs.mem.size <= 2, `mem holds ${logs.mem.size} trips, expected <= 2`);

  // Nothing is lost: every trip is fully readable (re-hydrated from disk).
  for (let i = 0; i < 5; i++) {
    const all = logs.all("trip-" + i);
    assert.equal(all.length, 1, `trip-${i} still has its op`);
    assert.equal(all[0].name, "Trip " + i);
  }
});

test("evict() releases a trip from memory but keeps it on disk", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const logs = new TripLogs(dir); // unlimited cap — test explicit eviction alone
  const C = new Clock("A");
  const op = ops.addMember(C, "m1", { name: "Ann" });
  await logs.append("trip-e", op);
  await logs.flush(); // ensure the write reached disk

  assert.ok(logs.mem.has("trip-e"), "trip is hydrated after an append");
  logs.evict("trip-e");
  assert.ok(!logs.mem.has("trip-e"), "evict drops the trip from memory");

  // Re-read pulls it back from disk, intact.
  const all = logs.all("trip-e");
  assert.equal(all.length, 1);
  assert.equal(all[0].memberId, "m1");
});

test("evict() defers while a write is still in flight (no op lost)", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const logs = new TripLogs(dir);
  const C = new Clock("A");
  const op = ops.setTripName(C, "Rome");
  // Kick off the append but do NOT await it — the disk write is still queued.
  const appended = logs.append("trip-d", op);
  logs.evict("trip-d"); // must not drop mid-write

  await appended;
  await logs.flush();
  // The op is durably on disk regardless of the eviction timing.
  const all = logs.all("trip-d");
  assert.equal(all.length, 1, "the in-flight op was not lost to a premature evict");
  assert.equal(all[0].name, "Rome");
});

test("a hot trip is not evicted under the LRU cap; a cold one is", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const logs = new TripLogs(dir, { maxTripsInMemory: 2 });
  const mk = async (trip) => {
    const C = new Clock(trip);
    await logs.append(trip, ops.setTripName(C, trip));
  };
  await mk("a");
  await mk("b");
  await logs.flush();
  // Touch "a" so it becomes most-recently-used, then bring in a third trip.
  logs.all("a");
  await mk("c");

  // "b" (the coldest) should have been evicted; "a" (just touched) and "c"
  // (just written) remain hot.
  assert.ok(logs.mem.has("a"), "recently-touched trip stays hydrated");
  assert.ok(logs.mem.has("c"), "just-written trip stays hydrated");
  assert.ok(!logs.mem.has("b"), "the least-recently-used trip is evicted");
});
