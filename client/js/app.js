// App entry point — wires the op-log store, the sync client, the board UI and
// all the pointer gestures together. No framework, no build step: loaded as an
// ES module straight from index.html.
//
// The data loop is one-directional:
//   user action -> log.emit(op) -> (persist + broadcast) -> log change ->
//   re-fold -> buildSnapshot -> render. Incoming synced ops enter the same path,
//   so remote and local edits render identically.
//
// The UI layer is a faithful port of the reference app's game-like board
// (github.com/benny-kc/siano): a pannable/zoomable board of meal cards, a dock
// of draggable traveller tokens, drag-to-split, and slide-in drawers. See
// ui/board.js (renderer), ui/interactions.js (gestures), ui/boardview.js
// (pan/zoom) and ui/viewstate.js (drawer state).

import { openTripStore } from "./store/oplog.js";
import { lastTripId, rememberTrip, forgetTrip } from "./store/trips.js";
import { SyncClient } from "./sync/client.js";
import * as ops from "./core/ops.js";
import { parse } from "./core/money.js";
import { render, ui, downloadReportCsv } from "./ui/board.js";
import { BoardView } from "./ui/boardview.js";
import { installViewState, View } from "./ui/viewstate.js";
import { initInteractions } from "./ui/interactions.js";
import { applyTypography, setFont, stepScale, stepWeight, setTheme, resetTypography, SCALE_STEP, WEIGHT_STEP } from "./ui/typography.js";
import { installFullscreen, fullscreenPreferred, setFullscreenPreferred } from "./ui/fullscreen.js";
import { dlog, derror } from "./log.js";

const PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const EMOJIS = ["🍽️", "🍕", "🍔", "🍜", "🍣", "🥘", "🍰", "🍺", "🍷", "☕", "🛒", "🚕", "🏨", "🎟️", "⛽", "🍦"];
const uid = (p) =>
  (globalThis.crypto?.randomUUID ? crypto.randomUUID() : p + Math.random().toString(36).slice(2, 10));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Trip id lives in the URL as /t/<id>; mint one if absent so a fresh visit is a
