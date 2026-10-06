// Coordinator agent: every enforcement rule, against a fake runtime and fake sessions (simulator).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";
import { CoordinatorAgent, type LaunchSpec } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Budget, checkSend, screenDestructive, similarity, withPrefix } from "../src/daemon/coordinator/policy.ts";
import { resolveTier, rubricTier, suggestTier } from "../src/daemon/coordinator/tiers.ts";
import { coordinatorArgs, DENIED_BUILTINS, type RuntimeLike } from "../src/daemon/coordinator/runtime.ts";
import { TOOL_NAMES } from "../src/daemon/coordinator/tools.ts";
import type { SbEvent, Session } from "../src/shared/types.ts";

const MIN = 60_000;
// Grants need an existing directory; tests share one named "r" (worktree paths end in /wt/r/…).
const R = join(realpathSync(mkdtempSync(join(tmpdir(), "sb-coordinator-"))), "r");
mkdirSync(R);
afterAll(() => rmSync(dirname(R), { recursive: true, force: true }));

class FakeRuntime implements RuntimeLike {
  running = false;
  busy = false;
  turns: string[] = [];
  starts = 0;
  onText = (_: string) => {};
  onResult = (_: any) => {};
  onExit = (_: number | null) => {};
  start() {
    this.running = true;
    this.starts++;
  }
  stop() {
    this.running = false;
  }
  send(t: string) {
    if (!this.running) return false;
    this.turns.push(t);
    this.busy = true;
    return true;
  }
  finish(cost: number) {
    this.busy = false;
    this.onResult({ total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 10 } });
  }
}

function setup(over: any = {}) {
  let clock = Date.parse("2026-10-06T12:00:00Z");
  const store = new Store("", ":memory:");
  const coordination = new Coordination(store);
  const sessions = new Map<string, Session>();
  const add = (id: string, cwd = R) => {
    const s = Object.assign(blankSession(id, "claude", "tui", id), { execution: "idle" as const, cwd, sendMethods: ["terminal"] }) as Session;
    sessions.set(id, s);
    return s;
  };
  const sent: { sessionId: string; text: string }[] = [];
  const escalations: string[] = [];
  const launches: LaunchSpec[] = [];
  const gov: string[] = [];
  const rt = new FakeRuntime();
  let n = 0;
  const cfg = mergeCoordinatorConfig({ ...over });
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination,
    cfg,
    sessions: () => sessions,
    events: () => [],
    send: async (sessionId, text) => (sent.push({ sessionId, text }), { ok: true }),
    launch: async (spec) => {
      launches.push(spec);
      const id = `w${++n}`;
      add(id, spec.cwd);
      return id;
    },
    // A real directory: launches pin the worker directory's identity (p1/fixes4).
    createWorktree: async (repo, slug) => {
      const p = join(dirname(R), "wt", repo.split("/").pop()!, slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    escalate: (_s, title) => escalations.push(title),
    governor: { throttle: (id) => (gov.push(`throttle ${id}`), true), snapshot: () => ({ ok: 1 }) },
    push: () => {},
    runtime: rt,
    now: () => clock,
    timers: false,
  });
  const humanObjective = (title = "Human objective") => {
    const o = coordination.createObjective(title, "", undefined, "human");
    coordination.grantObjective(o.id, { root: R }, "human");
    return { result: coordination.objective(o.id)! };
  };
  const objective = humanObjective().result;
  let taskNumber = 0;
  const createTask = (args: any) => agent.callTool("create_task", { objectiveId: objective.id, scope: { paths: [`src/task-${++taskNumber}.ts`], resources: [] }, ...args });
  const authorizeSession = (id: string) => coordination.createTask({ title: `Human assignment ${id}`, objectiveId: objective.id, owner: id, scope: { paths: [`src/human-${id}.ts`], resources: [] }, acceptance: ["human review"] }, "human");
  coordination.onChange = () => agent.onCoordinationChange();
  return { agent, coordination, sessions, add, humanObjective, objective, createTask, authorizeSession, sent, escalations, launches, gov, rt, store, cfg, tick: (ms: number) => (clock += ms), now: () => clock };
}

