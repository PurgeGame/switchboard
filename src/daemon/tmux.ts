// Terminal injection for sessions running inside tmux (typical over SSH). Same guard as the
// VS Code bridge: before the paste and again before Enter, the agent must be alive, on the
// pane's tty, and the foreground job of that tty. Text goes in as a bracketed paste
// (tmux paste-buffer -p), so a shell that somehow received it would not execute it.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { userInfo } from "node:os";
import type { Session } from "../shared/types.ts";
import type { TerminalSender } from "./messaging.ts";
import { isForeground, readStat, ttyOf } from "./proc.ts";

interface Pane {
  socket: string;
  paneId: string;
  panePid: number;
  tty: string;
}

const run = (args: string[], input?: string) => spawnSync("tmux", args, { encoding: "utf8", timeout: 3000, input });

export class TmuxSender implements TerminalSender {
  private panes: Pane[] = [];
  private scannedAt = 0;

  /** All tmux servers owned by this user (default and -L sockets). */
  private scan() {
    if (Date.now() - this.scannedAt < 3000) return;
    this.scannedAt = Date.now();
    const dir = `/tmp/tmux-${userInfo().uid}`;
    let sockets: string[] = [];
    try {
      sockets = readdirSync(dir).map((f) => `${dir}/${f}`);
    } catch {}
    const out: Pane[] = [];
    for (const socket of sockets) {
      const r = run(["-S", socket, "list-panes", "-a", "-F", "#{pane_id} #{pane_pid} #{pane_tty}"]);
      if (r.status !== 0) continue;
      for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
        const [paneId, pid, tty] = line.split(" ");
        out.push({ socket, paneId, panePid: +pid, tty });
      }
    }
    this.panes = out;
  }

  paneFor(s: Session): Pane | null {
    if (!s.pid) return null;
    this.scan();
    const chain = new Set<number>();
    let p: number | undefined = s.pid;
    for (let i = 0; i < 8 && p && p > 1; i++) {
      chain.add(p);
      p = readStat(p)?.ppid;
    }
    return this.panes.find((x) => chain.has(x.panePid)) ?? null;
  }

  canSend(s: Session): boolean {
    return s.kind === "tui" && s.pidConfidence === "confirmed" && s.execution !== "ended" && this.paneFor(s) !== null;
  }

  private guard(s: Session, pane: Pane): string | null {
    const process = s.pid ? readStat(s.pid) : null;
    if (!process || process.state === "Z") return "the agent process is gone";
    if (s.meta.processStartTime !== undefined && s.meta.processStartTime !== process.startTime) return "the agent process has changed";
    if (ttyOf(process.pid) !== pane.tty) return "agent is not on this pane";
    if (!isForeground(process.pid)) return "the agent is not the pane's foreground process";
    return null;
  }

  private paste(pane: Pane, text: string): boolean {
    const buf = `sb-${process.pid}`;
    if (run(["-S", pane.socket, "load-buffer", "-b", buf, "-"], text.replaceAll("\x1b", "")).status !== 0) return false;
    return run(["-S", pane.socket, "paste-buffer", "-p", "-d", "-b", buf, "-t", pane.paneId]).status === 0;
  }

  async send(s: Session, text: string, images: string[] = []): Promise<{ ok: boolean; error?: string; wrote?: boolean }> {
    const pane = this.paneFor(s);
    if (!pane) return { ok: false, error: "no tmux pane for this session", wrote: false };
    const g = this.guard(s, pane);
    if (g) return { ok: false, error: `refused: ${g}`, wrote: false };
    for (const img of images) {
      if (!this.paste(pane, img)) return { ok: false, error: "tmux paste failed" };
      await Bun.sleep(150);
    }
    if (!this.paste(pane, text)) return { ok: false, error: "tmux paste failed" };
    await Bun.sleep(300);
    const again = this.guard(s, pane);
    if (again) return { ok: false, error: `pasted but not submitted: ${again}` };
    return run(["-S", pane.socket, "send-keys", "-t", pane.paneId, "Enter"]).status === 0 ? { ok: true } : { ok: false, error: "tmux send-keys failed" };
  }

  async quit(s: Session) {
    const pane = this.paneFor(s);
    if (!pane) return { ok: false, wrote: false, error: "no tmux pane for this session" };
    const guard = this.guard(s, pane);
    if (guard) return { ok: false, wrote: false, error: guard };
    if (run(["-S", pane.socket, "send-keys", "-t", pane.paneId, "C-c"]).status !== 0) return { ok: false, error: "tmux send-keys failed" };
    await Bun.sleep(300);
    return this.send(s, s.provider === "codex" ? "/quit" : "/exit");
  }

  async interrupt(s: Session): Promise<{ ok: boolean; error?: string; wrote?: boolean }> {
    const pane = this.paneFor(s);
    if (!pane) return { ok: false, error: "no tmux pane for this session", wrote: false };
    const g = this.guard(s, pane);
    if (g) return { ok: false, error: `refused: ${g}`, wrote: false };
    return run(["-S", pane.socket, "send-keys", "-t", pane.paneId, "Escape"]).status === 0 ? { ok: true } : { ok: false, error: "tmux send-keys failed" };
  }
}

/** VS Code bridge first, tmux second. */
export class CompositeTerminal implements TerminalSender {
  constructor(private senders: TerminalSender[]) {}
  private pick(s: Session) {
    return this.senders.find((x) => x.canSend(s)) ?? null;
  }
  canSend(s: Session) {
    return this.pick(s) !== null;
  }
  send(s: Session, text: string, images?: string[]) {
    return this.pick(s)?.send(s, text, images) ?? Promise.resolve({ ok: false, error: "no terminal for this session", wrote: false });
  }
  quit(s: Session) {
    const sender = this.pick(s);
    return sender?.quit?.(s) ?? sender?.send(s, s.provider === "codex" ? "/quit" : "/exit") ?? Promise.resolve({ ok: false, wrote: false, error: "no terminal for this session" });
  }
  interrupt(s: Session) {
    return this.pick(s)?.interrupt(s) ?? Promise.resolve({ ok: false, error: "no terminal for this session", wrote: false });
  }
}
