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
//
// ANTI-ENTROPY. The hello/sync/want exchange is also run PERIODICALLY and on wake
// (tab foregrounded, network back), not only on (re)connect. Live op broadcast is
// fire-and-forget: an op can be lost while the socket still looks OPEN (a
// half-open mobile radio, a frozen/backgrounded PWA, a dropped frame), and with
// recovery previously tied only to a full reconnect handshake, a single op could
// stay stranded on the OTHER device for the rest of a long-lived session — the
// "one phone shows 4 travellers, the other only 3, and it never catches up" bug.
// Re-sending `hello` on a live socket reconciles the delta both ways and heals it.
//
// END-TO-END ENCRYPTION. This client is the boundary where ops leave the device,
// so it is where they get sealed. Every op on the wire is an ENCRYPTED ENVELOPE
// (crypto.js) — the hub relays opaque ciphertext and never holds the key. Local
// ops are `encrypt`ed just before send; incoming envelopes are `decrypt`ed before
// they enter the log. `have`/`want` negotiate on the plaintext op-id (`op.id`),
// which the envelope also carries, so delta reconciliation is unchanged. When no
// `crypto` is supplied (an insecure context, or a locked trip) we send/ingest ops
// as-is — the hub falls back to today's plaintext relay.

import { dlog, dwarn } from "../log.js";
import { registerVersion } from "../version.js";
registerVersion("js/sync/client.js", 3);

// How often, while a connection stays OPEN, to re-run the delta exchange as an
// anti-entropy sweep (see `_resync`). Modest — a stranded op is picked up within
// this window without a device having to fully disconnect first.
const RESYNC_MS = 20000;

export class SyncClient {
  /**
   * @param {string} url   ws:// or wss:// hub URL
   * @param {import("../store/oplog.js").OpLog} log
   * @param {{onStatus?: (s: "connecting"|"open"|"closed") => void, crypto?: {encrypt(op):Promise<object>, decrypt(env):Promise<object>}|null, resyncMs?: number}} [opts]
   */
  constructor(url, log, opts = {}) {
    this.url = url;
    this.log = log;
    this.onStatus = opts.onStatus || (() => {});
    this.crypto = opts.crypto || null; // end-to-end envelope crypto, or null (plaintext)
    this.ws = null;
    this.backoff = 1000;
    this.maxBackoff = 30000;
    this.closed = false;
    this.resyncMs = opts.resyncMs || RESYNC_MS;
    this.resyncTimer = null;

    // Broadcast local ops as they're created (remote ops carry local=false and
    // are never echoed back — that would loop). Each op is sealed before it leaves.
    this._unsub = log.subscribe(({ ops, local }) => {
      if (!local || !this._isOpen()) return;
      for (const op of ops) this._sealAndSend({ t: "op" }, op);
    });

    // Anti-entropy trigger: something woke this device (tab foregrounded, network
    // came back). A live op can be lost with the socket still looking OPEN — a
    // half-open mobile radio, a backgrounded/frozen PWA on iOS, a dropped frame —
    // and until now nothing re-checked the delta unless the socket fully closed
    // and re-handshook. That stranded exactly one op on the peer (the "one phone
    // has 4 travellers, the other only 3, forever" report) while every later edit
    // still flowed. So re-run the delta exchange on wake, not only on reconnect.
    this._onWake = () => {
      if (globalThis.document && globalThis.document.visibilityState === "hidden") return;
      this._resync("wake");
    };
  }

  // Encrypt (when crypto is configured) then send. Order within a batch doesn't
  // matter — the hub dedups by op-id and the reducer is order-independent — so a
  // per-op async seal that resolves out of order is fine.
  async _sealAndSend(frame, op) {
    try {
      const payload = this.crypto ? await this.crypto.encrypt(op) : op;
      if (this._isOpen()) this._send({ ...frame, op: payload });
    } catch (e) {
      dwarn("sync: failed to encrypt op, not sent", e?.message || e);
    }
  }

