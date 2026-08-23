// Per-file version registry — a debugging aid to confirm which build of each
// client module a device is actually running. Surfaced in the Settings drawer
// when the per-device "Debug" toggle is on (see ui/debug.js + board.js).
//
// HOW IT WORKS: every JS module under client/js/ calls registerVersion() at
// import time with a version number embedded IN THAT FILE. Because the number
// lives inside each module, a device serving a STALE cached copy of one file
// keeps registering that file's OLD number — so the Settings list reveals
// exactly which module a device is running stale, which a single central
// manifest could not (a fresh manifest would wrongly vouch for a stale file).
//
// CONVENTION (also in CLAUDE.md): whenever you edit ANY client/js/*.js file,
// bump the number in its registerVersion(...) call by one. That is how you and
// the device agree on "did my change actually ship?".
//
// This module imports nothing (it is a leaf of the ESM graph), so every other
// module can depend on it without creating an import cycle — which the asset
// hashing in hub/assets.js relies on.

const versions = new Map();

/** Record a module's embedded version. Called once per module at import time. */
export function registerVersion(file, version) {
  versions.set(file, version);
}

/** Every registered module as `{ file, version }`, sorted by path. */
export function fileVersions() {
  return [...versions.entries()]
    .map(([file, version]) => ({ file, version }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

registerVersion("js/version.js", 1);
