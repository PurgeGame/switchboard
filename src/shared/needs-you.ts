import type { AttentionItem, CoordinatorPlan, CoordinatorProposal, CoordinatorState, Session, Task } from "./types.ts";

type Source =
  | { kind: "proposal"; proposal: CoordinatorProposal }
  | { kind: "review"; task: Task }
  | { kind: "launch"; plan: CoordinatorPlan; task: CoordinatorPlan["tasks"][number] }
  | { kind: "attention"; attention: AttentionItem };
export type NeedsYouItem = Source & { id: string; summary: string; sessionId: string | null; createdAt: number };
export interface NeedsYouState {
  attention: AttentionItem[];
  coordinator: CoordinatorState | null;
  tasks: Task[];
  sessions: Record<string, Session>;
}
const line = (text: string) => (text ?? "").replace(/\s+/g, " ").trim();

/** One definition for the pinned list, badge, and phone push. IDs survive reconnects/restarts. */
export function needsYouItems(s: NeedsYouState): NeedsYouItem[] {
  const result: NeedsYouItem[] = [];
  for (const proposal of s.coordinator?.proposals ?? []) if (proposal.state === "pending") {
    result.push({ kind: "proposal", proposal, id: `proposal:${proposal.id}`, summary: `Decide: ${line(proposal.title)}`, sessionId: proposal.sessionId, createdAt: proposal.createdAt });
  }
  for (const task of s.tasks) if (task.status === "finished_unverified") {
    result.push({ kind: "review", task, id: `review:${task.id}`, summary: `Review: ${line(task.title)}`, sessionId: task.owner, createdAt: task.updatedAt });
  }
  for (const plan of s.coordinator?.plans ?? []) for (const task of plan.tasks) if (task.state === "failed") {
    result.push({ kind: "launch", plan, task, id: `launch:${plan.proposalId}:${task.key}`, summary: `Couldn't start: ${line(task.title)}`, sessionId: null, createdAt: 0 });
  }
  const open = s.attention.filter((i) => i.status === "open" && !i.meta.autoApproved && !i.meta.autoPending && !i.meta.permissionPending);
  const seen = new Set<string>();
  for (const attention of open) {
    const i = attention;
    // Status, conflict and routine completion notices are for the coordinator. An explicit
    // escalation is for the human, as are worker questions even when the worker is backgrounded.
    if (!["approval", "question", "escalation"].includes(i.kind)) continue;
    if (i.meta.coordinatorOnly || i.meta.handledBy === "coordinator") continue;
    if (s.sessions[i.sessionId]?.execution === "ended") continue;
    if (i.kind === "approval" && !i.meta.answerKey && open.some((p) => p.sessionId === i.sessionId && p.kind === "approval" && p.meta.answerKey)) continue;
    const key = i.kind === "question" ? `question:${i.sessionId}` : `${i.kind}:${i.meta.answerKey ?? i.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = s.sessions[i.sessionId]?.name ?? i.sessionName ?? i.sessionId;
    result.push({ kind: "attention", attention, id: `attention:${i.id}`, summary: line(`${who}: ${i.text || i.title}`), sessionId: i.sessionId, createdAt: i.createdAt });
  }
  return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
