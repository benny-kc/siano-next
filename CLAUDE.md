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
- **Per-file version — bump it whenever you edit a `client/js/**/*.js` file.**
  Every client module calls `registerVersion("js/…", N)` at import time (the
  number is embedded in the file). **When you change a file, increment its
  number by one.** The Settings drawer's **Debug** toggle (per-device,
  `siano:debug`) lists every loaded module's version, so a device can prove
  whether it's running your change or a stale cached copy — and because each
  module reports its OWN number, it pinpoints exactly which file is stale. This
  is a debugging aid, separate from the operator-only `SIANO_CLIENT_DEBUG`
  gating in `js/log.js`. `js/version.js` is the leaf registry (imports nothing,
  so it never creates a cycle for the asset-hash topo sort). This is on top of —
  not instead of — the service-worker `CACHE` bump below.

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
| `client/js/store/trips.js` | Device-local trip index (localStorage `siano:trips`, most-recent-first): `loadTrips`/`rememberTrip`/`forgetTrip`/`lastTripId`. Powers the Settings "Your trips" switcher and the resume-last-trip behaviour on a bare `/` visit. |
| `client/js/sync/client.js` | `SyncClient` — WebSocket to hub: hello-with-have, delta-on-reconnect, live fan-out. |
| `client/js/ui/board.js` | `render(snap, actions)` — repaints the game-like board (meal cards), the dock, the top bar and the drawer/report contents from the snapshot. Holds per-viewer UI state (`ui`: bills filter/sort, inline-share edit, ledger pick). |
| `client/js/ui/boardview.js` | `BoardView` — pan/zoom kept as CSS vars on `:root` (a repaint never resets the view) + screen↔canvas math. |
| `client/js/ui/viewstate.js` | `View` — the drawers / help / report / sort-popover open state, kept as data-attrs on `:root` (survives repaints), plus system-Back integration. |
| `client/js/ui/selection.js` | The "armed" traveller (single-select) shared by the renderer and gestures. |
| `client/js/ui/typography.js` | Per-device Appearance preferences (localStorage `siano:type`): font family, text size, **font weight** and **light/dark theme**, applied as CSS vars (`--siano-font`/`--siano-ui-scale`/`--siano-weight`) + `data-siano-theme` on `<html>` (also syncs the `theme-color` meta). The weight is an offset added to every `--fw-*` tier in `css/app.css`, so the stepper shifts the whole app's text heavier/lighter (not one bold toggle). System-font stacks only (offline/CSP-safe). The light theme is a warm-beige palette defined once as token overrides under `:root[data-siano-theme="light"]`. |
| `client/js/ui/fullscreen.js` | Optional "always full-screen" preference (localStorage `siano:fullscreen`, default off). When on, re-enters full-screen on any gesture (browsers only allow it from a user gesture); when off, the app is a normal page. Toggle lives in the Settings "Appearance" section. |
| `client/js/ui/install.js` | PWA install detection for the Settings "Install app" section. Captures `beforeinstallprompt`/`appinstalled` **at import time** (the one-shot event fires before the drawer opens), exposes `installState()` (`standalone`/`installable`/`ios`/`none`), `promptInstall()` (replays the stashed prompt — must run from a click), and `initInstall(repaint)`. There is **no way to force-install from a tab**: Chromium only lets you replay its captured prompt from a user gesture; iOS Safari has no API (manual "Add to Home Screen" only); desktop Firefox has neither. |
| `client/js/ui/interactions.js` | All pointer gestures wired ONCE by delegation on stable containers (survive repaints): pan/zoom, edge-swipe drawers, traveller drag-to-split, meal-card drag, long-press-to-set-share, and the in-page confirm dialog. |
| `client/index.html`, `css/app.css` | The fixed-viewport shell (top bar / board / dock / drawers / help / confirm) and the full game-like styling — a buildless, plain-CSS port of the reference app's Tailwind + custom look. |
| `client/js/vendor/qrcode.js` | Dependency-free QR encoder (`encodeText(text) -> {size, modules}`), a condensed port of Nayuki's public-domain library. Renders the trip-share QR in the Settings drawer. |
| `client/js/app.js` | Entry: wires store + sync + UI; defines `actions`; **rAF-coalesced paint, also deferred while a drag/pan is in flight**. |
| `client/js/log.js` | Operator-controlled client logging (see Logging). |
| `client/manifest.webmanifest`, `service-worker.js` | PWA manifest + offline-shell cache (bump `CACHE` + the `SHELL` list when adding a client module — see the caching gotcha). |
| `client/sw-register.js` | Registers the service worker from the `<head>` (loaded `async`). Kept as a **separate same-origin file, never inline** — the CSP is `script-src 'self'` with no `'unsafe-inline'`/hash, so an inline block is refused and the SW would never install (no offline shell, on iOS **and** Android). Guarded by a test (`security.test.mjs`, "no inline `<script>`"). |
| `client/icons/*` | Home-screen / install icons. `icon.svg` is the source; the PNGs (`icon-192`, `icon-512`, `apple-touch-icon`) are **rendered from it** and must be **fully-opaque, full-bleed amber** — a maskable icon with any transparent/white margin shows white borders once the launcher masks it. This env has no `rsvg`/`inkscape`; render with a throwaway `cairosvg` + `PIL` script (`pip install cairosvg pillow`), flattening onto amber and saving RGB. Keep the briefcase inside the maskable safe zone (~central 80%). |

