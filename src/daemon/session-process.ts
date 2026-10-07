// Resolve an inferred session to the process holding its exact transcript open. This is
// deliberately done at End time: cwd/start-time guesses are never signal targets.
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Session } from "../shared/types.ts";
import { cmdlineOf, cwdOf, listPids, readStat } from "./proc.ts";

export interface SessionProcess { pid: number; startTime: number }
type ProcessSession = Pick<Session, "provider" | "cwd" | "transcriptPath">;

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Recheck immediately before acting, including exec() into another binary on the same PID. */
export function sessionProcessError(s: ProcessSession, identity: SessionProcess, procRoot = "/proc"): string | null {
  const before = readStat(identity.pid, procRoot);
  if (!before || before.state === "Z" || before.startTime !== identity.startTime)
    return "The original agent process has changed; refresh the session before ending it.";
  const cmd = cmdlineOf(identity.pid, procRoot);
  if (cmd[0]?.split("/").pop() !== s.provider || s.provider === "codex" && cmd.includes("app-server"))
    return "That process is not the session's agent; nothing was ended.";
  const cwd = cwdOf(identity.pid, procRoot);
  if (!s.cwd || !cwd || canonical(s.cwd) !== canonical(cwd))
    return "The agent's folder no longer matches this session; nothing was ended.";
  const after = readStat(identity.pid, procRoot);
  return !after || after.state === "Z" || after.startTime !== identity.startTime
    ? "The original agent process has changed; refresh the session before ending it." : null;
}

export function findTranscriptProcess(s: ProcessSession, procRoot = "/proc"): { process: SessionProcess; error?: never } | { process?: never; error: string } {
  if (!s.transcriptPath || !isAbsolute(s.transcriptPath) || !s.transcriptPath.endsWith(".jsonl"))
    return { error: "This session has no transcript path to identify its process; nothing was ended." };
  if (!s.cwd || !isAbsolute(s.cwd)) return { error: "This session has no folder to verify its process; nothing was ended." };
  const transcript = canonical(s.transcriptPath);
  const matches: SessionProcess[] = [];
  let pids: number[];
  try { pids = listPids(procRoot); }
  catch { return { error: "Cannot inspect session processes; nothing was ended." }; }
  for (const pid of pids) {
    const stat = readStat(pid, procRoot);
    if (!stat || stat.state === "Z") continue;
    const identity = { pid, startTime: stat.startTime };
    if (sessionProcessError(s, identity, procRoot)) continue;
    try {
      const dir = join(procRoot, String(pid), "fd");
      const owns = readdirSync(dir).some((fd) => {
        try { return readlinkSync(join(dir, fd)) === transcript; } catch { return false; }
      });
      // One process may open the same file more than once. Count processes, not descriptors.
      if (owns && !sessionProcessError(s, identity, procRoot)) matches.push(identity);
    } catch {} // inaccessible or exited while inspecting it
  }
  if (matches.length === 0) return { error: `No ${s.provider} process in this folder has this session's transcript open; nothing was ended.` };
  if (matches.length > 1) return { error: `More than one ${s.provider} process has this session's transcript open; nothing was ended.` };
  return { process: matches[0] };
}
