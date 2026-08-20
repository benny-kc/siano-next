// The board renderer: paints every dynamic region from the folded snapshot.
//
// A faithful port of the reference app's game-like board (its
// lib/siano_web/live/trip_live/sections/*.heex templates). Where the reference
// let LiveView + morphdom patch server-rendered HTML in place, here we repaint
// the dynamic regions from the local snapshot — but the two things a repaint
// must never disturb (the board's pan/zoom and the drawers' open state) live on
// <html> (see boardview.js / viewstate.js), so a full repaint is safe.
//
// The regions:
//   • top bar    — trip name chip, bill count, running total
//   • #board-canvas — the open meal cards, positioned in canvas coordinates
//   • #dock      — the draggable traveller tokens
//   • Bills drawer, Settings drawer, Report overlay contents
//
// Pointer gestures (drag-to-split, card drag, pan/zoom, long-press, edge-swipe)
// are wired once in interactions.js by event delegation, so they survive every
// repaint without re-binding.

import { format } from "../core/money.js";
import { selectedMember } from "./selection.js";
import { encodeText } from "../vendor/qrcode.js";
import { loadTrips } from "../store/trips.js";
import { FONTS, getTypography, SCALE_MIN, SCALE_MAX, WEIGHT_MIN, WEIGHT_MAX } from "./typography.js";
import { fullscreenPreferred } from "./fullscreen.js";

// ── Per-viewer UI state (the reference held some of this server-side) ─────────
export const ui = {
  billsFilter: null, // member id, or null for "all bills"
  billsSort: "created_asc",
  editingShare: null, // "mealId:memberId" while a share is being typed
  ledgerMember: null, // which traveller the personal ledger is showing
};

// ── DOM helper ────────────────────────────────────────────────────────────────
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "value") n.value = v;
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) { if (dv != null) n.dataset[dk] = dv; }
    else if (k === "style") n.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const signed = (cents) => (cents > 0 ? "+" : "") + format(cents);

// A meal's creation time as "d Mon, HH:MM" in the VIEWER's local wall-clock
// (e.g. "20 Aug, 14:30") — the same compact format the reference app showed on
// each card. `createdAt` is unix ms carried on the add op, so every device shows
// the author's creation moment. Returns null for pre-`createdAt` meals (nothing
// to show) or a bad value, so the caller can omit the line entirely.
function fmtCreatedAt(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const mon = d.toLocaleString("en-US", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${mon}, ${hh}:${mm}`;
}
const toneClass = (c) => (c > 0 ? "tone-pos" : c < 0 ? "tone-neg" : "tone-zero");

// Build an inline-SVG QR for a URL so it can be scanned to open the trip on
// another phone. Self-contained (see js/vendor/qrcode.js), so it works offline
// in the installed PWA. Memoized by URL — the code only changes per trip.
let _qr = { url: null, svg: "" };
function qrSvg(url) {
  if (_qr.url === url) return _qr.svg;
  let svg = "";
  try {
    const { size, modules } = encodeText(url, "M");
    const quiet = 4;
    const dim = size + quiet * 2;
    let path = "";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
      }
    }
    svg =
      `<svg viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${path}" fill="#0f172a"/></svg>`;
  } catch {
    svg = "";
  }
  _qr = { url, svg };
  return svg;
}

// The canonical shareable URL for this trip (matches the "Copy trip link" text).
const tripUrl = (id) => `${location.origin}/t/${encodeURIComponent(id)}`;

// ── Trash / grip icons as small SVGs ──────────────────────────────────────────
function trashIcon() {
  const svg = el("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2" });
  svg.innerHTML =
    '<path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a1 1 0 01-1 1H7a1 1 0 01-1-1V7"/>';
  return svg;
}