**Hub (dependency-free Node relay):**
| Path | What |
|---|---|
| `hub/ws.js` | RFC 6455 WebSocket server: handshake + framing, bounded frames, masking/reserved/control-frame checks, `ping()`/`terminate()`, `"reject"` events. |
| `hub/log.js` | `TripLogs`: durable append-only JSONL per trip; async per-trip write queue; op/trip caps; `all`/`missing`/`flush`. |
| `hub/server.js` | `createHub({...})` factory (returns `{ httpServer, wss, logs, shutdown }`) + static server (env-controlled cache headers + optional asset hashing) + relay + heartbeat + logging + graceful shutdown. Auto-starts when run directly. |
| `hub/assets.js` | `buildAssets(clientDir)` — in-memory content-hash fingerprinting: rewrites the ESM import graph + `index.html` + service worker to `…<hash>.js` URLs (dependency-ordered; throws on an import cycle). Enabled by `SIANO_ASSET_HASHING`. |
| `hub/metrics.js` | `Metrics` (lifetime counters the hub bumps) + `render(metrics, live)` — Prometheus text exposition served at `GET /metrics`. **Token-gated (`SIANO_METRICS_TOKEN`), off (404) when unset** — series leak trip ids/volume. Covers client traffic, per-trip series, process, AND the **peer link** (`siano_peer_*`: link up/down, ops in/out, reconnects, inbound conns, auth failures). Dependency-free; scrape it with Grafana Alloy/Agent → Grafana Cloud (see docs/security.md → *Metrics / monitoring*). NB the peer counter Map fields (`peerOpsIn`/`peerOpsOut`) and the record methods (`peerRecvOps`/`peerSentOps`) are deliberately named differently — a same-named instance field would shadow the prototype method. |
| `hub/peer.js` | `createPeers({...})` — **hub-to-hub sync (Phase 2: one always-on multiplexed link per peer)**. A hub *dials* each `SIANO_PEER_URL` at startup and keeps that ONE socket up forever (reconnect/backoff), carrying EVERY trip (each frame names its `trip`). Not lazy — the link exists whenever the hub is up, so there's never data with nowhere to send it (link down ⇒ peer down ⇒ flushes on reconnect). A hub with no `SIANO_PEER_URL` is a **passive listener** (accepts inbound peer links; a single dial is bidirectional). Peer protocol: `phello`(token)→`ptrips`→`phave`/`pwant`/`pops`; on (re)connect the dialer reconciles the UNION of both hubs' trips (backlog both ways), then live ops flow as `pops`. Ingested peer ops fan to LOCAL leaves AND re-forward to OTHER peer links (dedup stops loops) — so 2-hub, star, chain, and mesh all converge. Peer conns offer the `siano-peer` subprotocol (Origin-exempt, rate-limit-exempt, larger frame cap `SIANO_PEER_MAX_MSG_BYTES`). Token auth (`SIANO_PEER_TOKEN`; unset ⇒ accept + warn once). See docs/security.md → *Hub-to-hub sync*. |

