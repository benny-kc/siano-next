import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeEncoder,
  makeDecoder,
  serializeFrame,
  parseFrame,
  toPayload,
  fromPayload,
  FRAME_PREFIX,
} from "../client/js/core/qrstream.js";

// A deterministic-ish payload of a given length.
function bytesOf(n, salt = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + salt * 17) & 0xff;
  return b;
}

test("fountain round-trips a payload through serialize/parse frames", () => {
  for (const len of [1, 20, 128, 129, 500, 2000, 7000]) {
    const payload = bytesOf(len, len);
    const enc = makeEncoder(payload, { blockSize: 64 });
    const dec = makeDecoder();
    let frames = 0;
    // Feed coded frames (through the wire format) until the decoder completes.
    // A generous cap guards against a pathological RNG run — LT needs ~K(1+ε).
    const cap = enc.K * 40 + 200;
    while (!dec.isComplete() && frames < cap) {
      const wire = serializeFrame(enc.next());
      assert.ok(wire.startsWith(FRAME_PREFIX + ","));
      dec.add(parseFrame(wire));
      frames++;
    }
    assert.ok(dec.isComplete(), `len=${len} did not complete within ${cap} frames`);
    assert.deepEqual([...dec.payload()], [...payload], `len=${len} payload mismatch`);
  }
});

test("decoder is idempotent and order-free (dup / shuffled frames)", () => {
  const payload = bytesOf(1500, 9);
  const enc = makeEncoder(payload, { blockSize: 100 });
  // Collect a surplus of frames, then feed them shuffled and duplicated.
  const wires = [];
  for (let i = 0; i < enc.K * 6 + 50; i++) wires.push(serializeFrame(enc.next()));
  const shuffled = wires.concat(wires); // duplicates
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (i * 2654435761) % (i + 1); // deterministic shuffle
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const dec = makeDecoder();
  for (const w of shuffled) dec.add(parseFrame(w));
  assert.ok(dec.isComplete());
  assert.deepEqual([...dec.payload()], [...payload]);
});

test("progress rises to 1 and never regresses", () => {
  const payload = bytesOf(3000, 3);
  const enc = makeEncoder(payload, { blockSize: 128 });
  const dec = makeDecoder();
  let last = 0;
  for (let i = 0; i < enc.K * 40 + 200 && !dec.isComplete(); i++) {
    dec.add(parseFrame(serializeFrame(enc.next())));
    assert.ok(dec.progress >= last, "progress regressed");
    last = dec.progress;
  }
  assert.equal(dec.progress, 1);
});

test("ops payload survives the codec unchanged", () => {
  const ops = [
    { t: "add_meal", id: "meal-1", lamport: 3, device: "A", vv: { A: 3 } },
    { t: "set_amount", id: "meal-1", cents: 4899, lamport: 4, device: "A", vv: { A: 4 } },
    { t: "add_member", id: "m-1", name: "Zoë ⚡", lamport: 1, device: "A", vv: { A: 1 } },
  ];
  const enc = makeEncoder(toPayload(ops), { blockSize: 48 });
  const dec = makeDecoder();
  for (let i = 0; i < enc.K * 40 + 200 && !dec.isComplete(); i++) dec.add(parseFrame(serializeFrame(enc.next())));
  assert.ok(dec.isComplete());
  assert.deepEqual(fromPayload(dec.payload()), ops);
});

test("parseFrame rejects junk", () => {
  assert.equal(parseFrame("not a frame"), null);
  assert.equal(parseFrame("SNQR1,a,b"), null);
  assert.equal(parseFrame(""), null);
  assert.equal(parseFrame(null), null);
});
