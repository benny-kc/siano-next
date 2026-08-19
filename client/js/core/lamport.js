// Lamport clock + version vector for one device.
//
// Every op an app emits is stamped with:
//   - `lamport`: a Lamport timestamp giving a deterministic TOTAL order (used as
//     the tiebreak/LWW winner so all devices converge on the same value), and
//   - `device`:  this device's stable id (author + tiebreak within a lamport), and
//   - `vv`:      a VERSION VECTOR — a snapshot of the highest lamport this device
//     had seen from every device at the moment it created the op.
//
// The version vector is what lets us tell CAUSAL edits apart from CONCURRENT
// ones — a Lamport clock alone cannot. Op A causally-follows op B ("A's author
// had already applied B") iff `A.vv[B.device] >= B.lamport`. Two money edits
// that are genuinely concurrent (neither follows the other) are surfaced as a
// conflict instead of one silently overwriting the other. See reducer.js.
//
// Trips have only a handful of devices, so an O(devices) vector per op is cheap.

export class Clock {
  /**
   * @param {string} device  stable per-device id (keypair fingerprint later)
   * @param {{lamport?: number, vv?: Object}} [init]  persisted state to resume
   */
  constructor(device, init = {}) {
    this.device = device;
    this.lamport = init.lamport || 0;
    // vv: { [deviceId]: highest lamport seen from that device }
    this.vv = { ...(init.vv || {}) };
  }

  /** Fold an op we received/loaded into our knowledge (no new local event). */
  observe(op) {
    if (op.lamport > this.lamport) this.lamport = op.lamport;
    const prev = this.vv[op.device] || 0;
    if (op.lamport > prev) this.vv[op.device] = op.lamport;
  }

  /**
   * Stamp a NEW local op: advance our clock past everything we've seen, record
   * it in our own vv slot, and return the fields to attach to the op. The `vv`
   * returned is a snapshot of what we had seen BEFORE this op (its causal past).
   */
  stamp() {
    const causalPast = { ...this.vv };
    this.lamport += 1;
    this.vv[this.device] = this.lamport;
    return { lamport: this.lamport, device: this.device, vv: causalPast };
  }

  /** Serializable state for persistence (survives reloads). */
  toJSON() {
    return { device: this.device, lamport: this.lamport, vv: { ...this.vv } };
  }
}

/**
 * Deterministic total order on ops: by lamport, then device id as tiebreak.
 * Returns negative if a < b, positive if a > b, 0 if identical position.
 */
export function compareOps(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.device < b.device) return -1;
  if (a.device > b.device) return 1;
  return 0;
}

/** Stable unique id for an op. A device's lamport strictly increases per op. */
export function opId(op) {
  return `${op.lamport}.${op.device}`;
}

/**
 * Does `a` causally follow `b`? True iff a's author had already applied b when
 * it created a (a's version vector covers b). Identity is not "following".
 */
export function causallyAfter(a, b) {
  if (a === b) return false;
  return (a.vv?.[b.device] || 0) >= b.lamport;
}

/**
 * The causal frontier of a set of ops: those not causally-followed by any other
 * op in the set. A single-element frontier means one op supersedes all others
 * (a clean LWW). A multi-element frontier means those ops are mutually
 * concurrent — the basis for both add-wins OR-Set membership and money-conflict
 * detection.
 */
export function frontier(ops) {
  return ops.filter((x) => !ops.some((y) => causallyAfter(y, x)));
}
