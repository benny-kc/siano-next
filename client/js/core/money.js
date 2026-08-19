// Tiny helpers for converting between user-facing money strings and the
// integer-cents representation used everywhere internally.
//
// Ported from the reference Elixir app's `Siano.Trips.Money`. The golden rule
// of the whole app: money is ALWAYS integer cents, client and hub. Floats never
// cross a boundary and never get synced. These helpers are pure and have no
// dependencies so they run unchanged in the browser and under `node --test`.

/**
 * Parse a user-supplied amount (`"42.50"`, `"7"`, `"3,20"`, or a number) into
 * integer cents. Returns `{ ok: true, cents }` or `{ ok: false }`.
 *
 * A comma is treated as a decimal separator (European entry), matching the
 * reference app. Negative inputs are rejected — an amount is never negative.
 */
export function parse(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return { ok: false };
    // Integers are whole currency units; anything else is a fractional amount.
    return { ok: true, cents: Number.isInteger(value) ? value * 100 : Math.round(value * 100) };
  }
  if (typeof value !== "string") return { ok: false };

  const normalized = value.trim().replace(",", ".");
  // Require the WHOLE string to be a single decimal number, like Elixir's
  // `Float.parse(normalized)` with an empty remainder. This rejects "12 foo".
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { ok: false };
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false };
  return { ok: true, cents: Math.round(amount * 100) };
}

/**
 * Pull the first price-like token out of arbitrary text (e.g. an OCR field like
 * `"€12.50"`) and parse it to cents. Returns `{ ok, cents }`.
 *
 * The token is `\d+[.,]\d{2}` — a number with exactly two fractional digits,
 * i.e. what a price on a receipt looks like.
 */
export function extract(text) {
  const match = String(text ?? "").match(/\d+[.,]\d{2}/);
  return match ? parse(match[0]) : { ok: false };
}

/**
 * Format integer cents as a plain decimal string, e.g. `4250 -> "42.50"`.
 * Handles negatives (used for balances): `-4250 -> "-42.50"`.
 */
export function format(cents) {
  if (!Number.isInteger(cents)) throw new TypeError("format expects integer cents");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}
