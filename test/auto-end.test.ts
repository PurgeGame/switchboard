// Daemon cleanup with a fake clock, persisted coordinator state, and a guarded fake transport.
// Process/worktree probes have separate real-git and process-table coverage below.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PerspectiveGroup, Session, TaskStatus } from "../src/shared/types.ts";
import { CoordinatorAgent, type CoordinatorDeps } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { AUTO_END_INTERVAL_MS, inputBlocker, processBlocker, worktreeState } from "../src/daemon/coordinator/auto-end.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";
import type { ProcInfo } from "../src/daemon/proc.ts";
import { coordinatorAllowed } from "../src/daemon/auth.ts";
import { CodexAdapter, runningSubagentParents } from "../src/daemon/adapters/codex.ts";

const MIN = 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

function fixture(opts: { authority?: "launched" | "autopilot" | "human"; task?: boolean; cfg?: any } = {}) {
  const store = new Store("", ":memory:");
  cleanups.push(() => store.db.close());
  const c = new Coordination(store);
  let now = Date.now();
  const s: Session = { ...blankSession("claude:worker", "claude", "tui", "worker"), cwd: "/worktree", pid: 1234, pidConfidence: "confirmed", execution: "idle", executionConfidence: "confirmed", startedAt: now - 60 * MIN };
  const sessions = new Map([[s.id, s]]);
  const groups: PerspectiveGroup[] = [];
  const ended: string[] = [];
  const attention: string[] = [];
  const task = (owner: string | null = s.id, status: TaskStatus = "verified") => {
    const t = c.createTask({ title: "Work", acceptance: ["works"], owner }, "human");
    if (status === "verified") c.recordEvidence(t.id, "human", "checked", { criterion: "works" });
    else c.updateTask(t.id, { status }, "human");
    return c.task(t.id)!;
  };
  const t = opts.task === false ? null : task();
  store.db.run("CREATE TABLE coord_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const kv = (key: string, value: unknown) => store.db.query("INSERT OR REPLACE INTO coord_kv VALUES (?, ?)").run(key, JSON.stringify(value));
  kv("mode", "active");
  const authority = opts.authority ?? "launched";
  if (authority === "launched") kv("launched", [{ sessionId: s.id, objectiveId: null, taskId: t?.id ?? null, tier: "standard", at: now }]);
  if (authority === "autopilot") kv("autopilot", [s.id]);
  let tree: "clean" | "dirty" | "unknown" = "clean";
  let blocker: string | null = null;
  const deps: CoordinatorDeps = {
    db: store.db, coordination: c, cfg: mergeCoordinatorConfig({ agent: "external", ...opts.cfg }),
    sessions: () => sessions, events: () => [], groups: () => groups,
    send: async () => ({ ok: true }), push: () => {}, timers: false, now: () => now,
    end: async (id, guard) => {
      const blocked = await guard?.();
      if (blocked) return { ok: false, error: blocked };
      ended.push(id);
      return { ok: true, how: "typed the exit command" };
    },
    autoEndBlocker: () => blocker,
    worktreeState: async () => tree,
    escalate: (_id, title) => attention.push(title),
  };
  let agent = new CoordinatorAgent(deps);
  const group = (background = true) => {
    const g: PerspectiveGroup = {
      id: "group", createdAt: now, prompt: "Compare", images: [], cwd: s.cwd!, source: "ui", status: "answered", background, autoSynthesize: true, round: 1,
      members: [{ sessionId: s.id, provider: "claude", model: null, label: "Claude", state: "answered", promptSentAt: now - MIN, answer: "done", answeredAt: now, error: null }],
      synthesis: { state: "done", model: null, path: null, text: "done", error: null, startedAt: now - MIN, finishedAt: now },
    };
    groups.push(g);
    return g;
  };
  return {
    s, sessions, c, store, deps, ended, attention, task, t, kv, group,
    get agent() { return agent; },
    restart() { agent = new CoordinatorAgent(deps); },
    tick(ms: number) { now += ms; },
    tree(value: typeof tree) { tree = value; },
    block(value: typeof blocker) { blocker = value; },
    async grace() { await agent.sweepIdleWorkers(); now += deps.cfg.autoEnd.idleMinutes * MIN; },
    event(type: Parameters<CoordinatorAgent["onEvent"]>[0]["type"], text = "", ts = now) { agent.onEvent({ sessionId: s.id, sourceId: `event:${now}`, type, ts, data: { text } }); },
  };
}

describe("finished idle workers", () => {
  test("a separate daemon timer cleans up when no worker or model is running", async () => {
    const x = fixture();
    const intervals: { ms: number; run: () => void }[] = [];
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((run: () => void, ms: number) => {
      intervals.push({ ms, run });
      return { unref() {} };
    }) as typeof setInterval);
    // This test enables real coordinator timers. Clear its debounced state push before
    // fixture teardown closes SQLite, so it cannot leak into the next test file.
    const pending: ReturnType<typeof setTimeout>[] = [];
    const schedule = globalThis.setTimeout;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const handle = schedule(...args);
      pending.push(handle);
      return handle;
    }) as typeof setTimeout);
    try {
      const agent = new CoordinatorAgent({ ...x.deps, timers: true });
      const cleanup = intervals.find((i) => i.ms === AUTO_END_INTERVAL_MS)!;
      expect(cleanup).toBeDefined();
      expect(agent.runtime).toBeNull();
      cleanup.run();
      await Bun.sleep(0);
      x.tick(10 * MIN);
      cleanup.run();
      await Bun.sleep(0);
      expect(x.ended).toEqual([x.s.id]);
    } finally {
      for (const handle of pending) clearTimeout(handle);
      timeout.mockRestore();
      timer.mockRestore();
    }
  });

  test("default ten-minute grace, all verified/rejected tasks, shared close cleanup and a reason in activity", async () => {
    const x = fixture();
    x.task(x.s.id, "rejected");
    const claim = x.c.claim(x.s.id, "port:3000");
    expect(x.agent.state().autoEnd).toEqual({ enabled: true, idleMinutes: 10 });
    await x.agent.sweepIdleWorkers();
    x.tick(10 * MIN - 1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.tick(1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([x.s.id]);
    expect(x.c.claims().some((c) => c.id === claim.claim.id)).toBe(false);
    expect(x.agent.state().launched).toEqual([]);
    expect(x.agent.activity().find((a) => a.action === "auto_end_session")).toMatchObject({ outcome: "ok", sessionId: x.s.id, reason: expect.stringMatching(/verified or rejected.*10 min.*30 min/) });
    await x.agent.sweepIdleWorkers();
    x.restart();
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1); // no duplicate exit while discovery catches up, even after restart
  });

  test("explicit autopilot makes a finished worker eligible; revoked autopilot does not", async () => {
    const x = fixture({ authority: "autopilot" });
    await x.grace();
    x.agent.setAutopilot(x.s.id, false);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.agent.setAutopilot(x.s.id, true);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([x.s.id]);
    expect(x.agent.state().autopilot).toEqual([]);
  });

  test("a human-started session stays open regardless of idle duration or finished tasks", async () => {
    const x = fixture({ authority: "human" });
    await x.grace();
    x.tick(24 * 60 * MIN);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
  });

  for (const status of ["unassigned", "assigned", "in_progress", "blocked", "finished_unverified"] as const) {
    test(`one ${status} task among completed tasks prevents auto-end`, async () => {
      const x = fixture();
      // Completion policy consumes the durable task snapshot, independent of status transitions.
      const t = x.task();
      t.status = status;
      await x.grace();
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  test("an unfinished launch task still protects a worker after its ownership changed", async () => {
    const x = fixture();
    x.t!.owner = "someone-else";
    x.t!.status = "in_progress";
    x.task();
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
  });

  for (const execution of ["working", "waiting_answer", "waiting_approval", "stalled", "failed", "interrupted", "unknown", "ended"] as const) {
    test(`${execution} is never idle for auto-end`, async () => {
      const x = fixture();
      await x.grace();
      x.s.execution = execution;
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  for (const patch of [
    { executionConfidence: "inferred" },
    { turnStartedAt: 1 },
    { subagents: [{ status: "running" }] },
    { resources: { procs: 2 } },
    { resources: { procs: 1, running: { kind: "tests", cmd: "tests", since: 1 } } },
    { resources: { procs: 1, inferred: true } },
    { meta: { coordinatorClient: true } },
    { meta: { onDaemon: true, subagentStateKnown: true, runningSubagents: true } },
    { meta: { onDaemon: true, subagentStateKnown: false } },
  ]) {
    test(`unsafe session state prevents auto-end: ${JSON.stringify(patch)}`, async () => {
      const x = fixture();
      await x.grace();
      Object.assign(x.s, patch);
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  test("completed subagents don't prevent cleanup", async () => {
    const x = fixture();
    x.s.subagents = [{ status: "completed" }] as Session["subagents"];
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([x.s.id]);
  });

  test("a busy embedded thread sharing the worker's process prevents cleanup", async () => {
    const x = fixture();
    const child: Session = { ...blankSession("codex:child", "codex", "tui", "child"), pid: x.s.pid, execution: "working" };
    x.sessions.set(child.id, child);
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    child.execution = "idle";
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([x.s.id]);
  });

  for (const reason of ["pending question", "pending permission", "live child process", "pending outbox message"]) {
    test(`${reason} vetoes cleanup even when execution says idle`, async () => {
      const x = fixture();
      await x.grace();
      x.block(reason);
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  test("a short new turn between sweeps resets the grace period", async () => {
    const x = fixture();
    await x.grace();
    x.s.execution = "working";
    x.agent.onSessionExecution(x.s);
    x.s.execution = "idle";
    x.agent.onSessionExecution(x.s);
    await x.agent.sweepIdleWorkers();
    x.tick(10 * MIN - 1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.tick(1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("another turn-ended event resets grace even if both observations were idle", async () => {
    const x = fixture();
    await x.grace();
    x.event("turn_ended");
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.tick(10 * MIN);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  for (const activity of ["typing", "message", "terminal", "image"] as const) {
    test(`recent human ${activity} holds cleanup for 30 minutes, independently of message cooldown`, async () => {
      const x = fixture({ cfg: { limits: { humanHoldMs: 0 } } });
      await x.grace();
      if (activity === "typing") x.agent.onHumanTyping(x.s.id);
      else if (activity === "message") x.agent.onHumanMessage(x.s.id);
      else x.event("user_msg", activity === "image" ? "" : "Please wait");
      await x.agent.sweepIdleWorkers();
      x.tick(30 * MIN - 1);
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
      x.tick(1);
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([x.s.id]);
    });
  }

  test("human hold survives restart; restart also starts a fresh idle observation", async () => {
    const x = fixture();
    x.agent.onHumanTyping(x.s.id);
    x.tick(15 * MIN);
    x.restart();
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.tick(5 * MIN);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("replayed user input from daemon downtime keeps its original thirty-minute hold", async () => {
    const x = fixture();
    const at = x.deps.now!() - 5 * MIN;
    x.event("user_msg", "wait for me", at);
    await x.grace();
    x.tick(15 * MIN - 1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.tick(1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("coordinator-authored input does not count as human typing", async () => {
    const x = fixture();
    x.event("user_msg", "[coordinator] Check the result");
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("taskless workers need a complete group or plan", async () => {
    const x = fixture({ task: false });
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.group();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("coordinator perspective members qualify without a launched-task record", async () => {
    const x = fixture({ authority: "human", task: false });
    x.group(true);
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("a user-created perspective group doesn't authorize ending its members", async () => {
    const x = fixture({ authority: "human", task: false });
    x.group(false);
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
  });

  for (const state of ["none", "running", "failed"] as const) {
    test(`taskless perspective worker stays open when synthesis is ${state}`, async () => {
      const x = fixture({ task: false });
      x.group().synthesis.state = state;
      await x.grace();
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  test("a running perspective group is incomplete even with an old synthesis", async () => {
    const x = fixture({ task: false });
    x.group().status = "running";
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
  });

  test("a taskless plan member waits for every plan task to be verified or rejected", async () => {
    const x = fixture({ task: false });
    const t = x.task(null, "finished_unverified");
    x.kv("plans", [{ proposalId: 1, objectiveId: "o", title: "Plan", tasks: [{ key: "a", taskId: t.id, sessionId: x.s.id, state: "launched", provider: "claude", attempts: 1 }] }]);
    x.restart();
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.c.updateTask(t.id, { status: "rejected" }, "human");
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("dirty worktree raises one attention item across sweeps and restarts; commit allows ending", async () => {
    const x = fixture();
    x.tree("dirty");
    await x.grace();
    await x.agent.sweepIdleWorkers();
    await x.agent.sweepIdleWorkers();
    x.restart();
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    expect(x.attention).toEqual(["Finished worker has uncommitted changes"]);
    x.tree("clean");
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("an unreadable worktree and unavailable safety checks fail closed", async () => {
    const x = fixture();
    await x.grace();
    x.tree("unknown");
    await x.agent.sweepIdleWorkers();
    x.tree("clean");
    x.deps.autoEndBlocker = undefined;
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
  });

  for (const mode of ["manual", "paused"] as const) {
    test(`${mode} mode never ends workers`, async () => {
      const x = fixture();
      await x.grace();
      x.agent.setMode(mode);
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  test("excluded sessions stay open", async () => {
    const x = fixture();
    await x.grace();
    x.agent.setExcluded(x.s.id, true);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
  });

  test("settings off switch and custom grace apply immediately and persist", async () => {
    const x = fixture();
    x.agent.setAutoEndSettings({ enabled: false, idleMinutes: 25 });
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.restart();
    expect(x.agent.state().autoEnd).toEqual({ enabled: false, idleMinutes: 25 });
    x.agent.setAutoEndSettings({ enabled: true, idleMinutes: 25 });
    await x.agent.sweepIdleWorkers();
    x.tick(25 * MIN - 1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.tick(1);
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });

  test("invalid settings are refused without changing the stored policy; coordinator can't change settings", () => {
    const x = fixture();
    for (const idleMinutes of [0, -1, 1.5, 1441, NaN, Infinity, "10", null])
      expect(() => x.agent.setAutoEndSettings({ enabled: true, idleMinutes })).toThrow(/whole number/);
    expect(() => x.agent.setAutoEndSettings({ enabled: "false", idleMinutes: 10 })).toThrow();
    expect(x.agent.state().autoEnd).toEqual({ enabled: true, idleMinutes: 10 });
    expect(coordinatorAllowed("POST", ["api", "coordinator", "auto-end"])).toBe(false);
  });

  for (const change of ["typing", "working", "task", "settings", "excluded", "child", "pid", "cwd"] as const) {
    test(`rechecks ${change} arriving during the git check`, async () => {
      const x = fixture();
      await x.grace();
      x.deps.worktreeState = async () => {
        if (change === "typing") x.agent.onHumanTyping(x.s.id);
        if (change === "working") x.s.execution = "working";
        if (change === "task") x.t!.status = "finished_unverified";
        if (change === "settings") x.agent.setAutoEndSettings({ enabled: false, idleMinutes: 10 });
        if (change === "excluded") x.agent.setExcluded(x.s.id, true);
        if (change === "child") x.block("child appeared");
        if (change === "pid") x.s.pid = 5678;
        if (change === "cwd") x.s.cwd = "/another-tree";
        return "clean";
      };
      await x.agent.sweepIdleWorkers();
      expect(x.ended).toEqual([]);
    });
  }

  test("failed shutdown retains claims/launch tracking and doesn't stop the sweep", async () => {
    const x = fixture();
    const claim = x.c.claim(x.s.id, "port:3000");
    x.deps.end = async () => ({ ok: false, error: "terminal unavailable" });
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.c.claims().some((c) => c.id === claim.claim.id)).toBe(true);
    expect(x.agent.state().launched).toHaveLength(1);
    expect(x.agent.activity().some((a) => a.action === "auto_end_session" && a.outcome === "ok")).toBe(false);
    expect(x.agent.activity().find((a) => a.action === "auto_end_session")?.detail).toContain("terminal unavailable");
  });

  test("overlapping sweeps never send duplicate exits", async () => {
    const x = fixture();
    await x.grace();
    let release!: () => void;
    x.deps.end = async (id) => {
      await new Promise<void>((resolve) => { release = resolve; });
      x.ended.push(id);
      return { ok: true };
    };
    const first = x.agent.sweepIdleWorkers();
    await Bun.sleep(0);
    await x.agent.sweepIdleWorkers();
    release();
    await first;
    expect(x.ended).toHaveLength(1);
  });
});

const proc = (pid: number, ppid: number, state = "S") => ({ pid, ppid, state } as ProcInfo);
test("Codex shared-daemon subagent activity protects parents and grandparents, including unknown status", () => {
  const threads = [
    { id: "worker", parentThreadId: null, status: { type: "idle" } },
    { id: "child", parentThreadId: "worker", status: { type: "idle" } },
    { id: "grandchild", parentThreadId: "child", status: { type: "active" } },
    { id: "other", parentThreadId: "unrelated", status: { type: "idle" } },
  ];
  expect([...runningSubagentParents(threads)].sort()).toEqual(["child", "worker"]);
  threads[2].status.type = "idle";
  expect([...runningSubagentParents(threads)]).toEqual([]);
  threads[2].status.type = "unknown";
  expect([...runningSubagentParents(threads)].sort()).toEqual(["child", "worker"]);
});

test("Codex discovery reads ephemeral children for cleanup and fails closed on an unreadable thread", async () => {
  const adapter = new CodexAdapter();
  const ensure = spyOn(adapter.daemon, "ensure").mockResolvedValue(true);
  let failed = false;
  const call = spyOn(adapter.daemon, "call").mockImplementation((async (method: string, args: any) => {
    if (method === "thread/loaded/list") return { data: ["worker", "child"] };
    if (args.threadId === "child" && failed) throw Error("thread unavailable");
    return { thread: args.threadId === "worker"
      ? { cwd: "/worktree", status: { type: "idle" }, path: "/worker.jsonl" }
      : { parentThreadId: "worker", ephemeral: true, status: { type: "active" } } };
  }) as typeof adapter.daemon.call);
  try {
    // Only exercise read-only thread discovery, with a fake daemon; no live socket.
    const read = () => (adapter as any).daemonThreads();
    expect((await read()).map((t: any) => t.id)).toEqual(["worker"]);
    expect((adapter as any).subagentParents.has("worker")).toBe(true);
    expect((adapter as any).subagentStateKnown).toBe(true);
    failed = true;
    await read();
    expect((adapter as any).subagentStateKnown).toBe(false);
  } finally {
    ensure.mockRestore();
    call.mockRestore();
  }
});
for (const kind of ["question", "approval"] as const) {
  test(`open ${kind} in the attention store protects an idle session until resolved`, async () => {
    const x = fixture();
    x.deps.autoEndBlocker = (s) => inputBlocker(x.store, s.id);
    const item = x.store.insertAttention({
      sessionId: x.s.id, sessionName: null, kind, createdAt: Date.now(), title: "Needs you", text: "Can I continue?", outcome: null,
      status: "open", resolvedAt: null, resolution: null, resolutionNote: null, sourceKey: kind, historical: false, meta: {},
    })!;
    await x.grace();
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toEqual([]);
    x.store.updateAttention({ ...item, status: "resolved", resolution: "answered_ui", resolvedAt: Date.now() });
    await x.agent.sweepIdleWorkers();
    expect(x.ended).toHaveLength(1);
  });
}

test("fresh process inspection catches sleeping children, grandchildren and shared-daemon children", () => {
  const x = fixture();
  const root = x.s.pid!;
  const ps = new Map([[root, proc(root, 1)]]);
  expect(processBlocker(x.s, null, ps)).toBeNull();
  ps.set(22, proc(22, root));
  ps.set(23, proc(23, 22));
  expect(processBlocker(x.s, null, ps)).toMatch(/live child/);
  ps.get(22)!.state = "Z";
  expect(processBlocker(x.s, null, ps)).toMatch(/live child/);
  ps.get(23)!.state = "Z";
  expect(processBlocker(x.s, null, ps)).toBeNull();
  x.s.meta.onDaemon = true;
  ps.set(33, proc(33, 1));
  ps.set(34, proc(34, 33));
  expect(processBlocker(x.s, 33, ps, () => "/worktree/subdir")).toMatch(/shared daemon/);
  expect(processBlocker(x.s, 33, ps, () => null)).toMatch(/shared daemon/);
  expect(processBlocker(x.s, 33, ps, () => "/unrelated")).toBeNull();
  expect(processBlocker(x.s, null, ps)).toMatch(/cannot inspect/);
  x.s.pidConfidence = "inferred";
  expect(processBlocker(x.s, 33, ps)).toMatch(/cannot confirm/);
  x.s.pid = null;
  expect(processBlocker(x.s, 33, ps)).toMatch(/cannot confirm/);
});

test("unresolved delivery keeps a finished worker open until settled", async () => {
  const x = fixture();
  x.deps.autoEndBlocker = (s) => inputBlocker(x.store, s.id);
  const { message } = x.store.insertOutbox({
    sessionId: x.s.id, clientId: "queued", author: "human", method: "terminal", mode: "queue", state: "queued", text: "one more thing", images: [],
    imageDelivery: null, createdAt: Date.now(), updatedAt: Date.now(), error: null, receipt: false, detail: null,
  });
  await x.grace();
  await x.agent.sweepIdleWorkers();
  expect(x.ended).toEqual([]);
  x.store.updateOutbox({ ...message, state: "failed" });
  await x.agent.sweepIdleWorkers();
  expect(x.ended).toHaveLength(1);
});

test("git checks the whole worktree for staged, unstaged, deleted and untracked files; errors fail closed", async () => {
  mkdirSync(join(import.meta.dir, "../.sandbox"), { recursive: true });
  const root = mkdtempSync(join(import.meta.dir, "../.sandbox/auto-end-git-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args]);
    expect(r.exitCode).toBe(0);
  };
  expect(await worktreeState("/does-not-exist")).toBe("unknown");
  expect(await worktreeState(null)).toBe("unknown");
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "tracked"), "initial");
  expect(await worktreeState(root)).toBe("dirty");
  git("add", ".");
  expect(await worktreeState(root)).toBe("dirty");
  git("commit", "-qm", "initial");
  expect(await worktreeState(root)).toBe("clean");
  writeFileSync(join(root, "tracked"), "changed");
  expect(await worktreeState(join(root, "sub"))).toBe("dirty");
  git("add", ".");
  expect(await worktreeState(root)).toBe("dirty");
  git("commit", "-qm", "update");
  rmSync(join(root, "tracked"));
  expect(await worktreeState(root)).toBe("dirty");
});
