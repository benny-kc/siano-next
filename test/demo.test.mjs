// Demo-trip seeder (client/js/demo.js).
//
// Seeds a believable starter trip for a first-run user who skips the welcome
// form. These tests fold the emitted ops through the real reducer/snapshot and
// assert the invariants the product asked for: five travellers, seven bills,
// even splits, varied payers, mostly-everyone guest lists, one open card, and
// locale-appropriate names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OpLog } from "../client/js/store/oplog.js";
import { seedDemoTrip } from "../client/js/demo.js";

// A tiny deterministic RNG so a run is reproducible (mulberry32).
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable ids so nothing depends on crypto.randomUUID being present.
function counterUid() {
  let n = 0;
  return (p) => `${p}${++n}`;
}

function seed(opts = {}) {
  const log = new OpLog("demo-trip", { device: "D" });
  const openId = seedDemoTrip(log, { rng: rngFrom(42), uid: counterUid(), ...opts });
  return { log, snap: log.snapshot(), openId };
}

test("seeds five travellers and seven bills", () => {
  const { snap } = seed();
  assert.equal(snap.members.length, 5);
  assert.equal(snap.billCount, 7);
  assert.ok(snap.name && snap.name.length > 0, "demo trip is named");
});

test("every bill is complete: amount 20–65, a payer who is a participant, even split", () => {
  const { snap } = seed();
  for (const bill of snap.report.bills) {
    assert.equal(bill.complete, true, `${bill.name} should be complete`);
    assert.ok(bill.amountCents >= 2000 && bill.amountCents <= 6595, `${bill.name} amount in range`);
    assert.equal(bill.diffCents, 0, `${bill.name} splits evenly (no remainder gap)`);
    // Payer must be one of the participants (shares only lists participants).
    assert.ok(bill.payerId && bill.payerId in bill.shares, `${bill.name} payer is a participant`);
  }
});

test("most bills include everyone; a few are a subset (3+)", () => {
  const { snap } = seed();
  const full = snap.bills.filter((b) => b.participantCount === 5).length;
  const subsets = snap.bills.filter((b) => b.participantCount < 5);
  assert.ok(full >= 4, `most bills include all five (got ${full})`);
  for (const b of subsets) assert.ok(b.participantCount >= 3, "subset bills still have 3+ people");
});

test("exactly one bill is left open on the board, and it's the returned id", () => {
  const { snap, openId } = seed();
  assert.equal(snap.meals.length, 1, "one open card");
  assert.equal(snap.meals[0].id, openId);
});

test("payers vary across bills (not all the same person)", () => {
  const { snap } = seed();
  const payers = new Set(snap.report.bills.map((b) => b.payerId));
  assert.ok(payers.size >= 3, `several different payers (got ${payers.size})`);
});

test("names follow the locale (Polish pool for pl), and are distinct", () => {
  const PL = ["Kasia", "Tomek", "Ania", "Michał", "Ola", "Piotr", "Zosia", "Marek", "Ewa", "Bartek"];
  const { snap } = seed({ locale: "pl" });
  const names = snap.members.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, "distinct names");
  for (const nm of names) assert.ok(PL.includes(nm), `${nm} is from the Polish pool`);
});

test("an unknown locale falls back to English names without throwing", () => {
  const EN = ["Alex", "Sam", "Jordan", "Taylor", "Casey", "Riley", "Morgan", "Jamie", "Chris", "Robin"];
  const { snap } = seed({ locale: "xx" });
  for (const m of snap.members) assert.ok(EN.includes(m.name), `${m.name} is from the English pool`);
});

test("a base-language locale tag (de-AT) resolves to its pool", () => {
  const DE = ["Lukas", "Anna", "Max", "Sophie", "Paul", "Marie", "Jonas", "Laura", "Felix", "Lena"];
  const { snap } = seed({ locale: "de-AT" });
  for (const m of snap.members) assert.ok(DE.includes(m.name), `${m.name} is from the German pool`);
});
