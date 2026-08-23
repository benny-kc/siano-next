# Offline peer-to-peer sync (Bluetooth & alternatives) — planning notes

**Status:** research / planning only. Nothing here is built. The question:

> Two phones are physically next to each other, both with **no internet**
> (no Wi-Fi, no cellular). Can they enable **Bluetooth** and sync bills
> directly between the two devices, with no hub?

Short answer: **not with Bluetooth from a browser/PWA today** — the web
platform doesn't allow it. But the goal ("two nearby phones converge with no
hub") is very achievable, and siano-next's architecture is unusually well
suited to it. This doc lays out what's possible, what isn't, and a recommended
path.

---

## 1. Why this fits siano-next so well

The hard part of peer-to-peer sync — conflict resolution — is **already solved
and already local**. Nothing about our merge model assumes a hub:

- The synced unit is an **op**, and every device folds the same append-only log
  with the same pure reducer (`client/js/core/reducer.js`). Convergence is
  guaranteed for anyone who has seen the same *set* of ops, **independent of
  arrival order or transport** (`docs/architecture.md`). Bluetooth vs.
  WebSocket vs. QR code is just a different pipe.
- The hub is already "a dumb relay" with **no business logic** — it only
  durably appends and fans out. A second phone can play the exact same role for
  a peer: "here are the ops I have, tell me what you're missing."
- Sync is **additive and idempotent**: ops are only ever appended and deduped
  by `opId`. A partial or interrupted exchange loses nothing — reconnect and
  re-run the delta. This is exactly what you want over a flaky short-range link.

### The protocol is already transport-agnostic

The whole client↔hub exchange is four JSON message shapes
(`client/js/sync/client.js`):

```
hello { trip, have:[opId…] }      → sync { ops:[…], want:[opId…] }
op    { op }                       (live fan-out, never echoed to sender)
ops   { ops:[…] }                  (batched answer to `want`)
```

And the op-log exposes exactly the primitives a peer transport needs, with no
WebSocket assumption baked in (`client/js/store/oplog.js`):

- `log.have()` → the op-ids I hold (the basis for delta negotiation)
- `log.get(id)` → fetch one op to answer a `want`
- `log.ingestMany(ops)` → merge received ops (returns only the new ones)
- `log.subscribe(({ ops, local }) => …)` → fire on new local ops to forward them

`SyncClient` is instantiated in exactly one place (`client/js/app.js:333`,
`new SyncClient(wsUrl(), log, …)`). **Any transport that can (a) move those JSON
frames between two devices and (b) do the two-way `have`/`want` diff could be
dropped in beside it** with no change to the reducer, the store, or the UI. That
is the single most important finding here: the cost of a new transport is a new
`*Client` class, not an architecture change.

---

## 2. Can a browser/PWA do Bluetooth phone-to-phone? — No

This is the crux, and the answer is a hard no on today's web platform.

### Web Bluetooth API — central-only, and no iOS

- **Browsers can only act as a GATT _central_ (client)** — they connect *to* a
  Bluetooth peripheral (a heart-rate strap, a thermometer). A browser
  **cannot advertise itself as a GATT peripheral/server**. So there is no way
  for two phone *browsers* to discover and connect to each other: neither one
  can be the thing the other connects to. Web Bluetooth is built for
  browser-to-gadget, not browser-to-browser.
- **iOS/iPadOS Safari does not support Web Bluetooth at all** (Apple has
  declined to ship it, citing privacy/fingerprinting). It only exists in
  Chromium browsers, and on iOS every browser is WebKit underneath — so it's
  absent there too. Given siano-next explicitly targets iPhone parity
  (`CLAUDE.md` → "iOS / iPhone parity"), an Android-only, browser-to-gadget-only
  API is a dead end for this use case.
- Even setting the above aside, Web Bluetooth requires a user gesture + a device
  chooser per connection and a secure context — usable for pairing a sensor,
  awkward for an ongoing device-to-device session.

**Verdict:** Web Bluetooth cannot sync two phones running siano-next in the
browser. This isn't a limitation we can code around; it's the shape of the API.

### What about other "just works offline" web transports?

| Transport | Phone↔phone, no internet? | iOS? | Verdict for us |
|---|---|---|---|
| **Web Bluetooth** | ❌ central-only, can't be a peer | ❌ | Not usable |
| **WebRTC DataChannel** | ⚠️ needs a shared *local IP* link (Wi-Fi / hotspot) + out-of-band signaling | ✅ | **Best pure-web option** (see §3) |
| **Web NFC** | tap-only, tiny NDEF, Android Chrome only | ❌ | Bootstrap/handoff at most |
| **QR code / file "sneakernet"** | ✅ fully offline, everywhere | ✅ | **Great fallback / bootstrap** (see §3) |
| **Local WebSocket to a phone-hosted hub** | ❌ browsers can't be servers; hub is Node | — | Not usable in-browser |

The realistic conclusion: **on the pure web, "no network at all" + real
Bluetooth is not reachable.** What *is* reachable offline is (a) WebRTC over a
local Wi-Fi/hotspot island, and (b) QR/file transfer that needs no radio pairing
at all.

---

## 3. What actually works — two pure-web offline paths

### Path A — WebRTC DataChannel over a local network (no internet)

WebRTC gives a **direct, encrypted, peer-to-peer data channel** and — crucially
— **is supported on iOS Safari**. It does not need the internet; it needs a
shared local IP link and a way to exchange the initial handshake (SDP + ICE
candidates).

- **The link:** both phones on the same local Wi-Fi, **or one phone's personal
  hotspot** (devices on a hotspot can reach each other on the local subnet even
  when the host has no upstream internet). This is the practical stand-in for
  "no coverage but physically together." It is Wi-Fi radio, not Bluetooth — but
  it meets the actual user need.
