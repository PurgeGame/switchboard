// SIMULATOR (not a real provider): fake Claude Code sessions for tests and e2e.
// Writes the same on-disk shapes Claude Code does, into a directory we control:
//   <home>/sessions/<pid>.json                         the live registry
//   <home>/projects/<cwd-encoded>/<sessionId>.jsonl    the transcript
// Each fake session is backed by a real, harmless `sleep` process so /proc validation
// (pid alive, start time matches) passes exactly as it does for a real session.
// Nothing here touches ~/.claude, ~/.codex or any real session.
import { spawn, type Subprocess } from "bun";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClaudeProjectDir } from "../../src/daemon/adapters/claude.ts";
import { readStat } from "../../src/daemon/proc.ts";

export interface SimSession {
  sessionId: string;
  name: string;
  cwd: string;
  pid: number;
  transcript: string;
  proc: Subprocess;
}

export class ClaudeSim {
  readonly home: string;
  readonly sessionsDir: string;
  readonly projectsDir: string;
  readonly sessions = new Map<string, SimSession>();
  private seq = 0;
  private clock: number;

  /** home: where to put the fake ~/.claude tree (default: a fresh temp dir). */
  constructor(home?: string) {
    this.home = home ?? mkdtempSync(join(tmpdir(), "sb-sim-"));
    this.sessionsDir = join(this.home, "sessions");
    this.projectsDir = join(this.home, "projects");
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.projectsDir, { recursive: true });
    this.clock = Date.now();
  }

  /** Create a live fake session (registry file + empty transcript + backing process). */
  start(name: string, opts: { cwd?: string; status?: "idle" | "busy" | "waiting" } = {}): SimSession {
    const sessionId = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    const cwd = opts.cwd ?? `/sim/${name}`;
    const proc = spawn(["sleep", "3600"], { stdout: "ignore", stderr: "ignore" });
    const st = readStat(proc.pid)!;
    const dir = join(this.projectsDir, encodeClaudeProjectDir(cwd));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, `${sessionId}.jsonl`);
    writeFileSync(transcript, "");
    const s: SimSession = { sessionId, name, cwd, pid: proc.pid, transcript, proc };
    this.sessions.set(sessionId, s);
    this.writeRegistry(s, opts.status ?? "idle", st.startTime);
    return s;
  }

  private writeRegistry(s: SimSession, status: string, procStart: number) {
    writeFileSync(
      join(this.sessionsDir, `${s.pid}.json`),
      JSON.stringify({ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, startedAt: this.clock, procStart: String(procStart), kind: "interactive", entrypoint: "cli", name: s.name, status, statusUpdatedAt: Date.now(), version: "sim" }),
    );
  }

  setStatus(s: SimSession, status: "idle" | "busy" | "waiting") {
    this.writeRegistry(s, status, readStat(s.pid)!.startTime);
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private append(s: SimSession, rec: Record<string, unknown>) {
    appendFileSync(s.transcript, JSON.stringify({ uuid: `sim-${s.sessionId.slice(-4)}-${++this.seq}`, timestamp: this.tick(), cwd: s.cwd, sessionId: s.sessionId, ...rec }) + "\n");
  }

  user(s: SimSession, text: string) {
    this.append(s, { type: "user", message: { role: "user", content: text }, origin: { kind: "human" } });
  }
  assistant(s: SimSession, text: string) {
    this.append(s, { type: "assistant", message: { id: `m${this.seq}`, role: "assistant", model: "sim-model", content: [{ type: "text", text }], stop_reason: "end_turn" } });
  }
  turnEnd(s: SimSession, durationMs = 1000) {
    this.append(s, { type: "system", subtype: "turn_duration", durationMs });
  }
  /** A complete turn: prompt, reply, turn end. */
  turn(s: SimSession, prompt: string, reply: string) {
    this.user(s, prompt);
    this.assistant(s, reply);
    this.turnEnd(s);
  }

  /** The session goes away: its process dies. The registry file stays behind, as it does after a crash. */
  kill(s: SimSession) {
    s.proc.kill("SIGKILL");
  }

  async stop() {
    for (const s of this.sessions.values()) s.proc.kill("SIGKILL");
    await Promise.all([...this.sessions.values()].map((s) => s.proc.exited));
  }

  async cleanup() {
    await this.stop();
    rmSync(this.home, { recursive: true, force: true });
  }
}
