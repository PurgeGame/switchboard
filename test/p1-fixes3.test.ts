// p1/fixes3: regressions for the automated security review of p1/fixes2 (3465b26).
// Each test fails on integrate/final 0204ce3 and passes after the fix.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import * as grants from "../src/daemon/grants.ts";
import { createWorktree } from "../src/daemon/coordinator/worktree.ts";
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
  const root = tmp("sb-p1-fixes3-");
  const db = new Store("", ":memory:");
  cleanup.push(() => db.db.close());
  const c = new Coordination(db),
    sessions = new Map<string, Session>();
  const add = (id: string, cwd = root) => {
    const s = { ...blankSession(id, "claude", "tui", id), cwd, execution: "idle" as const };
    sessions.set(id, s);
    return s;
  };
  const worktreeRepos: string[] = [];
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
    createWorktree: async (repo: string, slug: string) => {
      worktreeRepos.push(repo);
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
  return { root, db, c, sessions, add, agent, deps, o, task, own, launches, flags, worktreeRepos, tick: (ms: number) => (clock += ms) };
}

// ---------------------------------------------------------------- 1. authorization bypass
test("1: a coordinator edit can't turn a human-verified task into 'blocked' when a prerequisite was later unverified", async () => {
  const x = fixture();
  const a = x.task({ acceptance: ["a done"] });
  x.c.recordEvidence(a.id, "human", "ok", { criterion: "a done" });
  const b = x.task({ acceptance: ["b done"], prerequisites: [a.id] });
  x.c.recordEvidence(b.id, "human", "ok", { criterion: "b done" });
  expect(x.c.task(b.id)!.status).toBe("verified");
  // The human re-scopes A, which unverifies A (legitimately). B's own verification still stands.
  x.c.updateTask(a.id, { scope: { paths: [join(x.root, "moved")], resources: [] } }, "human");
  expect(x.c.task(a.id)!.status).toBe("finished_unverified");
  expect(x.c.isVerified(x.c.task(b.id)!)).toBe(true);
  // A harmless-looking coordinator edit (priority) used to recompute B as blocked, dropping the
  // human verification; once A was re-verified B came back as unassigned, not verified.
  await x.agent.callTool("update_task", { taskId: b.id, priority: "high", reason: "bump" });
  expect(x.c.task(b.id)!.status).toBe("verified");
  await x.agent.callTool("update_task", { taskId: b.id, status: "blocked", reason: "wait for A" });
  expect(x.c.task(b.id)!.status).toBe("verified");
  x.c.recordEvidence(a.id, "human", "ok again", { criterion: "a done" });
  expect(x.c.task(b.id)!.status).toBe("verified");
});

// ---------------------------------------------------------------- 3. TOCTOU (check-then-use)
test("3: the approved root is validated and stored as one value: a symlink swapped in mid-approval is refused", async () => {
  const x = fixture();
  const parent = tmp("sb-p1-fixes3-roots-");
  const repo = join(parent, "proj"),
    elsewhere = join(parent, "elsewhere");
  mkdirSync(repo);
  mkdirSync(elsewhere);
  const p: any = await x.agent.callTool("create_objective", { title: "Innocent", root: repo, reason: "r" });
  const orig = grants.canonical;
  let calls = 0;
  const spy = spyOn(grants, "canonical").mockImplementation((path: string) => {
    // The plain-path check sees a real directory; the worker swaps in a symlink right after.
    if (path === repo && ++calls === 2) {
      renameSync(repo, join(parent, "proj.orig"));
      symlinkSync(elsewhere, repo);
    }
    return orig(path);
  });
  try {
    await x.agent.approve(p.result.proposal.id).catch(() => {});
  } finally {
    spy.mockRestore();
  }
  const granted = x.c.snapshot().objectives.filter((o) => o.title === "Innocent");
  for (const o of granted) expect(o.grant!.root).toBe(repo);
  expect(granted.length).toBe(0);
});

