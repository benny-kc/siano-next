// The op-log store: the device's complete copy of a trip.
//
// It holds every op (local + synced), a Lamport clock, and a memoized folded
// snapshot. Local edits and incoming synced ops flow through the same ingest
// path, so the folded state is always the truth. This is the "full DB on every
// leaf" from the architecture: the log IS the trip and IS the backup — any leaf
// can re-seed the hub from it.
//
// `OpLog` is persistence-agnostic (pure, testable). `openTripStore()` wraps it
// with IndexedDB persistence for the browser.

import { Clock, opId } from "../core/lamport.js";
import { fold } from "../core/reducer.js";
import { buildSnapshot } from "../core/snapshot.js";
import { openDb, get, put, putMany, getAll } from "./idb.js";
import { registerVersion } from "../version.js";
registerVersion("js/store/oplog.js", 1);

function newDeviceId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts where randomUUID is unavailable.
  return "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class OpLog {
  /** @param {string} tripId  @param {{clock?: Clock, device?: string}} [opts] */
  constructor(tripId, opts = {}) {
    this.tripId = tripId;
    this.ops = new Map(); // opId -> op
    this.clock = opts.clock || new Clock(opts.device || newDeviceId());
    this._state = null;
    this._snapshot = null;
    this._listeners = new Set();
  }

  get device() {
    return this.clock.device;
  }

  has(id) {
    return this.ops.has(id);
  }

  /** Fetch a single op by its id (used to answer the hub's `want` on reconnect). */
  get(id) {
    return this.ops.get(id);
  }

  /** The op-ids this device already holds — the basis for sync delta negotiation. */
  have() {
    return [...this.ops.keys()];
  }

  allOps() {
    return [...this.ops.values()];
  }

  /** Ingest one op (local or remote). Returns true if it was new. */
  ingest(op) {
    const id = opId(op);
    if (this.ops.has(id)) return false;
    this.ops.set(id, op);
    this.clock.observe(op);
    this._invalidate();
    return true;
  }

  /** Ingest a batch of remote ops; notifies listeners with the ones that were new. */
  ingestMany(ops, { silent = false } = {}) {
    const added = [];
    for (const op of ops) if (this.ingest(op)) added.push(op);
    if (added.length && !silent) this._emit(added, false);
    return added;
  }

  /**
   * Create and append a LOCAL op. `makeFn(clock)` builds it (use the ops.js
   * constructors, which stamp the clock). Notifies listeners so the sync layer
   * can broadcast it.
   */
  emit(makeFn) {
    const op = makeFn(this.clock);
    this.ops.set(opId(op), op);
    this._invalidate();
    this._emit([op], true);
    return op;
  }

  /** The folded state (memoized until the next change). */
  state() {
    if (!this._state) this._state = fold(this.tripId, this.allOps());
    return this._state;
  }

  /** The rendered snapshot (memoized until the next change). */
  snapshot() {
    if (!this._snapshot) this._snapshot = buildSnapshot(this.state());
    return this._snapshot;
  }

  /** Listen for changes: fn({ ops, local, store }). Returns an unsubscribe fn. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _invalidate() {
    this._state = null;
    this._snapshot = null;
  }

  _emit(ops, local) {
    for (const fn of this._listeners) fn({ ops, local, store: this });
  }
}

/**
 * Open (or create) the IndexedDB-backed store for a trip. Rehydrates the clock
 * and every op from disk, then persists any new op automatically.
 * @returns {Promise<OpLog>}
 */
export async function openTripStore(tripId) {
  const db = await openDb(`siano:${tripId}`, 1, {
    ops: { keyPath: "_id" },
    meta: {},
  });

  let device = await get(db, "meta", "device");
  if (!device) {
    device = newDeviceId();
    await put(db, "meta", device, "device");
  }
  const clockState = (await get(db, "meta", "clock")) || {};
  const clock = new Clock(device, clockState);

  const log = new OpLog(tripId, { clock });
  const stored = await getAll(db, "ops");
  log.ingestMany(stored.map((r) => r.op), { silent: true }); // no listeners yet, don't re-broadcast

  // Persist every new op + the advancing clock. Fire-and-forget; IndexedDB
  // serializes writes per store so ordering within a store is preserved.
  log.subscribe(({ ops }) => {
    putMany(db, "ops", ops.map((op) => ({ _id: opId(op), op }))).catch((e) =>
      console.error("siano: failed to persist ops", e));
    put(db, "meta", log.clock.toJSON(), "clock").catch(() => {});
  });

  return log;
}
