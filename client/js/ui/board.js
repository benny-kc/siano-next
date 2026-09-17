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
import { installState } from "./install.js";
import { debugEnabled } from "./debug.js";
import { DEBUG } from "../log.js";
import { t, activeLocale, localePref, LOCALES } from "./i18n.js";
import { registerVersion, fileVersions } from "../version.js";
registerVersion("js/ui/board.js", 16);

// ── Per-viewer UI state (the reference held some of this server-side) ─────────
export const ui = {
  billsFilter: null, // member id, or null for "all bills"
  billsSort: "created_desc", // newest bill first (bills arrive oldest-first, so reverse)
  editingShare: null, // "mealId:memberId" while a share is being typed
  ledgerMember: null, // which traveller the personal ledger is showing
  quickAddMealId: null, // meal awaiting a transient "+ add all" (set by app.js)
  iconPickerMealId: null, // meal whose icon-picker grid is open above its card
  iconPickerIcons: [], // the 25 randomly-chosen icons currently shown in that grid
  focusMealNameId: null, // meal whose name field should regain focus after a repaint
};

// ── Meal-icon picker ──────────────────────────────────────────────────────────
// A pool of travel- and meal-related emoji to offer when the user wants a more
// fitting icon for a bill. The grid shows a RANDOM 25 of these each time it opens
// (and re-shuffles on every tap of the meal's icon field), so the choices feel
// fresh rather than a fixed menu.
const ICON_POOL = [
  "🍽️", "🍕", "🍔", "🍟", "🌭", "🥪", "🌮", "🌯", "🥙", "🧆",
  "🍜", "🍝", "🍣", "🍱", "🍛", "🍲", "🥘", "🥗", "🍤", "🍗",
  "🥩", "🥞", "🧇", "🥐", "🥖", "🧀", "🍰", "🧁", "🍩", "🍪",
  "🍦", "🍧", "🍨", "☕", "🍵", "🧃", "🥤", "🍺", "🍷", "🍸",
  "🍹", "🥂", "🧉", "🚕", "🚗", "🚌", "🚆", "🚝", "✈️", "🚢",
  "⛴️", "🚁", "🏨", "⛺", "🎟️", "⛽", "🗺️", "🧳", "🏖️", "🏔️",
  "🎢", "🎡", "🛒", "🛍️", "🎁", "💊", "⚕️",
];

