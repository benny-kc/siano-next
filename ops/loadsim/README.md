# Hub load simulator

`loadsim.js` is a dependency-free driver that opens many WebSocket **leaf**
connections to one hub, drives realistic op traffic, and reports how the hub
behaves under it. It speaks the exact leaf protocol (`hello` / `sync` / `op` /
`ops`, see [`hub/server.js`](../../hub/server.js)) over Node's built-in
WebSocket, so there is nothing to install — `node ops/loadsim/loadsim.js …`.

**Short answer to "can it work through a Cloudflare Tunnel and Cloudflare's
security?" — yes.** A Cloudflare Tunnel just terminates TLS and forwards the
WebSocket, so pointing the simulator at `wss://your-hub` works out of the box.
The parts that need a flag are Cloudflare's *security* layers (and the hub's own
Origin allowlist); each one, and how to get the load test through it, is covered
below.

---

## Quick start

```bash
# Local dev hub (node hub/server.js on :4000): 25 trips × 2 devices = 50 sockets
node ops/loadsim/loadsim.js --url ws://127.0.0.1:4000 --trips 25 --devices 2 --duration 10

# Through the tunnel, with the hub's Origin allowlist on:
node ops/loadsim/loadsim.js --url wss://siano.example.com \
  --origin https://siano.example.com \
  --trips 100 --devices 3 --rate 4 --duration 60 --ramp 10
```

Run `node ops/loadsim/loadsim.js --help` for every flag. The most important:

| Flag | Meaning |
|---|---|
| `--url` | Hub WS URL, `ws://` or `wss://` (**required**). |
| `--trips N` | Distinct trips / rooms (default 1). |
| `--devices N` | Devices **per trip** (default 2). Total sockets = `trips × devices`. Keep ≥2 so there's someone to relay to. |
| `--rate N` | Ops/sec **per device** (default 5). Offered op rate ≈ `trips × devices × rate`. |
| `--duration S` | Hold the load this long (default 10 s). |
| `--ramp S` | Spread the connection opens over this window (default 0 = all at once). Use it so a big run trickles in instead of looking like a burst attack. |
| `--origin URL` | `Origin` header — needed if the hub runs `SIANO_ALLOWED_ORIGINS`. |
| `--cf-access-id` / `--cf-access-secret` | Cloudflare Access **service token** (or the `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` env vars). |
| `--header 'K: V'` | Any other request header (repeatable). |
| `--json` | Emit the raw stats object instead of the text report. |

### What it measures

- **connections** opened / attempted / failed, and a histogram of **WebSocket
  close codes** — the single most useful "why did it break" signal.
- **connect latency** (p50/p90/p99/max) — the upgrade round trip, i.e. how long
  Cloudflare + the tunnel + the hub take to accept a socket.
- **ops emitted** vs **ops relayed**, with per-second rates — throughput.
- **relay latency** (p50/p90/p99/max) — the end-to-end `writer → hub → other
  device` round trip, the number a real user feels as "sync lag". Each emitted
  op carries a private `_lt` send time; the peer device on the same trip
  subtracts it on arrival.

The ops are **real** (stamped through `client/js/core`), so they fold cleanly
and exercise the same durable-append + fan-out path a phone does. The extra
`_lt` field rides along in the stored op — harmless, but a reason to point this
at **throwaway trips** (the tool invents unique ids per run) and never at a real
production trip.

---

## Cloudflare Tunnel + Cloudflare security: the playbook

Your traffic path is `simulator → Cloudflare edge → cloudflared tunnel → hub`.
Everything the hub sees comes from cloudflared, so the source socket is always
Cloudflare's — the real client is in the `CF-Connecting-IP` header. Work through
each layer the request has to pass:

### 1. The tunnel itself (TLS / `wss://`)
Nothing special. Use the public hostname with `wss://`. The simulator uses
Node's `https`-backed WebSocket, so it validates the edge certificate normally.
The hub's heartbeat pings every `SIANO_HEARTBEAT_MS` (30 s), which also keeps
Cloudflare from idling the tunnel out from under a quiet connection.

### 2. The hub's Origin allowlist (`SIANO_ALLOWED_ORIGINS`)
This is a hub guard, not Cloudflare's, but it's the one that trips people first.
A browser always sends an `Origin`; when the allowlist is on, the hub rejects an
upgrade whose `Origin` isn't listed with **403** (⇒ the socket never opens, and
the simulator shows `1006` / unopened connections). A plain Node client sends no
Origin at all, so it *would* be refused too. Fix: pass the app's URL as
`--origin https://siano.example.com`. The simulator sets that header on the
upgrade and the allowlist admits it. (The bundled test proves both directions:
matching Origin opens, a mismatched one is refused.)

### 3. Cloudflare Access (if you put it in front)
`docs/security.md` recommends Cloudflare Access for private trips. Access gates
the edge with an **interactive** login (email OTP / IdP) — which a headless load
test can't complete, so every upgrade would be bounced at the edge before it
ever reaches the tunnel. The supported non-interactive path is an Access
**service token**:

1. In the Zero Trust dashboard: **Access → Service Auth → Service Tokens**,
   create one. You get a Client ID and Client Secret.
2. Add a rule to the Access **application** covering your hub hostname:
   *Include → Service Token → (the one you made)*.
