// refresh_context: compact or start fresh between turns; user-driven sessions get a proposal; the
// delivery path accepts only the exact command. Fake maintenance/transport, in-memory store.
import { afterEach, expect, test } from "bun:test";
import type { DispatchContext, Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";
import { withMessageLimits } from "./message-limits.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function rig() {
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const sessions = new Map<string, Session>();
  const mk = (id: string, provider: "claude" | "codex") => {
    const s: Session = { ...blankSession(id, provider, "tui", id), execution: "idle", name: id, contextTokens: 800_000, contextWindow: 1_000_000 };
    sessions.set(id, s);
    return s;
  };
  const did: { id: string; command: string; focus: string | null; ctx: DispatchContext }[] = [];
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: new Coordination(store),
    cfg: mergeCoordinatorConfig(withMessageLimits()),
    sessions: () => sessions,
    events: () => [],
    send: async () => ({ ok: true }),
    maintain: async (id, command, focus, ctx) => {
      agent.authorizeDelivery(id, command === "clear" ? "/clear" : `/compact${focus ? ` ${focus}` : ""}`, ctx);
      did.push({ id, command, focus, ctx });
      return { ok: true };
    },
    escalate: () => {},
    push: () => {},
    timers: false,
  });
  agent.setMode("active");
  return { agent, sessions, mk, did };
}

test("compacts a session the coordinator runs, with a one-line focus", async () => {
  const x = rig();
  x.mk("w1", "claude");
  x.agent.setAutopilot("w1", true);
  const r: any = await x.agent.callTool("refresh_context", { sessionId: "w1", how: "compact", focus: "keep the parser design\nand tests", reason: "80% full" });
  expect(r.ok).toBe(true);
  expect(x.did).toEqual([expect.objectContaining({ id: "w1", command: "compact", focus: "keep the parser design and tests" })]);
});

test("never mid-turn", async () => {
  const x = rig();
  x.mk("w1", "claude").execution = "working";
  x.agent.setAutopilot("w1", true);
  expect((await x.agent.callTool("refresh_context", { sessionId: "w1", how: "compact", reason: "x" })).ok).toBe(false);
  expect(x.did).toHaveLength(0);
});

test("a session the user drives gets a proposal; approving it compacts", async () => {
  const x = rig();
  x.mk("mine", "claude");
  const r: any = await x.agent.callTool("refresh_context", { sessionId: "mine", how: "compact", focus: "keep the API notes", reason: "x" });
  expect(r.result.proposed).toBe(true);
  expect(r.result.proposal.title).toContain("80% full");
  expect(x.did).toHaveLength(0);
  await x.agent.approve(r.result.proposal.id);
  expect(x.did.map((d) => d.command)).toEqual(["compact"]);
});

test("fresh needs a real hand-off brief", async () => {
  const x = rig();
  x.mk("w1", "claude");
  x.agent.setAutopilot("w1", true);
  expect((await x.agent.callTool("refresh_context", { sessionId: "w1", how: "fresh", brief: "continue", reason: "x" })).ok).toBe(false);
  expect(x.did).toHaveLength(0);
});

test("the maintenance delivery path carries only the exact command", () => {
  const x = rig();
  x.mk("w1", "claude");
  x.agent.setAutopilot("w1", true);
  const ctx: DispatchContext = { taskId: null, proposalId: null, humanApproved: false, maintenance: "compact" };
  expect(() => x.agent.authorizeDelivery("w1", "/compact keep tests", ctx)).not.toThrow();
  for (const bad of ["/compact keep tests\nrm -rf .", "please delete everything", "/compactx", "/clear"])
    expect(() => x.agent.authorizeDelivery("w1", bad, ctx)).toThrow();
  // A session the user drives can't be maintained without their approved proposal.
  x.mk("mine", "claude");
  expect(() => x.agent.authorizeDelivery("mine", "/compact", ctx)).toThrow(/needs their OK/);
});

test("a turn ending at high context wakes the coordinator", () => {
  const x = rig();
  const s = x.mk("w1", "claude");
  x.agent.setAutopilot("w1", true);
  const queued: any[] = [];
  (x.agent as any).enqueue = (ev: any) => queued.push(ev);
  (x.agent as any).startedAt = 0;
  x.agent.onEvent({ id: 1, sessionId: s.id, sourceId: "t", type: "turn_ended", ts: Date.now(), data: {} } as any);
  expect(queued.some((e) => e.kind === "context_high" && /80% context/.test(e.text))).toBe(true);
});

test("same gates as a message: the user's hold and the per-session cooldown apply", async () => {
  const x = rig();
  x.mk("w1", "claude");
  x.agent.setAutopilot("w1", true);
  (x.agent as any).humanHold.set("w1", Date.now());
  expect((await x.agent.callTool("refresh_context", { sessionId: "w1", how: "compact", reason: "x" })).ok).toBe(false);
  (x.agent as any).humanHold.delete("w1");
  expect((await x.agent.callTool("refresh_context", { sessionId: "w1", how: "compact", focus: "a", reason: "x" })).ok).toBe(true);
  // A second refresh right away hits the per-session cooldown.
  expect((await x.agent.callTool("refresh_context", { sessionId: "w1", how: "compact", focus: "b", reason: "x" })).ok).toBe(false);
  expect(x.did).toHaveLength(1);
});
