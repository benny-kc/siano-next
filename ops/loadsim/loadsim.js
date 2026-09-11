// Siano hub load simulator — a dependency-free driver that opens many WebSocket
// "leaf" connections, drives realistic op traffic, and measures the hub's
// behaviour under it. Point it at ONE hub (through its Cloudflare Tunnel, or
// straight at loopback in dev) and it reports connect success/latency, op
// throughput, end-to-end RELAY latency (writer → hub → another device), and a
// histogram of WebSocket close codes (the single most useful "why did it break"
// signal — 1008 rate limit, 1009 too big, 1006 an edge/handshake rejection).
//
// Why hand no dependencies: the whole project is buildless + zero-dep, and the
// leaf protocol is tiny (hello / sync / op / ops, see hub/server.js). We speak
// it over Node's BUILT-IN WebSocket (undici), which — unlike a browser — lets us
// set request headers. That is what makes this work through Cloudflare's
// security, not just a bare tunnel:
//   • Origin allowlist (SIANO_ALLOWED_ORIGINS): a browser always sends Origin
//     and the hub rejects a mismatch with 403. We set --origin so the upgrade
//     passes. (A plain Node client sends none and would be refused.)
//   • Cloudflare Access: if Access sits in front, an interactive login gates the
//     edge — a headless flood can't answer it. Instead we present an Access
//     SERVICE TOKEN via the CF-Access-Client-Id / CF-Access-Client-Secret
//     headers, which Access validates at the edge and lets through to the
//     tunnel. Pass --cf-access-id/--cf-access-secret or the CF_ACCESS_CLIENT_ID/
//     CF_ACCESS_CLIENT_SECRET env vars.
// See ops/loadsim/README.md for the full Cloudflare playbook (WAF rate-limit
// rules, Bot Fight Mode, wss, concurrency).
//
// The ops it emits are REAL: stamped through client/js/core (Clock + ops.js), so
// they fold cleanly and exercise the same durable-append + fan-out path a real
// device does. Each op also carries a private `_lt` (load-test send time) so a
// second device on the same trip can measure how long the hub took to relay it.
// `_lt` rides along in the stored op — harmless, but a reason to use THROWAWAY
// trip ids (the default) and not aim this at a production trip.
//
// Usable two ways:
//   • as a CLI: `node ops/loadsim/loadsim.js --url wss://hub-a.example.com …`
//   • as a module: `import { runLoad } from ".../loadsim.js"` (the test does
//     this against an in-process hub).

import { Clock } from "../../client/js/core/lamport.js";
import * as ops from "../../client/js/core/ops.js";

// ---- small stats helpers ---------------------------------------------------

