// The Siano sync hub: a dumb, durable relay + static file server.
//
// Run it with nothing but `node hub/server.js`. It:
//   1. serves the static client from ../client (so one process is the whole app), and
//   2. relays ops between devices on the same trip over WebSocket, persisting
//      every op to a durable append-only log (see log.js).
//
// There is deliberately NO business logic here — the hub cannot compute a
// balance and doesn't try to. Two hubs behind one shared log directory would be
// active-active; a single one is plenty for a trip splitter.
//
// Env: PORT (default 4000), SIANO_DATA_DIR (default ../siano_data).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "./ws.js";
import { TripLogs, isValidOp } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, "../client");

// ---- Static client ---------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  // A trip deep-link (/t/<id>) is a client route — serve the app shell.
  if (rel.startsWith("/t/")) rel = "/index.html";

  const full = path.join(CLIENT_DIR, path.normalize(rel));
  if (!full.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end("forbidden"); // path traversal
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}

// ---- Hub factory -----------------------------------------------------------

/**
 * Build a hub. Returns the http.Server (call `.listen()` yourself) plus the
 * TripLogs, so tests can spin one up on an ephemeral port and inspect the log.
 * @param {{dataDir?: string}} [opts]
 */
export function createHub(opts = {}) {
  const dataDir = opts.dataDir || process.env.SIANO_DATA_DIR ||
    path.resolve(__dirname, "../siano_data");
  const logs = new TripLogs(path.join(dataDir, "logs"));

  const httpServer = http.createServer(serveStatic);
  const rooms = new Map(); // trip -> Set<Conn>

  const join = (trip, conn) => {
    if (!rooms.has(trip)) rooms.set(trip, new Set());
    rooms.get(trip).add(conn);
  };
  const leave = (conn) => {
    const room = conn.trip && rooms.get(conn.trip);
    if (!room) return;
    room.delete(conn);
    if (room.size === 0) rooms.delete(conn.trip);
  };
  const fanout = (trip, obj, except) => {
    const room = rooms.get(trip);
    if (!room) return;
    const str = JSON.stringify(obj);
    for (const c of room) if (c !== except) c.send(str);
  };

  const wss = new WebSocketServer(httpServer);
  wss.on("connection", (conn) => {
    conn.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.t === "hello" && typeof msg.trip === "string") {
        conn.trip = msg.trip;
        join(msg.trip, conn);
        // Hand the newcomer everything it's missing (delta on reconnect).
        conn.send(JSON.stringify({ t: "sync", ops: logs.missing(msg.trip, msg.have) }));
        return;
      }

      if (!conn.trip) return; // must say hello first

      if (msg.t === "op" && isValidOp(msg.op)) {
        if (logs.append(conn.trip, msg.op)) fanout(conn.trip, { t: "op", op: msg.op }, conn);
      } else if (msg.t === "ops" && Array.isArray(msg.ops)) {
        const added = msg.ops.filter((op) => logs.append(conn.trip, op));
        if (added.length) fanout(conn.trip, { t: "ops", ops: added }, conn);
      }
    });

    conn.on("close", () => leave(conn));
  });

  return { httpServer, logs, dataDir };
}

// Auto-start only when run directly (`node hub/server.js`), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const PORT = Number(process.env.PORT || 4000);
  const { httpServer, dataDir } = createHub();
  httpServer.listen(PORT, () => {
    console.log(`siano hub listening on http://localhost:${PORT}`);
    console.log(`  serving client from ${CLIENT_DIR}`);
    console.log(`  op logs under        ${path.join(dataDir, "logs")}`);
  });
}