// shareable trip immediately.
function currentTripId() {
  const m = location.pathname.match(/^\/t\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  // No trip in the URL (a bare visit to "/"): resume the last trip seen on this
  // device, or mint a fresh one if there is none yet.
  const id = lastTripId() || uid("trip-");
  history.replaceState(null, "", `/t/${id}`);
  return id;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

function toast(message) {
  let node = document.querySelector(".siano-toast");
  if (!node) { node = document.createElement("div"); node.className = "siano-toast"; document.body.appendChild(node); }
  node.textContent = message;
  requestAnimationFrame(() => node.classList.add("is-visible"));
  clearTimeout(node._t);
  node._t = setTimeout(() => node.classList.remove("is-visible"), 2200);
}

async function main() {
  const tripId = currentTripId();
  dlog("boot: trip", tripId, "at", location.href);
  const log = await openTripStore(tripId);
  dlog(`boot: store opened — ${log.allOps().length} ops on device`, "device", log.device);

  const netEl = document.getElementById("net");
  const surface = document.getElementById("board-surface");

  installViewState();
  applyTypography(); // restore this device's font/size/boldness before first paint
  installFullscreen(); // honour the per-device "always full-screen" preference

  let interactions; // set after init (below); openMeal needs its panToMeal

  // The centre of the currently-visible board, in canvas coordinates — where a
  // new card should appear so it lands on screen at any pan/zoom.
  function viewCenter() {
    const s = BoardView.scale;
    return {
      x: (surface.clientWidth / 2 - BoardView.panX) / s,
      y: (surface.clientHeight / 2 - BoardView.panY) / s,
    };
  }
  function newMealPos() {
    const c = viewCenter();
    const jitter = () => Math.round((Math.random() - 0.5) * 60);
    return { x: Math.round(c.x - 160) + jitter(), y: Math.round(c.y - 60) + jitter() };
  }

  // Add a traveller to a meal, defaulting the payer to the FIRST person added so
  // a meal is never left without someone who paid (matches the reference:
  // payer_id || first participant). Tapping another avatar still moves the payer.
  function addPerson(mealId, memberId) {
    const meal = log.snapshot().meals.find((m) => m.id === mealId);
    log.emit((c) => ops.addParticipant(c, mealId, memberId));
    if (meal && meal.payerId == null) {
      const firstParticipant = meal.participantIds[0] ?? memberId;
      log.emit((c) => ops.setPayer(c, mealId, firstParticipant));
    }
  }

  // Remove a traveller from a meal; if they were the payer, hand the payer role
  // to whoever remains (nil only when the meal is now empty).
  function removePerson(mealId, memberId) {
    const meal = log.snapshot().meals.find((m) => m.id === mealId);
    log.emit((c) => ops.removeParticipant(c, mealId, memberId));
    if (meal && meal.payerId === memberId) {
      const next = meal.participantIds.find((id) => id !== memberId) ?? null;
      log.emit((c) => ops.setPayer(c, mealId, next));
    }
  }

  const actions = {
    setTripName: (name) => log.emit((c) => ops.setTripName(c, name)),

    addMember: (name) => {
      const n = log.snapshot().members.length;
      const nm = (name && name.trim()) || `Traveller ${n + 1}`;
      const id = uid("m-");
      log.emit((c) => ops.addMember(c, id, { name: nm, color: PALETTE[n % PALETTE.length], initials: initials(nm) }));
    },
    setMemberName: (id, name) => log.emit((c) => ops.setMemberName(c, id, name)),
    removeMember: (id) => log.emit((c) => ops.removeMember(c, id)),
    // The budget select points at own id (solo) or a partner's id (pool).
    setMemberBudget: (id, target) => log.emit((c) => ops.setMemberBudget(c, id, target)),

    addMeal: () => {
      const { x, y } = newMealPos();
      log.emit((c) => ops.addMeal(c, uid("meal-"), { name: "", emoji: pick(EMOJIS), x, y, open: true }));
    },
    setMealName: (id, name) => log.emit((c) => ops.setMealName(c, id, name)),
    removeMeal: (id) => log.emit((c) => ops.removeMeal(c, id)),
    closeMeal: (id) => log.emit((c) => ops.setOpen(c, id, false)),
    openMeal: (id) => {
      log.emit((c) => ops.setOpen(c, id, true));
      // Tapping a bill in the drawer puts its card on the board: get out of the
      // way (close the Bills drawer) and pan the board to the card the user
      // pointed at. panToMeal measures on the next frame, and the drawer is a
      // fixed overlay that doesn't shift board layout, so closing it here is safe.
      View.closeDrawer();
      if (interactions) interactions.panToMeal(id);
    },
    setAmountStr: (id, str) => {
      const r = parse(str);
      if (r.ok) log.emit((c) => ops.setAmount(c, id, r.cents));
      else if (str.trim() === "") log.emit((c) => ops.setAmount(c, id, 0));
    },
    setPayer: (id, payerId) => log.emit((c) => ops.setPayer(c, id, payerId)),
    toggleParticipant: (mealId, memberId, add) =>
      add ? addPerson(mealId, memberId) : removePerson(mealId, memberId),

    // Inline "exact share" editor: blank clears the lock (back to auto split).
    saveShare: (mealId, memberId, str) => {
      const key = `${mealId}:${memberId}`;
      if (ui.editingShare !== key) return; // already saved (blur + submit both fire)
      ui.editingShare = null;
      const s = String(str ?? "").trim();
      if (s === "") log.emit((c) => ops.setShare(c, mealId, memberId, 0, false));
      else { const r = parse(s); if (r.ok) log.emit((c) => ops.setShare(c, mealId, memberId, r.cents, true)); }
      schedulePaint();
    },

    moveMeal: (id, x, y) => log.emit((c) => ops.moveMeal(c, id, x, y)),
    dropOnMeal: (mealId, memberId) => addPerson(mealId, memberId),
    dropOnBoard: (memberId, x, y) => {
      // Create the meal, then add the traveller — who becomes its payer (the
      // meal's first participant). Each op advances the clock, so the participant
      // + payer ops causally follow the add.
      const id = uid("meal-");
      log.emit((c) => ops.addMeal(c, id, { name: "", emoji: pick(EMOJIS), x, y, open: true }));
      addPerson(id, memberId);
      // Offer a brief "+ add all" so the creator can pull the whole group into
      // this fresh meal in one tap. Only worth it when others exist to add.
      if (log.snapshot().members.length > 1) armQuickAddAll(id);
    },

    // The transient "+ add all" shortcut: add every remaining traveller to the
    // just-created meal, then dismiss the shortcut. (Existing participants and
    // the payer are left untouched — addPerson only sets a payer when none yet.)
    quickAddAll: (mealId) => {
      const snap = log.snapshot();
      const meal = snap.meals.find((m) => m.id === mealId);
      if (meal) {
        const have = new Set(meal.participantIds);
        for (const m of snap.members) if (!have.has(m.id)) addPerson(mealId, m.id);
      }
      disarmQuickAddAll();
    },

    // Bills-drawer per-viewer UI state (toggle off when tapping the active one).
    filterBills: (id) => { ui.billsFilter = ui.billsFilter === id ? null : id; schedulePaint(); },
    setBillsSort: (key) => { ui.billsSort = key; schedulePaint(); },
    pickLedger: (id) => { ui.ledgerMember = ui.ledgerMember === id ? null : id; schedulePaint(); },

    share: async () => {
      try { await navigator.clipboard.writeText(location.href); toast("Trip link copied — share it to invite others"); }
      catch { toast(location.href); }
    },
    newTrip: () => { location.assign(`/t/${uid("trip-")}`); },

    // Appearance (per-device typography; applied live, persisted locally).
    setFont: (id) => { setFont(id); schedulePaint(); },
    stepTextSize: (dir) => { stepScale(dir * SCALE_STEP); schedulePaint(); },
    stepWeight: (dir) => { stepWeight(dir * WEIGHT_STEP); schedulePaint(); },
    setTheme: (t) => { setTheme(t); schedulePaint(); },
    toggleFullscreen: () => { setFullscreenPreferred(!fullscreenPreferred()); schedulePaint(); },
    resetAppearance: () => { resetTypography(); schedulePaint(); },

    // "Your trips" switcher (device-local list).
    openTrip: (id) => { if (id && id !== tripId) location.assign(`/t/${encodeURIComponent(id)}`); },
    shareTripLink: async (id) => {
      const url = `${location.origin}/t/${encodeURIComponent(id)}`;
      try { await navigator.clipboard.writeText(url); toast("🔗 Link copied — share it with your group."); }
      catch { toast(url); }
    },
    removeTrip: (id) => { forgetTrip(id); schedulePaint(); },
  };

  function paint() {
    try {
      const snap = log.snapshot();
      // Keep this device's trip list current (float to front, sync the name).
      rememberTrip(snap.id, snap.name || "");
      render(snap, actions);
    } catch (e) {
      derror("render failed", e);
    }
  }

  // Coalesce renders into an animation frame. A render must never run
  // synchronously inside an input's change/blur handler (replacing the board's
  // children mid-blur races the browser's focus teardown), and a repaint must
  // never yank a card out from under an in-progress drag/pan — so defer while
  // either is active and try again next frame.
  let painting = false;
  function schedulePaint() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(function tick() {
      if (window.__sianoDragging || window.__sianoPanning) { requestAnimationFrame(tick); return; }
      painting = false;
      paint();
    });
  }

  // ── Transient "+ add all" shortcut ─────────────────────────────────────────
  // Armed for a few seconds when a meal is created by dragging one traveller
  // onto the board; the button (rendered above the dock) pulls everyone else
  // into that fresh meal in one tap. If ignored it just fades away on timeout.
  const QUICK_ADD_MS = 6000;
  let quickAddTimer = null;
  function armQuickAddAll(mealId) {
    clearTimeout(quickAddTimer);
    ui.quickAddMealId = mealId;
    schedulePaint();
    quickAddTimer = setTimeout(disarmQuickAddAll, QUICK_ADD_MS);
  }
  function disarmQuickAddAll() {
    clearTimeout(quickAddTimer);
    quickAddTimer = null;
    if (ui.quickAddMealId != null) { ui.quickAddMealId = null; schedulePaint(); }
  }

  interactions = initInteractions({ actions, schedulePaint });

  log.subscribe(schedulePaint);
  paint();

  // Top-bar + primary "add meal" button.
  document.getElementById("add-meal").addEventListener("click", actions.addMeal);
  // Report CSV backup (built from the current snapshot at click time).
  document.getElementById("report-csv").addEventListener("click", () => downloadReportCsv(log.snapshot()));

  // Live sync (optional — the app is fully usable offline).
  const sync = new SyncClient(wsUrl(), log, {
    onStatus: (s) => {
      netEl.textContent = s === "open" ? "live" : s === "connecting" ? "…" : "offline";
      netEl.className = "net net--" + (s === "open" ? "open" : s === "connecting" ? "connecting" : "closed");
    },
  });
  sync.connect();

  // NOTE: the service worker is registered from an inline <script> in index.html's
  // <head>, not here, so it installs at the earliest possible point on a first
  // visit (a poor-coverage user who bails out mid-load still leaves the offline
  // shell installed for next time). See the head comment in client/index.html.
}

main().catch((e) => {
  derror("failed to start", e);
  const b = document.getElementById("board-canvas");
  if (b) b.textContent = "Failed to start: " + e.message;
});
