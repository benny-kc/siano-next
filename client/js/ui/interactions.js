// All pointer gestures for the board, wired ONCE on stable containers by event
// delegation so they survive every repaint (the reference app re-bound them per
// element via LiveView hooks on mounted/updated; here the board repaints, so we
// listen on the containers that never get replaced instead).
//
// Ported behaviour from the reference app's assets/js/hooks/{gestures,pan_zoom,
// traveller,meal_card}.js and misc.js (LongPress). Two shared runtime flags,
// window.__sianoDragging / __sianoPanning, keep the gestures from fighting each
// other — a real drag or pan suppresses the drawer edge-swipe, and app.js also
// defers repaints while either is set so a moving card is never yanked out from
// under the finger.

import { BoardView } from "./boardview.js";
import { View } from "./viewstate.js";
import { ui } from "./board.js";
import { selectedMember, setSelectedTraveller, clearSelectedTraveller } from "./selection.js";

const EDGE = 28; // px from a screen border where an "open" swipe may start
const DRAG_THRESH = 8; // px of travel before a token press becomes a drag

let zCounter = 10;

export function initInteractions({ actions, schedulePaint }) {
  const surface = document.getElementById("board-surface");
  const canvas = document.getElementById("board-canvas");
  const dock = document.getElementById("dock");

  BoardView.reset();

  wireOverlayClicks(actions, schedulePaint);
  wireConfirm(actions);
  wireEdgeSwipe(actions, schedulePaint);
  wirePanZoom(surface);
  wireTravellerDrag(dock, surface, actions);
  wireCardDrag(canvas, actions);
  wireLongPress(canvas, schedulePaint);

  // Expose a pan-to helper for "open a bill onto the board" (called by app.js).
  return {
    panToMeal(id) {
      requestAnimationFrame(() => {
        const card = document.getElementById("meal-" + id) || canvas.querySelector(`[data-meal-id="${CSS.escape(id)}"]`);
        if (!card) return;
        const cr = card.getBoundingClientRect();
        const br = surface.getBoundingClientRect();
        BoardView.panX += br.left + br.width / 2 - (cr.left + cr.width / 2);
        BoardView.panY += br.top + br.height / 2 - (cr.top + cr.height / 2);
        canvas.style.transition = "transform 0.3s ease";
        const clear = () => { canvas.style.transition = ""; canvas.removeEventListener("transitionend", clear); };
        canvas.addEventListener("transitionend", clear);
        setTimeout(clear, 400);
        BoardView.apply();
      });
    },
  };
}

// ── Overlay trigger taps (delegated on document, since the drawers are DOM
//    siblings of #trip). Mirrors hooks/gestures.js onClick. ────────────────────
function wireOverlayClicks(actions, schedulePaint) {
  document.addEventListener("click", (e) => {
    const t = e.target.closest(
      "[data-siano-open],[data-siano-close],[data-siano-help-open]," +
        "[data-siano-help-close],[data-siano-report-open],[data-siano-report-close]," +
        "[data-siano-sortmenu],[data-siano-sortmenu-close]",
    );
    if (!t) return;
    if (t.hasAttribute("data-siano-open")) {
      if (t.getAttribute("data-siano-open") === "bills") { ui.billsFilter = null; schedulePaint(); View.openDrawer("bills"); }
      else View.openDrawer("menu");
    } else if (t.hasAttribute("data-siano-close")) View.closeDrawer();
    else if (t.hasAttribute("data-siano-help-open")) View.openHelp();
    else if (t.hasAttribute("data-siano-help-close")) View.closeHelp();
    else if (t.hasAttribute("data-siano-report-open")) View.openReport();
    else if (t.hasAttribute("data-siano-report-close")) View.closeReport();
    else if (t.hasAttribute("data-siano-sortmenu")) View.toggleSortMenu();
    else if (t.hasAttribute("data-siano-sortmenu-close")) View.closeSortMenu();
  });
}