/** An objective with a task and a coordinator-launched worker that owns it. */
async function withWorker(x: ReturnType<typeof setup>) {
  x.agent.setMode("active");
  const o = x.humanObjective();
  const t = (await x.createTask({ title: "Implement the parser", objectiveId: o.result.id, acceptance: ["tests pass"], reason: "step 1" })) as any;
  const l = (await x.agent.callTool("launch_session", { taskId: t.result.id, repo: R, reason: "needs a worker" })) as any;
  expect(l.ok).toBe(true);
  return { objective: o.result, task: t.result, worker: l.result.sessionId as string };
}

describe("tier rubric", () => {
  test("contract/security work is deep, mechanical work is light, else standard; reasons recorded", () => {
    const deep = rubricTier({ title: "Fix reentrancy in withdraw()", paths: ["contracts/Vault.sol"] });
    expect(deep.tier).toBe("deep");
    expect(deep.reason).toMatch(/funds|contracts|Solidity/);
    expect(rubricTier({ title: "Harden the auth middleware against session fixation" }).tier).toBe("deep");
    expect(rubricTier({ title: "Model the game theory of the jackpot incentives" }).tier).toBe("deep");
    expect(rubricTier({ title: "Rename getUser to fetchUser across the codebase" }).tier).toBe("light");
    expect(rubricTier({ title: "Fix typos in README" }).tier).toBe("light");
    expect(rubricTier({ title: "Add pagination to the sessions list" }).tier).toBe("standard");
  });

  test("a config rule overrides the rubric, and the coordinator cannot override a rule", () => {
    const rules = [{ glob: "docs/**", tier: "deep" as const, reason: "docs are legal text here" }];
    const s = suggestTier({ title: "Fix typos", paths: ["docs/terms.md"] }, rules);
    expect(s).toMatchObject({ tier: "deep", source: "rule" });
    expect(resolveTier({ title: "Fix typos", paths: ["docs/terms.md"] }, rules, { tier: "light", reason: "it's just typos" }).tier).toBe("deep");
    expect(suggestTier({ title: "x", paths: ["src/Token.sol"] }, [{ glob: "**/*.sol", tier: "standard" }]).tier).toBe("standard");
  });

  test("coordinator override needs a reason", () => {
    expect(() => resolveTier({ title: "Add pagination" }, [], { tier: "deep" })).toThrow(/tierReason/);
    expect(resolveTier({ title: "Add pagination" }, [], { tier: "deep", reason: "touches billing totals" })).toMatchObject({ tier: "deep", overridden: true });
  });

  test("create_task applies rubric and rules; light results a decision depends on need higher-tier verification", async () => {
    const x = setup({ tierRules: [{ glob: "migrations/**", tier: "deep", reason: "irreversible" }] });
    x.agent.setMode("active");
    const a = (await x.createTask({ title: "Audit the token transfer logic", acceptance: ["report"], reason: "r" })) as any;
    const b = (await x.createTask({ title: "grep for usages of oldApi", acceptance: ["list"], decisionDepends: true, reason: "r" })) as any;
    const c = (await x.createTask({ title: "Rename column", scope: { paths: ["migrations/004.sql"] }, acceptance: ["ok"], reason: "r" })) as any;
    expect(a.result.tier).toBe("deep");
    expect(b.result).toMatchObject({ tier: "light", needsVerification: true });
    expect(c.result.tier).toBe("deep");
    expect(c.result.tierReason).toMatch(/Rule migrations/);
    const v = (await x.agent.callTool("update_task", { taskId: b.result.id, status: "verified", reason: "done" })) as any;
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/evidence/);
  });

  test("launch maps tier to the configured provider model", async () => {
    const x = setup();
    x.agent.setMode("active");
    const o = x.humanObjective();
    const t = (await x.createTask({ title: "Review the signature verification", objectiveId: o.result.id, acceptance: ["a"], reason: "r" })) as any;
    await x.agent.callTool("launch_session", { taskId: t.result.id, repo: R, provider: "codex", reason: "r" });
    expect(x.launches[0]).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "xhigh", cwd: expect.stringContaining("/wt/r/") });
    expect(x.launches[0].prompt.startsWith("[coordinator]")).toBe(true);
  });
});

