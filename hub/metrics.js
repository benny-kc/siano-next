// Dependency-free Prometheus metrics for the hub.
//
// Grafana would be far too big for a single loopback-bound Node relay, so the
// hub instead exposes the numbers it already tracks in the Prometheus text
// exposition format at `GET /metrics`. That format is the lingua franca: you can
// `curl` it directly, or run Grafana Alloy/Agent on the host to scrape it and
// `remote_write` to Grafana Cloud's free tier — no inbound port, no TSDB, no
// dashboard server to run yourself.
//
// The endpoint is **token-gated and OFF by default**: with no SIANO_METRICS_TOKEN
// set it returns 404, because the series leak trip ids and activity volume (the
// hub has no auth — the trip URL is the capability). A scraper presents the token
// as `Authorization: Bearer <token>`.
//
// Counters accumulate over the process lifetime; gauges are sampled from the live
// hub state at scrape time. Per-trip series are labelled by trip id, which is
// already validated to `[A-Za-z0-9._~-]` on the way in, so it never needs label
// escaping — but the writer escapes defensively anyway.

/** Accumulating counters the hub bumps as it runs (gauges are sampled live). */
export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.wsOpened = 0; // WebSocket connections accepted
    this.wsClosed = 0; // …and closed
    this.messages = 0; // client frames parsed as JSON objects
    this.badJson = 0; // frames that failed to parse
    this.rateLimitCloses = 0; // connections closed for flooding (1008)
    this.opsAppended = 0; // ops accepted into a log (new, fanned out)
    this.opsRejected = 0; // ops refused: duplicate or hit a cap
    this.upgradeRejected = new Map(); // reason -> count (Origin, cap, bad request…)
    this.tripAppended = new Map(); // trip -> ops appended (per-trip counter)
    // Hub-to-hub (peer) sync — the dialer side counters, keyed by peer URL, plus
    // the acceptor-side auth-failure count. Link up/down is sampled live (gauges).
    this.peerConnects = new Map(); // peer url -> successful dials
    this.peerDisconnects = new Map(); // peer url -> link closures (→ reconnect)
    this.peerOpsIn = new Map(); // peer url -> ops ingested FROM the peer
    this.peerOpsOut = new Map(); // peer url -> ops forwarded TO the peer
    this.peerAuthFailures = 0; // inbound peer conns rejected for a bad token
  }

  _bump(map, key, n = 1) {
    map.set(key, (map.get(key) || 0) + n);
  }

  /** One op accepted into `trip`'s log. */
  appended(trip) {
    this.opsAppended += 1;
    this.tripAppended.set(trip, (this.tripAppended.get(trip) || 0) + 1);
  }

  /** `n` ops refused (duplicate or capped). */
  rejected(n = 1) {
    this.opsRejected += n;
  }

  /** A WebSocket upgrade refused, tallied by reason. */
  upgradeReject(reason) {
    this._bump(this.upgradeRejected, reason || "unknown");
  }

  // Peer (hub-to-hub) events, all keyed by the peer hub's URL. NB the method
  // names differ from the Map field names (peerOpsIn/peerOpsOut) on purpose — an
  // instance field would shadow a same-named prototype method.
  peerConnect(url) { this._bump(this.peerConnects, url); }
  peerDisconnect(url) { this._bump(this.peerDisconnects, url); }
  peerRecvOps(url, n) { if (n) this._bump(this.peerOpsIn, url, n); }
  peerSentOps(url, n) { if (n) this._bump(this.peerOpsOut, url, n); }
  /** An inbound peer connection rejected for presenting the wrong token. */
  peerAuthFail() { this.peerAuthFailures += 1; }
}

// Prometheus label values escape backslash, double-quote and newline. Trip ids
// are already validated so this is belt-and-braces (and guards the reason label).
const esc = (v) =>
  String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/**
 * Render the Prometheus text exposition for a scrape.
 * @param {Metrics} m accumulated counters
 * @param {{connections:number, rooms:Map<string,Set>, opCounts:Map<string,number>, tripsOnDisk:number}} live
 *   sampled hub state: live socket count, trip -> connected devices, trip -> ops
 *   held in memory, and the on-disk trip-file count.
 */
