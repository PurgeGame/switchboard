// Polling JSONL tailer: survives partial writes, truncation, and file replacement,
// and resumes from a persisted offset after a daemon restart.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface TailOptions {
  /** On first sight of a file, only read this many trailing bytes (history cap). */
  initialMaxBytes?: number;
  pollMs?: number;
  getOffset?: (path: string) => { ino: number; offset: number } | null;
  setOffset?: (path: string, ino: number, offset: number) => void;
}

export type LineHandler = (obj: any, meta: { offset: number; path: string }) => void;

export class JsonlTail {
  private offset = 0;
  private ino = -1;
  private partial: Buffer = Buffer.alloc(0);
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    readonly path: string,
    private onLine: LineHandler,
    private opts: TailOptions = {},
  ) {}

  start() {
    const saved = this.opts.getOffset?.(this.path);
    try {
      const st = statSync(this.path);
      if (saved && saved.ino === st.ino && saved.offset <= st.size) {
        this.ino = saved.ino;
        this.offset = saved.offset;
      } else {
        this.ino = st.ino;
        const max = this.opts.initialMaxBytes ?? Infinity;
        this.offset = st.size > max ? this.alignToLine(st.size - max) : 0;
      }
    } catch {
      // file not there yet; poll() will pick it up
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 700);
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Move a byte offset forward to just after the next newline. */
  private alignToLine(pos: number): number {
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      let p = pos;
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, p);
        if (n <= 0) return p;
        const i = buf.subarray(0, n).indexOf(10);
        if (i >= 0) return p + i + 1;
        p += n;
      }
    } finally {
      closeSync(fd);
    }
  }

  poll() {
    if (this.stopped) return;
    let st;
    try {
      st = statSync(this.path);
    } catch {
      return;
    }
    if (st.ino !== this.ino || st.size < this.offset) {
      // replaced or truncated: start over
      this.ino = st.ino;
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (st.size === this.offset) return;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      while (this.offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - this.offset), this.offset);
        if (n <= 0) break;
        // Work in bytes: 0x0A never occurs inside a UTF-8 multi-byte sequence,
        // so splitting on it is safe even when a read ends mid-character.
        let lineOffset = this.offset - this.partial.length;
        const data = Buffer.concat([this.partial, buf.subarray(0, n)]);
        this.offset += n;
        let start = 0;
        for (let i = data.indexOf(10); i >= 0; i = data.indexOf(10, start)) {
          const line = data.subarray(start, i);
          this.handle(line, lineOffset);
          lineOffset += i - start + 1;
          start = i + 1;
        }
        this.partial = Buffer.from(data.subarray(start));
      }
      // Persist only up to the last complete line.
      this.opts.setOffset?.(this.path, this.ino, this.offset - this.partial.length);
    } finally {
      closeSync(fd);
    }
  }

  private handle(line: Buffer, offset: number) {
    if (line.length === 0) return;
    let obj;
    try {
      obj = JSON.parse(line.toString("utf8"));
    } catch {
      return; // corrupt line: skip, never crash the tailer
    }
    try {
      this.onLine(obj, { offset, path: this.path });
    } catch (e) {
      console.error(`[tail] handler error for ${this.path}:`, e);
    }
  }
}

/** Read the first `maxLines` JSON lines of a file (for first prompt / session meta). */
export function readHead(path: string, maxLines = 50, maxBytes = 512 * 1024): any[] {
  const out: any[] = [];
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return out;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (n === maxBytes) lines.pop();
    for (const l of lines) {
      if (out.length >= maxLines) break;
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
  } finally {
    closeSync(fd);
  }
  return out;
}
