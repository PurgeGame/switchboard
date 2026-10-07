// Codex adapter.
// - TUI sessions are threads hosted by the shared app-server daemon: discovered with
//   thread/loaded/list + thread/read (read-only), live status from the daemon.
// - The TUI process <-> thread mapping is not exposed anywhere, so it is inferred from
//   cwd + start time (or `codex resume <id>` on the command line) and labeled as such.
// - Sessions outside the daemon (embedded-mode TUIs, exec, VS Code extension) hold their
//   rollout file open, which identifies the owning process.
// - In daemon mode, tool commands run as children of the daemon, not the TUI.
import { readdirSync, readlinkSync } from "node:fs";
import type { Execution } from "../../shared/types.ts";
import { paths } from "../config.ts";
import { cmdlineOf, cwdOf, startedAtMs, ttyOf, type ProcInfo } from "../proc.ts";
import { CodexDaemonClient } from "./codex-daemon.ts";
import { parseCodexLine } from "./parse-codex.ts";
import type { Adapter, DiscoverCtx, Discovered } from "./types.ts";
import { readHead } from "../tail.ts";

interface ThreadInfo {
  id: string;
  cwd: string;
  name: string | null;
  preview: string;
  createdAtMs: number;
  updatedAtMs: number;
  path: string | null;
  model: string | null;
  originator: string | null;
  status: any;
}

/** Shared-daemon subagents are threads, not necessarily child processes. Include every ancestor. */
export function runningSubagentParents(threads: { id: string; parentThreadId: string | null; status: any }[]): Set<string> {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const parents = new Set<string>();
  for (const t of threads) {
    if (["idle", "notLoaded", "systemError"].includes(t.status?.type)) continue;
    const seen = new Set<string>([t.id]);
    let parent = t.parentThreadId;
    while (parent && !seen.has(parent)) {
      parents.add(parent);
      seen.add(parent);
      parent = byId.get(parent)?.parentThreadId ?? null;
    }
  }
  return parents;
}

export function codexExecution(status: any): { execution: Execution; detail: string } {
  if (!status) return { execution: "unknown", detail: "no status" };
  if (status.type === "active") {
    const flags: string[] = status.activeFlags ?? [];
    if (flags.includes("waitingOnApproval")) return { execution: "waiting_approval", detail: "daemon: waitingOnApproval" };
    if (flags.includes("waitingOnUserInput")) return { execution: "waiting_answer", detail: "daemon: waitingOnUserInput" };
    return { execution: "working", detail: "daemon: active" };
  }
  if (status.type === "idle") return { execution: "idle", detail: "daemon: idle" };
  if (status.type === "systemError") return { execution: "failed", detail: "daemon: systemError" };
  return { execution: "ended", detail: `daemon: ${status.type}` };
}

/** Assign each TUI process to at most one thread in the same cwd. Pure; unit-tested. */
export function mapTuisToThreads(
  tuis: { pid: number; cwd: string; startMs: number; resumeId?: string }[],
  threads: { id: string; cwd: string; createdAtMs: number; updatedAtMs: number }[],
): Map<string, { pid: number; confidence: "confirmed" | "inferred" }> {
  const out = new Map<string, { pid: number; confidence: "confirmed" | "inferred" }>();
  const used = new Set<number>();
  for (const t of tuis)
    if (t.resumeId && threads.some((th) => th.id === t.resumeId)) {
      out.set(t.resumeId, { pid: t.pid, confidence: "confirmed" });
      used.add(t.pid);
    }
  const cwds = new Set(threads.map((t) => t.cwd));
  for (const cwd of cwds) {
    const ths = threads.filter((t) => t.cwd === cwd && !out.has(t.id)).sort((a, b) => b.createdAtMs - a.createdAtMs);
    const procs = tuis.filter((p) => p.cwd === cwd && !used.has(p.pid)).sort((a, b) => b.startMs - a.startMs);
    // Pass 1: a thread belongs to the newest TUI that started before it was created.
    for (const th of ths) {
      const p = procs.find((p) => !used.has(p.pid) && p.startMs <= th.createdAtMs + 10_000);
      if (p) {
        out.set(th.id, { pid: p.pid, confidence: "inferred" });
        used.add(p.pid);
      }
    }
    // Pass 2: leftover TUIs (e.g. resumed threads) take the most recently updated leftover thread.
    const leftThreads = ths.filter((t) => !out.has(t.id)).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    for (const p of procs.filter((p) => !used.has(p.pid))) {
      const th = leftThreads.shift();
      if (!th) break;
      out.set(th.id, { pid: p.pid, confidence: "inferred" });
      used.add(p.pid);
    }
  }
  return out;
}

