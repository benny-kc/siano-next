// Fountain-coded QR stream (LT codes) — the pure, transport-neutral codec behind
// offline device-to-device sync (docs/qr-sync.md §4a/§4b). The sender turns the
// trip's ops into an endless stream of coded frames; a receiver collects *any*
// "enough" of them and reconstructs the payload — rateless, so lost/duplicate/
// out-of-order frames are harmless (which is exactly what a shaky camera link
// and the order-free op-log both want).
//
// This module is DOM-free and deterministic so it is unit-testable under
// `node --test` (the encoder and decoder share the same seeded RNG + degree
// distribution, so the decoder reproduces each frame's block selection from the
// tiny per-frame seed — nothing but the seed needs to travel).
//
//   payload (bytes) ──makeEncoder──▶ frames ──serializeFrame──▶ QR text
//   QR text ──parseFrame──▶ frames ──makeDecoder().add──▶ payload (bytes)
//
// Frame wire format (all-ASCII so it packs tight in QR byte mode):
//   SNQR1,<id>,<K>,<L>,<bs>,<seed>,<base64(coded block)>
// with id/K/L/bs/seed in base36. `id` (a hash of the payload) tags a generation
// so a decoder resets cleanly when the sender starts a new payload.

import { registerVersion } from "../version.js";
registerVersion("js/core/qrstream.js", 1);

export const FRAME_PREFIX = "SNQR1";
export const DEFAULT_BLOCK_SIZE = 128;

// ── payload <-> ops ───────────────────────────────────────────────────────────
export function toPayload(ops) {
  return new TextEncoder().encode(JSON.stringify(ops));
}
export function fromPayload(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ── tiny helpers ──────────────────────────────────────────────────────────────
// mulberry32 — a small, fast, seedable PRNG (deterministic across environments).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit — identifies a payload/generation and salts the per-frame RNG.
function hash32(bytes) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Robust-soliton degree distribution → a sampler(rng) → degree in [1, K].
// The spike near K/R plus the 1/(d(d-1)) tail is what lets the peeling decoder
// finish from ~K(1+ε) symbols with high probability.
function solitonSampler(K) {
  if (K <= 1) return () => 1;
  const c = 0.1;
  const delta = 0.5;
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const mu = new Array(K + 1).fill(0);
  mu[1] = 1 / K;
  for (let d = 2; d <= K; d++) mu[d] = 1 / (d * (d - 1)); // ideal soliton ρ
  const kr = Math.max(1, Math.round(K / R));
  for (let d = 1; d <= K; d++) {
    if (d < kr) mu[d] += R / (d * K);
    else if (d === kr) mu[d] += (R * Math.log(R / delta)) / K;
  }
  let beta = 0;
  for (let d = 1; d <= K; d++) beta += mu[d];
  const cdf = new Array(K + 1).fill(0);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += mu[d] / beta;
    cdf[d] = acc;
  }
  return (rng) => {
    const x = rng();
    for (let d = 1; d <= K; d++) if (x <= cdf[d]) return d;
    return K;
  };
}

// The set of source-block indices a frame combines — recomputed identically by
// encoder and decoder from just (seed, id, K).
function symbolIndices(seed, id, K, sampleDeg) {
  const rng = mulberry32((seed ^ id) >>> 0);
  const d = Math.min(K, Math.max(1, sampleDeg(rng)));
  const set = new Set();
  while (set.size < d) set.add(Math.floor(rng() * K) % K);
  return set;
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

// ── base64 (portable over Uint8Array; no btoa/Buffer dependency) ──────────────
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
function b64encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >>> 6) & 63] : "=") +
      (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}
