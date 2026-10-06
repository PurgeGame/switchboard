// p1/fixes2: regressions for the automated security review of p1/fixes (3fb2740).
// Each test fails on integrate/final e4fadf1 and passes after the fix.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Store } from "../src/daemon/db.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { blankSession } from "../src/daemon/state.ts";
import type { Session } from "../src/shared/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

function fixture(opts: { limits?: any } = {}) {
  const root = tmp("sb-p1-fixes2-");
  const db = new Store("", ":memory:");
  cleanup.push(() => db.db.close());
  const c = new Coordination(db),
    sessions = new Map<string, Session>();
  const add = (id: string, cwd = root) => {
    const s = { ...blankSession(id, "claude", "tui", id), cwd, execution: "idle" as const };
    sessions.set(id, s);
    return s;
  };
  const launches: any[] = [],
    flags: string[] = [];
  let clock = Date.now();
  const deps: any = {
    db: db.db,
    coordination: c,
    cfg: mergeCoordinatorConfig({ limits: opts.limits ?? {} }),
    sessions: () => sessions,
    events: () => [],
    send: async () => ({ ok: true }),
    launch: async (spec: any) => {
      const id = `worker${launches.length}`;
      launches.push(spec);
      add(id, spec.cwd);
      return id;
    },
    createWorktree: async (_repo: string, slug: string) => {
      const p = join(root, ".wt", slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    escalate: (_: any, title: string) => flags.push(title),
    push: () => {},
    now: () => clock,
    timers: false,
  };
  const agent = new CoordinatorAgent(deps);
  const o = c.createObjective("Human objective", "", undefined, "human");
  c.grantObjective(o.id, { root, resources: ["port:34567"] }, "human");
  agent.setMode("active");
  let n = 0;
  const task = (patch: any = {}) =>
    c.createTask({ title: "Task", objectiveId: o.id, acceptance: ["answer"], scope: { paths: [join(root, `file${n++}`)], resources: [] }, ...patch }, "human");
  const own = (id = "owner", patch: any = {}) => {
    add(id);
    agent.setAutopilot(id, true);
    return task({ owner: id, ...patch });
  };
  return { root, db, c, sessions, add, agent, deps, o, task, own, launches, flags, tick: (ms: number) => (clock += ms) };
}

// ---------------------------------------------------------------- 1. authorization bypass
test("1: the coordinator can't undo a human verification by changing a verified task's scope, prerequisites or owner", async () => {
  const x = fixture();
  // Owned by an autopilot worker the coordinator may otherwise steer.
  const t = x.own("owner", { acceptance: ["code reviewed"] });
  x.c.recordEvidence(t.id, "human", "I reviewed the diff", { criterion: "code reviewed" });
  expect(x.c.task(t.id)!.status).toBe("verified");
  const other = x.task();
  const attempts: any[] = [
    { scope: { paths: [join(x.root, "elsewhere")] } },
    { prerequisites: [other.id] },
    { owner: null },
  ];
  for (const a of attempts) {
    const r = await x.agent.callTool("update_task", { taskId: t.id, ...a, reason: "tidy up" });
    expect(r.ok).toBe(false);
    expect(x.c.task(t.id)!.status).toBe("verified");
    expect(x.c.isVerified(x.c.task(t.id)!)).toBe(true);
  }
  // Unowned verified task: no autonomy check guards it at all.
  const free = x.task({ acceptance: ["looked at"] });
  x.c.recordEvidence(free.id, "human", "looked", { criterion: "looked at" });
  expect(x.c.task(free.id)!.status).toBe("verified");
  const r = await x.agent.callTool("update_task", { taskId: free.id, scope: { paths: [join(x.root, "else")] }, reason: "re-scope" });
  expect(r.ok).toBe(false);
  expect(x.c.isVerified(x.c.task(free.id)!)).toBe(true);
  // The human still can.
  expect(x.c.updateTask(free.id, { scope: { paths: [join(x.root, "else")], resources: [] } }, "human").status).toBe("finished_unverified");
  // Non-revision edits (priority, tier) stay allowed for the coordinator.
  expect((await x.agent.callTool("update_task", { taskId: t.id, priority: "high", reason: "bump" })).ok).toBe(true);
  expect(x.c.task(t.id)!.status).toBe("verified");
});

test("1b: the coordinator can't launch a worker onto a human-verified task (which would reopen it)", async () => {
  const x = fixture(),
    t = x.task({ acceptance: ["looked at"] });
  x.c.recordEvidence(t.id, "human", "looked", { criterion: "looked at" });
  expect(x.c.task(t.id)!.status).toBe("verified");
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "redo" });
  expect(r.ok).toBe(false);
  expect(x.launches).toHaveLength(0);
  expect(x.c.reservation(t.id)).toBeNull();
  expect(x.c.isVerified(x.c.task(t.id)!)).toBe(true);
});

