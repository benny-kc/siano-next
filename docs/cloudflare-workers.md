# Cloudflare Workers / Durable Objects as a hub — planning notes

**Status:** research / planning only. Nothing here is built. The original
question:

> Would it be possible to use Cloudflare Workers instead of my hub, or as an
> addition?

Short version: **yes, and it's an unusually clean fit** — because of one
decision already baked into the design: *the hub has no business logic.* It only
appends ops, dedups by `opId`, fans out, and hands back reconnect deltas. That is
almost exactly the shape of a Cloudflare **Durable Object**, and the trip id is
already the shard key. The client barely changes, because it only ever knew a
`wss://` URL.

This doc records the mapping, the wins, the costs, and the recommended shape, so
a future session can pick it up without re-deriving it.

---

## 1. What the hub actually does today

Two separable jobs (`hub/server.js`):

1. **Static file server** (`makeServeStatic`) — the shell + assets, CSP + security
   headers, ETag/`304`, env-controlled cache policy, the dynamic `/env.js` debug
   flag, and optional content-hashed asset URLs (`hub/assets.js`).
2. **Durable WebSocket relay** — accept `hello`/`op`/`ops`, append to an
   append-only per-trip log (`TripLogs` → `<trip>.jsonl`, `hub/log.js`), dedup by
   `opId`, fan out to the room (`rooms`: trip → `Set<Conn>`), and compute the
   reconnect delta (`missing` + `wanted`, both directions). Plus the extras:
   heartbeat reaper, per-connection rate limit, `/metrics`, hub-to-hub peer sync
   (`hub/peer.js`), and the HMAC GitHub deploy webhook.

These map onto Cloudflare, but onto **different** primitives — the split matters.

### Why it fits so well

- The synced unit is an **op**; every device folds the same append-only log with
  the same pure reducer (`client/js/core/reducer.js`). Convergence is guaranteed
  for anyone who has seen the same *set* of ops, independent of transport
  (`docs/architecture.md`). The relay is just a pipe.
- Sync is **additive and idempotent** — ops are only ever appended and deduped by
  `opId`. Nothing in the protocol assumes a filesystem or a long-lived Node process.
- The wire protocol is small, JSON text frames, and already transport-agnostic on
  the client side: `SyncClient` (`client/js/sync/client.js`) is instantiated in
  exactly one place (`client/js/app.js`) and only needs a `ws://|wss://` URL.

---

## 2. The mapping

| Your hub piece | Cloudflare equivalent | Notes |
|---|---|---|
| `rooms` (trip → `Set<Conn>`) + `fanout` | **one Durable Object per trip** | `env.TRIP.get(env.TRIP.idFromName(tripId))`. The DO instance *is* the room and holds its own sockets. |
| `TripLogs` (JSONL, dedup, caps) | **DO storage** (KV-transactional) or the **DO-embedded SQLite** | `put(opId, op)` = append + dedup in one. `missing`/`wanted`/`pick`/`all` become storage `list`/`get`. Durability is replicated, not a single file. |
| `hub/ws.js` (hand-rolled RFC 6455) | **native WebSocket + Hibernation API** | Delete it. The platform owns the handshake/framing/masking. Hibernation means an idle trip costs nothing until an op arrives. |
| static server + CSP/cache headers | **Workers Static Assets** (or Pages) | Serves `client/`. `X-Robots-Tag` for `/t/<id>`, and the dynamic `/env.js`, become a small Worker route or `_headers`. |
| `SIANO_FORCE_HTTPS`, `HOST`/loopback, Cloudflare Tunnel | *gone* | TLS terminates at the edge natively. The `HOST=127.0.0.1` → 502 foot-gun (see `docs/security.md`) disappears. |
| GitHub deploy webhook (stop-for-redeploy) | `wrangler deploy` | No process to stop and restart. |
| `hub/peer.js` (hub-to-hub federation) | **mostly obsolete** | See §4. |
| caps / rate limit / metrics | same logic inside the DO | Straight port; metrics via Workers Analytics Engine / `wrangler tail` instead of `/metrics`. |

`opId` stays a single source of truth: the Worker can `import` the existing pure
`client/js/core/lamport.js`, exactly as `hub/log.js` does today — so hub, Worker,
and every device keep agreeing on op identity with zero duplication.

The wire contract ports verbatim (`client -> hub` / `hub -> client`):

```
{ t:"hello", trip, have:[opId,...] }  ->  { t:"sync", ops:[...], want:[opId,...] }
{ t:"op", op }        // new local op        -> fan-out to the room (never echoed)
{ t:"ops", ops:[...]} // answer to `want`    -> fan-out of the new ones
```

---

## 3. The structural win: a DO-per-trip is globally single-instanced

A Durable Object is globally single-instanced *by name*. So
`idFromName(tripId)` gives exactly **one** authoritative relay + log per trip,
worldwide. Consequences:

- The whole `rooms` `Map` collapses into "the DO is the room."
- The reconnect delta (`missing`/`wanted`) is a local storage diff inside the DO.
- The **entire hub-to-hub federation problem disappears** — see §4.

Correctness still does not *depend* on that single instance (the CRDT model means
any leaf can re-seed), but you no longer have to build convergence between relays
yourself.

---

## 4. `hub/peer.js` becomes unnecessary

`peer.js` exists only because you can run multiple independent Node hubs that then
have to reconcile: the always-on multiplexed link, `phello`/`ptrips`/`phave`/
`pwant`/`pops`, union reconciliation on reconnect, dedup-to-stop-loops, and
`SIANO_PEER_TOKEN`. With a DO-per-trip there is only ever one instance of a given
trip's relay, so **all of that is deleted, not ported.** That is a large chunk of
the most complex hub code that the platform makes moot.

