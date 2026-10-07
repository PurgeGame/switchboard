// A task that becomes verified or rejected releases its claims and launch reservation, and queued
// plan tasks launch as soon as the claim or launch slot blocking them frees (not at the next
// heartbeat). The slot test drives a real Registry, wired as main.ts wires it. Temp dirs, fake
// launcher, in-memory store.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Store } from "../src/daemon/db.ts";
import { Registry } from "../src/daemon/registry.ts";
import { blankSession } from "../src/daemon/state.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function fixture(cfg: any = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sb-release-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo"),
    wt = join(base, "worktrees");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(wt);
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const c = new Coordination(store);
  const registry = new Registry([], store, {} as any);
  const sessions = registry.sessions;
  const add = (id: string, cwd = root) => {
    const s: Session = { ...blankSession(id, "claude", "tui", id), cwd, name: id, execution: "idle" };
    sessions.set(id, s);
    return s;
  };
  const launches: any[] = [];
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: c,
    cfg: mergeCoordinatorConfig(cfg),
    sessions: () => sessions,
    events: () => [],
    send: async () => ({ ok: true }),
    launch: async (spec: any) => {
      const id = `worker${launches.length}`;
      launches.push(spec);
      sessions.set(id, { ...blankSession(id, spec.provider, "tui", id), cwd: spec.cwd, execution: "working" });
      return id;
    },
    createWorktree: async (_repo: string, slug: string) => {
      const p = join(wt, slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    escalate: () => {},
    push: () => {},
    timers: false,
  } as any);
  // As main.ts wires them.
  c.onChange = () => agent.onCoordinationChange();
  registry.execHooks.push((s) => s.execution === "ended" && agent.onSessionEnded(s.id));
  agent.setMode("active");
  const objective = () => {
    const o = c.createObjective("Human objective", "", undefined, "human");
    c.grantObjective(o.id, { root, resources: [] }, "human");
    return o;
  };
  const audit = (action: string) => (store.db.query("SELECT data FROM authority_audit WHERE action=?").all(action) as { data: string }[]).map((r) => JSON.parse(r.data));
  return { root, store, c, agent, registry, sessions, add, launches, objective, audit };
}

const planTask = (key: string, extra: any = {}) => ({
  key,
  title: `Do ${key}`,
  brief: `Implement ${key} in src/${key}.ts.`,
  acceptance: [`${key} works`],
  provider: "claude",
  tier: "standard",
  paths: [`src/${key}.ts`],
  ...extra,
});
async function plan(x: ReturnType<typeof fixture>, tasks: any[]) {
  const r: any = await x.agent.callTool("propose_plan", { title: "Plan", root: x.root, tasks, reason: "asked" });
  expect(r.ok).toBe(true);
  await x.agent.approve(r.result.proposal.id, { digest: r.result.proposal.digest });
  await x.agent.settled();
}
const planTasks = (x: ReturnType<typeof fixture>) => x.agent.plansSnapshot()[0].tasks;

test("a task that becomes verified releases every claim tagged with it and its launch reservation", async () => {
  const x = fixture();
  await plan(x, [planTask("a")]);
  const a = x.c.task(planTasks(x)[0].taskId)!;
  expect(a.owner).toBe("worker0");
  expect(x.c.reservation(a.id)!.state).toBe("launched");
  // Someone else's claim tagged with the task, and an unrelated claim that must stay.
  x.add("helper");
  x.c.claim("helper", `path:${x.root}/src/a-notes.md`, { taskId: a.id });
  const unrelated = x.c.claim("helper", `path:${x.root}/src/unrelated.ts`).claim;
  expect(x.c.claims().filter((q) => q.taskId === a.id)).toHaveLength(2);
  for (const criterion of a.acceptance) x.c.recordEvidence(a.id, "human", "checked", { criterion });
  expect(x.c.task(a.id)!.status).toBe("verified");
  expect(x.c.claims(["active", "suspect", "waiting"]).filter((q) => q.taskId === a.id)).toHaveLength(0);
  expect(x.c.reservation(a.id)).toBeNull();
  expect(x.c.claims().map((q) => q.id)).toEqual([unrelated.id]);
  expect(x.audit("released_on_finish")).toEqual([expect.objectContaining({ taskId: a.id, status: "verified" })]);
});