// ── Meal card ─────────────────────────────────────────────────────────────────
function mealCard(meal, snap, actions) {
  // header: grip + emoji (both drag handles), name, close
  const head = el("div", { class: "meal-head" },
    el("span", { class: "drag-handle drag-grip", title: "Drag to move" }, "⠿"),
    el("span", { class: "drag-handle drag-emoji", title: "Drag to move" }, meal.emoji || "🍽️"),
    el("input", {
      class: "meal-name", value: meal.name, placeholder: "Meal name", "aria-label": "Meal name",
      title: "Tap to rename", autocomplete: "off",
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => actions.setMealName(meal.id, e.target.value),
    }),
    el("button", { class: "meal-close", title: "Close card (kept in Bills history)", onclick: () => actions.closeMeal(meal.id) }, "✕"),
  );

  // total row
  const badge = meal.hasCustomShares
    ? el("span", { class: "per-head" }, "custom 📌")
    : meal.perHeadCents > 0
      ? el("span", { class: "per-head" }, `${format(meal.perHeadCents)}/head`)
      : null;
  const total = el("div", { class: "meal-total" },
    el("span", { class: "label" }, "Total"),
    el("input", {
      class: "amount-input siano-amount", inputmode: "decimal", "aria-label": "total",
      value: meal.amountCents > 0 ? format(meal.amountCents) : "", placeholder: "0.00",
      autocomplete: "off", dataset: { mealId: meal.id },
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => actions.setAmountStr(meal.id, e.target.value),
    }),
    badge,
  );

  // participants
  const rows = meal.participants.map((p) => {
    const key = `${meal.id}:${p.id}`;
    const payerBtn = el("button", {
      type: "button", class: "payer-btn" + (p.isPayer ? " is-payer" : ""), title: "Mark as payer",
      onclick: () => actions.setPayer(meal.id, p.id),
    }, p.isPayer ? "💳" : (p.initials || "?"));

    const body = ui.editingShare === key
      ? el("form", { class: "share-form", onsubmit: (e) => { e.preventDefault(); const v = e.target.elements.value.value; actions.saveShare(meal.id, p.id, v); } },
          el("input", {
            class: "share-edit", name: "value", inputmode: "decimal",
            value: p.locked ? format(p.shareCents) : "", placeholder: format(p.shareCents),
            autocomplete: "off", "data-autofocus": "1",
            onblur: (e) => actions.saveShare(meal.id, p.id, e.target.value),
          }),
        )
      : el("div", { class: "pbody", title: "Hold to set an exact share", dataset: { longpress: "1", mealId: meal.id, memberId: p.id } },
          el("span", { class: "pname" }, p.name),
          el("span", { class: "pshare" }, format(p.shareCents)),
          p.locked ? el("span", { class: "pin", title: "Custom share" }, "📌") : null,
        );

    const chip = el("div", { class: "pchip animate-pop", style: `background-color:${p.color}`, title: `${p.name} · ${format(p.shareCents)}${p.isPayer ? " · paid" : ""}` },
      payerBtn, body,
      el("button", { type: "button", class: "premove", title: "Remove from meal", onclick: () => actions.toggleParticipant(meal.id, p.id, false) }, "✕"),
    );

    const diff = p.isPayer && meal.allSharesFixed
      ? el("span", { class: "diff-badge animate-pop", title: "Bill total minus everyone's declared shares — aim for 0.00" }, signed(meal.diffCents))
      : null;

    return el("div", { class: "participant-row" }, chip, diff);
  });

  const dropzone = el("div", { class: "dropzone" },
    meal.participants.length === 0 ? el("p", { class: "hint" }, "drop travellers here") : null,
    el("div", { class: "participants" }, ...rows),
  );

  const created = fmtCreatedAt(meal.createdAt);
  const foot = el("div", { class: "meal-foot" },
    created ? el("span", { class: "meal-time", title: "When this bill was created" }, created) : null,
    el("button", {
      type: "button", class: "delete", title: "Delete bill", "aria-label": `Delete ${meal.name}`,
      dataset: { confirm: `Delete “${meal.name || "this bill"}” permanently? This removes its cost from everyone's balance.`, confirmAction: `deleteMeal:${meal.id}` },
    }, trashIcon()),
  );

  return el("article", {
    class: "meal-card animate-pop", style: `left:${meal.x}px; top:${meal.y}px;`,
    dataset: { mealId: meal.id, x: meal.x, y: meal.y },
  },
    head, total, dropzone,
    meal.participants.length ? el("p", { class: "meal-hint" }, "hold a name to set an exact share · 💳 marks who paid") : null,
    foot,
    conflictNote(meal.conflicts),
  );
}

function conflictNote(conflicts) {
  if (!conflicts) return null;
  const bits = [];
  if (conflicts.amount) bits.push(`total also set to ${conflicts.amount.map((c) => format(c.value)).join(", ")}`);
  if (conflicts.shares) {
    for (const cs of Object.values(conflicts.shares)) {
      bits.push(`a share also set to ${cs.map((c) => format(c.cents)).join(", ")}`);
    }
  }
  return el("div", { class: "conflict", title: "Two people set this at once — pick one." }, "⚠ " + bits.join("; "));
}

// ── Dock ────────────────────────────────────────────────────────────────────
function travellerToken(m) {
  return el("div", {
    class: "traveller-token animate-pop" + (m.id === selectedMember ? " is-selected" : ""),
    dataset: { memberId: m.id },
  },
    el("span", { class: "avatar", style: `background-color:${m.color}` }, m.initials || "?"),
    el("span", { class: "traveller-name" }, m.name || "?"),
  );
}