/** Pick `n` distinct random icons from the pool (Fisher–Yates partial shuffle). */
export function randomMealIcons(n = 25) {
  const pool = ICON_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

// The square 5×5 grid of icon choices (bare glyphs, no chrome — see app.css),
// rendered right above the meal card while its icon picker is open. Tapping a tile
// sets the meal's emoji and closes the picker (setMealEmoji clears the open state).
// Tiles preventDefault their pointerdown so the tap never blurs the meal-name field
// / dismisses the keyboard before the pick registers; the dismiss-on-outside-tap
// handler in interactions.js ignores taps inside `.icon-grid`.
function iconGrid(meal, actions) {
  return el("div", {
    class: "icon-grid", "aria-label": t("card.iconPickerLabel"),
    onpointerdown: (e) => e.preventDefault(),
  },
    ...ui.iconPickerIcons.map((icon) =>
      el("button", {
        type: "button", class: "icon-tile",
        title: t("card.useIcon"), onclick: () => actions.setMealEmoji(meal.id, icon),
      }, icon)),
  );
}

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

// Attributes that stop Chrome / Android / a password manager from popping the
// password / credit-card / address autofill bar over a plain field (the bar with
// the key / card / location icons over the keyboard). `type: "search"` is the
// load-bearing one — browsers never offer those autofills on a search field — and
// the data-* opt-outs quiet LastPass / 1Password / Dashlane. Ported from the
// reference app (its CLAUDE.md documents the same trick). Spread onto every text
// field; pair with `inputmode: "decimal"` on money fields to keep the numeric pad.
// CSS strips the search field's native clear button (`input[type="search"]` in
// app.css) so it still reads as a plain input.
const NO_AUTOFILL = {
  type: "search", autocomplete: "off", autocorrect: "off", spellcheck: "false",
  "data-lpignore": "true", "data-1p-ignore": true, "data-form-type": "other",
};

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
  const mon = d.toLocaleString(activeLocale(), { month: "short" });
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
    el("span", { class: "drag-handle drag-grip", title: t("card.gripTitle") }, "⠿"),
    el("span", { class: "drag-handle drag-emoji", title: t("card.emojiTitle") }, meal.emoji || "🍽️"),
    el("input", {
      class: "meal-name", value: meal.name, placeholder: t("card.mealNamePlaceholder"), "aria-label": t("card.mealNameAria"),
      title: t("card.mealNameTitle"), ...NO_AUTOFILL, autocapitalize: "words",
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => actions.setMealName(meal.id, e.target.value),
    }),
    el("button", { class: "meal-close", title: t("card.closeTitle"), onclick: () => actions.closeMeal(meal.id) }, "✕"),
  );

  // total row
  const badge = meal.hasCustomShares
    ? el("span", { class: "per-head" }, t("card.customBadge"))
    : meal.perHeadCents > 0
      ? el("span", { class: "per-head" }, t("card.perHead", { amount: format(meal.perHeadCents) }))
      : null;
  const total = el("div", { class: "meal-total" },
    el("span", { class: "label" }, t("card.total")),
    el("input", {
      class: "amount-input siano-amount", "aria-label": t("card.totalAria"),
      value: meal.amountCents > 0 ? format(meal.amountCents) : "", placeholder: "0.00",
      ...NO_AUTOFILL, inputmode: "decimal", dataset: { mealId: meal.id },
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => actions.setAmountStr(meal.id, e.target.value),
    }),
    badge,
  );

  // participants
  const rows = meal.participants.map((p) => {
    const key = `${meal.id}:${p.id}`;
    const payerBtn = el("button", {
      type: "button", class: "payer-btn" + (p.isPayer ? " is-payer" : ""), title: t("card.markPayer"),
      onclick: () => actions.setPayer(meal.id, p.id),
    }, p.isPayer ? "💳" : (p.initials || "?"));

    const body = ui.editingShare === key
      ? el("form", { class: "share-form", onsubmit: (e) => { e.preventDefault(); const v = e.target.elements.value.value; actions.saveShare(meal.id, p.id, v); } },
          el("input", {
            class: "share-edit", name: "value",
            value: p.locked ? format(p.shareCents) : "", placeholder: format(p.shareCents),
            ...NO_AUTOFILL, inputmode: "decimal", "data-autofocus": "1",
            onblur: (e) => actions.saveShare(meal.id, p.id, e.target.value),
          }),
        )
      : el("div", { class: "pbody", title: t("card.holdShare"), dataset: { longpress: "1", mealId: meal.id, memberId: p.id } },
          el("span", { class: "pname" }, p.name),
          el("span", { class: "pshare" }, format(p.shareCents)),
          p.locked ? el("span", { class: "pin", title: t("card.customShareTitle") }, "📌") : null,
        );

    const chip = el("div", { class: "pchip animate-pop", style: `background-color:${p.color}`, title: `${p.name} · ${format(p.shareCents)}${p.isPayer ? t("card.paidSuffix") : ""}` },
      payerBtn, body,
      el("button", { type: "button", class: "premove", title: t("card.removeFromMeal"), onclick: () => actions.toggleParticipant(meal.id, p.id, false) }, "✕"),
    );

    const diff = p.isPayer && meal.allSharesFixed
      ? el("span", { class: "diff-badge animate-pop", title: t("card.diffTitle") }, signed(meal.diffCents))
      : null;

    return el("div", { class: "participant-row" }, chip, diff);
  });

  const dropzone = el("div", { class: "dropzone" },
    meal.participants.length === 0 ? el("p", { class: "hint" }, t("card.dropHere")) : null,
    el("div", { class: "participants" }, ...rows),
  );

  const created = fmtCreatedAt(meal.createdAt);
  const foot = el("div", { class: "meal-foot" },
    created ? el("span", { class: "meal-time", title: t("card.createdTitle") }, created) : null,
    el("button", {
      type: "button", class: "delete", title: t("card.deleteTitle"), "aria-label": t("card.deleteAria", { name: meal.name }),
      dataset: { confirm: t("confirm.deleteMeal", { name: meal.name || t("card.thisBill") }), confirmAction: `deleteMeal:${meal.id}` },
    }, trashIcon()),
  );

  return el("article", {
    class: "meal-card animate-pop", style: `left:${meal.x}px; top:${meal.y}px;`,
    dataset: { mealId: meal.id, x: meal.x, y: meal.y },
  },
    ui.iconPickerMealId === meal.id ? iconGrid(meal, actions) : null,
    head, total, dropzone,
    meal.participants.length ? el("p", { class: "meal-hint" }, t("card.mealHint")) : null,
    foot,
    conflictNote(meal.conflicts),
  );
}

function conflictNote(conflicts) {
  if (!conflicts) return null;
  const bits = [];
  if (conflicts.amount) bits.push(t("card.conflictAmount", { values: conflicts.amount.map((c) => format(c.value)).join(", ") }));
  if (conflicts.shares) {
    for (const cs of Object.values(conflicts.shares)) {
      bits.push(t("card.conflictShare", { values: cs.map((c) => format(c.cents)).join(", ") }));
    }
  }
  return el("div", { class: "conflict", title: t("card.conflictTitle") }, "⚠ " + bits.join("; "));
}

// ── Transient quick-actions row (above the dock) ──────────────────────────────
// A deliberately subtle "+ add all" shortcut that app.js arms for a few seconds
// right after a meal is created by dragging one traveller onto the board. It
// pulls every remaining traveller into that fresh meal in one tap. Shown only
// while `ui.quickAddMealId` points at a still-open meal that is missing someone.
function renderQuickActions(snap, actions) {
  const host = document.getElementById("quick-actions");
  if (!host) return;
  const mealId = ui.quickAddMealId;
  const meal = mealId != null ? snap.meals.find((m) => m.id === mealId) : null;
  const missing = meal
    ? snap.members.filter((mm) => !meal.participants.some((p) => p.id === mm.id))
    : [];
  if (!meal || missing.length === 0) { host.replaceChildren(); return; }
  host.replaceChildren(
    el("button", {
      type: "button", class: "quick-add-all",
      title: t("quick.addAllTitle"),
      onclick: () => actions.quickAddAll(mealId),
    }, t("quick.addAll")),
  );
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
// Sort keys are stable; the labels are resolved through t() at render time (see
// renderSortMenu) so they follow the active language.
const SORT_OPTIONS = [
  ["bills.sort.nameAsc", "name_asc"],
  ["bills.sort.nameDesc", "name_desc"],
  ["bills.sort.createdAsc", "created_asc"],
  ["bills.sort.createdDesc", "created_desc"],
  ["bills.sort.cashAsc", "cash_asc"],
  ["bills.sort.cashDesc", "cash_desc"],
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
    ...SORT_OPTIONS.map(([labelKey, key]) =>
      el("button", {
        type: "button", class: ui.billsSort === key ? "active" : "",
        onclick: () => actions.setBillsSort(key),
      }, el("span", {}, t(labelKey)), ui.billsSort === key ? el("span", {}, "✓") : null)),
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
    kids.push(el("p", { class: "card-note" }, t("bills.empty")));
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
      t("bills.filtered", { name: name || t("bills.oneTraveller") })));
  }

  root.replaceChildren(...kids);
}

