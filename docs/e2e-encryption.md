# End-to-end encryption — design (planning)

> **Status: planning / not yet implemented.** This document is the design record.
> The code changes it describes are a **TODO** (see [Implementation TODO](#implementation-todo)).
> Read [architecture.md](architecture.md) and [security.md](security.md) first — this
> builds directly on the op-log model and the "dumb relay" hub.

## Goal

Make the hub **blind**: it must store and relay trip data it cannot read, process,
or gather. Only clients can read a trip. Concretely:

- The hub's durable log (`<dir>/<trip>.jsonl`) and its in-RAM index hold **ciphertext
  only** — no bill amounts, names, payers, meal text, device ids, or op types.
- The operator never possesses the key. There is nothing readable to disclose at rest.

## Requirements & non-goals (decided)

Decided with the product owner — these shape everything below:

- **No access control.** The trip URL *is* the capability. Anyone with the URL is a
  full participant (read + write). We are not gating, granting, or revoking devices.
- **No password / no prompt.** The key must be automatic and invisible. Flow stays:
  get a URL (link or QR) → open the local app → edit bills. Nothing to type.
- **Local storage stays plaintext.** IndexedDB on the device is *not* encrypted. The
  device already trusts itself; encryption matters only on the wire and on the hub.
- **The hub is not responsible for what clients do.** It's a blind relay, full stop.

Because there is no access control and no password, the original two-key idea
(asymmetric to negotiate/forward a key, symmetric for content) **collapses to a single
symmetric key per trip**. There is nothing to negotiate — the URL delivers the key.
The asymmetric layer would only earn its place if we later wanted device-granular
revocation; it is explicitly out of scope here.

### Non-goals (state these plainly in security.md)

- **Traffic-analysis resistance.** A relay necessarily sees op *sizes*, *timing*,
  *count*, connecting *IPs*, and the trip id. This design hides op **contents**, not
  the existence/shape of activity.
- **Authorship integrity.** Any URL-holder can forge an op authored as any device.
  Acceptable: holding the URL already grants full write access.
- **Defense against a malicious operator serving hostile client code.** See
  [The one unavoidable caveat](#the-one-unavoidable-caveat).

## Design in one screen

```
URL:  https://hub/t/<tripId>#k=<base64url(TK)>
      └── path: routing (hub sees it) ─┘ └── fragment: the key (hub NEVER sees it) ─┘

TK (256-bit random master) ──HKDF-SHA256──> encKey (AES-256-GCM)  encrypts each op body
                                          └> idKey  (HMAC-SHA256)  makes opaque wire ids

On the wire / in the hub JSONL:   { id, iv, ct }        ← no type, device, or amounts
In local IndexedDB & the reducer: { op, lamport, device, vv, ... }  ← plaintext, unchanged
```

Two facts make this clean:

1. **The URL fragment (`#…`) is never sent to a server** — not in the request line,
   not in `Referer`, not in access logs, not to the TLS terminator / tunnel. So the
   key rides in the URL (satisfying "URL is everything") while remaining invisible to
   the hub. This is the same technique client-side-encrypted web apps use.
2. **Encryption happens only at the sync boundary**, not the storage boundary. Local
   ops, the reducer, `core/*`, and IndexedDB stay plaintext and **synchronous**.
   WebCrypto is async, but that ripple is contained entirely inside `SyncClient`'s
   send/receive handlers (already async, and eventual consistency tolerates a few ms).

### The op envelope

Today a synced op is the whole object `{ op, lamport, device, vv, ...payload }`. Under
this design that object is encrypted into an **envelope** that is all the hub ever sees:

```jsonc
// Wire frame body / one JSONL line on the hub:
{
  "id": "9c1f…",   // opaque wire id (see below) — replaces `${lamport}.${device}`
  "iv": "…",       // 12-byte random nonce, base64url
  "ct": "…"        // AES-256-GCM(encKey, iv, aad=id, plaintext=JSON(inner op)), base64url
}
```

```jsonc
// Inner op — recovered client-side after decrypt, then fed to the EXISTING reducer:
{ "op": "set_amount", "mealId": "…", "cents": 1200, "lamport": 42, "device": "…", "vv": {…} }
```

The trip id is **not** in the envelope — it is carried once per connection in the
`hello` frame, exactly as today, and the hub files each trip's log under it.

### Key derivation

`TK` is a 256-bit random master key (never a password-derived value — nothing for the
hub to brute-force). From it, HKDF-SHA256 expands two independent subkeys with distinct
`info` labels so the same bytes never serve two algorithms:

- `encKey = HKDF(TK, info="siano/enc/v1")` → AES-256-GCM
- `idKey  = HKDF(TK, info="siano/id/v1")`  → HMAC-SHA256

### Content encryption

`ct = AES-256-GCM(encKey, iv, additionalData = idBytes, plaintext = utf8(JSON(op)))`

- Fresh random 12-byte `iv` per op via `crypto.getRandomValues`. Random 96-bit nonces
  are safe well past a trip's op volume (birthday bound ~2^32 messages per key; a trip
  has thousands). Never reuse an `iv` under one key.
- The wire id is bound in as **AAD**, so the hub cannot graft a ciphertext onto a
  different id (GCM authenticates it; a mismatch fails `decrypt`).

### The opaque wire id (fixes a real leak)

Today `opId(op)` is `` `${op.lamport}.${op.device}` `` (`client/js/core/lamport.js`).
That string is what the hub dedupes, routes, and stores on — so **the hub currently
sees every device id and each device's op count in plaintext.** We replace it, on the
wire only, with:

```
id = base64url( HMAC-SHA256(idKey, `${lamport}.${device}`) )
```

Properties: deterministic (same op → same id on every client), unique (the
`lamport.device` pre-image is unique per op), **opaque to the hub** (needs `idKey`,
which needs TK, which the hub never has), and recomputable by any client right after it
decrypts an incoming op. The internal `opId` stays `lamport.device` for the reducer and
the local store; the wire id is a sync-layer concern only.

## What the hub sees — before vs after

| | Today (plaintext) | After (blind) |
|---|---|---|
| Op contents (amounts, names, payer, text) | **visible** | ciphertext |
| Op type | **visible** | hidden |
| Device id / per-device op count | **visible** (in `opId`) | hidden (opaque id) |
| Lamport / version vector | **visible** | hidden |
| Trip id | visible | visible (routing) |
| Op sizes, timing, total count, IPs | visible | visible (relay metadata — non-goal) |

## The one unavoidable caveat

This makes the server blind **at rest and in transit**: the JSONL files and the hub's
RAM hold only ciphertext, and the operator never holds TK. That fully delivers "the
server cannot read / process / gather the data."

The single remaining trust is that clients run **honest JavaScript** — and the hub is
what serves that JS. A *malicious* operator could ship client code that exfiltrates TK
from the fragment. That is an active attack against one's own users (contrary to the
whole intent here) and is the unavoidable limit of any browser-delivered E2E system.
Mitigations already available in this repo: `SIANO_ASSET_HASHING` (content-pinned
assets) and the installed-PWA offline shell (pins the code a device runs). Document this
honestly in `security.md`; it is not something the crypto can solve.

## Integration points (the concrete work)

### 1. New module — `client/js/crypto.js`

A small WebCrypto wrapper (no new dependency — WebCrypto is built into browsers and
into Node via `node:crypto`, so it's unit-testable under `node --test`):

- `deriveKeys(tkRawBytes) -> { encKey, idKey }` (HKDF)
- `wireId(idKey, lamport, device) -> string`
- `sealOp(keys, op) -> { id, iv, ct }`
- `openOp(keys, envelope) -> op` (throws on auth failure / wrong key)
- `generateTripKey() -> { raw, urlKey }`  (32 random bytes + base64url form for `#k=`)

### 2. `client/js/sync/client.js`

- On send (`{t:"op"}` / `{t:"ops"}`): `sealOp` each op first.
- On receive (`{t:"op"|"ops"|"sync"}`): `openOp` each envelope, then `ingestMany`.
- `have()` / `want`: exchange **wire ids**. Keep a `Map(wireId → op)` (recompute
  `wireId` on emit and on ingest) so the client can answer the hub's `want` list.
- Handlers become `async` (await WebCrypto). Harmless — sync is order-independent.
- The `SyncClient` needs the trip's `keys`; pass them in at construction from `app.js`.

### 3. Mint / join / share — `client/js/app.js` + `client/js/store/trips.js`

- **Mint** (fresh trip): `generateTripKey()`, set `location.hash = "#k=" + urlKey`,
  cache `raw` in the device-local trip index.
- **Join** (opened a shared link): read `#k=` from `location.hash`, import it, cache it.
  Then **strip the fragment** from the address bar (`history.replaceState`) — the key is
  cached locally, so re-share is rebuilt from cache; the visible URL stays clean.
- **`trips.js` must cache TK per trip** (localStorage, alongside the id/name). Local
  plaintext storage of TK is fine (per requirements).
- **Fix the share paths** — they currently drop the fragment, which would produce
  undecryptable links:
  - `shareTripLink` builds `${location.origin}/t/${id}` → must append `#k=`.
  - `newTrip` / `openTrip` navigate to `/t/<id>` → must include `#k=` from cache.
  - the QR encoder must encode the full URL **including** `#k=`.
  - `share()` already copies `location.href` (fragment included) — OK once join keeps
    or rebuilds the fragment. (If we strip on join, `share()` must rebuild from cache.)
- **No key in the URL → no access.** A `/t/<id>` link with no fragment, on a device
  that has never cached that trip's TK, cannot decrypt. That is correct and intended:
  the fragment is the secret.

### 4. Hub — `hub/log.js` + `hub/server.js`

- `isValidOp` validates the **envelope** shape `{ id:string, iv:string, ct:string }`
  instead of `{ op, lamport, device }`.
- `opId(envelope)` becomes `envelope.id` (the hub imports the id straight off the
  envelope; it no longer computes it from op internals).
- `SIANO_DEBUG` op logging drops type/lamport (they no longer exist in plaintext) and
  logs only the opaque `id` and ciphertext size.
- Everything else in `TripLogs` (append / dedup / `all` / `missing` / `wanted` / caps)
  is unchanged — it already treats ops as opaque, keyed by id.

### 5. Untouched

`core/*` (money, split, budgets, lamport, ops, reducer, snapshot), `store/oplog.js`,
IndexedDB, and the entire UI — all stay plaintext and synchronous. This is the payoff
of encrypting at the sync boundary.

## Migration: clean cutover (decided)

**No dual-shape back-compat.** Existing plaintext trips are discarded, not migrated.
The hub rejects/ignores legacy plaintext lines; clients start fresh encrypted trips.
This keeps the hub and sync code single-path (envelope only) and avoids branching on a
version tag everywhere. (Acceptable because there is no precious production data.)

Operationally: clear the hub data dir (or let old trip files sit unread) and reset the
service-worker `CACHE` + per-file versions so devices pick up the new client. No
in-place data conversion is written.

## Testing (all under `node --test`)

- **`crypto.js`**: encrypt→decrypt round-trip; `wireId` determinism; AAD/id-tamper
  rejection; wrong-key `decrypt` failure; HKDF subkey separation.
- **`hub`**: envelope stored & fanned out verbatim; the stored JSONL contains **no**
  plaintext op fields (assert absence of `op`/`cents`/`device`); dedup by `id`;
  `missing`/`wanted` delta still correct over opaque ids.
- **`sync`** (or browser smoke test): two clients with the same TK converge; a client
  with a different/absent TK cannot read (decrypt throws, op is dropped).
- Keep the existing `core/*` tests green unchanged (proof that the seam didn't leak
  into the pure core).

## Implementation TODO

Ordered; each step is independently reviewable.

1. [ ] `client/js/crypto.js` + its tests.
2. [ ] Thread `keys` into `SyncClient`; seal on send, open on receive; wire-id `have`/`want`.
3. [ ] Mint/join/share: generate & cache TK, `#k=` handling, fix share/QR/switcher URLs.
4. [ ] Hub: envelope-shaped `isValidOp` / `opId` / debug log.
5. [ ] Clean cutover: reset hub data dir; bump SW `CACHE` + per-file versions.
6. [ ] Update `security.md` (blind-hub model, the honest caveat, non-goals) and
       `CLAUDE.md` (envelope on the wire, plaintext locally, key in the fragment).
7. [ ] Tests per above; browser smoke test of two-tab convergence.

## Appendix — why not the alternatives

- **Password-derived key** — a human password over hub-held ciphertext is offline
  brute-forceable, and the requirement is explicitly *no password*. Rejected.
- **Asymmetric per-device key wrapping** — buys device-granular revocation/approval we
  explicitly don't want, and needs an online admitter (breaks "just open the link").
  Out of scope; revisit only if access control is ever added.
- **Encrypting the local IndexedDB** — out of scope by requirement; the threat is the
  hub, not the device.
