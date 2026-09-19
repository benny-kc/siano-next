// First-run welcome / onboarding overlay.
//
// Shown once, on a genuinely fresh device: no trip yet, nothing stored, no
// travellers (see the `firstTime` check in app.js). It greets the newcomer and
// lets them seed the trip in one go — a trip name plus a handful of traveller
// names — instead of discovering the Settings drawer on their own.
//
// It is a static shell in index.html (#onboard-modal, toggled by `.hidden` like
// the confirm dialog, so it never flashes on first paint); this module only
// fills in the dynamic traveller rows and wires the buttons. "Done" hands the
// filled-in values back to app.js (which names the trip and adds the named
// travellers as ops); "Later" — or the backdrop — just dismisses it. Either way
// the overlay is a one-shot for this boot: dismissing it never reopens it.

import { t } from "./i18n.js";
import { registerVersion } from "../version.js";
registerVersion("js/ui/onboarding.js", 4);

const START_ROWS = 3; // a few empty name fields to invite more than one traveller
const MAX_ROWS = 24; // a soft cap so "+" can't spawn an unbounded list

// Build one traveller-name row. `type="search"` + the data-* opt-outs suppress
// the browser / password-manager autofill bar (same trick as ui/board.js's
// NO_AUTOFILL); a search field never offers password/card/address autofill.
function personRow(n) {
  const row = document.createElement("div");
  row.className = "onboard-person";
  const input = document.createElement("input");
  input.type = "search";
  input.className = "onboard-input";
  input.placeholder = t("app.travellerDefault", { n });
  input.setAttribute("aria-label", t("onboard.travellerNameAria", { n }));
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "words");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-1p-ignore", "true");
  input.setAttribute("data-form-type", "other");
  row.appendChild(input);
  return row;
}

/**
 * Show the first-run overlay. `onDone({ tripName, names })` is called only when
 * the user taps "Done": `tripName` is the trimmed trip name (may be ""), `names`
 * is the list of non-blank traveller names in order. "Later" / backdrop dismiss
 * without calling back. Idempotent per boot — a second call while it's open is a
 * no-op.
 *
 * `force: true` bypasses the once-per-boot guard so the overlay can be replayed
 * on demand (the temporary "Preview welcome screen" button in Settings). Each
 * call wires its listeners through an AbortController that `close()` aborts, so
 * a replay never stacks duplicate handlers on the shared buttons.
 */
export function showOnboarding({ onDone, force = false } = {}) {
  const modal = document.getElementById("onboard-modal");
  if (!modal || (modal.dataset.shown === "1" && !force)) return;
  modal.dataset.shown = "1";
  const ac = new AbortController();
  const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });

  const tripInput = modal.querySelector("#onboard-trip");
  const people = modal.querySelector("#onboard-people");
  const addBtn = modal.querySelector("#onboard-add");
  const laterBtn = modal.querySelector("#onboard-later");
  const doneBtn = modal.querySelector("#onboard-done");
  const backdrop = modal.querySelector(".onboard-backdrop");

  people.replaceChildren();
  for (let i = 1; i <= START_ROWS; i++) people.appendChild(personRow(i));

  const addRow = () => {
    if (people.children.length >= MAX_ROWS) return;
    const row = personRow(people.children.length + 1);
    people.appendChild(row);
    // Focus the freshly-added field so the user can keep typing names.
    row.querySelector("input")?.focus();
  };

  const close = () => {
    ac.abort(); // drop this showing's listeners so a replay can't stack them
    modal.dataset.shown = ""; // allow a forced re-show (Settings preview button)
    modal.style.opacity = "0";
    setTimeout(() => modal.classList.add("hidden"), 200);
  };

  const done = () => {
    const tripName = (tripInput.value || "").trim();
    const names = Array.from(people.querySelectorAll("input"))
      .map((i) => i.value.trim())
      .filter(Boolean);
    close();
    if (typeof onDone === "function") onDone({ tripName, names });
  };

  on(addBtn, "click", addRow);
  on(laterBtn, "click", close);
  on(doneBtn, "click", done);
  on(backdrop, "click", close);
  // Enter in the trip name jumps to the first traveller; Enter in the last
  // traveller row adds another — a keyboard-only path through the form.
  on(tripInput, "keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); people.querySelector("input")?.focus(); }
  });
  on(people, "keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = Array.from(people.querySelectorAll("input"));
    if (e.target === inputs[inputs.length - 1]) addRow();
    else inputs[inputs.indexOf(e.target) + 1]?.focus();
  });

  // Reveal (mirrors the confirm dialog: drop `.hidden`, then fade opacity in).
  // Deliberately DON'T auto-focus the trip-name field: on mobile, focusing an
  // input pops the on-screen keyboard, which covers the lower half of this
  // already-tall overlay so the welcome copy + traveller fields aren't fully
  // visible. Let the user read the screen first; the keyboard only appears once
  // they tap a field themselves.
  modal.classList.remove("hidden");
  requestAnimationFrame(() => {
    modal.style.opacity = "1";
  });
}