function billRow(bill, actions) {
  const people = t("bills.people", { n: bill.participantCount });
  const meta = people +
    (bill.payerName ? t("bills.paidBy", { name: bill.payerName }) : "") +
    (bill.complete ? "" : t("bills.draftSuffix"));
  return el("li", { class: "bill-row" },
    el("button", { type: "button", class: "bill-open", onclick: () => actions.openMeal(bill.id) },
      el("span", { class: "emoji" }, bill.emoji || "🍽️"),
      el("span", { class: "info" },
        el("span", { class: "bname" }, bill.name || t("common.untitled")),
        el("span", { class: "bmeta" }, meta),
      ),
      el("span", { class: "amt" },
        el("span", { class: "money" }, format(bill.amountCents)),
        el("span", { class: "state " + (bill.open ? "on" : "off") }, bill.open ? t("bills.onBoard") : t("bills.closed")),
      ),
    ),
    el("button", {
      type: "button", class: "bill-del", title: t("card.deleteTitle"), "aria-label": t("card.deleteAria", { name: bill.name }),
      dataset: { confirm: t("confirm.deleteMeal", { name: bill.name || t("card.thisBill") }), confirmAction: `deleteMeal:${bill.id}` },
    }, "🗑"),
  );
}

// ── Settings drawer contents ──────────────────────────────────────────────────
function renderMenu(snap, actions) {
  const root = document.getElementById("menu-content");
  // installSection may return null (already installed, or nothing to offer) —
  // filter it out so replaceChildren never gets a null (which the DOM would
  // stringify to the literal "null"). See the CLAUDE.md replaceChildren note.
  root.replaceChildren(
    ...[
      installSection(actions),
      travellersSection(snap, actions),
      budgetsSection(snap),
      totalSection(snap),
      settleSection(snap),
      ledgerSection(snap, actions),
      offlineSyncSection(),
      tripNameSection(snap, actions),
      tripsSection(snap, actions),
      appearanceSection(actions),
      onboardingPreviewSection(actions),
      debugSection(actions),
      helpSection(),
      disclaimerSection(),
    ].filter(Boolean),
  );
}

// Debug — a per-device switch (localStorage, see ui/debug.js). When on, it lists
// every loaded JS module's embedded version (version.js), so you can confirm
// from the device itself whether it is running the latest build or serving a
// stale cached copy of some file — each module reports its OWN number, so a
// partially-cached device shows exactly which file is stale.
//
// The whole section is GATED behind the operator flag SIANO_CLIENT_DEBUG (read
// via window.__SIANO_DEBUG__ / log.js's DEBUG): a normal user never sees it, and
// only when the operator turns the flag on server-side (+ hub restart) does the
// switch appear in Settings. Returns null otherwise (renderMenu filters it out).
function debugSection(actions) {
  if (!DEBUG) return null;
  const on = debugEnabled();
  const toggle = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, t("menu.debug.label")),
    el("button", {
      type: "button", class: "toggle", "aria-pressed": String(on),
      onclick: () => actions.toggleDebug(),
    }, on ? t("common.on") : t("common.off")),
  );

  const kids = [el("h3", {}, t("menu.debug.title")), toggle];
  if (on) {
    const list = el("ul", { class: "debug-versions" },
      ...fileVersions().map(({ file, version }) =>
        el("li", { class: "debug-ver-row" },
          el("span", { class: "debug-ver-file" }, file),
          el("span", { class: "debug-ver-num" }, `v${version}`),
        )),
    );
    // How the page itself was served — is a service worker (the offline shell
    // cache) controlling this tab? A stale cache is the usual culprit here.
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller ? t("menu.debug.serviceWorker") : t("menu.debug.network");
    kids.push(
      el("p", { class: "debug-note" }, t("menu.debug.note", { n: fileVersions().length, via: sw })),
      list,
    );
  }
  return el("section", {}, ...kids);
}

// The iOS "Share" glyph as inline SVG (SF Symbols don't render in web content).
const IOS_SHARE_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3v11"/><path d="M8.5 6.5 12 3l3.5 3.5"/>' +
  '<path d="M7 10H5.5A1.5 1.5 0 0 0 4 11.5V19A1.5 1.5 0 0 0 5.5 20.5h13A1.5 1.5 0 0 0 20 19v-7.5A1.5 1.5 0 0 0 18.5 10H17"/>' +
  '</svg>';

