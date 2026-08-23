// The concrete operation set for a Siano trip, plus constructors that stamp an
// op with the local clock. Ops are the ONLY thing that gets synced — the log of
// ops IS the trip and IS the backup. Every device folds the same log with the
// same reducer (reducer.js) and gets the same state.
//
// Two kinds of field, two merge strategies (see reducer.js):
//   - SET membership (members, meals, participants, photos) -> add-wins OR-Set.
//   - SCALAR fields (names, emoji, position, open flag)      -> LWW by clock.
//   - MONEY scalars (meal amount, a locked share)            -> LWW by clock for
//     convergence, BUT genuinely concurrent differing edits are surfaced as a
//     conflict rather than silently overwritten. Money is always integer cents.

import { registerVersion } from "../version.js";
registerVersion("js/core/ops.js", 1);

export const OP = Object.freeze({
  SET_TRIP_NAME: "set_trip_name",

  ADD_MEMBER: "add_member",
  REMOVE_MEMBER: "remove_member",
  SET_MEMBER_NAME: "set_member_name",
  SET_MEMBER_BUDGET: "set_member_budget", // directional pool pointer (see budgets.js)

  ADD_MEAL: "add_meal",
  REMOVE_MEAL: "remove_meal",
  SET_MEAL_NAME: "set_meal_name",
  SET_MEAL_EMOJI: "set_meal_emoji",
  SET_AMOUNT: "set_amount", // MONEY
  SET_PAYER: "set_payer",
  ADD_PARTICIPANT: "add_participant",
  REMOVE_PARTICIPANT: "remove_participant",
  SET_SHARE: "set_share", // MONEY (locked custom share; locked:false clears it)
  MOVE_MEAL: "move_meal", // board coords, purely visual
  SET_OPEN: "set_open",

  ADD_PHOTO: "add_photo",
  SET_PHOTO_FIELDS: "set_photo_fields",
  ASSIGN_FIELD: "assign_field",
});

/** The money-bearing ops — the reducer routes these through conflict detection. */
export const MONEY_OPS = new Set([OP.SET_AMOUNT, OP.SET_SHARE]);

/**
 * Build one op: `{ op, ...payload, lamport, device, vv }`. Stamping advances the
 * clock, so call it exactly once per intended change. Returns the op ready to
 * append to the local log and broadcast.
 */
export function makeOp(clock, op, payload = {}) {
  return { op, ...payload, ...clock.stamp() };
}

// --- Convenience constructors (thin wrappers; keep call sites readable) ------

export const setTripName = (c, name) => makeOp(c, OP.SET_TRIP_NAME, { name });

export const addMember = (c, memberId, { name, color, initials, budgetId } = {}) =>
  makeOp(c, OP.ADD_MEMBER, { memberId, name, color, initials, budgetId });
export const removeMember = (c, memberId) => makeOp(c, OP.REMOVE_MEMBER, { memberId });
export const setMemberName = (c, memberId, name) => makeOp(c, OP.SET_MEMBER_NAME, { memberId, name });
export const setMemberBudget = (c, memberId, budgetId) =>
  makeOp(c, OP.SET_MEMBER_BUDGET, { memberId, budgetId });

// `createdAt` (unix milliseconds, wall-clock at creation) rides on the add op so
// every device shows the SAME "created" time on the card — the author's clock at
// the moment the bill was made, carried in the synced op, not each viewer's fold
// time. Callers may override it (e.g. tests); otherwise it's stamped now.
export const addMeal = (c, mealId, fields = {}) =>
  makeOp(c, OP.ADD_MEAL, { mealId, createdAt: Date.now(), ...fields });
export const removeMeal = (c, mealId) => makeOp(c, OP.REMOVE_MEAL, { mealId });
export const setMealName = (c, mealId, name) => makeOp(c, OP.SET_MEAL_NAME, { mealId, name });
export const setMealEmoji = (c, mealId, emoji) => makeOp(c, OP.SET_MEAL_EMOJI, { mealId, emoji });
export const setAmount = (c, mealId, cents) => makeOp(c, OP.SET_AMOUNT, { mealId, cents });
export const setPayer = (c, mealId, payerId) => makeOp(c, OP.SET_PAYER, { mealId, payerId });
export const addParticipant = (c, mealId, memberId) =>
  makeOp(c, OP.ADD_PARTICIPANT, { mealId, memberId });
export const removeParticipant = (c, mealId, memberId) =>
  makeOp(c, OP.REMOVE_PARTICIPANT, { mealId, memberId });
export const setShare = (c, mealId, memberId, cents, locked = true) =>
  makeOp(c, OP.SET_SHARE, { mealId, memberId, cents, locked });
export const moveMeal = (c, mealId, x, y) => makeOp(c, OP.MOVE_MEAL, { mealId, x, y });
export const setOpen = (c, mealId, open) => makeOp(c, OP.SET_OPEN, { mealId, open });

export const addPhoto = (c, mealId, photoId) => makeOp(c, OP.ADD_PHOTO, { mealId, photoId });
export const setPhotoFields = (c, mealId, photoId, fields) =>
  makeOp(c, OP.SET_PHOTO_FIELDS, { mealId, photoId, fields });
export const assignField = (c, mealId, photoId, fieldIndex, memberId) =>
  makeOp(c, OP.ASSIGN_FIELD, { mealId, photoId, fieldIndex, memberId });
