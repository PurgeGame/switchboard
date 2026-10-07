import type { Execution, Session } from "../../shared/types.ts";

export type Tone = "green" | "amber" | "blue" | "red" | "redmuted" | "gray" | "dim";
export type IconName = "question" | "shield" | "active" | "warn" | "cross" | "stop" | "pause" | "unknown" | "moon" | "check" | "flag";

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: IconName;
}

export const STATUS: Record<Execution, StatusMeta> = {
  waiting_answer: { label: "Needs answer", tone: "amber", icon: "question" },
  waiting_approval: { label: "Needs approval", tone: "amber", icon: "shield" },
  failed: { label: "Failed", tone: "red", icon: "cross" },
  interrupted: { label: "Interrupted", tone: "redmuted", icon: "stop" },
  stalled: { label: "Working", tone: "blue", icon: "active" }, // legacy daemon snapshots
  working: { label: "Working", tone: "blue", icon: "active" },
  idle: { label: "Idle", tone: "gray", icon: "pause" },
  unknown: { label: "Unknown", tone: "gray", icon: "unknown" },
  ended: { label: "Ended", tone: "dim", icon: "moon" },
};

export type StatusGroup = "attention" | "problem" | "active" | "quiet" | "ended";

export const STATUS_GROUPS: { id: StatusGroup; label: string; members: Execution[] }[] = [
  { id: "attention", label: "Needs you", members: ["waiting_answer", "waiting_approval"] },
  { id: "problem", label: "Failed", members: ["failed", "interrupted"] },
  { id: "active", label: "Working", members: ["working", "stalled"] },
  { id: "quiet", label: "Idle", members: ["idle", "unknown"] },
  { id: "ended", label: "Ended", members: ["ended"] },
];

export const needsYou = (s: Session) => s.execution === "waiting_answer" || s.execution === "waiting_approval";

export function statusLabel(s: Session): string {
  const base = STATUS[s.execution].label;
  return base;
}

/**
 * A coordinator worker's folder, `.switchboard-worktrees/<repo>/<task id start>-<title words>`
 * (the daemon's worktreeSlug). Null for any other folder.
 */
export function workerFolder(cwd: string | null | undefined): { repo: string; taskPrefix: string; words: string } | null {
  const m = cwd?.match(/\/\.switchboard-worktrees\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  const [, repo, slug] = m;
  const dash = slug.indexOf("-");
  return { repo, taskPrefix: dash < 0 ? slug : slug.slice(0, dash), words: dash < 0 ? "" : slug.slice(dash + 1) };
}

let taskTitles: { id: string; title: string }[] = [];
/** The store keeps this current, so a worker can go by its task's title. */
export function rememberTasks(tasks: { id: string; title: string }[]) {
  taskTitles = tasks;
}

export function sessionTitle(s: Session): string {
  const w = workerFolder(s.cwd);
  // The coordinator names a worker after its task id (sb-<id>-<tier>, or its folder): use the task's title.
  if (w && (!s.name || s.name.startsWith(`sb-${w.taskPrefix}`) || s.name.startsWith(w.taskPrefix))) {
    const task = taskTitles.find((t) => t.id.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(w.taskPrefix));
    if (task?.title) return task.title;
    if (w.words) return w.words.charAt(0).toUpperCase() + w.words.slice(1).replace(/-/g, " ");
  }
  return s.name || s.goal || s.id;
}

export function projectOf(s: Session): string {
  return s.project ?? s.cwd ?? "No project";
}
