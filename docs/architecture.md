# siano-next architecture — local-first, strong eventual consistency

siano-next is a rewrite of [Siano](https://github.com/benny-kc/siano) (an
Elixir/Phoenix LiveView app where the server owns all state) into a
**local-first** app: every device holds the complete trip, writes to it
instantly — online or offline — and all copies converge once they can talk. The
product idea is unchanged (travellers, meals as cards, drag-to-split, a live
shared board, OCR bills); the architecture is what's new.

> This document is the canonical design. It was lifted from the planning-session
> handoff and expanded with the concrete operation set and merge rules now
> implemented in `client/js/core`.

## Why not "highly consistent"?

The original ask was for a "highly consistent distributed DB." Strict
(linearizable) consistency is incompatible with "the phone is a database that
accepts writes while offline" — that's CAP. So we adopt **strong eventual
consistency** instead:

> Every device writes to its local copy immediately. All copies converge once
> connected. The guarantee is: **everyone who has seen the same set of
> operations computes the same balances, regardless of the order they arrived.**

## Shape

```
  Phone A ──┐                    ┌── Phone D
  (full DB) │                    │  (full DB)
  Phone B ──┤◀──▶ Hub / Relay ◀──┤── Phone E
  (full DB) │   (durable log +   │  (full DB)
  Phone C ──┘    fan-out relay)  └── ...
   every leaf holds the COMPLETE trip; the hub is just an always-on replica
```

## Three core commitments

### 1. Store operations, not rows (event sourcing)

We sync an **append-only log of intent-ops**, not table rows:

```
{ op: "add_meal",        mealId, name, ... ,        lamport, device, vv }
{ op: "set_amount",      mealId, cents: 4200,       lamport, device, vv }
{ op: "add_participant", mealId, memberId,          lamport, device, vv }
{ op: "set_share",       mealId, memberId, cents, locked, lamport, device, vv }
```

Every device folds the log into current state with the **same pure reducer**
(`client/js/core/reducer.js`) and then derives the board with the same pure
snapshot builder (`snapshot.js`) — this is the reference app's `Splitter` /
`Snapshot` math moved client-side. Benefits:

- **Trivial, robust sync** — "here are the ops you're missing."
- **The log IS the backup** — any leaf can re-seed the hub; the hub is the
  most-available replica, not the source of truth. (This solves the original
  backup/recovery concern.)

### 2. Money conflicts are intentional, never automatic

We do **not** grab a generic CRDT and let last-writer-wins silently edit money.

- **Membership sets** (members, meals, participants, photos) → **add-wins
  OR-Set**. Add/remove commute cleanly; a concurrent re-add survives a remove.
  This is most of the data and is genuinely conflict-free.
