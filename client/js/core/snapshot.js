// Build the plain view ("snapshot") the UI renders, from a folded trip state.
//
// Ported from `Siano.Trips.Snapshot.build_snapshot/1`. Pure: no storage, no
// network — given the same state it always returns the same snapshot, so it is
// trivially testable. In the reference app the server built this; here every
// device folds its op-log into `state` (see reducer.js) and then calls this to
// derive everything the board needs.

import { customSplit, balances, settlements } from "./split.js";
import { resolveBudgets, buildBudgets } from "./budgets.js";
import { registerVersion } from "../version.js";
registerVersion("js/core/snapshot.js", 1);

const lockedShares = (meal) => meal.lockedShares || {};
const photosOf = (meal) => meal.photos || [];

// Avatar initials, DERIVED from the current name so renaming a traveller (in
// Settings or on a chip) updates their avatar immediately. The `initials` stamped
// on the add_member op is only a fallback for when the name is blank — deriving
// here means the stored value never goes stale after a set_member_name. One or
// two uppercase letters; "" when the name is blank (callers fall back to the
// stored initials, then "?"). Mirrors the reference app's avatar initials.
export function initialsFor(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Only meals that represent real spending contribute to the ledger. */
function expensesFromMeals(state) {
  return state.mealOrder
    .map((id) => state.meals[id])
    .filter((m) => m && m.amountCents > 0 && m.payerId != null && m.participantIds.length > 0)
    .map((m) => ({
      payerId: m.payerId,
      amountCents: m.amountCents,
      participantIds: m.participantIds,
      shares: customSplit(m.amountCents, m.participantIds, lockedShares(m)),
    }));
}

/** A compact view of a meal for the bills-history list (every meal). */
function summarizeBill(meal, state) {
  const memberIds = [...new Set([meal.payerId, ...meal.participantIds])]
    .filter((id) => id != null && Object.prototype.hasOwnProperty.call(state.members, id));
  return {
    id: meal.id,
    name: meal.name,
    emoji: meal.emoji,
    amountCents: meal.amountCents,
    participantCount: meal.participantIds.length,
    memberIds,
    payerName: meal.payerId ? state.members[meal.payerId]?.name : null,
    open: meal.open !== false,
    photoCount: photosOf(meal).length,
    complete: meal.amountCents > 0 && meal.payerId != null && meal.participantIds.length > 0,
  };
}

/** Decorate an open meal with its per-participant shares, diff, and photos. */
function decorateMeal(meal, state) {
  // Defend against any stale reference to a removed member so one bad id can
  // never break the whole render.
  const participantIds = meal.participantIds.filter((id) =>
    Object.prototype.hasOwnProperty.call(state.members, id));
  const locks = {};
  for (const [id, cents] of Object.entries(lockedShares(meal))) {
    if (Object.prototype.hasOwnProperty.call(state.members, id)) locks[id] = cents;
  }
  const shares = customSplit(meal.amountCents, participantIds, locks);

  const participants = participantIds.map((mid) => {
    const m = state.members[mid];
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      initials: initialsFor(m.name) || m.initials,
      isPayer: meal.payerId === mid,
      shareCents: shares[mid] || 0,
      locked: Object.prototype.hasOwnProperty.call(locks, mid),
    };
  });

  const perHead = participantIds.length === 0
    ? 0
    : Math.trunc(meal.amountCents / participantIds.length);

  // The diff is only meaningful once every participant is locked — while anyone
  // is automatic, customSplit makes the shares balance exactly (diff 0).
  const allSharesFixed =
    participantIds.length > 0 && participantIds.every((id) => Object.prototype.hasOwnProperty.call(locks, id));
  const shareSum = Object.values(shares).reduce((a, b) => a + b, 0);
  const diffCents = meal.amountCents - shareSum;

  const photos = photosOf(meal).map((p) => ({
    id: p.id,
    url: `/photos/${state.id}/${p.id}.jpg`,
    fields: (p.fields || []).map((f) => ({
      text: f.text,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      memberId: f.memberId ?? null,
      color: f.memberId ? state.members[f.memberId]?.color : null,
    })),
  }));

  return {
    ...meal,
    participants,
    perHeadCents: perHead,
    hasCustomShares: Object.keys(locks).length > 0,
    allSharesFixed,
    diffCents,
    photos,
    payerName: meal.payerId ? state.members[meal.payerId]?.name : null,
    // Unresolved concurrent money edits surfaced by the reducer — the UI shows a
    // "⚠ two people set this at once" chip. Never silently discarded.
    conflicts: meal.conflicts || null,
  };
}

/**
 * Build the read-only Report: a bills × travellers share matrix plus the
 * per-traveller Paid / Consumed / Net summary — the same view the reference
 * app's `Siano.Trips.Report` produced. Covers EVERY bill (open and closed);
 * incomplete "draft" bills are listed but excluded from the totals.
 */
