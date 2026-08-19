// Pure, dependency-free money math for splitting shared travel costs.
//
// Ported verbatim in behaviour from the reference Elixir app's
// `Siano.Trips.Splitter`. This is the heart of the reducer: given a meal's
// total and its participants (with any locked/custom shares), it computes who
// owes what. All amounts are integer cents.
//
// The one rule you must not break: a LOCKED (custom) share is honoured EXACTLY
// as declared — never clamped, never nudged. Only unlocked participants absorb
// the remainder. Clamping a locked share to force the sum to balance was the
// bug behind two "a fixed share got silently edited" reports. Any genuine gap
// is surfaced as the meal's diff (see snapshot.js) for humans to reconcile.

/**
 * Split `amountCents` evenly across `participantIds`.
 *
 * The base share is `floor(amount / n)`. Leftover cents (the remainder) are
 * handed out one at a time to the first participants, so the shares sum EXACTLY
 * back to the amount — nobody loses or gains a cent to rounding.
 *
 *   evenSplit(1000, ["a","b","c"])  ->  { a: 334, b: 333, c: 333 }
 *
 * Returns a plain object `{ [participantId]: cents }`.
 */
export function evenSplit(amountCents, participantIds) {
  const out = {};
  const n = participantIds.length;
  if (n === 0) return out;
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError("evenSplit expects a non-negative integer amount");
  }
  const base = Math.trunc(amountCents / n);
  const remainder = amountCents % n;
  participantIds.forEach((id, index) => {
    out[id] = index < remainder ? base + 1 : base;
  });
  return out;
}

/**
 * Split `amountCents` across `participantIds`, honouring any `locked` shares.
 *
 * `locked` is `{ [memberId]: cents }` for participants whose share is fixed.
 * Two regimes:
 *
 *  - Some participants are unlocked: every locked amount is honoured exactly,
 *    and the unlocked participants split whatever is left (never below zero).
 *    Sums to `amountCents` when the locked shares fit; if they meet or exceed
 *    the total the unlocked participants get 0 and the overshoot becomes diff.
 *
 *  - Everyone is locked: each declared share stands exactly as entered. Nothing
 *    is redistributed — there is no automatic participant to absorb a mismatch,
 *    so the result may NOT sum to `amountCents`; the gap is the meal's diff.
 *
 *   customSplit(3000, ["a","b","c"], { a: 1800 })          -> { a:1800, b:600, c:600 }
 *   customSplit(3000, ["a","b"],     { a: 1800, b: 1000 }) -> { a:1800, b:1000 }
 *   customSplit(10000,["a","b","c"], { a: 7000, b: 7000 }) -> { a:7000, b:7000, c:0 }
 */
export function customSplit(amountCents, participantIds, locked = {}) {
  const out = {};
  if (participantIds.length === 0) return out;
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError("customSplit expects a non-negative integer amount");
  }

  const has = (id) => Object.prototype.hasOwnProperty.call(locked, id);
  const lockedIds = participantIds.filter(has);
  const unlockedIds = participantIds.filter((id) => !has(id));

  if (unlockedIds.length > 0) {
    // Honour every locked share EXACTLY. The unlocked participants then split
    // whatever is left; if the locked shares already cover (or exceed) the bill
    // there is nothing left and they split 0. Any real overshoot shows as diff.
    let spent = 0;
    for (const id of lockedIds) {
      const share = Math.max(0, locked[id] | 0);
      out[id] = share;
      spent += share;
    }
    const remaining = Math.max(0, amountCents - spent);
    Object.assign(out, evenSplit(remaining, unlockedIds));
    return out;
  }

  // Everyone has a fixed share: honour each exactly as declared. Deliberately
  // NOT forced to sum to the total — the difference is the meal's diff.
  for (const id of participantIds) out[id] = Math.max(0, locked[id] | 0);
  return out;
}

/**
 * Compute the net balance for every member from a list of expenses.
 *
 * Each expense is `{ payerId, amountCents, shares? , participantIds? }`. If
 * `shares` (a `{ memberId: cents }` map) is absent it is derived by an even
 * split of the amount across `participantIds`.
 *
 * Only every OTHER participant's share is a debt: it credits the payer (they
 * fronted it) and debits the participant (they owe it). The payer's own share
 * and the bill total never enter the ledger — this is exactly why the balances
 * sum to zero even when declared shares overshoot or undershoot the total.
 *
 * Positive balance => the group owes that member (creditor). Negative => they
 * owe. `memberIds` seeds the result so inactive members show up as 0.
 */
export function balances(expenses, memberIds = []) {
  const acc = {};
  for (const id of memberIds) acc[id] = 0;

  for (const expense of expenses) {
    const shares = expense.shares || evenSplit(expense.amountCents, expense.participantIds);
    const payerId = expense.payerId;
    for (const [memberId, share] of Object.entries(shares)) {
      if (memberId === String(payerId)) continue;
      acc[payerId] = (acc[payerId] || 0) + share;
      acc[memberId] = (acc[memberId] || 0) - share;
    }
  }
  return acc;
}

/**
 * Turn a `{ id: balance }` map into a minimal-ish list of "who pays whom"
 * transfers that settles everyone up. Greedy: repeatedly match the biggest
 * debtor with the biggest creditor. Not the theoretical minimum (that is
 * NP-hard) but clean and intuitive for real trip-sized groups.
 *
 * Returns `[{ from, to, amountCents }]`.
 */
export function settlements(balanceMap) {
  const bySizeDesc = (a, b) => b[1] - a[1];
  let debtors = Object.entries(balanceMap)
    .filter(([, amt]) => amt < 0)
    .map(([id, amt]) => [id, -amt])
    .sort(bySizeDesc);
  let creditors = Object.entries(balanceMap)
    .filter(([, amt]) => amt > 0)
    .map(([id, amt]) => [id, amt])
    .sort(bySizeDesc);

  const out = [];
  while (debtors.length > 0 && creditors.length > 0) {
    const [debtor, owed] = debtors[0];
    const [creditor, due] = creditors[0];
    const transfer = Math.min(owed, due);
    out.push({ from: debtor, to: creditor, amountCents: transfer });

    debtors = debtors.slice(1);
    creditors = creditors.slice(1);
    if (owed - transfer > 0) debtors = [[debtor, owed - transfer], ...debtors].sort(bySizeDesc);
    if (due - transfer > 0) creditors = [[creditor, due - transfer], ...creditors].sort(bySizeDesc);
  }
  return out;
}
