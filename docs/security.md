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
| **Cache freshness** | Static responses carry a configurable `Cache-Control` **+ `CDN-Cache-Control`** with a strong `ETag`; conditional GETs return `304`. The default (`no-cache`) makes browser and CDN (Cloudflare honours these) revalidate every load, so a new release is picked up at once — ideal during development. Set `SIANO_CACHE_CONTROL` to a caching policy for production. The **service worker** has its own knob (`SIANO_SW_CACHE_CONTROL`, default `no-cache`) and stays fresh regardless, because a cached SW never updates and its cache-first shell would serve the old UI forever. `/env.js` is always `no-store`. |
| **Security headers** | A tight `Content-Security-Policy` (`default-src 'self'`, same-origin scripts, WebSocket only back to origin, no third-party anything), plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a minimal `Permissions-Policy`. |
| **Origin allowlist** | Optional `SIANO_ALLOWED_ORIGINS` (comma-separated). When set, WebSocket upgrades from any other `Origin` (or none, from a browser) are rejected `403` — defeats cross-site WebSocket hijacking if a trip URL ever leaks. |
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
| `SIANO_CACHE_CONTROL` | `no-cache` | `Cache-Control` for static assets + the HTML shell. `no-cache` = store but always revalidate (dev-friendly; a Cloudflare purge always suffices). For production set a caching policy, e.g. `public, max-age=300` or `public, max-age=31536000, immutable`. Empty (`SIANO_CACHE_CONTROL=`) omits the header so Cloudflare uses its extension defaults. |
| `SIANO_CDN_CACHE_CONTROL` | *(= `SIANO_CACHE_CONTROL`)* | `CDN-Cache-Control` — the CDN-scoped directive Cloudflare honours independently of the browser's `Cache-Control`. Defaults to the same value; set it to cache at the edge while telling browsers something else. Empty omits it. |
| `SIANO_SW_CACHE_CONTROL` | `no-cache` | `Cache-Control` (and `CDN-Cache-Control`) for `/service-worker.js` only. Keep it `no-cache` — a cached service worker never updates, so its cache-first shell serves the old UI forever. Its own knob so you can cache everything else aggressively in production. |
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
purge always shows the latest build. Once the UI is stable, enable edge caching —
the service worker stays fresh on its own knob:

```bash
# …plus the production vars above
SIANO_CACHE_CONTROL="public, max-age=300" \
node hub/server.js
```

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
   Configuration) after switching to these headers. Once you turn on edge caching
   in production (`SIANO_CACHE_CONTROL`), purge on each deploy (or use hashed
   asset names). If you run a "Cache Everything" page rule or a Browser-Cache-TTL
   override, exempt `/service-worker.js` and `/index.html` so the edge respects
   their `no-cache`.

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
