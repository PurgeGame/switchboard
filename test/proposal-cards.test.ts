// Every proposal kind the coordinator queues renders as an approvable card: the card names what
// approving does (its button) and shows the exact text it sends or uses, and tapping it works.
// Proposals come from the real engine (callTool), cards from the web's proposalView, approval
// through agent.approve as the HTTP route calls it. Wired as main.ts wires delivery. Temp dirs,
// fake terminal, launcher and maintenance: no real session.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorProposal, Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent, type CoordinatorDeps } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Store } from "../src/daemon/db.ts";
import { Messenger, type TerminalSender } from "../src/daemon/messaging.ts";
import { blankSession } from "../src/daemon/state.ts";
import { proposalView } from "../src/web/src/proposals.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function rig() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sb-cards-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo"),
    wt = join(base, "worktrees");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(wt);
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const c = new Coordination(store);
  const sessions = new Map<string, Session>();
  for (const id of ["mine", "docs", "notes"]) sessions.set(id, { ...blankSession(id, "claude", "tui", id), cwd: root, name: id, execution: "idle" });
  const written: { id: string; text: string }[] = [];
  const terminal: TerminalSender = { canSend: () => true, send: async (s, text) => (written.push({ id: s.id, text }), { ok: true }), interrupt: async () => ({ ok: true }) };
  const messenger = new Messenger(store, { sessions } as any, { onReceipt: null } as any, { owns: () => false } as any, () => {});
  messenger.terminal = terminal;
  const done: string[] = [];
  const deps: CoordinatorDeps = {
    db: store.db,
    coordination: c,
    cfg: mergeCoordinatorConfig({ agent: "external" }), // no model process; the engine is the same
    sessions: () => sessions,
    events: () => [],
    send: async (sessionId, text, ctx) => {
      const m = await messenger.send({ sessionId, text, author: "coordinator", clientId: ctx.proposalId !== null ? `proposal:${ctx.proposalId}` : undefined, context: ctx });
      return m.state === "failed" ? { ok: false, error: m.error ?? "failed" } : { ok: true };
    },
    maintain: async (id, command, focus, ctx) => (agent.authorizeDelivery(id, command === "clear" ? "/clear" : `/compact${focus ? ` ${focus}` : ""}`, ctx), done.push(`${command} ${id}`), { ok: true }),
    askSeveral: async (prompt) => (done.push(`ask ${prompt}`), { id: "g1" }),
    route: async (sessionId, text) => (done.push(`route ${sessionId}: ${text}`), { ok: true }),
    launch: async (spec) => {
      sessions.set("worker", { ...blankSession("worker", spec.provider, "tui", "worker"), cwd: spec.cwd, execution: "working" });
      done.push(`launch ${spec.cwd}`);
      return "worker";
    },
    createWorktree: async (_r, slug) => {
      const p = join(wt, slug);
      mkdirSync(p, { recursive: true });
      return p;
    },
    escalate: () => {},
    push: () => {},
    timers: false,
  };
  const agent = new CoordinatorAgent(deps);
  messenger.authorize = (m) => agent.authorizeDelivery(m.sessionId, m.text, m.context);
  agent.setMode("active");
  return { root, c, agent, written, done, sessions };
}

const nameOf = (id: string | null) => id ?? "a session";