// ---------------------------------------------------------------- 2. authorization scope bypass
test("2: approving a create_objective proposal grants exactly the shown root: no symlink or .. redirection", async () => {
  const x = fixture();
  const repo = tmp("sb-p1-fixes2-repo-"),
    secret = tmp("sb-p1-fixes2-secret-");
  symlinkSync(secret, join(repo, "proj")); // a worker can plant this; the human sees ".../proj"
  mkdirSync(join(repo, "a"));
  const before = x.c.snapshot().objectives.length;
  for (const root of [join(repo, "proj"), `${repo}/a/../proj`, `${repo}/a/..`]) {
    const p: any = await x.agent.callTool("create_objective", { title: "Innocent", root, reason: "r" });
    await expect(x.agent.approve(p.result.proposal.id)).rejects.toThrow(/Nothing was created/);
    expect(x.agent.proposal(p.result.proposal.id)!.state).toBe("pending");
  }
  expect(x.c.snapshot().objectives).toHaveLength(before);
  expect(x.c.snapshot().objectives.some((o) => o.grant?.root === secret)).toBe(false);
  // A plain canonical path still works (trailing slash tolerated).
  const ok: any = await x.agent.callTool("create_objective", { title: "Plain", root: `${repo}/`, reason: "r" });
  expect((await x.agent.approve(ok.result.proposal.id)).state).toBe("approved");
});

test("2: a grant root that contains the home directory is refused, like / and $HOME", async () => {
  const x = fixture();
  const parent = dirname(realpathSync(homedir())); // e.g. /home (the in-memory store is all that changes)
  const p: any = await x.agent.callTool("create_objective", { title: "Everything", root: parent, reason: "r" });
  await expect(x.agent.approve(p.result.proposal.id)).rejects.toThrow(/too broad/);
  expect(() => x.c.grantObjective(x.o.id, { root: parent }, "human")).toThrow(/too broad/);
  expect(x.c.snapshot().objectives.some((o) => o.grant?.root === parent)).toBe(false);
});

// ---------------------------------------------------------------- 3. resource cap defeat
test("3: an uncertain launch whose worker is live keeps counting toward maxLaunched after the window", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  const a = x.task(),
    b = x.task();
  x.deps.launch = async (spec: any) => {
    x.add("ghost", spec.cwd); // the worker started; the acknowledgment was lost
    throw Error("lost acknowledgment");
  };
  await x.agent.callTool("launch_session", { taskId: a.id, repo: x.root, reason: "a" });
  expect(x.c.reservation(a.id)?.state).toBe("uncertain");
  x.tick(31 * 60_000);
  x.deps.launch = async (spec: any) => (x.add("extra", spec.cwd), "extra");
  const r: any = await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, reason: "b" });
  expect(r.error).toMatch(/cap reached/);
  // Once that worker has ended, the stuck reservation no longer blocks launches (H3 intent).
  x.sessions.get("ghost")!.execution = "ended";
  expect(((await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, reason: "b2" })) as any).ok).toBe(true);
});

test("3: a worker whose launch was invalidated mid-flight (recorded on the reservation) still counts toward the cap", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  const a = x.task(),
    b = x.task();
  const real = x.deps.launch;
  x.deps.launch = async (spec: any) => {
    x.c.updateTask(a.id, { title: "Renamed while launching" }, "human"); // invalidates the launch
    return real(spec);
  };
  const first: any = await x.agent.callTool("launch_session", { taskId: a.id, repo: x.root, reason: "a" });
  expect(first.ok).toBe(false);
  const res = x.c.reservation(a.id)!;
  expect(res).toMatchObject({ state: "uncertain", sessionId: "worker0" });
  x.deps.launch = real;
  x.tick(31 * 60_000);
  expect(((await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, reason: "b" })) as any).error).toMatch(/cap reached/);
  x.sessions.get("worker0")!.execution = "ended";
  expect(((await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, reason: "b2" })) as any).ok).toBe(true);
});
