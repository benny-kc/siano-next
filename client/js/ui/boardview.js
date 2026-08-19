// Board pan / zoom — ported from the reference app's assets/js/lib/board.js.
//
// The meal cards live inside #board-canvas, which is transformed via CSS custom
// properties set on :root. Keeping the transform on <html> (not on any element
// a repaint replaces) is the whole trick: a full re-render of #board-canvas
// never resets the view, exactly as morphdom leaving <html> alone did in the
// reference. All card/traveller coordinate math converts between screen and
// canvas space through BoardView so dragging stays accurate at any zoom/pan.

export const BoardView = {
  scale: 1,
  panX: 0,
  panY: 0,
  MIN: 0.4,
  MAX: 3,
  apply() {
    const root = document.documentElement.style;
    root.setProperty("--siano-pan-x", this.panX + "px");
    root.setProperty("--siano-pan-y", this.panY + "px");
    root.setProperty("--siano-scale", String(this.scale));
  },
  reset() {
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.apply();
  },
  // screen point -> canvas coordinates
  toCanvas(clientX, clientY, boardRect) {
    return {
      x: (clientX - boardRect.left - this.panX) / this.scale,
      y: (clientY - boardRect.top - this.panY) / this.scale,
    };
  },
  // zoom by `factor` keeping the viewport point (vx, vy) fixed
  zoomAt(vx, vy, factor) {
    const next = Math.min(this.MAX, Math.max(this.MIN, this.scale * factor));
    const f = next / this.scale;
    this.panX = vx - (vx - this.panX) * f;
    this.panY = vy - (vy - this.panY) * f;
    this.scale = next;
    this.apply();
  },
};
