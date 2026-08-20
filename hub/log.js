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
  /** @param {string} dir @param {{maxOpsPerTrip?: number, maxTrips?: number}} [opts] */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.maxOpsPerTrip = opts.maxOpsPerTrip ?? 0; // 0 = unlimited
    this.maxTrips = opts.maxTrips ?? 0; // 0 = unlimited
    fs.mkdirSync(dir, { recursive: true });
    this.mem = new Map(); // trip -> Map(opId -> op)
    this.writeQueues = new Map(); // trip -> Promise chain (serialize appends)
    this.capped = new Set(); // trips we've already warned about
    // Count existing trip files so maxTrips survives restarts.
    this.tripCount = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  }

  _file(trip) {
    return path.join(this.dir, encodeURIComponent(trip) + ".jsonl");
  }

  _load(trip) {
    let map = this.mem.get(trip);
    if (map) return map;
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
    return map;
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
  _enqueueWrite(trip, line) {
    const prev = this.writeQueues.get(trip) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => fsp.appendFile(this._file(trip), line));
    this.writeQueues.set(trip, next);
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