test("every proposal kind renders as a card that names its action and shows exactly what it sends, and approving it works", async () => {
  const x = rig();
  const queued: CoordinatorProposal[] = [];
  const q = async (tool: string, args: any) => {
    const r: any = await x.agent.callTool(tool, { reason: "worth doing", ...args });
    expect(r.ok).toBe(true);
    queued.push(r.result.proposal ?? r.result);
  };
  await q("send_message", { sessionId: "mine", text: "The API tests are flaky on CI; can you look?" });
  await q("send_message", { sessionId: "docs", text: "Revert the commits from this morning; they broke the build." }); // held: destructive
  await q("create_objective", { title: "Rate limiter", root: x.root, resources: ["port:3000"] });
  await q("propose_plan", { title: "Ship it", root: x.root, tasks: [{ key: "a", title: "Do a", brief: "Implement a in src/a.ts.", acceptance: ["a works"], provider: "claude", tier: "standard", paths: ["src/a.ts"] }] });
  await q("ask_several", { prompt: "Which queue library should we use?", cwd: x.root });
  // refresh_context for a session the user drives: one compact, one fresh start. (Approved cards
  // keep the per-session cooldown (D35), so each targets its own session here.)
  await q("refresh_context", { sessionId: "mine", how: "compact", focus: "the API work" });
  await q("refresh_context", { sessionId: "notes", how: "fresh", brief: "Done: API in src/api.ts, tested with bun test. Next: write docs/API.md." });
  await q("propose_action", { title: "Merge the auth branch", detail: "It's verified; merging is your call." });
  // A launch without a worktree, and a destructive-sounding chat message routed to a session.
  const o = x.c.createObjective("Human objective", "", undefined, "human");
  x.c.grantObjective(o.id, { root: x.root, resources: [] }, "human");
  const t = x.c.createTask({ title: "Shared tree", objectiveId: o.id, acceptance: ["done"], scope: { paths: [join(x.root, "src/s.ts")], resources: [] } }, "human");
  await q("launch_session", { taskId: t.id, repo: x.root, worktree: false, prompt: "Fix the flaky test in src/s.ts." });
  const chat = x.agent.userChat("tell docs to delete the old changelog files")!.id!;
  await q("route_to_session", { chatId: chat, sessionId: "docs" });

  const cards = queued.map((p) => ({ p, v: proposalView(x.agent.proposal(p.id)!, nameOf) }));
  const kinds = cards.map(({ p }) => (p.kind === "action" ? `action:${(p.payload as any).action ?? "propose_action"}` : p.kind));
  expect(kinds).toEqual([
    "send_message",
    "send_message",
    "action:new_objective",
    "action:plan",
    "action:ask_several",
    "action:refresh_context",
    "action:refresh_context",
    "action:propose_action",
    "launch_session",
    "action:route",
  ]);
  expect(cards.map(({ v }) => v.approve)).toEqual(["Send", "Send", "Go ahead", "Go ahead", "Ask them", "Compact", "Start fresh", "Go ahead", "Start", "Send"]);
  const [msg, held, objective, plan, several, compact, fresh, action, launch, route] = cards.map((c) => c.v);
  expect(msg).toMatchObject({ heading: "Send this to mine?", body: "The API tests are flaky on CI; can you look?" });
  expect(held.facts[0].text).toMatch(/sounded destructive/);
  expect(held.body).toBe("Revert the commits from this morning; they broke the build.");
  expect(objective.facts).toEqual([{ text: "Works in ", mono: x.root }, { text: "Also uses port:3000" }]);
  expect(plan).toMatchObject({ plan: true, heading: "Plan: Ship it" });
  expect(several).toMatchObject({ body: "Which queue library should we use?", facts: [{ text: "They work in ", mono: x.root }] });
  expect(compact).toMatchObject({ body: "the API work", bodyLabel: "What to keep" });
  expect(fresh.body).toBe("Done: API in src/api.ts, tested with bun test. Next: write docs/API.md.");
  expect(action).toMatchObject({ heading: "Merge the auth branch?", body: "It's verified; merging is your call." });
  expect(launch.facts).toEqual([{ text: "Works in ", mono: x.root }, { text: "Claude, in that folder itself (no worktree of its own)" }]);
  expect(launch.body).toBe("Fix the flaky test in src/s.ts.");
  expect(route).toMatchObject({ body: "tell docs to delete the old changelog files" });
  for (const { v } of cards) expect(v.heading.length).toBeGreaterThan(3);

  // Every card can be approved, and approving does what the card said.
  for (const { p } of cards) {
    const out = await x.agent.approve(p.id, { digest: x.agent.proposal(p.id)!.digest });
    await x.agent.settled();
    expect([p.id, out.state]).toEqual([p.id, "approved"]);
  }
  expect(x.written.map((w) => `${w.id}: ${w.text}`)).toEqual([
    "mine: [coordinator] The API tests are flaky on CI; can you look?",
    "docs: [coordinator] Revert the commits from this morning; they broke the build.",
    "notes: [coordinator] Done: API in src/api.ts, tested with bun test. Next: write docs/API.md.",
  ]);
  expect(x.done).toEqual(
    expect.arrayContaining(["ask Which queue library should we use?", "compact mine", "clear notes", `launch ${x.root}`, "route docs: tell docs to delete the old changelog files"]),
  );
  expect(x.c.snapshot().objectives.map((q) => q.title)).toEqual(expect.arrayContaining(["Rate limiter", "Ship it"]));
});