// ── Bills drawer contents ─────────────────────────────────────────────────────
const SORT_OPTIONS = [
  ["Name (A–Z)", "name_asc"],
  ["Name (Z–A)", "name_desc"],
  ["Date added (oldest first)", "created_asc"],
  ["Date added (newest first)", "created_desc"],
  ["Amount (low to high)", "cash_asc"],
  ["Amount (high to low)", "cash_desc"],
];

function sortBills(bills, sort) {
  const by = (f) => [...bills].sort(f);
  switch (sort) {
    case "name_asc": return by((a, b) => (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase()));
    case "name_desc": return by((a, b) => (b.name || "").toLowerCase().localeCompare((a.name || "").toLowerCase()));
    case "created_desc": return [...bills].reverse();
    case "cash_asc": return by((a, b) => a.amountCents - b.amountCents);
    case "cash_desc": return by((a, b) => b.amountCents - a.amountCents);
    default: return bills; // created_asc = identity (bills arrive oldest first)
  }
}

function renderSortMenu(actions) {
  const box = document.getElementById("bills-sort-menu");
  box.replaceChildren(
    ...SORT_OPTIONS.map(([label, key]) =>
      el("button", {
        type: "button", class: ui.billsSort === key ? "active" : "",
        onclick: () => actions.setBillsSort(key),
      }, el("span", {}, label), ui.billsSort === key ? el("span", {}, "✓") : null)),
  );
}

function renderBills(snap, actions) {
  renderSortMenu(actions);
  const root = document.getElementById("bills-content");
  const kids = [];

  if (snap.members.length && snap.bills.length) {
    kids.push(el("div", { class: "filter-pills" },
      ...snap.members.map((m) =>
        el("button", {
          type: "button", class: "pill" + (ui.billsFilter === m.id ? " active" : ""),
          onclick: () => actions.filterBills(m.id),
        }, m.name)),
    ));
  }

  if (snap.bills.length === 0) {
    kids.push(el("p", { class: "card-note" }, "No bills yet — tap ➕ to add one."));
  } else {
    const filtered = ui.billsFilter
      ? snap.bills.filter((b) => b.memberIds.includes(ui.billsFilter))
      : snap.bills;
    const list = el("ul", { class: "bills-list" },
      ...sortBills(filtered, ui.billsSort).map((bill) => billRow(bill, actions)),
    );
    kids.push(list);
  }

  if (ui.billsFilter) {
    const name = snap.members.find((m) => m.id === ui.billsFilter)?.name;
    kids.push(el("p", { class: "card-note", style: "text-align:center" },
      `Showing only ${name || "one traveller"}'s bills — tap their name again to see all.`));
  }

  root.replaceChildren(...kids);
}

function billRow(bill, actions) {
  const people = `${bill.participantCount} ${bill.participantCount === 1 ? "person" : "people"}`;
  const meta = people +
    (bill.payerName ? ` · ${bill.payerName} paid` : "") +
    (bill.complete ? "" : " · draft");
  return el("li", { class: "bill-row" },
    el("button", { type: "button", class: "bill-open", onclick: () => actions.openMeal(bill.id) },
      el("span", { class: "emoji" }, bill.emoji || "🍽️"),
      el("span", { class: "info" },
        el("span", { class: "bname" }, bill.name || "Untitled"),
        el("span", { class: "bmeta" }, meta),
      ),
      el("span", { class: "amt" },
        el("span", { class: "money" }, format(bill.amountCents)),
        el("span", { class: "state " + (bill.open ? "on" : "off") }, bill.open ? "on board" : "closed"),
      ),
    ),
    el("button", {
      type: "button", class: "bill-del", title: "Delete bill", "aria-label": `Delete ${bill.name}`,
      dataset: { confirm: `Delete “${bill.name || "this bill"}” permanently? This removes its cost from everyone's balance.`, confirmAction: `deleteMeal:${bill.id}` },
    }, "🗑"),
  );
}

// ── Settings drawer contents ──────────────────────────────────────────────────
function renderMenu(snap, actions) {
  const root = document.getElementById("menu-content");
  root.replaceChildren(
    travellersSection(snap, actions),
    budgetsSection(snap),
    totalSection(snap),
    settleSection(snap),
    ledgerSection(snap, actions),
    tripNameSection(snap, actions),
    tripsSection(snap, actions),
    appearanceSection(actions),
    helpSection(),
    disclaimerSection(),
  );
}

