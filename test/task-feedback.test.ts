import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { CoordinatorAgent } from "../src/daemon/coordinator/agent.ts";
import { mergeCoordinatorConfig } from "../src/daemon/coordinator/config.ts";
import { startHttp } from "../src/daemon/http.ts";
import { Messenger } from "../src/daemon/messaging.ts";
import { blankSession } from "../src/daemon/state.ts";
import { needsYouItems } from "../src/shared/needs-you.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

async function rig() {
  const store = new Store("", ":memory:");
  const c = new Coordination(store);
  const worker = blankSession("codex:feedback-worker", "codex", "tui", "feedback-worker");
  worker.execution = "idle";
  worker.meta.onDaemon = true;
  const sessions = new Map([[worker.id, worker]]);
  const registry: any = { sessions, list: () => [...sessions.values()], onPush: () => {} };
  const sent: string[] = [];
  let deliver = async () => ({ outcome: "accepted", detail: "simulated transport" });
  const messenger = new Messenger(store, registry, {
    send: async (_id: string, text: string) => { sent.push(text); return deliver(); },
  } as any, { owns: () => false } as any, () => {});
  const agent = new CoordinatorAgent({
    db: store.db, coordination: c, cfg: mergeCoordinatorConfig({ agent: "external" }),
    sessions: () => sessions, events: () => [], send: async () => ({ ok: false }),
    escalate: () => {}, push: () => {}, timers: false,
  });
  agent.setMode("active");
  const updates = async () => (await agent.callTool("get_updates", { waitSeconds: 0 }) as any).result;
  await updates();
  const t = c.createTask({ title: "Fix the header", owner: worker.id, acceptance: ["Works on a phone"] }, "human");
  c.updateTask(t.id, { status: "finished_unverified", result: "Ready to review" }, "human");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const token = "a".repeat(64), coordinatorToken = "c".repeat(64);
  const { server } = startHttp({
    port, token, coordinatorToken, store, coordination: c, coordinator: agent, messenger, registry,
    attention: { open: () => [] }, webDist: "/nonexistent", system: () => null,
  } as any);
  cleanups.push(() => { server.stop(true); store.db.close(); });
  const post = (note: unknown, auth = token) => fetch(`http://127.0.0.1:${port}/api/tasks/${t.id}/feedback`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ note }),
  });
  const cards = () => needsYouItems({ attention: [], coordinator: null, tasks: c.snapshot().tasks, sessions: Object.fromEntries(sessions) });
  return { store, c, t, worker, sessions, sent, agent, updates, post, cards, coordinatorToken, delivery: (fn: typeof deliver) => { deliver = fn; } };
}

test("feedback reopens and persists the task, delivers to a live worker, and clears Needs you until re-finished", async () => {
  const x = await rig();
  expect(x.cards().map(c => c.id)).toEqual([`review:${x.t.id}`]);
  const response = await x.post("  The header still overflows.\nPlease check 390px.  ");
  expect(response.status).toBe(200);
  const task = await response.json() as any;
  expect(task).toMatchObject({ status: "in_progress", owner: x.worker.id, feedback: [{ by: "human", note: "The header still overflows.\nPlease check 390px." }] });
  expect(x.sent).toHaveLength(1);
  expect(x.sent[0]).toContain(x.t.id);
  expect(x.sent[0]).toContain(task.feedback[0].note);
  expect(x.store.outboxFor(x.worker.id)[0]).toMatchObject({ author: "human", state: "accepted" });
  expect((await x.updates()).events).toEqual([]);
  expect(x.agent.chat()).toEqual([]);
  expect(x.cards()).toEqual([]);
  expect(new Coordination(x.store).task(x.t.id)).toMatchObject({ status: "in_progress", feedback: task.feedback });
  const audit = x.store.db.query("SELECT data FROM authority_audit WHERE action='task_rejected_with_feedback'").get() as { data: string };
  expect(JSON.parse(audit.data)).toEqual({ taskId: x.t.id, note: task.feedback[0].note });
  // An unrelated update cannot make the review card return.
  x.c.updateTask(x.t.id, { result: "Working on the overflow" }, "human");
  expect(x.cards()).toEqual([]);
  x.c.updateTask(x.t.id, { status: "finished_unverified", result: "Fixed at 390px" }, "human");
  expect(x.cards().map(c => c.id)).toEqual([`review:${x.t.id}`]);
  expect(x.c.task(x.t.id)?.feedback).toEqual(task.feedback);
});

test("task state is published while worker delivery is still pending", async () => {
  const x = await rig();
  let finish!: () => void;
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  x.delivery(async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return { outcome: "accepted", detail: "delayed" }; });
  const request = x.post("Fix the header");
  await sending;
  try {
    expect(x.c.task(x.t.id)?.status).toBe("in_progress");
    expect(x.cards()).toEqual([]);
  } finally { finish(); }
  expect((await request).status).toBe(200);
});

for (const unavailable of ["ended", "missing", "unowned", "unreachable", "failed", "throws", "uncertain"] as const) {
  test(`${unavailable} worker wakes the coordinator with the task id and note`, async () => {
    const x = await rig();
    if (unavailable === "ended") x.worker.execution = "ended";
    if (unavailable === "missing") x.sessions.clear();
    if (unavailable === "unowned") x.c.updateTask(x.t.id, { owner: null }, "human");
    if (unavailable === "unreachable") x.worker.meta.onDaemon = false;
    if (unavailable === "failed" || unavailable === "uncertain") x.delivery(async () => ({ outcome: unavailable, detail: "transport unavailable" }));
    if (unavailable === "throws") x.delivery(async () => { throw Error("disconnected"); });
    expect((await x.post("Still missing the phone fix")).status).toBe(200);
    expect(x.c.task(x.t.id)?.status).toBe("in_progress");
    expect(x.cards()).toEqual([]);
    const events = (await x.updates()).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "task_rejected_with_feedback", data: { taskId: x.t.id, note: "Still missing the phone fix" } });
    expect(events[0].text).toContain(x.t.id);
    expect(events[0].text).toContain("Still missing the phone fix");
    if (unavailable === "uncertain") {
      expect(events[0].data.deliveryState).toBe("uncertain");
      expect(events[0].text).toContain("before sending it again");
    }
    if (["ended", "missing", "unowned", "unreachable"].includes(unavailable)) expect(x.sent).toEqual([]);
    expect((await x.updates()).events).toEqual([]);
  });
}

test("blank notes, coordinator credentials and stale review submissions do not mutate or re-send", async () => {
  const x = await rig();
  for (const note of ["", "   ", null, 123]) expect((await x.post(note)).status).toBe(409);
  expect((await x.post("Not done", x.coordinatorToken)).status).toBe(403);
  expect(x.c.task(x.t.id)?.status).toBe("finished_unverified");
  expect(x.sent).toEqual([]);
  expect((await x.post("Not done")).status).toBe(200);
  expect((await x.post("Not done")).status).toBe(409);
  expect(x.c.task(x.t.id)?.feedback).toHaveLength(1);
  expect(x.sent).toHaveLength(1);
});
