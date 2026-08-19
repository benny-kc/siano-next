import { test } from "node:test";
import assert from "node:assert/strict";
import { evenSplit, customSplit, balances, settlements } from "../client/js/core/split.js";

test("evenSplit spreads leftover cents to the first participants, summing exactly", () => {
  assert.deepEqual(evenSplit(1000, ["a", "b", "c"]), { a: 334, b: 333, c: 333 });
  assert.deepEqual(evenSplit(0, ["a", "b"]), { a: 0, b: 0 });
  assert.deepEqual(evenSplit(500, []), {});
  const s = evenSplit(9999, ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(Object.values(s).reduce((x, y) => x + y, 0), 9999);
});

test("customSplit honours a locked share exactly; unlocked absorb the rest", () => {
  assert.deepEqual(customSplit(3000, ["a", "b", "c"], { a: 1800 }), { a: 1800, b: 600, c: 600 });
});

test("customSplit: everyone locked stands as declared (may not sum to total)", () => {
  assert.deepEqual(customSplit(3000, ["a", "b"], { a: 1800, b: 1000 }), { a: 1800, b: 1000 });
});

test("customSplit: locked shares exceeding the total are NEVER clamped; newcomer gets 0", () => {
  assert.deepEqual(customSplit(10000, ["a", "b", "c"], { a: 7000, b: 7000 }), { a: 7000, b: 7000, c: 0 });
});

test("balances: only non-payer shares move money; balances sum to zero", () => {
  // a pays 3000 for a,b,c even split -> b and c each owe 1000 to a
  const b = balances([{ payerId: "a", amountCents: 3000, participantIds: ["a", "b", "c"] }], ["a", "b", "c"]);
  assert.deepEqual(b, { a: 2000, b: -1000, c: -1000 });
  assert.equal(Object.values(b).reduce((x, y) => x + y, 0), 0);
});

test("balances stay exact even when locked shares overshoot the bill total", () => {
  // a pays 100, but b's locked share is 7000: a is owed 7000 by b regardless of the tiny total
  const b = balances(
    [{ payerId: "a", amountCents: 100, shares: { a: 0, b: 7000 } }],
    ["a", "b"],
  );
  assert.deepEqual(b, { a: 7000, b: -7000 });
  assert.equal(b.a + b.b, 0);
});

test("settlements: greedy biggest-debtor-to-biggest-creditor clears everyone", () => {
  const s = settlements({ a: 2000, b: -1500, c: -500 });
  const net = {};
  for (const { from, to, amountCents } of s) {
    net[from] = (net[from] || 0) - amountCents;
    net[to] = (net[to] || 0) + amountCents;
  }
  assert.deepEqual(net, { b: -1500, c: -500, a: 2000 });
});
