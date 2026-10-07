import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { Registry } from "../src/daemon/registry.ts";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { blankSession, checkStalled } from "../src/daemon/state.ts";
import { childrenIndex, type ProcInfo } from "../src/daemon/proc.ts";
import type { AttentionItem, Session } from "../src/shared/types.ts";
import { STATUS, STATUS_GROUPS, statusLabel } from "../src/web/src/status.ts";
import { needsYou } from "../src/web/src/home.ts";
import { groupInbox, openItems, sessionRank } from "../src/web/src/attention.ts";

const MIN = 60_000;
const cfg = { port: 0, longRunMs: 5 * MIN, stalledMs: 10 * MIN, endedRetentionMs: 1, notifyDesktop: false, notifyFinished: false, notifyIgnore: [], modelClassifier: false, autoContinue: { enabled: false, graceMs: 0, maxConsecutive: 3, typingHoldMs: 0, offProjects: [] } };
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.db.close(); });

function setup(limits: Record<string, number> = {}) {
  const store = new Store("", ":memory:");
  stores.push(store);
  const registry = new Registry([], store, cfg);
  const coordination = new Coordination(store);
  let now = Date.now();
  let serial = 0;
  const sent: string[] = [];
  const notified: AttentionItem[] = [];
  const attention = new AttentionEngine(store, cfg, {
    pushItem: () => {}, notify: (i) => notified.push(i),
    setExecution: (s, x, c) => registry.update(s.id, (t) => { t.execution = x; t.executionConfidence = c; }),
  }, undefined, now);
  registry.attention = attention;
  const makeAgent = (reg = registry, external = true) => {
    const agent = new CoordinatorAgent({
      db: store.db, coordination, cfg: mergeCoordinatorConfig({ agent: external ? "external" : "builtin", limits }),
      sessions: () => reg.sessions, events: (id, limit) => store.events(id, { limit }),
      send: async (_, text) => { sent.push(text); return { ok: true }; },
      reportStall: (...args) => reg.reportStall(...args), escalate: () => {}, push: () => {}, now: () => now, timers: false,
    });
    reg.stallHooks.push((s, c) => agent.onStallSuspected(s, c));
    return agent;
  };
  const agent = makeAgent();
  agent.setMode("active");
  const s = blankSession("claude:s", "claude", "tui", "s");
  s.name = "Worker";
  s.cwd = process.cwd();
  registry.sessions.set(s.id, s);
  const objective = coordination.createObjective("Test", "", undefined, "human");
  coordination.grantObjective(objective.id, { root: process.cwd() }, "human");
  coordination.createTask({ title: "API job", objectiveId: objective.id, owner: s.id, scope: { paths: ["src"], resources: [] }, acceptance: ["job done"] }, "human");
  s.sendMethods = ["terminal"];
  registry.sessions.set(s.id, s);
  const feed = (type: Parameters<Registry["ingest"]>[1][0]["type"], data = {}, ts = now) =>
    registry.ingest(s.id, [{ sessionId: s.id, sourceId: `e${serial++}`, type, ts, data }]);
  feed("turn_started", {}, now - 12 * MIN);
  feed("tool_call", { name: "Bash", input: { command: "curl https://example.test/job" } }, now - 11 * MIN);
  const detect = () => registry.checkStall(s, now);
  const report = (status: "working" | "stuck", extra = {}) => agent.callTool("report_stall", {
    sessionId: s.id, checkId: s.stallCheck!.id, status,
    reason: status === "working" ? "The worker is waiting for its API response." : "The worker cannot proceed because its API credential expired.",
    ...(status === "stuck" ? { suggestedAction: "Reply to the worker with the renewed credential." } : {}), ...extra,
  });
  return { store, registry, attention, agent, makeAgent, s, feed, detect, report, sent, notified, now: () => now, tick: (ms: number) => now += ms };
}
const updates = async (a: CoordinatorAgent) => (await a.callTool("get_updates") as any).result.events;

test("suspicion wakes with session, silence and last tool; no UI status, attention or duplicate event", async () => {
  const x = setup();
  x.detect();
  const events = (await updates(x.agent)).filter((e: any) => e.kind === "stall_suspected");
  expect(events).toHaveLength(1);
  expect(events[0].data.lastStep).toContain("Bash");
  expect(events[0].data.lastStep).toContain("curl");
  expect(events[0].sessionId).toBe(x.s.id);
  expect(events[0].data.checkId).toBe(x.s.stallCheck!.id);
  expect(events[0].data.silentForMs).toBe(11 * MIN);
  expect(x.s.execution).toBe("working");
  expect(x.s.executionConfidence).toBe("confirmed");
  expect(x.attention.open()).toHaveLength(0);
  expect(x.notified).toHaveLength(0);
  x.tick(MIN); x.detect();
  expect(await updates(x.agent)).toHaveLength(0);
  expect(x.sent).toHaveLength(0);
});

