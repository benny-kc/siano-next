# siano-next

A **local-first** rewrite of [Siano](https://github.com/benny-kc/siano) — a
real-time, game-like bill-splitting app for a group trip. Travellers, meals as
cards, drag-to-split, a live shared board, OCR bills. The product idea is the
same; the architecture is new: every device holds the complete trip and writes
to it instantly (online or offline), and all copies converge through an
append-only log of operations relayed by a dumb hub.

> The original Siano is Elixir/Phoenix LiveView with the server owning all
> state. siano-next moves all the logic into static client files and reduces the
> server to a durable relay. See **[docs/architecture.md](docs/architecture.md)**
> for the full design and rationale.

## Highlights

- **Offline-first.** The phone is the database. Edits apply locally and sync
  when a hub is reachable; nothing is lost if it isn't.
- **Event-sourced.** The synced unit is an op (`add_meal`, `set_amount`, …), not
  a row. The log *is* the trip and *is* the backup — any device can re-seed the
  hub.
- **Deterministic convergence.** Every device folds the same log with the same
  pure reducer and computes the same balances, regardless of arrival order.
- **Money is never silently merged.** Membership uses an add-wins OR-Set;
  money scalars use LWW for the converged value but **surface genuinely
  concurrent conflicting edits** for humans to reconcile. Integer cents
  everywhere.
- **No build step, no dependencies.** The client is plain ESM served as static
  files. The hub is one dependency-free Node file.

## Layout

```
client/   Static PWA — plain HTML/CSS/ESM, no build step.
  js/core/    Pure logic: money, split, budgets, snapshot, clock, ops, reducer.
  js/store/   IndexedDB op-log store.
  js/sync/    WebSocket sync client.
  js/ui/      Minimal board renderer.
hub/      Dependency-free Node.js relay: WebSocket server + durable JSONL log.
docs/     Architecture.
test/     node:test suites (pure core, reducer merge rules, hub end-to-end).
```

## Run it

Requires **Node 18+** (developed on Node 22). No `npm install` needed — there
are no dependencies.

```bash
node hub/server.js
# → siano hub listening on http://localhost:4000
```

Open <http://localhost:4000>. A fresh visit mints a trip at `/t/<id>`; open that
same URL on another device/tab (pointed at the same hub) and edits sync live.
The hub binds `127.0.0.1` by default (put a tunnel/proxy in front — see below);
configure with `HOST`, `PORT`, and `SIANO_DATA_DIR` (default `./siano_data`).

The app also runs with **no hub at all** — open `client/index.html` and it works
offline against IndexedDB; it just won't sync until it can reach a hub.

## Test

```bash
node --test        # pure core, reducer/merge rules, and the hub end-to-end
```

The reducer suite includes the key guarantees: locked shares are never clamped,
balances stay exact, OR-Set is add-wins, concurrent money edits surface a
conflict (and a sequential edit does not), and folding in any order yields
identical state. The hub suite exercises the real WebSocket framing, fan-out,
and delta-on-reconnect. The security suite covers the hub's abuse guards
(oversized-message rejection, Origin allowlist, trip-id validation, rate limit,
disk caps, security headers).

## Security

The hub is meant to sit behind a tunnel or reverse proxy (e.g. Cloudflare
Tunnel). It binds loopback by default and ships with WebSocket size/rate limits,
a connection cap, a heartbeat reaper, disk caps, input validation, security
headers, and an optional Origin allowlist — all env-configurable. There is **no
built-in auth**: the trip URL is the capability. For private trips, put
Cloudflare Access (or equivalent) in front. Full threat model, tuning knobs, and
a hardened systemd unit are in **[docs/security.md](docs/security.md)**.

## Roadmap

- Port the reference app's pannable/zoomable board and drag-to-split gestures
  (`assets/js/hooks/*` in the siano repo are largely portable).
- Photo/OCR blob channel (log carries `photoId` + fields; bytes sync
  opportunistically; the OCR service stays server-side).
- Per-device keypair signing of ops (tamper-evidence + authorship; trip URL is
  the capability — no accounts).
- Log compaction (snapshot + tail) for long-lived trips.
- A second active-active hub behind the shared log.

## License

Apache-2.0 (same as the reference app). See [LICENSE](LICENSE).