// Install prompt at the very top of the drawer. Hidden when we're already an
// installed app; a real "Install" button on Android/Chromium (replays the
// captured beforeinstallprompt); manual Add-to-Home-Screen steps on iOS Safari
// (which has no prompt API). See ui/install.js for the detection.
function installSection(actions) {
  const state = installState();
  if (state === "standalone" || state === "none") return null;

  if (state === "ios") {
    return el("section", { class: "install-card" },
      el("h3", {}, t("menu.install.title")),
      el("p", { class: "install-note" },
        t("menu.install.iosLead"),
      ),
      el("ol", { class: "install-steps" },
        el("li", {}, t("menu.install.iosStep1Pre"), el("strong", {}, t("menu.install.share")), t("menu.install.iosStep1Mid"),
          el("span", { class: "ios-share", "aria-hidden": "true", html: IOS_SHARE_SVG }), t("menu.install.iosStep1Post")),
        el("li", {}, t("menu.install.iosStep2Pre"), el("strong", {}, t("menu.install.addToHome")), t("menu.install.iosStep2Post")),
        el("li", {}, t("menu.install.iosStep3Pre"), el("strong", {}, t("menu.install.add")), t("menu.install.iosStep3Post")),
      ),
    );
  }

  // "installable" — Chromium (Android / desktop) handed us a prompt to replay.
  return el("section", { class: "install-card" },
    el("h3", {}, t("menu.install.title")),
    el("p", { class: "install-note" },
      t("menu.install.androidNote"),
    ),
    el("button", { type: "button", class: "btn-block install-btn", onclick: () => actions.installApp() },
      t("menu.install.androidBtn")),
  );
}

// Appearance — per-device typography (font, size, boldness). Client-only,
// applied live via CSS vars on <html> (see ui/typography.js); nothing synced.
function appearanceSection(actions) {
  const tp = getTypography();
  const pct = Math.round(tp.scale * 100);

  const theme = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, t("menu.appearance.theme")),
    el("div", { class: "seg" },
      el("button", { type: "button", class: "seg-btn" + (tp.theme !== "light" ? " active" : ""), "aria-pressed": String(tp.theme !== "light"), onclick: () => actions.setTheme("dark") }, t("menu.appearance.dark")),
      el("button", { type: "button", class: "seg-btn" + (tp.theme === "light" ? " active" : ""), "aria-pressed": String(tp.theme === "light"), onclick: () => actions.setTheme("light") }, t("menu.appearance.light")),
    ),
  );

  const size = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, t("menu.appearance.textSize")),
    el("div", { class: "size-ctl" },
      el("button", { type: "button", class: "size-btn", title: t("menu.appearance.smaller"), "aria-label": t("menu.appearance.smallerAria"), disabled: tp.scale <= SCALE_MIN + 1e-9, onclick: () => actions.stepTextSize(-1) }, el("span", { class: "sm" }, "A")),
      el("span", { class: "size-val" }, `${pct}%`),
      el("button", { type: "button", class: "size-btn", title: t("menu.appearance.larger"), "aria-label": t("menu.appearance.largerAria"), disabled: tp.scale >= SCALE_MAX - 1e-9, onclick: () => actions.stepTextSize(1) }, el("span", { class: "lg" }, "A")),
    ),
  );

  const weight = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, t("menu.appearance.weight")),
    el("div", { class: "size-ctl" },
      el("button", { type: "button", class: "size-btn", title: t("menu.appearance.lighter"), "aria-label": t("menu.appearance.lighterAria"), disabled: tp.weight <= WEIGHT_MIN, onclick: () => actions.stepWeight(-1) }, el("span", { class: "sm", style: "font-weight:400" }, "B")),
      el("span", { class: "size-val" }, String(400 + tp.weight)),
      el("button", { type: "button", class: "size-btn", title: t("menu.appearance.bolder"), "aria-label": t("menu.appearance.bolderAria"), disabled: tp.weight >= WEIGHT_MAX, onclick: () => actions.stepWeight(1) }, el("span", { class: "lg", style: "font-weight:900" }, "B")),
    ),
  );

  // Language — per-device, follows the browser by default ("auto"). The picker
  // lists the languages we ship by their own name (endonym); missing strings in
  // a partly-translated language fall back to English (see js/i18n/*).
  const langSel = el("select", { class: "budget-select", "aria-label": t("menu.appearance.languageAria"), onchange: (e) => actions.setLocale(e.target.value) },
    el("option", { value: "auto", selected: localePref() === "auto" }, t("menu.appearance.languageAuto")),
    ...LOCALES.map((l) => el("option", { value: l.code, selected: localePref() === l.code }, l.endonym)),
  );
  const language = el("div", { class: "appear-row" },
    el("span", { class: "lbl" }, t("menu.appearance.language")),
    langSel,
  );

  // The full-screen toggle only makes sense in a browser tab (it re-enters the
  // Fullscreen API on gestures to hide the browser chrome). An installed PWA is
  // already chrome-free (standalone) and has no browser bars to escape, so the
  // toggle is a no-op there — hide the row entirely when running as an app.
  const fs = fullscreenPreferred();
  const fullscreen = installState() === "standalone"
    ? null
    : el("div", { class: "appear-row" },
        el("span", { class: "lbl" }, t("menu.appearance.fullscreen")),
        el("button", { type: "button", class: "toggle", "aria-pressed": String(fs), onclick: () => actions.toggleFullscreen() }, fs ? t("common.on") : t("common.off")),
      );

  const fonts = el("div", { class: "font-pills" },
    ...FONTS.map((f) =>
      el("button", {
        type: "button", class: "pill" + (f.id === tp.family ? " active" : ""),
        style: `font-family:${f.stack}`, "aria-pressed": String(f.id === tp.family),
        onclick: () => actions.setFont(f.id),
      }, f.label)),
  );

  return el("section", {},
    el("h3", {}, t("menu.appearance.title")),
    theme, size, weight, language, fullscreen, fonts,
    el("button", { type: "button", class: "btn-block", onclick: () => actions.resetAppearance() }, t("menu.appearance.reset")),
  );
}

