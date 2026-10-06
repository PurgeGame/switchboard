// p1/fixes4: regressions for the automated security review of p1/fixes3 (f1884d5):
// authority is bound to the granted directory itself (device + inode), not just its name, and
// worktree creation is validated after the fact. Tests use temp dirs and throwaway git repos.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
/** Swap a directory for a different one of the same name: no symlink anywhere afterwards. */
const replaceDir = (p: string) => {
  renameSync(p, p + ".old");
  mkdirSync(p);
};

function fixture(opts: { verification?: unknown } = {}) {
  const base = tmp("sb-p1-fixes4-"),
    root = join(base, "repo"),
    wt = join(base, "worktrees");
  mkdirSync(root);
  mkdirSync(wt);
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
  const deps: any = {
    db: db.db,
    coordination: c,
    cfg: mergeCoordinatorConfig({}),
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
      const p = join(wt, slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    escalate: (_: any, title: string) => flags.push(title),
    push: () => {},
    now: () => Date.now(),
    timers: false,
  };
  const agent = new CoordinatorAgent(deps);
  const o = c.createObjective("Human objective", "", undefined, "human");
  c.grantObjective(o.id, { root, resources: [], verification: opts.verification }, "human");
  agent.setMode("active");
  let n = 0;
  const task = (patch: any = {}) =>
    c.createTask({ title: "Task", objectiveId: o.id, acceptance: ["answer"], scope: { paths: [join(root, `file${n++}`)], resources: [] }, ...patch }, "human");
  const source = (owner: string, sourceId: string, text = "YES") =>
    db.insertEvent({ sessionId: owner, sourceId, type: "assistant_msg", ts: Date.now() + 1, data: { text } });
  return { base, root, wt, db, c, sessions, add, agent, deps, o, task, source, launches, flags };
}

function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    if (p.exitCode !== 0) throw Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  git("init", "-q");
  writeFileSync(join(dir, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "init");
  return git;
}

// ---------------------------------------------------------------- 1. grant root identity
test("1: a grant root replaced by another directory of the same name (no symlink) stops dispatch and launch", async () => {
  const x = fixture();
  const t = x.task();
  expect(() => x.c.assertTaskReady(t)).not.toThrow();
  replaceDir(x.root);
  expect(() => x.c.assertTaskReady(t)).toThrow(/Granted root changed/);
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "go" });
  expect(r.ok).toBe(false);
  expect(x.launches).toHaveLength(0);
});

test("1: a grant root swapped while the worktree is being created is caught before the provider is invoked", async () => {
  const x = fixture();
  const t = x.task();
  const make = x.deps.createWorktree;
  x.deps.createWorktree = async (repo: string, slug: string) => {
    replaceDir(x.root); // during the await
    return make(repo, slug);
  };
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "go" });
  expect(r.ok).toBe(false);
  expect(x.launches).toHaveLength(0);
  expect(x.c.reservation(t.id)).toBeNull(); // nothing reached the provider: released
});

// ---------------------------------------------------------------- 2. worker directory binding
test("2: a worktree path that is a symlink when the launch resolves it is refused, not followed", async () => {
  const x = fixture();
  const elsewhere = tmp("sb-p1-fixes4-elsewhere-");
  x.deps.createWorktree = async (_repo: string, slug: string) => {
    const p = join(x.wt, slug);
    symlinkSync(elsewhere, p); // swapped in after createWorktree's own checks
    return p;
  };
  const t = x.task();
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "go" });
  expect(r.ok).toBe(false);
  expect(x.launches).toHaveLength(0);
});

test("2: a launched worker's directory replaced after launch loses its binding and its file checks", async () => {
  const x = fixture({ verification: [{ criterion: "done", kind: "file_contains", path: "out.txt", expected: "DONE" }] });
  const t = x.task({ acceptance: ["done"], scope: { paths: [join(x.root, "out.txt")], resources: [] } });
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "go" });
  expect(r.ok).toBe(true);
  const cwd = x.launches[0].cwd as string;
  const owner = x.c.task(t.id)!.owner!;
  x.source(owner, "final", "done");
  replaceDir(cwd); // e.g. a different checkout moved into place
  writeFileSync(join(cwd, "out.txt"), "DONE");
  expect(() => x.c.recordEvidence(t.id, "coordinator", "checked", { criterion: "done", sourceId: "final" })).toThrow();
  expect(x.c.task(t.id)!.status).not.toBe("verified");
});