- **Money scalars** (a meal's amount, a locked share) → **LWW by clock for the
  converged value, but a genuinely concurrent differing edit is surfaced as a
  conflict** ("⚠ two people set this at once — pick one") rather than silently
  overwritten. Same philosophy as the reference app's red `diff_cents` badge:
  surface the discrepancy, let humans reconcile.
- **Integer cents everywhere**, client and hub. Floats never cross a boundary.

Concurrency is detected exactly using a **version vector** carried on every op
(see below), so "concurrent" means *causally* concurrent — not merely "close in
time."

### 3. The hub is a dumb, durable relay — not a brain

Its only jobs: durably append every op, fan out to connected leaves, and hand a
returning leaf the delta. **No business logic on the hub** — it literally cannot
compute a balance. This keeps "all logic in static files on the client" true.
Two hubs behind one shared log directory would be active-active; one is plenty.

## How merge actually works (the reducer)

Each op carries causal metadata from its author's `Clock`
(`client/js/core/lamport.js`):

- `lamport` — a Lamport timestamp giving a deterministic **total order** (the
  LWW tiebreak, so all devices converge on one value).
- `device` — the author id (and secondary tiebreak within a lamport tick).
- `vv` — a **version vector**: the highest lamport this device had seen from
  every device at the moment it created the op (its causal past).

From these we derive one primitive, the **causal frontier** of a set of ops for
one field: the ops not causally-followed by any other op in the set (`A`
causally-follows `B` iff `A.vv[B.device] >= B.lamport`). Everything else is built
on the frontier:

| Field kind | Rule |
|---|---|
| Membership (OR-Set) | Present iff the frontier of its add/remove events contains an **add** (add-wins). |
| Plain scalar (names, emoji, board position, open flag) | Frontier op with the greatest `(lamport, device)` wins. |
| **Money scalar** (amount, locked share) | Same LWW winner **for convergence**, but any *other* frontier op with a different value is recorded as a **conflict** on the meal. |

A single-op frontier ⇒ a clean edit (no conflict). A multi-op frontier ⇒ those
ops were mutually concurrent ⇒ add-wins for membership, conflict-surfaced for
money.

Because the fold depends only on the ops' causal metadata (never arrival order),
`fold(ops)` is deterministic under reordering — the strong-eventual-consistency
guarantee. This is covered by `test/reducer.test.mjs` (`convergence: folding the
same ops in any order yields identical state`).

## The operation set

Defined in `client/js/core/ops.js`:

- Trip: `set_trip_name`
- Members: `add_member`, `remove_member`, `set_member_name`, `set_member_budget`
- Meals: `add_meal`, `remove_meal`, `set_meal_name`, `set_meal_emoji`,
  `set_amount` *(money)*, `set_payer`, `add_participant`, `remove_participant`,
  `set_share` *(money; `locked:false` clears a custom share)*, `move_meal`,
  `set_open`
- Photos/OCR: `add_photo`, `set_photo_fields`, `assign_field`

## Domain rules that MUST survive (from the reference app's CLAUDE.md)

- Money is always **integer cents**, client and hub.
- Meals split **per person**, but balances/settlements are **per budget** (a
  budget = people pooling money, e.g. a couple; resolved as union-find connected
  components over `budgetId` — `client/js/core/budgets.js`).
- **Locked/custom shares are honoured exactly — never clamped or nudged.** Only
  unlocked participants absorb the remainder; any gap surfaces as `diffCents` for
  humans to reconcile. (This was the bug behind two "a fixed share got silently
  edited" reports.)
- Removing a member scrubs every dangling reference (the snapshot defends against
  stale ids so one bad reference can never crash the render).

## Component map

| Path | What |
|---|---|
| `client/js/core/money.js` | `parse`/`format`/`extract` — string ↔ integer cents. Ported from `Siano.Trips.Money`. |
| `client/js/core/split.js` | `evenSplit`/`customSplit`/`balances`/`settlements`. Ported from `Siano.Trips.Splitter`. **Never clamps a locked share.** |
| `client/js/core/budgets.js` | Union-find budget resolution + rollup. Ported from `Snapshot.resolve_budgets`/`build_budgets`. |
| `client/js/core/lamport.js` | `Clock` (Lamport + version vector), `frontier`, `causallyAfter`, `compareOps`, `opId`. |
| `client/js/core/ops.js` | The concrete op set + stamped constructors. |
| `client/js/core/reducer.js` | `fold(tripId, ops) -> state`. The heart: OR-Set + LWW + money-conflict merge. |
| `client/js/core/snapshot.js` | `buildSnapshot(state)` — the view the board renders. Ported from `Snapshot.build_snapshot`. |
| `client/js/store/idb.js` | Tiny promise wrapper over IndexedDB (dependency-free; swap in Dexie later). |
| `client/js/store/oplog.js` | `OpLog` (pure, testable) + `openTripStore` (IndexedDB-backed): the device's full copy. |
| `client/js/sync/client.js` | `SyncClient` — WebSocket to the hub; hello-with-have, delta-on-reconnect, live fan-out. |
| `client/js/ui/board.js` + `app.js` | Minimal functional board + wiring. |
| `hub/ws.js` | Dependency-free WebSocket server (RFC 6455 handshake + framing). |
| `hub/log.js` | Durable append-only JSONL op log per trip (dedup + delta). |
| `hub/server.js` | The hub: static client server + relay. `createHub()` factory. |

## Decisions (and the picks made)

| Decision | Pick | Why |
|---|---|---|
| Sync/convergence | **Roll-your-own op-log** | Tiny domain; money needs a custom merge. A full sync engine drags in a server DB, fighting the "static client + dumb hub" goal. |
| On-device store | **IndexedDB** (thin wrapper; Dexie-swappable) | Store op-log + a memoized folded snapshot. |
| Transport | **WebSocket to hub (v1)** | Simple, NAT-friendly. WebRTC peer-to-peer is a later option. |
| Hub runtime | **Node.js, dependency-free** | One language across client + hub; runs with just `node hub/server.js`. |
| Photos (OCR bills) | **Separate blob channel** (planned) | Log carries `photoId` + OCR fields; bytes sync opportunistically. |
| Identity/trust | **Trip URL = capability; per-device keypair signs ops** (planned) | No accounts, no server user model — matches the reference app. |

## What's built vs. what's next

**Built and tested** (`node --test`, plus a real-browser smoke test):
the pure core (money, split, budgets, snapshot), the op set + version-vector
clock, the merge reducer (OR-Set add-wins, LWW, money-conflict detection,
order-independent convergence), the IndexedDB op-log store, the WebSocket sync
client, the dependency-free Node hub (fan-out + delta-on-reconnect), and a
minimal functional board.

**Next** (see `README.md` roadmap): port the reference app's pannable/zoomable
board and drag-to-split gestures (`assets/js/hooks/*` are largely portable);
the photo/OCR blob channel; per-device keypair signing of ops; log compaction
(snapshot + tail) for long-lived trips; a second active-active hub.
