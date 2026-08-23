# Offline peer-to-peer sync via QR (and why not Bluetooth) — planning notes

**Status:** research / planning only. Nothing here is built. The original
question:

> Two phones are physically next to each other, both with **no internet**
> (no Wi-Fi, no cellular). Can they sync bills directly between the two devices,
> with no hub?

The first instinct was **Bluetooth** — but the browser/PWA platform can't do
phone-to-phone Bluetooth (see §5). The path that actually works everywhere,
including offline and on iPhone, is **transferring a bill as a QR code**: one
phone shows it, the other scans it with an in-app camera and imports it straight
into the log. This doc focuses on that flow, and keeps the Bluetooth /
WebRTC analysis as supporting context.

Short version: **yes, a single bill fits in a QR code, and the import can be
fully automatic** — the "you must tap the link" friction people expect only
applies to the phone's *system* camera, not to a camera running *inside* our
PWA, where our own code reads the bytes and imports them.

---

## 1. Why this fits siano-next so well

The hard part of peer-to-peer sync — conflict resolution — is **already solved
and already local**. Nothing about our merge model assumes a hub:

- The synced unit is an **op**, and every device folds the same append-only log
  with the same pure reducer (`client/js/core/reducer.js`). Convergence is
  guaranteed for anyone who has seen the same *set* of ops, **independent of
  arrival order or transport** (`docs/architecture.md`). A QR code, a WebSocket,
  or Bluetooth is just a different pipe.
- The hub is already "a dumb relay" with **no business logic** — it only
  durably appends and fans out. A QR handoff plays the same role for one bill:
  "here are some ops; merge the ones you don't have."
- Sync is **additive and idempotent**: ops are only ever appended and deduped
  by `opId`. A partial or re-scanned QR loses nothing and duplicates nothing —
  exactly what you want for a manual, one-shot transfer.

### The protocol is already transport-agnostic

The op-log exposes exactly the primitives a QR transfer needs, with no
WebSocket assumption baked in (`client/js/store/oplog.js`):

- `log.have()` → the op-ids I hold (to compute "what does the other phone lack")
- `log.get(id)` / `log.allOps()` → fetch the ops to encode
- `log.ingestMany(ops)` → merge received ops (returns only the new ones), which
  triggers re-fold → `buildSnapshot` → render, same path as a synced op

`SyncClient` is instantiated in exactly one place (`client/js/app.js:333`). A QR
transfer isn't even a live client — it's just "serialize some ops → picture →
camera → `ingestMany`." **No change to the reducer, store, or UI.**

---

## 2. Can a single bill fit in a QR code?

A "bill" isn't one blob — it's a small cluster of ops (`client/js/core/ops.js`).
Creating one meal with a payer and 4 participants is roughly:

```
add_meal + set_amount + set_payer + 4× add_participant   (+ optional set_share)
≈ 7–10 ops
```

Each op is small JSON, but it carries causal metadata `{ lamport, device, vv }`
(`ops.js:49`, `makeOp`). The heavy part is **`vv`** (the version vector), which
repeats a 36-char device UUID **for every device that has ever touched the
trip**. So a single op is ~200 bytes with 2 devices, and grows as the trip gains
devices.

**Rough sizes (4-person bill):**

| Devices in `vv` | Raw JSON | Deflate-compressed |
|---|---|---|
| 2 | ~1.3 KB | ~0.5–0.6 KB |
| 4 | ~2.0 KB | ~0.8 KB |

**QR byte-mode capacity** (for comparison): version 25 (~117×117 modules) holds
~1.3 KB; version 40 (max, 177×177) ~2.3 KB (M error-correction).

So the verdict:

- **One bill fits.** Raw, a 2-device bill lands around QR version 25 — a *dense*
  code that scans phone-to-phone but is a bit fragile.
- **Compress it.** The `vv` repeats identical UUIDs, so deflate crushes it
  ~50–60% → ~500–800 bytes → a comfortable, robust QR (version ~12–16).
- **Chunk if needed.** For the fat cases (many devices, or when member ops must
  ride along — see below), split the payload across 2–3 sequential QR frames the
  camera reads in a row. Dedup-by-`opId` makes order and overlap harmless.

⚠️ **The one real subtlety — dangling references.** A bill references members by
id (`set_payer`, `add_participant`). If both phones already share the trip's
members, the meal ops alone resolve. If the receiver *doesn't* have those
members yet, the relevant `add_member` ops must travel in the same payload, or
the imported bill points at ids that don't exist. `snapshot.js` already defends
against dangling ids so it won't crash — but the bill would render with unknown
travellers until the member ops arrive. The packager (§4) must decide "which ops
make up this bill" and include the member ops the receiver lacks.

