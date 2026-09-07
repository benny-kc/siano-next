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
import { makeEncoder, makeDecoder, serializeFrame, parseFrame, packOps, unpackOps } from "../core/qrstream.js";
import { encodeText } from "../vendor/qrcode.js";
import jsQR from "../vendor/jsqr.js";
import { registerVersion } from "../version.js";
registerVersion("js/ui/interactions.js", 9);

const EDGE = 28; // px from a screen border where an "open" swipe may start
const DRAG_THRESH = 8; // px of travel before a token press becomes a drag

let zCounter = 10;

export function initInteractions({ actions, schedulePaint }) {
  const surface = document.getElementById("board-surface");
  const canvas = document.getElementById("board-canvas");
  const dock = document.getElementById("dock");

  BoardView.reset();

  wireOverlayClicks(actions, schedulePaint);
  wireOfflineSyncSim(actions);
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
        "[data-siano-offlinesync-open],[data-siano-offlinesync-close]," +
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
    else if (t.hasAttribute("data-siano-offlinesync-open")) View.openOfflineSync();
    else if (t.hasAttribute("data-siano-offlinesync-close")) View.closeOfflineSync();
    else if (t.hasAttribute("data-siano-sortmenu")) View.toggleSortMenu();
    else if (t.hasAttribute("data-siano-sortmenu-close")) View.closeSortMenu();
  });
}

// Render one QR-stream frame's text as an SVG that fills the square placeholder.
function qrFrameSvg(text) {
  try {
    const { size, modules } = encodeText(text, "M");
    const quiet = 4;
    const dim = size + quiet * 2;
    let path = "";
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (modules[r][c]) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
    return `<svg viewBox="0 0 ${dim} ${dim}" width="100%" height="100%" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${path}" fill="#0f172a"/></svg>`;
  } catch { return ""; }
}