**Tests (`test/*.mjs`, `node --test`):** `split`, `money`, `budgets`, `reducer`
(merge rules + order-independent convergence), `hub` (real WS framing, fan-out,
delta), `peer` (two real hubs: one multiplexed always-on link syncing many trips
both ways, backlog flush on reconnect, token auth), `security` (caps, oversized-message close,
Origin/trip-id rejection, rate limit, headers), `metrics` (token-gated
`/metrics`: 404 when off, bearer auth, live + per-trip series).

---

## Sync protocol (client ⇄ hub, JSON text frames)

```
client -> hub  { t:"hello", trip, have:[opId,...] }
hub -> client  { t:"sync",  ops:[...], want:[opId,...] }
                  // ops the client lacked, PLUS op-ids the hub lacks that the
                  // client claims to have (its offline-created ops)
client -> hub  { t:"ops",   ops:[...] }        // answer to `want` (deduped on the hub)
client -> hub  { t:"op",    op }               // a new local op
hub -> client  { t:"op", op } | { t:"ops", ops:[...] }   // fan-out (never echoed to sender)
```

Sync is additive (ops only appended + deduped by `opId`), so a dropped
connection loses nothing — reconnect and exchange the delta. The exchange is
**bidirectional**: `sync.ops` catches the leaf up, and `sync.want` pulls the
leaf's offline-made ops back up to the hub (and thence to every other leaf), so
edits made while a device was offline propagate the moment it reconnects.

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
`SIANO_MAX_TRIPS`, `SIANO_HEARTBEAT_MS`, `SIANO_TRIP_ID_MAX`, `SIANO_PEER_URL`,
`SIANO_PEER_TOKEN`, `SIANO_PEER_MAX_MSG_BYTES`, `SIANO_METRICS_TOKEN`, `SIANO_DEBUG`, `SIANO_CLIENT_DEBUG`,
`SIANO_ASSET_HASHING`, `SIANO_CACHE_CONTROL`, `SIANO_CDN_CACHE_CONTROL`,
`SIANO_SW_CACHE_CONTROL`, `SIANO_FORCE_HTTPS`.
Defaults + meanings are tabled in docs/security.md.

**Static cache headers are env-controlled** (`hub/server.js`,
`resolveCacheConfig`). Default is `no-cache` everywhere (dev: revalidate always,
a Cloudflare purge always shows the latest). The service worker keeps its own
`SIANO_SW_CACHE_CONTROL` (default `no-cache`) so a cached SW can never pin the
old shell. Empty value ⇒ omit the header (Cloudflare extension defaults). A
strong `ETag` + `304` is sent in every mode.

**Content-hashed assets** (`hub/assets.js`, `SIANO_ASSET_HASHING=1`): at startup
the hub fingerprints the client — hashing JS in dependency order and rewriting
the ESM import graph + `index.html` + the service worker to `…<hash>.js` URLs —
all in memory, so source files stay unhashed and it's still buildless. Hashed
URLs are served `immutable`, so production needs **no CDN purge** on deploy; only
the tiny `no-cache` shell + SW revalidate. If the import graph ever gains a cycle
the build throws and the hub falls back to serving unhashed files. No cycles
today — keep `core/*` and `ui/*` acyclic (the topo sort depends on it).

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
- **The service worker is cache-first over the `SHELL`, so ANY shell edit needs a
  `CACHE` bump** in `client/service-worker.js` (`siano-shell-v<N>` — monotonic).
  Editing a cached file (`app.css`, any `SHELL` `.js`, `index.html`, an icon) with
  no bump → installed PWAs keep serving the old cached copy and never see the fix.
  Adding a **new** module additionally means adding its path to the `SHELL` list
  (and a `modulepreload` in `index.html`), or the install 404s the new import.
  When in doubt after touching anything under `client/`, bump the version. This
  bites hardest on installed PWAs (a plain browser tab revalidates via `ETag`);
  the last visible bug of "my change didn't ship" is almost always a missed bump.
