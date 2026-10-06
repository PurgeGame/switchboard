// Regression tests for the adversarial review of the authority work.
// Each failed before its fix.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/daemon/db.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { createWorktree, worktreeSlug } from "../src/daemon/coordinator/worktree.ts";
import { blankSession } from "../src/daemon/state.ts";
import { Registry } from "../src/daemon/registry.ts";
import { startHttp } from "../src/daemon/http.ts";
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

function fixture(opts: { root?: string; grantRoot?: string; verification?: unknown; limits?: any } = {}) {
  const root = opts.root ?? tmp("sb-p1-fixes-");
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
    flags: string[] = [],
    sends: string[] = [];
  let clock = Date.now();
  const deps: any = {
    db: db.db,
    coordination: c,
    cfg: mergeCoordinatorConfig({ limits: opts.limits ?? {} }),
    sessions: () => sessions,
    events: () => [],
    send: async (id: string) => (sends.push(id), { ok: true }),
    launch: async (spec: any) => {
      const id = `worker${launches.length}`;
      launches.push(spec);
      add(id, spec.cwd);
      return id;
    },
    createWorktree: async () => {
      const p = join(root, ".wt");
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
  c.grantObjective(o.id, { root: opts.grantRoot ?? root, resources: ["port:34567"], verification: opts.verification }, "human");
  agent.setMode("active");
  let n = 0;
  const task = (patch: any = {}) =>
    c.createTask(
      { title: "Task", objectiveId: o.id, acceptance: ["answer"], scope: { paths: [join(opts.grantRoot ?? root, `file${n++}`)], resources: [] }, ...patch },
      "human",
    );
  const own = (id = "owner", patch: any = {}) => {
    add(id);
    agent.setAutopilot(id, true);
    return task({ owner: id, ...patch });
  };
  const source = (owner: string, sourceId: string, text = "YES") =>
    db.insertEvent({ sessionId: owner, sourceId, type: "assistant_msg", ts: Date.now() + 1, data: { text } });
  return { root, db, c, sessions, add, agent, deps, o, task, own, source, launches, flags, sends, tick: (ms: number) => (clock += ms) };
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode !== 0) throw Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

// ---------------------------------------------------------------- H1
test("H1: a subdirectory grant runs the worker in that subdirectory of a real git worktree and verifies that file", async () => {
  const base = tmp("sb-p1-h1-"),
    repo = join(base, "repo"),
    pkg = join(repo, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(repo, "out.txt"), "old");
  writeFileSync(join(pkg, "out.txt"), "old");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const x = fixture({
    root: base,
    grantRoot: pkg,
    verification: [{ criterion: "done", kind: "file_contains", path: "out.txt", expected: "DONE" }],
  });
  x.deps.createWorktree = (r: string, slug: string) => createWorktree(join(base, "worktrees"), r, slug); // the real one
  const t = x.task({ acceptance: ["done"], scope: { paths: [join(pkg, "out.txt")], resources: [] } });
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: pkg, reason: "work" });
  expect(r.ok).toBe(true);
  const wtTop = join(base, "worktrees", "repo", worktreeSlug(t.id, t.title));
  expect(x.launches[0].cwd).toBe(join(wtTop, "pkg"));
  expect(x.launches[0].prompt).toContain(`Scope in this working tree: ${join(wtTop, "pkg", "out.txt")}`);
  const owner = x.c.task(t.id)!.owner!;
  x.source(owner, "final", "done");
  // Writing the repo's top-level out.txt must not satisfy a check declared on pkg/out.txt.
  writeFileSync(join(wtTop, "out.txt"), "DONE");
  expect(() => x.c.recordEvidence(t.id, "coordinator", "checked", { criterion: "done", sourceId: "final" })).toThrow(/expected/);
  expect(x.c.task(t.id)!.status).not.toBe("verified");
  writeFileSync(join(wtTop, "pkg", "out.txt"), "DONE");
  expect(x.c.recordEvidence(t.id, "coordinator", "checked", { criterion: "done", sourceId: "final" }).status).toBe("verified");
  git(repo, "worktree", "remove", "--force", wtTop);
});

