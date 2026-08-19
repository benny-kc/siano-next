import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBudgets, buildBudgets } from "../client/js/core/budgets.js";

const members = {
  a: { id: "a", name: "Ann", budgetId: null },
  b: { id: "b", name: "Bob", budgetId: "a" }, // Bob pools with Ann
  c: { id: "c", name: "Cy", budgetId: null }, // solo
  d: { id: "d", name: "Di", budgetId: "c" }, // Di pools with Cy
  e: { id: "e", name: "Ed", budgetId: "d" }, // Ed -> Di -> Cy (chain)
};
const order = ["a", "b", "c", "d", "e"];

test("resolveBudgets unions directional pointers into connected components", () => {
  const of = resolveBudgets(order, members);
  // canonical id is the earliest member of each group
  assert.equal(of.a, "a");
  assert.equal(of.b, "a");
  assert.equal(of.c, "c");
  assert.equal(of.d, "c");
  assert.equal(of.e, "c"); // chain e->d->c collapses to c
});

test("buildBudgets groups members and sums their balances", () => {
  const of = resolveBudgets(order, members);
  const personBalances = { a: 1000, b: -400, c: 200, d: -500, e: -300 };
  const budgets = buildBudgets(order, members, personBalances, of);
  assert.equal(budgets.length, 2);
  const ann = budgets.find((x) => x.id === "a");
  assert.equal(ann.name, "Ann & Bob");
  assert.equal(ann.balanceCents, 600);
  const cy = budgets.find((x) => x.id === "c");
  assert.equal(cy.name, "Cy & Di & Ed");
  assert.equal(cy.balanceCents, -600);
  assert.equal(budgets[0].balanceCents + budgets[1].balanceCents, 0);
});