test("your rejection releases a task's claims and its launch reservation, even an uncertain one, and lets a waiting claim through", async () => {
  const x = fixture();
  const o = x.objective();
  x.add("mine");
  const t = x.c.createTask({ title: "Mine", objectiveId: o.id, owner: "mine", acceptance: ["done"], scope: { paths: [`${x.root}/src/m.ts`], resources: [] } }, "human");
  x.add("next");
  const waiting = x.c.claim("next", `path:${x.root}/src/m.ts`);
  expect(waiting.granted).toBe(false);
  x.c.updateTask(t.id, { status: "rejected" }, "human");
  expect(x.c.claims().find((q) => q.id === waiting.claim.id)!.state).toBe("active"); // granted on release
  expect(x.c.claims().some((q) => q.taskId === t.id)).toBe(false);
  // A launch reservation left uncertain (a worker may or may not have started): your call settles it.
  const other = x.c.createTask({ title: "Other", objectiveId: o.id, acceptance: ["done"], scope: { paths: [`${x.root}/src/o.ts`], resources: [] } }, "coordinator");
  const r = x.c.reserveLaunch(other.id, x.root);
  x.c.updateReservation({ ...r, state: "uncertain", detail: "bridge timed out" });
  x.c.updateTask(other.id, { status: "rejected" }, "human");
  expect(x.c.reservation(other.id)).toBeNull();
  expect(x.c.claims().some((q) => q.owner === `reservation:${r.id}`)).toBe(false);
  // finished_unverified keeps them: the worker may still need to fix things.
  const kept = x.c.createTask({ title: "Kept", objectiveId: o.id, owner: "mine", acceptance: ["done"], scope: { paths: [`${x.root}/src/k.ts`], resources: [] } }, "human");
  x.c.updateTask(kept.id, { status: "finished_unverified", result: "done" }, "human");
  expect(x.c.claims().some((q) => q.taskId === kept.id)).toBe(true);
});

test("the coordinator rejecting its own task frees only what it could release itself: not a session you drive, not an uncertain launch", async () => {
  const x = fixture();
  const o = x.objective();
  x.add("mine"); // a session you drive
  const yours = x.c.createTask({ title: "Yours", objectiveId: o.id, owner: "mine", acceptance: ["done"], scope: { paths: [`${x.root}/src/y.ts`], resources: [] } }, "coordinator");
  x.c.updateTask(yours.id, { status: "rejected" }, "coordinator");
  expect(x.c.claims().filter((q) => q.taskId === yours.id).map((q) => q.owner)).toEqual(["mine"]);
  // An uncertain launch stays held for a look; an in-flight one it started itself is released.
  const unsure = x.c.createTask({ title: "Unsure", objectiveId: o.id, acceptance: ["done"], scope: { paths: [`${x.root}/src/u.ts`], resources: [] } }, "coordinator");
  const r = x.c.reserveLaunch(unsure.id, x.root);
  x.c.updateReservation({ ...r, state: "uncertain" });
  x.c.updateTask(unsure.id, { status: "rejected" }, "coordinator");
  expect(x.c.reservation(unsure.id)!.state).toBe("uncertain");
  expect(x.c.claims().some((q) => q.owner === `reservation:${r.id}`)).toBe(true);
  const fresh = x.c.createTask({ title: "Fresh", objectiveId: o.id, acceptance: ["done"], scope: { paths: [`${x.root}/src/f.ts`], resources: [] } }, "coordinator");
  const r2 = x.c.reserveLaunch(fresh.id, x.root);
  x.c.updateTask(fresh.id, { status: "rejected" }, "coordinator");
  expect(x.c.reservation(fresh.id)).toBeNull();
  expect(x.c.claims().some((q) => q.owner === `reservation:${r2.id}`)).toBe(false);
  // Its own worker's claims go.
  await plan(x, [planTask("a")]);
  const a = planTasks(x)[0].taskId;
  x.c.updateTask(a, { status: "rejected" }, "coordinator");
  expect(x.c.claims().some((q) => q.taskId === a)).toBe(false);
  expect(x.c.reservation(a)).toBeNull();
});

test("a plan task launches into its own worktree while the shared tree's copy of its file is claimed", async () => {
  const x = fixture();
  x.add("human1");
  x.c.claim("human1", `path:${x.root}/src/a.ts`);
  await plan(x, [planTask("a")]);
  expect(x.launches).toHaveLength(1);
  expect(planTasks(x)[0]).toMatchObject({ state: "launched", attempts: 0 });
});

test("a plan task doesn't wait for a task on the same files in the shared tree: the two meet at merge", async () => {
  const x = fixture();
  const o = x.objective();
  x.add("human1");
  x.c.createTask({ title: "Human's", objectiveId: o.id, owner: "human1", acceptance: ["done"], scope: { paths: [`${x.root}/src/a.ts`], resources: [] } }, "human");
  await plan(x, [planTask("a")]);
  expect(x.launches).toHaveLength(1);
});

test("a queued plan task launches when a launched worker's session ends (registry execution hook, not a transcript event)", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  await plan(x, [planTask("a"), planTask("b")]);
  expect(x.launches).toHaveLength(1);
  expect(planTasks(x).map((q) => q.state)).toEqual(["launched", "waiting"]);
  // The registry ends the session (the process went away): no session_ended event is ingested.
  x.registry.update("worker0", (s) => {
    s.execution = "ended";
  });
  await x.agent.settled();
  expect(x.launches).toHaveLength(2);
  expect(planTasks(x).map((q) => q.state)).toEqual(["launched", "launched"]);
});
