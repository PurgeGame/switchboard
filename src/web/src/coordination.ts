import type { Session, Task, TaskStatus } from "../../shared/types.ts";
import type { Tone } from "./status.ts";

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  blocked: { label: "Blocked", tone: "redmuted" },
  unassigned: { label: "Unassigned", tone: "gray" },
  assigned: { label: "Assigned", tone: "blue" },
  in_progress: { label: "In progress", tone: "blue" },
  finished_unverified: { label: "Finished (unverified)", tone: "green" },
  verified: { label: "Verified", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
};

export const BOARD_COLUMNS: { id: string; label: string; tone: Tone; statuses: TaskStatus[] }[] = [
  { id: "blocked", label: "Blocked", tone: "redmuted", statuses: ["blocked"] },
  { id: "unassigned", label: "Unassigned", tone: "gray", statuses: ["unassigned"] },
  { id: "active", label: "Assigned / In progress", tone: "blue", statuses: ["assigned", "in_progress"] },
  { id: "finished", label: "Finished (unverified)", tone: "green", statuses: ["finished_unverified"] },
  { id: "verified", label: "Verified", tone: "green", statuses: ["verified"] },
  { id: "rejected", label: "Rejected", tone: "red", statuses: ["rejected"] },
];

export const TIER: Record<Task["tier"], string> = { deep: "Deep", standard: "Standard", light: "Light" };

export const sessionName = (sessions: Record<string, Session>, id: string): string => {
  const s = sessions[id];
  return s ? s.name || s.goal || s.id : id;
};

/** Prerequisites that are not yet verified. */
export function unmetPrerequisites(task: Task, tasks: Task[]): Task[] {
  return task.prerequisites.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.status !== "verified");
}
