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
//   hub -> client  { t:"sync",  ops:[...] }        // ops the client lacked
//   client -> hub  { t:"op",    op }               // a new local op
//   hub -> client  { t:"op",    op } | { t:"ops", ops:[...] }   // fan-out

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
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.onStatus("open");
      this._send({ t: "hello", trip: this.log.tripId, have: this.log.have() });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === "op" && msg.op) this.log.ingestMany([msg.op]);
      else if ((msg.t === "ops" || msg.t === "sync") && Array.isArray(msg.ops)) {
        this.log.ingestMany(msg.ops);
      }
    };

    ws.onclose = () => {
      this.onStatus("closed");
      if (this.closed) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
      setTimeout(() => !this.closed && this._open(), wait);
    };

    ws.onerror = () => ws.close();
  }

  _send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* not open yet / closing — the reconnect + hello will resync */
    }
  }
}
