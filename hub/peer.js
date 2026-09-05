// Hub-to-hub replication (Phase 2) — ONE always-on link per peer, multiplexing
// EVERY trip.
//
// Phase 1 opened a separate WebSocket per (peer, trip), lazily, the first time a
// local leaf touched a trip. Phase 2 replaces that with a single multiplexed
// connection per configured peer that:
//   • is ACTIVE, not lazy — the dialer opens it as soon as the hub is up and
//     keeps it up forever (reconnect with backoff), independent of any trip or
//     leaf. So there is never a moment where this hub has data to send but no
//     link to send it over: if the link is down the *peer* is down, and the
//     backlog flushes automatically the instant the link comes back.
//   • carries ALL trips over the one socket — every frame names its `trip`.
//   • is symmetric once up: whoever DIALS authenticates (sends the token); the
//     ACCEPTOR (a hub with no SIANO_PEER_URL — a passive listener) just answers.
//     A single dial is fully bidirectional, so a passive hub needs no config
//     beyond the shared token to both receive and send.
//
// Because ops are content-addressed + deduped (log.js) and the reducer is
// order-independent, replication needs no merge logic — a peer link is a "big
// leaf." A newly-ingested peer op is fanned to LOCAL leaves and re-forwarded to
// OTHER peer links (never back to its source); dedup (`append` → false) stops
// any loop, so a chain / star / full mesh all converge correctly.
//
// Wire protocol (JSON text frames; all but the handshake carry `trip`):
//   dialer → acceptor  { t:"phello", token? }            // authenticate the link
//   acceptor → dialer  { t:"ptrips", trips:[id,...] }     // announce my trip ids
//   dialer → acceptor  { t:"phave",  trip, have:[opId,...] } // reconcile one trip
//   either →           { t:"pwant",  trip, want:[opId,...] } // ids I lack, send them
//   either →           { t:"pops",   trip, ops:[...] }       // ops (reconcile + live)
// On connect the dialer reconciles the UNION of its own trips and the acceptor's
// announced trips; `phave` diffs both ways (missing ops pushed, wanted ops asked
// for), so any backlog on either side — including trips created while the link
// was down — flushes on every (re)connect. Live edits then flow as `pops`.
//
// AUTH: peer links offer the `siano-peer` subprotocol (ws.js exempts them from
// the Origin allowlist — a Node WS client sends no Origin) and present a shared
// token in `phello`. A mismatch is closed 1008. No token configured ⇒ accepted
// with a loud one-time warning. This authenticates the peer HUB, not individual
// ops (per-device op signing is still a roadmap item) — so only link hubs you
// operate. See docs/security.md → Hub-to-hub sync.

import { opId } from "../client/js/core/lamport.js";
import { isValidOp } from "./log.js";
import { PEER_SUBPROTOCOL } from "./ws.js";

const OPS_BATCH = 200; // ops per `pops` frame — keeps a frame well under the cap

// One authenticated peer session over a transport (an outbound dialed socket or
// an inbound accepted Conn). Symmetric after the handshake; `role` only decides
// who speaks first and who initiates reconciliation.
class Session {
  /**
   * @param {{label:string, send:(obj:object)=>void, close:(code?:number)=>void}} tx
   * @param {"dialer"|"acceptor"} role
   * @param {object} mgr the PeerManager internals
   */
  constructor(tx, role, mgr) {
    this.tx = tx;
    this.role = role;
    this.mgr = mgr;
    this.registered = false;
  }

  // Dialer speaks first (phello, then reconcile once it hears ptrips). Acceptor
  // waits for phello before doing anything.
  start() {
    if (this.role !== "dialer") return;
    this.tx.send({ t: "phello", ...(this.mgr.token ? { token: this.mgr.token } : {}) });
    this._register();
  }

  _register() {
    if (this.registered) return;
    this.registered = true;
    this.mgr.registry.add(this);
  }

  onClose() {
    if (!this.registered) return;
    this.registered = false;
    this.mgr.registry.delete(this);
  }