3. Run the simulator with it:
   ```bash
   export CF_ACCESS_CLIENT_ID='xxxx…​.access'
   export CF_ACCESS_CLIENT_SECRET='yyyy…'
   node ops/loadsim/loadsim.js --url wss://siano.example.com \
     --origin https://siano.example.com \
     --cf-access-id "$CF_ACCESS_CLIENT_ID" --cf-access-secret "$CF_ACCESS_CLIENT_SECRET" \
     --trips 100 --devices 3 --rate 4 --duration 60 --ramp 10
   ```
   The tool sends `CF-Access-Client-Id` / `CF-Access-Client-Secret`; Access
   validates the token at the edge and forwards the upgrade to the tunnel. This
   is the same mechanism a peer hub uses to dial an Access-protected hub
   (`docs/security.md → Hub-to-hub sync`).

### 4. WAF rate-limiting rules
`docs/security.md` suggests a WAF rate-limit rule as a second layer beyond the
hub's per-connection limit. A load test is exactly the traffic such a rule is
built to stop, so **it will fire** and you'll see connections bounced (unopened
/ `1006`) or challenged. That's a legitimate result — you're measuring the rule.
While you specifically want to test the *hub*, scope the rule around the test:
- add a WAF **skip / bypass** expression for the simulator's egress IP, or for a
  custom header you pass with `--header 'X-Loadtest: <secret>'` and match on; or
- run the test from an IP the rule excludes; or
- temporarily raise/disable the rule for the test window.
Then re-enable it and run again to measure the rule's own ceiling.

### 5. Bot Fight Mode / Super Bot Fight Mode & Security Level
Cloudflare's bot protections can serve a JS/managed challenge to traffic that
"looks automated" — which a headless flood does. A challenge can't be solved by
the simulator, so those upgrades fail at the edge (again: unopened / `1006`).
Options:
- A valid Access **service token** (step 3) puts the request in an authenticated
  lane and is the cleanest way through.
- Or add a **WAF skip rule** (Bot Management / Security actions) for your test IP
  or the custom `--header` marker above.
- For a plain hostname with no Access, temporarily set the zone/hostname
  **Security Level** low and Bot Fight Mode off for the test window.
Whatever you choose, remember it changes what you're measuring — note it next to
the numbers.

### 6. Per-IP vs per-connection limits
Behind Cloudflare the hub's socket source is always cloudflared, so the hub's
**per-connection** rate limit (`SIANO_MAX_MSGS_PER_SEC`) is what a single
simulated device hits — not a per-IP cap. If you want per-client limiting under
load, that's the Cloudflare WAF rate-limit rule (step 4), keyed on
`CF-Connecting-IP`.

---

## Reading the result

```
  connections   : 300/300 opened
  connect latency: n=300 p50=48ms p90=71ms p99=180ms max=402ms
  close codes   : 1000:300
  ops emitted   : 71640  (1194/s)
  ops relayed   : 143280 (2388/s)
  relay latency : n=143280 p50=61ms p90=140ms p99=430ms max=1900ms
```

- **`1000` closes** are the simulator's own clean shutdown at end of run — good.
- **`1008`** = the hub rate-limited that connection (`--rate` above
  `SIANO_MAX_MSGS_PER_SEC`, or a WAF rate-limit rule). Lower `--rate` or raise
  the cap, depending on what you're testing.
- **`1009`** = a frame exceeded `SIANO_MAX_MSG_BYTES` (you won't hit this with
  normal ops).
- **`1006` / fewer opened than attempted** = the upgrade never completed: an
  edge or handshake rejection. Walk back through steps 2–5 — Origin allowlist,
  Access service token, WAF, Bot Fight Mode — or the hub is simply down.

The text report prints these same hints inline when it sees the codes.

### Testing your **two** hubs

Run the simulator against **each hub's** public hostname in turn (or at the same
time from two shells) to compare their capacity through their respective tunnels.

To validate **hub-to-hub sync under load** — the reason you run two hubs — put
one run's devices on hub A and another run's on hub B, sharing the **same trip
ids** (`--fixed-trips`) but with **different device tags** (`--device-tag`) so
they don't collide. Because both runs are on one host (one wall clock), the
`_lt` timestamps line up, so the relay latency each side reports is the true
**cross-hub** round trip (`writer on A → hub A → peer link → hub B → reader on
B`):

```bash
# Terminal 1 — hub A, devices tagged "a"
node ops/loadsim/loadsim.js --url wss://hub-a.example.com --origin https://hub-a.example.com \
  --fixed-trips --trip-prefix xhub --device-tag a \
  --trips 5 --devices 2 --rate 3 --duration 60

# Terminal 2 — hub B, SAME trips, devices tagged "b"
node ops/loadsim/loadsim.js --url wss://hub-b.example.com --origin https://hub-b.example.com \
  --fixed-trips --trip-prefix xhub --device-tag b \
  --trips 5 --devices 2 --rate 3 --duration 60
```

Each run's **`ops relayed`** and **relay latency** then include the ops that
crossed the peer link from the other hub — if that count stays near zero while
the other run is clearly emitting, the peer link isn't carrying the load. Cross-
check with each hub's `GET /metrics`: `siano_ops_appended_total` should converge
on both, and `siano_peer_ops_in` / `siano_peer_ops_out` prove the inter-hub link
actually moved them. `docs/security.md → Metrics / monitoring` covers the
(token-gated) `/metrics` endpoint and the `siano_peer_*` series.

---

## Caveats

- **Throwaway trips only.** Emitted ops carry a private `_lt` field and land in
  the durable log; the tool uses unique per-run trip ids so it never touches a
  real trip. Don't override that to aim at production data.
- **The simulator is one process on one host.** Its egress is a single IP, so
  it models per-IP concurrency from one client, not a geographically spread
  fleet. For very large tests, run several copies from different hosts/IPs.
- **It measures, it doesn't tune.** If a run bounces at the edge, the fix is a
  Cloudflare setting (steps 2–5) or a hub env knob (`docs/security.md`), not the
  tool.
