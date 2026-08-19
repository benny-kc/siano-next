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
import { SyncClient } from "./sync/client.js";
import * as ops from "./core/ops.js";
import { parse } from "./core/money.js";
import { render, ui } from "./ui/board.js";
import { BoardView } from "./ui/boardview.js";
import { installViewState } from "./ui/viewstate.js";
import { initInteractions } from "./ui/interactions.js";
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
  const id = uid("trip-");
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
      if (interactions) interactions.panToMeal(id);
    },
    setAmountStr: (id, str) => {
      const r = parse(str);
      if (r.ok) log.emit((c) => ops.setAmount(c, id, r.cents));
      else if (str.trim() === "") log.emit((c) => ops.setAmount(c, id, 0));
    },
    setPayer: (id, payerId) => log.emit((c) => ops.setPayer(c, id, payerId)),
    toggleParticipant: (mealId, memberId, add) =>
      log.emit((c) => (add ? ops.addParticipant(c, mealId, memberId) : ops.removeParticipant(c, mealId, memberId))),

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
    dropOnMeal: (mealId, memberId) => log.emit((c) => ops.addParticipant(c, mealId, memberId)),
    dropOnBoard: (memberId, x, y) => {
      // Two stamped ops: create the meal, then add the traveller to it. Each
      // advances the clock, so the participant op causally follows the add.
      const id = uid("meal-");
      log.emit((c) => ops.addMeal(c, id, { name: "", emoji: pick(EMOJIS), x, y, open: true }));
      log.emit((c) => ops.addParticipant(c, id, memberId));
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
  };

  function paint() {
    try {
      render(log.snapshot(), actions);
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

  interactions = initInteractions({ actions, schedulePaint });

  log.subscribe(schedulePaint);
  paint();

  // Top-bar + primary "add meal" button.
  document.getElementById("add-meal").addEventListener("click", actions.addMeal);

  // Live sync (optional — the app is fully usable offline).
  const sync = new SyncClient(wsUrl(), log, {
    onStatus: (s) => {
      netEl.textContent = s === "open" ? "live" : s === "connecting" ? "…" : "offline";
      netEl.className = "net net--" + (s === "open" ? "open" : s === "connecting" ? "connecting" : "closed");
    },
  });
  sync.connect();

  // Register the service worker so the shell works offline. Two anti-staleness
  // measures so a new release is actually picked up (the SW's own cache is
  // cache-first, so without these a returning device can keep serving the old
  // shell): `updateViaCache: "none"` stops the browser HTTP cache from pinning
  // the SW script, and — since the SW skipWaiting()s + claims on activate — a
  // one-time reload when a *new* worker takes control swaps the page over to the
  // fresh shell. Guarded so the very first install (no prior controller) never
  // triggers a reload. (The hub also serves the SW `no-cache`; see server.js.)
  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !hadController) return; // first install → no reload
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" }).catch(() => {});
  }
}

main().catch((e) => {
  derror("failed to start", e);
  const b = document.getElementById("board-canvas");
  if (b) b.textContent = "Failed to start: " + e.message;
});
