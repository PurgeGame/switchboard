// coordinator.agent = "builtin" | "external" | "none" (D34): the engine's rules are the same
// whoever the brain is; an external brain has no runtime and polls with get_updates.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";
import { CoordinatorAgent, permissionJudgeGate } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import type { RuntimeLike } from "../src/daemon/coordinator/runtime.ts";
import { TOOL_NAMES } from "../src/daemon/coordinator/tools.ts";
import type { Session } from "../src/shared/types.ts";

const R = join(realpathSync(mkdtempSync(join(tmpdir(), "sb-modes-"))), "r");
mkdirSync(R);
afterAll(() => rmSync(dirname(R), { recursive: true, force: true }));

class FakeRuntime implements RuntimeLike {
  running = false;
  busy = false;
  starts = 0;
  turns: string[] = [];
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
}

function setup(agent: "builtin" | "external", over: any = {}) {
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
  const cfg = mergeCoordinatorConfig({ agent, ...over });
  const a = new CoordinatorAgent({
    db: store.db,
    coordination,
    cfg,
    sessions: () => sessions,
    events: () => [],
    send: async (sessionId, text) => (sent.push({ sessionId, text }), { ok: true }),
    escalate: () => {},
    push: () => {},
    now: () => clock,
    timers: false,
  });
  return { agent: a, coordination, sessions, add, sent, tick: (ms: number) => (clock += ms) };
}

describe("config", () => {
  test("coordinator.agent defaults to builtin; external and none are accepted; anything else falls back to builtin", () => {
    expect(mergeCoordinatorConfig(null).agent).toBe("builtin");
    expect(mergeCoordinatorConfig({ agent: "external" }).agent).toBe("external");
    expect(mergeCoordinatorConfig({ agent: "none" }).agent).toBe("none");
    expect(mergeCoordinatorConfig({ agent: "externl" }).agent).toBe("builtin");
  });
});

describe("permission judging", () => {
  test("only the built-in coordinator, switched on, ever judges a prompt; none and external send every prompt to the user", () => {
    expect(permissionJudgeGate(null)("s1")).toBe(false); // agent: none
    const ext = setup("external");
    ext.agent.setMode("active");
    expect(ext.agent.mayJudgePermissions("s1")).toBe(false);
    expect(permissionJudgeGate(ext.agent)("s1")).toBe(false);
    const b = setup("builtin");
    expect(permissionJudgeGate(b.agent)("s1")).toBe(false); // off
    b.agent.setMode("active");
    expect(permissionJudgeGate(b.agent)("s1")).toBe(true);
  });
});

