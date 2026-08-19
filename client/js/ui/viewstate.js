// Client-side view state for the purely-visual, per-viewer toggles: the two
// drawers (Bills / Settings), the Report overlay, the Help overlay and the Bills
// sort popover. Ported from the reference app's assets/js/lib/viewstate.js.
//
// The state lives as data-attributes on <html>, exactly like the pan/zoom
// transform (see boardview.js). A full re-render of the board / dock / drawer
// contents never touches the <html> element, so whatever the user opened stays
// exactly as they left it, and the matching CSS in app.css slides/fades it with
// no round trip.
//
//   data-siano-drawer   = "bills" | "menu" (absent = both closed)
//   data-siano-help     = present when the help overlay is open
//   data-siano-report   = present when the report overlay is open
//   data-siano-sortmenu = present when the Bills sort popover is open

const root = document.documentElement;

// ── Android-/browser-Back integration ──────────────────────────────────────
// Push a history entry when an overlay opens so the system Back button closes it
// (instead of leaving the app).
const History = {
  pushed: false,
  programmatic: false, // we called history.back() ourselves (UI close)
  closeFromPop: false, // Back popped our entry (system close)
  anyOpen() {
    return !!View.currentDrawer() || View.helpOpen() || View.reportOpen();
  },
  sync() {
    const open = this.anyOpen();
    if (open && !this.pushed) {
      history.pushState({ sianoOverlay: true }, "");
      this.pushed = true;
    } else if (!open && this.pushed) {
      this.pushed = false;
      if (this.closeFromPop) {
        this.closeFromPop = false; // Back already removed the entry
      } else {
        this.programmatic = true; // UI close -> drop our entry
        history.back();
      }
    }
  },
};

export const View = {
  // ── Drawers ────────────────────────────────────────────────────────────────
  currentDrawer() {
    return root.getAttribute("data-siano-drawer") || null;
  },
  openDrawer(which) {
    if (which !== "bills" && which !== "menu") return;
    root.setAttribute("data-siano-drawer", which);
    this.closeSortMenu();
    History.sync();
  },
  closeDrawer() {
    root.removeAttribute("data-siano-drawer");
    this.closeSortMenu();
    History.sync();
  },

  // ── Help overlay ─────────────────────────────────────────────────────────────
  helpOpen() {
    return root.hasAttribute("data-siano-help");
  },
  openHelp() {
    root.setAttribute("data-siano-help", "");
    History.sync();
  },
  closeHelp() {
    root.removeAttribute("data-siano-help");
    History.sync();
  },

  // ── Report overlay ─────────────────────────────────────────────────────────
  // A read-only table of every bill/split/total. A second left drawer that
  // slides in over Bills; closing it returns straight to the board (dropping the
  // Bills drawer it was sitting on top of).
  reportOpen() {
    return root.hasAttribute("data-siano-report");
  },
  openReport() {
    root.setAttribute("data-siano-report", "");
    this.closeSortMenu();
    History.sync();
  },
  closeReport() {
    root.removeAttribute("data-siano-report");
    root.removeAttribute("data-siano-drawer"); // back to the board, not back to Bills
    History.sync();
  },

  // ── Bills sort popover ────────────────────────────────────────────────────────
  sortMenuOpen() {
    return root.hasAttribute("data-siano-sortmenu");
  },
  toggleSortMenu() {
    if (this.sortMenuOpen()) root.removeAttribute("data-siano-sortmenu");
    else root.setAttribute("data-siano-sortmenu", "");
    this.reflectSortMenu();
  },
  closeSortMenu() {
    root.removeAttribute("data-siano-sortmenu");
    this.reflectSortMenu();
  },
  reflectSortMenu() {
    const btn = document.getElementById("bills-sort-btn");
    if (btn) btn.setAttribute("aria-expanded", String(this.sortMenuOpen()));
  },

  // Close every overlay through the history-aware path (used by the system Back
  // button, where popstate has already flagged closeFromPop).
  closeAll() {
    root.removeAttribute("data-siano-drawer");
    root.removeAttribute("data-siano-help");
    root.removeAttribute("data-siano-report");
    root.removeAttribute("data-siano-sortmenu");
    this.reflectSortMenu();
    History.sync();
  },
};

// Installed once from app.js. Wires the system Back button to close overlays.
export function installViewState() {
  window.addEventListener("popstate", () => {
    if (History.programmatic) {
      History.programmatic = false;
      return;
    }
    if (History.anyOpen()) {
      History.closeFromPop = true;
      View.closeAll();
    }
  });
}
