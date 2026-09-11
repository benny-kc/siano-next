// Durable per-trip op log — the hub's whole job on the storage side.
//
// One append-only JSONL file per trip (`<dir>/<trip>.jsonl`), one op per line.
// The hub never interprets ops (no business logic lives here — that stays in
// the client reducer); it only appends, dedups, and hands back deltas. Because
// the file is append-only, it is crash-safe by construction and any leaf can
// re-seed it, exactly as the architecture calls for.
//
// Abuse containment (there is no auth — the trip URL is the capability, so
// anyone who reaches the hub can write): writes are async so a flood can't block
// the event loop, and two caps bound worst-case disk/inode use —
//   - maxOpsPerTrip: refuse further ops once a trip is this large, and
//   - maxTrips:      refuse to create new trip files past this many.
// Both default off (0 = unlimited) but SHOULD be set in production; see docs.
//
// Memory containment: a touched trip's ops are cached in `this.mem` so repeated
// reads/appends don't re-parse the file. That cache is BOUNDED two ways so a
// burst of trips (e.g. a load test) can't pin every trip's op set in the heap
// forever (the reported "RSS jumps and stays high long after every device
// disconnected" — the log dir grows, but so did resident memory):
//   - maxTripsInMemory: an LRU cap; the least-recently-used trip is dropped once
//     more than this many are hydrated, and
//   - evict(trip):      an explicit release the hub calls when a trip's last
//     device disconnects, so idle trips fall out of memory promptly.
// Dropping a trip loses nothing — the append-only JSONL on disk is the source of
// truth and is re-read on the next access. A trip is never dropped while it has
// an in-flight write (its op may not be on disk yet).
//
// opId() is imported from the CLIENT core so the hub and every device agree on
// op identity from a single source of truth.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { opId } from "../client/js/core/lamport.js";

/** Minimal shape check so a malformed frame can never poison the dedup index. */
export function isValidOp(op) {
  return (
    op &&
    typeof op === "object" &&
    typeof op.op === "string" &&
    typeof op.lamport === "number" &&
    Number.isFinite(op.lamport) &&
    typeof op.device === "string"
  );
}

