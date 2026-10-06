// Minimal RFC 6455 WebSocket client over a unix socket (Bun.connect).
// Needed because Bun's WebSocket client cannot dial unix sockets, and the Codex
// app-server daemon speaks WebSocket on ~/.codex/app-server-control/app-server-control.sock.
import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class UnixWebSocket {
  private sock: any = null;
  private buf = Buffer.alloc(0);
  private handshakeDone = false;
  private key = randomBytes(16).toString("base64");
  private fragments: Buffer[] = [];
  private outQueue: Buffer[] = [];
  onmessage: (text: string) => void = () => {};
  onclose: (reason: string) => void = () => {};

  constructor(
    private sockPath: string,
    private reqPath = "/",
  ) {}

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("handshake timeout"));
        this.sock?.end();
      }, timeoutMs);
      const self = this;
      Bun.connect({
        unix: this.sockPath,
        socket: {
          open(s) {
            self.sock = s;
            self.writeRaw(
              Buffer.from(
                `GET ${self.reqPath} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                  `Sec-WebSocket-Key: ${self.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
              ),
            );
          },
          data(_s, chunk) {
            self.buf = Buffer.concat([self.buf, Buffer.from(chunk)]);
            if (!self.handshakeDone) {
              const end = self.buf.indexOf("\r\n\r\n");
              if (end < 0) return;
              const head = self.buf.subarray(0, end).toString("latin1");
              self.buf = self.buf.subarray(end + 4);
              const expect = createHash("sha1").update(self.key + GUID).digest("base64");
              if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(expect.toLowerCase())) {
                clearTimeout(timer);
                reject(new Error(`bad handshake: ${head.split("\r\n")[0]}`));
                self.sock.end();
                return;
              }
              self.handshakeDone = true;
              clearTimeout(timer);
              resolve();
            }
            self.parseFrames();
          },
          drain() {
            self.flush();
          },
          close() {
            clearTimeout(timer);
            self.onclose("closed");
          },
          error(_s, err) {
            clearTimeout(timer);
            reject(err);
            self.onclose(String(err));
          },
        },
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private parseFrames() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= this.buf[maskOff + (i % 4)];
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) {
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.sock?.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          try {
            this.onmessage(msg);
          } catch (e) {
            console.error("[wsunix] onmessage error", e);
          }
        }
      }
    }
  }

  send(text: string) {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  private sendFrame(opcode: number, payload: Buffer) {
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = 0x80 | len;
    else if (len < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
    this.writeRaw(Buffer.concat([header, mask, body]));
  }

  private writeRaw(b: Buffer) {
    this.outQueue.push(b);
    this.flush();
  }

  private flush() {
    while (this.sock && this.outQueue.length) {
      const b = this.outQueue[0];
      const n = this.sock.write(b);
      if (n < b.length) {
        this.outQueue[0] = b.subarray(Math.max(n, 0));
        return; // wait for drain
      }
      this.outQueue.shift();
    }
  }

  close() {
    try {
      this.sendFrame(0x8, Buffer.from([0x03, 0xe8]));
    } catch {}
    this.sock?.end();
  }
}
