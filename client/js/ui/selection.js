// Which traveller is currently "armed" (single-selected in the dock). Ported
// from the reference app's assets/js/lib/selection.js.
//
// While a traveller is selected, tapping a participant chip's name arms/edits;
// in the reference it also drives bill-photo field assignment. Single-select:
// selecting one clears the others. The renderer consults `selectedMember` to
// re-apply the `.is-selected` ring after a repaint (a repaint re-creates the
// tokens), and interactions.js flips it live on tap without waiting for a paint.

import { registerVersion } from "../version.js";
registerVersion("js/ui/selection.js", 1);

export let selectedMember = null;

export function setSelectedTraveller(id) {
  selectedMember = selectedMember === id ? null : id;
  reflect();
}

export function clearSelectedTraveller() {
  if (selectedMember === null) return;
  selectedMember = null;
  reflect();
}

// Re-apply the ring to whatever tokens are currently in the DOM.
export function reflect() {
  document.querySelectorAll(".traveller-token").forEach((t) => {
    t.classList.toggle("is-selected", t.dataset.memberId === selectedMember);
  });
}