// ---------------------------------------------------------------- H2
test("H2: coordinator tool outputs hide expected values, hashes and check paths; human views keep them", async () => {
  const hash = "ab".repeat(32);
  const x = fixture({
    verification: [
      { criterion: "answer", kind: "response_equals", expected: "SECRET-ORACLE-1" },
      { criterion: "file", kind: "file_sha256", path: "hidden-oracle-path.txt", expected: hash },
    ],
  });
  const t = x.own("owner", { acceptance: ["answer", "file"] });
  x.source("owner", "ev", "SECRET-ORACLE-1");
  const outputs = [
    await x.agent.callTool("get_state", {}),
    await x.agent.callTool("create_task", { title: "More", objectiveId: x.o.id, scope: { paths: [join(x.root, "more")], resources: [] }, acceptance: ["answer"], reason: "split" }),
    await x.agent.callTool("update_task", { taskId: t.id, result: "partial", reason: "progress" }),
    await x.agent.callTool("record_evidence", { taskId: t.id, criterion: "answer", sourceId: "ev", text: "observed", reason: "check" }),
    await x.agent.callTool("get_state", {}),
  ];
  for (const out of outputs) expect(out.ok).toBe(true);
  const seen = JSON.stringify(outputs) + x.agent.stateDigest();
  expect(seen).not.toContain("SECRET-ORACLE");
  expect(seen).not.toContain(hash);
  expect(seen).not.toContain("hidden-oracle-path");
  const state: any = outputs[0];
  expect(state.result.objectives[0].grant.verification).toEqual([
    { criterion: "answer", kind: "response_equals" },
    { criterion: "file", kind: "file_sha256" },
  ]);
  // The human's views (snapshot = GET /api/coordination, the WS feed) still carry the oracle.
  expect(JSON.stringify(x.c.snapshot())).toContain("SECRET-ORACLE-1");
  expect(x.c.objective(x.o.id)!.grant!.verification[1]).toMatchObject({ expected: hash, path: "hidden-oracle-path.txt" });
});

// ---------------------------------------------------------------- H3
test("H3: a failure before the provider is invoked releases the reservation and its claims; retry works", async () => {
  const x = fixture(),
    t = x.task();
  x.deps.createWorktree = async () => {
    throw Error("git worktree add: branch exists");
  };
  const r: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "first" });
  expect(r.error).toMatch(/before any worker started.*released.*branch exists/);
  expect(x.c.reservations()).toHaveLength(0);
  expect(x.c.claims(["active", "suspect", "waiting"])).toHaveLength(0);
  x.deps.createWorktree = undefined; // missing dependency: same, nothing launched
  expect(((await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "second" })) as any).error).toMatch(/released/);
  expect(x.c.reservations()).toHaveLength(0);
  x.c.grantObjective(x.o.id, { root: x.root, resources: ["port:34567"] }, "human"); // re-grant isn't blocked
  x.deps.createWorktree = async () => join(x.root, ".wt");
  mkdirSync(join(x.root, ".wt"), { recursive: true });
  (x.agent as any).retries.clear(`launch:${t.id}`);
  const third: any = await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, prompt: "now with a working worktree", reason: "third" });
  expect(third.error).toBeUndefined();
  expect(x.launches).toHaveLength(1);
});

test("H3: uncertain reservations stay held and escalated, leave the cap after the window, and a human clear unblocks re-grant and relaunch", async () => {
  const x = fixture({ limits: { maxLaunched: 1 } });
  const stuck = x.task(),
    next = x.task();
  const realLaunch = x.deps.launch;
  x.deps.launch = async () => {
    throw Error("bridge timeout after sending the launch");
  };
  expect(((await x.agent.callTool("launch_session", { taskId: stuck.id, repo: x.root, reason: "a" })) as any).ok).toBe(false);
  expect(x.c.reservation(stuck.id)?.state).toBe("uncertain");
  expect(x.c.claims().every((c) => c.owner.startsWith("reservation:"))).toBe(true);
  expect(x.flags).toContain("Launch reservation needs a look");
  x.deps.launch = realLaunch;
  expect(((await x.agent.callTool("launch_session", { taskId: next.id, repo: x.root, reason: "b" })) as any).error).toMatch(/cap reached/);
  x.tick(31 * 60_000);
  expect(((await x.agent.callTool("launch_session", { taskId: next.id, repo: x.root, reason: "c" })) as any).ok).toBe(true);
  // Still held: the grant can't change and the task can't be relaunched until the human looks.
  expect(() => x.c.grantObjective(x.o.id, { root: x.root }, "human")).toThrow(/reservation\/clear/);
  expect(() => x.c.clearReservation(stuck.id, { as: "not_launched" }, "coordinator" as any)).toThrow(/human/);
  x.agent.clearReservation(stuck.id, "not_launched");
  expect(x.c.reservation(stuck.id)).toBeNull();
  expect(x.c.claims().filter((c) => c.taskId === stuck.id)).toHaveLength(0);
  x.c.grantObjective(x.o.id, { root: x.root, resources: ["port:34567"] }, "human");
  expect(x.db.db.query("SELECT COUNT(*) AS n FROM authority_audit WHERE action='reservation_cleared'").get()).toEqual({ n: 1 });
});

