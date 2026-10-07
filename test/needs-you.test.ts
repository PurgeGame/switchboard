import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import fixtures from "./fixtures/needs-you-transcripts.json";
import { classifyTurnEnd, AmbiguityResolver } from "../src/daemon/classify.ts";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { Store } from "../src/daemon/db.ts";
import { applyEvent, blankSession } from "../src/daemon/state.ts";
import { needsYouItems, type NeedsYouState } from "../src/shared/needs-you.ts";
import { NeedsYouPush, validSubscription } from "../src/daemon/push.ts";
import { startHttp } from "../src/daemon/http.ts";
import type { AttentionItem, CoordinatorState, SbEvent, Task } from "../src/shared/types.ts";

const cfg = { port: 0, longRunMs: 300_000, stalledMs: 600_000, endedRetentionMs: 1, notifyDesktop: false, notifyFinished: false, notifyIgnore: [], modelClassifier: false, autoContinue: { enabled: false, graceMs: 0, maxConsecutive: 3, typingHoldMs: 0, offProjects: [] } };
const setup = (resolver?: AmbiguityResolver) => {
  const store = new Store("", ":memory:");
  const session = blankSession("worker", "claude", "tui", "1");
  const notifications: AttentionItem[] = [];
  const engine = new AttentionEngine(store, cfg, { pushItem() {}, notify: (i) => { notifications.push(i); }, setExecution: (s, x) => { s.execution = x; } }, resolver);
  let n = 0;
  const feed = (type: SbEvent["type"], data = {}, sourceId = `e${++n}`) => {
    const e = { sessionId: session.id, type, data, sourceId, ts: Date.now() };
    const previous = session.turnStartedAt;
    applyEvent(session, e);
    engine.onEvent(session, e, previous);
  };
  return { store, session, engine, feed, notifications };
};