(The one thing peer sync also gave you — federating hubs run by *different*
operators you don't both control — is a separate, still-open question; a
Workers deployment is single-tenant to your Cloudflare account.)

---

## 5. The costs / what you'd give up

1. **Buildless + zero-dep takes a hit — the big one.** CLAUDE.md's first rule is
   "No build step, no dependencies." Workers means `wrangler`, a `wrangler.toml`,
   a deploy CLI, and a dev toolchain. The *client* stays buildless; the *backend*
   stops being "just `node hub/server.js`."
2. **Paid plan.** WebSockets + Durable Objects require the Workers Paid plan
   (~$5/mo min), and DO storage/SQLite has its own request/duration billing. Fine
   for a trip splitter, but it's no longer "runs anywhere Node runs, free."
3. **`node --test` no longer covers the relay.** The hub suite tests against real
   WS framing (`hub.test.mjs`, `peer.test.mjs`, `security.test.mjs`). Those don't
   run against a DO — you'd test with `wrangler dev` / Miniflare /
   `vitest-pool-workers`, a different harness. The **core** tests (reducer, split,
   money, budgets) are unaffected — they're pure.
4. **Feature parity work.** `/metrics` (Prometheus), the HMAC deploy webhook,
   `SIANO_DEBUG` op logging, the heartbeat reaper (Hibernation changes liveness),
   and the rate limiter each need re-expressing in Worker idioms (Analytics Engine,
   DO alarms, `wrangler tail`). None hard; all non-zero.
5. **DO location / latency.** A trip's DO lives in one region (near its creator).
   Great for a co-located travel group; slightly worse for globally-scattered
   members than a nearby self-hosted hub — though the peer mesh had the same
   reality.
6. **Trusting the platform for hardening you currently own.** `hub/ws.js` +
   `security.test.mjs` encode bounded frames, masking checks, Origin allowlist,
   etc. Deleting `ws.js` means trusting Cloudflare's WS stack for that layer.

**Unchanged no matter what:** the client, the reducer, the op set, and the CRDT
merge rules. The hub is a dumb relay *by design*, so swapping what relays is
genuinely a backend-only concern — which is exactly why this is feasible.

---

## 6. Recommended shape (if/when built)

Ranked, most-recommended first.

### A. Swappable alternate backend (preferred)

Add a `worker/` target — a Durable Object class that mirrors `TripLogs` + the
`hello`/`op`/`ops` handling — that speaks the **exact same wire protocol**. Because
the client only knows a `wss://` URL, it can't tell whether the other end is
`hub/server.js` or a Worker. Keep the Node hub as the buildless, zero-dep,
self-hostable **default**; offer Workers as an opt-in "serverless, global,
no-tunnel, no-peer-sync" deploy. Preserves the project's identity *and* adds the
edge option. The stable wire protocol is the contract that makes this low-risk.

Rough surface:

- `worker/wrangler.toml` — a `[[durable_objects.bindings]]` for the trip DO, a
  static-assets binding for `client/`.
- `worker/index.js` — routes: static assets; `/t/<id>` → app shell; WS upgrade →
  `env.TRIP.get(idFromName(trip))`.
- `worker/trip-do.js` — the Durable Object: `fetch()` accepts the WS upgrade;
  `webSocketMessage()` runs the `hello`/`op`/`ops` logic; storage holds ops keyed
  by `opId`; reuse `client/js/core/lamport.js` `opId`.
- Tests via Miniflare / `vitest-pool-workers`, mirroring `hub.test.mjs`.

### B. Static on Cloudflare, sync on the Node hub (cheapest real win)

You're likely already behind Cloudflare. Serve the shell/assets from Workers
Static Assets or Pages (immutable hashed assets, edge cache, no tunnel for
statics) while the Node hub keeps the WebSocket. Small, reversible, changes no
sync code. Good first step even if A never happens.

### C. Full replacement

Make Workers/DO the primary backend and retire the Node hub, tunnel, and
`peer.js`. Technically sound; it's a *product-identity* decision (adopting
`wrangler` permanently and dropping "bare Node, offline, free"), not a technical
blocker.

### D. Worker hub as a *peer* of the Node hub (most work, least common benefit)

Port `peer.js`'s custom protocol into a Worker so the two federate. Only worth it
for a genuine mixed-fleet requirement.

---

## 7. Open questions for a future session

- **DO storage model:** classic transactional KV vs. the SQLite-in-DO backend
  (the latter maps more naturally to an append-only op log and to future **log
  compaction**, a roadmap item).
- **Hibernation + liveness:** with hibernating WebSockets, what replaces the
  30s heartbeat reaper? (DO alarms, or lean on the platform's own socket lifecycle.)
- **Caps under a DO:** `maxOpsPerTrip` is naturally per-DO; `maxTrips` (global) has
  no single process to count in — needs a different mechanism or is dropped.
- **Metrics:** map the `siano_*` series onto Analytics Engine, or accept a reduced
  set.
- **Cross-operator federation:** the one thing a DO deployment does *not* give you
  that `peer.js` did (hubs run by different people). Still open; relates to
  `docs/e2e-encryption.md`.

---

## 8. Related docs

- `docs/architecture.md` — the op-log / reducer / dumb-relay design this leans on.
- `docs/security.md` — the current hub's threat model and the env knobs a Worker
  port would have to re-express (or make moot).
- `CLAUDE.md` — the file map (`hub/*`) and the buildless/zero-dep principle this
  trades against.
