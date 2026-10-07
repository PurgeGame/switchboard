import { execFile } from "node:child_process";
import type { Session } from "../../shared/types.ts";
import { childrenIndex, cwdOf, descendants, snapshot, type ProcInfo } from "../proc.ts";
import type { Store } from "../db.ts";

export const AUTO_END_INTERVAL_MS = 30_000;
export const AUTO_END_HUMAN_HOLD_MS = 30 * 60_000;
export type EndGuard = () => Promise<string | null>;

export function inputBlocker(store: Store, sessionId: string): string | null {
  if (store.openAttention(sessionId).some((i) => i.kind === "question" || i.kind === "approval")) return "waiting on a question or permission prompt";
  if (store.unresolvedOutbox(sessionId).length) return "session has pending message delivery";
  return null;
}

/** Every live descendant counts, including sleeping commands and detached daemon children. */
export function processBlocker(s: Session, daemonPid: number | null = null, procs = snapshot(), cwd = cwdOf): string | null {
  if (!s.pid || s.pidConfidence !== "confirmed") return "cannot confirm the worker's process";
  const live = (p: ProcInfo | undefined) => p && p.state !== "Z" && p.state !== "X";
  if (!live(procs.get(s.pid))) return "worker process is no longer live";
  const kids = childrenIndex(procs);
  if (descendants(s.pid, kids).some((pid) => pid !== s.pid && live(procs.get(pid)))) return "worker has live child processes";
  if (s.meta.onDaemon) {
    if (!daemonPid || !live(procs.get(daemonPid))) return "cannot inspect the shared daemon's child processes";
    // Attribution by folder is conservative: a child may belong to another thread in this folder.
    if (descendants(daemonPid, kids).some((pid) => {
      if (pid === daemonPid || pid === s.pid || !live(procs.get(pid))) return false;
      const path = cwd(pid);
      return !path || !s.cwd || path === s.cwd || path.startsWith(`${s.cwd}/`);
    })) return "shared daemon has possible worker child processes";
  }
  return null;
}

/** Read the entire worktree, even when the session works in a subdirectory. Fail closed. */
export function worktreeState(cwd: string | null): Promise<"clean" | "dirty" | "unknown"> {
  if (!cwd) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
      { timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => resolve(error ? "unknown" : stdout.length ? "dirty" : "clean"));
  });
}
