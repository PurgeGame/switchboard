import { describe, expect, test } from "bun:test";
import type { AttentionItem, SbEvent, Session } from "../src/shared/types.ts";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { Store } from "../src/daemon/db.ts";
import { applyEvent, blankSession } from "../src/daemon/state.ts";

const NOW = 10_000_000;
const cfg = { port: 0, longRunMs: 5 * 60_000, stalledMs: 600_000, endedRetentionMs: 1, notifyDesktop: false, notifyFinished: false, notifyIgnore: [], modelClassifier: false, autoContinue: { enabled: false, graceMs: 0, maxConsecutive: 3, typingHoldMs: 0, offProjects: [] } };

function setup() {
  const store = new Store("", ":memory:");
  const pushed: AttentionItem[] = [];
  const notified: AttentionItem[] = [];
  const engine = new AttentionEngine(
    store,
    cfg,
    {
      pushItem: (i) => pushed.push(structuredClone(i)),
      notify: (i) => notified.push(i),
      setExecution: (s, x, c) => {
        s.execution = x;
        s.executionConfidence = c;
      },
    },
    undefined,
    NOW,
  );
  const s = blankSession("claude:1", "claude", "tui", "1");
  let n = 0;
  /** Apply like the registry does: state first, then attention. */
  const feed = (type: SbEvent["type"], ts: number, data: Record<string, unknown> = {}) => {
    const e = store.insertEvent({ sessionId: s.id, sourceId: `e${n++}`, type, ts, data })!;
    const prevTurn = s.turnStartedAt;
    const prevExec = s.execution;
    applyEvent(s, e);
    engine.onEvent(s, e, prevTurn);
    if (s.execution !== prevExec) engine.onExecutionChange(s, prevExec, ts);
  };
  return { store, engine, s, feed, pushed, notified };
}

describe("attention engine", () => {
  test("a turn ending in a question opens an item; the next prompt answers it", () => {
    const { engine, s, feed, notified } = setup();
    feed("user_msg", NOW + 1, { text: "do it" });
    feed("turn_started", NOW + 1);
    feed("assistant_msg", NOW + 2, { text: "Done with step 1.\n\nShould I continue with step 2?" });
    feed("turn_ended", NOW + 3, { durationMs: 2 });
    const open = engine.open(s.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "question", historical: false });
    expect(open[0].meta.continuationAsk).toBe(true);
    expect(s.execution).toBe("waiting_answer");
    expect(notified).toHaveLength(1);
    feed("user_msg", NOW + 10, { text: "yes" });
    expect(engine.open(s.id)).toHaveLength(0);
  });

  test("long turns raise Finished with an outcome; short turns raise nothing", () => {
    const { engine, s, feed } = setup();
    feed("turn_started", NOW + 1);
    feed("assistant_msg", NOW + 2, { text: "All tests pass." });
    feed("turn_ended", NOW + 3, { durationMs: 30_000 });
    expect(engine.open(s.id)).toHaveLength(0);
    feed("turn_started", NOW + 100);
    feed("assistant_msg", NOW + 6 * 60_000, { text: "Implemented the parser; all tests pass." });
    feed("turn_ended", NOW + 6 * 60_000, { durationMs: 6 * 60_000 });
    const [f] = engine.open(s.id);
    expect(f).toMatchObject({ kind: "finished", outcome: "success", title: "Finished after 6m" });
    expect(engine.acknowledge(f.id).ok).toBe(true);
    expect(engine.open(s.id)).toHaveLength(0);
  });

  test("a new turn closes a stale Finished notice (a working session isn't also 'finished')", () => {
    const { engine, s, feed } = setup();
    feed("turn_started", NOW + 1);
    feed("assistant_msg", NOW + 6 * 60_000, { text: "Both agents are working in the background. I'll pick up when either reports." });
    feed("turn_ended", NOW + 6 * 60_000, { durationMs: 6 * 60_000 });
    expect(engine.open(s.id).map((i) => i.kind)).toEqual(["finished"]);
    feed("turn_started", NOW + 7 * 60_000);
    expect(engine.open(s.id)).toHaveLength(0);
  });

  test("history: questions reconcile silently, finished turns are not news", () => {
    const { engine, s, feed, notified } = setup();
    const old = NOW - 3_600_000;
    feed("turn_started", old);
    feed("assistant_msg", old + 1, { text: "Which database should I use, Postgres or SQLite?" });
    feed("turn_ended", old + 2, { durationMs: 10 * 60_000 });
    expect(engine.open(s.id)).toMatchObject([{ kind: "question", historical: true }]);
    expect(notified).toHaveLength(0);
    feed("user_msg", old + 5, { text: "sqlite" }); // answered later in the replayed history
    expect(engine.open(s.id)).toHaveLength(0);
  });

  test("approval: hook detail fills an item the registry raised first; leaving the state resolves it", () => {
    const { engine, s } = setup();
    s.execution = "waiting_approval";
    s.executionConfidence = "confirmed";
    engine.onExecutionChange(s, "working", NOW + 1);
    expect(engine.open(s.id)[0]).toMatchObject({ kind: "approval", text: null });
    engine.noteApproval(s.id, { tool: "Bash", summary: "touch x", ts: NOW + 2 });
    expect(engine.open(s.id)[0]).toMatchObject({ title: "Needs approval: Bash", text: "touch x" });
    expect(engine.acknowledge(engine.open(s.id)[0].id).ok).toBe(false); // must be answered
    s.execution = "working";
    engine.onExecutionChange(s, "waiting_approval", NOW + 3);
    expect(engine.open(s.id)).toHaveLength(0);
  });

  test("a held prompt upgrades the registry item in place, notifies once and settles once", () => {
    const { engine, s, notified } = setup();
    // Discovery and the broker see the same prompt: preserve its identity.
    s.execution = "waiting_approval";
    s.executionConfidence = "confirmed";
    engine.onExecutionChange(s, "working", NOW + 1);
    engine.raisePermission(s, { tool: "Bash", summary: "touch x", answerKey: "k1", recommendation: null });
    expect(engine.open(s.id)).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(engine.open(s.id)[0].meta.answerKey).toBe("k1");
    engine.settlePermission("k1", "answered in Switchboard");
    expect(engine.open(s.id)).toHaveLength(0);
  });

  test("dedupe: the same source event never raises twice", () => {
    const { engine, s, store } = setup();
    const e = store.insertEvent({ sessionId: s.id, sourceId: "dup", type: "turn_ended", ts: NOW + 5, data: { lastAgentMessage: "Proceed?" } })!;
    engine.onEvent(s, e, null);
    engine.onEvent(s, e, null);
    expect(engine.open(s.id)).toHaveLength(1);
  });

  test("session end supersedes questions and approvals", () => {
    const { engine, s, feed } = setup();
    feed("turn_started", NOW + 1);
    feed("assistant_msg", NOW + 2, { text: "Want me to keep going?" });
    feed("turn_ended", NOW + 3);
    const prev = s.execution;
    s.execution = "ended";
    engine.onExecutionChange(s, prev, NOW + 4);
    expect(engine.open(s.id)).toHaveLength(0);
  });
});

test("an inferred stalled execution never raises attention", () => {
  const { engine, s, store, notified } = setup();
  s.execution = "stalled"; // a legacy snapshot/provider hint is not a coordinator verdict
  engine.onExecutionChange(s, "working", NOW);
  expect(store.openAttention(s.id)).toHaveLength(0);
  expect(notified).toHaveLength(0);
});
