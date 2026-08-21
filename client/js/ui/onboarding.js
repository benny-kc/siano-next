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
  input.placeholder = `Traveller ${n}`;
  input.setAttribute("aria-label", `Traveller ${n} name`);
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
 */
export function showOnboarding({ onDone } = {}) {
  const modal = document.getElementById("onboard-modal");
  if (!modal || modal.dataset.shown === "1") return;
  modal.dataset.shown = "1";

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

  addBtn.addEventListener("click", addRow);
  laterBtn.addEventListener("click", close);
  doneBtn.addEventListener("click", done);
  backdrop.addEventListener("click", close);
  // Enter in the trip name jumps to the first traveller; Enter in the last
  // traveller row adds another — a keyboard-only path through the form.
  tripInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); people.querySelector("input")?.focus(); }
  });
  people.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = Array.from(people.querySelectorAll("input"));
    if (e.target === inputs[inputs.length - 1]) addRow();
    else inputs[inputs.indexOf(e.target) + 1]?.focus();
  });

  // Reveal (mirrors the confirm dialog: drop `.hidden`, then fade opacity in).
  modal.classList.remove("hidden");
  requestAnimationFrame(() => {
    modal.style.opacity = "1";
    tripInput.focus();
  });
}