function buildReport(state) {
  const members = state.memberOrder.map((id) => {
    const m = state.members[id];
    return { id, name: m.name, color: m.color };
  });

  const shareTotals = {}; // memberId -> summed share across COMPLETE bills
  const paidTotals = {}; // memberId -> summed total of bills they paid (complete)
  for (const id of state.memberOrder) {
    shareTotals[id] = 0;
    paidTotals[id] = 0;
  }

  let consumedTotalCents = 0;
  let grandTotalCents = 0;
  let draftCount = 0;
  const bills = [];

  for (const mealId of state.mealOrder) {
    const meal = state.meals[mealId];
    if (!meal) continue;

    // Defend against dangling ids exactly as decorateMeal does.
    const participantIds = meal.participantIds.filter((id) =>
      Object.prototype.hasOwnProperty.call(state.members, id));
    const locks = {};
    for (const [id, cents] of Object.entries(lockedShares(meal))) {
      if (Object.prototype.hasOwnProperty.call(state.members, id)) locks[id] = cents;
    }
    const shares = customSplit(meal.amountCents, participantIds, locks);
    const shareSum = Object.values(shares).reduce((a, b) => a + b, 0);
    const complete = meal.amountCents > 0 && meal.payerId != null && participantIds.length > 0;

    if (complete) {
      grandTotalCents += meal.amountCents;
      for (const [pid, cents] of Object.entries(shares)) {
        shareTotals[pid] = (shareTotals[pid] || 0) + cents;
        consumedTotalCents += cents;
      }
      if (paidTotals[meal.payerId] != null) paidTotals[meal.payerId] += meal.amountCents;
    } else {
      draftCount += 1;
    }

    bills.push({
      id: meal.id,
      name: meal.name,
      emoji: meal.emoji,
      amountCents: meal.amountCents,
      payerId: meal.payerId ?? null,
      payerName: meal.payerId ? state.members[meal.payerId]?.name : null,
      complete,
      shares, // { [memberId]: cents } — only participants appear
      diffCents: meal.amountCents - shareSum,
    });
  }

  const memberTotals = {};
  for (const id of state.memberOrder) {
    memberTotals[id] = {
      paidCents: paidTotals[id],
      shareCents: shareTotals[id],
      netCents: paidTotals[id] - shareTotals[id], // = this member's balance
    };
  }

  return { members, bills, memberTotals, consumedTotalCents, grandTotalCents, draftCount };
}

/** Build the full snapshot the board renders from a folded trip state. */
export function buildSnapshot(state) {
  const members = state.memberOrder.map((id) => state.members[id]);

  const openMealIds = state.mealOrder.filter((id) => state.meals[id] && state.meals[id].open !== false);
  const meals = openMealIds.map((id) => decorateMeal(state.meals[id], state));
  const bills = state.mealOrder.map((id) => summarizeBill(state.meals[id], state));

  const expenses = expensesFromMeals(state);

  // Per-person balances first (a 4-way meal divides by 4)...
  const personBalances = balances(expenses, state.memberOrder);

  // ...then rolled up into budgets (couples pool money).
  const budgetOf = resolveBudgets(state.memberOrder, state.members);
  const budgets = buildBudgets(state.memberOrder, state.members, personBalances, budgetOf);
  const budgetsById = Object.fromEntries(budgets.map((b) => [b.id, b]));
  const budgetBalances = Object.fromEntries(budgets.map((b) => [b.id, b.balanceCents]));
  const budgetNames = Object.fromEntries(budgets.map((b) => [b.id, b.name]));

  const settleList = settlements(budgetBalances).map((s) => ({
    from: budgetNames[s.from],
    to: budgetNames[s.to],
    amountCents: s.amountCents,
  }));

  const totalCents = expenses.reduce((sum, e) => sum + e.amountCents, 0);

  const membersWithBalance = members.map((member) => {
    const bid = budgetOf[member.id];
    const budget = budgetsById[bid];
    const partners = budget.memberIds
      .map((id, i) => [id, budget.memberNames[i]])
      .filter(([id]) => id !== member.id);
    return {
      ...member,
      initials: initialsFor(member.name) || member.initials,
      budgetId: bid,
      balanceCents: budgetBalances[bid] || 0,
      budgetName: budgetNames[bid],
      budgetSolo: partners.length === 0,
      budgetPartnerId: partners.length > 0 ? partners[0][0] : null,
      budgetPartnerNames: partners.map(([, name]) => name),
    };
  });

  return {
    id: state.id,
    name: state.name,
    members: membersWithBalance,
    budgets,
    meals,
    bills,
    settlements: settleList,
    totalCents,
    memberCount: members.length,
    budgetCount: budgets.length,
    billCount: bills.length,
    report: buildReport(state),
  };
}
