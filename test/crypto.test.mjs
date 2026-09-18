// End-to-end envelope encryption (client/js/core/crypto.js).
//
// These run under `node --test` because Web Crypto (`crypto.subtle`) is available
// in Node ≥18 just as it is in a browser secure context — the same code path the
// client uses. They prove the hub-facing guarantee: an envelope reveals nothing
// but its opaque op-id, and only a holder of the trip key can open it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock, opId } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";
import { genTripKey, importTripKey, makeTripCrypto, subtleAvailable } from "../client/js/core/crypto.js";

test("subtle is available in the test runtime", () => {
  assert.ok(subtleAvailable(), "crypto.subtle should be present under node --test");
});

test("round-trips an op through encrypt/decrypt", async () => {
  const A = new Clock("A");
  const crypto = makeTripCrypto(await importTripKey(genTripKey()));
  const op = ops.addMeal(A, "meal1", { name: "Sushi 🍣", x: 1, y: 2 });
  const env = await crypto.encrypt(op);
  const back = await crypto.decrypt(env);
  assert.deepEqual(back, op, "decrypted op must equal the original");
});

test("the envelope leaks no plaintext and only exposes the op-id", async () => {
  // A distinctive multi-char device id — a single letter would coincidentally
  // appear in the random base64 ciphertext and make the substring check meaningless.
  const A = new Clock("device-QWERTY-ZZZ");
  const crypto = makeTripCrypto(await importTripKey(genTripKey()));
  const op = ops.setAmount(A, "meal-QWERTY", 481516); // op type + distinctive amount + id
  const env = await crypto.encrypt(op);

  // Shape the hub sees: a marker, the plaintext op-id, and opaque ciphertext.
  assert.equal(env.e, 1);
  assert.equal(typeof env.id, "string");
  assert.equal(opId(op), env.id, "envelope id must equal opId(op)");
  const blob = JSON.stringify(env);
  assert.ok(!blob.includes("set_amount"), "op type must not appear in the envelope");
  assert.ok(!blob.includes("481516"), "amount must not appear in the envelope");
  assert.ok(!blob.includes("meal-QWERTY"), "ids in the payload must not appear in the envelope");
  assert.ok(!blob.includes(op.device), "author device must not appear in the envelope");
});

test("a wrong key cannot open the envelope", async () => {
  const A = new Clock("A");
  const mine = makeTripCrypto(await importTripKey(genTripKey()));
  const theirs = makeTripCrypto(await importTripKey(genTripKey()));
  const env = await mine.encrypt(ops.setTripName(A, "Rome"));
  await assert.rejects(() => theirs.decrypt(env), "a different trip key must fail to decrypt");
});

test("each op gets a fresh data key and iv (no reuse)", async () => {
  const A = new Clock("A");
  const crypto = makeTripCrypto(await importTripKey(genTripKey()));
  const e1 = await crypto.encrypt(ops.addMeal(A, "m1", { name: "x" }));
  const e2 = await crypto.encrypt(ops.addMeal(A, "m2", { name: "x" }));
  assert.notEqual(e1.k, e2.k, "wrapped data keys must differ per op");
  assert.notEqual(e1.iv, e2.iv, "data ivs must differ per op");
});

test("decrypt passes a legacy plaintext op through unchanged", async () => {
  const crypto = makeTripCrypto(await importTripKey(genTripKey()));
  const legacy = { op: "set_open", mealId: "m", open: true, lamport: 1, device: "A", vv: { A: 1 } };
  const back = await crypto.decrypt(legacy);
  assert.deepEqual(back, legacy);
});

test("importTripKey rejects a malformed token", async () => {
  await assert.rejects(() => importTripKey("too-short"), "a non-32-byte token must be rejected");
});
