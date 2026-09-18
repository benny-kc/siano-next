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
import { genTripKey, subtleAvailable } from "../core/crypto.js";
import { openDb, get, put, putMany, getAll } from "./idb.js";
import { registerVersion } from "../version.js";
registerVersion("js/store/oplog.js", 2);

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
 *
 * Also resolves the trip's end-to-end encryption key (crypto.js). The key is the
 * capability that unlocks the trip's data; it is NEVER sent to the hub. Resolution
 * order (transparent — no password anywhere):
 *   1. `fragKey` — came in the URL fragment (`/t/<id>#k=…`) or an offline-QR
 *      import. Persist it locally and use it.
 *   2. a key already persisted on this device for this trip.
 *   3. `minted` (a genuinely fresh trip this device just created) — generate one,
 *      persist it, and flag `keyMinted` so the caller can put it in the URL.
 *   4. otherwise → `locked`: someone opened a `/t/<id>` link with no `#k=` and this
 *      device has never held the key. The app runs locally but can't decrypt/sync
 *      until it gets the full link or QR (never silently forks with a wrong key).
 * The resolved token (base64url) is attached as `log.keyToken`; `log.locked` /
 * `log.keyMinted` describe how we got here. Ops themselves are stored PLAINTEXT
 * on-device (the device holds the key and the user works on decrypted data);
 * encryption happens only where ops leave the device (sync/client.js, QR export).
 *
 * @param {string} tripId
 * @param {{ fragKey?: string|null, minted?: boolean }} [opts]
 * @returns {Promise<OpLog>}
 */
export async function openTripStore(tripId, opts = {}) {
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

  // Resolve the trip key. Encryption is only possible in a secure context; in an
  // insecure one (raw LAN IP over http) we degrade to plaintext (keyToken = null)
  // rather than lock the user out.
  log.keyToken = null;
  log.locked = false;
  log.keyMinted = false;
  if (subtleAvailable()) {
    let token = await get(db, "meta", "tripKey");
    if (opts.fragKey && opts.fragKey !== token) {
      token = opts.fragKey;
      await put(db, "meta", token, "tripKey");
    } else if (!token && opts.minted) {
      token = genTripKey();
      await put(db, "meta", token, "tripKey");
      log.keyMinted = true;
    }
    if (token) log.keyToken = token;
    else log.locked = true; // existing trip link opened without its #k= key
  }

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

/**
 * Read a trip's stored encryption key token without opening its full store —
 * used to build a shareable link (with `#k=…`) for a trip in the device-local
 * list. Returns the base64url token, or null if none is stored / unavailable.
 */
export async function readTripKey(tripId) {
  try {
    const db = await openDb(`siano:${tripId}`, 1, { ops: { keyPath: "_id" }, meta: {} });
    return (await get(db, "meta", "tripKey")) || null;
  } catch {
    return null;
  }
}