describe("modes and authority", () => {
  test("manual = off; paused = read-only, takes no actions and never stops workers", async () => {
    const x = setup();
    expect(x.agent.mode).toBe("manual"); // default off
    expect((await x.agent.callTool("get_state", {})).ok).toBe(false);
    const { worker } = await withWorker(x);
    x.agent.setMode("paused");
    expect((await x.agent.callTool("get_state", {})).ok).toBe(true);
    const r = await x.agent.callTool("send_message", { sessionId: worker, text: "hi", reason: "r" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/paused/) });
    expect(x.sessions.get(worker)!.execution).not.toBe("ended");
    expect(x.rt.running).toBe(false); // never started a process: nothing woke it
  });

  test("messages to coordinator-launched sessions go out prefixed; to user-driven sessions they become proposals", async () => {
    const x = setup();
    const { worker } = await withWorker(x);
    x.add("mine");
    x.authorizeSession("mine");
    x.tick(11 * MIN);
    const a = (await x.agent.callTool("send_message", { sessionId: worker, text: "Please also add a test for empty input", reason: "coverage" })) as any;
    expect(a.result.sent).toBe(true);
    expect(x.sent.at(-1)).toMatchObject({ sessionId: worker, text: "[coordinator] Please also add a test for empty input" });
    const b = (await x.agent.callTool("send_message", { sessionId: "mine", text: "Could you rebase onto main?", reason: "r" })) as any;
    expect(b.result.proposed).toBe(true);
    expect(x.sent.some((m) => m.sessionId === "mine")).toBe(false);
    const p = x.agent.proposals()[0];
    expect(p).toMatchObject({ kind: "send_message", heldBecause: "outside_authority", state: "pending" });
    await x.agent.approve(p.id);
    expect(x.sent.at(-1)).toMatchObject({ sessionId: "mine", text: "[coordinator] Could you rebase onto main?" });
  });

  test("autopilot grants autonomy; exclusion revokes everything", async () => {
    const x = setup();
    x.agent.setMode("active");
    x.add("mine");
    x.authorizeSession("mine");
    x.agent.setAutopilot("mine", true);
    expect(((await x.agent.callTool("send_message", { sessionId: "mine", text: "go", reason: "r" })) as any).result.sent).toBe(true);
    x.agent.setExcluded("mine", true);
    x.tick(11 * MIN);
    expect((await x.agent.callTool("send_message", { sessionId: "mine", text: "go on", reason: "r" })).ok).toBe(false);
    expect(x.agent.authority("mine")).toBe("excluded");
  });

  test("governor tools: only for sessions within authority", async () => {
    const x = setup();
    const { worker } = await withWorker(x);
    x.add("mine");
    x.authorizeSession("mine");
    expect((await x.agent.callTool("throttle", { sessionId: "mine", level: 1, reason: "r" })).ok).toBe(false);
    expect((await x.agent.callTool("throttle", { sessionId: worker, level: 1, reason: "r" })).ok).toBe(true);
    expect(x.gov).toEqual([`throttle ${worker}`]);
    expect(((await x.agent.callTool("get_resources", {})) as any).result).toEqual({ ok: 1 });
  });

  test("tool surface: no approvals, shell or git tools; unknown tools refused; reason required", async () => {
    const x = setup();
    x.agent.setMode("active");
    for (const bad of ["answer_approval", "approve", "bash", "run_command", "git", "exec"]) {
      expect(TOOL_NAMES).not.toContain(bad);
      expect((await x.agent.callTool(bad, {})).ok).toBe(false);
    }
    expect((await x.agent.callTool("create_objective", { title: "x" })).ok).toBe(false);
    const argv = coordinatorArgs("haiku", TOOL_NAMES, "/m.json", "/p.md");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--allowedTools") + 1].split(",").every((t) => t.startsWith("mcp__switchboard__"))).toBe(true);
    expect(argv[argv.indexOf("--disallowedTools") + 1].split(",")).toEqual(DENIED_BUILTINS);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--bare");
  });
});

