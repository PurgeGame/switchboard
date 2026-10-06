// D32: delegation plans. One propose_plan card; the human's single approval grants the root,
// creates the tasks and lets the daemon launch them as they become ready. Fake launcher, temp dirs.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

function fixture(cfg: any = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sb-delegate-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo"),
    wt = join(base, "worktrees");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(wt);
  const db = new Store("", ":memory:");
  cleanup.push(() => db.db.close());
  const c = new Coordination(db),
    sessions = new Map<string, Session>();
  const launches: any[] = [];
  const failing = { worktree: false };
  const agent = new CoordinatorAgent({
    db: db.db,
    coordination: c,
    cfg: mergeCoordinatorConfig(cfg),
    sessions: () => sessions,
    events: () => [],
    send: async () => ({ ok: true }),
    launch: async (spec: any) => {
      const id = `worker${launches.length}`;
      launches.push(spec);
      sessions.set(id, { ...blankSession(id, spec.provider, "tui", id), cwd: spec.cwd, execution: "working" as const });
      return id;
    },
    createWorktree: async (_repo: string, slug: string) => {
      if (failing.worktree) throw new Error("worktree could not be created");
      const p = join(wt, slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    escalate: () => {},
    push: () => {},
    timers: false,
  } as any);
  c.onChange = () => agent.onCoordinationChange(); // as main.ts wires it
  agent.setMode("active");
  return { base, root, c, agent, launches, sessions, failing };
}

const task = (key: string, extra: any = {}) => ({
  key,
  title: `Do ${key}`,
  brief: `Implement ${key} in src/${key}.ts and keep the public API unchanged.`,
  acceptance: [`${key} works`, "bun test passes"],
  provider: "claude",
  tier: "standard",
  paths: [`src/${key}.ts`],
  ...extra,
});
const plan = (root: string, tasks: any[], extra: any = {}) => ({ title: "Ship the feature", root, tasks, reason: "the user asked for it", ...extra });

async function proposeAndApprove(x: ReturnType<typeof fixture>, tasks: any[]) {
  const r: any = await x.agent.callTool("propose_plan", plan(x.root, tasks));
  expect(r.ok).toBe(true);
  const p = await x.agent.approve(r.result.proposal.id, { digest: r.result.proposal.digest });
  await x.agent.settled();
  return { r, p, id: r.result.proposal.id as number };
}
const tasksByTitle = (x: ReturnType<typeof fixture>) => new Map(x.c.snapshot().tasks.map((t) => [t.title, t]));

test("propose_plan validation failures create nothing", async () => {
  const x = fixture();
  const link = join(x.base, "link");
  symlinkSync(x.root, link);
  const bad: [string, any][] = [
    ["relative root", plan("repo", [task("a")])],
    ["missing root", plan(join(x.base, "nope"), [task("a")])],
    ["symlinked root", plan(link, [task("a")])],
    ["dotdot root", plan(`${x.root}/../repo`, [task("a")])],
    ["home root", plan(realpathSync(require("node:os").homedir()), [task("a")])],
    ["no tasks", plan(x.root, [])],
    ["too many tasks", plan(x.root, Array.from({ length: 9 }, (_, i) => task(`t${i}`)))],
    ["duplicate keys", plan(x.root, [task("a"), task("a")])],
    ["unknown prerequisite", plan(x.root, [task("a", { prerequisites: ["zzz"] })])],
    ["self prerequisite", plan(x.root, [task("a", { prerequisites: ["a"] })])],
    ["cycle", plan(x.root, [task("a", { prerequisites: ["c"] }), task("b", { prerequisites: ["a"] }), task("c", { prerequisites: ["b"] })])],
    ["no acceptance", plan(x.root, [task("a", { acceptance: [] })])],
    ["bad provider", plan(x.root, [task("a", { provider: "gpt" })])],
    ["bad tier", plan(x.root, [task("a", { tier: "max" })])],
    ["path outside root", plan(x.root, [task("a", { paths: ["../elsewhere"] })])],
    ["absolute path outside root", plan(x.root, [task("a", { paths: [x.base] })])],
    ["tier override without reason", plan(x.root, [task("a", { tier: "deep" })])],
    ["parallel tasks with overlapping scope", plan(x.root, [task("a", { paths: ["src"] }), task("b")])],
    ["parallel tasks with default (whole-root) scope", plan(x.root, [task("a", { paths: [] }), task("b", { paths: [] })])],
    ["bad resource", plan(x.root, [task("a")], { resources: ["nonsense"] })],
    ["no title", plan(x.root, [task("a")], { title: "" })],
  ];
  for (const [why, args] of bad) {
    const r = await x.agent.callTool("propose_plan", args);
    if (r.ok) throw new Error(`accepted: ${why}`);
  }
  expect(x.agent.proposals().length).toBe(0);
  expect(x.c.snapshot().objectives.length).toBe(0);
  expect(x.c.snapshot().tasks.length).toBe(0);
  // A tier override with a reason is fine; a trailing slash on the root is the same directory.
  const ok: any = await x.agent.callTool("propose_plan", plan(`${x.root}/`, [task("a", { tier: "deep", tierReason: "touches the session protocol" })]));
  expect(ok.ok).toBe(true);
  expect(ok.result.proposal.payload.root).toBe(x.root);
});

test("approve creates the human grant and all tasks, and launches only the ready ones", async () => {
  const x = fixture();
  const { p, id } = await proposeAndApprove(x, [
    task("a", { tier: "deep", tierReason: "auth flow" }),
    task("b", { provider: "codex" }),
    task("c", { prerequisites: ["a", "b"] }),
  ]);
  expect(p.state).toBe("approved");
  const [o] = x.c.snapshot().objectives;
  expect(o.grant!.issuedBy).toBe("human");
  expect(o.grant!.root).toBe(x.root);
  expect(o.grant!.provenance).toBe(`human approved plan #${id}`);
  const t = tasksByTitle(x);
  expect(t.size).toBe(3);
  expect(t.get("Do c")!.prerequisites.sort()).toEqual([t.get("Do a")!.id, t.get("Do b")!.id].sort());
  expect(t.get("Do c")!.status).toBe("blocked");
  expect(t.get("Do a")!.tier).toBe("deep");
  expect(x.launches.length).toBe(2);
  const a = x.launches.find((l) => l.prompt.includes("Do a"))!;
  const b = x.launches.find((l) => l.prompt.includes("Do b"))!;
  expect(a.provider).toBe("claude");
  expect(a.model).toBe("opus");
  expect(a.effort).toBe("xhigh");
  expect(b.provider).toBe("codex");
  expect(b.model).toBe(mergeCoordinatorConfig({}).tiers.standard.codex.model);
  // Brief = task brief + acceptance criteria + how to report back.
  expect(a.prompt).toContain("Implement a in src/a.ts");
  expect(a.prompt).toContain("- a works");
  expect(a.prompt).toContain("reply with what you did and how you verified it");
  expect(a.cwd.startsWith(join(x.base, "worktrees"))).toBe(true);
  expect(t.get("Do a")!.owner).toBe("worker0");
  // Proposal payload carries the resolved model/effort per task (what the card shows).
  const pl: any = x.agent.proposal(id)!.payload;
  expect(pl.tasks.find((q: any) => q.key === "a")).toMatchObject({ model: "opus", effort: "xhigh", provider: "claude" });
});

test("the launch cap is respected: the rest queue and launch when a slot frees up", async () => {
  const x = fixture({ limits: { maxLaunched: 2 } });
  await proposeAndApprove(x, [task("a"), task("b"), task("c")]);
  expect(x.launches.length).toBe(2);
  const waiting = x.agent.plansSnapshot()[0].tasks.filter((q) => q.state === "waiting");
  expect(waiting.length).toBe(1);
  // Nothing new on unrelated changes while the cap is full.
  await x.agent.pumpPlans();
  expect(x.launches.length).toBe(2);
  x.sessions.get("worker0")!.execution = "ended";
  x.agent.onEvent({ sessionId: "worker0", sourceId: "e", type: "session_ended", ts: Date.now(), data: {} } as any);
  await x.agent.settled();
  expect(x.launches.length).toBe(3);
});

test("a dependent launches when its prerequisite is VERIFIED, not on finished_unverified", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("a"), task("b", { prerequisites: ["a"] })]);
  expect(x.launches.length).toBe(1);
  const a = tasksByTitle(x).get("Do a")!;
  x.c.updateTask(a.id, { status: "finished_unverified", result: "added a.ts with tests" }, "human");
  await x.agent.settled();
  expect(x.launches.length).toBe(1);
  expect(tasksByTitle(x).get("Do b")!.status).toBe("blocked");
  for (const criterion of a.acceptance) x.c.recordEvidence(a.id, "human", "checked", { criterion });
  expect(x.c.task(a.id)!.status).toBe("verified");
  await x.agent.settled();
  expect(x.launches.length).toBe(2);
  expect(x.launches[1].prompt).toContain("Implement b");
  expect(x.launches[1].prompt).toContain("added a.ts with tests"); // the prerequisite's result rides along
  expect(tasksByTitle(x).get("Do b")!.owner).toBe("worker1");
});