// Appearance — per-device typography (font, size, boldness). Client-only,
// applied live via CSS vars on <html> (see ui/typography.js); nothing synced.
function appearanceSection(actions) {
  const t = getTypography();
  const pct = Math.round(t.scale * 100);

  const theme = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, "Theme"),
    el("div", { class: "seg" },
      el("button", { type: "button", class: "seg-btn" + (t.theme !== "light" ? " active" : ""), "aria-pressed": String(t.theme !== "light"), onclick: () => actions.setTheme("dark") }, "🌙 Dark"),
      el("button", { type: "button", class: "seg-btn" + (t.theme === "light" ? " active" : ""), "aria-pressed": String(t.theme === "light"), onclick: () => actions.setTheme("light") }, "☀️ Light"),
    ),
  );

  const size = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, "Text size"),
    el("div", { class: "size-ctl" },
      el("button", { type: "button", class: "size-btn", title: "Smaller", "aria-label": "Smaller text", disabled: t.scale <= SCALE_MIN + 1e-9, onclick: () => actions.stepTextSize(-1) }, el("span", { class: "sm" }, "A")),
      el("span", { class: "size-val" }, `${pct}%`),
      el("button", { type: "button", class: "size-btn", title: "Larger", "aria-label": "Larger text", disabled: t.scale >= SCALE_MAX - 1e-9, onclick: () => actions.stepTextSize(1) }, el("span", { class: "lg" }, "A")),
    ),
  );

  const weight = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, "Font weight"),
    el("div", { class: "size-ctl" },
      el("button", { type: "button", class: "size-btn", title: "Lighter", "aria-label": "Lighter text", disabled: t.weight <= WEIGHT_MIN, onclick: () => actions.stepWeight(-1) }, el("span", { class: "sm", style: "font-weight:400" }, "B")),
      el("span", { class: "size-val" }, String(400 + t.weight)),
      el("button", { type: "button", class: "size-btn", title: "Bolder", "aria-label": "Bolder text", disabled: t.weight >= WEIGHT_MAX, onclick: () => actions.stepWeight(1) }, el("span", { class: "lg", style: "font-weight:900" }, "B")),
    ),
  );

  const fs = fullscreenPreferred();
  const fullscreen = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, "Full screen"),
    el("button", { type: "button", class: "toggle", "aria-pressed": String(fs), onclick: () => actions.toggleFullscreen() }, fs ? "On" : "Off"),
  );

  const fonts = el("div", { class: "font-pills" },
    ...FONTS.map((f) =>
      el("button", {
        type: "button", class: "pill" + (f.id === t.family ? " active" : ""),
        style: `font-family:${f.stack}`, "aria-pressed": String(f.id === t.family),
        onclick: () => actions.setFont(f.id),
      }, f.label)),
  );

  return el("section", {},
    el("h3", {}, "Appearance"),
    theme, size, weight, fullscreen, fonts,
    el("button", { type: "button", class: "btn-block", onclick: () => actions.resetAppearance() }, "↺ Reset appearance"),
  );
}

function travellersSection(snap, actions) {
  const items = snap.members.map((m) => {
    const select = el("select", { class: "budget-select", onchange: (e) => actions.setMemberBudget(m.id, e.target.value) },
      el("option", { value: m.id, selected: m.budgetSolo }, "on their own"),
      ...snap.members.filter((o) => o.id !== m.id).map((o) =>
        el("option", { value: o.id, selected: !m.budgetSolo && o.id === m.budgetPartnerId }, `shared with ${o.name}`)),
    );
    return el("li", { class: "member-item" },
      el("div", { class: "member-top" },
        el("span", { class: "mini-avatar", style: `background-color:${m.color}` }, m.initials || "?"),
        el("input", { class: "member-name-input", value: m.name, "aria-label": "traveller name", onchange: (e) => actions.setMemberName(m.id, e.target.value) }),
        el("button", {
          type: "button", class: "x-btn", title: "Remove traveller",
          dataset: { confirm: `Remove ${m.name} from the trip? Their meals and shares will be recalculated.`, confirmAction: `removeMember:${m.id}` },
        }, "✕"),
      ),
      el("div", { class: "budget-row" }, el("span", { class: "lbl" }, "💰 budget"), select),
      m.budgetSolo ? null : el("p", { class: "budget-note" }, `💰 shared budget: ${m.budgetName}`),
    );
  });

  const addForm = el("form", { class: "add-row", onsubmit: (e) => { e.preventDefault(); const inp = e.target.elements.name; actions.addMember(inp.value); inp.value = ""; } },
    el("input", { class: "text-input", name: "name", placeholder: "Add traveller…", autocomplete: "off" }),
    el("button", { class: "btn" }, "Add"),
  );

  return el("section", {},
    el("h3", {}, "Travellers"),
    el("ul", { class: "member-list" }, ...items),
    addForm,
  );
}

