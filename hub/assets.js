// Runtime asset fingerprinting — content-hashed URLs without a build step.
//
// The client is plain ESM served as static files (no bundler). To let a CDN
// cache the JS/CSS *forever* and still pick up a new release without a purge,
// their URLs must change when their bytes change. This module does that at hub
// startup, in memory: it reads the client dir, rewrites the ESM import graph +
// index.html + the service worker to point at content-hashed URLs, and returns
// the rewritten bytes for the hub to serve.
//
// The files on disk are never touched — there are no build artifacts and the dev
// workflow is unchanged (edit a source file, restart `node hub/server.js`). The
// fingerprinting is purely a concern of the static server.
//
// How the hashes are kept consistent across the module graph: imports are
// relative (`./ui/board.js`), and a module's hash depends on its bytes, which
// include its (rewritten) import URLs — so a module can only be hashed once all
// its dependencies have hashed names. We therefore hash JS in dependency order
// (leaves first). index.html and the service worker keep their stable URLs (they
// are the tiny no-cache bootstrap layer) but have their references rewritten.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ENTRY = "/index.html";
const SW = "/service-worker.js";
const DYNAMIC = new Set(["/env.js"]); // generated per-request, never fingerprinted

const hashOf = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 10);
const isJs = (u) => u.endsWith(".js");
const dirOf = (url) => url.slice(0, url.lastIndexOf("/")); // "/js/app.js" -> "/js"
const resolveSpec = (importerUrl, spec) =>
  path.posix.normalize(path.posix.join(dirOf(importerUrl), spec));

// Relative import/export specifiers only (start with ./ or ../). Bare/external
// specifiers (none here) and `import(...)` inside JSDoc comments are ignored:
// `from "x"` covers static import/export-from; `import "x"` covers side-effect
// imports (the leading quote can't follow the `import` in `import x from …`).
const REL_FROM = /\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/g;
const REL_SIDE = /\bimport\s*(['"])(\.\.?\/[^'"]+)\1/g;

function specifiers(src) {
  const found = new Set();
  let m;
  REL_FROM.lastIndex = 0;
  while ((m = REL_FROM.exec(src))) found.add(m[2]);
  REL_SIDE.lastIndex = 0;
  while ((m = REL_SIDE.exec(src))) found.add(m[2]);
  return [...found];
}

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, base, out);
    else out.push("/" + path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

// Insert the hash before the extension: "/js/ui/board.js" -> "/js/ui/board.<h>.js".
function hashedName(url, buf) {
  const ext = path.posix.extname(url);
  return `${url.slice(0, url.length - ext.length)}.${hashOf(buf)}${ext}`;
}

// Replace every quoted occurrence of `orig` with `next` (both quote styles).
const replaceQuoted = (text, orig, next) =>
  text.split(`"${orig}"`).join(`"${next}"`).split(`'${orig}'`).join(`'${next}'`);

/**
 * Fingerprint the client dir.
 * @returns {{ hashedContent: Map<string,Buffer>, entry: Buffer, sw: Buffer|null }}
 *   hashedContent maps each new hashed URL to its (rewritten) bytes; entry/sw are
 *   the rewritten index.html / service worker, still served at their stable URLs.
 * @throws if the import graph has a cycle (caller falls back to no hashing).
 */
export function buildAssets(clientDir) {
  const urls = walk(clientDir);
  const abs = (u) => path.join(clientDir, u);
  const raw = new Map(urls.map((u) => [u, fs.readFileSync(abs(u))]));

  const fingerprintable = urls.filter((u) => u !== ENTRY && u !== SW && !DYNAMIC.has(u));
  const jsFiles = fingerprintable.filter(isJs);

  // Dependency graph among local JS modules.
  const deps = new Map();
  for (const u of jsFiles) {
    const ds = specifiers(raw.get(u).toString("utf8"))
      .map((s) => resolveSpec(u, s))
      .filter((d) => raw.has(d) && isJs(d));
    deps.set(u, ds);
  }

  // Topological order (dependencies before dependents); reject cycles.
  const order = [];
  const state = new Map(); // 0/undefined = unseen, 1 = on stack, 2 = done
  const visit = (u) => {
    const s = state.get(u) || 0;
    if (s === 2) return;
    if (s === 1) throw new Error(`import cycle through ${u}`);
    state.set(u, 1);
    for (const d of deps.get(u) || []) visit(d);
    state.set(u, 2);
    order.push(u);
  };
  for (const u of jsFiles) visit(u);

  const hashedUrl = new Map(); // origUrl -> hashedUrl
  const hashedContent = new Map(); // hashedUrl -> Buffer

  // Non-JS fingerprintable assets are leaves here: app.css is self-contained and
  // the manifest has no icon URLs, so none reference another local file.
  for (const u of fingerprintable.filter((x) => !isJs(x))) {
    const buf = raw.get(u);
    const h = hashedName(u, buf);
    hashedUrl.set(u, h);
    hashedContent.set(h, buf);
  }

  // JS in dependency order: rewrite each module's relative imports to the
  // already-hashed dependency names, then hash the rewritten bytes.
  for (const u of order) {
    let src = raw.get(u).toString("utf8");
    for (const spec of specifiers(src)) {
      const h = hashedUrl.get(resolveSpec(u, spec));
      if (!h) continue;
      const next = spec.slice(0, spec.lastIndexOf("/") + 1) + path.posix.basename(h);
      src = replaceQuoted(src, spec, next);
    }
    const buf = Buffer.from(src, "utf8");
    const h = hashedName(u, buf);
    hashedUrl.set(u, h);
    hashedContent.set(h, buf);
  }

  // Rewrite absolute references in the two stable-URL files.
  const rewriteAbs = (text) => {
    for (const [orig, h] of hashedUrl) text = replaceQuoted(text, orig, h);
    return text;
  };
  const entry = Buffer.from(rewriteAbs(raw.get(ENTRY).toString("utf8")), "utf8");

  // The service worker's SHELL now lists hashed URLs; stamp its CACHE name with
  // a per-build hash too, so the SW's own `activate` cleanup (which deletes any
  // cache whose key !== CACHE) evicts the previous build's entries instead of
  // letting old hashed assets pile up in the client cache across deploys.
  let sw = null;
  if (raw.has(SW)) {
    let text = rewriteAbs(raw.get(SW).toString("utf8"));
    const v = hashOf(Buffer.from(text, "utf8"));
    text = text.replace(/(const\s+CACHE\s*=\s*["'])[^"']*(["'])/, `$1siano-shell-${v}$2`);
    sw = Buffer.from(text, "utf8");
  }

  return { hashedContent, entry, sw, count: hashedUrl.size };
}
