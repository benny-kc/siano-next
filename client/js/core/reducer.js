// The pure reducer: fold an op-log into current trip state.
//
// This is the whole point of the local-first design. Every device holds the
// same append-only log of ops and folds it here into the same `state`, which
// buildSnapshot() (snapshot.js) then turns into what the board renders. Order
// of arrival does not matter — the fold is deterministic in the ops' causal
// metadata, so "everyone who has seen the same set of ops computes the same
// balances." (Strong eventual consistency.)
//
// Merge strategy per field:
//   - Membership sets (members, meals, participants, photos): ADD-WINS OR-Set.
//     An element is present iff its causal frontier contains an add — a remove
//     only beats adds it causally follows, so a concurrent re-add survives.
//   - Plain scalars (names, emoji, board position, open flag): LWW — the frontier
//     op with the greatest (lamport, device) wins. Convergent and boring.
//   - MONEY scalars (meal amount, locked share): LWW winner for convergence, but
//     any *genuinely concurrent* differing edit on the frontier is recorded as a
//     conflict so the UI can say "two people set this at once — pick one." Money
//     is never silently overwritten.

import { OP } from "./ops.js";
import { compareOps, causallyAfter, frontier } from "./lamport.js";
import { registerVersion } from "../version.js";
registerVersion("js/core/reducer.js", 1);

function maxByOrder(ops) {
  return ops.reduce((best, o) => (compareOps(o, best) > 0 ? o : best), ops[0]);
}
function minByOrder(ops) {
  return ops.reduce((best, o) => (compareOps(o, best) < 0 ? o : best), ops[0]);
}

/** Present iff the causal frontier of add/remove events contains an add (add-wins). */
function orSetPresent(events) {
  if (events.length === 0) return false;
  return frontier(events).some((e) => e.add);
}

/**
 * Resolve a scalar field from its set-ops. Returns null if never set, else
 * `{ value, conflicts }`. `conflicts` lists concurrent frontier values that
 * disagree with the winner (empty for a clean edit). `valueOf(op)` extracts the
 * field's value; equality is by `keyOf` (defaults to the value itself).
 */
function resolveScalar(ops, valueOf, keyOf = (v) => v) {
  if (ops.length === 0) return null;
  const f = frontier(ops);
  const winner = maxByOrder(f);
  const winValue = valueOf(winner);
  const winKey = keyOf(winValue);
  const conflicts = f
    .filter((o) => o !== winner && keyOf(valueOf(o)) !== winKey)
    .map((o) => ({ value: valueOf(o), device: o.device, lamport: o.lamport }))
    .sort((a, b) => b.lamport - a.lamport);
  return { value: winValue, conflicts };
}

function bucket(map, key) {
  let v = map.get(key);
  if (!v) map.set(key, (v = {}));
  return v;
}

/**
 * Fold ops into trip state.
 * @param {string} tripId
 * @param {Array}  ops     the full op-log (any order; each op carries lamport/device/vv)
 * @returns {Object} state consumable by buildSnapshot()
 */