function budgetsSection(snap) {
  return el("section", {},
    el("h3", {}, "Budgets ", el("span", { class: "muted" }, "(who owes whom)")),
    el("ul", { class: "plain-list" },
      ...snap.budgets.map((b) =>
        el("li", { class: "budget-item" },
          el("span", {}, b.size > 1 ? "👥" : "🙂"),
          el("span", { class: "col" },
            el("span", { class: "bn" }, b.name || "—"),
            el("span", { class: "muted-note " + toneClass(b.balanceCents) },
              b.balanceCents > 0 ? `is owed ${format(b.balanceCents)}` : b.balanceCents < 0 ? `owes ${format(-b.balanceCents)}` : "settled up"),
          ),
        )),
    ),
  );
}

function totalSection(snap) {
  const sub = `${snap.memberCount} travellers` + (snap.budgetCount < snap.memberCount ? ` · ${snap.budgetCount} budgets` : "");
  return el("section", {},
    el("div", { class: "total-card" },
      el("p", { class: "lbl" }, "Total tracked"),
      el("p", { class: "big" }, format(snap.totalCents)),
      el("p", { class: "sub" }, sub),
    ),
  );
}

function settleSection(snap) {
  return el("section", {},
    el("h3", {}, "Settle up"),
    snap.settlements.length === 0
      ? el("p", { class: "card-note" }, "Everyone's even — nothing to settle 🎉")
      : el("ul", { class: "plain-list" },
          ...snap.settlements.map((s) =>
            el("li", { class: "settle-item" },
              el("span", { class: "from" }, s.from),
              el("span", { class: "arrow" }, "→"),
              el("span", { class: "to" }, s.to),
              el("span", { class: "money" }, format(s.amountCents)),
            ))),
  );
}

function ledgerSection(snap, actions) {
  const picks = el("div", { class: "filter-pills" },
    ...snap.members.map((m) =>
      el("button", {
        type: "button", class: "pill ledger-pick" + (m.id === ui.ledgerMember ? " is-me" : ""),
        onclick: () => actions.pickLedger(m.id),
      }, m.name)),
  );

  const me = snap.members.find((m) => m.id === ui.ledgerMember);
  let block;
  if (me) {
    const pays = snap.settlements.filter((s) => s.from === me.budgetName);
    const collects = snap.settlements.filter((s) => s.to === me.budgetName);
    block = el("div", { class: "ledger-block" },
      el("p", {}, "Hi ", el("span", { style: `color:${me.color};font-weight:700` }, me.name), " 👋"),
      me.budgetName !== me.name ? el("p", { class: "muted-note" }, `budget: 💰 ${me.budgetName}`) : null,
      el("p", { class: "big " + toneClass(me.balanceCents) },
        me.balanceCents > 0 ? `You are owed ${format(me.balanceCents)}` : me.balanceCents < 0 ? `You owe ${format(-me.balanceCents)}` : "You're settled up"),
      el("ul", {},
        ...pays.map((s) => el("li", { class: "pay" }, el("span", {}, `pay ${s.to}`), el("span", { class: "font-mono" }, format(s.amountCents)))),
        ...collects.map((s) => el("li", { class: "collect" }, el("span", {}, `collect from ${s.from}`), el("span", { class: "font-mono" }, format(s.amountCents)))),
      ),
    );
  } else {
    block = el("p", { class: "muted-note" }, "Pick who you are to see a personal breakdown.");
  }

  return el("section", {}, el("h3", {}, "Your ledger"), picks, block);
}

function tripNameSection(snap, actions) {
  return el("section", {},
    el("h3", {}, "Trip name"),
    el("input", {
      class: "text-input text-input--full", value: snap.name, placeholder: "Name this trip…", "aria-label": "Trip name", autocomplete: "off",
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => actions.setTripName(e.target.value),
    }),
    el("p", { class: "trip-id-note" }, "Trip ID: ", el("span", { class: "mono" }, snap.id)),
    el("div", { class: "qr-share" },
      el("div", { class: "qr-box", html: qrSvg(tripUrl(snap.id)), "aria-label": "Trip QR code" }),
      el("span", { class: "muted-note" }, "Scan to open this trip on another phone"),
    ),
    el("div", { class: "admin", style: "margin-top:0.75rem" },
      el("button", { type: "button", class: "btn-block", onclick: () => actions.share() }, "🔗 Copy trip link"),
      el("button", { type: "button", class: "btn-block", onclick: () => actions.newTrip() }, "✨ New trip"),
    ),
  );
}

