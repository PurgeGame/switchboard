// Every proposal card the coordinator queues can be approved: the user's approval of an exact
// message is its authority (no task needed), and anything approval would refuse for a reason the
// daemon already knows is refused when proposed. Wired as main.ts wires it (agent.send ->
// messenger.send, messenger.authorize -> agent.authorizeDelivery). In-memory store, temp grant
// root, fake terminal and maintenance: no real session.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent, type CoordinatorDeps } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Store } from "../src/daemon/db.ts";
import { Messenger, type TerminalSender } from "../src/daemon/messaging.ts";
import { blankSession } from "../src/daemon/state.ts";
import { withMessageLimits } from "./message-limits.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function rig(omit: (keyof CoordinatorDeps)[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-approvable-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const c = new Coordination(store);
  const sessions = new Map<string, Session>();
  const add = (id: string) => {
    const s: Session = { ...blankSession(id, "claude", "tui", id), cwd: root, name: id, execution: "idle" };
    sessions.set(id, s);
    return s;
  };
  const written: { id: string; text: string }[] = [];
  const terminal: TerminalSender = {
    canSend: () => true,
    send: async (s, text) => (written.push({ id: s.id, text }), { ok: true }),
    interrupt: async () => ({ ok: true }),
  };
  const messenger = new Messenger(store, { sessions } as any, { onReceipt: null } as any, { owns: () => false } as any, () => {});
  messenger.terminal = terminal;
  const maintained: string[] = [];
  const deps: CoordinatorDeps = {
    db: store.db,
    coordination: c,
    cfg: mergeCoordinatorConfig(withMessageLimits()),
    sessions: () => sessions,
    events: () => [],
    send: async (sessionId, text, ctx) => {
      const clientId = ctx.proposalId !== null ? `proposal:${ctx.proposalId}` : undefined;
      const m = await messenger.send({ sessionId, text, author: "coordinator", clientId, context: ctx });
      return m.state === "failed" ? { ok: false, error: m.error ?? "failed" } : { ok: true };
    },
    maintain: async (id, command, focus, ctx) => {
      agent.authorizeDelivery(id, command === "clear" ? "/clear" : `/compact${focus ? ` ${focus}` : ""}`, ctx);
      maintained.push(`${id} ${command}`);
      return { ok: true };
    },
    askSeveral: async () => ({ id: "g1" }),
    launch: async () => "worker",
    createWorktree: async () => root,
    escalate: () => {},
    push: () => {},
    timers: false,
  };
  for (const k of omit) delete (deps as any)[k];
  const agent = new CoordinatorAgent(deps);
  messenger.authorize = (m) => agent.authorizeDelivery(m.sessionId, m.text, m.context);
  const o = c.createObjective("Human objective", "", undefined, "human");
  c.grantObjective(o.id, { root, resources: [] }, "human");
  agent.setMode("active");
  let n = 0;
  const task = (patch: any = {}) =>
    c.createTask({ title: "Task", objectiveId: o.id, acceptance: ["done"], scope: { paths: [join(root, `f${n++}.ts`)], resources: [] }, ...patch }, "human");
  add("mine"); // a session the user drives: no task, no autopilot
  return { root, store, c, o, agent, messenger, sessions, add, task, written, maintained };
}

const propose = async (x: ReturnType<typeof rig>, args: any, tool = "send_message") => {
  const r: any = await x.agent.callTool(tool, { reason: "r", ...args });
  expect(r.ok).toBe(true);
  return r.result.proposal as { id: number; heldBecause: string; taskId: string | null };
};

test("approving a message to a session the user drives, with no task, delivers it", async () => {
  const x = rig();
  const p = await propose(x, { sessionId: "mine", text: "The API tests are flaky on CI; can you look?" });
  expect(p).toMatchObject({ heldBecause: "outside_authority", taskId: null });
  expect(x.written).toHaveLength(0);
  expect((await x.agent.approve(p.id)).state).toBe("approved");
  expect(x.written).toEqual([{ id: "mine", text: "[coordinator] The API tests are flaky on CI; can you look?" }]);
  expect(x.store.outboxByClientId(`proposal:${p.id}`)!.context).toEqual({ taskId: null, proposalId: p.id, humanApproved: true });
  // request_checkpoint takes the same path.
  (x.agent as any).sent.length = 0; // past the per-session cooldown
  const cp = await propose(x, { sessionId: "mine" }, "request_checkpoint");
  expect((await x.agent.approve(cp.id)).state).toBe("approved");
  expect(x.written.at(-1)!.text).toStartWith("[coordinator] Checkpoint please");
});