describe("rate limits, budget, retries, loops", () => {
  test("1 message per session per 10 min and 6 per hour; near-duplicates dropped", () => {
    const lim = { perSessionCooldownMs: 10 * MIN, perSessionPerHour: 6, dedupeWindowMs: 60 * MIN };
    const t0 = 1_000_000_000;
    const h = [{ sessionId: "a", at: t0, text: "[coordinator] Please run the test suite and report" }];
    expect(checkSend(h, "a", "something else entirely", lim, t0 + 5 * MIN)).toMatchObject({ ok: false, outcome: "refused" });
    expect(checkSend(h, "a", "something else entirely", lim, t0 + 11 * MIN).ok).toBe(true);
    expect(checkSend(h, "a", "Please run the test suite and report.", lim, t0 + 30 * MIN)).toMatchObject({ ok: false, outcome: "dropped" });
    expect(checkSend(h, "b", "x", lim, t0 + 1).ok).toBe(true);
    const lim2 = { ...lim, perSessionCooldownMs: 0 };
    const six = Array.from({ length: 6 }, (_, i) => ({ sessionId: "a", at: t0 + i * MIN, text: `distinct message number ${i} about topic ${"xyz".repeat(i)}` }));
    expect(checkSend(six, "a", "a seventh, unrelated note", lim2, t0 + 7 * MIN)).toMatchObject({ ok: false, reason: expect.stringMatching(/per hour/) });
    expect(similarity("[coordinator] hello there", "hello there!")).toBeGreaterThan(0.85);
  });

  test("enforced through the agent too", async () => {
    const x = setup();
    const { worker } = await withWorker(x);
    x.tick(11 * MIN); // the launch prompt counts as a message
    expect((await x.agent.callTool("send_message", { sessionId: worker, text: "first update", reason: "r" })).ok).toBe(true);
    const r = (await x.agent.callTool("send_message", { sessionId: worker, text: "a totally different second thing", reason: "r" })) as any;
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cooldown/) });
    expect(x.agent.activity()[0]).toMatchObject({ action: "send_message", outcome: "refused" });
  });

  test("daily budget: cumulative per-process cost, hard stop, flags the user, resets next day", async () => {
    const b = new Budget(1, () => "2026-10-06");
    b.record(0.4);
    b.record(0.7); // cumulative: +0.3
    expect(b.spentUsd).toBeCloseTo(0.7);
    b.newProcess();
    b.record(0.35);
    expect(b.spentUsd).toBeCloseTo(1.05);
    expect(b.exhausted).toBe(true);

    const x = setup({ limits: { dailyBudgetUsd: 0.5 } });
    const { worker } = await withWorker(x);
    x.agent.enqueue({ kind: "turn_ended", sessionId: worker, text: "done" });
    expect(x.agent.flush()).toContain("EVENTS");
    x.rt.finish(0.6);
    expect(x.agent.budget.exhausted).toBe(true);
    expect(x.rt.running).toBe(false);
    expect(x.escalations).toContain("Coordinator budget reached");
    expect((await x.agent.callTool("create_objective", { title: "more", reason: "r" })).ok).toBe(false);
    expect(x.agent.userChat("hello").ok).toBe(false);
    x.tick(24 * 60 * MIN);
    expect(x.agent.budget.exhausted).toBe(false);
  });

  test("cap on concurrent coordinator-launched sessions; retry limit on failing launches", async () => {
    const x = setup({ limits: { maxLaunched: 1 } });
    const { objective } = await withWorker(x);
    const t2 = (await x.createTask({ title: "Second thing", objectiveId: objective.id, acceptance: ["a"], reason: "r" })) as any;
    const r = (await x.agent.callTool("launch_session", { taskId: t2.result.id, repo: R, reason: "r" })) as any;
    expect(r.error).toMatch(/cap reached/);

    const y = setup();
    (y.agent as any).d.launch = async () => {
      throw new Error("no VS Code");
    };
    y.agent.setMode("active");
    const o = y.humanObjective();
    const t = (await y.createTask({ title: "t", objectiveId: o.result.id, acceptance: ["a"], reason: "r" })) as any;
    expect(((await y.agent.callTool("launch_session", { taskId: t.result.id, repo: R, reason: "try 1" })) as any).error).toMatch(/launch failed/);
    expect(((await y.agent.callTool("launch_session", { taskId: t.result.id, repo: R, reason: "try 2" })) as any).error).toMatch(/reservation/);
    expect(((await y.agent.callTool("launch_session", { taskId: t.result.id, repo: R, reason: "try 3" })) as any).error).toMatch(/retry limit/);
  });

  test("doing the same thing again is refused without halting; only a runaway loop halts and flags the user", async () => {
    const x = setup();
    x.agent.setMode("active");
    for (let i = 0; i < 2; i++) expect((await x.agent.callTool("propose_action", { title: "Merge branch A", detail: "d", reason: `r${i}` })).ok).toBe(true);
    const r = await x.agent.callTool("propose_action", { title: "Merge branch A", detail: "d", reason: "r3" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/repeated work/) });
    expect(x.agent.mode).toBe("active");
    expect(x.escalations).not.toContain("Coordinator halted: repeated work");
    // Hammering it anyway is a loop: the backstop halts.
    for (let i = 0; i < 6; i++) await x.agent.callTool("propose_action", { title: "Merge branch A", detail: "d", reason: `again ${i}` });
    expect(x.agent.mode).toBe("active"); // 9 attempts
    await x.agent.callTool("propose_action", { title: "Merge branch A", detail: "d", reason: "tenth" });
    expect(x.agent.mode).toBe("paused");
    expect(x.escalations).toContain("Coordinator halted: repeated work");
  });

  test("refused attempts don't count as repeated work", async () => {
    const x = setup();
    x.agent.setMode("active");
    // Refused twice by a gate (no such task), then the same call is not "the third time".
    for (let i = 0; i < 3; i++) expect(((await x.agent.callTool("update_task", { taskId: "nope", status: "finished_unverified", reason: "r" })) as any).error).toMatch(/unknown task/);
    expect(x.agent.mode).toBe("active");
  });

  test("relay hop cap: a long agent-to-agent chain is cut, halted and flagged", async () => {
    const x = setup({ limits: { maxRelayHops: 2, perSessionCooldownMs: 0, dedupeWindowMs: 0 } });
    const { worker } = await withWorker(x);
    const w2 = x.add("w2");
    x.agent.setAutopilot(w2.id, true);
    x.authorizeSession(w2.id);
    // hop 1: worker's turn -> message w2; hop 2: w2's turn -> message worker; hop 3 would be cut
    const relay = async (from: string, to: string, text: string) => {
      x.agent.enqueue({ kind: "turn_ended", sessionId: from, text: "said something" });
      x.agent.flush();
      x.rt.finish(0);
      return x.agent.callTool("send_message", { sessionId: to, text, reason: "relay" });
    };
    expect((await relay(worker, w2.id, "worker says the API is ready")).ok).toBe(true);
    expect((await relay(w2.id, worker, "w2 says it consumed the API")).ok).toBe(true);
    const third = (await relay(worker, w2.id, "worker replies again about something")) as any;
    expect(third.error).toMatch(/relay hop cap/);
    expect(x.agent.mode).toBe("paused");
  });
});