- **`/env.js` must stay non-cached** (server `no-store`) so the debug flag is
  always live. The service worker serves it **network-first with a short timeout
  and a safe offline fallback** (`window.__SIANO_DEBUG__=false`) — never caching
  it — because it is a render-blocking classic `<script>` in `index.html`: a
  plain network bypass made an offline/poor-coverage device freeze the whole boot
  behind it (~10-20s on "0 bills" before the local DB rendered). Keep it uncached
  and keep the fallback fast; don't turn it back into a bare bypass.
- Client frames are masked; the hub's WS parser enforces it. Server→client frames
  are never masked.
- **The board repaints wholesale, so anything a repaint must not disturb lives on
  `<html>`, never inside a repainted region**: the pan/zoom transform (CSS vars,
  `boardview.js`) and the drawer/help/report open state (data-attrs,
  `viewstate.js`). This is the local-first equivalent of the reference relying on
  morphdom never touching `<html>`. Gestures are likewise wired ONCE by delegation
  on stable containers (`interactions.js`), not per-card, so they survive repaints.
- **Never repaint mid-drag/mid-pan.** `app.js`'s `schedulePaint` defers while
  `window.__sianoDragging` / `__sianoPanning` is set, or a remote op arriving
  mid-gesture would yank the card out from under the finger. The same flags let a
  real drag/pan suppress the drawer edge-swipe.
- When calling `element.replaceChildren(...)` directly (not via the `el()` helper,
  which filters them), **never pass a `null`/`false` child** — the DOM coerces it
  to the literal text `"null"`. Filter first (this bit the dock once — and again
  when `installSection()` returns `null` for an already-installed PWA, so
  `renderMenu` `.filter(Boolean)`s its section list).
- **The critical inline CSS in `index.html` defaults the modals to
  `pointer-events: none`** (so a hidden `#help-modal`/`#confirm-modal` never eats
  taps). A modal shown by JS MUST restore `pointer-events: auto` in `app.css`, or
  it renders on top but every tap falls straight through to the board beneath —
  buttons look present but "click the thing under them". `#help-modal` restores it
  via `:root[data-siano-help]`; `#confirm-modal` (toggled by `.hidden`) sets it on
  the base rule. This showed up as "the delete-trip Yes/No buttons do nothing" in
  the installed PWA. Any new overlay defaulted to `pointer-events:none` needs the
  same restore.

---

## iOS / iPhone (Safari + WebKit) parity — checked, don't reintroduce

The app is developed/tested on Android; these are the WebKit-specific traps that
make a gesture or field "work on Android, break on iPhone". All are fixed —
keep them fixed.

- **No inline `<script>` anywhere.** The CSP is `script-src 'self'` with no
  `'unsafe-inline'` and no hash, so WebKit (and Chromium) silently **refuse**
  any inline script body. This once blocked the SW-registration block →
  the service worker never installed → the installed PWA had **no offline
  shell** (iOS *and* Android). Registration now lives in `client/sw-register.js`
  (external, `async`). Guarded by `security.test.mjs`.
- **`-webkit-user-select` on form fields.** An ancestor with
  `-webkit-user-select: none` (e.g. `.meal-card`, so cards don't select while
  dragging) is inherited by inline `<input>`s, and iOS Safari then refuses to
  place a caret or accept typing — the amount/rename/exact-share fields silently
  became uneditable on iPhone. `app.css` restores `-webkit-user-select: text` on
  `input, textarea`. Don't drop it.
- **`-webkit-touch-callout: none` on long-press targets.** The press-and-hold
  (`.pchip .pbody`, 450 ms) fights iOS's native selection magnifier/callout
  unless BOTH the prefixed `-webkit-user-select: none` and
  `-webkit-touch-callout: none` are set (unprefixed alone is a no-op on iOS).