test("a dependent's launch re-runs the normal gates (paused: stays queued)", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("a"), task("b", { prerequisites: ["a"] })]);
  const a = tasksByTitle(x).get("Do a")!;
  x.agent.setMode("paused");
  for (const criterion of a.acceptance) x.c.recordEvidence(a.id, "human", "checked", { criterion });
  await x.agent.settled();
  expect(x.launches.length).toBe(1);
  x.agent.setMode("active");
  await x.agent.pumpPlans();
  expect(x.launches.length).toBe(2);
});

test("the approval is consumed once", async () => {
  const x = fixture();
  const { id } = await proposeAndApprove(x, [task("a")]);
  await expect(x.agent.approve(id)).rejects.toThrow(/approved/);
  await x.agent.settled();
  expect(x.launches.length).toBe(1);
  expect(x.c.snapshot().objectives.length).toBe(1);
  expect(x.c.snapshot().tasks.length).toBe(1);
});

test("the coordinator can't launch plan tasks without the human's approval", async () => {
  const x = fixture();
  const r: any = await x.agent.callTool("propose_plan", plan(x.root, [task("a")]));
  expect(r.ok).toBe(true);
  // Proposing creates nothing: no objective, no grant, no task to launch.
  expect(x.c.snapshot().objectives.length).toBe(0);
  expect(x.c.snapshot().tasks.length).toBe(0);
  await x.agent.pumpPlans();
  expect(x.launches.length).toBe(0);
  // Approving needs an active coordinator; a paused one leaves the proposal pending.
  x.agent.setMode("paused");
  await expect(x.agent.approve(r.result.proposal.id, { digest: r.result.proposal.digest })).rejects.toThrow(/still pending/);
  expect(x.agent.proposal(r.result.proposal.id)!.state).toBe("pending");
  x.agent.setMode("active");
  x.agent.reject(r.result.proposal.id);
  await expect(x.agent.approve(r.result.proposal.id)).rejects.toThrow(/rejected/);
  await x.agent.pumpPlans();
  expect(x.launches.length).toBe(0);
  expect(x.c.snapshot().tasks.length).toBe(0);
});