  async onFrame(msg) {
    if (!msg || typeof msg !== "object") return;
    const { logs, warn, debug, isValidTrip } = this.mgr.deps;
    switch (msg.t) {
      case "phello": {
        if (this.role !== "acceptor") return; // a dialer never receives phello
        if (this.mgr.token) {
          if (msg.token !== this.mgr.token) {
            this.mgr.metrics?.peerAuthFail();
            warn(`peer: inbound auth failed from ${this.tx.label} — closing 1008`);
            this.tx.close(1008);
            return;
          }
        } else {
          this.mgr.warnNoToken(this.tx.label);
        }
        this._register();
        // Announce our trips so the dialer reconciles the union of both sides.
        this.tx.send({ t: "ptrips", trips: logs.trips() });
        debug(`peer: inbound link up from ${this.tx.label}`);
        return;
      }
      case "ptrips": {
        if (this.role !== "dialer") return;
        this._reconcile(Array.isArray(msg.trips) ? msg.trips : []);
        return;
      }
      case "phave": {
        if (!isValidTrip(msg.trip)) return;
        // Push what they lack, ask for what we lack — both directions in one step.
        this._sendOps(msg.trip, logs.missing(msg.trip, msg.have));
        const want = logs.wanted(msg.trip, msg.have);
        if (want.length) this.tx.send({ t: "pwant", trip: msg.trip, want });
        return;
      }
      case "pwant": {
        if (!isValidTrip(msg.trip) || !Array.isArray(msg.want)) return;
        this._sendOps(msg.trip, logs.pick(msg.trip, msg.want));
        return;
      }
      case "pops": {
        if (!isValidTrip(msg.trip) || !Array.isArray(msg.ops)) return;
        await this._ingest(msg.trip, msg.ops);
        return;
      }
      default:
        debug(`peer: unknown frame t=${msg.t} from ${this.tx.label}`);
    }
  }

  // Dialer only: reconcile the union of our trips and theirs. `phave` for each
  // pulls what we're missing AND offers what they're missing, so a single pass
  // converges both hubs (including trips created while the link was down).
  _reconcile(theirTrips) {
    const { logs, debug, isValidTrip } = this.mgr.deps;
    const union = new Set(logs.trips());
    for (const t of theirTrips) if (typeof t === "string") union.add(t);
    debug(`peer: reconciling ${union.size} trips with ${this.tx.label}`);
    for (const trip of union) {
      if (!isValidTrip(trip)) continue;
      this.tx.send({ t: "phave", trip, have: logs.all(trip).map(opId) });
    }
  }

  // Append peer ops to our durable log; fan the NEW ones to LOCAL leaves and
  // re-forward them to OTHER peer links (never this one). Dedup stops loops.
  async _ingest(trip, ops) {
    const { logs, fanout, debug } = this.mgr.deps;
    const added = [];
    for (const op of ops) {
      if (isValidOp(op) && (await logs.append(trip, op))) added.push(op);
    }
    if (!added.length) return;
    this.mgr.metrics?.peerRecvOps(this.tx.label, added.length);
    debug(`peer: ingested ${added.length}/${ops.length} for ${trip} from ${this.tx.label}`);
    fanout(trip, { t: "ops", ops: added }); // local leaves
    this.mgr.broadcastOps(trip, added, this); // other peers (except source)
  }

  // Send ops for a trip as batched `pops` frames (bounded by the peer frame cap).
  _sendOps(trip, ops) {
    if (!ops || !ops.length) return;
    for (let i = 0; i < ops.length; i += OPS_BATCH) {
      const batch = ops.slice(i, i + OPS_BATCH);
      this.tx.send({ t: "pops", trip, ops: batch });
      this.mgr.metrics?.peerSentOps(this.tx.label, batch.length);
    }
  }
}

// One outbound dialer: keeps a single multiplexed link to `url` up forever.
class OutboundPeer {
  constructor(url, mgr) {
    this.url = url;
    this.mgr = mgr;
    this.ws = null;
    this.session = null;
    this.backoff = 500;
    this.maxBackoff = 30000;
    this.closed = false;
  }

  start() {
    this.closed = false;
    this._open();
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }

  /** For metrics.sample(): is the link currently up? */
  get up() {
    return !!this.session;
  }

  _open() {
    const { warn, debug } = this.mgr.deps;
    let ws;
    try {
      ws = new WebSocket(this.url, PEER_SUBPROTOCOL);
    } catch (e) {
      warn(`peer: cannot dial ${this.url}: ${e.message}`);
      this._reconnect();
      return;
    }
    this.ws = ws;
    debug(`peer: dialing ${this.url}`);
    const tx = {
      label: this.url,
      send: (obj) => {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          /* closing — reconnect + reconcile will catch up */
        }
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      },
    };