function b64decode(str) {
  const clean = str.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64INV[clean.charCodeAt(i)];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >>> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ── encoder ───────────────────────────────────────────────────────────────────
// Returns { K, L, blockSize, id, next() } where next() yields one coded frame.
export function makeEncoder(payload, { blockSize = DEFAULT_BLOCK_SIZE } = {}) {
  const L = payload.length;
  const K = Math.max(1, Math.ceil(L / blockSize));
  const blocks = [];
  for (let i = 0; i < K; i++) {
    const b = new Uint8Array(blockSize);
    b.set(payload.subarray(i * blockSize, Math.min(L, (i + 1) * blockSize)));
    blocks.push(b);
  }
  const id = hash32(payload);
  const sampleDeg = solitonSampler(K);
  let seq = 0;
  return {
    K, L, blockSize, id,
    next() {
      const seed = seq++ >>> 0;
      const indices = symbolIndices(seed, id, K, sampleDeg);
      const data = new Uint8Array(blockSize);
      for (const j of indices) xorInto(data, blocks[j]);
      return { seed, id, K, L, blockSize, indices, data };
    },
  };
}

export function serializeFrame(frame) {
  return [
    FRAME_PREFIX,
    frame.id.toString(36),
    frame.K.toString(36),
    frame.L.toString(36),
    frame.blockSize.toString(36),
    frame.seed.toString(36),
    b64encode(frame.data),
  ].join(",");
}

export function parseFrame(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",");
  if (parts.length !== 7 || parts[0] !== FRAME_PREFIX) return null;
  const id = parseInt(parts[1], 36);
  const K = parseInt(parts[2], 36);
  const L = parseInt(parts[3], 36);
  const blockSize = parseInt(parts[4], 36);
  const seed = parseInt(parts[5], 36);
  if ([id, K, L, blockSize, seed].some((n) => !Number.isFinite(n))) return null;
  return { id: id >>> 0, K, L, blockSize, seed: seed >>> 0, data: b64decode(parts[6]) };
}

// ── decoder (peeling / belief-propagation) ────────────────────────────────────
// add(frame) returns true once the whole payload is recovered. Not needed by the
// current sender-only UI, but it makes the codec round-trippable in tests and is
// the receiver's core for the next step.
export function makeDecoder() {
  return {
    id: null,
    K: 0,
    L: 0,
    blockSize: 0,
    solved: new Map(), // index -> Uint8Array(blockSize)
    pending: [], // { indices:Set, data:Uint8Array }
    _sampleDeg: null,

    get progress() {
      return this.K ? this.solved.size / this.K : 0;
    },
    isComplete() {
      return this.K > 0 && this.solved.size === this.K;
    },

    add(frame) {
      if (!frame) return this.isComplete();
      if (frame.id !== this.id) {
        // A new generation — start fresh.
        this.id = frame.id;
        this.K = frame.K;
        this.L = frame.L;
        this.blockSize = frame.blockSize;
        this.solved = new Map();
        this.pending = [];
        this._sampleDeg = solitonSampler(frame.K);
      }
      const indices = symbolIndices(frame.seed, frame.id, this.K, this._sampleDeg);
      this._absorb(indices, frame.data.slice());
      return this.isComplete();
    },

    // Peel a symbol into the solved set, rippling any symbols it unlocks.
    _absorb(indices, data) {
      const queue = [{ indices, data }];
      while (queue.length) {
        const sym = queue.pop();
        for (const i of [...sym.indices]) {
          if (this.solved.has(i)) {
            xorInto(sym.data, this.solved.get(i));
            sym.indices.delete(i);
          }
        }
        if (sym.indices.size === 0) continue; // redundant
        if (sym.indices.size > 1) {
          this.pending.push(sym);
          continue;
        }
        const idx = [...sym.indices][0];
        if (this.solved.has(idx)) continue;
        this.solved.set(idx, sym.data);
        // Newly solved: reduce every pending symbol that referenced idx.
        const still = [];
        for (const p of this.pending) {
          if (p.indices.has(idx)) {
            xorInto(p.data, sym.data);
            p.indices.delete(idx);
            if (p.indices.size === 1) queue.push(p);
            else if (p.indices.size > 1) still.push(p);
            // size 0 -> drop (redundant)
          } else {
            still.push(p);
          }
        }
        this.pending = still;
      }
    },

    payload() {
      if (!this.isComplete()) return null;
      const out = new Uint8Array(this.K * this.blockSize);
      for (let i = 0; i < this.K; i++) out.set(this.solved.get(i), i * this.blockSize);
      return out.subarray(0, this.L);
    },
  };
}
