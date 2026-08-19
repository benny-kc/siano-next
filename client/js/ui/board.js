// Minimal board renderer.
//
// This is a FUNCTIONAL scaffold of the UI, not the finished game-like board.
// It renders straight from the folded snapshot and proves the whole local-first
// loop end to end: edit -> op -> log -> fold -> snapshot -> render, synced live
// across devices. The pannable/zoomable board, draggable traveller tokens and
// drag-to-split gestures from the reference app are a follow-up (their hooks in
// the siano repo's assets/js are largely portable); everything they need is
// already here in the reducer and snapshot.

import { format, parse } from "../core/money.js";

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "value") n.value = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const signed = (cents) => (cents > 0 ? "+" : "") + format(cents);

function balancesPanel(snap) {
  const rows = snap.budgets.map((b) =>
    el("div", { class: "bal-row" },
      el("span", { class: "bal-name", text: b.name || "—" }),
      el("span", {
        class: "bal-amt " + (b.balanceCents > 0 ? "pos" : b.balanceCents < 0 ? "neg" : ""),
        text: signed(b.balanceCents),
      }),
    ));
  const settle = snap.settlements.map((s) =>
    el("li", { text: `${s.from} → ${s.to}: ${format(s.amountCents)}` }));

  return el("section", { class: "panel" },
    el("div", { class: "panel-head" },
      el("span", { text: `${snap.budgetCount} budget${snap.budgetCount === 1 ? "" : "s"}` }),
      el("span", { class: "total", text: `total ${format(snap.totalCents)}` }),
    ),
    el("div", { class: "bals" }, ...rows),
    snap.settlements.length ? el("ul", { class: "settle" }, ...settle) : null,
  );
}

function memberChip(m, actions, { active, onClick, removable } = {}) {
  return el("span", {
    class: "chip" + (active ? " chip--on" : ""),
    style: m.color ? `--chip:${m.color}` : null,
    title: m.name,
    onClick: onClick || null,
  },
    el("span", { class: "chip-name", text: m.name || "?" }),
    removable
      ? el("button", {
          class: "chip-x", type: "button", title: "Remove",
          onClick: (e) => { e.stopPropagation(); actions.removeMember(m.id); },
        }, "×")
      : null,
  );
}

function membersStrip(snap, actions) {
  const chips = snap.members.map((m) =>
    el("span", { class: "chip chip--edit", style: m.color ? `--chip:${m.color}` : null },
      el("input", {
        class: "chip-input", value: m.name, "aria-label": "traveller name",
        onChange: (e) => actions.setMemberName(m.id, e.target.value),
      }),
      el("button", {
        class: "chip-x", type: "button", title: "Remove traveller",
        onClick: () => actions.removeMember(m.id),
      }, "×"),
    ));
  return el("section", { class: "strip" }, ...chips,
    snap.members.length === 0 ? el("p", { class: "empty", text: "Add a traveller to start." }) : null);
}

function conflictChip(conflicts) {
  if (!conflicts) return null;
  const bits = [];
  if (conflicts.amount) bits.push(`total also set to ${conflicts.amount.map((c) => format(c.value)).join(", ")}`);
  if (conflicts.shares) {
    for (const [mid, cs] of Object.entries(conflicts.shares)) {
      bits.push(`a share also set to ${cs.map((c) => format(c.cents)).join(", ")}`);
    }
  }
  return el("div", { class: "conflict", title: "Two people set this at once — pick one." },
    "⚠ " + bits.join("; "));
}

function mealCard(meal, snap, actions) {
  const payerSelect = el("select", {
    class: "payer",
    onChange: (e) => actions.setPayer(meal.id, e.target.value || null),
  },
    el("option", { value: "", text: "who paid?" }),
    ...snap.members.map((m) => {
      const o = el("option", { value: m.id, text: m.name });
      if (m.id === meal.payerId) o.selected = true;
      return o;
    }));

  const participantToggles = snap.members.map((m) => {
    const on = meal.participantIds.includes(m.id);
    return memberChip(m, actions, {
      active: on,
      onClick: () => actions.toggleParticipant(meal.id, m.id, !on),
    });
  });

  const shareRows = meal.participants.map((p) => {
    const lockBtn = el("button", {
      class: "lock" + (p.locked ? " lock--on" : ""), type: "button",
      title: p.locked ? "Unlock (back to auto split)" : "Lock this share",
      onClick: () => actions.setShare(meal.id, p.id, p.locked ? null : p.shareCents),
    }, p.locked ? "🔒" : "🔓");
    const amt = p.locked
      ? el("input", {
          class: "share-input", value: format(p.shareCents), inputmode: "decimal",
          onChange: (e) => {
            const r = parse(e.target.value);
            if (r.ok) actions.setShare(meal.id, p.id, r.cents);
          },
        })
      : el("span", { class: "share-amt", text: format(p.shareCents) });
    return el("div", { class: "share" },
      el("span", { class: "share-name", text: p.name + (p.isPayer ? " (paid)" : "") }),
      amt, lockBtn);
  });

  return el("article", { class: "meal" },
    el("div", { class: "meal-head" },
      el("input", {
        class: "meal-name", value: meal.name, placeholder: "Bill name",
        onChange: (e) => actions.setMealName(meal.id, e.target.value),
      }),
      el("input", {
        class: "meal-amt", value: meal.amountCents ? format(meal.amountCents) : "",
        placeholder: "0.00", inputmode: "decimal", "aria-label": "total",
        onChange: (e) => {
          const r = parse(e.target.value);
          if (r.ok) actions.setAmount(meal.id, r.cents);
        },
      }),
      el("button", { class: "meal-x", type: "button", title: "Delete bill", onClick: () => actions.removeMeal(meal.id) }, "×"),
    ),
    payerSelect,
    el("div", { class: "toggles" }, ...participantToggles),
    shareRows.length ? el("div", { class: "shares" }, ...shareRows) : null,
    meal.diffCents && meal.allSharesFixed
      ? el("div", { class: "diff", text: `off by ${format(meal.diffCents)} — reconcile to 0` })
      : null,
    conflictChip(meal.conflicts),
  );
}

/** Render the whole board into `root` from `snap`, wiring `actions`. */
export function render(root, snap, actions) {
  root.replaceChildren(
    balancesPanel(snap),
    membersStrip(snap, actions),
    ...snap.meals.map((m) => mealCard(m, snap, actions)),
    snap.meals.length === 0 && snap.members.length > 0
      ? el("p", { class: "empty", text: "Add a bill to split." })
      : null,
  );
}