// "Your trips" — the device-local list (localStorage), so this viewer can switch
// between the trips they've opened. Every trip visited is remembered
// automatically; the current one is flagged and can't remove itself.
function tripsSection(snap, actions) {
  const trips = loadTrips();
  const list = trips.length === 0
    ? el("p", { class: "muted-note" }, "No trips yet.")
    : el("ul", { class: "trip-list" },
        ...trips.map((t) => {
          const isCurrent = t.id === snap.id;
          const name = t.name || "Untitled trip";
          return el("li", { class: "trip-item" },
            el("button", {
              type: "button", class: "trip-open", disabled: isCurrent,
              onclick: () => actions.openTrip(t.id),
            },
              el("span", { class: "nm" + (isCurrent ? " current" : "") }, name),
              el("span", { class: "sub" }, t.id.slice(0, 8) + (isCurrent ? " · current" : "")),
            ),
            el("button", {
              type: "button", class: "trip-icon-btn", title: "Copy link to share", "aria-label": "Copy link to share",
              onclick: () => actions.shareTripLink(t.id),
            }, "🔗"),
            isCurrent
              ? el("span", { class: "trip-icon-btn", "aria-hidden": "true" })
              : el("button", {
                  type: "button", class: "trip-icon-btn remove", title: "Remove from this device", "aria-label": "Remove from this device",
                  dataset: { confirm: `Remove “${name}” from this device? (The trip itself isn't deleted.)`, confirmAction: `removeTrip:${t.id}` },
                }, "✕"),
          );
        }));

  return el("section", {}, el("h3", {}, "Your trips"), list);
}

function helpSection() {
  return el("section", {},
    el("button", { type: "button", class: "btn-block", "data-siano-help-open": "" }, "❓ How to use Siano"),
  );
}

function disclaimerSection() {
  return el("div", { class: "disclaimer" },
    el("p", { class: "hd" }, "Disclaimer"),
    el("p", {}, "Siano is provided for informational and convenience purposes only, with no warranty of any kind. It may contain bugs and can make mistakes in its calculations, splitting and tracking, so figures shown here are estimates — not a financial record. Always verify amounts yourselves before settling up. The author accepts no responsibility or liability for any errors, losses or disputes arising from use of this application. By using it you agree you do so at your own risk."),
  );
}

// ── Report overlay ────────────────────────────────────────────────────────────
// A read-only, spreadsheet-style view of the whole trip: every bill × each
// traveller's share, then the per-traveller Paid / Consumed / Net summary — a
// faithful port of the reference app's "Report & backup". "Consumed" is a
// traveller's share of the bills; "Paid" is what they fronted; "Net" (= Paid −
// Consumed) is their balance (green owed / red owes). A CSV button saves the
// same data as a backup.
function reportDash() {
  return el("span", { class: "rep-dash" }, "·");
}

