// A minimal, dependency-free WebSocket server (RFC 6455) over Node's http
// upgrade. Node ships a WebSocket *client* but no server, and we don't want to
// pull in `ws` — the hub should run with nothing but `node hub/server.js`,
// mirroring the reference app's "no extra moving parts" spirit. This handles
// exactly what the relay needs: the handshake, masked client text frames
// (including fragmentation and 16/64-bit lengths), ping/pong, and close.
// Swap in `ws` later if you need per-message deflate or subprotocols.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WebSocketServer extends EventEmitter {
  constructor(httpServer) {
    super();
    httpServer.on("upgrade", (req, socket) => this._upgrade(req, socket));
  }

  _upgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.emit("connection", new Conn(socket, req), req);
  }
}

class Conn extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOpcode = null;
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => {
      this.alive = false;
      this.emit("close");
    });
    socket.on("error", () => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // Parse as many complete frames as the buffer currently holds.
    while (this._parseFrame());
  }

  // Returns true if it consumed a full frame (so the caller should try again).
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let mask;
    if (masked) {
      if (buf.length < offset + 4) return false;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return false; // whole payload not here yet

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
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
        return;
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: // binary
        if (opcode !== 0x0) {
          this._fragOpcode = opcode;
          this._frags = [];
        }
        this._frags.push(payload);
        if (fin) {
          const full = Buffer.concat(this._frags);
          const op = this._fragOpcode;
          this._frags = [];
          this._fragOpcode = null;
          if (op === 0x1) this.emit("message", full.toString("utf8"));
          // binary frames are ignored — the sync protocol is JSON text
        }
        return;
      default:
        this.close();
    }
  }

  send(str) {
    this._sendFrame(0x1, Buffer.from(str, "utf8"));
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

  close() {
    if (!this.alive) return;
    this.alive = false;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* already closing */
    }
  }
}