export function fold(tripId, ops) {
  const tripName = [];
  const members = new Map(); // id -> { events:[], name:[], budget:[], adds:[] }
  const meals = new Map(); // id -> { events, name, emoji, amount, payer, move, open, adds, parts:Map, shares:Map, photos:Map }

  const memberOf = (id) => {
    let m = members.get(id);
    if (!m) members.set(id, (m = { events: [], name: [], budget: [], adds: [] }));
    return m;
  };
  const mealOf = (id) => {
    let m = meals.get(id);
    if (!m) {
      meals.set(id, (m = {
        events: [], name: [], emoji: [], amount: [], payer: [], move: [], open: [],
        adds: [], parts: new Map(), shares: new Map(), photos: new Map(),
      }));
    }
    return m;
  };

  for (const op of ops) {
    switch (op.op) {
      case OP.SET_TRIP_NAME:
        tripName.push(op);
        break;

      case OP.ADD_MEMBER: {
        const m = memberOf(op.memberId);
        m.events.push({ ...op, add: true });
        m.adds.push(op);
        break;
      }
      case OP.REMOVE_MEMBER:
        memberOf(op.memberId).events.push({ ...op, add: false });
        break;
      case OP.SET_MEMBER_NAME:
        memberOf(op.memberId).name.push(op);
        break;
      case OP.SET_MEMBER_BUDGET:
        memberOf(op.memberId).budget.push(op);
        break;

      case OP.ADD_MEAL: {
        const m = mealOf(op.mealId);
        m.events.push({ ...op, add: true });
        m.adds.push(op);
        break;
      }
      case OP.REMOVE_MEAL:
        mealOf(op.mealId).events.push({ ...op, add: false });
        break;
      case OP.SET_MEAL_NAME:
        mealOf(op.mealId).name.push(op);
        break;
      case OP.SET_MEAL_EMOJI:
        mealOf(op.mealId).emoji.push(op);
        break;
      case OP.SET_AMOUNT:
        mealOf(op.mealId).amount.push(op);
        break;
      case OP.SET_PAYER:
        mealOf(op.mealId).payer.push(op);
        break;
      case OP.MOVE_MEAL:
        mealOf(op.mealId).move.push(op);
        break;
      case OP.SET_OPEN:
        mealOf(op.mealId).open.push(op);
        break;
      case OP.ADD_PARTICIPANT: {
        const b = bucket(mealOf(op.mealId).parts, op.memberId);
        (b.events || (b.events = [])).push({ ...op, add: true });
        break;
      }
      case OP.REMOVE_PARTICIPANT: {
        const b = bucket(mealOf(op.mealId).parts, op.memberId);
        (b.events || (b.events = [])).push({ ...op, add: false });
        break;
      }
      case OP.SET_SHARE: {
        const shares = mealOf(op.mealId).shares;
        (shares.get(op.memberId) || shares.set(op.memberId, []).get(op.memberId)).push(op);
        break;
      }
      case OP.ADD_PHOTO: {
        const b = bucket(mealOf(op.mealId).photos, op.photoId);
        (b.events || (b.events = [])).push({ ...op, add: true });
        break;
      }
      case OP.SET_PHOTO_FIELDS: {
        const b = bucket(mealOf(op.mealId).photos, op.photoId);
        (b.fields || (b.fields = [])).push(op);
        break;
      }
      case OP.ASSIGN_FIELD: {
        const b = bucket(mealOf(op.mealId).photos, op.photoId);
        const assigns = b.assigns || (b.assigns = new Map());
        (assigns.get(op.fieldIndex) || assigns.set(op.fieldIndex, []).get(op.fieldIndex)).push(op);
        break;
      }
      default:
        // Unknown op — ignore, so a newer client's ops never crash an older fold.
        break;
    }
  }

  // ---- Project members ----
  const outMembers = {};
  const presentMemberIds = [];
  for (const [id, m] of members) {
    if (!orSetPresent(m.events)) continue;
    presentMemberIds.push(id);
    const winAdd = maxByOrder(m.adds); // fields declared at (re-)add time
    const name = resolveScalar([...m.adds, ...m.name], (o) => o.name)?.value;
    const budgetId = resolveScalar([...m.adds, ...m.budget], (o) => o.budgetId)?.value;
    outMembers[id] = {
      id,
      name: name ?? "",
      color: winAdd.color ?? null,
      initials: winAdd.initials ?? null,
      budgetId: budgetId ?? null,
    };
  }
  // Join order = earliest add op, deterministic across devices.
  const memberOrder = presentMemberIds
    .sort((a, b) => compareOps(minByOrder(members.get(a).adds), minByOrder(members.get(b).adds)));

  // ---- Project meals ----
  const outMeals = {};
  const presentMealIds = [];
  for (const [id, m] of meals) {
    if (!orSetPresent(m.events)) continue;
    presentMealIds.push(id);

    // Creation time = the FIRST add op's wall-clock stamp (unix ms). minByOrder
    // is deterministic across devices, so a concurrent re-add (after a remove)
    // never changes the original "created" time. Null for pre-`createdAt` ops.
    const firstAdd = minByOrder(m.adds);
    const createdAt = typeof firstAdd.createdAt === "number" ? firstAdd.createdAt : null;

    const name = resolveScalar([...m.adds, ...m.name], (o) => o.name)?.value;
    const emoji = resolveScalar([...m.adds, ...m.emoji], (o) => o.emoji)?.value;
    const amountRes = resolveScalar(m.amount, (o) => o.cents);
    const payer = resolveScalar(m.payer, (o) => o.payerId);
    const posX = resolveScalar([...m.adds, ...m.move], (o) => o.x)?.value;
    const posY = resolveScalar([...m.adds, ...m.move], (o) => o.y)?.value;
    const open = resolveScalar([...m.adds, ...m.open], (o) => o.open)?.value;

    // participants: add-wins OR-Set, ordered by earliest add
    const participantIds = [];
    for (const [mid, b] of m.parts) {
      if (b.events && orSetPresent(b.events) && outMembers[mid]) participantIds.push(mid);
    }
    participantIds.sort((a, b) => {
      const aa = m.parts.get(a).events.filter((e) => e.add);
      const bb = m.parts.get(b).events.filter((e) => e.add);
      return compareOps(minByOrder(aa), minByOrder(bb));
    });

    // locked shares (money): latest set_share per member; locked:false clears it
    const lockedShares = {};
    const shareConflicts = {};
    for (const [mid, ops2] of m.shares) {
      const res = resolveScalar(ops2, (o) => ({ cents: o.cents, locked: o.locked }), (v) => `${v.locked}:${v.cents}`);
      if (res && res.value.locked) {
        lockedShares[mid] = res.value.cents;
        const moneyConflicts = res.conflicts.filter((c) => c.value.locked);
        if (moneyConflicts.length) {
          shareConflicts[mid] = moneyConflicts.map((c) => ({ cents: c.value.cents, device: c.device }));
        }
      }
    }

    // photos: add-wins OR-Set; fields = latest set_photo_fields; assigns override
    const photos = [];
    for (const [pid, b] of m.photos) {
      if (!(b.events && orSetPresent(b.events))) continue;
      const fieldsRes = b.fields ? resolveScalar(b.fields, (o) => o.fields, (v) => JSON.stringify(v)) : null;
      const fields = (fieldsRes?.value || []).map((f) => ({ ...f }));
      if (b.assigns) {
        for (const [idx, aops] of b.assigns) {
          const a = resolveScalar(aops, (o) => o.memberId);
          if (a && fields[idx]) fields[idx].memberId = a.value ?? null;
        }
      }
      photos.push({ id: pid, fields });
    }

    const conflicts = {};
    if (amountRes && amountRes.conflicts.length) conflicts.amount = amountRes.conflicts;
    if (Object.keys(shareConflicts).length) conflicts.shares = shareConflicts;

    outMeals[id] = {
      id,
      name: name ?? "",
      emoji: emoji ?? null,
      createdAt,
      amountCents: amountRes?.value ?? 0,
      payerId: payer?.value ?? null,
      participantIds,
      lockedShares,
      x: posX ?? 0,
      y: posY ?? 0,
      open: open ?? true,
      photos,
      conflicts: Object.keys(conflicts).length ? conflicts : null,
    };
  }
  const mealOrder = presentMealIds
    .sort((a, b) => compareOps(minByOrder(meals.get(a).adds), minByOrder(meals.get(b).adds)));

  return {
    id: tripId,
    name: resolveScalar(tripName, (o) => o.name)?.value ?? "",
    members: outMembers,
    memberOrder,
    meals: outMeals,
    mealOrder,
  };
}
