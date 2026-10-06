// Claude Code adapter. Discovery: ~/.claude/sessions/<pid>.json (the live registry),
// validated against /proc. History + live activity: transcript JSONL tail.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Execution } from "../../shared/types.ts";
import { paths } from "../config.ts";
import { ttyOf } from "../proc.ts";
import { parseClaudeRecord } from "./parse-claude.ts";
import type { Adapter, DiscoverCtx, Discovered } from "./types.ts";

export const encodeClaudeProjectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  procStart?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
  messagingSocketPath?: string;
  version?: string;
}

export class ClaudeAdapter implements Adapter {
  readonly provider = "claude" as const;
  readonly initialTranscriptBytes = 3 * 1024 * 1024;
  private claimed = new Set<number>();
  private transcriptCache = new Map<string, string>();

  constructor(private sessionsDir = paths.claudeSessions, private projectsDir = paths.claudeProjects) {}

  claimedPids() {
    return this.claimed;
  }

  private internal = new Map<string, boolean>();
  private isInternal(pid: number, startTime: number): boolean {
    const key = `${pid}:${startTime}`;
    let v = this.internal.get(key);
    if (v === undefined) {
      try {
        v = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((kv) => kv.startsWith("SB_INTERNAL="));
      } catch {
        v = false;
      }
      this.internal.set(key, v);
    }
    return v;
  }

  parse(record: unknown, sessionId: string, offsetKey: string) {
    return parseClaudeRecord(record, sessionId, offsetKey);
  }

  findTranscript(sessionId: string, cwd: string): string | null {
    const cached = this.transcriptCache.get(sessionId);
    if (cached && existsSync(cached)) return cached;
    const direct = join(this.projectsDir, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
    let found: string | null = existsSync(direct) ? direct : null;
    if (!found) {
      // cwd can differ from the project dir (long paths are hashed); search.
      try {
        for (const d of readdirSync(this.projectsDir)) {
          const f = join(this.projectsDir, d, `${sessionId}.jsonl`);
          if (existsSync(f)) {
            found = f;
            break;
          }
        }
      } catch {}
    }
    if (found) this.transcriptCache.set(sessionId, found);
    return found ?? direct; // the tailer waits for the file to appear
  }

  async discover(ctx: DiscoverCtx): Promise<Discovered[]> {
    const out: Discovered[] = [];
    const claimed = new Set<number>();
    let files: string[] = [];
    try {
      files = readdirSync(this.sessionsDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return out;
    }
    for (const f of files) {
      let e: RegistryEntry;
      try {
        e = JSON.parse(readFileSync(join(this.sessionsDir, f), "utf8"));
      } catch {
        continue;
      }
      const p = ctx.procs.get(e.pid);
      // Stale registry file: pid gone or reused by another process.
      if (!p || p.state === "Z" || (e.procStart && String(p.startTime) !== String(e.procStart))) continue;
      if (this.isInternal(e.pid, p.startTime)) continue; // Switchboard's own classifier calls
      claimed.add(e.pid);

      const kind = e.entrypoint === "claude-vscode" ? "vscode" : e.kind === "interactive" ? "tui" : e.kind === "background" ? "background" : "headless";
      const limitations: string[] = [];
      let connection: Discovered["connection"] = "observe-only";
      if (kind === "tui") {
        limitations.push("Genuine user turns only through terminal injection (needs the VS Code bridge). Peer messages are labeled 'not typed by your user'.");
      } else if (kind === "vscode") {
        limitations.push("Owned by the VS Code extension: observe-only. Peer messages are held, then dropped, because the session runs bypassPermissions.");
      } else if (kind === "headless") {
        limitations.push("Headless session owned by another process: observe-only.");
      }

      const status = e.status;
      const execution: Execution = status === "busy" ? "working" : status === "waiting" ? "waiting_approval" : status === "idle" ? "idle" : "unknown";
      out.push({
        id: `claude:${e.sessionId}`,
        provider: "claude",
        kind,
        nativeId: e.sessionId,
        name: e.name ?? null,
        cwd: e.cwd,
        pid: e.pid,
        pidConfidence: "confirmed",
        tty: ttyOf(e.pid),
        transcriptPath: this.findTranscript(e.sessionId, e.cwd),
        connection,
        limitations,
        startedAt: e.startedAt ?? null,
        liveStatus: status ? { execution, confidence: "confirmed", detail: `registry: ${status}`, since: e.statusUpdatedAt ?? e.updatedAt } : undefined,
        meta: { entrypoint: e.entrypoint, version: e.version, messagingSocketPath: e.messagingSocketPath },
      });
    }
    this.claimed = claimed;
    return out;
  }
}