---

## 3. The security worry is misplaced — two different "cameras"

The instinct that "security requirements will block automatic import" is **true
for one path and false for the other**, and we get to choose the path.

**Path A — the phone's OS / system camera app.** Scanning a QR here shows a URL
banner the user must tap; raw JSON just shows as inert text. This is the manual,
click-required flow. **We do not use this.**

**Path B — a camera *inside the PWA*** (`getUserMedia` + a JS QR decoder). Here
**our own code** owns the video stream and decodes the frames. The instant the
decoder reads a complete payload, our code calls `log.ingestMany(ops)` directly.
**No URL, no OS handoff, no "tap to open," no user click** — the OS never
interprets the data at all. The bill just appears on the board.

So automatic import is fully possible. The gates are mild and one-time:

- **A one-time camera-permission prompt** the first time we call `getUserMedia`
  (browser-level, remembered afterward).
- **Secure-context requirement** (HTTPS / installed PWA) for camera access —
  which siano-next already satisfies behind the Cloudflare tunnel, and an
  installed PWA keeps that secure context offline.

Neither is the "the browser forces the user to confirm every import" barrier the
question imagined. That barrier is a property of Path A only.

---

## 4. The exact end-to-end flow

**Phone A (sender):**
1. Long-press / card menu on a bill → **"Share this bill."**
2. App runs a **packager**: collect that meal's ops, plus any `add_member` ops
   the meal references (optionally diffed against what the receiver claims to
   have — but for a one-shot QR we can't ask, so include the members the meal
   touches by default). Compress (deflate) → base64/binary.
3. Render a QR with the encoder **we already ship**
   (`client/js/vendor/qrcode.js`, `encodeText`). If the payload exceeds a
   single comfortable QR, cycle through 2–3 frames (a tiny `{ i, n, chunk }`
   header per frame).

**Phone B (receiver):**
4. Tap **"Scan a bill"** → app opens the in-PWA camera (permission prompt the
   first time only).
5. App decodes frames continuously; once it has all chunks it reassembles,
   inflates, and parses the ops array.
6. **Optional preview** ("Import *Dinner at Luigi's* — €48, 4 people — from
   Phone A?") — a UX nicety, *not* a security requirement. Then call
   `log.ingestMany(ops)`.
7. Re-fold → `buildSnapshot` → render. **The bill is now on Phone B's board.**

Safety properties that fall out of the existing model:
- **Idempotent:** re-scanning the same QR is a no-op (`ingest` dedups by
  `opId`), so the camera can stay live without creating duplicates.
- **Order-free:** chunks or multiple bills can arrive in any order and still
  converge (the reducer is order-independent).
- **Non-destructive:** import only ever *adds* ops; it can't overwrite or delete
  the receiver's existing data. A concurrent money edit surfaces as a conflict
  (existing behaviour), never a silent overwrite.

---

## 5. The one honest catch: we need a QR *decoder*

We ship a QR **encoder** but not a **decoder** — decoding is real image
processing (locate finder patterns, correct perspective, read modules). Options:

| Option | Cross-platform? | Cost |
|---|---|---|
| **`BarcodeDetector`** (native browser API) | ❌ **not on iOS Safari/WebKit** | Zero-dependency, but Android/Chromium-only — breaks the app's iOS-parity rule (`CLAUDE.md`) |
| **Vendored JS decoder** (jsQR, zxing-wasm) | ✅ everywhere incl. iPhone | A new ~30–90 KB file under `client/js/vendor/`, alongside the QR encoder |

Because siano-next explicitly targets iPhone parity, the realistic choice is a
**vendored JS decoder** (mirroring how `qrcode.js` was vendored for encoding),
possibly *preferring* `BarcodeDetector` when present and falling back to the
vendored decoder on iOS. This is the main real cost of the whole feature, and
it's modest — but it *is* a new dependency, so it's a deliberate call against the
zero-dep value (`CLAUDE.md`).

---

## 6. Why not Bluetooth (the original idea)

For completeness — this is why the plan moved to QR.

### Web Bluetooth — central-only, and no iOS

- **Browsers can only act as a GATT _central_ (client)** — they connect *to* a
  peripheral (a sensor). A browser **cannot advertise itself as a peripheral**,
  so two phone *browsers* can't discover or connect to each other. Web Bluetooth
  is browser-to-gadget, not browser-to-browser.
- **iOS/iPadOS Safari doesn't support Web Bluetooth at all** (Apple declined it;
  every iOS browser is WebKit underneath). Given our iPhone-parity requirement,
  an Android-only, browser-to-gadget-only API is a dead end here.

**Verdict:** Web Bluetooth cannot sync two phones running siano-next in the
browser. This is the shape of the API, not something we can code around.

