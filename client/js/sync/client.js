// WebSocket sync client — connects a local OpLog to the relay hub.
//
// The hub is a DUMB relay: this client sends the op-ids it already has, the hub
// replies with whatever it's missing, and from then on each side forwards new
// ops as they happen. Sync is entirely additive (ops only ever get appended and
// deduped), so a dropped connection loses nothing — reconnect and exchange the
// delta. The app is fully usable with the hub offline; this just keeps devices
// converged when it's reachable.
//
// Protocol (JSON text frames):
//   client -> hub  { t:"hello", trip, have:[opId,...] }
//   hub -> client  { t:"sync",  ops:[...], want:[opId,...] }
//                     // ops the client lacked, plus op-ids the hub lacks that
//                     // the client claims to have (its offline-made ops)
//   client -> hub  { t:"ops",   ops:[...] }         // answer to `want`
//   client -> hub  { t:"op",    op }                // a new local op
//   hub -> client  { t:"op",    op } | { t:"ops", ops:[...] }   // fan-out
//
// The `want` half is what makes offline edits survive reconnect: without it the
// hub only ever pushes ops DOWN to a returning leaf; nothing pulls the leaf's
// offline-created ops back UP, so those bills stay stranded on one device.

import { dlog, dwarn } from "../log.js";
import { registerVersion } from "../version.js";
registerVersion("js/sync/client.js", 1);

export class SyncClient {
  /**
   * @param {string} url   ws:// or wss:// hub URL
   * @param {import("../store/oplog.js").OpLog} log
   * @param {{onStatus?: (s: "connecting"|"open"|"closed") => void}} [opts]
   */
  constructor(url, log, opts = {}) {
    this.url = url;
    this.log = log;
    this.onStatus = opts.onStatus || (() => {});
    this.ws = null;
    this.backoff = 1000;
    this.maxBackoff = 30000;
    this.closed = false;

    // Broadcast local ops as they're created (remote ops carry local=false and
    // are never echoed back — that would loop).
    this._unsub = log.subscribe(({ ops, local }) => {
      if (!local || !this._isOpen()) return;
      for (const op of ops) this._send({ t: "op", op });
    });
  }

  connect() {
    this.closed = false;
    this._open();
    return this;
  }

  close() {
    this.closed = true;
    this._unsub?.();
    this.ws?.close();
  }

  _isOpen() {
    return this.ws && this.ws.readyState === 1; // WebSocket.OPEN
  }

  _open() {
    this.onStatus("connecting");
    dlog("sync: connecting to", this.url);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.onStatus("open");
      const have = this.log.have();
      dlog(`sync: open — hello trip=${this.log.tripId} have=${have.length} ops`);
      this._send({ t: "hello", trip: this.log.tripId, have });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        dwarn("sync: received non-JSON frame, ignored");
        return;
      }
      if (msg.t === "op" && msg.op) {
        const added = this.log.ingestMany([msg.op]);
        dlog(`sync: recv op (${added.length ? "new" : "dup"})`);
      } else if ((msg.t === "ops" || msg.t === "sync") && Array.isArray(msg.ops)) {
        const added = this.log.ingestMany(msg.ops);
        dlog(`sync: recv ${msg.t} — ${msg.ops.length} ops, ${added.length} new`);
        // A `sync` may also carry `want`: op-ids the hub is missing that this
        // device holds — its ops created while offline. Push them so they reach
        // the durable log + the other leaves. Skipping this is exactly why ops
        // made while a phone was offline never propagated once it came back
        // online (the hub only ever pushed ops down to us, never pulled ours up).
        if (msg.t === "sync" && Array.isArray(msg.want) && msg.want.length) {
          this._pushWanted(msg.want);
        }
      } else {
        dlog("sync: recv unknown message", msg.t);
      }
    };

    ws.onclose = (ev) => {
      this.onStatus("closed");
      // An abnormal close code is the single most useful troubleshooting signal:
      // 1008 = rejected (rate limit / bad trip id), 1009 = message too big,
      // 1006 = never established (often an upgrade 403/blocked, or hub down).
      if (!this.closed && ev && ev.code !== 1000 && ev.code !== 1001) {
        dwarn(`sync: closed code=${ev.code}${ev.reason ? " reason=" + ev.reason : ""} — will reconnect`);
      } else {
        dlog(`sync: closed code=${ev?.code}`);
      }
      if (this.closed) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
      setTimeout(() => !this.closed && this._open(), wait);
    };

    ws.onerror = (e) => {
      dwarn("sync: websocket error", e?.message || "(no detail — often an upgrade rejection or unreachable hub)");
      ws.close();
    };
  }

  // Answer the hub's `want` list (op-ids it's missing that we hold) by pushing
  // those ops back. Resolve ids we actually have (a stale/foreign id is just
  // skipped) and send them in bounded batches — a device that was offline a
  // long time can accumulate many ops, and a single frame must stay under the
  // hub's max-message cap (256 KiB by default). The hub dedupes on append, so
  // re-sending is always safe.
  _pushWanted(ids) {
    const ops = [];
    for (const id of ids) {
      const op = this.log.get(id);
      if (op) ops.push(op);
    }
    if (!ops.length) return;
    dlog(`sync: hub wants ${ids.length} ops — pushing ${ops.length} back`);
    const BATCH = 200;
    for (let i = 0; i < ops.length; i += BATCH) {
      this._send({ t: "ops", ops: ops.slice(i, i + BATCH) });
    }
  }

  _send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* not open yet / closing — the reconnect + hello will resync */
    }
  }
}