test("H3: the human can confirm an uncertain launch as launched; the worker gets the task and claims", async () => {
  const x = fixture(),
    t = x.task();
  x.deps.launch = async (spec: any) => {
    x.add("ghost", spec.cwd); // the worker started, but the acknowledgment was lost
    throw Error("lost acknowledgment");
  };
  await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "go" });
  expect(x.c.reservation(t.id)?.state).toBe("uncertain");
  x.add("impostor", tmp("sb-p1-elsewhere-"));
  expect(() => x.agent.clearReservation(t.id, "launched", "impostor")).toThrow(/reserved directory/);
  x.agent.clearReservation(t.id, "launched", "ghost");
  expect(x.c.task(t.id)).toMatchObject({ owner: "ghost", status: "in_progress" });
  expect(x.c.claims().every((c) => c.owner === "ghost" && c.state === "active")).toBe(true);
  expect(x.agent.autonomous("ghost")).toBe(true);
});

test("H3: reservation recovery is a human-only HTTP route", async () => {
  const x = fixture(),
    t = x.task();
  x.deps.launch = async () => {
    throw Error("lost");
  };
  await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "go" });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const registry: any = { sessions: x.sessions, onPush: () => {}, list: () => [] };
  const { server } = startHttp({ port, token: "r".repeat(64), coordinatorToken: "c".repeat(64), registry, store: x.db, coordination: x.c, coordinator: x.agent, webDist: x.root, system: () => null } as any);
  cleanup.push(() => server.stop(true));
  const call = (token: string, path: string, body?: any) =>
    fetch(`http://127.0.0.1:${port}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect((await call("c".repeat(64), `tasks/${t.id}/reservation/clear`, { as: "not_launched" })).status).toBe(403);
  expect(((await (await call("r".repeat(64), `tasks/${t.id}/reservation`)).json()) as any).reservation.state).toBe("uncertain");
  expect((await call("r".repeat(64), `tasks/${t.id}/reservation/clear`, { as: "maybe" })).status).toBe(409);
  expect((await call("r".repeat(64), `tasks/${t.id}/reservation/clear`, { as: "not_launched" })).status).toBe(200);
  expect(x.c.reservation(t.id)).toBeNull();
});

// ---------------------------------------------------------------- M1
test("M1: re-granting the same or a containing root keeps a launched worker in its recorded worktree", async () => {
  const base = tmp("sb-p1-m1-"),
    sub = join(base, "sub"),
    worktree = tmp("sb-p1-m1-wt-");
  mkdirSync(sub);
  const x = fixture({ root: base, grantRoot: sub, verification: [{ criterion: "file", kind: "file_contains", path: "file.txt", expected: "OK" }] });
  x.deps.createWorktree = async () => worktree;
  const t = x.task({ acceptance: ["file"], scope: { paths: [join(sub, "file.txt")], resources: [] } });
  expect(((await x.agent.callTool("launch_session", { taskId: t.id, repo: sub, reason: "go" })) as any).ok).toBe(true);
  const worker = x.c.task(t.id)!.owner!;
  x.c.grantObjective(x.o.id, { root: sub, resources: ["port:34567", "port:34568"], verification: [{ criterion: "file", kind: "file_contains", path: "file.txt", expected: "OK" }] }, "human");
  expect(x.agent.autonomous(worker)).toBe(true);
  expect(() => x.agent.assertDispatch(worker, t.id)).not.toThrow();
  x.c.grantObjective(x.o.id, { root: base, verification: [{ criterion: "file", kind: "file_contains", path: "sub/file.txt", expected: "OK" }] }, "human");
  expect(x.agent.autonomous(worker)).toBe(true);
  x.source(worker, "done");
  writeFileSync(join(sub, "file.txt"), "not it"); // the main tree is not the worker's tree
  writeFileSync(join(worktree, "file.txt"), "OK");
  expect(x.c.recordEvidence(t.id, "coordinator", "checked", { criterion: "file", sourceId: "done" }).status).toBe("verified");
  // A different root cuts the worker off.
  const other = join(base, "other");
  mkdirSync(other);
  x.c.grantObjective(x.o.id, { root: other }, "human");
  expect(x.agent.autonomous(worker)).toBe(false);
});

// ---------------------------------------------------------------- M2
test("M2: a human reassignment releases the old owner's claims for that task, recorded in the audit", () => {
  const x = fixture(),
    t = x.own("a", { scope: { paths: [join(x.root, "shared")], resources: ["port:34567"] } });
  x.c.claim("a", "db:unrelated"); // not for this task: untouched
  x.add("b");
  const moved = x.c.updateTask(t.id, { owner: "b" }, "human");
  expect(moved.owner).toBe("b");
  const held = x.c.claims();
  expect(held.filter((c) => c.taskId === t.id).every((c) => c.owner === "b")).toBe(true);
  expect(held.filter((c) => c.taskId === t.id)).toHaveLength(2);
  expect(held.some((c) => c.owner === "a" && c.resource === "db:unrelated")).toBe(true);
  const audit: any = x.db.db.query("SELECT actor, data FROM authority_audit WHERE action='claims_released_on_reassign'").get();
  expect(audit.actor).toBe("human");
  expect(JSON.parse(audit.data)).toMatchObject({ taskId: t.id, from: "a" });
  // A failed reassignment (outside the grant) rolls back: nothing released.
  x.add("outside", tmp("sb-p1-out-"));
  expect(() => x.c.updateTask(t.id, { owner: "outside" }, "human")).toThrow(/outside human grant/);
  expect(x.c.claims().filter((c) => c.taskId === t.id).every((c) => c.owner === "b")).toBe(true);
});

test("M2: after a revoke the human can still edit title and description", () => {
  const x = fixture(),
    t = x.own();
  x.c.updateTask(t.id, { status: "in_progress" }, "human");
  x.c.revokeObjective(x.o.id, "human");
  expect(x.c.updateTask(t.id, { title: "Renamed", description: "Clarified" }, "human")).toMatchObject({ title: "Renamed", description: "Clarified" });
  expect(() => x.c.checkDispatch(t.id, "owner")).toThrow(/grant/);
});

test("M2: a legacy (ungranted) objective can hold a human-assigned task; dispatch stays refused until granted", () => {
  const x = fixture();
  const legacy = x.c.createObjective("Legacy", "", undefined, "human");
  x.add("human-picked");
  x.agent.setAutopilot("human-picked", true);
  const t = x.c.createTask(
    { title: "Old work", objectiveId: legacy.id, owner: "human-picked", acceptance: ["done"], scope: { paths: [join(x.root, "old")], resources: [] } },
    "human",
  );
  expect(t).toMatchObject({ owner: "human-picked", status: "assigned" });
  const t2 = x.c.createTask({ title: "Second", objectiveId: legacy.id, acceptance: ["done"], scope: { paths: [join(x.root, "old2")], resources: [] } }, "human");
  expect(x.c.updateTask(t2.id, { owner: "human-picked" }, "human").owner).toBe("human-picked");
  expect(() => x.c.checkDispatch(t.id, "human-picked")).toThrow(/grant/);
  expect(() => x.agent.assertDispatch("human-picked", t.id, true)).toThrow(/grant/);
});

// ---------------------------------------------------------------- M3
test("M3: coordinator evidence never overwrites or supersedes a human verification", () => {
  const x = fixture(),
    t = x.own("owner", { acceptance: ["code reviewed"] });
  x.c.recordEvidence(t.id, "human", "I reviewed the diff", { criterion: "code reviewed" });
  expect(x.c.task(t.id)!.status).toBe("verified");
  x.source("owner", "later", "looks fine to me");
  x.c.recordEvidence(t.id, "coordinator", "model says reviewed", { criterion: "code reviewed", sourceId: "later" });
  const after = x.c.task(t.id)!;
  expect(after.status).toBe("verified");
  expect(after.verifiedEvidence!.some((e) => e.by === "human" && e.verifiedBy === "human")).toBe(true);
});

test("M3: the coordinator can't reject human-created tasks, change a verified task's status, or rewrite its description", async () => {
  const x = fixture();
  const human = x.task();
  const r = await x.agent.callTool("update_task", { taskId: human.id, status: "rejected", reason: "drop it" });
  expect(r.ok).toBe(false);
  expect(x.c.task(human.id)!.status).not.toBe("rejected");
  const t = x.own("owner", { acceptance: ["code reviewed"] });
  x.c.recordEvidence(t.id, "human", "reviewed", { criterion: "code reviewed" });
  expect((await x.agent.callTool("update_task", { taskId: t.id, status: "finished_unverified", reason: "undo" })).ok).toBe(false);
  expect((await x.agent.callTool("update_task", { taskId: t.id, description: "something else entirely", reason: "rewrite" })).ok).toBe(false);
  expect(x.c.task(t.id)).toMatchObject({ status: "verified", description: "" });
  // Its own tasks remain its to reject.
  const mine: any = await x.agent.callTool("create_task", { title: "Mine", objectiveId: x.o.id, scope: { paths: [join(x.root, "mine")], resources: [] }, acceptance: ["a"], reason: "plan" });
  expect((await x.agent.callTool("update_task", { taskId: mine.result.id, status: "rejected", reason: "obsolete" })).ok).toBe(true);
});

// ---------------------------------------------------------------- M4
test("M4: legacy relative claims and relative edit paths never throw; they resolve against the session cwd", () => {
  const x = fixture();
  x.add("legacy");
  x.db.db.query("INSERT INTO claims (resource, owner, state, data) VALUES (?,?,?,?)").run("path:src/**", "legacy", "active", "{}");
  const id = (x.db.db.query("SELECT MAX(id) AS id FROM claims").get() as any).id;
  const legacy = { id, resource: "path:src/**", owner: "legacy", taskId: null, exclusive: true, state: "active", createdAt: 0, heartbeatAt: Date.now(), note: null };
  x.db.db.query("UPDATE claims SET data=? WHERE id=?").run(JSON.stringify(legacy), id);
  x.c.session = (sid) => x.sessions.get(sid);
  const blocked = x.c.claim("other", `path:${join(x.root, "src/a.ts")}`);
  expect(blocked.granted).toBe(false);
  expect(blocked.blockedBy?.owner).toBe("legacy");
  expect(x.c.lookup(join(x.root, "src/b.ts"), "other").claimedBy?.owner).toBe("legacy");
  x.add("editor");
  const conflicts: string[] = [];
  x.c.onConflict = (c) => conflicts.push(c.kind);
  expect(() => x.c.onEvent({ sessionId: "editor", sourceId: "e1", type: "tool_call", ts: Date.now(), data: { name: "apply_patch", paths: ["src/c.ts"] } }, x.sessions)).not.toThrow();
  expect(conflicts).toContain("claimed_area");
  expect(x.c.lookup("src/c.ts", "editor").claimedBy?.owner).toBe("legacy");
  // Owner cwd unknown: the claim can't be placed, so it matches nothing (and still doesn't throw).
  x.sessions.delete("legacy");
  expect(x.c.claim("third", `path:${join(x.root, "src/d.ts")}`).granted).toBe(true);
});

test("M4: one event hook's exception doesn't skip the others", () => {
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const registry = new Registry([], store, {} as any);
  registry.sessions.set("s", { ...blankSession("s", "claude", "tui", "s"), cwd: "/tmp" });
  const seen: string[] = [];
  registry.eventHooks.push(() => {
    throw Error("Absolute path required");
  });
  registry.eventHooks.push((e) => seen.push(e.sourceId));
  const orig = console.error;
  console.error = () => {};
  try {
    registry.ingest("s", [{ sessionId: "s", sourceId: "x1", type: "assistant_msg", ts: Date.now(), data: { text: "hi" } }]);
  } finally {
    console.error = orig;
  }
  expect(seen).toEqual(["x1"]);
});

// ---------------------------------------------------------------- lows
test("L1: actor is never assumed to be the human", () => {
  const x = fixture(),
    t = x.task();
  const loose = x.c as any;
  expect(() => loose.createObjective("Self")).toThrow(/human/);
  expect(() => loose.grantObjective(x.o.id, { root: x.root })).toThrow(/human/);
  expect(() => loose.revokeObjective(x.o.id)).toThrow(/human/);
  expect(() => loose.updateTask(t.id, { acceptance: ["always passes"] })).toThrow(/human/);
  // Without an actor, task creation gets the coordinator's checks (scope inside the grant).
  expect(() => loose.createTask({ title: "x", objectiveId: x.o.id, acceptance: ["a"], scope: { paths: ["/elsewhere/x"], resources: [] } })).toThrow(/outside human grant/);
});

test("L2: approving a held message while paused says why, and the proposal stays pending", async () => {
  const x = fixture(),
    t = x.own();
  const held: any = await x.agent.callTool("send_message", { sessionId: t.owner, taskId: t.id, text: "git reset --hard", reason: "screen" });
  x.agent.setMode("paused");
  await expect(x.agent.approve(held.result.proposal.id)).rejects.toThrow(/while the coordinator is paused.*still pending/);
  expect(x.agent.proposal(held.result.proposal.id)!.state).toBe("pending");
});

test("L6/L7: reservation claims aren't swept as orphaned; grants need an existing, bounded root", () => {
  const x = fixture(),
    t = x.task();
  x.c.reserveLaunch(t.id, x.root);
  expect(x.c.sweep(x.sessions).orphaned).toHaveLength(0);
  expect(x.c.claims()[0].state).toBe("active");
  const o = x.c.createObjective("Broad", "", undefined, "human");
  expect(() => x.c.grantObjective(o.id, { root: "/" }, "human")).toThrow(/too broad/);
  expect(() => x.c.grantObjective(o.id, { root: join(x.root, "missing") }, "human")).toThrow(/existing directory/);
});

// ---------------------------------------------------------------- P1-A5
test("P1-A5: approving a create_objective proposal creates the objective with a human grant on its root", async () => {
  const x = fixture(),
    repo = tmp("sb-p1-a5-");
  const before = x.c.snapshot().objectives.length;
  const r: any = await x.agent.callTool("create_objective", { title: "Ship it", description: "d", root: repo, resources: ["port:4000"], reason: "user asked" });
  expect(r.result.proposed).toBe(true);
  expect(x.c.snapshot().objectives).toHaveLength(before); // nothing until the human clicks
  const approved = await x.agent.approve(r.result.proposal.id);
  expect(approved.state).toBe("approved");
  const o = x.c.snapshot().objectives.find((o) => o.title === "Ship it")!;
  expect(o.grant).toMatchObject({ root: repo, resources: ["port:4000"], verification: [], issuedBy: "human", revokedAt: null, provenance: `human approved proposal #${r.result.proposal.id}` });
  await expect(x.agent.approve(r.result.proposal.id)).rejects.toThrow(/approved/);
});

test("P1-A5: approval fails clearly when the proposed root isn't an existing directory, creating nothing", async () => {
  const x = fixture();
  const before = x.c.snapshot().objectives.length;
  const r: any = await x.agent.callTool("create_objective", { title: "Nowhere", root: join(x.root, "does-not-exist"), reason: "r" });
  await expect(x.agent.approve(r.result.proposal.id)).rejects.toThrow(/not an existing directory.*Nothing was created/);
  expect(x.c.snapshot().objectives).toHaveLength(before);
  expect(x.agent.proposal(r.result.proposal.id)!.state).toBe("pending");
  expect((await x.agent.callTool("create_objective", { title: "No root", reason: "r" })).ok).toBe(false);
});