- **`gesture*` events on the board.** iOS fires proprietary
  `gesturestart`/`change`/`end` for a pinch and can page-zoom on them even with
  `touch-action: none`; `interactions.js` `preventDefault`s them on the board
  surface so a pinch drives our zoom, not the browser's.
- **CSV export.** iOS Safari ignores `<a download>` for blob URLs (it navigates
  the tab / drops a PWA out of the app), so `downloadReportCsv` routes through
  the Web Share API on iOS and keeps the plain download elsewhere.
- **PWA install** is manual on iOS (no `beforeinstallprompt`); `install.js`
  detects iOS and shows Add-to-Home-Screen instructions. The apple-prefixed
  `<meta>`s in `index.html` set standalone mode + status-bar style.
- **Can't run WebKit in this env** (Playwright's WebKit download is proxy-blocked;
  only Chromium is present), so a browser smoke test here validates the *code
  path* under an emulated iPhone but NOT WebKit's rendering — the fixes above are
  from WebKit's documented behaviour and still want a real-device pass.

## Roadmap / known gaps (good next tasks)

- **Offline op replay on reconnect** ✅ *(fixed)* — `SyncClient` used to only
  broadcast ops created *after* the connection opened; it did **not** push a
  device's pre-existing local ops on (re)connect, so bills made while a phone was
  offline stayed stranded on that one device even after it came back online
  (the "one phone has 8 bills, the other only 4" report). Fixed by making the
  `hello`/`sync` exchange bidirectional: the hub diffs the leaf's `have` list
  both ways and returns `sync.want` (op-ids it's missing that the leaf holds);
  the client answers by pushing those ops (batched, deduped on the hub). See the
  Sync protocol section. Regression test: `hub.test.mjs` ("pulls a reconnecting
  device's offline-made ops back up").
- **Board is ported** ✅ — the pannable/zoomable board, the traveller dock,
  drag-to-split, draggable meal cards, long-press-to-set-share, the slide-in
  Bills/Settings/Report drawers, help + in-page confirm, and the full game-like
  CSS now live under `client/js/ui/*` + `client/{index.html,css/app.css}`
  (buildless, plain-CSS port of the reference's Tailwind look). The Report drawer
  shows the full bills × travellers share matrix with Paid/Consumed/Net totals
  and a client-side CSV backup (`snapshot.report`, built in `snapshot.js`). The
  Settings drawer shares the trip via a Copy-link button and a scannable **QR
  code** (self-contained encoder in `client/js/vendor/qrcode.js`). What remains
  from the reference UI: bill **photos/OCR** (next item) and the first-run
  coach-mark hints.
- **Photo/OCR blob channel**: log carries `photoId` + fields; bytes sync
  opportunistically; the OCR service stays server-side (`lib/siano/ocr.ex` in the
  reference).
- **Per-device keypair signing of ops** (tamper-evidence + authorship; trip URL
  stays the capability).
- **Log compaction** (snapshot + tail) for long-lived trips — also bounds disk.
- **Multi-hub sync** ✅ *(Phase 2 done)* — `hub/peer.js`: a hub dials each
  `SIANO_PEER_URL` and keeps ONE always-on link up (reconnect/backoff) that
  **multiplexes every trip**. Active, not lazy — the link exists whenever the hub
  is up, so a hub is never holding data it can't send (link down ⇒ the peer is
  down ⇒ the backlog flushes via union reconciliation the moment the link
  returns). A hub with no `SIANO_PEER_URL` is a passive listener; one dial is
  bidirectional. Ingested peer ops re-forward to other peer links (dedup stops
  loops), so 2-hub, star, chain, and mesh all converge. Token-authed
  (`SIANO_PEER_TOKEN`). Next: digest-based reconciliation (avoid re-sending every
  op-id on reconnect for very large hubs), and a shared-secret/Access story for
  federating hubs you don't both operate. (NB: sharing one log *directory*
  between hubs is **not** live sync — each caches trips in memory; the peer link
  is the mechanism.)

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
