// The coordinator's right-hand panel ("What's happening"): done or abandoned projects and finished
// task rows wait behind "Show finished"; what is under way shows by default.
import { expect, test } from "bun:test";
import type { AttentionItem, CoordinatorProposal, Objective, Session, Task } from "../src/shared/types.ts";
import { happeningTaskSummary, happeningTaskView, happeningView } from "../src/web/src/happening.ts";
import { blankSession } from "../src/daemon/state.ts";

const grant = (revoked = false) => ({ id: "g", root: "/r", resources: [], verification: [], issuedBy: "human", issuedAt: 1, revokedAt: revoked ? 2 : null, provenance: "p" });
const obj = (id: string, extra: Partial<Objective> = {}) => ({ id, title: id, description: "", status: "active", priority: "normal", createdAt: 1, updatedAt: 1, grant: grant(), ...extra }) as Objective;
let n = 0;
const task = (objectiveId: string, status: Task["status"]) => ({ id: `t${++n}`, objectiveId, title: `${objectiveId} ${status}`, status }) as Task;

const objectives = [obj("live"), obj("shipped"), obj("stopped", { grant: grant(true) } as any), obj("dropped", { status: "dropped" }), obj("sent-back"), obj("new")];
const tasks = [
  task("live", "in_progress"),
  task("live", "finished_unverified"),
  task("live", "verified"),
  task("live", "rejected"),
  task("shipped", "verified"),
  task("shipped", "rejected"),
  task("stopped", "in_progress"),
  task("dropped", "assigned"),
  task("sent-back", "rejected"),
];

test("by default: only work under way; finished rows and done or abandoned projects are counted, not shown", () => {
  const v = happeningView(objectives, tasks, false);
  expect(v.objectives.map((o) => o.objective.id)).toEqual(["live", "new"]); // a project with no tasks yet is under way
  const live = v.objectives[0];
  expect(live.tasks.map((t) => t.status)).toEqual(["in_progress", "finished_unverified"]); // needs your OK: still shown
  expect([live.done, live.total, live.state]).toEqual([1, 3, "active"]);
  expect(v.hidden).toBe(2 + 4); // live's verified and rejected rows; shipped, stopped, dropped, sent-back
});

test("Show finished: everything, each project marked done or abandoned", () => {
  const v = happeningView(objectives, tasks, true);
  expect(v.hidden).toBe(0);
  expect(Object.fromEntries(v.objectives.map((o) => [o.objective.id, o.state]))).toEqual({
    live: "active",
    shipped: "done",
    stopped: "abandoned",
    dropped: "abandoned",
    "sent-back": "abandoned",
    new: "active",
  });
  expect(v.objectives.find((o) => o.objective.id === "live")!.tasks).toHaveLength(4);
  expect(v.objectives.find((o) => o.objective.id === "shipped")).toMatchObject({ done: 1, total: 1 });
});

function taskContext() {
  const sessions = Object.fromEntries(["working", "idle", "waiting_answer", "waiting_approval", "ended", "failed", "unknown"].map((execution) => [execution, {
    ...blankSession(execution, "codex", "tui", execution), execution: execution as Session["execution"],
  }]));
  const context = { sessions, open: [] as AttentionItem[], failed: new Set<string>(), pending: [] as CoordinatorProposal[] };
  return { context, view: (t: Task) => happeningTaskView(t, context) };
}
const owned = (id: string, status: Task["status"], owner: string | null) => ({ ...task("live", status), id, owner });

test("mixed tasks: only executing assigned/in-progress work stays outside the counted disclosure", () => {
  const { view } = taskContext();
  const mixed = [owned("run", "in_progress", "working"), owned("queue", "unassigned", null), owned("blocked", "blocked", "working"), owned("idle", "in_progress", "idle"), owned("review", "finished_unverified", "working"), owned("done", "verified", "working")];
  const summary = happeningTaskSummary(mixed, view);
  expect(summary.running.map((t) => t.id)).toEqual(["run"]);
  expect(summary.other.map((t) => t.id)).toEqual(["queue", "blocked", "idle", "review", "done"]);
  expect(summary.text).toBe("1 running · 1 needs you · 1 blocked · 1 idle · 1 queued · 1 done");
  expect(new Set([...summary.running, ...summary.other].map((t) => t.id)).size).toBe(mixed.length);
});

test("in_progress alone, old timing, and background commands never imply execution", () => {
  const { context, view } = taskContext();
  context.sessions.idle.resources = { cpuPct: 0, rssMB: 0, procs: 1, running: { kind: "command", cmd: "bun dev", since: 1 } };
  context.sessions.working.lastActivityAt = 1;
  for (const owner of ["idle", "waiting_answer", "waiting_approval", "ended", "failed", "unknown", "missing", null]) {
    expect(view(owned("t", "in_progress", owner)).running).toBe(false);
  }
  expect(view(owned("t", "assigned", "working")).running).toBe(true);
  expect(view(owned("t", "in_progress", "idle"))).toMatchObject({ status: "idle", label: "Worker idle" });
  expect(view(owned("t", "in_progress", "working"))).toMatchObject({ status: "running", running: true });
});

test("all non-running objectives retain needs, blocked, failed and idle summaries", () => {
  const { context, view } = taskContext();
  context.failed.add("launch");
  const summary = happeningTaskSummary([owned("review", "finished_unverified", null), owned("blocked", "blocked", null), owned("idle", "in_progress", "idle"), owned("launch", "unassigned", null)], view);
  expect(summary.running).toHaveLength(0);
  expect(summary.other).toHaveLength(4);
  expect(summary.text).toBe("1 needs you · 1 failed · 1 blocked · 1 idle");
  expect(happeningTaskSummary([], view).text).toBe("No tasks yet");
});

test("live execution and review transitions partition every task exactly once; attention doesn't hide executing work", () => {
  const { context, view } = taskContext();
  const t = owned("t", "in_progress", "working");
  context.open = [{ kind: "question", sessionId: "working", meta: {} } as AttentionItem];
  expect(view(t)).toMatchObject({ status: "needs", running: true });
  expect(happeningTaskSummary([t], view).text).toBe("1 running · 1 needs you");
  context.open = [];
  for (const execution of ["working", "idle", "working", "waiting_approval", "working"] as const) {
    context.sessions.working.execution = execution;
    const summary = happeningTaskSummary([t], view);
    expect(summary.running.length).toBe(execution === "working" ? 1 : 0);
    expect([...summary.running, ...summary.other]).toEqual([t]);
  }
  t.status = "finished_unverified";
  expect(view(t)).toMatchObject({ status: "needs", running: false });
  t.status = "verified";
  expect(view(t)).toMatchObject({ status: "done", running: false });
  expect(happeningView([obj("live")], [t, owned("queued", "unassigned", null)], false).objectives[0].tasks).toHaveLength(1);
  const shown = happeningView([obj("live")], [t, owned("queued", "unassigned", null)], true).objectives[0];
  expect(happeningTaskSummary(shown.tasks, view).other).toHaveLength(2);
});
