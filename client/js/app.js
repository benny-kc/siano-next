// App entry point — wires the op-log store, the sync client, and the board UI
// together. No framework, no build step: this file is loaded as an ES module
// straight from index.html.
//
// The data loop is deliberately one-directional and simple:
//   user action -> log.emit(op) -> (persist + broadcast) -> log change ->
//   re-fold -> buildSnapshot -> render. Incoming synced ops enter the same
//   change path, so remote edits and local edits render identically.

import { openTripStore } from "./store/oplog.js";
import { SyncClient } from "./sync/client.js";
import * as ops from "./core/ops.js";
import { render } from "./ui/board.js";
import { dlog, derror } from "./log.js";

const PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const uid = (p) =>
  (globalThis.crypto?.randomUUID ? crypto.randomUUID() : p + Math.random().toString(36).slice(2, 10));

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Trip id lives in the URL as /t/<id>; mint one if absent so a fresh visit
// becomes a shareable trip immediately.
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

async function main() {
  const tripId = currentTripId();
  dlog("boot: trip", tripId, "at", location.href);
  const log = await openTripStore(tripId);
  dlog(`boot: store opened — ${log.allOps().length} ops on device`, "device", log.device);

  const board = document.getElementById("board");
  const netEl = document.getElementById("net");
  const nameEl = document.getElementById("trip-name");

  const actions = {
    setTripName: (name) => log.emit((c) => ops.setTripName(c, name)),
    addMember: () => {
      const n = log.snapshot().members.length;
      const id = uid("m-");
      const name = `Traveller ${n + 1}`;
      log.emit((c) => ops.addMember(c, id, { name, color: PALETTE[n % PALETTE.length], initials: initials(name) }));
    },
    setMemberName: (id, name) => log.emit((c) => ops.setMemberName(c, id, name)),
    removeMember: (id) => log.emit((c) => ops.removeMember(c, id)),
    addMeal: () => log.emit((c) => ops.addMeal(c, uid("meal-"), { name: "" })),
    setMealName: (id, name) => log.emit((c) => ops.setMealName(c, id, name)),
    removeMeal: (id) => log.emit((c) => ops.removeMeal(c, id)),
    setAmount: (id, cents) => log.emit((c) => ops.setAmount(c, id, cents)),
    setPayer: (id, payerId) => log.emit((c) => ops.setPayer(c, id, payerId)),
    toggleParticipant: (mealId, memberId, add) =>
      log.emit((c) => (add ? ops.addParticipant(c, mealId, memberId) : ops.removeParticipant(c, mealId, memberId))),
    setShare: (mealId, memberId, cents) =>
      log.emit((c) => (cents == null
        ? ops.setShare(c, mealId, memberId, 0, false)
        : ops.setShare(c, mealId, memberId, cents, true))),
  };

  function paint() {
    try {
      const snap = log.snapshot();
      // Keep the trip-name field in sync without stomping the user mid-type.
      if (document.activeElement !== nameEl) nameEl.value = snap.name || "";
      document.title = snap.name ? `${snap.name} · Siano` : "Siano";
      render(board, snap, actions);
    } catch (e) {
      // A render exception must not silently leave a blank board — surface it.
      derror("render failed", e);
      board.textContent = "Something went wrong rendering the board — see console.";
    }
  }

  // Coalesce renders into an animation frame. Rendering must never run
  // synchronously inside an input's change/blur handler: replacing the board's
  // children mid-blur races the browser's own focus DOM teardown. Deferring
  // also batches a burst of ops (e.g. a sync delta) into a single repaint.
  let painting = false;
  function schedulePaint() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      paint();
    });
  }

  log.subscribe(schedulePaint);
  paint();

  // Toolbar wiring
  nameEl.addEventListener("change", (e) => actions.setTripName(e.target.value));
  document.getElementById("add-member").addEventListener("click", actions.addMember);
  document.getElementById("add-meal").addEventListener("click", actions.addMeal);
  document.getElementById("share").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      netEl.textContent = "link copied";
      setTimeout(paint, 1200);
    } catch {
      /* clipboard blocked — the URL bar already shows the shareable link */
    }
  });

  // Live sync (optional — the app is fully usable offline).
  const sync = new SyncClient(wsUrl(), log, {
    onStatus: (s) => {
      netEl.textContent = s === "open" ? "live" : s === "connecting" ? "…" : "offline";
      netEl.className = "net net--" + (s === "open" ? "open" : "closed");
    },
  });
  sync.connect();

  // Register the service worker so the shell works offline (best-effort).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
}

main().catch((e) => {
  derror("failed to start", e);
  document.getElementById("board").textContent = "Failed to start: " + e.message;
});
