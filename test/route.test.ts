// route_to_session: the user's chat message (text + images) goes verbatim, once, to the session
// the coordinator picks. Paused/off coordinators don't route; destructive-sounding messages wait
// for the user's confirmation of the destination. In-memory store, fake delivery.
import { afterEach, expect, test } from "bun:test";
import type { Session } from "../src/shared/types.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function rig() {
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const sessions = new Map<string, Session>();
  for (const id of ["web", "api"]) sessions.set(id, { ...blankSession(id, "claude", "tui", id), execution: "idle" as const, name: id });
  const delivered: { sessionId: string; text: string; images: string[]; chatId: number }[] = [];
  const agent = new CoordinatorAgent({
    db: store.db,
    coordination: new Coordination(store),
    cfg: mergeCoordinatorConfig({}),
    sessions: () => sessions,
    events: () => [],
    send: async () => ({ ok: true }),
    route: async (sessionId, text, images, chatId) => (delivered.push({ sessionId, text, images, chatId }), { ok: true }),
    escalate: () => {},
    push: () => {},
    timers: false,
  });
  agent.setMode("active");
  // The chat goes through userChat; no coordinator process is needed for these tests.
  (agent as any).ensureRuntime = () => ({ busy: false, send: () => true });
  return { agent, delivered, sessions };
}

test("routes the user's exact words and images to the chosen session, once", async () => {
  const x = rig();
  const r = x.agent.userChat("the header overlaps on mobile, fix it", ["/uploads/shot.png"]);
  expect(r.ok).toBe(true);
  const first: any = await x.agent.callTool("route_to_session", { chatId: r.id, sessionId: "web", reason: "website issue" });
  expect(first.ok).toBe(true);
  expect(x.delivered).toEqual([{ sessionId: "web", text: "the header overlaps on mobile, fix it", images: ["/uploads/shot.png"], chatId: r.id! }]);
  const again: any = await x.agent.callTool("route_to_session", { chatId: r.id, sessionId: "api", reason: "try again" });
  expect(again.ok).toBe(false);
  expect(x.delivered).toHaveLength(1);
  expect(x.agent.chat().find((e) => e.id === r.id)?.routedTo).toBe("web");
});

test("a paused coordinator doesn't route", async () => {
  const x = rig();
  const r = x.agent.userChat("tell the api session to add tests");
  x.agent.setMode("paused");
  expect((await x.agent.callTool("route_to_session", { chatId: r.id, sessionId: "api", reason: "x" })).ok).toBe(false);
  expect(x.delivered).toHaveLength(0);
});

test("excluded sessions and the coordinator's own replies can't be routed", async () => {
  const x = rig();
  const r = x.agent.userChat("add tests");
  x.agent.setExcluded("api", true);
  expect((await x.agent.callTool("route_to_session", { chatId: r.id, sessionId: "api", reason: "x" })).ok).toBe(false);
  (x.agent as any).addChat("coordinator", "rm everything");
  const mine = x.agent.chat().at(-1)!;
  expect((await x.agent.callTool("route_to_session", { chatId: mine.id, sessionId: "web", reason: "x" })).ok).toBe(false);
  expect(x.delivered).toHaveLength(0);
});

test("a destructive-sounding message waits for the user to confirm where it goes", async () => {
  const x = rig();
  const r = x.agent.userChat("git reset --hard and start the nav over");
  const held: any = await x.agent.callTool("route_to_session", { chatId: r.id, sessionId: "web", reason: "nav" });
  expect(held.result.held).toBe(true);
  expect(x.delivered).toHaveLength(0);
  await x.agent.approve(held.result.proposal.id);
  expect(x.delivered.map((d) => d.sessionId)).toEqual(["web"]);
  // Approving again can't deliver twice.
  await expect(x.agent.approve(held.result.proposal.id)).rejects.toThrow();
  expect(x.delivered).toHaveLength(1);
});
