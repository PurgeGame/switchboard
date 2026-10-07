// VS Code bridge hub: one WebSocket per VS Code window (extension in bridge/).
// - maps VS Code terminals to sessions through /proc ancestry (terminal shell pid -> agent pid)
// - guarded terminal injection: before every send AND before the Enter, the agent must be
//   alive, on the terminal's tty, and the foreground job of that tty. If the agent exited, the
//   shell would receive the text and could run it, so a failed check refuses the send.
// - bracketed paste: a shell that somehow got the text would not execute it (verified, bash 5.3)
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Session } from "../shared/types.ts";
import { cmdlineOf, isForeground, readStat, ttyOf } from "./proc.ts";
import type { TerminalSender } from "./messaging.ts";

export interface BridgeTerminal {
  id: string;
  name: string;
  processId: number | null;
  launchId?: string | null;
}

interface BridgeWindow {
  ws: any;
  windowId: string;
  folders: string[];
  terminals: BridgeTerminal[];
  capabilities: string[];
}

const ESC = "\x1b";
const managedRunner = `${import.meta.dir}/managed-terminal.py`;

export class BridgeHub implements TerminalSender {
  private windows = new Map<any, BridgeWindow>();
  private pending = new Map<string, { res: (v: any) => void; timer: any }>();
  /** Terminals Switchboard created itself (persisted): the only ones that accept raw input. */
  private launched = new Set<string>();
  private launchedFile: string | null = null;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.launchedFile = `${dataDir}/launched-terminals.json`;
      try {
        this.launched = new Set(JSON.parse(readFileSync(this.launchedFile, "utf8")));
      } catch {}
    }
  }

  /**
   * Listen on a unix socket inside the 0700 data dir: filesystem permissions authenticate
   * both ends (only this user can connect; the extension checks the dir before connecting).
   */
  listen(sockPath: string) {
    if (existsSync(sockPath)) unlinkSync(sockPath);
    const hub = this;
    const bufs = new WeakMap<any, string>();
    Bun.listen({
      unix: sockPath,
      socket: {
        open(sock) {
          bufs.set(sock, "");
          hub.open({ send: (s: string) => sock.write(s + "\n"), sock });
        },
        data(sock, chunk) {
          let buf = (bufs.get(sock) ?? "") + Buffer.from(chunk).toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            const conn = [...hub.windows.keys()].find((c) => c.sock === sock);
            if (conn) hub.message(conn, line);
          }
          bufs.set(sock, buf);
        },
        close(sock) {
          const conn = [...hub.windows.keys()].find((c) => c.sock === sock);
          if (conn) hub.close(conn);
        },
        error() {},
      },
    });
    chmodSync(sockPath, 0o600);
  }

  status() {
    return {
      windows: this.windows.size,
      terminals: [...this.windows.values()].reduce((n, w) => n + w.terminals.length, 0),
    };
  }

  open(ws: any) {
    this.windows.set(ws, { ws, windowId: "?", folders: [], terminals: [], capabilities: [] });
  }

  close(ws: any) {
    this.windows.delete(ws);
  }

  message(ws: any, raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const w = this.windows.get(ws);
    if (!w) return;
    if (m.type === "hello") {
      w.windowId = String(m.windowId ?? "?");
      w.folders = Array.isArray(m.workspaceFolders) ? m.workspaceFolders.map(String) : [];
      w.capabilities = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
    } else if (m.type === "terminals" && Array.isArray(m.terminals)) {
      w.terminals = m.terminals.map((t: any) => ({ id: String(t.id), name: String(t.name ?? ""), processId: typeof t.processId === "number" ? t.processId : null, launchId: typeof t.launchId === "string" ? t.launchId : null }));
    } else if (m.type === "result" && typeof m.reqId === "string") {
      const p = this.pending.get(m.reqId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.reqId);
        p.res(m);
      }
    }
  }

  private request(w: BridgeWindow, msg: Record<string, unknown>, timeoutMs = 5000): Promise<{ ok: boolean; data?: any; error?: string }> {
    const reqId = randomUUID();
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        res({ ok: false, error: "bridge timeout" });
      }, timeoutMs);
      this.pending.set(reqId, { res, timer });
      w.ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  /** The terminal whose shell is an ancestor of the session's agent process. */
  terminalFor(s: Session): { w: BridgeWindow; t: BridgeTerminal } | null {
    if (!s.pid) return null;
    const process = readStat(s.pid);
    if (!process || process.state === "Z" || (s.meta?.processStartTime !== undefined && s.meta.processStartTime !== process.startTime)) return null;
    const chain = new Set<number>();
    let p: number | undefined = s.pid;
    for (let i = 0; i < 8 && p && p > 1; i++) {
      chain.add(p);
      p = readStat(p)?.ppid;
    }
    const hits: { w: BridgeWindow; t: BridgeTerminal }[] = [];
    for (const w of this.windows.values()) for (const t of w.terminals) {
      if (!t.processId || !chain.has(t.processId)) continue;
      if (t.launchId) {
        const argv = cmdlineOf(t.processId);
        // The current process must still be our exact runner for this launch. A title,
        // inherited environment variable, or a recycled shell PID alone proves nothing.
        if (!this.launched.has(t.id) || t.id !== `managed-${t.launchId}` || argv[1] !== managedRunner || argv[2] !== t.launchId) continue;
      }
      hits.push({ w, t });
    }
    return hits.length === 1 ? hits[0] : null;
  }

  /** Only sessions whose agent pid is known for sure (never an inferred mapping). */
  canSend(s: Session): boolean {
    return s.kind === "tui" && s.pidConfidence === "confirmed" && s.execution !== "ended" && this.terminalFor(s) !== null;
  }

  private guard(s: Session, t: BridgeTerminal): string | null {
    const process = s.pid ? readStat(s.pid) : null;
    if (!process || process.state === "Z") return "the agent process is gone";
    if (s.meta.processStartTime !== undefined && s.meta.processStartTime !== process.startTime) return "the agent process has changed";
    if (!t.processId) return "terminal has no process";
    const agentTty = ttyOf(process.pid);
    if (!agentTty || agentTty !== ttyOf(t.processId)) return "agent is not on this terminal";
    if (!isForeground(process.pid)) return "the agent is not the terminal's foreground process";
    return null;
  }

  /**
   * images: pasted one per paste, before the text. Claude's TUI turns a lone pasted image path
   * into an attachment; inside a multi-line paste it stays plain text (verified both ways).
   */
  async send(s: Session, text: string, images: string[] = []): Promise<{ ok: boolean; error?: string; wrote?: boolean }> {
    const hit = this.terminalFor(s);
    if (!hit) return { ok: false, error: "no VS Code terminal for this session", wrote: false };
    const before = this.guard(s, hit.t);
    if (before) return { ok: false, error: `refused: ${before}`, wrote: false };
    // Strip ESC so the text cannot end the bracketed paste early.
    const paste = (x: string) => `${ESC}[200~${x.replaceAll(ESC, "")}${ESC}[201~`;
    for (const img of images) {
      const r = await this.request(hit.w, { type: "sendText", terminalId: hit.t.id, text: paste(img) });
      if (!r.ok) return { ok: false, error: r.error };
      await Bun.sleep(150);
    }
    const r1 = await this.request(hit.w, { type: "sendText", terminalId: hit.t.id, text: paste(text) });
    if (!r1.ok) return { ok: false, error: r1.error };
    await Bun.sleep(300);
    const again = this.guard(s, hit.t);
    if (again) return { ok: false, error: `pasted but not submitted: ${again}` };
    const r2 = await this.request(hit.w, { type: "sendText", terminalId: hit.t.id, text: "\r" });
    return r2.ok ? { ok: true } : { ok: false, error: r2.error };
  }

  async quit(s: Session) {
    const hit = this.terminalFor(s);
    if (!hit) return { ok: false, wrote: false, error: "no terminal for this session" };
    const guard = this.guard(s, hit.t);
    if (guard) return { ok: false, wrote: false, error: guard };
    // Ctrl-C cancels a draft or a modal so /quit cannot append to an unfinished prompt.
    const clear = await this.request(hit.w, { type: "sendText", terminalId: hit.t.id, text: "\x03" });
    if (!clear.ok) return { ok: false, error: clear.error };
    await Bun.sleep(300);
    return this.send(s, s.provider === "codex" ? "/quit" : "/exit");
  }

  async interrupt(s: Session): Promise<{ ok: boolean; error?: string; wrote?: boolean }> {
    const hit = this.terminalFor(s);
    if (!hit) return { ok: false, error: "no VS Code terminal for this session", wrote: false };
    const g = this.guard(s, hit.t);
    if (g) return { ok: false, error: `refused: ${g}`, wrote: false };
    const r = await this.request(hit.w, { type: "sendText", terminalId: hit.t.id, text: ESC });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async show(s: Session): Promise<{ ok: boolean; error?: string; wrote?: boolean }> {
    const hit = this.terminalFor(s);
    if (!hit) return { ok: false, error: "no VS Code terminal for this session", wrote: false };
    return this.request(hit.w, { type: "show", terminalId: hit.t.id });
  }

  /** Open a new VS Code terminal in the window that owns `cwd` (else any window) and run `command`. */
  async launch(cwd: string, name: string, command: string): Promise<{ ok: boolean; data?: any; error?: string }> {
    const wins = [...this.windows.values()];
    if (!wins.length) return { ok: false, error: "no VS Code window is connected (is the Switchboard Bridge extension installed?)" };
    const w = wins.find((x) => x.folders.some((f) => cwd === f || cwd.startsWith(f + "/"))) ?? wins[0];
    if (!w.capabilities.includes("managed-terminal-v1")) return { ok: false, error: "VS Code bridge lacks managed-terminal-v1; install bridge 0.1.2 and reload its extension before launching" };
    const runtime = Bun.which("python3");
    if (!runtime || process.platform !== "linux") return { ok: false, error: "managed terminals require Linux and python3 (child subreaping)" };
    const launchId = randomUUID();
    // Persist ownership before sending: a lost reply must not lose the launch's identity.
    this.launched.add(`managed-${launchId}`);
    if (this.launchedFile) writeFileSync(this.launchedFile, JSON.stringify([...this.launched]));
    const r = await this.request(w, { type: "createManaged", cwd, name, command, launchId, runtime, runner: managedRunner }, 10_000);
    if (r.ok && r.data?.terminalId) {
      this.launched.add(String(r.data.terminalId));
      if (this.launchedFile) writeFileSync(this.launchedFile, JSON.stringify([...this.launched]));
    }
    return r;
  }

  /** Was this terminal opened by Switchboard (Launcher, coordinator, perspectives)? */
  isLaunched(terminalId: string) {
    return this.launched.has(terminalId);
  }

  /** Open terminals Switchboard opened itself, with their names and shell pids. */
  launchedTerminals(): BridgeTerminal[] {
    return [...this.windows.values()].flatMap((w) => w.terminals).filter((t) => this.launched.has(t.id));
  }

  /** Raw keys (e.g. answering a startup prompt) — only for terminals Switchboard launched. */
  async sendRaw(terminalId: string, text: string): Promise<{ ok: boolean; error?: string; wrote?: boolean }> {
    if (!this.launched.has(terminalId)) return { ok: false, error: "only terminals launched by Switchboard accept raw input" };
    const w = [...this.windows.values()].find((x) => x.terminals.some((t) => t.id === terminalId));
    if (!w) return { ok: false, error: "terminal is gone" };
    return this.request(w, { type: "sendText", terminalId, text });
  }
}

/** POSIX single-quote a shell argument. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