test("2: file checks still verify a real file read through the pinned root", async () => {
  const x = fixture({ verification: [{ criterion: "done", kind: "file_contains", path: "out.txt", expected: "DONE" }] });
  x.add("owner");
  x.agent.setAutopilot("owner", true);
  const t = x.task({ owner: "owner", acceptance: ["done"], scope: { paths: [join(x.root, "out.txt")], resources: [] } });
  writeFileSync(join(x.root, "out.txt"), "DONE");
  x.source("owner", "ev", "done");
  expect(x.c.recordEvidence(t.id, "coordinator", "checked", { criterion: "done", sourceId: "ev" }).status).toBe("verified");
});

// ---------------------------------------------------------------- 3. worktree creation validation
test("3: an existing worktree of the same repo on a different branch at the predictable path is not reused", async () => {
  const base = tmp("sb-p1-fixes4-git-"),
    repo = join(base, "repo"),
    wtRoot = join(base, "wt");
  const git = gitRepo(repo);
  git("branch", "planted");
  mkdirSync(join(wtRoot, "repo"), { recursive: true });
  git("worktree", "add", "-q", join(wtRoot, "repo", "task-1"), "planted"); // prepared by a worker
  await expect(createWorktree(wtRoot, repo, "task-1")).rejects.toThrow(/branch|not a worktree/);
  // A retried launch reusing its own sb/<slug> worktree still works.
  const first = await createWorktree(wtRoot, repo, "task-2");
  expect(await createWorktree(wtRoot, repo, "task-2")).toBe(first);
});

test("3: repository hooks and GIT_* environment don't run or redirect worktree creation", async () => {
  const base = tmp("sb-p1-fixes4-git-"),
    repo = join(base, "repo"),
    other = join(base, "other"),
    wtRoot = join(base, "wt"),
    marker = join(base, "hook-ran");
  const git = gitRepo(repo);
  gitRepo(other);
  writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other, ".git");
  try {
    const dir = await createWorktree(wtRoot, repo, "task-1");
    expect(existsSync(marker)).toBe(false);
    expect(git("worktree", "list", "--porcelain")).toContain(dir);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test("3: the repository must still be the granted directory (identity) when the worktree is created", async () => {
  const base = tmp("sb-p1-fixes4-git-"),
    repo = join(base, "repo"),
    wtRoot = join(base, "wt");
  gitRepo(repo);
  const { dirIdentity } = await import("../src/daemon/grants.ts");
  const id = dirIdentity(repo);
  renameSync(repo, repo + ".old");
  gitRepo(repo); // a different repository under the granted name
  await expect(createWorktree(wtRoot, repo, "task-1", id)).rejects.toThrow(/changed|identity/);
  expect(existsSync(join(wtRoot, "repo", "task-1"))).toBe(false);
});

test("3: a world-writable worktree root is refused", async () => {
  const base = tmp("sb-p1-fixes4-git-"),
    repo = join(base, "repo"),
    wtRoot = join(base, "wt");
  gitRepo(repo);
  mkdirSync(wtRoot);
  chmodSync(wtRoot, 0o777);
  await expect(createWorktree(wtRoot, repo, "task-1")).rejects.toThrow(/writable/);
});

test("3: odd repository names (leading dash, spaces, newline) and bad slugs are handled", async () => {
  const base = tmp("sb-p1-fixes4-git-"),
    repo = join(base, "-rf x\ny"),
    wtRoot = join(base, "wt");
  gitRepo(repo);
  const dir = await createWorktree(wtRoot, repo, "task-1");
  expect(dir).toBe(join(wtRoot, "-rf_x_y", "task-1"));
  for (const slug of ["-b", "../x", "a/b", "a..b", "x.lock", "", "A"]) await expect(createWorktree(wtRoot, repo, slug)).rejects.toThrow(/slug/);
});
