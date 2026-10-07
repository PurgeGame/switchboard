// "What's happening" (the coordinator's right-hand panel): what is under way, with finished work
// behind a "Show finished" toggle. Finished = an objective that is done (every task that wasn't
// sent back is verified) or abandoned (stopped, closed, or every task sent back), and inside the
// rest, task rows whose work is over (verified or sent back). Pure, shared by the panel and tests.
import type { AttentionItem, CoordinatorProposal, Objective, Session, Task } from "../../shared/types.ts";
import { needsYou } from "./status.ts";

export type HappeningStatus = "running" | "needs" | "waiting" | "idle" | "queued" | "failed" | "done" | "stopped";
export const happeningLabels: Record<HappeningStatus, string> = {
  running: "Running", needs: "Needs you", waiting: "Waiting on other work", idle: "Worker idle", queued: "Not started",
  failed: "Failed", done: "Done", stopped: "Sent back",
};
export interface HappeningTaskView {
  status: HappeningStatus;
  label: string;
  session?: Session;
  /** Execution is independent of attention: a working task may also need a decision. */
  running: boolean;
}

export function happeningTaskView(t: Task, context: {
  sessions: Record<string, Session>;
  open: AttentionItem[];
  failed: Set<string>;
  pending: CoordinatorProposal[];
}): HappeningTaskView {
  const { sessions, open, failed, pending } = context;
  const session = t.owner ? sessions[t.owner] : undefined;
  const running = (t.status === "assigned" || t.status === "in_progress") && session?.execution === "working";
  const notices = open.filter((i) => (t.owner && i.sessionId === t.owner) || i.meta.taskId === t.id);
  let status: HappeningStatus;
  let label: string | undefined;
  if (t.status === "verified") status = "done";
  else if (t.status === "rejected") status = "stopped";
  else if (failed.has(t.id) || session?.execution === "failed" || session?.execution === "interrupted" || notices.some((i) => i.kind === "failed")) status = "failed";
  else if (t.status === "finished_unverified" || (session && needsYou(session)) || notices.length || pending.some((p) => p.taskId === t.id)) {
    status = "needs";
    if (t.status === "finished_unverified") label = "Needs you: review completed work";
  } else if (t.status === "blocked") status = "waiting";
  else if (running) status = "running";
  else if ((t.status === "assigned" || t.status === "in_progress") && session?.execution === "idle") status = "idle";
  else {
    status = "queued";
    if (t.status === "assigned" || t.status === "in_progress") label = session?.execution === "ended" ? "Worker ended" : "Waiting for worker";
  }
  return { status, label: label ?? happeningLabels[status], session, running };
}

/** One partition for rows and counts; never infer execution from task status or elapsed time. */
export function happeningTaskSummary(tasks: Task[], view: (t: Task) => HappeningTaskView) {
  const running: Task[] = [];
  const other: Task[] = [];
  const counts: Partial<Record<HappeningStatus, number>> = {};
  for (const t of tasks) {
    const v = view(t);
    (v.running ? running : other).push(t);
    counts[v.status] = (counts[v.status] ?? 0) + 1;
  }
  const countLabels: Partial<Record<HappeningStatus, string>> = { needs: "needs you", failed: "failed", waiting: "blocked", idle: "idle", queued: "queued", done: "done", stopped: "sent back" };
  const parts = [running.length ? `${running.length} running` : "", ...Object.entries(countLabels).map(([status, label]) => counts[status as HappeningStatus] ? `${counts[status as HappeningStatus]} ${label}` : "")].filter(Boolean);
  return { running, other, text: parts.join(" · ") || "No tasks yet" };
}

export interface HappeningObjective {
  objective: Objective;
  /** The rows shown (with the toggle off, only work still under way). */
  tasks: Task[];
  /** Verified out of the tasks that weren't sent back. */
  done: number;
  total: number;
  state: "active" | "done" | "abandoned";
}

const over = (t: Task) => t.status === "verified" || t.status === "rejected";

export function happeningView(objectives: Objective[], tasks: Task[], showFinished: boolean): { objectives: HappeningObjective[]; hidden: number } {
  let hidden = 0;
  const out: HappeningObjective[] = [];
  for (const o of objectives) {
    const mine = tasks.filter((t) => t.objectiveId === o.id);
    const kept = mine.filter((t) => t.status !== "rejected");
    const done = kept.filter((t) => t.status === "verified").length;
    const state: HappeningObjective["state"] =
      o.status !== "active" || !!o.grant?.revokedAt || (mine.length > 0 && kept.length === 0) ? "abandoned" : kept.length > 0 && done === kept.length ? "done" : "active";
    if (state !== "active" && !showFinished) {
      hidden++;
      continue;
    }
    const rows = state === "active" && !showFinished ? mine.filter((t) => !over(t)) : mine;
    hidden += mine.length - rows.length;
    out.push({ objective: o, tasks: rows, done, total: kept.length, state });
  }
  return { objectives: out, hidden };
}