describe("Needs you transcript fixtures", () => {
  for (const f of fixtures) test(f.name, () => {
    const { store, engine, feed } = setup();
    try {
      for (let i = 0; i < f.messages.length; i += 2) {
        feed("user_msg", { text: f.messages[i] });
        feed("turn_started");
        feed("assistant_msg", { text: f.messages[i + 1] });
        feed("turn_ended");
      }
      expect(engine.open().some((i) => i.kind === "question")).toBe(f.waiting);
      if (f.humanGate) {
        expect(classifyTurnEnd(f.messages.at(-1)).realChoice).toBe(true);
        expect(classifyTurnEnd(f.messages.at(-1)).continuationAsk).toBe(false);
      }
    } finally { store.db.close(); }
  });

  test("duplicate turn ends notify once; reply resolves; the next question is new", () => {
    const { store, engine, feed, notifications } = setup();
    feed("assistant_msg", { text: "Please approve this command." });
    feed("turn_ended", {}, "same-turn");
    feed("turn_ended", {}, "same-turn");
    expect(notifications).toHaveLength(1);
    feed("user_msg", { text: "Approved" });
    expect(engine.open()).toHaveLength(0);
    feed("assistant_msg", { text: "Please provide the URL." });
    feed("turn_ended");
    expect(notifications).toHaveLength(2);
    store.db.close();
  });

  test("late model result cannot resurrect a question after a later turn finished", async () => {
    let resolve!: (value: boolean) => void;
    const { store, engine, feed } = setup(new AmbiguityResolver(() => new Promise((r) => { resolve = r; })));
    feed("assistant_msg", { text: "Would you like me to investigate." });
    feed("turn_ended");
    feed("user_msg", { text: "Yes" });
    feed("assistant_msg", { text: "Done. Tests pass." });
    feed("turn_ended");
    resolve(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(engine.open()).toHaveLength(0);
    store.db.close();
  });
});

const attention = (id: number, kind = "question", meta = {}): AttentionItem => ({ id, kind, sessionId: "worker", sessionName: "Worker", title: "Please approve", text: "Please approve the command.", createdAt: id, status: "open", meta } as AttentionItem);
const state = (): NeedsYouState => ({ attention: [], coordinator: null, tasks: [], sessions: {} });
const review = { id: "task", title: "Fix UI", owner: "worker", updatedAt: 1, status: "finished_unverified" } as Task;

test("one selector covers all action types, removes resolved items and excludes coordinator-only work", () => {
  const s = state();
  s.tasks = [review];
  s.coordinator = { proposals: [{ id: 2, title: "Start a worker", state: "pending", createdAt: 1 }], plans: [{ proposalId: 3, tasks: [{ key: "a", title: "Launch", state: "failed" }] }] } as CoordinatorState;
  s.attention = [attention(1), attention(2, "approval", { answerKey: "prompt" }), attention(3, "approval"), attention(4, "finished"), attention(5, "conflict"), attention(6, "approval", { autoApproved: true }), attention(7, "question", { autoPending: true }), attention(8, "escalation", { coordinatorOnly: true })];
  expect(needsYouItems(s).map((i) => i.kind).sort()).toEqual(["attention", "attention", "launch", "proposal", "review"]);
  s.tasks = [{ ...review, status: "verified" }];
  s.coordinator.proposals[0].state = "approved";
  s.coordinator.plans[0].tasks[0].state = "waiting";
  s.attention = s.attention.map((i) => ({ ...i, status: "resolved" }));
  expect(needsYouItems(s)).toEqual([]);
});

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } };
describe("phone push dedupe", () => {
  test("reconnects, concurrent updates and daemon restarts do not duplicate; a new occurrence does notify", async () => {
    const store = new Store("", ":memory:");
    const sent: string[] = [];
    const send = async (_s: unknown, p: string) => { sent.push(JSON.parse(p).id); };
    const push = new NeedsYouPush(store.db, "mailto:test@example.com", send);
    push.subscribe(subscription, "owner");
    const items = needsYouItems({ ...state(), tasks: [review] });
    await Promise.all([push.sync(items), push.sync(items), push.sync(items)]);
    push.subscribe(subscription, "owner");
    await push.sync(items);
    const restarted = new NeedsYouPush(store.db, "mailto:test@example.com", send);
    expect(restarted.publicKey).toBe(push.publicKey);
    await restarted.sync(items);
    expect(sent).toEqual(["review:task:1"]);
    await restarted.sync([]);
    await restarted.sync(items);
    expect(sent).toEqual(["review:task:1", "review:task:2"]);
    restarted.revoke("owner");
    await restarted.sync(needsYouItems({ ...state(), attention: [attention(9)] }));
    expect(sent).toHaveLength(2);
    store.db.close();
  });
  test("transient failures retry; expired endpoints are removed; resolved items stop retrying", async () => {
    const store = new Store("", ":memory:");
    let attempts = 0;
    const push = new NeedsYouPush(store.db, "mailto:test@example.com", async () => { if (++attempts === 1) throw { statusCode: 503 }; });
    push.subscribe(subscription, null);
    const items = needsYouItems({ ...state(), tasks: [review] });
    await push.sync(items); await push.sync(items); await push.sync(items);
    expect(attempts).toBe(2);
    const expired = new NeedsYouPush(store.db, "mailto:test@example.com", async () => { attempts++; throw { statusCode: 410 }; });
    await expired.sync([]); await expired.sync(items); await expired.sync(items);
    expect(attempts).toBe(3);
    expect(store.db.query("SELECT * FROM push_subscriptions").all()).toEqual([]);
    store.db.close();
  });
  test("by default a notification says only how many items need you; push.details puts the item text back", async () => {
    const { store, engine, session } = setup();
    engine.raisePermission(session, { tool: "Bash", summary: "rm -rf /home/me/secret-project/build", answerKey: "held", recommendation: null });
    const items = needsYouItems({ ...state(), tasks: [review], attention: engine.open() });
    expect(items).toHaveLength(2);
    const payloads = async (opts?: { details?: boolean }) => {
      const sent: any[] = [];
      store.db.exec("DROP TABLE IF EXISTS push_deliveries");
      const push = new NeedsYouPush(store.db, "mailto:switchboard@localhost", async (_, p) => { sent.push(JSON.parse(p)); }, opts);
      push.subscribe(subscription, null);
      await push.sync(items);
      return sent;
    };
    const plain = await payloads();
    expect(plain.map((p) => p.body)).toEqual(["2 items need you", "2 items need you"]);
    expect(JSON.stringify(plain)).not.toContain("secret-project");
    expect(plain.every((p) => p.id && p.itemId && p.url)).toBe(true);
    const detailed = await payloads({ details: true });
    expect(detailed.map((p) => p.body).join("\n")).toContain("secret-project");
    store.db.close();
  });
  test("the VAPID subject is generic unless configured: never this machine's name", async () => {
    const { mergeConfig } = await import("../src/daemon/config.ts");
    expect(mergeConfig({}).push).toEqual({ details: false, subject: "mailto:switchboard@localhost" });
    expect(mergeConfig({ push: { details: true } }).push).toEqual({ details: true, subject: "mailto:switchboard@localhost" });
    expect(readFileSync(new URL("../src/daemon/main.ts", import.meta.url), "utf8")).not.toMatch(/NeedsYouPush\([^)]*remoteHost/);
  });
  test("subscription URLs cannot target arbitrary hosts or local services", () => {
    expect(validSubscription(subscription)).toBe(true);
    for (const endpoint of ["http://127.0.0.1:7777", "https://evil.example/push", "https://fcm.googleapis.com.evil.test/", "https://user@fcm.googleapis.com/push", "https://fcm.googleapis.com:1234/push"]) expect(validSubscription({ ...subscription, endpoint })).toBe(false);
  });
  test("upgrading a terminal prompt to Allow/Deny preserves notification identity", async () => {
    const { store, engine, session } = setup();
    const sent: string[] = [];
    const push = new NeedsYouPush(store.db, "mailto:test@example.com", async (_, p) => { sent.push(p); });
    push.subscribe(subscription, null);
    session.execution = "waiting_approval";
    session.executionConfidence = "confirmed";
    engine.onExecutionChange(session, "working");
    const items = () => needsYouItems({ ...state(), attention: engine.open() });
    await push.sync(items());
    engine.raisePermission(session, { tool: "Bash", summary: "Run deploy", answerKey: "held", recommendation: null });
    await push.sync(items());
    expect(items()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    engine.settlePermission("held", "answered in Switchboard");
    expect(items()).toHaveLength(0);
    store.db.close();
  });
  test("coordinator checks and automatic approvals never produce phone alerts", async () => {
    const { store, engine, session } = setup();
    const sent: string[] = [];
    const push = new NeedsYouPush(store.db, "mailto:test@example.com", async (_, p) => { sent.push(p); });
    push.subscribe(subscription, null);
    engine.setPermissionChecking(session.id, true);
    session.execution = "waiting_approval";
    session.executionConfidence = "confirmed";
    engine.onExecutionChange(session, "working");
    await push.sync(needsYouItems({ ...state(), attention: engine.open() }));
    engine.recordAutoApproval(session, { tool: "Read", summary: "Read the README", reason: "within scope", key: "auto-1" });
    engine.setPermissionChecking(session.id, false);
    await push.sync(needsYouItems({ ...state(), attention: engine.open() }));
    expect(sent).toEqual([]);
    expect(engine.open()).toEqual([]);
    store.db.close();
  });
});

test("push HTTP routes require human authentication; logout revokes the device", async () => {
  const store = new Store("", ":memory:");
  const push = new NeedsYouPush(store.db, "mailto:test@example.com", async () => {});
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const { server } = startHttp({ port, token: "human", coordinatorToken: "coordinator", store, push,
    registry: { sessions: new Map(), list: () => [], onPush() {} }, attention: { open: () => [] },
    coordination: { snapshot: () => ({ tasks: [] }) }, perspectives: { list: () => [] }, system: () => null,
  } as any);
  const base = `http://127.0.0.1:${port}`;
  const api = (path: string, headers: Record<string, string> = {}, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    expect((await api("/api/push/key")).status).toBe(401);
    expect((await api("/api/push/key", { authorization: "Bearer coordinator" })).status).toBe(403);
    expect((await api("/api/push/subscribe", { authorization: "Bearer coordinator" }, subscription)).status).toBe(403);
    const { url } = await (await api("/api/login-code", { authorization: "Bearer human" }, {})).json() as { url: string };
    const login = await fetch(url);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect((await (await api("/api/push/key", { cookie })).json() as any).publicKey).toBe(push.publicKey);
    expect((await api("/api/push/subscribe", { cookie }, { ...subscription, endpoint: "http://localhost/" })).status).toBe(400);
    expect((await api("/api/push/subscribe", { cookie }, subscription)).status).toBe(200);
    expect(store.db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(1);
    await api("/api/auth/logout", { cookie }, {});
    expect(store.db.query("SELECT * FROM push_subscriptions").all()).toHaveLength(0);
    expect((await api("/api/push/key", { cookie })).status).toBe(401);
  } finally { server.stop(true); store.db.close(); }
});
