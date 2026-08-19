import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../client/js/core/lamport.js";
import * as ops from "../client/js/core/ops.js";
import { fold } from "../client/js/core/reducer.js";
import { buildSnapshot } from "../client/js/core/snapshot.js";

const dev = (id) => new Clock(id);

test("fold + snapshot: a basic trip computes balances and settlements", () => {
  const A = dev("A");
  const log = [
    ops.setTripName(A, "Rome"),
    ops.addMember(A, "m1", { name: "Ann", color: "#f00", initials: "AN" }),
    ops.addMember(A, "m2", { name: "Bob", color: "#00f", initials: "BO" }),
    ops.addMeal(A, "meal1", { name: "Dinner" }),
    ops.setAmount(A, "meal1", 3000),
    ops.setPayer(A, "meal1", "m1"),
    ops.addParticipant(A, "meal1", "m1"),
    ops.addParticipant(A, "meal1", "m2"),
  ];
  const snap = buildSnapshot(fold("trip", log));
  assert.equal(snap.name, "Rome");
  assert.equal(snap.memberCount, 2);
  assert.equal(snap.totalCents, 3000);
  const ann = snap.members.find((m) => m.id === "m1");
  const bob = snap.members.find((m) => m.id === "m2");
  assert.equal(ann.balanceCents, 1500);
  assert.equal(bob.balanceCents, -1500);
  assert.deepEqual(snap.settlements, [{ from: "Bob", to: "Ann", amountCents: 1500 }]);
});

test("OR-Set is add-wins: a concurrent re-add beats a remove", () => {
  const A = dev("A");
  const B = dev("B");
  // shared history: m1 added, both devices observe it
  const add = ops.addMember(A, "m1", { name: "Ann" });
  B.observe(add);
  // concurrently: A removes m1, B re-adds m1 (neither has seen the other's op)
  const rem = ops.removeMember(A, "m1");
  const readd = ops.addMember(B, "m1", { name: "Ann2" });
  // deliver crosswise
  A.observe(readd);
  B.observe(rem);
  const state = fold("trip", [add, rem, readd]);
  assert.ok(state.members.m1, "m1 should survive because add wins on concurrency");
});

test("OR-Set: a remove that causally follows the add wins (element gone)", () => {
  const A = dev("A");
  const add = ops.addMember(A, "m1", { name: "Ann" });
  const rem = ops.removeMember(A, "m1"); // same device, later => causally after
  const state = fold("trip", [add, rem]);
  assert.equal(state.members.m1, undefined);
});

test("money: concurrent differing set_amount surfaces a conflict, winner deterministic", () => {
  const A = dev("A");
  const B = dev("B");
  const base = [
    ops.addMeal(A, "meal1", { name: "Dinner" }),
  ];
  B.observe(base[0]);
  // concurrent amount edits
  const aAmt = ops.setAmount(A, "meal1", 3000);
  const bAmt = ops.setAmount(B, "meal1", 5000);
  A.observe(bAmt);
  B.observe(aAmt);
  const state = fold("trip", [...base, aAmt, bAmt]);
  const meal = state.meals.meal1;
  // deterministic winner: equal lamport, device "B" > "A" => B's 5000 wins
  assert.equal(meal.amountCents, 5000);
  assert.ok(meal.conflicts && meal.conflicts.amount, "a money conflict must be surfaced");
  assert.equal(meal.conflicts.amount[0].value, 3000);
});

test("money: a later causal edit is NOT a conflict (normal sequential edit)", () => {
  const A = dev("A");
  const B = dev("B");
  const m = ops.addMeal(A, "meal1", {});
  B.observe(m);
  const first = ops.setAmount(A, "meal1", 3000);
  B.observe(first); // B sees A's edit before editing
  const second = ops.setAmount(B, "meal1", 4200);
  const state = fold("trip", [m, first, second]);
  assert.equal(state.meals.meal1.amountCents, 4200);
  assert.equal(state.meals.meal1.conflicts, null);
});

test("locked share honoured, and set_share locked:false clears it", () => {
  const A = dev("A");
  const log = [
    ops.addMember(A, "m1", { name: "Ann" }),
    ops.addMember(A, "m2", { name: "Bob" }),
    ops.addMeal(A, "meal1", {}),
    ops.setAmount(A, "meal1", 3000),
    ops.addParticipant(A, "meal1", "m1"),
    ops.addParticipant(A, "meal1", "m2"),
    ops.setShare(A, "meal1", "m1", 1800, true),
  ];
  let state = fold("trip", log);
  assert.deepEqual(state.meals.meal1.lockedShares, { m1: 1800 });
  log.push(ops.setShare(A, "meal1", "m1", 0, false)); // unlock
  state = fold("trip", log);
  assert.deepEqual(state.meals.meal1.lockedShares, {});
});

test("convergence: folding the same ops in any order yields identical state", () => {
  const A = dev("A");
  const B = dev("B");
  const shared = [
    ops.addMember(A, "m1", { name: "Ann" }),
    ops.addMember(A, "m2", { name: "Bob" }),
    ops.addMeal(A, "meal1", { name: "Dinner" }),
  ];
  for (const op of shared) B.observe(op);
  const aOps = [ops.setAmount(A, "meal1", 3000), ops.setMealName(A, "meal1", "Lunch")];
  const bOps = [ops.setMealName(B, "meal1", "Brunch"), ops.setPayer(B, "meal1", "m1")];
  for (const op of aOps) B.observe(op);
  for (const op of bOps) A.observe(op);

  const all = [...shared, ...aOps, ...bOps];
  const order1 = fold("trip", all);
  const shuffled = [all[5], all[0], all[4], all[2], all[6], all[1], all[3]];
  const order2 = fold("trip", shuffled);
  assert.deepEqual(order2, order1, "state must be independent of fold order");
});
