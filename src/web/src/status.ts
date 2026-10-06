import type { Execution, Session } from "../../shared/types.ts";

export type Tone = "green" | "amber" | "blue" | "red" | "redmuted" | "gray" | "dim";
export type IconName = "question" | "shield" | "spinner" | "warn" | "cross" | "stop" | "pause" | "unknown" | "moon" | "check" | "flag";

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
  stalled: { label: "Stalled?", tone: "blue", icon: "warn" },
  working: { label: "Working", tone: "blue", icon: "spinner" },
  idle: { label: "Idle", tone: "gray", icon: "pause" },
  unknown: { label: "Unknown", tone: "gray", icon: "unknown" },
  ended: { label: "Ended", tone: "dim", icon: "moon" },
};

export type StatusGroup = "attention" | "problem" | "active" | "quiet" | "ended";

export const STATUS_GROUPS: { id: StatusGroup; label: string; members: Execution[] }[] = [
  { id: "attention", label: "Needs you", members: ["waiting_answer", "waiting_approval"] },
  { id: "problem", label: "Failed", members: ["failed", "interrupted", "stalled"] },
  { id: "active", label: "Working", members: ["working"] },
  { id: "quiet", label: "Idle", members: ["idle", "unknown"] },
  { id: "ended", label: "Ended", members: ["ended"] },
];

export const needsYou = (s: Session) => s.execution === "waiting_answer" || s.execution === "waiting_approval";

export function statusLabel(s: Session): string {
  const base = STATUS[s.execution].label;
  return base;
}

export function sessionTitle(s: Session): string {
  return s.name || s.goal || s.id;
}

export function projectOf(s: Session): string {
  return s.project ?? s.cwd ?? "No project";
}