    ws.onopen = () => {
      this.backoff = 500;
      this.mgr.metrics?.peerConnect(this.url);
      this.session = new Session(tx, "dialer", this.mgr);
      this.session.start();
      debug(`peer: link up ${this.url}`);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.session?.onFrame(msg).catch((e) => warn(`peer: frame error ${this.url}: ${e.message}`));
    };
    ws.onclose = () => {
      const wasUp = !!this.session;
      if (this.session) {
        this.session.onClose();
        this.session = null;
      }
      if (this.closed) return;
      if (wasUp) this.mgr.metrics?.peerDisconnect(this.url);
      this._reconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  _reconnect() {
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.mgr.deps.debug(`peer: ${this.url} down — reconnect in ${wait}ms`);
    setTimeout(() => !this.closed && this._open(), wait);
  }
}

/**
 * Peer manager: one always-on multiplexed link per configured peer URL, plus a
 * registry of every authenticated session (outbound + inbound) for fan-out.
 * @param {{urls?: string[], token?: string, logs: import("./log.js").TripLogs,
 *   fanout: (trip: string, obj: object, except?: any) => void,
 *   isValidTrip?: (id:any)=>boolean, warn?: Function, debug?: Function,
 *   metrics?: object}} deps
 */
export function createPeers(deps) {
  const urls = (deps.urls || []).filter(Boolean);
  const token = deps.token || "";
  const warn = deps.warn || (() => {});
  const debug = deps.debug || (() => {});
  const metrics = deps.metrics || null;
  const isValidTrip = deps.isValidTrip || (() => true);

  const registry = new Set(); // authenticated Sessions (outbound + inbound)
  const dialers = []; // OutboundPeer[]
  let noTokenWarned = false;

  const mgr = {
    token,
    metrics,
    registry,
    deps: { logs: deps.logs, fanout: deps.fanout, isValidTrip, warn, debug },
    warnNoToken(label) {
      if (noTokenWarned) return;
      noTokenWarned = true;
      warn(`peer: inbound peer ${label} connected WITHOUT a token — any client offering the peer subprotocol can inject ops. Set SIANO_PEER_TOKEN on both hubs.`);
    },
    // Forward ops for a trip to every peer session except `except` (the source).
    broadcastOps(trip, ops, except) {
      if (!registry.size || !ops || !ops.length) return;
      for (const s of registry) if (s !== except) s._sendOps(trip, ops);
    },
  };

  // Begin (and forever maintain) the outbound links. Called when the hub is up.
  function start() {
    for (const url of urls) {
      const d = new OutboundPeer(url, mgr);
      dialers.push(d);
      d.start();
    }
  }

  // Adopt an inbound peer connection (ws.js flagged conn.isPeer). It authenticates
  // by sending `phello`; until then it's parked (not in the registry).
  function onInboundConn(conn) {
    const tx = {
      label: conn.ip || "inbound",
      send: (obj) => {
        try {
          conn.send(JSON.stringify(obj));
        } catch {
          /* peer gone */
        }
      },
      close: (code) => {
        try {
          conn.close(code || 1008);
        } catch {
          /* already closing */
        }
      },
    };
    const session = new Session(tx, "acceptor", mgr);
    conn.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      session.onFrame(msg).catch((e) => warn(`peer: inbound frame error: ${e.message}`));
    });
    conn.on("close", () => session.onClose());
  }

  // Forward a local-leaf op (or batch) to all peer links. Called from server.js
  // after the op is appended + fanned to local leaves.
  function broadcastOp(trip, op) {
    mgr.broadcastOps(trip, [op], null);
  }
  function broadcastOps(trip, ops) {
    mgr.broadcastOps(trip, ops, null);
  }

  function shutdown() {
    for (const d of dialers) d.close();
    for (const s of [...registry]) s.tx.close(1001);
    registry.clear();
  }

  // Live snapshot for metrics: one entry per configured peer URL with whether its
  // always-on link is currently up (open 1/0, total 1). Inbound links are counted
  // separately by the server (they have no stable URL label).
  function sample() {
    return {
      configured: urls.length,
      links: dialers.map((d) => ({ peer: d.url, open: d.up ? 1 : 0, total: 1 })),
    };
  }

  return {
    start,
    onInboundConn,
    broadcastOp,
    broadcastOps,
    shutdown,
    sample,
    enabled: urls.length > 0,
    urls,
    get size() {
      return registry.size;
    },
  };
}