function travellersSection(snap, actions) {
  const items = snap.members.map((m) => {
    const select = el("select", { class: "budget-select", onchange: (e) => actions.setMemberBudget(m.id, e.target.value) },
      el("option", { value: m.id, selected: m.budgetSolo }, t("menu.travellers.solo")),
      ...snap.members.filter((o) => o.id !== m.id).map((o) =>
        el("option", { value: o.id, selected: !m.budgetSolo && o.id === m.budgetPartnerId }, t("menu.travellers.sharedWith", { name: o.name }))),
    );
    return el("li", { class: "member-item" },
      el("div", { class: "member-top" },
        el("span", { class: "mini-avatar", style: `background-color:${m.color}` }, m.initials || "?"),
        el("input", { class: "member-name-input", value: m.name, "aria-label": t("menu.travellers.nameAria"), ...NO_AUTOFILL, autocapitalize: "words", onchange: (e) => actions.setMemberName(m.id, e.target.value) }),
        el("button", {
          type: "button", class: "x-btn", title: t("menu.travellers.remove"),
          dataset: { confirm: t("confirm.removeMember", { name: m.name }), confirmAction: `removeMember:${m.id}` },
        }, "✕"),
      ),
      el("div", { class: "budget-row" }, el("span", { class: "lbl" }, t("menu.travellers.budget")), select),
      m.budgetSolo ? null : el("p", { class: "budget-note" }, t("menu.travellers.sharedBudget", { name: m.budgetName })),
    );
  });

  const addForm = el("form", { class: "add-row", onsubmit: (e) => { e.preventDefault(); const inp = e.target.elements.name; actions.addMember(inp.value); inp.value = ""; } },
    // id lets the empty-dock hint (actions.hintAddTraveller) find this field to
    // blink it as a first-run "start here" cue.
    el("input", { id: "add-traveller-input", class: "text-input", name: "name", placeholder: t("menu.travellers.addPlaceholder"), ...NO_AUTOFILL, autocapitalize: "words" }),
    el("button", { class: "btn" }, t("menu.travellers.add")),
  );

  return el("section", {},
    el("h3", {}, t("menu.travellers.title")),
    el("ul", { class: "member-list" }, ...items),
    addForm,
  );
}

function budgetsSection(snap) {
  return el("section", {},
    el("h3", {}, t("menu.budgets.title"), el("span", { class: "muted" }, t("menu.budgets.subtitle"))),
    el("ul", { class: "plain-list" },
      ...snap.budgets.map((b) =>
        el("li", { class: "budget-item" },
          el("span", {}, b.size > 1 ? "👥" : "🙂"),
          el("span", { class: "col" },
            el("span", { class: "bn" }, b.name || "—"),
            el("span", { class: "muted-note " + toneClass(b.balanceCents) },
              b.balanceCents > 0 ? t("balance.isOwed", { amount: format(b.balanceCents) }) : b.balanceCents < 0 ? t("balance.owes", { amount: format(-b.balanceCents) }) : t("balance.settled")),
          ),
        )),
    ),
  );
}

function totalSection(snap) {
  const sub = t("menu.total.travellers", { n: snap.memberCount }) + (snap.budgetCount < snap.memberCount ? t("menu.total.budgets", { n: snap.budgetCount }) : "");
  return el("section", {},
    el("div", { class: "total-card" },
      el("p", { class: "lbl" }, t("menu.total.label")),
      el("p", { class: "big" }, format(snap.totalCents)),
      el("p", { class: "sub" }, sub),
    ),
  );
}

function settleSection(snap) {
  return el("section", {},
    el("h3", {}, t("menu.settle.title")),
    snap.settlements.length === 0
      ? el("p", { class: "card-note" }, t("menu.settle.even"))
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
      el("p", {}, t("menu.ledger.hi"), el("span", { style: `color:${me.color};font-weight:700` }, me.name), t("menu.ledger.wave")),
      me.budgetName !== me.name ? el("p", { class: "muted-note" }, t("menu.ledger.budget", { name: me.budgetName })) : null,
      el("p", { class: "big " + toneClass(me.balanceCents) },
        me.balanceCents > 0 ? t("menu.ledger.youAreOwed", { amount: format(me.balanceCents) }) : me.balanceCents < 0 ? t("menu.ledger.youOwe", { amount: format(-me.balanceCents) }) : t("menu.ledger.youSettled")),
      el("ul", {},
        ...pays.map((s) => el("li", { class: "pay" }, el("span", {}, t("menu.ledger.pay", { name: s.to })), el("span", { class: "font-mono" }, format(s.amountCents)))),
        ...collects.map((s) => el("li", { class: "collect" }, el("span", {}, t("menu.ledger.collect", { name: s.from })), el("span", { class: "font-mono" }, format(s.amountCents)))),
      ),
    );
  } else {
    block = el("p", { class: "muted-note" }, t("menu.ledger.pickPrompt"));
  }

  return el("section", {}, el("h3", {}, t("menu.ledger.title")), picks, block);
}

// Offline sync — the QR-stream / offline sync entry point. Opens the
// #offline-sync-modal overlay (send on top / receive below); the actual QR
// stream + transfer logic lands in a follow-up, so the modal's buttons are
// inert placeholders for now. Opened purely by the delegated
// data-siano-offlinesync-open handler (interactions.js), like the help overlay.
function offlineSyncSection() {
  return el("section", {},
    el("h3", {}, t("menu.osync.title")),
    el("button", { type: "button", class: "btn-block", "data-siano-offlinesync-open": "" }, t("menu.osync.button")),
  );
}