// ── In-page confirm dialog (replaces native confirm()). Intercepts clicks on
//    [data-confirm] in the capture phase; runs the action only on "Yes". ───────
function wireConfirm(actions) {
  const modal = document.getElementById("confirm-modal");
  const msgEl = modal.querySelector(".confirm-message");
  const yes = modal.querySelector(".confirm-yes");
  const no = modal.querySelector(".confirm-no");
  const backdrop = modal.querySelector(".confirm-backdrop");
  let pending = null;

  const open = (message, fn) => { pending = fn; msgEl.textContent = message || "Are you sure?"; modal.classList.remove("hidden"); requestAnimationFrame(() => modal.style.opacity = "1"); };
  const close = () => { pending = null; modal.style.opacity = "0"; setTimeout(() => modal.classList.add("hidden"), 200); };

  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-confirm]");
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    const [name, arg] = String(trigger.dataset.confirmAction || "").split(":");
    open(trigger.dataset.confirm, () => runConfirm(actions, name, arg));
  }, true);

  yes.addEventListener("click", () => { const p = pending; close(); if (p) p(); });
  no.addEventListener("click", close);
  backdrop.addEventListener("click", close);
}

function runConfirm(actions, name, arg) {
  if (name === "deleteMeal") actions.removeMeal(arg);
  else if (name === "removeMember") actions.removeMember(arg);
}

// ── Edge-swipe drawers (touch only), on document so swipes over an open drawer
//    still count. Mirrors hooks/gestures.js. ────────────────────────────────────
function wireEdgeSwipe(actions, schedulePaint) {
  const THRESH = 60, RATIO = 1.7, MAX_DY = 55;
  let x0 = null, y0 = null, invalid = false;

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { invalid = true; x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; invalid = false;
  }, { passive: true });

  document.addEventListener("touchmove", () => {
    if (x0 !== null && window.__sianoDragging) invalid = true;
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    const startX = x0;
    const bad = invalid || window.__sianoDragging;
    x0 = null; invalid = false;
    if (startX === null || bad) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - (y0 ?? t.clientY);
    if (Math.abs(dx) < THRESH) return;
    if (Math.abs(dy) > MAX_DY) return;
    if (Math.abs(dx) < RATIO * Math.abs(dy)) return;

    const drawer = View.currentDrawer();
    const openBills = () => { ui.billsFilter = null; schedulePaint(); View.openDrawer("bills"); };
    if (View.reportOpen()) {
      if (dx < 0 && startX >= window.innerWidth - EDGE) View.closeReport();
    } else if (drawer === "bills") {
      if (dx < 0) View.closeDrawer();
      else if (dx > 0 && startX <= EDGE) View.openReport();
    } else if (drawer === "menu") {
      if (dx > 0) View.closeDrawer();
    } else if (dx > 0 && startX <= EDGE) {
      openBills();
    } else if (dx < 0 && startX >= window.innerWidth - EDGE) {
      View.openDrawer("menu");
    }
  }, { passive: true });
}

