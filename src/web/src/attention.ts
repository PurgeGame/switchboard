import type { AttentionItem, AttentionKind, Outcome, PerspectiveGroup, Resolution, Session } from "../../shared/types.ts";
import { clip } from "./format.ts";
import { needsYou, sessionTitle, type IconName, type Tone } from "./status.ts";

export type AttentionGroup = "needs" | "failed" | "finished" | "stalled" | "other";

interface KindMeta {
  label: string;
  tone: Tone;
  icon: IconName;
  group: AttentionGroup;
}

export const KIND: Record<AttentionKind, KindMeta> = {
  question: { label: "Question", tone: "amber", icon: "question", group: "needs" },
  approval: { label: "Approval", tone: "amber", icon: "shield", group: "needs" },
  conflict: { label: "Conflict", tone: "amber", icon: "warn", group: "needs" },
  escalation: { label: "Escalation", tone: "amber", icon: "flag", group: "needs" },
  failed: { label: "Failed", tone: "red", icon: "cross", group: "failed" },
  finished: { label: "Finished", tone: "green", icon: "check", group: "finished" },
  stalled: { label: "Stalled", tone: "blue", icon: "warn", group: "stalled" },
};

/** Kinds that only resolve when actually answered; everything else can be acknowledged. */
export const isAckable = (k: AttentionKind) => k !== "question" && k !== "approval";

export const OUTCOME: Record<Outcome, { label: string; tone: Tone }> = {
  success: { label: "reports success", tone: "green" },
  failure: { label: "reports failure", tone: "red" },
  incomplete: { label: "incomplete", tone: "gray" },
  limit: { label: "hit a limit", tone: "redmuted" },
  unclear: { label: "unclear", tone: "gray" },
};

export const RESOLUTION: Record<Resolution, string> = {
  answered_ui: "answered here",
  answered_terminal: "answered in the session",
  acknowledged: "acknowledged",
  auto: "continued automatically",
  superseded: "superseded",
};

export const GROUPS: { id: AttentionGroup; label: string; tone: Tone }[] = [
  { id: "needs", label: "Needs you", tone: "amber" },
  { id: "failed", label: "Failed", tone: "red" },
  { id: "finished", label: "Finished", tone: "green" },
  { id: "stalled", label: "Stalled", tone: "blue" },
  { id: "other", label: "Other", tone: "gray" },
];

export interface InboxGroup {
  id: AttentionGroup;
  label: string;
  tone: Tone;
  items: AttentionItem[];
}

/**
 * Only things that need a decision from you reach the UI. Finished/stalled/conflict notices stay
 * in the daemon's history for the coordinator; they aren't yours to handle.
 */
const FOR_YOU = new Set<AttentionItem["kind"]>(["question", "approval", "escalation", "failed"]);
export const openItems = (all: Record<number, AttentionItem>) => Object.values(all).filter((i) => i.status === "open" && FOR_YOU.has(i.kind));

export function recentlyResolved(all: Record<number, AttentionItem>, limit = 50): AttentionItem[] {
  return Object.values(all)
    .filter((i) => i.status === "resolved" && i.kind !== "stalled")
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, limit);
}

export const autoHandled = (all: Record<number, AttentionItem>, limit = 50) =>
  recentlyResolved(all, 500)
    .filter((i) => i.resolution === "auto")
    .slice(0, limit);

export function groupInbox(open: AttentionItem[]): InboxGroup[] {
  return GROUPS.map((g) => ({
    ...g,
    items: open.filter((i) => (KIND[i.kind]?.group ?? "other") === g.id).sort((a, b) => b.createdAt - a.createdAt),
  })).filter((g) => g.items.length > 0);
}

export interface AttentionCounts {
  needYou: number;
  failed: number;
  finished: number;
  working: number;
  open: number;
}

export function countAttention(open: AttentionItem[], sessions: Session[]): AttentionCounts {
  const inGroup = (g: AttentionGroup) => open.filter((i) => KIND[i.kind]?.group === g).length;
  return {
    needYou: inGroup("needs"),
    failed: inGroup("failed"),
    finished: inGroup("finished"),
    working: sessions.filter((s) => s.execution === "working").length,
    open: open.length,
  };
}

export function bySession(open: AttentionItem[]): Map<string, AttentionItem[]> {
  const map = new Map<string, AttentionItem[]>();
  for (const i of open) map.set(i.sessionId, [...(map.get(i.sessionId) ?? []), i]);
  return map;
}

/** Sort rank: question/approval, failed, unacked finished, stalled, working, idle, unknown, ended. */
export function sessionRank(s: Session, items: AttentionItem[] | undefined): number {
  const groups = new Set((items ?? []).map((i) => KIND[i.kind]?.group));
  if (needsYou(s) || groups.has("needs")) return 0;
  if (groups.has("failed") || s.execution === "failed" || s.execution === "interrupted") return 1;
  if (groups.has("finished")) return 2;
  if (groups.has("stalled")) return 3;
  switch (s.execution) {
    case "stalled": // old snapshots carry an unconfirmed guess; treat it as ordinary work
    case "working":
      return 4;
    case "unknown":
      return 6;
    case "ended":
      return 7;
    default:
      return 5;
  }
}

export function compareSessions(open: Map<string, AttentionItem[]>) {
  return (a: Session, b: Session) =>
    sessionRank(a, open.get(a.id)) - sessionRank(b, open.get(b.id)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
}

/** Group-level items carry sessionId "group:<id>" and meta.groupId. */
export function groupIdOf(item: AttentionItem): string | null {
  if (typeof item.meta.groupId === "string") return item.meta.groupId;
  return item.sessionId.startsWith("group:") ? item.sessionId.slice("group:".length) : null;
}

export function subjectName(item: AttentionItem, sessions: Record<string, Session>, groups: Record<string, PerspectiveGroup>): string {
  const gid = groupIdOf(item);
  if (gid) return groups[gid] ? `Perspectives: ${clip(groups[gid].prompt, 40)}` : "Perspectives group";
  const s = sessions[item.sessionId];
  return s ? sessionTitle(s) : item.sessionId;
}