test("3: a launch validates the repository's real path and then uses that path, never the caller's string", async () => {
  const x = fixture();
  const links = tmp("sb-p1-fixes3-links-");
  const link = join(links, "repo");
  symlinkSync(x.root, link); // resolves into the grant now; a worker can repoint it at any time
  const t = x.task();
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: link, reason: "go" });
  expect(r.ok).toBe(true);
  expect(x.worktreeRepos).toEqual([x.root]);
  // Without a worktree (held, then approved by the human), the worker starts in the validated root.
  const u = x.task();
  const held: any = await x.agent.callTool("launch_session", { taskId: u.id, repo: link, worktree: false, reason: "go" });
  expect(held.result.held).toBe(true);
  await x.agent.approve(held.result.proposal.id);
  expect(x.launches.at(-1).cwd).toBe(x.root);
});

test("3: a pre-planted symlink at the predictable worktree path is refused, not launched into", async () => {
  const repo = tmp("sb-p1-fixes3-git-"),
    wtRoot = tmp("sb-p1-fixes3-wt-"),
    outside = tmp("sb-p1-fixes3-out-");
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
    if (p.exitCode !== 0) throw Error(p.stderr.toString());
  };
  git("init", "-q");
  writeFileSync(join(repo, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "init");
  const name = repo.split("/").pop()!.replace(/[^\w.-]/g, "_");
  mkdirSync(join(wtRoot, name));
  symlinkSync(outside, join(wtRoot, name, "task-1")); // a worker planted it before the launch
  await expect(createWorktree(wtRoot, repo, "task-1")).rejects.toThrow(/symlink|not a worktree/);
  // A real, fresh worktree still works.
  expect(await createWorktree(wtRoot, repo, "task-2")).toBe(join(wtRoot, name, "task-2"));
});

// ---------------------------------------------------------------- 2. resource cap defeat
test("2: two live workers sharing a directory (one unrecorded) both count toward maxLaunched", async () => {
  const x = fixture({ limits: { maxLaunched: 2 } });
  const a = x.task(),
    b = x.task(),
    c = x.task();
  // A: a human-approved launch without a worktree; worker0 runs in the grant root.
  const ha: any = await x.agent.callTool("launch_session", { taskId: a.id, repo: x.root, worktree: false, reason: "a" });
  await x.agent.approve(ha.result.proposal.id);
  expect(x.c.reservation(a.id)).toMatchObject({ state: "launched", sessionId: "worker0" });
  // B: same, but the acknowledgment is lost after the worker started (uncertain, no session id).
  x.deps.launch = async (spec: any) => {
    x.add("ghost", spec.cwd);
    throw Error("lost acknowledgment");
  };
  const hb: any = await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, worktree: false, reason: "b" });
  await x.agent.approve(hb.result.proposal.id);
  expect(x.c.reservation(b.id)?.state).toBe("uncertain");
  x.tick(31 * 60_000);
  x.deps.launch = async (spec: any) => (x.add("extra", spec.cwd), "extra");
  // Two live workers: worker0 must not also stand in for the ghost.
  const r: any = await x.agent.callTool("launch_session", { taskId: c.id, repo: x.root, reason: "c" });
  expect(r.error).toMatch(/cap reached/);
  x.sessions.get("ghost")!.execution = "ended";
  expect(((await x.agent.callTool("launch_session", { taskId: c.id, repo: x.root, reason: "c2" })) as any).ok).toBe(true);
});

test("2: an unrecorded worker that reports a subdirectory of the reserved directory still counts", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  const a = x.task(),
    b = x.task();
  x.deps.launch = async (spec: any) => {
    x.add("ghost", join(spec.cwd, "pkg"));
    throw Error("lost acknowledgment");
  };
  await x.agent.callTool("launch_session", { taskId: a.id, repo: x.root, reason: "a" });
  expect(x.c.reservation(a.id)?.state).toBe("uncertain");
  x.tick(31 * 60_000);
  x.deps.launch = async (spec: any) => (x.add("extra", spec.cwd), "extra");
  expect(((await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, reason: "b" })) as any).error).toMatch(/cap reached/);
  x.sessions.get("ghost")!.execution = "ended";
  expect(((await x.agent.callTool("launch_session", { taskId: b.id, repo: x.root, reason: "b2" })) as any).ok).toBe(true);
});