describe("external agent", () => {
  test("never gets a runtime: none is accepted, so no LLM process can be spawned", () => {
    const x = setup("external");
    expect(() => x.agent.setRuntime(new FakeRuntime())).toThrow(/external/);
    x.agent.setMode("active");
    x.agent.enqueue({ kind: "test", sessionId: null, text: "something happened" });
    expect(x.agent.flush()).toBeNull();
    const st = x.agent.state();
    expect(st.agent).toBe("external");
    expect(st.running).toBe(false);
    expect(st.nextWakeAt).toBeNull();
    expect(x.agent.activity().some((e) => e.action === "runtime")).toBe(false);
  });

  test("the built-in agent doesn't see the polling tools; the external one does", async () => {
    const b = setup("builtin");
    b.agent.setMode("active");
    expect(b.agent.tools().map((t) => t.name)).not.toContain("get_updates");
    expect(TOOL_NAMES).not.toContain("get_updates"); // the built-in brain's --allowedTools
    expect(((await b.agent.callTool("get_updates", {})) as any).ok).toBe(false);
    const x = setup("external");
    const names = x.agent.tools().map((t) => t.name);
    expect(names).toContain("get_updates");
    expect(names).toContain("get_instructions");
    for (const n of TOOL_NAMES) expect(names).toContain(n);
  });

  test("get_updates returns the pending events once (drained), with a state line", async () => {
    const x = setup("external");
    x.agent.setMode("active");
    x.add("w1");
    x.agent.enqueue({ kind: "turn_ended", sessionId: "w1", text: "turn ended: done" });
    const r = (await x.agent.callTool("get_updates", {})) as any;
    expect(r.ok).toBe(true);
    expect(r.result.restarted).toBe(true); // first poll since the daemon started
    const kinds = r.result.events.map((e: any) => e.kind);
    expect(kinds).toContain("mode");
    expect(kinds).toContain("turn_ended");
    expect(r.result.state).toMatch(/^STATE: mode active/);
    const again = (await x.agent.callTool("get_updates", {})) as any;
    expect(again.result.events).toEqual([]);
    expect(again.result.restarted).toBe(false);
    expect(x.agent.state().pendingEvents).toBe(0);
  });

  test("the user's chat reaches the external agent once through get_updates, with its chat # for routing", async () => {
    const x = setup("external");
    x.agent.setMode("active");
    const s = x.add("mine");
    s.execution = "idle";
    const c = x.agent.userChat("tell mine to add tests");
    expect(c.ok).toBe(true);
    const r = (await x.agent.callTool("get_updates", {})) as any;
    expect(r.result.chat).toEqual([expect.objectContaining({ id: c.id, text: "tell mine to add tests" })]);
    expect(((await x.agent.callTool("get_updates", {})) as any).result.chat).toEqual([]);
  });

  test("get_updates can wait for the next event instead of returning empty", async () => {
    const x = setup("external");
    x.agent.setMode("active");
    await x.agent.callTool("get_updates", {}); // drain the mode event
    const p = x.agent.callTool("get_updates", { waitSeconds: 5 }) as Promise<any>;
    await Bun.sleep(30);
    x.agent.enqueue({ kind: "conflict", sessionId: null, text: "two sessions edit a.ts" });
    const r = await p;
    expect(r.result.events.map((e: any) => e.kind)).toEqual(["conflict"]);
  });

  test("the same rules apply as for the built-in brain: mode, authority, reasons", async () => {
    const x = setup("external");
    x.add("mine");
    // Off: everything refused, the polling tools included.
    expect(((await x.agent.callTool("get_updates", {})) as any).error).toMatch(/off/);
    x.agent.setMode("paused");
    expect(((await x.agent.callTool("get_updates", {})) as any).ok).toBe(true); // read-only
    expect(((await x.agent.callTool("send_message", { sessionId: "mine", text: "hi", reason: "r" })) as any).error).toMatch(/paused/);
    x.agent.setMode("active");
    expect(((await x.agent.callTool("send_message", { sessionId: "mine", text: "hi" })) as any).error).toMatch(/reason/);
    // A session the user drives: a proposal for the user, not a delivery.
    const r = (await x.agent.callTool("send_message", { sessionId: "mine", text: "Could you rebase onto main?", reason: "r" })) as any;
    expect(r.ok).toBe(true);
    expect(x.sent).toEqual([]);
    expect(x.agent.proposals()[0]).toMatchObject({ kind: "send_message", state: "pending" });
    x.agent.setExcluded("mine", true);
    expect(((await x.agent.callTool("send_message", { sessionId: "mine", text: "hi again", reason: "r" })) as any).ok).toBe(false);
  });

  test("get_instructions returns the coordinator prompt plus how to poll", async () => {
    const x = setup("external");
    x.agent.setMode("active");
    const r = (await x.agent.callTool("get_instructions", {})) as any;
    expect(r.result.text).toContain("You are the Switchboard coordinator");
    expect(r.result.text).toContain("get_updates");
  });

  test("the last tool call time is exposed so the UI can say whether the agent is connected", async () => {
    const x = setup("external");
    expect(x.agent.state().lastToolCallAt).toBeNull();
    await x.agent.callTool("get_state", {}); // refused (off), but the agent was seen
    expect(x.agent.state().lastToolCallAt).not.toBeNull();
  });
});
