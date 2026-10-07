// Plan-launched Codex sessions get linked to their task; a task with a live worker is never
// launched twice; the coordinator settles an uncertain launch itself after the daemon's checks;
// and it can close an idle worker whose task is done, freeing its slot and claims. Fake launcher
// and registry map, temp dirs, in-memory store: no real session.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { similarity } from "../src/daemon/coordinator/policy.ts";
import { Store } from "../src/daemon/db.ts";
import { isLaunchedCodexThread } from "../src/daemon/perspectives.ts";
import { blankSession } from "../src/daemon/state.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

/** `mode` decides what the fake launcher does after the provider is invoked. */
function fixture(cfg: any = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sb-link-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo"),
    wt = join(base, "worktrees");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(wt);
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const c = new Coordination(store);
  const sessions = new Map<string, Session>();
  const clock = { offset: 0 };
  const launches: any[] = [];
  const ended: string[] = [];
  const launcher = { mode: "ok" as "ok" | "lost" | "late" };
  const codex = (id: string, cwd: string, extra: Partial<Session> = {}) => {
    const s: Session = { ...blankSession(id, "codex", "tui", id), cwd, execution: "working", startedAt: Date.now() + clock.offset, ...extra };
    sessions.set(id, s);
    return s;
  };
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: c,
    cfg: mergeCoordinatorConfig({ worktreeRoot: wt, ...cfg }),
    sessions: () => sessions,
    events: () => [],
    send: async () => ({ ok: true }),
    launch: async (spec: any) => {
      launches.push(spec);
      const id = `codex:${launches.length}`;
      // Discovery records the first 1000 characters of the brief the launcher typed.
      const firstPrompt = String(spec.prompt).slice(0, 1000);
      if (launcher.mode === "ok") return (codex(id, spec.cwd, { firstPrompt }), id);
      // The thread shows up only after the launcher stopped waiting ("late": already there when
      // it gives up; "lost": not yet).
      if (launcher.mode === "late") codex(id, spec.cwd, { firstPrompt });
      throw new Error("the new session did not appear in discovery");
    },
    createWorktree: async (repo: string, slug: string) => {
      const p = join(wt, "repo", slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    end: async (id: string) => (ended.push(id), { ok: true, how: "typed the exit command" }),
    escalate: () => {},
    push: () => {},
    now: () => Date.now() + clock.offset,
    timers: false,
  } as any);
  c.onChange = () => agent.onCoordinationChange();
  agent.setMode("active");
  const call = (tool: string, args: any) => agent.callTool(tool, { reason: "checked", ...args }) as Promise<any>;
  return { root, wt, c, agent, sessions, launches, ended, launcher, clock, codex, call };
}

const planTask = (key: string, extra: any = {}) => ({ key, title: `Do ${key}`, brief: `Implement ${key}.`, acceptance: [`${key} works`], provider: "codex", tier: "standard", paths: [`src/${key}.ts`], ...extra });
async function plan(x: ReturnType<typeof fixture>, tasks: any[]) {
  const r: any = await x.agent.callTool("propose_plan", { title: "Plan", root: x.root, tasks, reason: "asked" });
  expect(r.ok).toBe(true);
  await x.agent.approve(r.result.proposal.id, { digest: r.result.proposal.digest });
  await x.agent.settled();
}
const planTasks = (x: ReturnType<typeof fixture>) => x.agent.plansSnapshot()[0].tasks;

test("the launcher recognizes its Codex thread by the clipped first prompt or by its process", () => {
  const brief = `[coordinator] ${"Implement the limiter in src/limit.ts with a token bucket; keep the API. ".repeat(40)}\n\nTask 8f5a8724: Limiter\nAcceptance criteria:\n- tests pass`;
  expect(brief.length).toBeGreaterThan(2500);
  const firstPrompt = brief.slice(0, 1000); // what discovery records
  expect(similarity(firstPrompt, brief)).toBeLessThan(0.9); // why the old whole-brief match never fired
  const s = { ...blankSession("codex:01a11391", "codex", "tui", "01a11391"), cwd: "/wt/repo/8f5a8724-limiter", startedAt: 2000, firstPrompt, pid: 4242 } as Session;
  const launch = { cwd: "/wt/repo/8f5a8724-limiter", startedAt: 1000, prompt: brief, pid: 999 };
  expect(isLaunchedCodexThread(s, launch)).toBe(true);
  expect(isLaunchedCodexThread({ ...s, firstPrompt: "something else entirely, typed by the user" }, launch)).toBe(false);
  expect(isLaunchedCodexThread({ ...s, firstPrompt: null }, { ...launch, pid: 4242 })).toBe(true); // the process it started
  expect(isLaunchedCodexThread(s, { ...launch, cwd: "/elsewhere" })).toBe(false);
  expect(isLaunchedCodexThread(s, { ...launch, startedAt: 60_000 })).toBe(false); // started before this launch
});