const isCodexBinary = (cmd: string[]) => /\/codex$/.test(cmd[0] ?? "") || cmd[0] === "codex";

export class CodexAdapter implements Adapter {
  readonly provider = "codex" as const;
  readonly initialTranscriptBytes = 3 * 1024 * 1024;
  readonly daemon: CodexDaemonClient;
  private claimed = new Set<number>();
  private threadCache = new Map<string, ThreadInfo>();
  private subagentParents = new Set<string>();
  private subagentStateKnown = false;
  private rolloutMeta = new Map<string, { id: string; cwd: string; originator: string | null; source: string | null }>();
  daemonPid: number | null = null;
  /**
   * TUI processes known for certain to host a thread (pid + its start time, so a reused pid
   * doesn't match): Switchboard launched them for it. They count like `codex resume <id>`.
   */
  private pins = new Map<number, { threadId: string; startTime: number }>();

  constructor(sockPath = paths.codexControlSock) {
    this.daemon = new CodexDaemonClient(sockPath);
  }

  pin(threadId: string, pid: number, startTime: number) {
    this.pins.set(pid, { threadId, startTime });
  }

  claimedPids() {
    return this.claimed;
  }

  parse(record: unknown, sessionId: string, offsetKey: string) {
    return parseCodexLine(record, sessionId, offsetKey);
  }

  private async daemonThreads(): Promise<ThreadInfo[]> {
    this.subagentStateKnown = false;
    if (!(await this.daemon.ensure())) return [];
    const loaded = await this.daemon.call<{ data: string[] }>("thread/loaded/list", {});
    const out: ThreadInfo[] = [];
    const families: { id: string; parentThreadId: string | null; status: any }[] = [];
    let complete = true;
    await Promise.all(
      loaded.data.map(async (id) => {
        try {
          const { thread: t } = await this.daemon.call<{ thread: any }>("thread/read", { threadId: id, includeTurns: false });
          const parentThreadId = t.parentThreadId ?? t.source?.subagent?.thread_spawn?.parent_thread_id ?? null;
          families.push({ id, parentThreadId, status: t.status });
          // Read even ephemeral children for the safety check; they don't own user terminals.
          if (parentThreadId || (t.ephemeral && !t.path)) return;
          const info: ThreadInfo = {
            id,
            cwd: t.cwd,
            name: t.name ?? null,
            preview: t.preview ?? "",
            createdAtMs: (t.createdAt ?? 0) * 1000,
            updatedAtMs: (t.updatedAt ?? 0) * 1000,
            path: t.path ?? null,
            model: t.model ?? null,
            originator: t.originator ?? null,
            status: t.status,
          };
          this.threadCache.set(id, info);
          out.push(info);
        } catch { complete = false; }
      }),
    );
    this.subagentParents = runningSubagentParents(families);
    this.subagentStateKnown = complete;
    return out;
  }

