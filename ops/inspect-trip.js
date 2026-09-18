// Inspect a trip's op-log AS THE HUB HOLDS IT — the decisive "did everything
// actually reach the hub?" check.
//
// The hub stores one append-only JSONL file per trip (`<data>/logs/<trip>.jsonl`),
// one op per line. Modern ops are ENCRYPTED envelopes ({e:1,id,k,iv,ct}); the hub
// is blind to their contents, so this tool takes the trip key (the `#k=` fragment
// from the share link) and decrypts them locally with the SAME core code the
// client uses — then folds the whole set with the SAME reducer and prints what the
// board would render: how many travellers, which ones, and a per-op-type tally.
//
// This answers the question directly: if the hub's own fold shows 3 travellers,
// the missing op never reached the hub (a send-side problem on the phone that made
// it); if it shows 4, the hub has everything and a device showing 3 is dropping /
// conflicting locally. It is READ-ONLY — it never writes to or mutates the log.
//
// Usage (dependency-free, run on the hub host or anywhere with the JSONL + key):
//   node ops/inspect-trip.js --file /path/to/<trip>.jsonl --key <base64url>
//   node ops/inspect-trip.js --dir ./siano_data/logs --trip <tripId> --key <b64url>
//   node ops/inspect-trip.js --file <trip>.jsonl --url 'https://host/t/<id>#k=<b64url>'
//   node ops/inspect-trip.js --file <trip>.jsonl            # plaintext trips (no key)
//
// The key never leaves this process; nothing is sent anywhere.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opId } from "../client/js/core/lamport.js";
import { fold } from "../client/js/core/reducer.js";
import { buildSnapshot } from "../client/js/core/snapshot.js";
import { importTripKey, makeTripCrypto, subtleAvailable } from "../client/js/core/crypto.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

// Pull the `#k=<token>` out of a full share URL (the key rides in the fragment).
function keyFromUrl(url) {
  const h = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const m = h.match(/(?:^|&)k=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  let file = args.file;
  if (!file && args.trip) {
    const dir = args.dir || path.resolve(__dirname, "../siano_data/logs");
    file = path.join(dir, encodeURIComponent(args.trip) + ".jsonl");
  }
  if (!file) {
    console.error("usage: node ops/inspect-trip.js --file <trip>.jsonl [--key <b64url> | --url <share-url>]");
    console.error("       node ops/inspect-trip.js --dir <logs> --trip <id> --key <b64url>");
    process.exit(2);
  }
  const key = args.key || (args.url ? keyFromUrl(String(args.url)) : null);

  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}\n(the hub had NO ops for this trip — nothing was ever synced up)`);
    process.exit(1);
  }

  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const raw = [];
  let torn = 0;
  for (const line of lines) {
    try { raw.push(JSON.parse(line)); } catch { torn++; }
  }

  const encrypted = raw.filter((o) => o && o.e).length;
  let crypto = null;
  if (key) {
    if (!subtleAvailable()) { console.error("Web Crypto unavailable in this Node — cannot decrypt"); process.exit(1); }
    crypto = makeTripCrypto(await importTripKey(String(key)));
  }

  // Decrypt (or pass through plaintext) into the plain ops the reducer eats.
  const ops = [];
  let failed = 0;
  for (const o of raw) {
    if (o && o.e) {
      if (!crypto) { failed++; continue; } // encrypted but no key given
      try { ops.push(await crypto.decrypt(o)); } catch { failed++; }
    } else {
      ops.push(o); // legacy plaintext op
    }
  }

  // Per-op-type tally + the raw add/remove_member events (before merge).
  const byType = {};
  const memberEvents = [];
  for (const op of ops) {
    byType[op.op] = (byType[op.op] || 0) + 1;
    if (op.op === "add_member") memberEvents.push({ kind: "add", id: op.memberId, name: op.name, lamport: op.lamport, device: op.device });
    if (op.op === "remove_member") memberEvents.push({ kind: "remove", id: op.memberId, lamport: op.lamport, device: op.device });
  }

  // The decisive part: fold the hub's op set exactly as a device would, and show
  // the travellers the board WOULD render from what the hub holds.
  const trip = args.trip || path.basename(file, ".jsonl");
  const snap = buildSnapshot(fold(trip, ops));

  console.log(`\n=== trip ${trip} — as the HUB holds it ===`);
  console.log(`file                : ${file}`);
  console.log(`lines on disk       : ${lines.length}${torn ? ` (+${torn} torn/unparseable)` : ""}`);
  console.log(`ops parsed          : ${raw.length}  (encrypted envelopes: ${encrypted}${key ? "" : " — NO KEY GIVEN, add --key to decrypt"})`);
  if (failed) console.log(`ops NOT decrypted   : ${failed}  ⚠ (wrong key, or missing key for encrypted ops)`);
  console.log(`op types            : ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join("  ") || "(none readable)"}`);

  console.log(`\nadd/remove_member events on the hub (${memberEvents.length}):`);
  for (const e of memberEvents) {
    console.log(`  ${e.kind === "add" ? "+" : "−"} ${e.id}  ${e.kind === "add" ? JSON.stringify(e.name) : ""}  @${e.lamport}.${e.device}`);
  }

  console.log(`\n>>> travellers the hub's op-set folds to: ${snap.members.length}`);
  for (const m of snap.members) console.log(`      • ${m.name}  (${m.id})`);
  console.log(`>>> bills: ${snap.billCount}\n`);

  if (!key && encrypted) {
    console.log("This trip is encrypted — pass --key <token from the #k= in the share link>");
    console.log("to decrypt and see the traveller names + the folded count above.\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