test("a destructive message without a task is held, then delivered once approved", async () => {
  const x = rig();
  const p = await propose(x, { sessionId: "mine", text: "git reset --hard origin/main" });
  expect(p.heldBecause).toBe("destructive_screen");
  expect(x.written).toHaveLength(0);
  expect((await x.agent.approve(p.id)).state).toBe("approved");
  expect(x.written.map((w) => w.text)).toEqual(["[coordinator] git reset --hard origin/main"]);
});

test("approved taskless messages still face exclusion, the user's message, rate limit and near-duplicates", async () => {
  const x = rig();
  // Excluding the session cancels its pending card.
  const ex = await propose(x, { sessionId: "mine", text: "Excluded soon" });
  x.agent.setExcluded("mine", true);
  await expect(x.agent.approve(ex.id)).rejects.toThrow(/cancelled/);
  x.agent.setExcluded("mine", false);
  // The user messaging the session cancels it too.
  const hm = await propose(x, { sessionId: "mine", text: "The user will answer this themselves" });
  x.agent.onHumanMessage("mine");
  await expect(x.agent.approve(hm.id)).rejects.toThrow(/cancelled/);
  expect(x.written).toHaveLength(0);
  (x.agent as any).humanHold.clear();
  // Two near-identical cards: the second is dropped once the first is sent.
  const a = await propose(x, { sessionId: "mine", text: "Please rerun the integration tests" });
  const b = await propose(x, { sessionId: "mine", text: "Please rerun the integration tests." });
  const c = await propose(x, { sessionId: "mine", text: "Something else entirely: bump the version" });
  expect((await x.agent.approve(a.id)).state).toBe("approved");
  expect(await x.agent.approve(b.id)).toMatchObject({ state: "failed", detail: expect.stringMatching(/near-identical/) });
  // A different message within the cooldown is refused.
  expect(await x.agent.approve(c.id)).toMatchObject({ state: "failed", detail: expect.stringMatching(/cooldown/) });
  expect(x.written).toHaveLength(1);
});