test("the built-in runtime receives the stall_suspected wake digest", () => {
  const x = setup();
  const a = x.makeAgent(x.registry, false);
  const turns: string[] = [];
  a.setRuntime({ running: true, busy: false, start: () => {}, stop: () => {}, send: (t: string) => { turns.push(t); return true; }, onText: () => {}, onResult: () => {}, onExit: () => {} });
  x.detect();
  expect(a.flush()).toContain("stall_suspected");
  expect(turns[0]).toContain(x.s.id);
  expect(turns[0]).toContain("silentForMs=660000");
  expect(turns[0]).toContain("Bash");
});

describe("exclusions", () => {
  const exclusions: [string, (s: Session) => void][] = [
    ["permission prompt", s => { s.execution = "waiting_approval"; }],
    ["question", s => { s.execution = "waiting_answer"; }],
    ["ended turn even if live status still says busy", s => { s.meta.lastProgressType = "turn_ended"; }],
    ["idle", s => { s.execution = "idle"; }],
    ["ended", s => { s.execution = "ended"; }],
    ["CPU busy", s => { s.resources = { cpuPct: 10, rssMB: 1, procs: 1 }; }],
    ["sleeping child", s => { s.resources = { cpuPct: 0, rssMB: 1, procs: 2, liveChildren: 1 }; }],
    ["child in legacy resources", s => { s.resources = { cpuPct: 0, rssMB: 1, procs: 2 }; }],
    ["running command", s => { s.resources = { cpuPct: 0, rssMB: 1, procs: 1, running: { kind: "tests", cmd: "bun test", since: 0 } }; }],
    ["running subagent", s => { s.subagents = [{ id: "a", type: "Agent", description: "tests", model: null, parentId: null, status: "running", activity: "waiting", startedAt: 1, lastActivityAt: 2, endedAt: null }]; }],
  ];
  for (const [name, change] of exclusions) test(name, async () => {
    const x = setup(); change(x.s); x.detect();
    expect(x.s.stallCheck).toBeUndefined();
    expect((await updates(x.agent)).some((e: any) => e.kind === "stall_suspected")).toBe(false);
    expect(x.attention.open()).toHaveLength(0);
  });

  test("an open prompt vetoes detection even if the provider says working", async () => {
    const x = setup();
    x.attention.raisePermission(x.s, { tool: "Bash", summary: "Allow it?", answerKey: "p", recommendation: null });
    x.detect();
    expect(x.s.stallCheck).toBeUndefined();
    expect((await updates(x.agent)).some((e: any) => e.kind === "stall_suspected")).toBe(false);
  });

  test("excluded and coordinator sessions never wake for a suspicion", async () => {
    const x = setup(); x.agent.setExcluded(x.s.id, true); x.detect();
    expect((await updates(x.agent)).some((e: any) => e.kind === "stall_suspected")).toBe(false);
    x.agent.setExcluded(x.s.id, false); x.s.meta.coordinatorClient = true; x.detect();
    expect((await updates(x.agent)).some((e: any) => e.kind === "stall_suspected")).toBe(false);
  });
});

test("resource sampling counts sleeping direct and nested children, but not zombies", () => {
  const x = setup(); x.s.pid = 100;
  const proc = (pid: number, ppid: number, state = "S"): ProcInfo => ({ pid, ppid, state, comm: "sleep", pgrp: pid, tpgid: 0, ttyNr: 0, startTime: 0, cpuTicks: 0, rssPages: 0 });
  const procs = new Map([proc(100, 1), proc(200, 100), proc(300, 200), proc(400, 100, "Z")].map(p => [p.pid, p]));
  (x.registry as any).sampleResources(procs, childrenIndex(procs), x.now());
  expect(x.s.resources?.liveChildren).toBe(2);
  expect(checkStalled(x.s, x.now(), cfg.stalledMs)).toBe(false);
  procs.delete(200); procs.delete(300);
  (x.registry as any).sampleResources(procs, childrenIndex(procs), x.now() + 1000);
  expect(x.s.resources?.liveChildren).toBe(0);
  expect(checkStalled(x.s, x.now(), cfg.stalledMs)).toBe(true);
});