export function render(m, live) {
  const rooms = live.rooms || new Map();
  const opCounts = live.opCounts || new Map();
  const L = [];
  // A single metric family: HELP + TYPE header, then one or more samples.
  const emit = (name, type, help, samples) => {
    L.push(`# HELP ${name} ${help}`);
    L.push(`# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) L.push(`${name}${labels} ${value}`);
  };
  const one = (v) => [["", v]]; // an unlabelled single sample

  const mem = process.memoryUsage();

  emit("siano_up", "gauge", "1 if the hub is serving.", one(1));
  emit("siano_uptime_seconds", "gauge", "Seconds since the hub started.",
    one(((Date.now() - m.startedAt) / 1000).toFixed(1)));

  // Live gauges (sampled now).
  emit("siano_ws_connections", "gauge", "Currently open WebSocket connections.",
    one(live.connections || 0));
  emit("siano_trips_active", "gauge", "Trips with at least one live connection.",
    one(rooms.size));
  emit("siano_trips_total", "gauge", "Trip logs on disk.", one(live.tripsOnDisk || 0));

  // Lifetime counters.
  emit("siano_ws_opened_total", "counter", "WebSocket connections accepted.", one(m.wsOpened));
  emit("siano_ws_closed_total", "counter", "WebSocket connections closed.", one(m.wsClosed));
  emit("siano_messages_total", "counter", "Client frames parsed as JSON objects.", one(m.messages));
  emit("siano_bad_json_total", "counter", "Frames that failed to parse as JSON.", one(m.badJson));
  emit("siano_rate_limit_closes_total", "counter",
    "Connections closed for exceeding the message rate limit.", one(m.rateLimitCloses));
  emit("siano_ops_appended_total", "counter",
    "Ops accepted into a log (new; fanned out).", one(m.opsAppended));
  emit("siano_ops_rejected_total", "counter",
    "Ops refused (duplicate or hit a cap).", one(m.opsRejected));

  // Upgrade rejections, labelled by reason.
  emit("siano_ws_upgrade_rejected_total", "counter",
    "WebSocket upgrades refused, by reason.",
    m.upgradeRejected.size
      ? [...m.upgradeRejected].map(([reason, n]) => [`{reason="${esc(reason)}"}`, n])
      : [[`{reason="none"}`, 0]]);

  // Process gauges (handy without a node_exporter alongside).
  emit("siano_process_resident_memory_bytes", "gauge", "Resident set size.", one(mem.rss));
  emit("siano_process_heap_used_bytes", "gauge", "V8 heap in use.", one(mem.heapUsed));

  // Peer (hub-to-hub) sync. `live.peer` is sampled from the peer manager +
  // acceptor at scrape time; the counters below accumulate over the run. On a hub
  // with no peering configured, only siano_peer_configured (0) is emitted.
  const peer = live.peer || { configured: 0, inbound: 0, links: [] };
  emit("siano_peer_configured", "gauge", "Peer hub URLs this hub is configured to dial.", one(peer.configured || 0));
  emit("siano_peer_inbound_connections", "gauge", "Inbound peer-hub connections currently accepted.", one(peer.inbound || 0));
  const plinks = peer.links || [];
  if (plinks.length) {
    const lbl = (l) => `{peer="${esc(l.peer)}"}`;
    emit("siano_peer_link_up", "gauge", "1 if at least one per-trip link to this peer hub is open, else 0.",
      plinks.map((l) => [lbl(l), l.open > 0 ? 1 : 0]));
    emit("siano_peer_links_open", "gauge", "Per-trip links to this peer hub currently OPEN.",
      plinks.map((l) => [lbl(l), l.open]));
    emit("siano_peer_links_total", "gauge", "Per-trip links to this peer hub created (open or reconnecting).",
      plinks.map((l) => [lbl(l), l.total]));
  }
  const peerCounter = (name, help, map) => {
    if (map.size) emit(name, "counter", help, [...map].map(([p, n]) => [`{peer="${esc(p)}"}`, n]));
  };
  peerCounter("siano_peer_connects_total", "Successful dials to a peer hub.", m.peerConnects);
  peerCounter("siano_peer_disconnects_total", "Peer-hub link closures that triggered a reconnect.", m.peerDisconnects);
  peerCounter("siano_peer_ops_in_total", "Ops ingested from a peer hub.", m.peerOpsIn);
  peerCounter("siano_peer_ops_out_total", "Ops forwarded to a peer hub.", m.peerOpsOut);
  emit("siano_peer_auth_failures_total", "counter", "Inbound peer connections rejected for a bad token.", one(m.peerAuthFailures));

  // Per-trip series. The set of trips is the union of those with live rooms,
  // those loaded in memory, and those we've appended to this run.
  const trips = new Set([...rooms.keys(), ...opCounts.keys(), ...m.tripAppended.keys()]);
  if (trips.size) {
    const conn = [], ops = [], appended = [];
    for (const trip of trips) {
      const lbl = `{trip="${esc(trip)}"}`;
      conn.push([lbl, rooms.get(trip)?.size || 0]);
      ops.push([lbl, opCounts.get(trip) || 0]);
      appended.push([lbl, m.tripAppended.get(trip) || 0]);
    }
    emit("siano_trip_connections", "gauge", "Live device connections for a trip.", conn);
    emit("siano_trip_ops", "gauge", "Ops held in memory for a trip.", ops);
    emit("siano_trip_ops_appended_total", "counter", "Ops appended for a trip since start.", appended);
  }

  return L.join("\n") + "\n";
}