test("a taskless approval can't be stretched: the delivery must carry exactly its text and no task", async () => {
  const x = rig();
  const t = x.task({ owner: "mine" });
  const p = await propose(x, { sessionId: "mine", text: "Please add tests" });
  await x.agent.approve(p.id);
  const ctx = { taskId: null, proposalId: p.id, humanApproved: true };
  expect(() => x.agent.authorizeDelivery("mine", "[coordinator] Please add tests", ctx)).not.toThrow();
  expect(() => x.agent.authorizeDelivery("mine", "[coordinator] rm -rf .", ctx)).toThrow(/approval doesn't match/);
  expect(() => x.agent.authorizeDelivery("mine", "[coordinator] Please add tests", { ...ctx, taskId: t.id })).toThrow(/approval doesn't match/);
  x.add("other");
  expect(() => x.agent.authorizeDelivery("other", "[coordinator] Please add tests", ctx)).toThrow(/approval doesn't match/);
});

test("a message naming a task its approval would refuse is refused up front, with no card", async () => {
  const x = rig();
  x.add("theirs");
  const elsewhere = x.task({ owner: "theirs" });
  const mine = x.task({ owner: "mine" });
  const cases: [any, RegExp][] = [
    [{ sessionId: "mine", text: "Status?", taskId: "no-such-task" }, /unknown task/],
    [{ sessionId: "mine", text: "Status?", taskId: elsewhere.id }, /isn't owned by mine/],
  ];
  for (const [args, why] of cases) {
    const r: any = await x.agent.callTool("send_message", { reason: "r", ...args });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(why);
    expect(r.error).toMatch(/Leave taskId out/);
  }
  expect((await x.agent.callTool("request_checkpoint", { sessionId: "mine", taskId: "no-such-task", reason: "r" })).ok).toBe(false);
  // Destructive text on a worker the coordinator runs: held only if its task checks out.
  x.add("worker");
  x.agent.setAutopilot("worker", true);
  x.task({ owner: "worker" });
  expect((await x.agent.callTool("send_message", { sessionId: "worker", taskId: mine.id, text: "git reset --hard", reason: "r" })).ok).toBe(false);
  // The session's own task under a revoked grant.
  x.c.revokeObjective(x.o.id, "human");
  const revoked: any = await x.agent.callTool("send_message", { sessionId: "mine", text: "Status?", taskId: mine.id, reason: "r" });
  expect(revoked).toMatchObject({ ok: false, error: expect.stringMatching(/grant/) });
  expect(x.agent.proposals()).toHaveLength(0);
  // Without the task it is a plain message the user can approve.
  const p = await propose(x, { sessionId: "mine", text: "Status?" });
  expect((await x.agent.approve(p.id)).state).toBe("approved");
  expect(x.written).toHaveLength(1);
});

test("a message naming the session's own valid task is still proposed and delivered under it", async () => {
  const x = rig();
  const t = x.task({ owner: "mine" });
  const p = await propose(x, { sessionId: "mine", text: "Please add tests", taskId: t.id });
  expect(p.taskId).toBe(t.id);
  expect((await x.agent.approve(p.id)).state).toBe("approved");
  expect(x.store.outboxByClientId(`proposal:${p.id}`)!.context).toEqual({ taskId: t.id, proposalId: p.id, humanApproved: true });
});

test("approving a fresh start for a session the user drives clears it and delivers the brief", async () => {
  const x = rig();
  const brief = "Done: parser and its tests (bun test green). Next: wire it into the CLI in src/cli.";
  const r: any = await x.agent.callTool("refresh_context", { sessionId: "mine", how: "fresh", brief, reason: "context 85% full" });
  expect(r.result.proposed).toBe(true);
  const out = await x.agent.approve(r.result.proposal.id);
  expect(out).toMatchObject({ state: "approved", detail: "done" });
  expect(x.maintained).toEqual(["mine clear"]);
  expect(x.written).toEqual([{ id: "mine", text: `[coordinator] ${brief}` }]);
  // A task named on a fresh start must already check out, or there is no card.
  const bad: any = await x.agent.callTool("refresh_context", { sessionId: "mine", how: "fresh", brief, taskId: "no-such-task", reason: "r" });
  expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/unknown task/) });
});

test("an empty taskId counts as no task, through approval and delivery", async () => {
  const x = rig();
  const p = await propose(x, { sessionId: "mine", text: "Status?", taskId: "" });
  expect((await x.agent.approve(p.id)).state).toBe("approved");
  x.add("yours");
  const brief = "Done: parser and its tests (bun test green). Next: wire it into the CLI in src/cli.";
  const r: any = await x.agent.callTool("refresh_context", { sessionId: "yours", how: "fresh", brief, taskId: "", reason: "r" });
  expect((await x.agent.approve(r.result.proposal.id)).state).toBe("approved");
  expect(x.written.map((w) => w.id)).toEqual(["mine", "yours"]);
});

test("a fresh start whose brief would be refused fails before anything is cleared", async () => {
  const x = rig();
  const brief = "Done: parser and its tests (bun test green). Next: wire it into the CLI in src/cli.";
  const r: any = await x.agent.callTool("refresh_context", { sessionId: "mine", how: "fresh", brief, reason: "r" });
  const msg = await propose(x, { sessionId: "mine", text: "Quick question about the parser" });
  await x.agent.approve(msg.id); // a message just went out: the cooldown is running
  const out = await x.agent.approve(r.result.proposal.id);
  expect(out).toMatchObject({ state: "failed", detail: expect.stringMatching(/brief would be refused.*cooldown/) });
  expect(x.maintained).toHaveLength(0);
});

test("proposals the daemon couldn't carry out are refused when made, not on the user's tap", async () => {
  // No context maintenance, no ask-several, no worktrees: no card for them.
  const x = rig(["maintain", "askSeveral", "createWorktree"]);
  expect(await x.agent.callTool("refresh_context", { sessionId: "mine", how: "compact", reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
  expect(await x.agent.callTool("ask_several", { prompt: "Which queue should we use?", cwd: x.root, reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
  const t = x.task();
  expect(await x.agent.callTool("launch_session", { taskId: t.id, repo: x.root, prompt: "git reset --hard first", reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/worktree creation unavailable/) });
  // An objective needs a title.
  expect(await x.agent.callTool("create_objective", { title: " ", root: x.root, reason: "r" })).toMatchObject({ ok: false, error: expect.stringMatching(/title/) });
  expect(x.agent.proposals()).toHaveLength(0);
});

test("a held launch for a task that already has an owner is refused, not queued", async () => {
  const x = rig();
  const owned = x.task({ owner: "mine" });
  const r: any = await x.agent.callTool("launch_session", { taskId: owned.id, repo: x.root, worktree: false, reason: "r" });
  expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already has an owner/) });
  expect(x.agent.proposals()).toHaveLength(0);
  // An unowned task is still held for the user, and approving it launches.
  const free = x.task();
  const held: any = await x.agent.callTool("launch_session", { taskId: free.id, repo: x.root, worktree: false, reason: "r" });
  expect(held.result.held).toBe(true);
  expect((await x.agent.approve(held.result.proposal.id)).state).toBe("approved");
});
