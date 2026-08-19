// Durable per-trip op log — the hub's whole job on the storage side.
//
// One append-only JSONL file per trip (`<dir>/<trip>.jsonl`), one op per line.
// The hub never interprets ops (no business logic lives here — that stays in
// the client reducer); it only appends, dedups, and hands back deltas. Because
// the file is append-only, it is crash-safe by construction and any leaf can
// re-seed it, exactly as the architecture calls for.
//
// opId() is imported from the CLIENT core so the hub and every device agree on
// op identity from a single source of truth.

import fs from "node:fs";
import path from "node:path";
import { opId } from "../client/js/core/lamport.js";

/** Minimal shape check so a malformed frame can never poison the dedup index. */
export function isValidOp(op) {
  return (
    op &&
    typeof op === "object" &&
    typeof op.op === "string" &&
    typeof op.lamport === "number" &&
    typeof op.device === "string"
  );
}

export class TripLogs {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.mem = new Map(); // trip -> Map(opId -> op)
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

  /** Append one op; returns true if it was new (and thus should be fanned out). */
  append(trip, op) {
    if (!isValidOp(op)) return false;
    const map = this._load(trip);
    const id = opId(op);
    if (map.has(id)) return false;
    map.set(id, op);
    fs.appendFileSync(this._file(trip), JSON.stringify(op) + "\n");
    return true;
  }

  /** Every op for a trip. */
  all(trip) {
    return [...this._load(trip).values()];
  }

  /** The ops this trip has that the caller (who lists `have` op-ids) is missing. */
  missing(trip, have) {
    const set = new Set(have || []);
    return this.all(trip).filter((op) => !set.has(opId(op)));
  }
}