  /** rollout path -> pid, for processes that hold their rollout open (non-daemon sessions). */
  private rolloutOwners(codexPids: number[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const pid of codexPids) {
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const t = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (t.startsWith(paths.codexSessions) && t.endsWith(".jsonl")) m.set(t, pid);
        } catch {}
      }
    }
    return m;
  }

  private metaOf(rollout: string) {
    let m = this.rolloutMeta.get(rollout);
    if (!m) {
      const head = readHead(rollout, 1)[0];
      const p = head?.type === "session_meta" ? head.payload : null;
      if (!p) return null;
      m = { id: p.id, cwd: p.cwd, originator: p.originator ?? null, source: p.source ?? null };
      this.rolloutMeta.set(rollout, m);
    }
    return m;
  }

  async discover(ctx: DiscoverCtx): Promise<Discovered[]> {
    const out: Discovered[] = [];
    const claimed = new Set<number>();
    const codexProcs: ProcInfo[] = [];
    this.daemonPid = null;
    for (const p of ctx.procs.values()) {
      if (p.comm !== "codex" || p.state === "Z") continue;
      const cmd = cmdlineOf(p.pid);
      if (!isCodexBinary(cmd)) continue;
      if (cmd.includes("--managed-daemon")) this.daemonPid = p.pid;
      codexProcs.push(p);
      claimed.add(p.pid);
    }
    const owners = this.rolloutOwners(codexProcs.map((p) => p.pid));
    const ownerPids = new Set(owners.values());

    for (const [pid, pin] of this.pins) if (ctx.procs.get(pid)?.startTime !== pin.startTime) this.pins.delete(pid); // gone
    // TUI processes on the shared daemon: codex binary with a tty, no app-server, no rollout fd.
    const tuis = codexProcs
      .filter((p) => !ownerPids.has(p.pid))
      .map((p) => ({ p, cmd: cmdlineOf(p.pid), tty: ttyOf(p.pid) }))
      .filter(({ cmd, tty }) => tty && !cmd.includes("app-server"))
      .map(({ p, cmd, tty }) => {
        const ri = cmd.indexOf("resume");
        return { pid: p.pid, cwd: cwdOf(p.pid) ?? "", startMs: startedAtMs(p), resumeId: ri >= 0 ? cmd[ri + 1] : this.pins.get(p.pid)?.threadId, tty };
      });

    let threads: ThreadInfo[] = [];
    try {
      threads = await this.daemonThreads();
    } catch (e) {
      this.daemon.lastError = String(e);
    }
    const mapping = mapTuisToThreads(tuis, threads);
    const daemonKids = this.daemonPid ? (ctx.kids.get(this.daemonPid) ?? []) : [];

    for (const t of threads) {
      const m = mapping.get(t.id);
      const st = codexExecution(t.status);
      // A loaded thread with no terminal and no running turn is a closed TUI waiting to unload.
      if (!m && st.execution !== "working" && !st.execution.startsWith("waiting")) continue;
      // Attribute daemon children by cwd; ambiguous when several threads share a cwd.
      const sameCwd = threads.filter((o) => o.cwd === t.cwd);
      const active = sameCwd.filter((o) => o.status?.type === "active");
      const mine = sameCwd.length === 1 || (active.length === 1 && active[0].id === t.id);
      const extra = mine
        ? daemonKids.filter((k) => {
            const c = cwdOf(k);
            return c !== null && (c === t.cwd || c.startsWith(t.cwd + "/"));
          })
        : [];
      out.push({
        id: `codex:${t.id}`,
        provider: "codex",
        kind: "tui",
        nativeId: t.id,
        name: t.name,
        cwd: t.cwd,
        pid: m?.pid ?? null,
        pidConfidence: m?.confidence ?? "inferred",
        tty: m ? (tuis.find((x) => x.pid === m.pid)?.tty ?? null) : null,
        transcriptPath: t.path,
        connection: "controllable",
        limitations: m?.confidence === "inferred" ? ["Terminal mapping is inferred from cwd and start time."] : [],
        startedAt: t.createdAtMs || null,
        model: t.model,
        liveStatus: { execution: st.execution, confidence: "confirmed", detail: st.detail },
        extraPids: extra,
        extraPidsInferred: sameCwd.length > 1,
        meta: { originator: t.originator, preview: t.preview.slice(0, 300), onDaemon: true, runningSubagents: this.subagentParents.has(t.id), subagentStateKnown: this.subagentStateKnown },
      });
    }

    // Sessions outside the daemon: whoever holds the rollout open.
    const loadedIds = new Set(threads.map((t) => t.id));
    for (const [rollout, pid] of owners) {
      const meta = this.metaOf(rollout);
      if (!meta || loadedIds.has(meta.id)) continue;
      const cmd = cmdlineOf(pid);
      const kind = cmd.some((c) => c.includes("openai.chatgpt")) ? "vscode" : ttyOf(pid) ? "tui" : "headless";
      out.push({
        id: `codex:${meta.id}`,
        provider: "codex",
        kind,
        nativeId: meta.id,
        name: null,
        cwd: meta.cwd,
        pid,
        pidConfidence: "confirmed",
        tty: ttyOf(pid),
        transcriptPath: rollout,
        connection: "observe-only",
        limitations: [
          kind === "vscode"
            ? "Owned by the VS Code extension's private app-server: observe-only."
            : "Not on the shared Codex daemon (embedded mode or exec): observe-only, status inferred from the rollout.",
        ],
        startedAt: null,
        meta: { originator: meta.originator, source: meta.source, onDaemon: false },
      });
    }
    this.claimed = claimed;
    return out;
  }
}