### Other transports considered

| Transport | Phone↔phone, no internet? | iOS? | Verdict |
|---|---|---|---|
| **QR code (this doc)** | ✅ fully offline, everywhere | ✅ | **Recommended first path** |
| **Audio (acoustic modem)** | ✅ fully offline, everywhere | ✅ | Complementary channel — hands-free + one-to-many (§8) |
| **Web Bluetooth** | ❌ central-only, can't be a peer | ❌ | Not usable |
| **WebRTC DataChannel** | ⚠️ needs a shared *local IP* link (Wi-Fi / hotspot) + out-of-band signaling | ✅ | Best path for a *live* nearby session (§7) |
| **Web NFC** | tap-only, tiny NDEF, Android Chrome only | ❌ | Bootstrap/handoff at most |
| **Local WebSocket to a phone-hosted hub** | ❌ browsers can't be servers | — | Not usable in-browser |
| **File share-sheet transfer** | ✅ fully offline, everywhere | ✅ | Same idea as QR, for bigger payloads |

---

## 7. Adjacent options (for later, not now)

- **WebRTC DataChannel over local Wi-Fi / hotspot** — a *live* two-way channel
  (supported on iOS), for keeping two phones continuously converged rather than
  one-bill-at-a-time. Needs a shared local IP link (same Wi-Fi, or one phone's
  hotspot — devices on a hotspot reach each other even with no upstream
  internet) and an out-of-band handshake (SDP/ICE), which **the QR machinery
  from this doc can carry**. It reuses the same op frames. It's Wi-Fi radio, not
  Bluetooth, but it meets "no coverage but physically together."
- **File "sneakernet"** — for a whole-trip transfer too big for a QR: export the
  op-log (or a delta) as a file, move it via the share sheet, import it. iOS
  file/share quirks are already solved once for CSV export (`downloadReportCsv`
  routes through the Web Share API on iOS — same trick applies).
- **Native Bluetooth (Capacitor shell)** — the *only* way to get true
  phone-to-phone Bluetooth (Android Nearby Connections / iOS
  MultipeerConnectivity). It abandons the buildless-PWA model (`CLAUDE.md`), so
  it should be a deliberate product decision, reserved for if QR/WebRTC prove
  insufficient. The transport still terminates in `log.ingestMany` — reducer,
  store and UI untouched.

---

## 8. Audio (acoustic modem) channel — beeps over the air

An entirely different offline transport: a **software acoustic modem** — one
phone encodes bits into audible tones and plays them; the other listens through
its mic and decodes. Exactly how dial-up modems worked. The browser has
everything for it — `getUserMedia({audio})` for capture, Web Audio
(`AudioContext` + oscillators / a generated buffer) for playback, and an
`AnalyserNode` / `AudioWorklet` FFT for the decode — and it **works on iOS
Safari** (same one-time permission model as the camera; the `AudioContext` just
has to be started from a user tap). So it clears the platform bar Bluetooth
failed.

### Modulation: FSK, and the two-band full-duplex idea

- **FSK** (frequency-shift keying): a symbol is a tone at a chosen frequency,
  held for a fixed slot; the receiver FFTs each slot and reads which frequency
  won → bits. **MFSK** uses N tones for several bits per symbol (e.g. 16 tones =
  4 bits/symbol) for more throughput per beep.
- **Full-duplex via two bands (FDD)** is the right way to do bidirectional:
  Phone A transmits in a **low band** (~1.5–2.5 kHz) and listens on the high
  band; Phone B transmits in a **high band** (~3.5–4.5 kHz) and listens on the
  low band. Each side band-pass-filters to the other's range, so both can beep
  at once without colliding. Needs a role assignment (who takes which band —
  e.g. the "share" initiator takes the low band, or lowest device-id wins).
- **Echo caveat:** each phone hears its *own* speaker loudly in its own mic. Band
  separation handles most of it (ignore energy in your own TX band); a little
  acoustic-echo-cancellation, or simply gating the decoder while your own tone
  plays, covers the rest. Because of this, **start half-duplex** (A sends, B
  sends a short ACK burst, turn-taking) and treat two-band full-duplex as a v2
  throughput/latency optimization — one bill is small.

### Band choice & throughput reality

- Stay in the **audible** range phone speakers/mics reproduce well (~**1–6 kHz**).
  Near-ultrasonic (18–20 kHz, "inaudible") is tempting but phone transducers are
  weak there and it's flaky; audible is uglier but far more robust.
- **Realistic robust throughput is ~10–100 bytes/sec.** A ~600-byte compressed
  bill (the deflate figure from §2) is therefore **~6–15 seconds** of beeping —
  fine for one bill, slow for a whole trip.