test("Settings tier rules override the requested tier, and the override is recorded", async () => {
  const x = fixture({ tierRules: [{ match: "readme", tier: "light", reason: "docs are cheap" }] });
  const r: any = await x.agent.callTool(
    "propose_plan",
    plan(x.root, [task("docs", { title: "Refresh the README", tier: "deep", tierReason: "wanted the best" }), task("code")]),
  );
  expect(r.ok).toBe(true);
  const docs = r.result.proposal.payload.tasks.find((t: any) => t.key === "docs");
  expect(docs.tier).toBe("light");
  expect(docs.requestedTier).toBe("deep");
  expect(docs.tierOverride).toMatch(/asked for deep/);
  expect(docs.model).toBe("haiku");
  expect(r.result.tierOverrides[0]).toMatch(/^docs:/);
  await x.agent.approve(r.result.proposal.id, { digest: r.result.proposal.digest });
  await x.agent.settled();
  const t = tasksByTitle(x).get("Refresh the README")!;
  expect(t.tier).toBe("light");
  expect(x.launches.find((l) => l.prompt.includes("Refresh the README"))!.model).toBe("haiku");
});
test("a dependent on the same files launches once its prerequisite is verified (its claims are released)", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("impl", { paths: ["src"] }), task("review", { paths: ["src"], prerequisites: ["impl"] })]);
  expect(x.launches.length).toBe(1);
  const impl = tasksByTitle(x).get("Do impl")!;
  expect(x.c.claims().some((c) => c.taskId === impl.id)).toBe(true);
  for (const criterion of impl.acceptance) x.c.recordEvidence(impl.id, "human", "checked", { criterion });
  await x.agent.settled();
  expect(x.launches.length).toBe(2);
  expect(x.c.claims().some((c) => c.taskId === impl.id)).toBe(false);
});