function tripNameSection(snap, actions) {
  return el("section", {},
    el("h3", {}, t("menu.trip.title")),
    el("input", {
      class: "text-input text-input--full", value: snap.name, placeholder: t("menu.trip.placeholder"), "aria-label": t("menu.trip.aria"), ...NO_AUTOFILL, autocapitalize: "words",
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => actions.setTripName(e.target.value),
    }),
    el("p", { class: "trip-id-note" }, t("menu.trip.idLabel"), el("span", { class: "mono" }, snap.id)),
    el("div", { class: "qr-share" },
      el("div", { class: "qr-box", html: qrSvg(tripUrl(snap.id)), "aria-label": t("menu.trip.qrAria") }),
      el("span", { class: "muted-note" }, t("menu.trip.qrNote")),
    ),
    el("div", { class: "admin", style: "margin-top:0.75rem" },
      el("button", { type: "button", class: "btn-block", onclick: () => actions.share() }, t("menu.trip.copyLink")),
      el("button", { type: "button", class: "btn-block", onclick: () => actions.newTrip() }, t("menu.trip.newTrip")),
    ),
  );
}

// "Your trips" — the device-local list (localStorage), so this viewer can switch
// between the trips they've opened. Every trip visited is remembered
// automatically; the current one is flagged and can't remove itself.
function tripsSection(snap, actions) {
  const trips = loadTrips();
  const list = trips.length === 0
    ? el("p", { class: "muted-note" }, t("menu.trips.empty"))
    : el("ul", { class: "trip-list" },
        ...trips.map((trip) => {
          const isCurrent = trip.id === snap.id;
          const name = trip.name || t("common.untitledTrip");
          return el("li", { class: "trip-item" },
            el("button", {
              type: "button", class: "trip-open", disabled: isCurrent,
              onclick: () => actions.openTrip(trip.id),
            },
              el("span", { class: "nm" + (isCurrent ? " current" : "") }, name),
              el("span", { class: "sub" }, trip.id.slice(0, 8) + (isCurrent ? t("menu.trips.current") : "")),
            ),
            el("button", {
              type: "button", class: "trip-icon-btn", title: t("menu.trips.copyLink"), "aria-label": t("menu.trips.copyLink"),
              onclick: () => actions.shareTripLink(trip.id),
            }, "🔗"),
            isCurrent
              ? el("span", { class: "trip-icon-btn", "aria-hidden": "true" })
              : el("button", {
                  type: "button", class: "trip-icon-btn remove", title: t("menu.trips.removeDevice"), "aria-label": t("menu.trips.removeDevice"),
                  dataset: { confirm: t("confirm.removeTrip", { name }), confirmAction: `removeTrip:${trip.id}` },
                }, "✕"),
          );
        }));

  return el("section", {}, el("h3", {}, t("menu.trips.title")), list);
}

function helpSection() {
  return el("section", {},
    el("button", { type: "button", class: "btn-block", "data-siano-help-open": "" }, t("menu.help.button")),
  );
}

// TEMPORARY (dev aid): a button to replay the first-run welcome/onboarding
// overlay without wiping the device's data, so the onboarding screen can be
// reviewed on demand. Tapping it toasts, then force-shows the overlay ~5s later
// (see app.js actions.previewOnboarding). Remove this section, its action, and
// the "app.toast.onboardingSoon" string once onboarding/tutorial work lands.
function onboardingPreviewSection(actions) {
  return el("section", { class: "onboard-preview-section" },
    el("h3", {}, "Onboarding (dev)"),
    el("p", { class: "muted-note" }, "Temporary — replay the first-run welcome screen (shows ~5s after tapping)."),
    el("button", { type: "button", class: "btn-block", onclick: () => actions.previewOnboarding() },
      "Preview welcome screen"),
  );
}

