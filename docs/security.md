# Security & hardening

siano-next's hub is a small Node process: a static file server plus a WebSocket
op-relay with a durable append-only log. This document covers its threat model,
the hardening built into the code, the knobs you can tune, and the
deployment-level steps that matter — especially behind a **Cloudflare Tunnel**.

## Threat model

The hub has **no built-in authentication**. Following the reference app, the
**trip URL is the capability**: trip ids are 122-bit random values
(`crypto.randomUUID`), so they are unguessable, and knowing one grants
read+write to that trip. That's the intended model for share-by-link trips. If
your trips must be genuinely private, add authentication in front (see
*Cloudflare Access* below) — the hub alone will not gate access.

What a Cloudflare Tunnel gives you, and what it doesn't:

- **Cloudflare provides**: public TLS termination, origin IP hiding (cloudflared
  dials *out* to Cloudflare; your origin isn't directly reachable), and
  absorption of volumetric/L3-L4 DDoS.
- **Cloudflare does not provide** (by default): protection from anyone who
  reaches your app *through* the tunnel. A WebSocket op-flood, an oversized
  frame, or a connection flood looks like ordinary application traffic and lands
  directly on Node. Those are the hub's job to survive — and the hardening below
  is aimed squarely at them.

## Hardening built into the hub

| Area | Protection |
|---|---|
| **Bind address** | Defaults to `127.0.0.1` (`HOST`), so only cloudflared (or a local reverse proxy) on the same host can reach it — never the LAN or public internet directly. A non-loopback bind prints a warning. |
| **WebSocket memory** | Every frame's length is bounded (`SIANO_MAX_MSG_BYTES`, default 256 KiB) **before any payload is buffered**, and the total across fragments is capped too. A client cannot make the parser allocate unbounded memory. Oversized ⇒ close `1009`. |
| **Protocol strictness** | Client frames must be masked and carry no reserved bits; control frames must be ≤125 bytes and un-fragmented (RFC 6455). Violations ⇒ close `1002`. |
| **Connection cap** | `SIANO_MAX_CONNECTIONS` (default 500) rejects new upgrades past the limit (`503`) and sets `server.maxConnections`. |
| **Heartbeat reaper** | Every `SIANO_HEARTBEAT_MS` (default 30 s) the hub pings each socket and terminates any that missed the previous pong — dead/wedged peers can't leak sockets or memory. |
| **Rate limiting** | Per-connection fixed-window cap `SIANO_MAX_MSGS_PER_SEC` (default 50). A flooding client is closed `1008`. |
| **Disk / inode caps** | `SIANO_MAX_OPS_PER_TRIP` and `SIANO_MAX_TRIPS` (both default unlimited — **set them in production**) bound worst-case disk use from the unauthenticated append path. |
| **Non-blocking writes** | Op persistence is async with a per-trip serialized write queue; a write flood can't block the event loop, and torn/failed writes are logged, not fatal. |
| **Input validation** | Trip ids are validated (`^[A-Za-z0-9._~-]{1,SIANO_TRIP_ID_MAX}$`) before use as a filename; ops are shape-checked; malformed frames are dropped. |
| **Static server** | GET/HEAD only (else `405`); path-traversal blocked (resolved path must stay under the client dir); a `/healthz` endpoint for probes. |
| **Cache freshness** | Static responses carry a configurable `Cache-Control` **+ `CDN-Cache-Control`** with a strong `ETag`; conditional GETs return `304`. Default (`no-cache`) makes browser and CDN revalidate every load, so a new release shows up at once — ideal for development. For production, `SIANO_ASSET_HASHING=1` serves content-hashed asset URLs so they cache forever with **no purge** on deploy (only the tiny `no-cache` shell + service worker revalidate). The **service worker** has its own knob (`SIANO_SW_CACHE_CONTROL`, default `no-cache`) and stays fresh regardless, because a cached SW never updates and its cache-first shell would serve the old UI forever. `/env.js` is always `no-store`. |
| **Security headers** | A tight `Content-Security-Policy` (`default-src 'self'`, same-origin scripts, WebSocket only back to origin, no third-party anything), plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a minimal `Permissions-Policy`. |
| **Origin allowlist** | Optional `SIANO_ALLOWED_ORIGINS` (comma-separated). When set, WebSocket upgrades from any other `Origin` (or none, from a browser) are rejected `403` — defeats cross-site WebSocket hijacking if a trip URL ever leaks. Hub-to-hub peer links (below) are exempt — they carry no `Origin` and authenticate by token instead. |
| **Hub-to-hub auth** | Optional `SIANO_PEER_URL`/`SIANO_PEER_TOKEN` (see [Hub-to-hub sync](#hub-to-hub-sync)). A peer link offers the `siano-peer` subprotocol and presents the shared token in its `hello`; a mismatch is closed `1008`. Peer links are rate-limit-exempt (they relay a whole trip's traffic), so **only enable them between hubs you operate** — a peer can inject ops into every replicated trip (per-op signing is still a roadmap item). |
| **Graceful shutdown** | `SIGINT`/`SIGTERM` stop the heartbeat, close all sockets (`1001`), stop accepting, and flush pending writes. |

## Environment knobs

| Var | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Keep it loopback behind a tunnel/proxy. |
| `PORT` | `4000` | Listen port. |
| `SIANO_DATA_DIR` | `./siano_data` | Where op logs live (`logs/`). |
| `SIANO_MAX_MSG_BYTES` | `262144` | Max WebSocket message size. |
| `SIANO_MAX_CONNECTIONS` | `500` | Max concurrent connections. |
| `SIANO_MAX_MSGS_PER_SEC` | `50` | Per-connection message rate limit. |
| `SIANO_ALLOWED_ORIGINS` | *(unset)* | Comma-separated `Origin` allowlist for WS upgrades. **Set this to your app's URL in production.** |
| `SIANO_MAX_OPS_PER_TRIP` | `0` (∞) | Refuse ops past this many per trip. **Set a generous value (e.g. 100000).** |
| `SIANO_MAX_TRIPS` | `0` (∞) | Refuse creating new trip files past this many. **Set one if trip creation is unauthenticated.** |
| `SIANO_HEARTBEAT_MS` | `30000` | Ping/reap interval. |
| `SIANO_TRIP_ID_MAX` | `128` | Max trip-id length. |
| `SIANO_PEER_URL` | *(unset)* | Comma-separated `ws://`/`wss://` URLs of peer hubs to **dial** for hub-to-hub sync (see [Hub-to-hub sync](#hub-to-hub-sync)). Off when unset. |
| `SIANO_PEER_TOKEN` | *(unset)* | Shared secret a dialing peer presents and a receiving hub checks. **Set the same value on both hubs.** Unset ⇒ peer links are accepted with a loud warning. |
| `SIANO_ASSET_HASHING` | *(off)* | When on (`1`/`true`), serve the JS/CSS/manifest at **content-hashed URLs** (`/js/app.<hash>.js`) computed in memory at startup — the ESM import graph, `index.html` and the service worker are rewritten to match. Hashed URLs change when the bytes do, so they can be cached forever and a new release is picked up **without a purge**. Flips the asset default to `immutable` (below). Source files on disk are untouched — still buildless. |
| `SIANO_CACHE_CONTROL` | `no-cache` *(→ `public, max-age=31536000, immutable` when `SIANO_ASSET_HASHING` is on)* | `Cache-Control` for static assets. Default `no-cache` = store but always revalidate (dev-friendly; a Cloudflare purge always suffices); with hashing on the default is `immutable`. Set it explicitly for a custom policy, e.g. `public, max-age=300`. Empty (`SIANO_CACHE_CONTROL=`) omits the header so Cloudflare uses its extension defaults. The HTML shell is `no-cache` whenever hashing is on (it names the current hashed URLs). |
| `SIANO_CDN_CACHE_CONTROL` | *(= `SIANO_CACHE_CONTROL`)* | `CDN-Cache-Control` — the CDN-scoped directive Cloudflare honours independently of the browser's `Cache-Control`. Defaults to the same value; set it to cache at the edge while telling browsers something else. Empty omits it. |
| `SIANO_SW_CACHE_CONTROL` | `no-cache` | `Cache-Control` (and `CDN-Cache-Control`) for `/service-worker.js` only. Keep it `no-cache` — a cached service worker never updates, so its cache-first shell serves the old UI forever. Its own knob so you can cache everything else aggressively in production. |
| `SIANO_METRICS_TOKEN` | *(unset)* | Bearer token that gates `GET /metrics` (Prometheus text format). **Unset ⇒ the endpoint is OFF (404)** — the series leak trip ids and activity volume, so it must never be open. Set it and a scraper (e.g. Grafana Alloy/Agent → Grafana Cloud) presents `Authorization: Bearer <token>`. Keep the hub loopback-bound; the token defends against other localhost processes / a misconfigured tunnel. |
| `SIANO_FORCE_HTTPS` | *(off)* | When on (`1`/`true`), the hub answers any request the proxy marks insecure (`X-Forwarded-Proto: http`) with a `301` to the same URL on `https://`. TLS terminates at Cloudflare, so the hub only sees plain HTTP and relies on that header. Cloudflare's own **SSL/TLS → Edge Certificates → "Always Use HTTPS"** does the same at the edge and is the canonical fix; this is for when that toggle is off, or behind a different TLS-terminating proxy (nginx, etc.). A request with **no** `X-Forwarded-Proto` (a direct-to-loopback dev hit) is left alone, so enabling it never loops a local `http://localhost` against a non-TLS port. Only enable it behind a proxy you trust to set the header. |
| `SIANO_DEBUG` | *(off)* | Verbose **hub** logging (per-request/per-op; op type + ids only, never payloads). Troubleshooting only. |
| `SIANO_CLIENT_DEBUG` | *(off)* | Verbose **client** logging. The hub injects the flag via `/env.js`; there is no user-facing switch, so end users never see logs. Flip it and restart to enable, then reload the client. |

Example production start:

```bash
HOST=127.0.0.1 PORT=4000 \
SIANO_ALLOWED_ORIGINS="https://siano.example.com" \
SIANO_MAX_OPS_PER_TRIP=100000 \
SIANO_MAX_TRIPS=5000 \
node hub/server.js
```

During development keep the cache defaults (everything `no-cache`) so a Cloudflare
purge always shows the latest build. Once the UI is stable, turn on content-hashed
asset URLs — then assets are cached forever and a deploy needs **no purge** (only
the tiny `no-cache` shell + service worker revalidate; the service worker stays
fresh on its own knob):

```bash
# …plus the production vars above
SIANO_ASSET_HASHING=1 \
node hub/server.js
```

(Or, without hashing, set `SIANO_CACHE_CONTROL="public, max-age=300"` for a short
edge TTL — simpler, but then purge on each deploy or wait out the TTL.)

## Metrics / monitoring

Grafana + Prometheus is far too heavy to *run* next to a single loopback-bound
Node relay, so the hub instead **exposes** metrics in the Prometheus text format
and lets something small collect them. `GET /metrics` (in `hub/server.js`, series
built by `hub/metrics.js`) reports live gauges (`siano_ws_connections`,
`siano_trips_active`, per-trip `siano_trip_connections`/`siano_trip_ops`),
lifetime counters (`siano_ops_appended_total`, `siano_ops_rejected_total`,
`siano_ws_upgrade_rejected_total{reason=…}`, `siano_rate_limit_closes_total`, …)
and a couple of process gauges — no dependencies, nothing to build.

The endpoint is **token-gated and off by default**: with no `SIANO_METRICS_TOKEN`
it returns `404`. The per-trip series carry trip ids and activity volume, and the
hub has no auth (the trip URL is the capability), so it must sit behind the token
even on loopback. A scrape is `no-store` (never cached) and needs
`Authorization: Bearer <token>`:

```bash
curl -H "Authorization: Bearer $SIANO_METRICS_TOKEN" http://127.0.0.1:4000/metrics
```

**Grafana Cloud free tier** is the visualiser that stays proportionate: don't host
Grafana yourself — run **Grafana Alloy** (or the older Grafana Agent) on the hub
host, have it scrape `127.0.0.1:4000/metrics` with the bearer token, and
`remote_write` to your Grafana Cloud stack. No inbound port, no local TSDB. A
minimal Alloy scrape:

```alloy
prometheus.scrape "siano" {
  targets    = [{ __address__ = "127.0.0.1:4000" }]
  metrics_path = "/metrics"
  scrape_interval = "30s"
  bearer_token = sys.env("SIANO_METRICS_TOKEN")
  forward_to = [prometheus.remote_write.grafanacloud.receiver]
}
prometheus.remote_write "grafanacloud" {
  endpoint {
    url = "https://prometheus-prod-XX.grafana.net/api/prom/push"
    basic_auth { username = "<instance-id>"  password = sys.env("GRAFANA_CLOUD_TOKEN") }
  }
}
```

(Prefer `siano_ops_appended_total` per-trip for activity, `siano_ws_connections`
for concurrency, and alert on `siano_up` disappearing or
`siano_rate_limit_closes_total` climbing. For pure uptime alerting, Uptime Kuma
hitting `/healthz` is even lighter and needs no token.)

An importable Grafana dashboard for all of the above lives at
[`ops/grafana/siano-hub-dashboard.json`](../ops/grafana/siano-hub-dashboard.json)
(Dashboards → New → Import → pick your Prometheus data source); see
[`ops/grafana/README.md`](../ops/grafana/README.md) for the panel list and a few
suggested alerts.

**Host / OS metrics** (CPU, memory, disk-free on `/`, load, app log-file sizes)
can be collected two ways, per host, joined to the app metrics by the `hub` label:

- **Lightweight (recommended for small / low-RAM boxes):** an **agent-less shell
  pusher**, [`ops/push/siano-metrics-push.sh`](../ops/push/README.md) — a one-shot
  `sh` + `curl` on a cron timer, no daemon. It computes `host_*` metrics from
  `/proc`+`df`, sizes the log files, and translates the hub's `/metrics` verbatim,
  posting InfluxDB line protocol to Grafana Cloud (which maps it back to
  Prometheus). Idle RAM ≈ 0.
- **Full-featured:** the **Grafana Alloy** agent via its built-in
  `prometheus.exporter.unix` (node_exporter), in [`ops/alloy/`](../ops/alloy/README.md).
  Heavier (~100–200 MB); use it only where the RAM is available.

The dashboard's *Host machines* row uses the `host_*` names from the shell pusher.
(For the node_exporter/Alloy variant, the Host panels want the `node_*` queries —
see git history.)

**Peer-link metrics** (`siano_peer_*`) cover the hub-to-hub sync WebSocket: whether
each dialed link is up, ops replicated in/out, reconnects, inbound peer connections,
and token auth failures. The dialing hub reports link status + op flow; the acceptor
reports inbound connections. They render in the dashboard's *Hub-to-hub sync* row and
are empty on a single-hub deployment (`siano_peer_configured` is `0`).

## Hub-to-hub sync

Two (or more) hubs can replicate a trip's op-log to each other so travellers who
happen to connect to *different* hubs for the *same* trip still converge. It's a
thin add-on to the existing relay: a hub **dials** its peer and speaks the exact
client sync protocol (`hello`/`sync`/`want`, then live `op`/`ops`), per trip.
Nothing new is needed on the merge side — ops are content-addressed and deduped
and the reducer is order-independent, so a peer link is just a "big leaf" that
happens to be another hub. See `hub/peer.js` and the architecture doc.

- **How to turn it on.** For two hubs, set on **one** of them:
  ```bash
  SIANO_PEER_URL="wss://other-hub.example.com" \
  SIANO_PEER_TOKEN="a-long-random-shared-secret" \
  node hub/server.js
  ```
  and set the **same** `SIANO_PEER_TOKEN` on the other hub (it only needs the
  token — it doesn't have to dial back; a single dial is bidirectional). For a
  fan-out of many hubs, point several **spoke** hubs' `SIANO_PEER_URL` at one
  central hub; the central hub relays between them through its ordinary room
  fan-out and needs no peer URL of its own (just the shared token).
- **Lazy per-trip.** A link for a trip opens the first time a local device joins
  that trip, so a trip replicates across hubs exactly when it's actually used on
  both — and a hub never blindly pulls every trip from its peer.
- **Self-healing.** The link reconnects with backoff and re-runs the two-way
  delta on every reconnect, so a flaky inter-hub network loses nothing (same
  guarantee as an offline phone).

**Trust boundary — read this.** A peer link widens trust from "anyone with the
trip URL" to "the operator of the peer hub": an authenticated peer can inject
ops into *every* replicated trip, and those ops are not individually signed yet
(per-device op signing is still a roadmap item). So:

- **Only link hubs you operate.** Do not federate with a hub you don't control.
- **Always set `SIANO_PEER_TOKEN`** (a long random secret) on both hubs. Without
  it, any client that offers the `siano-peer` subprotocol is accepted as a hub —
  the process logs a loud warning once when that happens.
- **Use `wss://` (TLS)** for the inter-hub link — put the peer behind the same
  Cloudflare Tunnel / TLS you use for browsers; if the peer sits behind
  Cloudflare Access, the dialing hub needs an Access **service token** to reach
  it.
- Peer links are **exempt from the per-connection rate limit** (they relay a
  whole trip's traffic) — another reason the token, and operating both ends,
  matter.

Topology note: Phase 1 covers **two hubs** (either/both directions) and a
**star** (spokes → one hub). A 3+ hub *chain* does not relay transitively yet
(dedup keeps a full mesh correct, just chattier); prefer a star.

## Deployment-level hardening (do these too)

The code can't do these for you:

1. **Put Cloudflare Access in front** if trips shouldn't be world-reachable by
   URL. Access enforces auth (email OTP, IdP, or a service token) at Cloudflare's
   edge before any request reaches the tunnel — the single biggest lock you can
   add. Pair it with a WAF **rate-limiting rule** on the app's hostname for a
   second layer beyond the per-connection limit.
2. **Run as a non-root, unprivileged user** with write access only to
   `SIANO_DATA_DIR`. The process needs nothing else.
3. **Sandbox with systemd** (or your init). A hardened unit, e.g.:
   ```ini
   [Service]
   ExecStart=/usr/bin/node /opt/siano-next/hub/server.js
   Environment=HOST=127.0.0.1 PORT=4000 SIANO_MAX_OPS_PER_TRIP=100000
   User=siano
   Group=siano
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   ReadWritePaths=/var/lib/siano
   Environment=SIANO_DATA_DIR=/var/lib/siano
   RestartSec=2
   Restart=on-failure
   CapabilityBoundingSet=
   ```
4. **Keep Node patched.** There are no npm dependencies to audit (by design), so
   your only supply-chain surface is the Node runtime itself — track its LTS
   security releases.
5. **Back up `SIANO_DATA_DIR`.** The op logs are the source of truth on the
   server side. (Any device also holds a full copy and can re-seed the hub, but a
   backup avoids depending on that.)
6. **Watch disk.** Even with per-trip caps, unauthenticated trip creation can
   grow the log directory; alert on disk usage and prefer `SIANO_MAX_TRIPS` +
   Cloudflare Access over hoping.
7. **Purge the CDN when a cached asset changes.** With the default `no-cache`
   policy Cloudflare revalidates every load, so a deploy shows up immediately —
   but any copy Cloudflare cached *before* these headers existed (it edge-caches
   `.js`/`.css` by extension even with no origin cache directives) keeps being
   served until its TTL lapses — the classic "my old UI is still showing"
   symptom. Do a one-time **Purge Everything** (Cloudflare → Caching →
   Configuration) after switching to these headers. For production, prefer
   `SIANO_ASSET_HASHING=1` — hashed URLs change per deploy, so **no purge is ever
   needed** (only the tiny `no-cache` shell + service worker revalidate). If you
   instead set a plain `SIANO_CACHE_CONTROL` TTL without hashing, purge on each
   deploy (or wait out the TTL). If you run a "Cache Everything" page rule or a
   Browser-Cache-TTL override, exempt `/service-worker.js` and `/index.html` so
   the edge respects their `no-cache`.

## Known limitations / roadmap

- **No auth in the hub** — by design; use Cloudflare Access for real privacy.
- **Ops are not yet signed.** Any client on a trip can forge an op authored by
  another device id. Per-device keypair signing (on the roadmap in the README)
  adds tamper-evidence and authorship you can verify.
- **No log compaction yet.** Long-lived trips grow their log forever; compaction
  (snapshot + tail) is on the roadmap and will also shrink the disk footprint.
- **Rate limiting is per-connection, not per-IP.** Behind Cloudflare the socket
  source is cloudflared; use a Cloudflare WAF rate-limit rule for per-client
  limits (the real client IP is in `CF-Connecting-IP`).