export class TripLogs {
  /**
   * @param {string} dir
   * @param {{maxOpsPerTrip?: number, maxTrips?: number, maxTripsInMemory?: number}} [opts]
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.maxOpsPerTrip = opts.maxOpsPerTrip ?? 0; // 0 = unlimited
    this.maxTrips = opts.maxTrips ?? 0; // 0 = unlimited
    this.maxTripsInMemory = opts.maxTripsInMemory ?? 0; // 0 = unlimited (no LRU cap)
    fs.mkdirSync(dir, { recursive: true });
    // trip -> Map(opId -> op). Insertion order doubles as LRU order: a touched
    // trip is re-inserted at the end (_load), so the FIRST key is the coldest.
    this.mem = new Map();
    this.writeQueues = new Map(); // trip -> Promise chain (serialize appends)
    this.pending = new Map(); // trip -> in-flight append count (never evict mid-write)
    this.capped = new Set(); // trips we've already warned about
    // Count existing trip files so maxTrips survives restarts.
    this.tripCount = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  }

  _file(trip) {
    return path.join(this.dir, encodeURIComponent(trip) + ".jsonl");
  }

  _load(trip) {
    let map = this.mem.get(trip);
    if (map) {
      // Cache hit: touch it (move to the most-recently-used end) so the LRU cap
      // evicts genuinely-cold trips, not ones actively being read/appended.
      this.mem.delete(trip);
      this.mem.set(trip, map);
      return map;
    }
    map = new Map();
    const file = this._file(trip);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line);
          if (isValidOp(op)) map.set(opId(op), op);
        } catch {
          /* skip a torn last line */
        }
      }
    }
    this.mem.set(trip, map);
    this._enforceMemCap(trip);
    return map;
  }

  // Drop least-recently-used hydrated trips until we're back within
  // maxTripsInMemory. `keep` is the trip we just hydrated — it's the MRU end (and
  // so never a candidate), passed only to be explicit. A trip with an in-flight
  // write is skipped (its op may not be on disk yet, so re-reading later could
  // miss it and re-append a duplicate line); it's collected on a later pass once
  // its write queue drains. Losing nothing: the JSONL is the source of truth.
  _enforceMemCap(keep) {
    const cap = this.maxTripsInMemory;
    if (!cap || this.mem.size <= cap) return;
    for (const trip of this.mem.keys()) {
      if (this.mem.size <= cap) break;
      if (trip === keep || this.pending.get(trip)) continue;
      this._drop(trip);
    }
  }

  // Forget a trip's in-memory state (op index + per-trip bookkeeping). Only safe
  // when the trip has no in-flight write; callers guarantee that.
  _drop(trip) {
    this.mem.delete(trip);
    this.capped.delete(trip);
    if (!this.pending.get(trip)) this.writeQueues.delete(trip);
  }

  /**
   * Release a trip from memory when the hub no longer has a live reason to keep
   * it hot (e.g. its last device disconnected). This is what keeps resident
   * memory bounded to the trips actually in use rather than every trip ever
   * touched this run. Deferred until any in-flight write for the trip has flushed
   * to disk, so no op is lost or re-appended; a no-op for a trip not currently
   * hydrated. The trip re-hydrates from disk on its next access.
   */
  evict(trip) {
    if (!this.mem.has(trip)) return;
    if (this.pending.get(trip)) {
      // Still flushing — drop it once the queued writes settle (unless a new
      // write arrived meanwhile, i.e. the trip went active again).
      const q = this.writeQueues.get(trip);
      if (q) q.then(() => { if (!this.pending.get(trip)) this._drop(trip); }, () => {});
      return;
    }
    this._drop(trip);
  }

  _warnCap(trip, why) {
    if (this.capped.has(trip)) return;
    this.capped.add(trip);
    console.warn(`siano: refusing ops for trip ${trip}: ${why}`);
  }

  /**
   * Append one op. Returns a promise resolving to true if it was new (and thus
   * should be fanned out), false if it was a duplicate or refused by a cap.
   */
  async append(trip, op) {
    if (!isValidOp(op)) return false;
    const fileExists = this.mem.has(trip) || fs.existsSync(this._file(trip));
    // Refuse to create a brand-new trip file past the global cap.
    if (!fileExists && this.maxTrips && this.tripCount >= this.maxTrips) {
      this._warnCap(trip, `server at trip cap (${this.maxTrips})`);
      return false;
    }
    const map = this._load(trip);
    const id = opId(op);
    if (map.has(id)) return false;
    if (this.maxOpsPerTrip && map.size >= this.maxOpsPerTrip) {
      this._warnCap(trip, `trip at op cap (${this.maxOpsPerTrip})`);
      return false;
    }
    if (!fileExists) this.tripCount += 1;
    map.set(id, op);
    // The op is already in the in-memory index (and about to be fanned out); a
    // failed disk write must not reject into the caller's async handler. Log it
    // and move on — a leaf will re-send on reconnect if it's ever lost.
    await this._enqueueWrite(trip, JSON.stringify(op) + "\n").catch((e) =>
      console.error(`siano: append write failed for trip ${trip}:`, e));
    return true;
  }

  // Serialize appends per trip so concurrent writes never interleave a line.
  // Tracks an in-flight count (`pending`) so eviction never drops a trip whose
  // op hasn't reached disk yet, and drops the settled chain from `writeQueues`
  // once idle so that map doesn't grow one entry per trip forever either.
  _enqueueWrite(trip, line) {
    const prev = this.writeQueues.get(trip) || Promise.resolve();
    this.pending.set(trip, (this.pending.get(trip) || 0) + 1);
    const next = prev
      .catch(() => {})
      .then(() => fsp.appendFile(this._file(trip), line));
    this.writeQueues.set(trip, next);
    const settle = () => {
      const n = (this.pending.get(trip) || 1) - 1;
      if (n > 0) { this.pending.set(trip, n); return; }
      this.pending.delete(trip);
      // Only clear the chain if a newer write hasn't replaced it in the meantime.
      if (this.writeQueues.get(trip) === next) this.writeQueues.delete(trip);
    };
    next.then(settle, settle);
    return next;
  }

  /** Flush all pending writes (call before shutdown). */
  async flush() {
    await Promise.allSettled([...this.writeQueues.values()]);
  }

  /** Every op for a trip. */
  all(trip) {
    return [...this._load(trip).values()];
  }

  /**
   * Every trip id this hub holds — on disk OR loaded in memory. Used by the
   * hub-to-hub peer link to announce and reconcile the full set of trips over a
   * single multiplexed connection (peer.js). Reads the log dir each call (cheap:
   * one readdir), so it reflects trips created since startup too.
   */
  trips() {
    const set = new Set(this.mem.keys());
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith(".jsonl")) set.add(decodeURIComponent(f.slice(0, -".jsonl".length)));
      }
    } catch {
      /* dir vanished mid-run — the in-memory set is the best we have */
    }
    return [...set];
  }

  /**
   * Per-trip op counts for trips currently held in memory (metrics only — does
   * not touch disk, so it reflects trips this hub has actually served this run).
   * @returns {Map<string, number>} trip -> ops in memory.
   */
  opCounts() {
    const out = new Map();
    for (const [trip, map] of this.mem) out.set(trip, map.size);
    return out;
  }

  /**
   * The ops this trip holds for the given op-ids (unknown ids skipped). Used by
   * the peer link to answer a `pwant` (the ids a peer hub asked us to send).
   */
  pick(trip, ids) {
    if (!Array.isArray(ids)) return [];
    const map = this._load(trip);
    const out = [];
    for (const id of ids) {
      const op = map.get(id);
      if (op) out.push(op);
    }
    return out;
  }

  /** The ops this trip has that the caller (who lists `have` op-ids) is missing. */
  missing(trip, have) {
    const set = new Set(Array.isArray(have) ? have : []);
    return this.all(trip).filter((op) => !set.has(opId(op)));
  }

  /**
   * The op-ids the caller CLAIMS to have (`have`) that this trip's log is
   * missing. This is the other direction of the delta: the hub uses it to ask a
   * (re)connecting leaf to push ops it created while offline — ops that were
   * only ever persisted on that device and so never reached the hub or the
   * other leaves. Without this, `missing()` alone only ever pulls ops TO the
   * newcomer; nothing pulls the newcomer's offline-made ops back UP.
   */
  wanted(trip, have) {
    if (!Array.isArray(have)) return [];
    const map = this._load(trip);
    return have.filter((id) => typeof id === "string" && !map.has(id));
  }
}