test("inspect, checkpoint and confirm: one Needs you card containing reason and action, no icon", async () => {
  const x = setup(); x.agent.setAutopilot(x.s.id, true); x.detect();
  expect(await x.report("stuck")).toMatchObject({ ok: false, error: expect.stringContaining("get_session") });
  const read: any = await x.agent.callTool("get_session", { sessionId: x.s.id });
  expect(read.result).toMatchObject({ canRequestCheckpoint: true, stallCheck: { status: "suspected" }, subagents: [] });
  expect(await x.report("stuck")).toMatchObject({ ok: false, error: expect.stringContaining("request_checkpoint") });
  expect(await x.agent.callTool("request_checkpoint", { sessionId: x.s.id, reason: "Check the suspected stall" })).toMatchObject({ ok: true });
  expect(x.sent[0]).toStartWith("[coordinator] Checkpoint");
  // A transcript echo of that request does not prove progress or invalidate the investigation.
  x.feed("coordinator_msg", { text: x.sent[0] });
  x.feed("user_msg", { text: `<pasted_content>${x.sent[0]}</pasted_content>` });
  x.feed("turn_started", { origin: "human" }); // same-record parser companion, still only our input
  expect(await x.report("stuck", { suggestedAction: " " })).toMatchObject({ ok: false });
  expect(await x.report("stuck")).toMatchObject({ ok: true });
  const [item] = x.attention.open();
  expect(item).toMatchObject({ kind: "escalation", title: expect.stringContaining("credential expired"), text: expect.stringContaining("renewed credential") });
  const ui = Object.fromEntries(x.attention.open().map(i => [i.id, i]));
  expect(needsYou(ui).waiting).toBe(1);
  expect(groupInbox(openItems(ui))[0].label).toBe("Needs you");
  expect(x.s.execution).toBe("working");
  expect(x.notified).toHaveLength(1);
  expect(await x.report("stuck")).toMatchObject({ ok: true });
  expect(x.attention.open()).toHaveLength(1);
  expect(x.notified).toHaveLength(1);
  expect(await x.report("working")).toMatchObject({ ok: true });
  expect(x.attention.open()).toHaveLength(0);
});

test("working verdict resolves silently and survives restart without rediscovery", async () => {
  const x = setup(); x.detect();
  await x.agent.callTool("get_session", { sessionId: x.s.id });
  expect(await x.report("working")).toMatchObject({ ok: true });
  expect(x.s.stallCheck?.status).toBe("working");
  expect(x.attention.open()).toHaveLength(0);
  const restored = new Registry([], x.store, cfg);
  const again = x.makeAgent(restored);
  restored.checkStall(restored.sessions.get(x.s.id)!, x.now() + 60 * MIN);
  expect(await updates(again)).toHaveLength(0);
  x.feed("tool_result", { text: "API recovered" }); x.tick(11 * MIN); x.detect();
  expect(x.s.stallCheck?.status).toBe("suspected");
});

test("pending checks survive restart and a coordinator that was off", async () => {
  const x = setup(); x.agent.setMode("manual"); x.detect();
  x.agent.setMode("active"); x.detect();
  expect((await updates(x.agent)).some((e: any) => e.kind === "stall_suspected")).toBe(true);
  x.registry.flush();
  const restored = new Registry([], x.store, cfg);
  const again = x.makeAgent(restored);
  restored.checkStall(restored.sessions.get(x.s.id)!, x.now());
  expect((await updates(again)).filter((e: any) => e.kind === "stall_suspected")).toHaveLength(1);
});

for (const recovery of ["progress", "question", "child", "ended"] as const) test(`stale confirmations are refused and confirmed cards clear on ${recovery}`, async () => {
  const x = setup(); x.detect();
  await x.agent.callTool("get_session", { sessionId: x.s.id });
  const checkId = x.s.stallCheck!.id;
  expect(await x.report("stuck")).toMatchObject({ ok: true });
  if (recovery === "progress") x.feed("assistant_msg", { text: "The API returned; continuing." });
  else if (recovery === "child") { x.s.resources = { cpuPct: 0, rssMB: 1, procs: 2 }; x.detect(); }
  else x.registry.update(x.s.id, s => { s.execution = recovery === "question" ? "waiting_answer" : "ended"; });
  expect(x.s.stallCheck).toBeUndefined();
  expect(x.attention.open().filter(i => i.meta.stallCheckId)).toHaveLength(0);
  expect(await x.agent.callTool("report_stall", { sessionId: x.s.id, checkId, status: "stuck", reason: "old evidence", suggestedAction: "Reply" })).toMatchObject({ ok: false, error: expect.stringContaining("stale") });
  expect((await updates(x.agent)).some((e: any) => e.kind === "stall_suspected")).toBe(false);
});