test("a task whose scope someone else holds waits without counting as a failed launch", async () => {
  const x = fixture();
  x.sessions.set("human1", { ...require("../src/daemon/state.ts").blankSession("human1", "claude", "tui", "human1"), cwd: x.root, execution: "idle" });
  x.c.claim("human1", `path:${x.root}/src/a.ts`);
  await proposeAndApprove(x, [task("a")]);
  expect(x.launches.length).toBe(0);
  const a = x.agent.plansSnapshot()[0].tasks[0];
  expect(a.state).toBe("waiting");
  expect(a.attempts).toBe(0);
  expect(a.error).toMatch(/held by human1/);
});

test("worktree names fit the strict slug rule for real task ids and any title (found by the live run)", async () => {
  const { worktreeSlug, isValidSlug } = await import("../src/daemon/coordinator/worktree.ts");
  for (const title of ["Create hello.txt containing the line hello", "Ünïcode — title!!", "", "a".repeat(200), "--x--"])
    expect(isValidSlug(worktreeSlug(crypto.randomUUID(), title))).toBe(true);
});

// ---------------------------------------------------------------- D32 hardening (delegate-fixes)
test("approval is bound to the digest of the exact plan shown: missing or stale digests are refused", async () => {
  const x = fixture();
  const r: any = await x.agent.callTool("propose_plan", plan(x.root, [task("a")]));
  const id = r.result.proposal.id;
  expect(typeof r.result.proposal.digest).toBe("string");
  await expect(x.agent.approve(id)).rejects.toThrow(/still pending/);
  await expect(x.agent.approve(id, { digest: "0".repeat(64) })).rejects.toThrow(/still pending/);
  // The stored payload changes after the card was rendered: the old digest no longer matches.
  const shown = r.result.proposal.digest;
  const row = x.agent.proposal(id)!;
  (row.payload as any).tasks[0].brief = "Delete everything under src and force-push.";
  (x.agent as any).saveProposal(row);
  await expect(x.agent.approve(id, { digest: shown })).rejects.toThrow(/changed/);
  expect(x.agent.proposal(id)!.state).toBe("pending");
  expect(x.c.snapshot().objectives.length).toBe(0);
  expect(x.launches.length).toBe(0);
});

test("approval re-checks the plan: a model/tier the Settings now resolve differently is refused", async () => {
  const x = fixture();
  const r: any = await x.agent.callTool("propose_plan", plan(x.root, [task("a")]));
  (x.agent as any).d.cfg.tiers.standard.claude = { model: "haiku", effort: null };
  await expect(x.agent.approve(r.result.proposal.id, { digest: r.result.proposal.digest })).rejects.toThrow(/still pending.*changed/);
  expect(x.c.snapshot().objectives.length).toBe(0);
});

test("the coordinator can't rewrite a plan task after approval (brief, scope, tier, prerequisites, owner)", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("a"), task("b", { prerequisites: ["a"] })]);
  const b = tasksByTitle(x).get("Do b")!;
  const edits = [
    { description: "Do something else entirely, quickly." },
    { scope: { paths: [x.root] } },
    { tier: "deep", tierReason: "bigger model" },
    { prerequisites: [...b.prerequisites, tasksByTitle(x).get("Do a")!.id] },
    { owner: "worker0" },
  ];
  for (const e of edits) {
    const res = await x.agent.callTool("update_task", { taskId: b.id, reason: "test", ...e });
    if (res.ok) throw new Error(`accepted: ${JSON.stringify(e)}`);
  }
  expect(x.c.task(b.id)!.description).toBe(b.description);
});