// Percentile from an UNSORTED sample array (nearest-rank). Returns 0 for empty.
function pct(samples, p) {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
function summarize(samples) {
  const count = samples.length;
  const mean = count ? samples.reduce((a, b) => a + b, 0) / count : 0;
  return {
    count,
    mean: Math.round(mean * 100) / 100,
    p50: pct(samples, 50),
    p90: pct(samples, 90),
    p99: pct(samples, 99),
    max: count ? Math.max(...samples) : 0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A realistic-ish op stream for one device: occasionally add a fresh meal (with
// a payer + participant), otherwise mutate a meal it already made (amount / name
// / board position). Everything is reducer-valid and money stays integer cents.
function makeOpGen(clock, memberId) {
  const meals = [];
  let n = 0;
  return () => {
    n += 1;
    if (!meals.length || n % 5 === 0) {
      const mealId = `${clock.device}.m${meals.length}`;
      meals.push(mealId);
      // Emit the add + a payer/participant as ONE op each turn in rotation would
      // undercount; the add alone is enough to keep the log growing realistically
      // and later mutations reference it.
      return ops.addMeal(clock, mealId, { name: `Bill ${meals.length}`, payerId: memberId });
    }
    const mealId = meals[n % meals.length];
    const roll = n % 3;
    if (roll === 0) return ops.setAmount(clock, mealId, 100 + ((n * 137) % 90000));
    if (roll === 1) return ops.moveMeal(clock, mealId, (n * 31) % 1000, (n * 17) % 1000);
    return ops.setMealName(clock, mealId, `Bill ${mealId.slice(-2)} v${n}`);
  };
}

// ---- one virtual device ----------------------------------------------------

// Drives a single WebSocket leaf: connect → hello → emit ops at `rate`/s while
// listening for the hub to relay OTHER devices' ops back (that round trip is the
// relay-latency sample). It records into the shared `stats` accumulator and
// never throws — a connection failure is data, not a crash.
class SimDevice {
  constructor({ url, trip, index, tag, rate, headers, stats, now, WebSocketImpl }) {
    this.url = url;
    this.trip = trip;
    // `tag` namespaces device ids so two simulator processes sharing one trip
    // (writers on hub A, readers on hub B) don't collide on `${trip}.d0`.
    this.deviceId = `${trip}.${tag || "d"}${index}`;
    this.rate = rate;
    this.headers = headers;
    this.stats = stats;
    this.now = now;
    this.WebSocketImpl = WebSocketImpl;
    this.clock = new Clock(this.deviceId);
    this.memberId = `${this.deviceId}.me`;
    this.gen = makeOpGen(this.clock, this.memberId);
    this.ws = null;
    this.open = false;
    this.emitTimer = null;
    this.connectStart = 0;
  }

  start() {
    this.stats.connections.attempted += 1;
    this.connectStart = this.now();
    let ws;
    try {
      // undici's WebSocket accepts a non-standard `headers` option — this is the
      // whole reason a headless client can satisfy the Origin allowlist and a
      // Cloudflare Access service token.
      ws = new this.WebSocketImpl(this.url, this.headers ? { headers: this.headers } : undefined);
    } catch (e) {
      this.stats.connections.failed += 1;
      bump(this.stats.errors, e?.message || "constructor threw");
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.open = true;
      this.stats.connections.opened += 1;
      this.stats.connectLatencyMs.push(this.now() - this.connectStart);
      // Fresh throwaway trip: nothing to catch up on, but the hello is mandatory
      // (the hub ignores ops before it) and the sync reply confirms the room.
      this._send({ t: "hello", trip: this.trip, have: [] });
      const periodMs = Math.max(1, Math.round(1000 / this.rate));
      this.emitTimer = setInterval(() => this._emit(), periodMs);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const list = msg.t === "op" ? [msg.op] : Array.isArray(msg.ops) ? msg.ops : [];
      for (const op of list) {
        if (!op) continue;
        this.clock.observe(op);
        // A relayed op that we did NOT author, carrying a load-test send time, is
        // one end-to-end round trip: writer → hub → us. That is the number that
        // matters through Cloudflare.
        if (op._lt && op.device !== this.deviceId) {
          this.stats.relayLatencyMs.push(this.now() - op._lt);
          this.stats.ops.relayed += 1;
        }
      }
    };

    ws.onclose = (ev) => {
      this.open = false;
      clearInterval(this.emitTimer);
      // 1006 = never cleanly established / abnormal (an edge or handshake reject
      // — Origin, Access, WAF, or the hub simply down). 1000/1001 = our own
      // teardown at end of run. Everything else is the hub telling us why.
      bump(this.stats.closeCodes, String(ev?.code ?? "none"));
    };

    ws.onerror = (ev) => {
      // undici surfaces the handshake failure here (e.g. a 403 from the Origin
      // allowlist or a blocked Access request). Keep the message; the close
      // follows with 1006.
      const m = ev?.error?.message || ev?.message || "websocket error";
      bump(this.stats.errors, m);
    };
  }

  _emit() {
    if (!this.open) return;
    const op = this.gen();
    op._lt = this.now(); // private load-test send timestamp (see file header)
    if (this._send({ t: "op", op })) this.stats.ops.emitted += 1;
  }

  _send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false; // closing/closed — counted via closeCodes already
    }
  }

  stop() {
    clearInterval(this.emitTimer);
    try {
      this.ws?.close(1000);
    } catch {
      /* already gone */
    }
  }
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

// ---- the run ---------------------------------------------------------------

/**
 * Run a load test against one hub and resolve to a stats object.
 *
 * @param {object} o
 * @param {string} o.url                 ws:// or wss:// hub URL (no path)
 * @param {number} [o.trips=1]           distinct trip ids (each its own room)
 * @param {number} [o.devicesPerTrip=2]  connections per trip (≥2 to measure relay)
 * @param {number} [o.rate=5]            ops/sec each device emits
 * @param {number} [o.durationMs=10000]  how long to hold the load
 * @param {number} [o.rampMs=0]          spread the connection opens over this window
 * @param {number} [o.drainMs=1000]      wait after stopping emits to collect in-flight relays
 * @param {string|null} [o.origin=null]  Origin header (satisfy SIANO_ALLOWED_ORIGINS)
 * @param {object} [o.headers={}]        extra request headers (CF Access service token, …)
 * @param {string} [o.tripPrefix]        trip-id prefix (a run nonce is appended)
 * @param {string|null} [o.nonce]        run nonce appended to trip ids; pass "" to
 *                                       get DETERMINISTIC ids (`prefix-0`, …) so two
 *                                       runs against two hubs share the same trips
 * @param {string} [o.deviceTag="d"]     namespaces device ids; give each of two
 *                                       cross-hub runs a different tag so they don't collide
 * @param {() => number} [o.now]         clock (injectable for tests)
 * @param {(s:string)=>void} [o.log]     progress logger
 * @param {typeof WebSocket} [o.WebSocketImpl]
 */
export async function runLoad(o) {
  const {
    url,
    trips = 1,
    devicesPerTrip = 2,
    rate = 5,
    durationMs = 10000,
    rampMs = 0,
    drainMs = 1000,
    origin = null,
    headers = {},
    tripPrefix = "loadsim",
    nonce,
    deviceTag = "d",
    now = Date.now,
    log = () => {},
    WebSocketImpl = globalThis.WebSocket,
  } = o;

  if (!url) throw new Error("runLoad: url is required");
  if (!WebSocketImpl) throw new Error("runLoad: no WebSocket implementation (Node 18+ has a global)");

  const reqHeaders = { ...headers };
  if (origin) reqHeaders["Origin"] = origin;
  const hasHeaders = Object.keys(reqHeaders).length > 0;

  const stats = {
    config: { url, trips, devicesPerTrip, rate, durationMs, rampMs, origin: origin || null },
    connections: { attempted: 0, opened: 0, failed: 0 },
    closeCodes: {},
    errors: {},
    connectLatencyMs: [],
    relayLatencyMs: [],
    ops: { emitted: 0, relayed: 0 },
  };

  // Trip ids stay valid (^[A-Za-z0-9._~-]+). By default a short random nonce
  // keeps re-runs (and two concurrent runs) from piling onto the same log. Pass
  // nonce="" for DETERMINISTIC ids — that's how writers on hub A and readers on
  // hub B land on the SAME trips and cross-hub sync can be observed/measured.
  const runNonce = nonce === undefined ? Math.random().toString(36).slice(2, 8) : String(nonce);
  const total = trips * devicesPerTrip;
  const devices = [];
  for (let t = 0; t < trips; t++) {
    const trip = runNonce ? `${tripPrefix}-${runNonce}-${t}` : `${tripPrefix}-${t}`;
    for (let d = 0; d < devicesPerTrip; d++) {
      devices.push(new SimDevice({
        url, trip, index: d, tag: deviceTag, rate,
        headers: hasHeaders ? reqHeaders : null,
        stats, now, WebSocketImpl,
      }));
    }
  }

  log(`loadsim: ${total} connections (${trips} trips × ${devicesPerTrip}) → ${url}`);
  log(`loadsim: ${rate} ops/s per device ⇒ ~${total * rate} ops/s offered for ${durationMs / 1000}s`);

  // Ramp the connection opens so we don't slam Cloudflare with a burst that
  // looks like an attack (and to model users trickling in). rampMs=0 = all at once.
  const gap = rampMs > 0 && total > 1 ? rampMs / total : 0;
  const startWall = now();
  for (const dev of devices) {
    dev.start();
    if (gap) await sleep(gap);
  }

  // Hold the load. (The ramp already consumed some wall-clock; hold for the
  // remainder so the total run is ~durationMs of steady state after ramp.)
  await sleep(durationMs);

  // Stop emitting, then drain briefly so relays already in flight are counted
  // before we tear the sockets down.
  for (const dev of devices) clearInterval(dev.emitTimer);
  await sleep(drainMs);
  for (const dev of devices) dev.stop();
  await sleep(100); // let close frames flush / onclose fire

  const wallMs = now() - startWall;
  const secs = Math.max(0.001, (durationMs) / 1000);
  return {
    ...stats,
    durationMs,
    wallMs,
    connectLatencyMs: summarize(stats.connectLatencyMs),
    relayLatencyMs: summarize(stats.relayLatencyMs),
    ops: {
      ...stats.ops,
      emitRatePerSec: Math.round(stats.ops.emitted / secs),
      relayRatePerSec: Math.round(stats.ops.relayed / secs),
    },
  };
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true; // bare flag
    else { out[key] = next; i++; }
  }
  return out;
}

const USAGE = `Siano hub load simulator

Usage:
  node ops/loadsim/loadsim.js --url wss://hub.example.com [options]

Options:
  --url URL            Hub WebSocket URL (ws:// or wss://). REQUIRED.
  --trips N            Distinct trips / rooms (default 1)
  --devices N          Devices per trip; ≥2 to measure relay latency (default 2)
  --rate N             Ops/sec per device (default 5). NB the hub closes a
                       connection 1008 above SIANO_MAX_MSGS_PER_SEC (default 50).
  --duration SECONDS   Hold the load this long (default 10)
  --ramp SECONDS       Spread connection opens over this window (default 0 = burst)
  --origin URL         Origin header — set it to your app URL if the hub runs
                       SIANO_ALLOWED_ORIGINS, else the upgrade is 403'd.
  --trip-prefix STR    Trip-id prefix (default "loadsim"). A random run nonce is
                       appended unless --fixed-trips is given.
  --fixed-trips        Deterministic trip ids ("<prefix>-0", …) with NO random
                       nonce — so a run against hub A and a run against hub B use
                       the SAME trips and you can watch/measure cross-hub sync.
  --device-tag STR     Namespace this run's device ids (default "d"). Give two
                       cross-hub runs different tags (e.g. --device-tag a / b) so
                       their devices don't collide on a shared trip.
  --cf-access-id ID    Cloudflare Access service-token Client-Id  (or env CF_ACCESS_CLIENT_ID)
  --cf-access-secret S Cloudflare Access service-token Client-Secret (or env CF_ACCESS_CLIENT_SECRET)
  --header 'K: V'      Extra request header (repeatable) for any other edge auth
  --json               Print the raw stats object as JSON (for scripting)
  --help               This help

Examples:
  # Local dev hub, 50 connections, 10s
  node ops/loadsim/loadsim.js --url ws://127.0.0.1:4000 --trips 25 --devices 2

  # Through Cloudflare Tunnel with an Origin allowlist + Access service token
  node ops/loadsim/loadsim.js --url wss://siano.example.com \\
    --origin https://siano.example.com \\
    --cf-access-id "$CF_ACCESS_CLIENT_ID" --cf-access-secret "$CF_ACCESS_CLIENT_SECRET" \\
    --trips 100 --devices 3 --rate 4 --duration 60 --ramp 10
`;

function fmt(stats) {
  const cc = Object.entries(stats.closeCodes).map(([k, v]) => `${k}:${v}`).join(" ") || "(none)";
  const errs = Object.entries(stats.errors);
  const lat = (s) => `n=${s.count} p50=${s.p50}ms p90=${s.p90}ms p99=${s.p99}ms max=${s.max}ms`;
  const lines = [
    "",
    "── load simulator result ─────────────────────────────────",
    `  target        : ${stats.config.url}`,
    `  offered load  : ${stats.config.trips} trips × ${stats.config.devicesPerTrip} devices` +
      ` @ ${stats.config.rate} ops/s ⇒ ~${stats.config.trips * stats.config.devicesPerTrip * stats.config.rate} ops/s`,
    `  duration      : ${stats.durationMs / 1000}s (wall ${Math.round(stats.wallMs / 1000)}s)`,
    "",
    `  connections   : ${stats.connections.opened}/${stats.connections.attempted} opened` +
      `${stats.connections.failed ? `, ${stats.connections.failed} failed to construct` : ""}`,
    `  connect latency: ${lat(stats.connectLatencyMs)}`,
    `  close codes   : ${cc}`,
    "",
    `  ops emitted   : ${stats.ops.emitted}  (${stats.ops.emitRatePerSec}/s)`,
    `  ops relayed   : ${stats.ops.relayed}  (${stats.ops.relayRatePerSec}/s)`,
    `  relay latency : ${lat(stats.relayLatencyMs)}`,
  ];
  if (errs.length) {
    lines.push("", "  errors:");
    for (const [msg, n] of errs) lines.push(`    ${n}× ${msg}`);
  }
  // A little interpretation so a failed run isn't a silent mystery.
  const hints = [];
  if (stats.closeCodes["1008"]) hints.push("1008 = rate-limited: --rate exceeds SIANO_MAX_MSGS_PER_SEC, or a Cloudflare WAF rate-limit rule fired.");
  if (stats.closeCodes["1009"]) hints.push("1009 = message too big: a frame exceeded SIANO_MAX_MSG_BYTES.");
  if (stats.closeCodes["1006"] || stats.connections.opened < stats.connections.attempted) {
    hints.push("1006 / unopened = the upgrade never completed: check --origin (SIANO_ALLOWED_ORIGINS), Cloudflare Access (need a service token), Bot Fight Mode, or the hub being down.");
  }
  if (hints.length) {
    lines.push("", "  notes:");
    for (const h of hints) lines.push(`    • ${h}`);
  }
  lines.push("──────────────────────────────────────────────────────────", "");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    process.stdout.write(USAGE);
    process.exit(args.url ? 0 : 1);
  }

  // Cloudflare Access service token → the two documented headers. CLI flags win
  // over env so a one-off run can override the shell's exported token.
  const headers = {};
  const cfId = args["cf-access-id"] || process.env.CF_ACCESS_CLIENT_ID;
  const cfSecret = args["cf-access-secret"] || process.env.CF_ACCESS_CLIENT_SECRET;
  if (cfId) headers["CF-Access-Client-Id"] = String(cfId);
  if (cfSecret) headers["CF-Access-Client-Secret"] = String(cfSecret);
  // Repeatable --header 'K: V' for anything else the edge wants.
  const rawHeaders = [].concat(args.header || []);
  for (const h of rawHeaders) {
    if (typeof h !== "string") continue;
    const idx = h.indexOf(":");
    if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  const num = (v, d) => (v == null || v === true || Number.isNaN(Number(v)) ? d : Number(v));
  const stats = await runLoad({
    url: String(args.url),
    trips: num(args.trips, 1),
    devicesPerTrip: num(args.devices, 2),
    rate: num(args.rate, 5),
    durationMs: num(args.duration, 10) * 1000,
    rampMs: num(args.ramp, 0) * 1000,
    origin: typeof args.origin === "string" ? args.origin : null,
    headers,
    tripPrefix: typeof args["trip-prefix"] === "string" ? args["trip-prefix"] : "loadsim",
    // --fixed-trips ⇒ nonce="" (deterministic ids shared across hubs).
    nonce: args["fixed-trips"] ? "" : undefined,
    deviceTag: typeof args["device-tag"] === "string" ? args["device-tag"] : "d",
    log: (s) => process.stderr.write(s + "\n"),
  });

  if (args.json) process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
  else process.stdout.write(fmt(stats));
  // Non-zero exit if nothing opened — useful in CI / scripts.
  process.exit(stats.connections.opened > 0 ? 0 : 2);
}

// Run as a CLI only when invoked directly, not when imported by the test.
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    process.stderr.write(`loadsim: ${e?.stack || e}\n`);
    process.exit(1);
  });
}
