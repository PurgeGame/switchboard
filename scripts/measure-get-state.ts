// Reproducible synthetic project history; in-memory SQLite, no daemon or provider.
// Run from the checkout root: bun scripts/measure-get-state.ts
import { CoordinatorAgent, coordinatorObjective, coordinatorTask } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";

const store = new Store("", ":memory:");
const coordination = new Coordination(store);
const root = process.cwd();
const sessions = new Map(Array.from({ length: 6 }, (_, i) => {
  const id = `claude:fixture-worker-${i}`;
  return [id, { ...blankSession(id, "claude", "tui", id), cwd: root, execution: "idle" as const }];
}));
const agent = new CoordinatorAgent({
  db: store.db, coordination, cfg: mergeCoordinatorConfig({}), sessions: () => sessions,
  events: () => [], send: async () => { throw new Error("fixture has no transport"); },
  escalate() {}, push() {}, timers: false, now: () => Date.parse("2026-10-07T12:00:00Z"),
});
const sized = (text: string, length: number) => (text + "\n").repeat(Math.ceil(length / (text.length + 1))).slice(0, length);
try {
  const names = ["Permission decisions", "Worker lifecycle", "Phone notifications", "Coordinator state"];
  const objectives = names.map((name) => {
    const o = coordination.createObjective(name, `Deliver ${name.toLowerCase()} with durable state and regression coverage.`, undefined, "human");
    return coordination.grantObjective(o.id, { root }, "human");
  });
  const topics = ["parser fixtures", "authority guards", "delivery receipts", "settings", "restart recovery", "phone actions", "notification dedupe", "worktree safety", "documentation", "browser coverage"];
  for (let i = 0; i < 40; i++) {
    const objective = objectives[i % 4];
    const title = `${objective.title}: ${topics[Math.floor(i / 4)]}`;
    const acceptance = ["Behavior covered by regression tests", "Authority boundaries remain enforced"];
    const t = coordination.createTask({
      title, objectiveId: objective.id, owner: i >= 38 ? null : `claude:fixture-worker-${i % 6}`,
      scope: { paths: [`src/fixture-${i}.ts`], resources: [] }, acceptance,
      description: sized(`${title}. Inspect existing behavior, implement the requested change, preserve pending human decisions across reconnects, and verify the result with targeted and full test suites.`, 5000),
    }, "human");
    if (i < 30) {
      coordination.updateTask(t.id, { status: "finished_unverified", result: sized(`${title} completed. Tests and typecheck pass. Reviewed the diff, exercised restart recovery, and verified that unauthorized requests remain refused.`, 8000) }, "human");
      for (const criterion of acceptance) coordination.recordEvidence(t.id, "human", sized(`Reviewed ${title}: ${criterion}. Recorded test output, inspected the implementation, and checked failure handling.`, 1500), { criterion });
    } else if (i < 36) coordination.updateTask(t.id, { status: "in_progress" }, "human");
    else if (i < 38) coordination.updateTask(t.id, { status: "finished_unverified", result: "Ready for human review; checks passed." }, "human");
  }
  agent.setMode("active");
  for (const title of ["Approve the next documentation task", "Schedule a follow-up browser review"]) {
    const proposed = await agent.callTool("propose_action", { title, detail: sized(title, 2000), reason: "Synthetic pending human decision" });
    if (!proposed.ok) throw new Error(proposed.error);
  }
  const response = await agent.callTool("get_state", {});
  if (!response.ok) throw new Error(response.error);
  const result = response.result as Record<string, any>;
  const snap = coordination.snapshot();
  // Exactly the previous get_state result shape, including its authority redactions.
  const previous = { ...snap, objectives: snap.objectives.map(coordinatorObjective), tasks: snap.tasks.map(coordinatorTask), proposals: agent.proposals(30).filter((p) => p.state === "pending"), budget: result.budget, launched: result.launched, settings: result.settings };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  console.log(JSON.stringify({
    fixture: { objectives: 4, tasks: 40, verified: 30, open: 10, sessions: 6, claims: snap.claims.length, pendingProposals: 2, descriptionCharactersPerTask: 5000, completedResultCharactersPerTask: 8000, evidenceCharactersPerCompletedTask: 3000 },
    defaultResultBytes: bytes(result), defaultResponseBytes: bytes(response), previousResultBytes: bytes(previous),
    reductionPercent: Number((100 * (1 - bytes(result) / bytes(previous))).toFixed(2)),
    returnedTasks: result.tasks.length, counts: result.counts,
  }, null, 2));
} finally {
  store.db.close();
}