// ── Board pan / zoom on #board-surface. Mirrors hooks/pan_zoom.js. ─────────────
function wirePanZoom(surface) {
  let two = null, one = null;
  const rect = () => surface.getBoundingClientRect();
  const NO_PAN = "button, a, input, textarea, select, label, form, .drag-handle, .traveller-token, [data-longpress]";

  const twoFinger = (e) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    return { dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY), midX: (a.clientX + b.clientX) / 2, midY: (a.clientY + b.clientY) / 2 };
  };

  surface.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) { two = twoFinger(e); one = null; window.__sianoPanning = true; }
    else if (e.touches.length === 1) {
      if (window.__sianoDragging) return;
      if (e.target.closest(NO_PAN)) return;
      const t = e.touches[0];
      if (t.clientX <= EDGE || t.clientX >= window.innerWidth - EDGE) return; // leave edges for drawer swipe
      one = { x: t.clientX, y: t.clientY };
    }
  }, { passive: true });

  surface.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && two) {
      e.preventDefault();
      const cur = twoFinger(e); const r = rect();
      if (two.dist > 0) BoardView.zoomAt(cur.midX - r.left, cur.midY - r.top, cur.dist / two.dist);
      BoardView.panX += cur.midX - two.midX;
      BoardView.panY += cur.midY - two.midY;
      BoardView.apply();
      two = cur;
    } else if (e.touches.length === 1 && one) {
      e.preventDefault();
      const t = e.touches[0];
      BoardView.panX += t.clientX - one.x;
      BoardView.panY += t.clientY - one.y;
      one.x = t.clientX; one.y = t.clientY;
      window.__sianoDragging = true;
      BoardView.apply();
    }
  }, { passive: false });

  const endTouch = (e) => {
    if (e.touches.length < 2) { two = null; window.__sianoPanning = false; }
    if (e.touches.length === 1) { const t = e.touches[0]; one = { x: t.clientX, y: t.clientY }; }
    else if (e.touches.length === 0) { one = null; setTimeout(() => { window.__sianoDragging = false; }, 0); }
  };
  surface.addEventListener("touchend", endTouch);
  surface.addEventListener("touchcancel", endTouch);

  // Tapping empty board space clears the armed traveller.
  let tapX = 0, tapY = 0;
  surface.addEventListener("pointerdown", (e) => { tapX = e.clientX; tapY = e.clientY; });
  surface.addEventListener("click", (e) => {
    if (!selectedMember) return;
    if (Math.abs(e.clientX - tapX) > 8 || Math.abs(e.clientY - tapY) > 8) return;
    if (e.target.closest(".meal-card, button, a, input, textarea, select, label")) return;
    clearSelectedTraveller();
  });

  // Desktop mouse pan (drag empty board) + wheel to pan, ctrl+wheel to zoom.
  let mouse = null;
  surface.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || (e.button != null && e.button > 0)) return;
    if (e.target.closest(NO_PAN) || e.target.closest(".meal-card")) return;
    if (e.clientX <= EDGE || e.clientX >= window.innerWidth - EDGE) return;
    mouse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointermove", (e) => {
    if (!mouse) return;
    BoardView.panX += e.clientX - mouse.x;
    BoardView.panY += e.clientY - mouse.y;
    mouse.x = e.clientX; mouse.y = e.clientY;
    BoardView.apply();
  });
  window.addEventListener("pointerup", () => { mouse = null; });

  surface.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = rect();
    if (e.ctrlKey) BoardView.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else { BoardView.panX -= e.deltaX; BoardView.panY -= e.deltaY; BoardView.apply(); }
  }, { passive: false });

  // Keep the centred board point centred across viewport resizes / rotation.
  let lastW = surface.clientWidth, lastH = surface.clientHeight;
  new ResizeObserver(() => {
    const w = surface.clientWidth, h = surface.clientHeight;
    if (!w || !h) return;
    if (lastW && lastH && (lastW !== w || lastH !== h)) {
      const s = BoardView.scale;
      const cx = (lastW / 2 - BoardView.panX) / s;
      const cy = (lastH / 2 - BoardView.panY) / s;
      BoardView.panX = w / 2 - cx * s;
      BoardView.panY = h / 2 - cy * s;
      BoardView.apply();
    }
    lastW = w; lastH = h;
  }).observe(surface);
}