test("a Codex thread that shows up after the launcher gave up is linked to its task (immediately, or when the registry sees it)", async () => {
  const x = fixture();
  // Already there when the launcher gives up: linked at once, the plan shows it launched.
  x.launcher.mode = "late";
  await plan(x, [planTask("a")]);
  const a = x.c.task(planTasks(x)[0].taskId)!;
  expect(a.owner).toBe("codex:1");
  expect(x.c.reservation(a.id)!.state).toBe("launched");
  expect(x.agent.isLaunched("codex:1")).toBe(true);
  expect(planTasks(x)[0]).toMatchObject({ state: "launched", sessionId: "codex:1" });
  // Not there yet: the launch stays uncertain, and the coordinator (not the user) is told.
  const y = fixture();
  y.launcher.mode = "lost";
  await plan(y, [planTask("b")]);
  const b = y.c.task(planTasks(y)[0].taskId)!;
  const r = y.c.reservation(b.id)!;
  expect(r.state).toBe("uncertain");
  expect(b.owner).toBeNull();
  expect((y.agent as any).pending.some((e: any) => e.kind === "launch_uncertain")).toBe(true);
  // A session you open in that folder yourself is never taken over as the worker.
  y.agent.linkWorker(y.codex("codex:yours", r.cwd!, { firstPrompt: "let me look at what's in this worktree" }));
  expect(y.c.task(b.id)!.owner).toBeNull();
  expect(y.agent.isLaunched("codex:yours")).toBe(false);
  expect((await y.call("resolve_launch", { taskId: b.id, sessionId: "codex:yours" })).error).toMatch(/started with this launch's brief/);
  y.sessions.get("codex:yours")!.execution = "ended";
  // The thread the launcher started appears; the registry's execution hook (main.ts) links it.
  y.agent.linkWorker(y.codex("codex:01a11391", r.cwd!, { firstPrompt: y.launches[0].prompt.slice(0, 1000) }));
  expect(y.c.task(b.id)!.owner).toBe("codex:01a11391");
  expect(y.c.task(b.id)!.status).toBe("in_progress");
  expect(y.agent.isLaunched("codex:01a11391")).toBe(true);
  expect(planTasks(y)[0]).toMatchObject({ state: "launched", sessionId: "codex:01a11391" });
  expect(y.c.claims().every((q) => q.owner === "codex:01a11391")).toBe(true);
});

test("a task with a live worker is never launched again, even after its launch was cleared as not launched", async () => {
  const x = fixture({ limits: { maxRetries: 5 } });
  x.launcher.mode = "lost";
  await plan(x, [planTask("a")]);
  const id = planTasks(x)[0].taskId;
  const dir = x.c.reservation(id)!.cwd!;
  x.codex("codex:live", dir, { execution: "idle" });
  // Someone clears it as not launched although the worker is running there.
  x.c.clearReservation(id, { as: "not_launched" }, "human");
  await x.agent.pumpPlans();
  expect(x.launches).toHaveLength(1);
  expect(planTasks(x)[0].error).toMatch(/already working in its folder/);
  // A direct launch is refused too.
  const o = x.c.createObjective("Human", "", undefined, "human");
  x.c.grantObjective(o.id, { root: x.root, resources: [] }, "human");
  const t = x.c.createTask({ title: "Solo", objectiveId: o.id, acceptance: ["ok"], scope: { paths: [`${x.root}/src/solo.ts`], resources: [] } }, "human");
  x.launcher.mode = "lost";
  expect((await x.call("launch_session", { taskId: t.id, repo: x.root })).ok).toBe(false);
  const solo = x.c.reservation(t.id)!.cwd!;
  x.codex("codex:solo", solo);
  x.c.clearReservation(t.id, { as: "not_launched" }, "human");
  expect((await x.call("launch_session", { taskId: t.id, repo: x.root, prompt: "again" })).error).toMatch(/already working on this task/);
  expect(x.launches).toHaveLength(2);
});

test("resolve_launch: the coordinator settles an uncertain launch itself, on the daemon's checks", async () => {
  const x = fixture();
  x.launcher.mode = "lost";
  const o = x.c.createObjective("Human", "", undefined, "human");
  x.c.grantObjective(o.id, { root: x.root, resources: [] }, "human");
  const task = (n: string) => x.c.createTask({ title: n, objectiveId: o.id, acceptance: ["ok"], scope: { paths: [`${x.root}/src/${n}.ts`], resources: [] } }, "human");
  const uncertain = async (n: string) => {
    const t = task(n);
    expect((await x.call("launch_session", { taskId: t.id, repo: x.root, provider: "codex" })).ok).toBe(false);
    expect(x.c.reservation(t.id)!.state).toBe("uncertain");
    return { t, dir: x.c.reservation(t.id)!.cwd! };
  };
  // Nothing there yet: too soon to say nothing started; later, the launch and its claims are released.
  const none = await uncertain("none");
  expect((await x.call("resolve_launch", { taskId: none.t.id })).error).toMatch(/yet/);
  x.clock.offset += 4 * 60_000;
  expect((await x.call("resolve_launch", { taskId: none.t.id })).result).toEqual({ as: "not_launched" });
  expect(x.c.reservation(none.t.id)).toBeNull();
  expect(x.c.claims().some((q) => q.taskId === none.t.id)).toBe(false);
  // Two sessions there: the coordinator must name the worker.
  const two = await uncertain("two");
  const brief = x.launches.at(-1).prompt.slice(0, 1000);
  x.codex("codex:x", two.dir, { startedAt: Date.now() + x.clock.offset, firstPrompt: brief });
  x.codex("codex:y", two.dir, { startedAt: Date.now() + x.clock.offset, firstPrompt: brief });
  expect((await x.call("resolve_launch", { taskId: two.t.id })).error).toMatch(/name the worker/);
  expect((await x.call("resolve_launch", { taskId: two.t.id, sessionId: "codex:y" })).result).toEqual({ as: "launched", sessionId: "codex:y" });
  expect(x.c.task(two.t.id)!.owner).toBe("codex:y");
  // A session ran there and ended: its work may be there, so it's the user's call.
  const gone = await uncertain("gone");
  x.codex("codex:gone", gone.dir, { execution: "ended", startedAt: Date.now() + x.clock.offset });
  expect((await x.call("resolve_launch", { taskId: gone.t.id })).error).toMatch(/Tell the user/);
  expect(x.c.reservation(gone.t.id)!.state).toBe("uncertain");
  // Never a launch that completed.
  expect((await x.call("resolve_launch", { taskId: two.t.id })).error).toMatch(/already completed/);
});

test("close_session: an idle worker whose task is done is closed and its claims released; it stopped holding a slot once its task was done", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  await plan(x, [planTask("a"), planTask("b")]);
  expect(x.launches).toHaveLength(1);
  const a = x.c.task(planTasks(x)[0].taskId)!;
  const worker = a.owner!;
  x.c.claim(worker, "port:3000"); // something it holds outside the task
  // Refused while it's busy, or while its task isn't finished.
  expect((await x.call("close_session", { sessionId: worker })).error).toMatch(/working/);
  x.sessions.get(worker)!.execution = "idle";
  expect((await x.call("close_session", { sessionId: worker })).error).toMatch(/isn't finished/);
  for (const criterion of a.acceptance) x.c.recordEvidence(a.id, "human", "checked", { criterion });
  await x.agent.settled();
  expect(x.launches).toHaveLength(2); // an idle worker whose task is verified isn't a real worker: b launched
  // The user talking to it makes it theirs for a while.
  x.agent.onHumanMessage(worker);
  expect((await x.call("close_session", { sessionId: worker })).error).toMatch(/theirs to close/);
  x.clock.offset += 11 * 60_000;
  const closed = await x.call("close_session", { sessionId: worker });
  expect(closed.ok).toBe(true);
  expect(x.ended).toEqual([worker]);
  expect(x.c.claims().some((q) => q.owner === worker)).toBe(false);
  await x.agent.settled();
  expect(x.launches).toHaveLength(2); // nothing more to launch
  // Never a session the user drives.
  x.sessions.set("mine", { ...blankSession("mine", "claude", "tui", "mine"), cwd: x.root, execution: "idle" });
  expect((await x.call("close_session", { sessionId: "mine" })).error).toMatch(/only close workers you launched/);
  expect(x.ended).toEqual([worker]);
});


test("UI close cleanup releases claims and the launch slot for queued work", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  await plan(x, [planTask("a"), planTask("b")]);
  expect(x.launches).toHaveLength(1);
  const task = x.c.task(planTasks(x)[0].taskId)!;
  const id = task.owner!;
  x.c.claim(id, "port:3000");
  x.sessions.get(id)!.execution = "ended";
  x.agent.onSessionClosed(id);
  expect(x.c.claims().some((c) => c.owner === id)).toBe(false);
  expect(x.agent.isLaunched(id)).toBe(false);
  await x.agent.settled();
  expect(x.launches).toHaveLength(2);
  // Closing never completes or reassigns the user's unfinished task.
  expect(x.c.task(task.id)!.owner).toBe(id);
  expect(x.c.task(task.id)!.status).not.toBe("verified");
});
