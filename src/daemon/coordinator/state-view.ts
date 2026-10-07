// The compact get_state: open work only, long fields previewed, finished work as counts. The
// coordinator's tool results have a size limit, and the full dump (every task's result and
// evidence) outgrew it; `include` and the id filters bring the detail back.
import type { Claim, Conflict, CoordinatorProposal, Objective, Task } from "../../shared/types.ts";

const FINISHED = ["verified", "rejected"];
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export interface StateArgs {
  objectiveId?: string;
  taskId?: string;
  include?: string[];
}

export interface StateSnap {
  objectives: Objective[];
  tasks: Task[];
  claims: Claim[];
  conflicts: Conflict[];
  proposals: CoordinatorProposal[];
}

/** `full` maps keep the coordinator-visible redactions (coordinatorObjective / coordinatorTask). */
export function compactState(snap: StateSnap, a: StateArgs, full: { objective: (o: Objective) => Objective; task: (t: Task) => Task }) {
  const include = new Set(Array.isArray(a.include) ? a.include.map(String) : []);
  const details = include.has("details");
  const isOpen = (t: Task) => !FINISHED.includes(t.status);
  const taskView = (t: Task) =>
    details || a.taskId
      ? full.task(t)
      : {
          id: t.id,
          objectiveId: t.objectiveId,
          title: clip(t.title, 100),
          status: t.status,
          owner: t.owner,
          tier: t.tier,
          priority: t.priority,
          description: clip(t.description, 200),
          acceptance: t.acceptance.slice(0, 4).map((x) => clip(x, 100)),
          acceptanceCount: t.acceptance.length,
          ...(t.prerequisites.length ? { prerequisites: t.prerequisites } : {}),
          ...(t.needsVerification ? { needsVerification: true } : {}),
          hasResult: !!t.result,
        };
  const objView = (o: Objective) =>
    details
      ? full.objective(o)
      : {
          id: o.id,
          title: clip(o.title, 100),
          status: o.status,
          priority: o.priority,
          description: clip(o.description, 200),
          ...(o.grant ? { grant: { root: o.grant.root, resources: o.grant.resources.slice(0, 5), revokedAt: o.grant.revokedAt, verification: full.objective(o).grant!.verification } } : {}),
        };

  let objectives: Objective[], tasks: Task[];
  if (a.taskId) {
    tasks = snap.tasks.filter((t) => t.id === a.taskId || t.id.startsWith(a.taskId!));
    objectives = snap.objectives.filter((o) => tasks.some((t) => t.objectiveId === o.id));
  } else if (a.objectiveId) {
    objectives = snap.objectives.filter((o) => o.id === a.objectiveId || o.id.startsWith(a.objectiveId!));
    tasks = snap.tasks.filter((t) => objectives.some((o) => o.id === t.objectiveId) && (include.has("finished") || isOpen(t)));
  } else {
    tasks = snap.tasks.filter((t) => include.has("finished") || isOpen(t));
    // An objective is open work if it's active and has an open task; the rest are counted.
    objectives = snap.objectives.filter((o) => include.has("finished") || (o.status === "active" && snap.tasks.some((t) => t.objectiveId === o.id && isOpen(t))));
  }
  const byStatus: Record<string, number> = {};
  for (const t of snap.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const hiddenObjectives = snap.objectives.length - objectives.length;
  const hiddenTasks = snap.tasks.length - tasks.length;
  const pending = snap.proposals.filter((p) => p.state === "pending");
  return {
    note:
      "Compact view: open objectives and tasks only, long fields previewed, results and evidence left out. " +
      "Widen it with objectiveId (one objective, its open tasks), taskId (one task in full, with result and evidence), " +
      "include: ['finished'] (verified/rejected work and finished objectives) and include: ['details'] (full descriptions, results, evidence, grants).",
    objectives: objectives.map(objView),
    tasks: tasks.map(taskView),
    counts: { objectives: snap.objectives.length, tasks: snap.tasks.length, tasksByStatus: byStatus, hiddenObjectives, hiddenTasks },
    claims: details ? snap.claims : snap.claims.slice(0, 40).map((c) => ({ resource: c.resource, owner: c.owner, taskId: c.taskId, state: c.state, exclusive: c.exclusive })),
    claimsTotal: snap.claims.length,
    conflicts: snap.conflicts.slice(0, details ? 100 : 10).map((c) => ({ ...c, detail: details ? c.detail : clip(c.detail, 200) })),
    conflictsTotal: snap.conflicts.length,
    proposals: pending.map((p) => (details ? p : { id: p.id, kind: p.kind, title: clip(p.title, 160), sessionId: p.sessionId, taskId: p.taskId, heldBecause: p.heldBecause, createdAt: p.createdAt })),
  };
}