  // Decrypt a batch of incoming envelopes (dropping any that fail to open) and
  // ingest the plaintext ops. Returns the ops that were new.
  async _ingestEnvelopes(envs) {
    const plain = [];
    for (const env of envs) {
      try {
        plain.push(this.crypto ? await this.crypto.decrypt(env) : env);
      } catch (e) {
        dwarn("sync: failed to decrypt an op, skipped", e?.message || e);
      }
    }
    return this.log.ingestMany(plain);
  }

  connect() {
    this.closed = false;
    // Wake events (guarded — this module also runs under `node --test`, where
    // there is no document/window). Recover a stranded op the moment a device
    // comes back to life instead of waiting for the periodic sweep or a full
    // reconnect that may never come while the app stays foregrounded.
    globalThis.document?.addEventListener?.("visibilitychange", this._onWake);
    globalThis.addEventListener?.("online", this._onWake);
    globalThis.addEventListener?.("pageshow", this._onWake);
    this._open();
    return this;
  }

  close() {
    this.closed = true;
    this._unsub?.();
    this._stopResync();
    globalThis.document?.removeEventListener?.("visibilitychange", this._onWake);
    globalThis.removeEventListener?.("online", this._onWake);
    globalThis.removeEventListener?.("pageshow", this._onWake);
    this.ws?.close();
  }

  _isOpen() {
    return this.ws && this.ws.readyState === 1; // WebSocket.OPEN
  }

  // Re-run the delta exchange on a LIVE connection (anti-entropy). Sending
  // `hello` again is exactly the reconcile the hub already answers on (re)connect:
  // it replies with `sync` (ops we lack) + `want` (ops it lacks that we hold), so
  // a single op lost in either direction over a still-open socket is recovered
  // without tearing the connection down. The hub's hello handler is idempotent
  // (join is a Set add), so repeating it is safe and cheap — it carries only op
  // ids. No-op when the socket isn't open (the next onopen will hello anyway).
  _resync(why) {
    if (!this._isOpen()) return;
    const have = this.log.have();
    dlog(`sync: resync (${why}) — hello trip=${this.log.tripId} have=${have.length} ops`);
    this._send({ t: "hello", trip: this.log.tripId, have });
  }

  _startResync() {
    this._stopResync();
    if (!this.resyncMs) return;
    this.resyncTimer = setInterval(() => this._resync("periodic"), this.resyncMs);
    // Don't keep a Node process (tests) alive just for the sweep.
    this.resyncTimer?.unref?.();
  }

  _stopResync() {
    if (this.resyncTimer) { clearInterval(this.resyncTimer); this.resyncTimer = null; }
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
      // Keep reconciling while the link stays up (anti-entropy) — a live op can be
      // silently dropped without the socket ever closing, and nothing else would
      // notice until the next full reconnect.
      this._startResync();
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
        this._ingestEnvelopes([msg.op]).then((added) =>
          dlog(`sync: recv op (${added.length ? "new" : "dup"})`));
      } else if ((msg.t === "ops" || msg.t === "sync") && Array.isArray(msg.ops)) {
        this._ingestEnvelopes(msg.ops).then((added) =>
          dlog(`sync: recv ${msg.t} — ${msg.ops.length} ops, ${added.length} new`));
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
      this._stopResync();
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
  async _pushWanted(ids) {
    const ops = [];
    for (const id of ids) {
      const op = this.log.get(id);
      if (op) ops.push(op);
    }
    if (!ops.length) return;
    dlog(`sync: hub wants ${ids.length} ops — pushing ${ops.length} back`);
    // Seal each before it leaves (or pass through when crypto is off).
    const sealed = [];
    for (const op of ops) {
      try {
        sealed.push(this.crypto ? await this.crypto.encrypt(op) : op);
      } catch (e) {
        dwarn("sync: failed to encrypt a wanted op, skipped", e?.message || e);
      }
    }
    if (!sealed.length || !this._isOpen()) return;
    const BATCH = 200;
    for (let i = 0; i < sealed.length; i += BATCH) {
      this._send({ t: "ops", ops: sealed.slice(i, i + BATCH) });
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
