// A minimal, dependency-free WebSocket server (RFC 6455) over Node's http
// upgrade. Node ships a WebSocket *client* but no server, and we don't want to
// pull in `ws` — the hub should run with nothing but `node hub/server.js`,
// mirroring the reference app's "no extra moving parts" spirit.
//
// Hardened for a hostile internet (it sits behind Cloudflare, but abusive
// traffic still reaches it through the tunnel):
//   - every frame length is bounded BEFORE any payload is buffered, so a client
//     can never make the parser allocate unbounded memory (the key DoS guard);
//   - client frames must be masked and carry no reserved bits (RFC 6455 §5), and
//     control frames must be short and un-fragmented, else the connection is
//     closed with the proper status code;
//   - the server tracks connections so callers can cap concurrency, run a
//     heartbeat, and close everything on shutdown.
// Swap in `ws` later if you need permessage-deflate or subprotocols.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Close codes we use (RFC 6455 §7.4.1).
const CLOSE_PROTOCOL = 1002;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

export class WebSocketServer extends EventEmitter {
  /**
   * @param {import("node:http").Server} httpServer
   * @param {{
   *   maxMessageBytes?: number,   // largest single (possibly fragmented) message
   *   maxConnections?: number,    // hard cap on concurrent sockets
   *   allowedOrigins?: Set<string>|null, // if set, Origin must be a member
   * }} [opts]
   */
  constructor(httpServer, opts = {}) {
    super();
    this.maxMessageBytes = opts.maxMessageBytes ?? 256 * 1024;
    this.maxConnections = opts.maxConnections ?? 500;
    this.allowedOrigins = opts.allowedOrigins ?? null;
    this.connections = new Set();
    httpServer.on("upgrade", (req, socket) => this._upgrade(req, socket));
  }

  _reject(socket, status, reason) {
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\n` +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n\r\n",
      );
      socket.destroy();
    } catch {
      /* socket already gone */
    }
  }

  _upgrade(req, socket) {
    if ((req.headers.upgrade || "").toLowerCase() !== "websocket") {
      return this._reject(socket, 400, "Bad Request");
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) return this._reject(socket, 400, "Bad Request");

    // Origin allowlist: browsers always send Origin, so an unexpected or missing
    // Origin from a browser is rejected. (Only enforced when configured, so
    // non-browser clients still work by default.)
    if (this.allowedOrigins) {
      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins.has(origin)) {
        return this._reject(socket, 403, "Forbidden");
      }
    }

    if (this.connections.size >= this.maxConnections) {
      return this._reject(socket, 503, "Service Unavailable");
    }

    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn = new Conn(socket, req, this.maxMessageBytes);
    this.connections.add(conn);
    conn.on("close", () => this.connections.delete(conn));
    this.emit("connection", conn, req);
  }

  /** Close every live connection (used on graceful shutdown). */
  closeAll(code = 1001) {
    for (const conn of this.connections) conn.close(code);
  }
}

class Conn extends EventEmitter {
  constructor(socket, req, maxMessageBytes) {
    super();
    this.socket = socket;
    this.req = req;
    this.maxMessageBytes = maxMessageBytes;
    this.alive = true;
    this.isAlive = true; // heartbeat flag (set on any inbound traffic / pong)
    this.lastActivity = Date.now();
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOpcode = null;
    this._fragBytes = 0;
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => {
      this.alive = false;
      this.emit("close");
    });
    socket.on("error", () => {
      this.alive = false;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });
  }

  _onData(chunk) {
    this.lastActivity = Date.now();
    this.isAlive = true;
    this._buf = Buffer.concat([this._buf, chunk]);
    // A single frame's header+payload can never exceed max + a small header
    // allowance; if the buffer blows past that, the peer is misbehaving.
    if (this._buf.length > this.maxMessageBytes + 14) {
      return this._fail(CLOSE_TOO_BIG, "frame too large");
    }
    try {
      while (this._parseFrame());
    } catch {
      this._fail(CLOSE_PROTOCOL, "protocol error");
    }
  }

  // Returns true if it consumed a full frame (so the caller should try again).
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;

    if (rsv !== 0) return this._fail(CLOSE_PROTOCOL, "reserved bits set"), false;
    // Per RFC 6455 §5.1 every client-to-server frame MUST be masked.
    if (!masked) return this._fail(CLOSE_PROTOCOL, "unmasked client frame"), false;

    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(this.maxMessageBytes)) return this._fail(CLOSE_TOO_BIG, "too large"), false;
      len = Number(big);
      offset += 8;
    }
    // Reject an oversized frame BEFORE waiting to buffer its payload.
    if (len > this.maxMessageBytes) return this._fail(CLOSE_TOO_BIG, "too large"), false;
    // Control frames (>=0x8) must be <=125 bytes and never fragmented.
    if (opcode >= 0x8 && (len > 125 || !fin)) return this._fail(CLOSE_PROTOCOL, "bad control frame"), false;

    if (buf.length < offset + 4) return false; // mask key not fully arrived
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    if (buf.length < offset + len) return false; // whole payload not here yet

    const masked_payload = buf.subarray(offset, offset + len);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = masked_payload[i] ^ mask[i & 3];

    this._buf = buf.subarray(offset + len);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close
        this.close();
        return;
      case 0x9: // ping -> pong
        this._sendFrame(0xa, payload);
        return;
      case 0xa: // pong
        this.isAlive = true;
        return;
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: { // binary
        if (opcode !== 0x0) {
          this._fragOpcode = opcode;
          this._frags = [];
          this._fragBytes = 0;
        } else if (this._fragOpcode === null) {
          return this._fail(CLOSE_PROTOCOL, "unexpected continuation");
        }
        this._fragBytes += payload.length;
        // Bound the total across all fragments of one message, not just one frame.
        if (this._fragBytes > this.maxMessageBytes) return this._fail(CLOSE_TOO_BIG, "message too large");
        this._frags.push(payload);
        if (fin) {
          const full = Buffer.concat(this._frags);
          const op = this._fragOpcode;
          this._frags = [];
          this._fragOpcode = null;
          this._fragBytes = 0;
          if (op === 0x1) this.emit("message", full.toString("utf8"));
          // binary frames are ignored — the sync protocol is JSON text
        }
        return;
      }
      default:
        this._fail(CLOSE_PROTOCOL, "bad opcode");
    }
  }

  send(str) {
    this._sendFrame(0x1, Buffer.from(str, "utf8"));
  }

  /** Send a heartbeat ping (the server sweeps for missing pongs). */
  ping() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  _sendFrame(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode; server frames are never masked
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      /* peer gone */
    }
  }

  // Send a close frame carrying a status code, then tear the socket down.
  _fail(code, _reason) {
    this.close(code);
    return false;
  }

  close(code = 1000) {
    if (!this.alive) return;
    this.alive = false;
    try {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      this._sendCloseFrame(body);
      this.socket.end();
    } catch {
      /* already closing */
    }
  }

  _sendCloseFrame(body) {
    const header = Buffer.alloc(2);
    header[0] = 0x88; // FIN + close
    header[1] = body.length;
    try {
      this.socket.write(Buffer.concat([header, body]));
    } catch {
      /* peer gone */
    }
  }

  /** Hard, immediate teardown (heartbeat reaper for dead peers). */
  terminate() {
    this.alive = false;
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}
