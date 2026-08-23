// The device's list of trips this user has attended — a tiny per-device index
// kept in localStorage, separate from each trip's IndexedDB op-log. Ported from
// the reference app's TripSwitcher (assets/js/hooks/trips.js): every trip opened
// on this device is remembered automatically (no follow step), most-recent-first,
// so the Settings drawer can list them and the landing page ("/") can resume the
// last trip seen. Browser-only (localStorage) — verified in-browser, like the
// IndexedDB store.

import { registerVersion } from "../version.js";
registerVersion("js/store/trips.js", 1);

const KEY = "siano:trips";
const MAX = 50;

/** The remembered trips, `[{ id, name }]`, most-recent-first (newest at [0]). */
export function loadTrips() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) ? v.filter((t) => t && t.id) : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode / storage disabled — the list is a convenience, not the data */
  }
}

/**
 * Remember `id` as the current trip: float it to the front (most-recent-first)
 * and keep its name in sync. A no-op when it's already at the front with the
 * same name, so calling it on every repaint is cheap and doesn't churn storage.
 */
export function rememberTrip(id, name = "") {
  if (!id) return;
  const list = loadTrips();
  const head = list[0];
  if (head && head.id === id && head.name === name) return;
  const rest = list.filter((t) => t.id !== id);
  rest.unshift({ id, name });
  save(rest.slice(0, MAX));
}

/** Forget a trip on this device (does not touch its op-log). */
export function forgetTrip(id) {
  save(loadTrips().filter((t) => t.id !== id));
}

/** The most-recently-seen trip id, or null if the device has none yet. */
export function lastTripId() {
  const list = loadTrips();
  return list.length ? list[0].id : null;
}