test("checkpoints preserve cooldown, hourly cap, duplicate suppression and human holds", async () => {
  for (const [limits, expected, human] of [
    [{ perSessionCooldownMs: 10 * MIN }, /cooldown/, false],
    [{ perSessionCooldownMs: 0, perSessionPerHour: 1 }, /rate limit/, false],
    [{ perSessionCooldownMs: 0 }, /human|user/i, true],
  ] as const) {
    const x = setup(limits); x.agent.setAutopilot(x.s.id, true); x.detect();
    await x.agent.callTool("get_session", { sessionId: x.s.id });
    expect(await x.agent.callTool("send_message", { sessionId: x.s.id, text: "Review the parser implementation", reason: "work" })).toMatchObject({ ok: true });
    if (human) x.agent.onHumanMessage(x.s.id);
    expect(await x.agent.callTool("request_checkpoint", { sessionId: x.s.id, reason: "investigate" })).toMatchObject({ ok: false, error: expect.stringMatching(expected) });
    expect(x.sent).toHaveLength(1);
    expect(x.attention.open()).toHaveLength(0);
  }
  const x = setup(); x.agent.setAutopilot(x.s.id, true);
  await x.agent.callTool("request_checkpoint", { sessionId: x.s.id, reason: "first" });
  expect(await x.agent.callTool("request_checkpoint", { sessionId: x.s.id, reason: "again" })).toMatchObject({ ok: false, error: expect.stringContaining("near-identical") });
  expect(x.sent).toHaveLength(1);
});

test("legacy stalled snapshots render as working and never sort into the problem group", () => {
  const s = blankSession("s", "claude", "tui", "s"); s.execution = "stalled";
  expect(statusLabel(s)).toBe("Working");
  expect(STATUS.stalled).toEqual(STATUS.working);
  expect(STATUS_GROUPS.find(g => g.id === "problem")!.members).not.toContain("stalled");
  expect(sessionRank(s, [])).toBe(sessionRank({ ...s, execution: "working" }, []));
});


test("upgrading retires old inferred statuses and attention without a notification", () => {
  const x = setup();
  x.s.execution = "stalled";
  x.store.upsertSession(x.s);
  const old = x.store.insertAttention({ sessionId: x.s.id, sessionName: "Worker", kind: "stalled", createdAt: x.now(), title: "Suspected stalled", text: "Quiet", outcome: null, status: "open", resolvedAt: null, resolution: null, resolutionNote: null, sourceKey: "old-stall", historical: false, meta: {} })!;
  const registry = new Registry([], x.store, cfg);
  let notices = 0;
  new AttentionEngine(x.store, cfg, { pushItem: () => {}, notify: () => { notices++; }, setExecution: () => {} });
  expect(registry.sessions.get(x.s.id)?.execution).toBe("working");
  expect(x.store.getAttention(old.id)?.status).toBe("resolved");
  expect(notices).toBe(0);
});

test("reporting keeps mode, exclusion and required-field gates; observe-only inspections make no message proposal", async () => {
  const x = setup(); x.detect();
  const args = { sessionId: x.s.id, checkId: x.s.stallCheck!.id, status: "stuck", reason: "Confirmed failure", suggestedAction: "Reply to the worker" };
  const detail: any = await x.agent.callTool("get_session", { sessionId: x.s.id });
  expect(detail.result.canRequestCheckpoint).toBe(false);
  expect(x.agent.proposals()).toHaveLength(0);
  expect(await x.agent.callTool("report_stall", { ...args, status: "maybe" })).toMatchObject({ ok: false });
  expect(await x.agent.callTool("report_stall", { ...args, reason: " " })).toMatchObject({ ok: false });
  x.agent.setMode("paused");
  expect(await x.agent.callTool("report_stall", args)).toMatchObject({ ok: false, error: expect.stringContaining("paused") });
  x.agent.setMode("active"); x.agent.setExcluded(x.s.id, true);
  expect(await x.agent.callTool("report_stall", args)).toMatchObject({ ok: false, error: expect.stringMatching(/excluded/i) });
  expect(x.attention.open()).toHaveLength(0);
});

test("checkpoint echoes preserve the silence baseline in sessions saved before this upgrade", () => {
  const x = setup();
  delete x.s.meta.lastProgressAt;
  delete x.s.meta.lastProgressType;
  x.detect();
  const id = x.s.stallCheck!.id;
  x.feed("user_msg", { text: "[coordinator] Checkpoint please" });
  x.feed("turn_started", { origin: "human" });
  x.detect();
  expect(x.s.stallCheck?.id).toBe(id);
  expect(x.s.stallCheck?.silentForMs).toBe(11 * MIN);
});