- **The signaling (normally the hard part):** we don't need a signaling server.
  The SDP offer/answer can be exchanged **out of band via a QR code** (phone A
  shows a QR of its offer, phone B scans and shows a QR of its answer). We
  already ship a dependency-free QR **encoder** (`client/js/vendor/qrcode.js`)
  for the trip-share code; this path additionally needs a QR **scanner**
  (camera + a decode step), which is the main new piece.
- **After handshake:** the DataChannel carries the *exact same* `hello`/`have`/
  `want`/`op` frames. `SyncClient` barely changes — swap `this.ws.send(…)` /
  `ws.onmessage` for `channel.send(…)` / `channel.onmessage`.

Cost: a QR scanner + a `WebRtcPeerClient` (~a few hundred lines, mostly the ICE
dance). No new dependency for the crypto/transport (browser-native), one for
scanning if we don't hand-roll it.

Caveat: mDNS-obfuscated ICE candidates and captive-portal-free hotspots make
this finicky in practice; it wants real two-device testing. And it's still
Wi-Fi — if the environment truly has *no* radio the phones can share, this
can't form a link either.

### Path B — QR / file "sneakernet" (works literally anywhere)

The op-log is small and additive, so you can move the delta **without any live
connection at all**:

- Phone A exports "the ops phone B is missing" (or just the whole log for a
  small trip) as a **QR code** (chunked if large) or a **downloadable/shared
  file**. Phone B scans/imports it → `ingestMany` → converged. Then reverse the
  direction for a full two-way sync.
- Fully offline, **works on every device including iPhone**, needs no pairing,
  no radio, no permissions beyond the camera (for QR) or the share sheet (for a
  file). iOS file/share quirks are already handled once for CSV export
  (`downloadReportCsv` routes through the Web Share API on iOS — same trick
  applies).
- Downside: manual and not continuous. Great for "sync once before we split the
  bill," poor for "keep two phones live all evening."

This is the lowest-risk, highest-portability option and a natural **first
increment** — it also builds the QR-scan + export/import plumbing that Path A
reuses.

---

## 4. If we genuinely need Bluetooth: go native (big decision)

The *only* way to get real phone-to-phone **Bluetooth** is to stop being a pure
PWA and ship a native shell. That is a significant departure from a stated core
value ("buildless, zero-dep, plain ES modules" — `CLAUDE.md`), so it should be a
deliberate choice, not a drift.

- **Capacitor** (keeps our existing HTML/CSS/JS almost verbatim, wraps it in a
  native WebView, exposes native APIs via plugins) is the least-disruptive way.
  Relevant plugins/APIs:
  - **Android:** BLE central *and* peripheral (both supported since API 21), or
    the **Nearby Connections API** (handles BT + BLE + Wi-Fi Direct and picks
    the best radio automatically — the closest thing to "just make these two
    phones talk").
  - **iOS:** **Core Bluetooth** (central + peripheral) or
    **MultipeerConnectivity** (Apple's BT + peer-to-peer-Wi-Fi framework —
    genuinely "no internet, two nearby devices").
- The transport still terminates in the same place: a native bridge feeds
  received frames into `log.ingestMany` and forwards `log.subscribe` ops out.
  The **reducer/store/UI are untouched** — again, it's a new `*Client`, plus a
  native plugin behind it.
- Costs to weigh: a build toolchain and app-store presence (vs. buildless PWA),
  per-OS Bluetooth permission/background limits, MAUI-style pairing UX, and
  maintaining a native layer. Bluetooth Classic/BLE throughput is also low —
  fine for tiny ops, but chunking matters for photos/OCR blobs.

Recommendation: **don't go native for Bluetooth unless Path A/B prove
insufficient in real use.** The web paths cover the stated scenario (two nearby
phones, no coverage) via Wi-Fi/hotspot or QR, without abandoning the PWA model.

---

## 5. Recommendation & suggested increments

1. **Refactor the transport seam first (small, pure win).** Extract the
   `have`/`want`/`op`/`ops` protocol logic out of `SyncClient` into a
   transport-neutral "peer session" that takes a generic `send(frame)` +
   `onFrame(cb)` and drives the delta exchange against `log`. `SyncClient`
   becomes "peer session over a WebSocket." This is worth doing regardless of
   which offline path we pick, and it's testable under `node --test` with a
   fake in-memory transport (no browser needed).
2. **Ship Path B (QR/file sneakernet) as the first offline sync.** Highest
   portability (iPhone included), no radio, and it builds the QR-scan +
   export/import plumbing.
3. **Add Path A (WebRTC over local Wi-Fi/hotspot, QR signaling) if a _live_
   nearby session is wanted.** Reuses the QR scanner from step 2 and the peer
   session from step 1.
4. **Only consider a native Capacitor shell for true Bluetooth** if steps 2–3
   don't meet the need — and treat it as an explicit product decision to add a
   build step, not an incremental patch.

### One-line summary

> **Bluetooth from the browser: no** (Web Bluetooth is central-only and absent
> on iOS — two phone browsers can't be peers). **The goal — two nearby phones
> converging with no hub: yes**, cleanly, because our op-log already merges
> transport-independently. Do it with WebRTC-over-local-Wi-Fi and/or QR/file
> transfer; reserve real Bluetooth for a deliberate native build.

---

*Grounding in the current code:* transport swap point `client/js/app.js:333`;
protocol + `want` logic `client/js/sync/client.js`; op-log primitives
(`have`/`get`/`ingestMany`/`subscribe`) `client/js/store/oplog.js`; merge
guarantee `docs/architecture.md`; QR encoder already shipped
`client/js/vendor/qrcode.js`; iOS share-sheet precedent `downloadReportCsv` in
`client/js/ui/board.js`.
