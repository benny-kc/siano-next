# siano-next — agent & developer guide

**siano-next** is a **local-first** rewrite of [Siano](https://github.com/benny-kc/siano)
(the reference app: Elixir/Phoenix LiveView, server owns all state). It keeps the
product idea — a game-like bill-splitter for a group trip: travellers as tokens,
meals/bills as cards, drag-to-split, a live shared board, OCR bills — but changes
the architecture: **every device holds the complete trip and writes to it
instantly (online or offline); copies converge through an append-only log of
operations relayed by a dumb hub.**

> Read **[docs/architecture.md](docs/architecture.md)** for the full design and
> **[docs/security.md](docs/security.md)** for the threat model and hardening.
> This file is the quick operational guide — read it before making changes.

---

## Working in this environment (READ FIRST)

- **No build step, no dependencies.** The client is plain ES modules served as
  static files. The hub is dependency-free Node (no `npm install`).
- **Verify JS syntax** with `node --check <file>`.
- **Run the tests** with `node --test` (Node 18+; developed on Node 22). This is
  the real signal — the pure core, the merge reducer, and the hub all have
  tests. Keep it green.
- **Run the app**: `node hub/server.js`, open the printed URL. A fresh visit
  mints a trip at `/t/<id>`; open the same URL elsewhere (same hub) to see live
  sync. It also runs with **no hub** — open `client/index.html`; it works offline
  against IndexedDB and just doesn't sync until a hub is reachable.
- **Browser smoke test** (optional, catches runtime/CSP issues `node --test`
  can't): Playwright + the preinstalled Chromium at `/opt/pw-browsers/chromium`
  drive two tabs through edit → op → fold → render → sync. See the session
  history for the throwaway script pattern.
- `.js` under `client/` is ESM because `client/package.json` sets
  `"type":"module"`; the hub is ESM via `hub/package.json`. Tests are `.mjs`.
  **`Date.now()`/`Math.random()` are fine here** (normal Node/browser, not a
  workflow sandbox).

---

## Architecture in one screen

```
  Phone A ──┐                    ┌── Phone D
  (full DB) │                    │  (full DB)
  Phone B ──┤◀──▶ Hub / Relay ◀──┤── Phone E
  (full DB) │  (durable op log   │  (full DB)
  Phone C ──┘   + fan-out relay) └── ...
```

- **Event sourcing.** The synced unit is an **op** (`add_meal`, `set_amount`, …),
  not a row. Every device folds the same op-log with the **same pure reducer**
  into `state`, then `buildSnapshot(state)` derives what the board renders. The
  log *is* the trip and *is* the backup — any leaf can re-seed the hub.
- **Strong eventual consistency, not linearizable.** `fold(ops)` is deterministic
  in the ops' causal metadata, independent of arrival order. Guarantee: everyone
  who has seen the same set of ops computes the same balances.
- **The hub is a dumb relay** — durably append, fan out, hand a returning leaf
  the delta. **No business logic on the hub** (it can't compute a balance).

### Causal metadata & merge rules (the heart)

Every op carries `{ lamport, device, vv }` from its author's `Clock`
(`client/js/core/lamport.js`): a Lamport timestamp (deterministic **total order**
= the LWW tiebreak), the author id, and a **version vector** (`vv` = highest
lamport seen from each device when the op was made). `vv` is what distinguishes
**causal** from **concurrent** edits — a Lamport clock alone can't.

One primitive drives everything: the **causal frontier** of a field's ops (those
not causally-followed by any other). `A` follows `B` iff `A.vv[B.device] >= B.lamport`.

| Field kind | Rule (in `reducer.js`) |
|---|---|
| Membership sets (members, meals, participants, photos) | **add-wins OR-Set**: present iff the frontier contains an add. A concurrent re-add survives a remove. |
| Plain scalars (names, emoji, board position, open flag) | **LWW**: frontier op with greatest `(lamport, device)` wins. |
| **Money scalars** (meal amount, locked share) | LWW winner **for convergence**, but a genuinely concurrent differing frontier value is recorded as a **conflict** on the meal (surfaced in the UI as "⚠ two people set this at once"). Money is never silently overwritten. |

---

## The operation set (`client/js/core/ops.js`)

- Trip: `set_trip_name`
- Members: `add_member`, `remove_member`, `set_member_name`, `set_member_budget`
- Meals: `add_meal`, `remove_meal`, `set_meal_name`, `set_meal_emoji`,
  `set_amount` *(money)*, `set_payer`, `add_participant`, `remove_participant`,
  `set_share` *(money; `locked:false` clears a custom share)*, `move_meal`, `set_open`
- Photos/OCR: `add_photo`, `set_photo_fields`, `assign_field`

Create ops via the `ops.js` constructors (they stamp the clock). Emit them through
`log.emit((c) => ops.setAmount(c, mealId, cents))` so they persist + broadcast.

---

## Domain rules that MUST survive (from the reference app)

- **Money is always integer cents**, client and hub. Never sync floats.
- Meals split **per person**, but balances/settlements are **per budget** (a
  budget = people pooling money, e.g. a couple; resolved as union-find connected
  components over `budgetId` in `client/js/core/budgets.js`).
- **Locked/custom shares are honoured exactly — never clamped or nudged.** Only
  unlocked participants absorb the remainder; any gap surfaces as `diffCents` for
  humans to reconcile. (Clamping was the bug behind two "a fixed share got
  silently edited" reports — don't reintroduce it.)
- Removing a member must not crash the render — `snapshot.js` defends against
  dangling ids everywhere.

---

## File map

**Client core (pure, tested — the reducer/math):**
| Path | What |
|---|---|
| `client/js/core/money.js` | `parse`/`format`/`extract` — string ↔ integer cents. |
| `client/js/core/split.js` | `evenSplit`/`customSplit`/`balances`/`settlements`. Never clamps a locked share. |
| `client/js/core/budgets.js` | Union-find budget resolution + rollup. |
| `client/js/core/lamport.js` | `Clock` (Lamport + version vector), `frontier`, `causallyAfter`, `compareOps`, `opId`. |
| `client/js/core/ops.js` | The op set + stamped constructors; `MONEY_OPS`. |
| `client/js/core/reducer.js` | `fold(tripId, ops) -> state`. OR-Set + LWW + money-conflict merge. |
| `client/js/core/snapshot.js` | `buildSnapshot(state)` — the view the board renders. |

**Client runtime (browser-only, not unit-tested — verify in-browser):**
| Path | What |
|---|---|
| `client/js/store/idb.js` | Tiny promise wrapper over IndexedDB (dependency-free; Dexie-swappable). |
| `client/js/store/oplog.js` | `OpLog` (pure) + `openTripStore` (IndexedDB-backed): the device's full copy. `emit`/`ingest`/`ingestMany`/`snapshot`/`subscribe`. |
| `client/js/sync/client.js` | `SyncClient` — WebSocket to hub: hello-with-have, delta-on-reconnect, live fan-out. |
| `client/js/ui/board.js` | `render(root, snap, actions)` — minimal functional board (full re-render). |
| `client/js/app.js` | Entry: wires store + sync + UI; defines `actions`; **rAF-coalesced paint**. |
| `client/js/log.js` | Operator-controlled client logging (see Logging). |
| `client/index.html`, `css/app.css`, `manifest.webmanifest`, `service-worker.js` | PWA shell. |

**Hub (dependency-free Node relay):**
| Path | What |
|---|---|
| `hub/ws.js` | RFC 6455 WebSocket server: handshake + framing, bounded frames, masking/reserved/control-frame checks, `ping()`/`terminate()`, `"reject"` events. |
| `hub/log.js` | `TripLogs`: durable append-only JSONL per trip; async per-trip write queue; op/trip caps; `all`/`missing`/`flush`. |
| `hub/server.js` | `createHub({...})` factory (returns `{ httpServer, wss, logs, shutdown }`) + static server + relay + heartbeat + logging + graceful shutdown. Auto-starts when run directly. |

**Tests (`test/*.mjs`, `node --test`):** `split`, `money`, `budgets`, `reducer`
(merge rules + order-independent convergence), `hub` (real WS framing, fan-out,
delta), `security` (caps, oversized-message close, Origin/trip-id rejection, rate
limit, headers).

---

## Sync protocol (client ⇄ hub, JSON text frames)

```
client -> hub  { t:"hello", trip, have:[opId,...] }
hub -> client  { t:"sync",  ops:[...] }        // ops the client lacked
client -> hub  { t:"op",    op }               // a new local op
hub -> client  { t:"op", op } | { t:"ops", ops:[...] }   // fan-out (never echoed to sender)
```

Sync is additive (ops only appended + deduped by `opId`), so a dropped
connection loses nothing — reconnect and exchange the delta.

---

## Security & hardening (behind a Cloudflare Tunnel)

Full detail in **docs/security.md**. Key points:
- **No built-in auth** — the trip URL is the capability (122-bit random id). For
  private trips, put **Cloudflare Access** in front.
- Hub defaults to binding **`127.0.0.1`** (`HOST`). ⚠ If your tunnel/proxy
  reaches it over a network (separate container/host), set `HOST=0.0.0.0` or it
  returns 502 at the edge. (This was the cause of an outage.)
- Guards: bounded WebSocket messages (256 KiB) checked before buffering,
  connection cap, per-connection rate limit, heartbeat reaper, async writes with
  per-trip op cap + global trip cap, trip-id validation, GET/HEAD-only static +
  path-traversal check, tight CSP + security headers, optional Origin allowlist,
  HTTP timeouts, graceful shutdown.

### Environment variables
`HOST`, `PORT`, `SIANO_DATA_DIR`, `SIANO_MAX_MSG_BYTES`, `SIANO_MAX_CONNECTIONS`,
`SIANO_MAX_MSGS_PER_SEC`, `SIANO_ALLOWED_ORIGINS`, `SIANO_MAX_OPS_PER_TRIP`,
`SIANO_MAX_TRIPS`, `SIANO_HEARTBEAT_MS`, `SIANO_TRIP_ID_MAX`, `SIANO_DEBUG`,
`SIANO_CLIENT_DEBUG`. Defaults + meanings are tabled in docs/security.md.

## Logging (troubleshooting)

- **Hub:** always-on operational logs (startup config, refused upgrades,
  rate-limit/invalid-trip closes). `SIANO_DEBUG=1` adds per-request/per-op debug
  (op **type + ids + lamport only** — never payloads, so no trip data leaks).
- **Client:** operator-controlled, **off by default, not user-switchable**. The
  hub serves `/env.js` (never cached) setting `window.__SIANO_DEBUG__` from
  `SIANO_CLIENT_DEBUG`; `client/js/log.js` reads it. `dlog`/`dwarn` are gated;
  `derror` always prints (devtools-only). Flip the env var + restart, then reload
  the client. There is intentionally **no `?debug` switch** — don't add one back.

---

## Gotchas learned (don't reintroduce)

- **Full re-render must not run synchronously inside an input change/blur
  handler** — replacing the board's children mid-blur races the browser's focus
  teardown and throws. `app.js` coalesces paints into `requestAnimationFrame`.
  Keep it that way (or move to targeted DOM updates).
- **Adding a new client module means updating the service worker**: add it to the
  `SHELL` list AND bump the `CACHE` version in `client/service-worker.js`, or
  installed PWAs keep serving the old cached shell (cache-first) / 404 the new
  import. (SW is currently `v3`.)
- **`/env.js` must stay non-cached** (server `no-store` + SW bypass) so the debug
  flag is always live.
- Client frames are masked; the hub's WS parser enforces it. Server→client frames
  are never masked.

---

## Roadmap / known gaps (good next tasks)

- **Offline op replay on reconnect (bug):** `SyncClient` currently only
  broadcasts ops created *after* the connection opens; it does **not** push a
  device's pre-existing local ops on (re)connect. The hub hands the client its
  delta, but the client doesn't hand the hub *its* unseen ops. Fix: on `hello`,
  have the hub also reply with what it wants, or have the client push ops the hub
  is missing (it can diff `have` both directions, or just resend all local ops —
  they dedupe). Until fixed, ops made while fully offline may not propagate.
- **Port the reference board**: pannable/zoomable board + drag-to-split gestures
  (`assets/js/hooks/*` in the siano repo are largely portable) and the richer CSS.
- **Photo/OCR blob channel**: log carries `photoId` + fields; bytes sync
  opportunistically; the OCR service stays server-side (`lib/siano/ocr.ex` in the
  reference).
- **Per-device keypair signing of ops** (tamper-evidence + authorship; trip URL
  stays the capability).
- **Log compaction** (snapshot + tail) for long-lived trips — also bounds disk.
- **Second active-active hub** behind the shared log dir.

---

## Conventions

- Match surrounding code density and comment style; many comments encode a fixed
  bug — don't strip them.
- Integer cents everywhere. Keep `core/*` pure and Phoenix/DOM-free so it stays
  unit-testable under `node --test`.
- Don't add dependencies casually — buildless + zero-dep is a core selling point.
- Mobile-first PWA. Avoid anything that would need a native dialog.
- Reference base for domain rules / reusable logic: the `benny-kc/siano` repo
  (branch `claude/mobile-server-data-sync-n2y0xj` has the handoff note); its
  `CLAUDE.md` documents the original domain in depth.