function renderReport(snap) {
  const root = document.getElementById("report-content");
  const rep = snap.report;
  const cols = rep.members;

  if (rep.bills.length === 0 || cols.length === 0) {
    root.replaceChildren(el("p", { class: "card-note" },
      "Nothing to report yet — add some travellers and bills, then come back to check the totals and download a backup."));
    return;
  }

  const tot = (id, key) => rep.memberTotals[id]?.[key] || 0;
  const netTotal = rep.grandTotalCents - rep.consumedTotalCents;

  // Header: Bill · Payer · Total · <each traveller> · Diff
  const head = el("tr", {},
    el("th", { class: "name" }, "Bill"),
    el("th", { class: "left" }, "Payer"),
    el("th", {}, "Total"),
    ...cols.map((m) => el("th", {}, el("span", { style: `color:${m.color || "var(--slate-300)"}` }, m.name))),
    el("th", { class: "muted" }, "Diff"),
  );

  const body = rep.bills.map((b) =>
    el("tr", { class: b.complete ? "" : "draft" },
      el("th", { class: "name" }, `${b.emoji || "🍽️"} ${b.name || "Untitled"}`,
        b.complete ? null : el("span", { class: "draft-tag" }, " · draft")),
      el("td", { class: "left" }, b.payerName || "—"),
      el("td", { class: "amt" }, format(b.amountCents)),
      ...cols.map((m) =>
        Object.prototype.hasOwnProperty.call(b.shares, m.id)
          ? el("td", {}, format(b.shares[m.id]))
          : el("td", {}, reportDash())),
      el("td", { class: b.diffCents === 0 ? "muted" : "neg" }, b.diffCents === 0 ? "—" : format(b.diffCents)),
    ));

  const foot = el("tfoot", {},
    el("tr", { class: "sum" },
      el("th", { class: "name" }, "Consumed"),
      el("td", {}, ""),
      el("td", { class: "amt" }, format(rep.consumedTotalCents)),
      ...cols.map((m) => el("td", {}, format(tot(m.id, "shareCents")))),
      el("td", {}, ""),
    ),
    el("tr", { class: "sum" },
      el("th", { class: "name" }, "Paid"),
      el("td", {}, ""),
      el("td", { class: "amt" }, format(rep.grandTotalCents)),
      ...cols.map((m) => el("td", {}, format(tot(m.id, "paidCents")))),
      el("td", {}, ""),
    ),
    el("tr", { class: "sum net" },
      el("th", { class: "name" }, "Net"),
      el("td", {}, ""),
      el("td", { class: "amt " + toneClass(netTotal) }, signed(netTotal)),
      ...cols.map((m) => el("td", { class: toneClass(tot(m.id, "netCents")) }, signed(tot(m.id, "netCents")))),
      el("td", {}, ""),
    ),
  );

  const table = el("table", { class: "report matrix" },
    el("thead", {}, head), el("tbody", {}, ...body), foot);

  const kids = [
    el("h3", {}, "Bills — each traveller's share"),
    el("div", { class: "report-scroll" }, table),
  ];
  if (rep.draftCount > 0) {
    kids.push(el("p", { class: "muted-note", style: "margin-top:0.5rem" },
      `${rep.draftCount} draft ${rep.draftCount === 1 ? "bill is" : "bills are"} still incomplete (missing a total, payer or people) and don't count toward the totals.`));
  }

  if (snap.budgets.length) {
    kids.push(el("h3", { style: "margin-top:1.5rem" }, "Balances — per budget"));
    kids.push(el("ul", { class: "plain-list" },
      ...snap.budgets.map((b) =>
        el("li", { class: "settle-item" },
          el("span", { class: "from", style: "color:var(--slate-200)" }, b.name || "—"),
          el("span", { class: "money " + toneClass(b.balanceCents) },
            b.balanceCents > 0 ? `is owed ${format(b.balanceCents)}` : b.balanceCents < 0 ? `owes ${format(-b.balanceCents)}` : "settled up"),
        ))));
  }

  kids.push(el("h3", { style: "margin-top:1.5rem" }, "Suggested settlements"));
  if (snap.settlements.length === 0) {
    kids.push(el("p", { class: "card-note", style: "color:var(--emerald-400)" }, "🎉 Everyone is settled up."));
  } else {
    kids.push(el("ul", { class: "plain-list" },
      ...snap.settlements.map((s) =>
        el("li", { class: "settle-item" },
          el("span", { class: "from" }, s.from), el("span", { class: "arrow" }, "pays"), el("span", { class: "to" }, s.to),
          el("span", { class: "money" }, format(s.amountCents)),
        ))));
  }

  kids.push(el("p", { class: "muted-note", style: "margin-top:1rem;border-top:1px solid var(--slate-800);padding-top:0.75rem" },
    "Read-only — nothing here changes the board. “Consumed” is a traveller's share of the bills; “Net” is what they fronted minus what they consumed (their balance)."));

  root.replaceChildren(...kids);
}

// Build a spreadsheet-friendly CSV of the whole trip and hand it to the browser
// as a download. Self-contained (a Blob + object URL) — no server round-trip,
// works offline. A faithful port of the reference app's `Report.to_csv/2`: four
// sections (RFC-4180, CRLF) — trip meta · the bills × travellers share matrix
// with Consumed/Paid/Net summary rows · per-budget balances · suggested
// settlements — so the file is a real backup, not just the on-screen table.
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const encodeCsv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const money2 = (c) => (c / 100).toFixed(2); // plain decimal, no locale grouping

