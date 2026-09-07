import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "../client/js/vendor/jsqr.js";
import { encodeText } from "../client/js/vendor/qrcode.js";
import {
  makeEncoder,
  makeDecoder,
  serializeFrame,
  parseFrame,
  toPayload,
  fromPayload,
} from "../client/js/core/qrstream.js";

// Render an encodeText matrix into an RGBA image (scale S px/module + quiet
// zone) — stands in for a clean camera capture so the whole receive path
// (encode → picture → jsQR → parseFrame → fountain decode) runs under node.
function renderRGBA(text, S = 6, quiet = 4) {
  const { size, modules } = encodeText(text, "M");
  const dim = (size + quiet * 2) * S;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255); // white
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const y = (r + quiet) * S + dy;
          const x = (c + quiet) * S + dx;
          const i = (y * dim + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0; // black module
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

test("jsQR decodes a frame our encoder produced", () => {
  const wire = serializeFrame(makeEncoder(toPayload([{ t: "add_meal", id: "m1", lamport: 1, device: "A", vv: { A: 1 } }])).next());
  const img = renderRGBA(wire);
  const res = jsQR(img.data, img.width, img.height);
  assert.ok(res && res.data === wire, "jsQR did not round-trip the frame text");
});

test("receive path: fountain frames → images → jsQR → decode → ops", () => {
  const ops = [];
  for (let i = 0; i < 8; i++) {
    ops.push({ t: "add_meal", id: "meal-" + i, name: "Dinner " + i, lamport: i + 1, device: "PHONE-A", vv: { "PHONE-A": i + 1 } });
    ops.push({ t: "set_amount", id: "meal-" + i, cents: 1234 * (i + 1), lamport: i + 1, device: "PHONE-A", vv: { "PHONE-A": i + 1 } });
  }
  const enc = makeEncoder(toPayload(ops));
  const dec = makeDecoder();
  let decoded = 0;
  for (let i = 0; i < enc.K * 8 + 100 && !dec.isComplete(); i++) {
    const img = renderRGBA(serializeFrame(enc.next()));
    const res = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    const frame = res && res.data ? parseFrame(res.data) : null;
    if (frame) { dec.add(frame); decoded++; }
  }
  assert.ok(dec.isComplete(), "decoder never completed from rendered frames");
  assert.ok(decoded >= enc.K, "should have decoded at least K frames");
  assert.deepEqual(fromPayload(dec.payload()), ops);
});