describe("destructive screen and human override", () => {
  test("best-effort destructive screen holds matching messages for approval", async () => {
    for (const t of ["run git reset --hard origin/main", "just force-push it", "rm -rf build/ and retry", "DROP TABLE users;", "delete the old migration files", "discard your changes and start over"])
      expect(screenDestructive(t)).not.toBeNull();
    expect(screenDestructive("please add a test for the reset button")).toBeNull();
    const x = setup();
    const { worker } = await withWorker(x);
    x.tick(11 * MIN);
    const r = (await x.agent.callTool("send_message", { sessionId: worker, text: "Run git reset --hard to clean up", reason: "r" })) as any;
    expect(r.result.held).toBe(true);
    expect(x.sent.filter((m) => m.sessionId === worker)).toHaveLength(0);
    expect(x.agent.proposals()[0]).toMatchObject({ heldBecause: "destructive_screen", state: "pending" });
    expect(x.agent.state().screenLabel).toMatch(/best-effort/i);
  });

  test("the user messaging a session cancels pending coordinator actions and holds its messages", async () => {
    const x = setup();
    x.agent.setMode("active");
    x.add("mine");
    x.authorizeSession("mine");
    await x.agent.callTool("send_message", { sessionId: "mine", text: "Consider splitting the PR", reason: "r" });
    expect(x.agent.proposals()[0].state).toBe("pending");
    x.tick(1000);
    const ev: SbEvent = { sessionId: "mine", type: "user_msg", ts: x.now(), sourceId: "u1", data: { text: "No, keep it as one PR and add docs" } } as any;
    x.agent.onEvent(ev);
    expect(x.agent.proposals()[0].state).toBe("cancelled");
    x.agent.setAutopilot("mine", true);
    expect(((await x.agent.callTool("send_message", { sessionId: "mine", text: "now do X", reason: "r" })) as any).error).toMatch(/human instructions win/);
    // its own prefixed messages never count as human (and never wake it)
    x.agent.onEvent({ ...ev, data: { text: withPrefix("hello") } } as any);
    // ...including a launch brief that Claude Code recorded as a paste
    x.agent.onEvent({ ...ev, data: { text: `\n\n<pasted_content id="3de0">\n${withPrefix("brief")}\n</pasted_content id="3de0">\n` } } as any);
    expect(x.agent.activity().filter((a) => a.action === "human_override")).toHaveLength(1);
  });

  test("the hold stops messages, not bookkeeping: the task still moves while the user talks to its worker", async () => {
    const x = setup({ limits: { perSessionCooldownMs: 0, dedupeWindowMs: 0 } });
    const { task, worker } = await withWorker(x);
    x.agent.onEvent({ sessionId: worker, type: "user_msg", ts: x.now(), data: { text: "also add a test" } } as any);
    expect(await x.agent.callTool("update_task", { taskId: task.id, status: "finished_unverified", result: "done", reason: "r" })).toMatchObject({ ok: true });
    expect(((await x.agent.callTool("send_message", { sessionId: worker, text: "next step", reason: "r" })) as any).error).toMatch(/human instructions win/);
  });

  test("tell_user's cap counts only unprompted posts since the user last spoke", async () => {
    const x = setup();
    x.agent.setMode("active");
    for (let i = 0; i < 12; i++) {
      x.agent.userChat(`question ${i}`);
      (x.agent as any).addChat("coordinator", `answer ${i}`); // replies to the user don't use up the cap
    }
    expect((await x.agent.callTool("tell_user", { text: "heads up", reason: "r" })).ok).toBe(true);
    for (let i = 0; i < 8; i++) await x.agent.callTool("tell_user", { text: `update ${i}`, reason: "r" });
    expect(((await x.agent.callTool("tell_user", { text: "more", reason: "r" })) as any).error).toMatch(/posted a lot/);
    x.agent.userChat("go on");
    expect((await x.agent.callTool("tell_user", { text: "ok", reason: "r" })).ok).toBe(true);
  });

  test("the user reassigning a task cancels the coordinator's pending actions for it", async () => {
    const x = setup();
    x.agent.setMode("active");
    x.add("mine");
    const t = x.coordination.createTask({ title: "t", owner: null, objectiveId: x.objective.id, scope: { paths: [R + "/reassigned.ts"], resources: [] }, acceptance: ["review"] }, "human");
    await x.agent.callTool("propose_action", { title: "Assign t to w9", detail: "d", taskId: t.id, reason: "r" });
    const updated = x.coordination.updateTask(t.id, { owner: "mine" }, "human");
    x.agent.onHumanTaskEdit(updated, null);
    expect(x.agent.proposals()[0].state).toBe("cancelled");
  });
});