test("a plan task changed after approval (by anyone) is not auto-launched", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("a"), task("b", { prerequisites: ["a"] })]);
  const a = tasksByTitle(x).get("Do a")!;
  const b = tasksByTitle(x).get("Do b")!;
  x.c.updateTask(b.id, { description: "A different brief than the one approved." }, "human");
  for (const criterion of a.acceptance) x.c.recordEvidence(a.id, "human", "checked", { criterion });
  await x.agent.settled();
  expect(x.launches.length).toBe(1);
  const st = x.agent.plansSnapshot()[0].tasks.find((q) => q.taskId === b.id)!;
  expect(st.state).toBe("skipped");
  expect(st.error).toMatch(/changed after approval/);
});

test("no tasks can be added to a plan's objective, and plan tasks launch only through the plan", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("a"), task("b", { prerequisites: ["a"] })]);
  const [o] = x.c.snapshot().objectives;
  const created = await x.agent.callTool("create_task", {
    title: "Extra",
    description: "Not in the plan the user approved.",
    objectiveId: o.id,
    acceptance: ["done"],
    scope: { paths: [join(x.root, "src/extra.ts")] },
    reason: "test",
  });
  expect(created.ok).toBe(false);
  const b = tasksByTitle(x).get("Do b")!;
  const launched = await x.agent.callTool("launch_session", { taskId: b.id, provider: "codex", repo: x.root, prompt: "something else", reason: "test" });
  expect(launched.ok).toBe(false);
  expect(x.launches.length).toBe(1);
});

test("prerequisite claim release frees only the prerequisite worker's claims inside the dependent's scope", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("impl", { paths: ["src/impl"] }), task("review", { paths: ["src/impl/a.ts", "src/other.ts"], prerequisites: ["impl"] })]);
  const impl = tasksByTitle(x).get("Do impl")!;
  // impl's worker claims all of src/impl (wider than review's src/impl/a.ts); someone else holds a claim tagged with impl.
  x.sessions.set("human1", { ...blankSession("human1", "claude", "tui", "human1"), cwd: x.root, execution: "idle" });
  const other = x.c.claim("human1", `path:${x.root}/src/other.ts`, { taskId: impl.id, exclusive: true } as any);
  expect(x.c.claims(["active"]).some((c) => c.owner === "human1")).toBe(true);
  for (const criterion of impl.acceptance) x.c.recordEvidence(impl.id, "human", "checked", { criterion });
  await x.agent.settled();
  const active = x.c.claims(["active", "suspect"]);
  expect(active.some((c) => c.owner === "human1")).toBe(true); // not ours to release
  expect(active.some((c) => c.owner === "worker0" && c.taskId === impl.id)).toBe(true); // wider than review's scope: kept
  expect(x.launches.length).toBe(1); // review waits on the held claim
  expect(other).toBeTruthy();
});

test("state() exposes plan tasks, so the UI can offer Retry on a failed one; only a failed task retries", async () => {
  const x = fixture({ limits: { maxRetries: 1 } });
  x.failing.worktree = true;
  const { id } = await proposeAndApprove(x, [task("a"), task("b", { prerequisites: ["a"] })]);
  const st = x.agent.state();
  expect(st.plans).toHaveLength(1);
  expect(st.plans[0]).toMatchObject({ proposalId: id, title: "Ship the feature" });
  const a = st.plans[0].tasks.find((q) => q.key === "a")!;
  expect(a).toMatchObject({ title: "Do a", state: "failed" });
  expect(a.error).toContain("worktree could not be created");
  expect(st.plans[0].tasks.find((q) => q.key === "b")!.state).toBe("waiting");
  expect(x.agent.retryPlanTask(id, "b").ok).toBe(false); // not failed
  x.failing.worktree = false;
  expect(x.agent.retryPlanTask(id, "a")).toEqual({ ok: true });
  await x.agent.settled();
  expect(x.agent.state().plans[0].tasks.find((q) => q.key === "a")!.state).toBe("launched");
});

test("the coordinator knows which sessions it launched (background agents)", async () => {
  const x = fixture();
  await proposeAndApprove(x, [task("a")]);
  expect(x.agent.isLaunched("worker0")).toBe(true);
  expect(x.agent.isLaunched("someone-elses")).toBe(false);
});
