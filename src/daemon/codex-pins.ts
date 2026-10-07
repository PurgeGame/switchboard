// Codex workers the coordinator launched, pinned to their TUI process. Codex doesn't say which
// terminal hosts which thread, so the adapter infers it from folder and start time, and an
// inferred process is never typed into or signalled. For a coordinator worker three facts agree:
// the coordinator linked the session to task T (by its brief), Switchboard opened a terminal named
// sb-T-<tier> for that launch, and one codex process runs under that terminal's shell. That
// process hosts the session, so it can be ended (typed into, or signalled) like a Claude session.
import type { Session } from "../shared/types.ts";
import type { BridgeTerminal } from "./bridge.ts";
import { childrenIndex, cmdlineOf, descendants, snapshot, type ProcInfo } from "./proc.ts";

const isCodex = (pid: number, procs: Map<number, ProcInfo>, cmdline: (pid: number) => string[]) => {
  if (procs.get(pid)?.comm !== "codex") return false;
  const cmd = cmdline(pid);
  return (/\/codex$/.test(cmd[0] ?? "") || cmd[0] === "codex") && !cmd.includes("app-server");
};

export function pinCodexWorkers(deps: {
  terminals: () => BridgeTerminal[];
  sessions: () => Iterable<Session>;
  /** The task the coordinator launched this session for, or null. */
  taskOf: (sessionId: string) => string | null;
  pin: (threadId: string, pid: number, startTime: number) => void;
  procs?: Map<number, ProcInfo>;
  cmdline?: (pid: number) => string[];
}) {
  const procs = deps.procs ?? snapshot();
  const cmdline = deps.cmdline ?? cmdlineOf;
  const kids = childrenIndex(procs);
  const byTask = new Map<string, Session>();
  for (const s of deps.sessions()) {
    if (s.provider !== "codex" || s.execution === "ended") continue;
    const t = deps.taskOf(s.id);
    if (t) byTask.set(t, s);
  }
  for (const t of deps.terminals()) {
    const m = t.name.match(/^sb-(.+)-(deep|standard|light)$/);
    const s = m && byTask.get(m[1]);
    if (!s || !t.processId) continue;
    const agents = descendants(t.processId, kids).filter((pid) => pid !== t.processId && isCodex(pid, procs, cmdline));
    if (agents.length !== 1) continue; // none, or more than one: not certain
    deps.pin(s.nativeId, agents[0], procs.get(agents[0])!.startTime);
  }
}