describe("wakes and handoffs", () => {
  test("events are batched into one digest with a state summary; first digest after a restart says so", async () => {
    const x = setup();
    const { worker, task } = await withWorker(x);
    x.agent.enqueue({ kind: "session_started", sessionId: "z", text: "z started" });
    x.agent.enqueue({ kind: "turn_ended", sessionId: worker, text: "turn ended: parser done" });
    const d = x.agent.flush()!;
    expect(x.rt.turns).toHaveLength(1);
    expect(d).toContain("(RE)STARTED");
    expect(d).toContain(task.id);
    expect(d).toContain("EVENTS (3"); // + the mode switch
    x.rt.finish(0.01);
    x.agent.enqueue({ kind: "heartbeat", sessionId: null, text: "hb" });
    expect(x.agent.flush()).not.toContain("(RE)STARTED");
  });

  test("a finished prerequisite unblocks the dependent task and produces handoff material", async () => {
    const x = setup();
    const { objective, task, worker } = await withWorker(x);
    const w2 = x.add("w2");
    x.agent.setAutopilot(w2.id, true);
    x.authorizeSession(w2.id);
    const t2 = (await x.createTask({ title: "Use the parser in the CLI", objectiveId: objective.id, prerequisites: [task.id], owner: w2.id, acceptance: ["cli parses"], reason: "step 2" })) as any;
    expect(t2.result.status).toBe("blocked");
    x.rt.turns = [];
    await x.agent.callTool("update_task", { taskId: task.id, status: "finished_unverified", result: "parser in src/parse.ts, 12 tests", reason: "worker reported" });
    expect(x.coordination.task(t2.result.id)!.status).toBe("blocked");
    x.coordination.recordEvidence(task.id, "human", "Inspected parser tests", { criterion: "tests pass" });
    const d = x.agent.flush()!;
    expect(d).toContain("prerequisites_landed");
    expect(d).toContain("parser in src/parse.ts");
    expect(x.coordination.task(t2.result.id)!.status).toBe("assigned");
    expect((await x.agent.callTool("send_message", { sessionId: w2.id, text: "Handoff: the parser is in src/parse.ts", taskId: t2.result.id, reason: "handoff" })).ok).toBe(true);
    void worker;
  });

  test("state survives a restart: mode, exclusions, launched sessions, rate-limit history", async () => {
    const x = setup();
    const { worker } = await withWorker(x);
    x.agent.setExcluded("other", true);
    const again = new CoordinatorAgent({ ...(x.agent as any).d, runtime: new FakeRuntime() });
    expect(again.mode).toBe("active");
    expect(again.authority(worker)).toBe("autonomous");
    expect(again.authority("other")).toBe("excluded");
    expect(((await again.callTool("send_message", { sessionId: worker, text: "x", reason: "r" })) as any).error).toMatch(/cooldown/);
  });
});