### Reliability — and the op-log makes it easy

The acoustic channel is noisy and bursty, so: a **preamble/sync tone** (start
detection + gain/timing lock), **forward error correction** (Reed–Solomon is the
standard here), and a **CRC per packet**. Then the existing model does the rest:
because `ingestMany` is **idempotent and order-free**, no careful handshake is
needed — chop the payload into small CRC'd packets and **loop the whole set on a
carousel**; the receiver collects until it has a complete valid set, then
imports. Duplicate or out-of-order packets are harmless; the reverse band (or the
half-duplex ACK) just says "got them all, stop."

### Plugs in the same way

Same seam as QR: `decode → bytes → inflate → ops → log.ingestMany(ops)` → re-fold
→ render. Reducer, store, and UI untouched.

### Don't hand-roll the DSP — vendor it

Bare FSK is writable, but timing recovery + FEC is the hard 80%. The realistic
path is to vendor a proven library — **ggwave** (MIT, WASM/JS build, FSK +
Reed–Solomon, audible *and* ultrasonic profiles, ~100–200 KB) or **Quiet.js**
(liquid-dsp/libcorrect → WASM). Another dependency, same deliberate call against
the zero-dep value (`CLAUDE.md`) that the QR decoder already forces.

### The honest catch — where you'd actually use this

siano-next's core scenario is **splitting a bill in a restaurant** — a loud,
reverberant room, which is exactly where data-over-sound struggles most (SNR is
the whole ballgame). So audio is a *complementary* channel, not the primary:

| | QR | Audio modem |
|---|---|---|
| Speed (one bill) | Instant | ~6–15 s of beeping |
| Noisy restaurant | Unaffected (it's light) | Degrades badly |
| Aiming / line-of-sight | Camera pointed at screen | **None — hands-free**, works in a pocket |
| One-to-many | No (one scan at a time) | **Yes — a table of phones can all listen at once** |
| Cracked/dirty screen or camera | Fails | Works |
| Annoyance | Silent | Audible beeping |

**Audio's genuine edge is no aiming and one-to-many broadcast** (one phone beeps
the bill; every phone at the table picks it up simultaneously — QR can't do
that). Its weaknesses are speed and the noisy-room problem. For the core use case
QR is the stronger primary; audio is a compelling optional second channel.

---

## 9. Recommendation & suggested increments

1. **Refactor the transport seam first (small, pure win).** Extract the "which
   ops make up this bill / delta" packaging and the `ingestMany` merge into a
   transport-neutral helper, independent of `SyncClient`. Testable under
   `node --test` with no browser.
2. **Ship QR bill transfer (this doc) as the first offline sync.** Highest
   portability (iPhone included), no radio, no pairing. Pieces:
   - a **packager** (bill → ops + referenced member ops → compress),
   - reuse the shipped **encoder** (`qrcode.js`) with multi-frame chunking,
   - a **vendored decoder** + in-PWA camera (`getUserMedia`) — the one new
     dependency (§5),
   - an optional **import-preview** step (UX, not security).
3. **Add the audio (acoustic modem) channel (§8) as an optional second path**
   if hands-free or one-to-many broadcast is wanted — vendor ggwave/Quiet.js,
   feed decoded bytes into the same packager/`ingestMany` seam, start
   half-duplex. Complementary to QR, not a replacement (noisy-room caveat).
4. **Add WebRTC-over-local-Wi-Fi later** if a *live* nearby session is wanted —
   it reuses the QR machinery for signaling and the same op frames.
5. **Only consider a native Capacitor shell for true Bluetooth** if the web
   paths don't meet the need — an explicit decision to add a build step, not an
   incremental patch.

### One-line summary

> **A single bill fits in a QR code** (compress, or chunk for the fat cases),
> and **import can be fully automatic** — the "tap the link" friction only
> exists on the OS-camera path, not the in-PWA-camera path where our own code
> reads the bytes and calls `ingestMany`. The real work is a **vendored QR
> decoder** (for iOS parity) and a small **bill packager**; everything else —
> merge, conflict handling, render — the op-log already does.

---

*Grounding in the current code:* transport swap point `client/js/app.js:333`;
op shapes + causal metadata `client/js/core/ops.js` (`makeOp`, `vv`); op-log
primitives (`have`/`get`/`allOps`/`ingestMany`) `client/js/store/oplog.js`;
merge guarantee + order-independence `docs/architecture.md`; QR **encoder**
already shipped `client/js/vendor/qrcode.js`; dangling-id defence
`client/js/core/snapshot.js`; iOS share-sheet precedent `downloadReportCsv` in
`client/js/ui/board.js`.