// ── Traveller drag-to-split (delegated pointerdown on #dock). Mirrors
//    hooks/traveller.js, minus pointer capture (the token is re-created on each
//    repaint, so we drive the drag off window listeners instead). ──────────────
function wireTravellerDrag(dock, surface, actions) {
  dock.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button > 0) return;
    const token = e.target.closest(".traveller-token");
    if (!token) return;
    e.preventDefault();
    const memberId = token.dataset.memberId;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, ghost = null, currentCard = null;

    const clearHighlights = () => document.querySelectorAll(".dropzone--over").forEach((z) => z.classList.remove("dropzone--over"));
    const mealCardAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest(".meal-card"); };
    const highlight = (card) => {
      if (card === currentCard) return;
      clearHighlights();
      currentCard = card;
      if (card) { const z = card.querySelector(".dropzone"); if (z) z.classList.add("dropzone--over"); }
    };

    const beginDrag = (ev) => {
      dragging = true;
      window.__sianoDragging = true;
      token.classList.add("token-dim");
      const r = token.getBoundingClientRect();
      ghost = token.cloneNode(true);
      ghost.classList.remove("animate-pop", "is-selected", "token-dim");
      ghost.classList.add("drag-ghost");
      ghost.style.width = `${r.width}px`;
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
      document.body.appendChild(ghost);
    };

    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) > DRAG_THRESH || Math.abs(ev.clientY - startY) > DRAG_THRESH) beginDrag(ev);
        else return;
      }
      if (ghost) { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; }
      highlight(mealCardAt(ev.clientX, ev.clientY));
    };

    const finish = (ev) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const wasDragging = dragging;
      const card = wasDragging ? mealCardAt(ev.clientX, ev.clientY) : null;
      if (ghost) { ghost.remove(); ghost = null; }
      token.classList.remove("token-dim");
      clearHighlights();
      setTimeout(() => { window.__sianoDragging = false; }, 0);

      if (!wasDragging) { setSelectedTraveller(memberId); return; }

      if (card) {
        card.classList.remove("pulse");
        void card.offsetWidth;
        card.classList.add("pulse");
        actions.dropOnMeal(card.dataset.mealId, memberId);
      } else {
        const b = surface.getBoundingClientRect();
        if (ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top && ev.clientY <= b.bottom) {
          const c = BoardView.toCanvas(ev.clientX, ev.clientY, b);
          actions.dropOnBoard(memberId, Math.round(c.x - 128), Math.round(c.y - 24));
        }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

// ── Meal-card drag by its handle (delegated on #board-canvas). Mirrors
//    hooks/meal_card.js. Bring-to-front on any pointerdown within a card. ───────
function wireCardDrag(canvas, actions) {
  canvas.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".meal-card");
    if (card) card.style.zIndex = String(++zCounter); // raise on any interaction

    const handle = e.target.closest(".drag-handle");
    if (!handle || !card) return;
    if (e.button != null && e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();

    window.__sianoDragging = true;
    card.classList.add("raised");
    const startX = e.clientX, startY = e.clientY;
    const originLeft = parseFloat(card.style.left) || 0;
    const originTop = parseFloat(card.style.top) || 0;

    const onMove = (ev) => {
      const left = originLeft + (ev.clientX - startX) / BoardView.scale;
      const top = originTop + (ev.clientY - startY) / BoardView.scale;
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.dataset.x = left;
      card.dataset.y = top;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      card.classList.remove("raised");
      setTimeout(() => { window.__sianoDragging = false; }, 0);
      actions.moveMeal(card.dataset.mealId, Math.round(parseFloat(card.dataset.x)), Math.round(parseFloat(card.dataset.y)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

// ── Long-press a participant name to edit their exact share; short tap arms
//    that traveller. Mirrors hooks/misc.js LongPress. ────────────────────────────
function wireLongPress(canvas, schedulePaint) {
  canvas.addEventListener("pointerdown", (e) => {
    const body = e.target.closest("[data-longpress]");
    if (!body) return;
    const mealId = body.dataset.mealId, memberId = body.dataset.memberId;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    let timer = setTimeout(() => {
      timer = null;
      ui.editingShare = `${mealId}:${memberId}`;
      schedulePaint();
    }, 450);

    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onMove = (ev) => { if (Math.abs(ev.clientX - sx) > 10 || Math.abs(ev.clientY - sy) > 10) { moved = true; cancel(); } };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const wasTap = timer !== null && !moved;
      cancel();
      if (wasTap) setSelectedTraveller(memberId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}