test("prerequisites added by update_task block the task until they land", async () => {
  const x = setup();
  x.agent.setMode("active");
  const a = (await x.createTask({ title: "first", acceptance: ["a"], reason: "r" })) as any;
  const b = (await x.createTask({ title: "second", acceptance: ["b"], reason: "r" })) as any;
  const u = (await x.agent.callTool("update_task", { taskId: b.result.id, prerequisites: [a.result.id], reason: "order" })) as any;
  expect(u.result.status).toBe("blocked");
  x.coordination.recordEvidence(a.result.id, "human", "Reviewed first", { criterion: "a" });
  expect(x.coordination.task(b.result.id)!.status).toBe("unassigned");
  expect(x.agent.flush()).toContain("prerequisites_landed");
});

test("activity in unrelated sessions never wakes the coordinator on its own", () => {
  const x = setup();
  x.agent.setMode("active");
  x.agent.flush();
  x.rt.finish(0);
  x.add("users-own");
  x.tick(1000);
  x.agent.onEvent({ sessionId: "users-own", type: "session_started", ts: x.now(), data: {} } as any);
  x.agent.onEvent({ sessionId: "users-own", type: "user_msg", ts: x.now(), data: { text: "refactor this" } } as any);
  expect(x.agent.flush()).toBeNull();
  x.agent.enqueue({ kind: "conflict", sessionId: null, text: "c" });
  expect(x.agent.flush()).toContain("users-own"); // rides along with the next real wake
});

test("launches without a worktree, or with a destructive-looking brief, are held for approval", async () => {
  const x = setup();
  x.agent.setMode("active");
  const o = x.humanObjective();
  const t = (await x.createTask({ title: "Add a flag", objectiveId: o.result.id, acceptance: ["a"], reason: "r" })) as any;
  const a = (await x.agent.callTool("launch_session", { taskId: t.result.id, repo: R, worktree: false, reason: "r" })) as any;
  expect(a.result.held).toBe(true);
  const b = (await x.agent.callTool("launch_session", { taskId: t.result.id, repo: R, prompt: "first run git reset --hard origin/main", reason: "r2" })) as any;
  expect(b.result.proposal.heldBecause).toBe("destructive_screen");
  expect(x.launches).toHaveLength(0);
  await x.agent.approve(a.result.proposal.id);
  expect(x.launches).toHaveLength(1);
  expect(x.launches[0].cwd).toBe(R);
  // the fixed footer ("never ... force-push") never trips the screen on a normal launch
  const t2 = (await x.createTask({ title: "Add another flag", objectiveId: o.result.id, acceptance: ["a"], reason: "r" })) as any;
  expect(((await x.agent.callTool("launch_session", { taskId: t2.result.id, repo: R, reason: "r3" })) as any).result.sessionId).toBeTruthy();
});

test("similar but distinct actions are not repeated work", async () => {
  const x = setup();
  x.agent.setMode("active");
  for (const n of [1, 2, 3, 4, 5]) expect((await x.createTask({ title: `Write n${n}.txt: river poem`, acceptance: ["exists"], reason: "r" })).ok).toBe(true);
  expect(x.agent.mode).toBe("active");
});