function disclaimerSection() {
  return el("div", { class: "disclaimer" },
    el("p", { class: "hd" }, t("menu.disclaimer.title")),
    el("p", {}, t("menu.disclaimer.body")),
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
    root.replaceChildren(el("p", { class: "card-note" }, t("report.empty")));
    return;
  }

  const tot = (id, key) => rep.memberTotals[id]?.[key] || 0;
  const netTotal = rep.grandTotalCents - rep.consumedTotalCents;

  // Header: Bill · Payer · Total · <each traveller> · Diff
  // A factory, not a single node — a DOM element can only live in one place, and
  // we repeat the header inside the body every REPEAT_HEADER_EVERY rows so the
  // column labels stay in sight when a long trip's table is scrolled.
  const makeHead = () => el("tr", { class: "matrix-head" },
    el("th", { class: "name" }, t("report.col.bill")),
    el("th", { class: "left" }, t("report.col.payer")),
    el("th", {}, t("report.col.total")),
    ...cols.map((m) => el("th", {}, el("span", { style: `color:${m.color || "var(--slate-300)"}` }, m.name))),
    el("th", { class: "muted" }, t("report.col.diff")),
  );

  const REPEAT_HEADER_EVERY = 20;
  const body = [];
  rep.bills.forEach((b, i) => {
    // Re-emit the header row every REPEAT_HEADER_EVERY bills (never before the
    // first row — that's the thead's job).
    if (i > 0 && i % REPEAT_HEADER_EVERY === 0) body.push(makeHead());
    body.push(el("tr", { class: b.complete ? "" : "draft" },
      el("th", { class: "name" }, `${b.emoji || "🍽️"} ${b.name || t("common.untitled")}`,
        b.complete ? null : el("span", { class: "draft-tag" }, t("report.draftTag"))),
      el("td", { class: "left" }, b.payerName || "—"),
      el("td", { class: "amt" }, format(b.amountCents)),
      ...cols.map((m) =>
        Object.prototype.hasOwnProperty.call(b.shares, m.id)
          ? el("td", {}, format(b.shares[m.id]))
          : el("td", {}, reportDash())),
      el("td", { class: b.diffCents === 0 ? "muted" : "neg" }, b.diffCents === 0 ? "—" : format(b.diffCents)),
    ));
  });

  const foot = el("tfoot", {},
    el("tr", { class: "sum" },
      el("th", { class: "name" }, t("report.consumed")),
      el("td", {}, ""),
      el("td", { class: "amt" }, format(rep.consumedTotalCents)),
      ...cols.map((m) => el("td", {}, format(tot(m.id, "shareCents")))),
      el("td", {}, ""),
    ),
    el("tr", { class: "sum" },
      el("th", { class: "name" }, t("report.paid")),
      el("td", {}, ""),
      el("td", { class: "amt" }, format(rep.grandTotalCents)),
      ...cols.map((m) => el("td", {}, format(tot(m.id, "paidCents")))),
      el("td", {}, ""),
    ),
    el("tr", { class: "sum net" },
      el("th", { class: "name" }, t("report.net")),
      el("td", {}, ""),
      el("td", { class: "amt " + toneClass(netTotal) }, signed(netTotal)),
      ...cols.map((m) => el("td", { class: toneClass(tot(m.id, "netCents")) }, signed(tot(m.id, "netCents")))),
      el("td", {}, ""),
    ),
  );

  const table = el("table", { class: "report matrix" },
    el("thead", {}, makeHead()), el("tbody", {}, ...body), foot);

  // The sticky Bill column stays full-width at rest (so a long title reads),
  // but once the table is scrolled sideways a CSS mask fades its right edge to
  // transparent so the traveller columns sliding underneath show through
  // instead of hiding behind a wide title. Toggle a class the moment the
  // horizontal scroll leaves the origin (see .report-scroll.scrolled in
  // app.css); scroll events don't bubble, so this is wired per-render.
  const kids = [
    el("h3", {}, t("report.matrixTitle")),
    el("div", {
      class: "report-scroll",
      onscroll: (e) => e.currentTarget.classList.toggle("scrolled", e.currentTarget.scrollLeft > 0),
    }, table),
  ];
  if (rep.draftCount > 0) {
    kids.push(el("p", { class: "muted-note", style: "margin-top:0.5rem" },
      t("report.draftNote", { n: rep.draftCount })));
  }

  if (snap.budgets.length) {
    kids.push(el("h3", { style: "margin-top:1.5rem" }, t("report.balancesTitle")));
    kids.push(el("ul", { class: "plain-list" },
      ...snap.budgets.map((b) =>
        el("li", { class: "settle-item" },
          el("span", { class: "from", style: "color:var(--slate-200)" }, b.name || "—"),
          el("span", { class: "money " + toneClass(b.balanceCents) },
            b.balanceCents > 0 ? t("balance.isOwed", { amount: format(b.balanceCents) }) : b.balanceCents < 0 ? t("balance.owes", { amount: format(-b.balanceCents) }) : t("balance.settled")),
        ))));
  }

  kids.push(el("h3", { style: "margin-top:1.5rem" }, t("report.settlementsTitle")));
  if (snap.settlements.length === 0) {
    kids.push(el("p", { class: "card-note", style: "color:var(--emerald-400)" }, t("report.allSettled")));
  } else {
    kids.push(el("ul", { class: "plain-list" },
      ...snap.settlements.map((s) =>
        el("li", { class: "settle-item" },
          el("span", { class: "from" }, s.from), el("span", { class: "arrow" }, t("report.pays")), el("span", { class: "to" }, s.to),
          el("span", { class: "money" }, format(s.amountCents)),
        ))));
  }

  kids.push(el("p", { class: "muted-note", style: "margin-top:1rem;border-top:1px solid var(--slate-800);padding-top:0.75rem" },
    t("report.footer")));

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

// iOS (incl. iPadOS 13+, which reports as a Mac with a touch screen). Kept local
// so board.js has no import dependency just for a UA sniff.
function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
}

