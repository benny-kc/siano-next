// Resolve members into shared-budget groups, and total each budget's balance.
//
// Ported from `Siano.Trips.Snapshot`'s budget logic. A budget is one or more
// people who pool money (e.g. a couple). Meals split per PERSON, but balances
// and settlements are per BUDGET.
//
// `budgetId` on a member is a DIRECTIONAL pointer to whoever they first pooled
// with. The real group is the connected component you get by unioning those
// pointers (union-find), which is robust to chains (A->B->C all pool together)
// and to the order people were linked, and never leaves the "root" of a shared
// budget looking like they are on their own.

/** A member's budget pointer defaults to their own id (a budget of one). */
export function budgetPointer(member) {
  return member.budgetId || member.id;
}

/**
 * Resolve members into shared-budget groups.
 *
 * @param {string[]} memberOrder  member ids in join order (stable across restarts)
 * @param {Object}   members      { [id]: member }
 * @returns {Object} `{ [memberId]: canonicalBudgetId }` — the canonical id is
 *          the earliest member of the group by join order.
 */
export function resolveBudgets(memberOrder, members) {
  const parent = new Map(memberOrder.map((id) => [id, id]));

  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // path-compress for cheapness; behaviour is identical either way
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  for (const id of memberOrder) {
    const target = budgetPointer(members[id]);
    if (target !== id && Object.prototype.hasOwnProperty.call(members, target)) {
      const ra = find(id);
      const rb = find(target);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  // Group by root, then pick the canonical id = first member of the group in
  // join order. This mirrors the Elixir `hd(group)` over member-ordered values.
  const groups = new Map(); // root -> [ids in join order]
  for (const id of memberOrder) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  const canonOf = {};
  for (const group of groups.values()) {
    const canon = group[0];
    for (const id of group) canonOf[id] = canon;
  }
  return canonOf;
}

/**
 * Build the budget list: one entry per group, with its pooled balance.
 *
 * @param {string[]} memberOrder
 * @param {Object}   members         { [id]: member }
 * @param {Object}   personBalances  { [memberId]: cents } from split.balances()
 * @param {Object}   budgetOf        result of resolveBudgets()
 * @returns {Array} `[{ id, name, memberIds, memberNames, size, balanceCents }]`
 */
export function buildBudgets(memberOrder, members, personBalances, budgetOf) {
  const orderedBudgetIds = [];
  const seen = new Set();
  for (const id of memberOrder) {
    const bid = budgetOf[id];
    if (!seen.has(bid)) {
      seen.add(bid);
      orderedBudgetIds.push(bid);
    }
  }

  return orderedBudgetIds.map((bid) => {
    const group = memberOrder.filter((id) => budgetOf[id] === bid).map((id) => members[id]);
    const names = group.map((m) => m.name);
    return {
      id: bid,
      name: names.join(" & "),
      memberIds: group.map((m) => m.id),
      memberNames: names,
      size: group.length,
      balanceCents: group.reduce((sum, m) => sum + (personBalances[m.id] || 0), 0),
    };
  });
}