function pad2(n) {
  return String(n).padStart(2, "0");
}
function localStamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
function tzLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function downloadReportCsv(snap) {
  const rep = snap.report;
  const cols = rep.members;
  const names = cols.map((m) => m.name);
  const tot = (id, key) => rep.memberTotals[id]?.[key] || 0;
  const completeCount = rep.bills.length - rep.draftCount;
  const now = new Date();
  const netTotal = rep.grandTotalCents - rep.consumedTotalCents;

  const rows = [];

  // 1. Trip meta.
  rows.push(["Siano trip report"]);
  rows.push(["Trip", snap.name || ""]);
  rows.push(["Trip id", snap.id]);
  rows.push([`Generated (${tzLabel()})`, now.toLocaleString()]);
  rows.push(["Total", money2(rep.grandTotalCents)]);
  rows.push(["Bills", String(completeCount)]);
  rows.push(["Drafts (not counted)", String(rep.draftCount)]);
  rows.push(["Travellers", String(cols.length)]);
  rows.push([]);

  // 2. Bills × travellers share matrix + summary rows.
  rows.push(["Bills — each traveller's share"]);
  rows.push(["Bill", "Payer", "Status", "Total", ...names, "Assigned", "Unassigned"]);
  for (const b of rep.bills) {
    const assigned = b.amountCents - b.diffCents; // = sum of shares
    rows.push([
      (b.emoji ? b.emoji + " " : "") + (b.name || "Untitled"),
      b.payerName || "",
      b.complete ? "complete" : "draft",
      money2(b.amountCents),
      ...cols.map((m) => (Object.prototype.hasOwnProperty.call(b.shares, m.id) ? money2(b.shares[m.id]) : "")),
      money2(assigned),
      money2(b.diffCents),
    ]);
  }
  rows.push(["Consumed (share)", "", "", money2(rep.consumedTotalCents), ...cols.map((m) => money2(tot(m.id, "shareCents"))), "", ""]);
  rows.push(["Paid", "", "", money2(rep.grandTotalCents), ...cols.map((m) => money2(tot(m.id, "paidCents"))), "", ""]);
  rows.push(["Net (paid - consumed)", "", "", money2(netTotal), ...cols.map((m) => money2(tot(m.id, "netCents"))), "", ""]);
  rows.push([]);

  // 3. Per-budget balances.
  rows.push(["Balances — per budget"]);
  rows.push(["Budget", "Members", "Paid", "Consumed", "Balance", "Direction"]);
  for (const b of snap.budgets) {
    const paid = b.memberIds.reduce((s, id) => s + tot(id, "paidCents"), 0);
    const consumed = b.memberIds.reduce((s, id) => s + tot(id, "shareCents"), 0);
    const dir = b.balanceCents > 0 ? "is owed" : b.balanceCents < 0 ? "owes" : "settled";
    rows.push([b.name, b.memberNames.join(", "), money2(paid), money2(consumed), money2(b.balanceCents), dir]);
  }
  rows.push([]);

  // 4. Suggested settlements.
  rows.push(["Suggested settlements"]);
  if (snap.settlements.length === 0) {
    rows.push(["Everyone is settled up"]);
  } else {
    rows.push(["From", "To", "Amount"]);
    for (const s of snap.settlements) rows.push([s.from, s.to, money2(s.amountCents)]);
  }

  const blob = new Blob(["﻿" + encodeCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = (snap.name || "siano-trip").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "siano-trip";
  a.href = url;
  a.download = `${slug}-siano-report-${localStamp(now)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Top bar + focus restore ────────────────────────────────────────────────────
function renderTopBar(snap) {
  document.getElementById("trip-chip").textContent = snap.name || "Untitled trip";
  document.getElementById("bill-count").textContent = String(snap.billCount);
  document.getElementById("bill-word").textContent = snap.billCount === 1 ? "bill" : "bills";
  document.getElementById("total").textContent = format(snap.totalCents);
  document.title = snap.name ? `${snap.name} · Siano` : "Siano";
}

// ── Full paint ────────────────────────────────────────────────────────────────
/**
 * Repaint every dynamic region from `snap`, wiring `actions`. The pan/zoom
 * transform (on <html>) and drawer state (on <html>) are untouched, so the
 * board stays put and any open drawer stays open across a repaint.
 */
export function render(snap, actions) {
  renderTopBar(snap);

  const canvas = document.getElementById("board-canvas");
  canvas.replaceChildren(...snap.meals.map((m) => mealCard(m, snap, actions)));
  document.getElementById("board-empty").classList.toggle("hidden", snap.meals.length > 0);

  const dock = document.getElementById("dock");
  dock.replaceChildren(
    ...(snap.members.length
      ? snap.members.map((m) => travellerToken(m))
      : [el("p", { class: "dock-empty" }, "No travellers yet — add some in ⚙️ Settings.")]),
  );

  renderBills(snap, actions);
  renderMenu(snap, actions);
  renderReport(snap);

  // Autofocus a freshly-opened inline share editor.
  const focusEl = canvas.querySelector("[data-autofocus]");
  if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
}