export async function downloadReportCsv(snap) {
  const rep = snap.report;
  const cols = rep.members;
  const names = cols.map((m) => m.name);
  const tot = (id, key) => rep.memberTotals[id]?.[key] || 0;
  const completeCount = rep.bills.length - rep.draftCount;
  const now = new Date();
  const netTotal = rep.grandTotalCents - rep.consumedTotalCents;

  const rows = [];

  // 1. Trip meta.
  rows.push([t("report.csv.title")]);
  rows.push([t("report.csv.trip"), snap.name || ""]);
  rows.push([t("report.csv.tripId"), snap.id]);
  rows.push([t("report.csv.generated", { tz: tzLabel() }), now.toLocaleString(activeLocale())]);
  rows.push([t("report.csv.total"), money2(rep.grandTotalCents)]);
  rows.push([t("report.csv.bills"), String(completeCount)]);
  rows.push([t("report.csv.drafts"), String(rep.draftCount)]);
  rows.push([t("report.csv.travellers"), String(cols.length)]);
  rows.push([]);

  // 2. Bills × travellers share matrix + summary rows.
  rows.push([t("report.csv.matrixTitle")]);
  rows.push([t("report.csv.colBill"), t("report.csv.colPayer"), t("report.csv.colStatus"), t("report.csv.colTotal"), ...names, t("report.csv.colAssigned"), t("report.csv.colUnassigned")]);
  for (const b of rep.bills) {
    const assigned = b.amountCents - b.diffCents; // = sum of shares
    rows.push([
      (b.emoji ? b.emoji + " " : "") + (b.name || t("common.untitled")),
      b.payerName || "",
      b.complete ? t("report.csv.statusComplete") : t("report.csv.statusDraft"),
      money2(b.amountCents),
      ...cols.map((m) => (Object.prototype.hasOwnProperty.call(b.shares, m.id) ? money2(b.shares[m.id]) : "")),
      money2(assigned),
      money2(b.diffCents),
    ]);
  }
  rows.push([t("report.csv.rowConsumed"), "", "", money2(rep.consumedTotalCents), ...cols.map((m) => money2(tot(m.id, "shareCents"))), "", ""]);
  rows.push([t("report.csv.rowPaid"), "", "", money2(rep.grandTotalCents), ...cols.map((m) => money2(tot(m.id, "paidCents"))), "", ""]);
  rows.push([t("report.csv.rowNet"), "", "", money2(netTotal), ...cols.map((m) => money2(tot(m.id, "netCents"))), "", ""]);
  rows.push([]);

  // 3. Per-budget balances.
  rows.push([t("report.csv.balancesTitle")]);
  rows.push([t("report.csv.colBudget"), t("report.csv.colMembers"), t("report.csv.rowPaid"), t("report.csv.colConsumed"), t("report.csv.colBalance"), t("report.csv.colDirection")]);
  for (const b of snap.budgets) {
    const paid = b.memberIds.reduce((s, id) => s + tot(id, "paidCents"), 0);
    const consumed = b.memberIds.reduce((s, id) => s + tot(id, "shareCents"), 0);
    const dir = b.balanceCents > 0 ? t("report.csv.dirOwed") : b.balanceCents < 0 ? t("report.csv.dirOwes") : t("report.csv.dirSettled");
    rows.push([b.name, b.memberNames.join(", "), money2(paid), money2(consumed), money2(b.balanceCents), dir]);
  }
  rows.push([]);

  // 4. Suggested settlements.
  rows.push([t("report.csv.settlementsTitle")]);
  if (snap.settlements.length === 0) {
    rows.push([t("report.csv.allSettled")]);
  } else {
    rows.push([t("report.csv.colFrom"), t("report.csv.colTo"), t("report.csv.colAmount")]);
    for (const s of snap.settlements) rows.push([s.from, s.to, money2(s.amountCents)]);
  }

  const blob = new Blob(["﻿" + encodeCsv(rows)], { type: "text/csv;charset=utf-8" });
  const slug = (snap.name || "siano-trip").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "siano-trip";
  const filename = `${slug}-siano-report-${localStamp(now)}.csv`;

  // iOS Safari ignores the `<a download>` attribute for blob URLs — instead of
  // saving the file it navigates the tab to the blob (and in an installed PWA
  // that drops the user out of the app). So on iOS route the CSV through the
  // Web Share API (iOS 15+), which lets them save it to Files / send it on.
  // Everywhere else (Android, desktop) keep the plain download that works.
  if (isIOS() && typeof navigator.canShare === "function") {
    let file = null;
    try { file = new File([blob], filename, { type: "text/csv" }); } catch { /* no File ctor */ }
    if (file && navigator.canShare({ files: [file] })) {
      // File sharing is supported: commit to it. A cancel (AbortError) is a
      // deliberate user choice, not a failure — swallow it and return either
      // way, rather than falling through to the download that iOS mishandles.
      try { await navigator.share({ files: [file], title: filename }); } catch { /* cancelled */ }
      return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Top bar + focus restore ────────────────────────────────────────────────────
function renderTopBar(snap) {
  document.getElementById("trip-chip").textContent = snap.name || t("common.untitledTrip");
  document.getElementById("bill-count").textContent = String(snap.billCount);
  document.getElementById("bill-word").textContent = t("topbar.billWord", { n: snap.billCount });
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
  const boardEmpty = document.getElementById("board-empty");
  boardEmpty.classList.toggle("hidden", snap.meals.length > 0);
  // The "Drag a traveller up here" phrase only shimmers once the trip has at
  // least one traveller to drag — before that the prompt stays calm and the
  // bottom dock hint shimmers instead (see .board-empty.has-travellers .shine).
  boardEmpty.classList.toggle("has-travellers", snap.members.length > 0);

  const dock = document.getElementById("dock");
  dock.replaceChildren(
    ...(snap.members.length
      ? snap.members.map((m) => travellerToken(m))
      // Empty dock (a fresh trip with nobody added yet): make the whole
      // placeholder a tap target that opens Settings and blinks the "Add
      // traveller" field — a first-run hint that shows a newcomer where to start.
      : [el("button", {
          type: "button", class: "dock-empty",
          onclick: () => actions.hintAddTraveller(),
        }, t("board.dockEmpty"))]),
  );

  renderQuickActions(snap, actions);
  renderBills(snap, actions);
  renderMenu(snap, actions);
  renderReport(snap);

  // Autofocus a freshly-opened inline share editor.
  const focusEl = canvas.querySelector("[data-autofocus]");
  if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }

  // Restore focus to a meal name field that was being edited when the icon picker
  // opened or an icon was picked (a repaint replaces the input node, so its focus
  // is otherwise lost). Caret to the end rather than select-all — the user is
  // typing a name, not replacing it. One-shot: cleared once applied.
  if (ui.focusMealNameId != null) {
    const card = canvas.querySelector(`[data-meal-id="${CSS.escape(ui.focusMealNameId)}"]`);
    const nameEl = card && card.querySelector(".meal-name");
    ui.focusMealNameId = null;
    if (nameEl && document.activeElement !== nameEl) {
      nameEl.focus();
      const n = nameEl.value.length;
      try { nameEl.setSelectionRange(n, n); } catch { /* not all inputs support it */ }
    }
  }
}