// ── Offline sync — the QR fountain link (sender + receiver) ────────────────────
//    Two halves of docs/qr-sync.md, both driving the shared placeholder + their
//    own button-as-progress-bar (green fill = real progress):
//
//    "Start sending" fountain-encodes the whole trip's ops (core/qrstream.js)
//    into an ENDLESS stream of coded QR frames shown at ~8/sec. Its fill advances
//    one step per frame across one payload-generation (enc.K frames), then loops
//    as the rateless stream keeps going; the "sending on a loop" hint shows.
//
//    "Start receiving" opens the in-PWA camera (getUserMedia — one-time
//    permission prompt), decodes frames with the vendored jsQR (§5), feeds them
//    to the fountain decoder, and its fill tracks real decode progress. Once the
//    payload reconstructs it calls actions.ingestOps() (dedup + persist + re-fold
//    + repaint — the bills just appear on the board) and shows a done state.
//
//    Closing the overlay — the ✕, the backdrop or system Back, all of which drop
//    data-siano-offlinesync on <html> — stops the stream, releases the camera,
//    restores the placeholder and resets both buttons. The modal markup is
//    static in index.html (never repainted), so direct listeners are safe.
function wireOfflineSyncSim(actions) {
  const modal = document.getElementById("offline-sync-modal");
  if (!modal) return;
  const sendBtn = modal.querySelector("[data-siano-offlinesync-send]");
  const recvBtn = modal.querySelector("[data-siano-offlinesync-receive]");
  if (!sendBtn && !recvBtn) return;
  const sendingNote = modal.querySelector(".osync-sending-note");
  const qrBox = modal.querySelector(".osync-qr");
  const qrIdle = qrBox ? qrBox.innerHTML : null; // "QR code / camera will appear here"
  const sendLabel = sendBtn && sendBtn.textContent; // "Start sending"
  const recvLabel = recvBtn && recvBtn.textContent; // "Start receiving"

  const restorePlaceholder = () => { if (qrBox && qrIdle != null) qrBox.innerHTML = qrIdle; };
  const boxNote = (text) => {
    if (!qrBox) return;
    qrBox.innerHTML = '<span class="osync-qr-note"></span>';
    qrBox.firstChild.textContent = text; // textContent, not HTML — our own strings, but safe by construction
  };

  // ── Sender: fountain-QR stream ──────────────────────────────────────────────
  const FRAME_MS = 120; // ~8 QR frames/sec (docs/qr-sync.md: ~5–10/sec)
  let sendTimer = null;
  const stopStream = () => {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    if (sendBtn) sendBtn.style.backgroundSize = "";
  };
  const startStream = async () => {
    stopReceive();
    stopStream();
    const ops = (actions && actions.allOps && actions.allOps()) || [];
    const payload = await packOps(ops); // whole-payload deflate (fewer frames)
    // Overlay may have closed while packOps awaited.
    if (!document.documentElement.hasAttribute("data-siano-offlinesync") || !sendBtn.classList.contains("is-sending")) return;
    const enc = makeEncoder(payload);
    const gen = enc.K; // frames covering one payload's worth → one progress cycle
    let n = 0;
    const tick = () => {
      let text;
      try { text = serializeFrame(enc.next()); } catch { return; }
      if (qrBox) { const svg = qrFrameSvg(text); if (svg) qrBox.innerHTML = svg; }
      if (sendBtn) sendBtn.style.backgroundSize = (((n % gen) + 1) / gen) * 100 + "% 100%";
      n++;
    };
    tick();
    sendTimer = setInterval(tick, FRAME_MS);
  };

  // ── Receiver: camera + jsQR decode + ingest ─────────────────────────────────
  let recvStream = null;
  let recvVideo = null;
  let recvRVFC = null;
  let recvTimer = null;
  const stopReceive = () => {
    if (recvVideo && recvRVFC && recvVideo.cancelVideoFrameCallback) recvVideo.cancelVideoFrameCallback(recvRVFC);
    recvRVFC = null;
    if (recvTimer) { clearTimeout(recvTimer); recvTimer = null; }
    if (recvStream) { recvStream.getTracks().forEach((t) => t.stop()); recvStream = null; }
    recvVideo = null;
    if (recvBtn) recvBtn.style.backgroundSize = "";
  };

  const startReceive = async () => {
    stopStream();
    stopReceive();
    const dec = makeDecoder();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch {
      boxNote("Camera unavailable — allow camera access, then tap Start receiving again.");
      if (recvBtn) { recvBtn.classList.remove("is-receiving"); recvBtn.removeAttribute("aria-busy"); recvBtn.textContent = recvLabel; }
      return;
    }
    // Bailed out (overlay closed) while the permission prompt was up.
    if (!document.documentElement.hasAttribute("data-siano-offlinesync")) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    recvStream = stream;
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.style.cssText = "width:100%;height:100%;object-fit:cover;";
    video.srcObject = stream;
    recvVideo = video;
    if (qrBox) { qrBox.innerHTML = ""; qrBox.appendChild(video); }
    try { await video.play(); } catch { /* autoplay is muted+inline, should be fine */ }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const complete = async (packed) => {
      stopReceive(); // release camera + loop before the async inflate/ingest
      let ops = null;
      try { ops = await unpackOps(packed); } catch { ops = null; }
      if (!ops) {
        if (recvBtn) { recvBtn.classList.remove("is-receiving"); recvBtn.removeAttribute("aria-busy"); recvBtn.textContent = recvLabel; }
        boxNote("Couldn't read the transfer — try again.");
        return;
      }
      const added = (actions && actions.ingestOps && actions.ingestOps(ops)) || [];
      if (recvBtn) { recvBtn.style.backgroundSize = "100% 100%"; recvBtn.removeAttribute("aria-busy"); recvBtn.textContent = "Received ✓"; }
      const n = added.length;
      boxNote(n ? `Received ${n} new ${n === 1 ? "op" : "ops"} 🎉` : "Already up to date — nothing new 🎉");
    };

    const scan = () => {
      if (!recvStream || recvVideo !== video) return; // stopped / superseded
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw && vh) {
        const scale = Math.min(1, 640 / vw); // cap width for decode speed
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        let img = null;
        try { img = ctx.getImageData(0, 0, w, h); } catch { img = null; }
        if (img) {
          const res = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
          const frame = res && res.data ? parseFrame(res.data) : null;
          if (frame) {
            dec.add(frame);
            if (recvBtn) recvBtn.style.backgroundSize = dec.progress * 100 + "% 100%";
            if (dec.isComplete()) { complete(dec.payload()); return; }
          }
        }
      }
      schedule();
    };
    const schedule = () => {
      if (recvStream !== stream) return;
      if (video.requestVideoFrameCallback) recvRVFC = video.requestVideoFrameCallback(() => scan());
      else recvTimer = setTimeout(scan, 100);
    };
    schedule();
  };

  if (sendBtn) sendBtn.addEventListener("click", () => {
    sendBtn.classList.add("is-sending");
    sendBtn.setAttribute("aria-busy", "true");
    sendBtn.textContent = "Sending…";
    if (sendingNote) sendingNote.classList.remove("hidden");
    if (recvBtn) { recvBtn.classList.remove("is-receiving"); recvBtn.removeAttribute("aria-busy"); recvBtn.textContent = recvLabel; }
    startStream();
  });
  if (recvBtn) recvBtn.addEventListener("click", () => {
    recvBtn.classList.remove("is-receiving");
    void recvBtn.offsetWidth;
    recvBtn.classList.add("is-receiving");
    recvBtn.setAttribute("aria-busy", "true");
    recvBtn.textContent = "Receiving…";
    if (sendBtn) { sendBtn.classList.remove("is-sending"); sendBtn.removeAttribute("aria-busy"); sendBtn.textContent = sendLabel; }
    if (sendingNote) sendingNote.classList.add("hidden");
    startReceive();
  });

  new MutationObserver(() => {
    if (document.documentElement.hasAttribute("data-siano-offlinesync")) return;
    stopStream();
    stopReceive();
    restorePlaceholder();
    if (sendBtn) { sendBtn.classList.remove("is-sending"); sendBtn.removeAttribute("aria-busy"); sendBtn.textContent = sendLabel; }
    if (recvBtn) { recvBtn.classList.remove("is-receiving"); recvBtn.removeAttribute("aria-busy"); recvBtn.textContent = recvLabel; }
    if (sendingNote) sendingNote.classList.add("hidden");
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-siano-offlinesync"] });
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
  else if (name === "removeTrip") actions.removeTrip(arg);
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

  // iOS Safari fires proprietary gesture* events for a pinch and can still zoom
  // the whole PAGE on them even though the surface is `touch-action: none` and
  // we preventDefault the two-finger touchmove (Android/Chrome has no such
  // events, so this only matters on iPhone). Swallow them on the board so a
  // pinch drives OUR zoom (touchmove handler) and never the browser's page zoom.
  // Scoped to the surface so a pinch over a drawer still behaves normally.
  ["gesturestart", "gesturechange", "gestureend"].forEach((type) =>
    surface.addEventListener(type, (e) => e.preventDefault(), { passive: false }),
  );

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
