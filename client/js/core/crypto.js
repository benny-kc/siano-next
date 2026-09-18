// End-to-end (envelope) encryption for ops — a zero-knowledge hub.
//
// The hub is a dumb relay and MUST NOT be able to read user data (bill names,
// amounts, who paid). So every op is encrypted on the device BEFORE it leaves —
// over the sync socket or an offline-QR export — and only ever decrypted on a
// device that holds the trip key. The hub stores and forwards opaque ciphertext;
// it never sees the key.
//
// Transparent by design: there is no password. The trip key rides in the share
// URL's FRAGMENT (`/t/<id>#k=<token>`), which browsers never send to the server,
// and is cached locally per device (oplog.js). Sharing the link or QR shares the
// key; opening the link unlocks the trip with nothing to type.
//
// Envelope encryption (textbook): each op is sealed under a fresh random DATA key
// (DEK); that DEK is then WRAPPED (encrypted) under the trip KEY (KEK, from the
// fragment). Both travel together in the envelope. This is what "envelope
// encryption" means — the data key is enveloped by the key key.
//
//   envelope = { e:1, id, k, iv, ct }
//     e  : format marker (its presence ⇒ this is an encrypted op)
//     id : the op-id, in PLAINTEXT — the ONLY thing the hub needs to dedup/relay
//          (a random uuid for new ops; see ops.js / lamport.opId). Everything the
//          hub could learn from it is opaque, so the hub stays fully blind.
//     k  : base64url( wrapIv(12) || AES-GCM(KEK, rawDEK) )   — the wrapped DEK
//     iv : base64url( dataIv(12) )
//     ct : base64url( AES-GCM(DEK, utf8(JSON.stringify(op))) ) — the sealed op
//
// The op TYPE, amounts, names, device/author id, lamport and version vector all
// live inside `ct` — the hub sees none of them. See docs/security.md.
//
// Uses the Web Crypto API (`crypto.subtle`), available in every secure context
// (https, or localhost) and in Node's test runner — so this module is exercised
// by `node --test` like the rest of core. In an INSECURE context (a raw LAN IP
// over http) `crypto.subtle` is absent; callers check `subtleAvailable()` and
// fall back to today's plaintext behaviour rather than hard-breaking. Keep this
// module DOM-free and dependency-free (it imports only version.js + lamport.opId,
// so the asset-hash topo sort stays acyclic).

import { opId } from "./lamport.js";
import { registerVersion } from "../version.js";
registerVersion("js/core/crypto.js", 1);

const subtle = () => globalThis.crypto?.subtle;

/** True when Web Crypto is usable here (secure context). */
export function subtleAvailable() {
  return !!subtle();
}

// --- base64url <-> bytes (no padding; URL/fragment-safe) ----------------------

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = (globalThis.btoa ? btoa(bin) : Buffer.from(bytes).toString("base64"));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = globalThis.atob ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// --- trip key (KEK) -----------------------------------------------------------

/** A fresh trip key as a base64url token — this is what goes in the `#k=` fragment. */
export function genTripKey() {
  return bytesToB64url(randomBytes(32)); // 256-bit
}

/**
 * Import a base64url trip-key token as a non-extractable AES-GCM key used only to
 * WRAP/UNWRAP per-op data keys. Throws if the token isn't a 32-byte key.
 */
export async function importTripKey(token) {
  const raw = b64urlToBytes(token);
  if (raw.length !== 32) throw new Error("siano: bad trip key length");
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// --- the per-trip crypto (encrypt/decrypt ops) --------------------------------

/**
 * Build the encrypt/decrypt pair for a trip, bound to its KEK.
 * @param {CryptoKey} kek  from importTripKey()
 * @returns {{ encrypt(op): Promise<object>, decrypt(env): Promise<object> }}
 */
export function makeTripCrypto(kek) {
  const s = subtle();

  async function encrypt(op) {
    // Fresh data key per op (the "envelope"): its own AES-GCM-256 key…
    const dek = await s.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawDek = new Uint8Array(await s.exportKey("raw", dek));

    // …wrapped under the trip key…
    const wrapIv = randomBytes(12);
    const wrapped = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: wrapIv }, kek, rawDek));
    const k = new Uint8Array(wrapIv.length + wrapped.length);
    k.set(wrapIv, 0);
    k.set(wrapped, wrapIv.length);

    // …and the op itself sealed under the data key.
    const dataIv = randomBytes(12);
    const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: dataIv }, dek, enc.encode(JSON.stringify(op))));

    // `id` stays plaintext so the hub can dedup/relay. It equals opId(op) so a
    // legacy plaintext op re-encrypts to its existing id (no duplicate on the
    // hub) and a new op uses its random op.id.
    return {
      e: 1,
      id: opId(op),
      k: bytesToB64url(k),
      iv: bytesToB64url(dataIv),
      ct: bytesToB64url(ct),
    };
  }

  async function decrypt(env) {
    // Passthrough for a plaintext (legacy / insecure-context) op — nothing to do.
    if (!env || !env.e) return env;
    const kBytes = b64urlToBytes(env.k);
    const wrapIv = kBytes.slice(0, 12);
    const wrapped = kBytes.slice(12);
    const rawDek = new Uint8Array(await s.decrypt({ name: "AES-GCM", iv: wrapIv }, kek, wrapped));
    const dek = await s.importKey("raw", rawDek, { name: "AES-GCM" }, false, ["decrypt"]);
    const dataIv = b64urlToBytes(env.iv);
    const ptBytes = new Uint8Array(await s.decrypt({ name: "AES-GCM", iv: dataIv }, dek, b64urlToBytes(env.ct)));
    const op = JSON.parse(dec.decode(ptBytes));
    if (op && op.id == null) op.id = env.id; // legacy ops carry no id inside the ciphertext
    return op;
  }

  return { encrypt, decrypt };
}
