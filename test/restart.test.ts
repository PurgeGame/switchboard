// Restart / reconnect tests against the SIMULATOR (test/sim/claude-sim.ts): fake Claude
// sessions on disk, a real Registry and a real on-disk Store. No real provider is involved.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionItem, OutboxMessage, Session } from "../src/shared/types.ts";
import { ClaudeAdapter } from "../src/daemon/adapters/claude.ts";
import { AttentionEngine } from "../src/daemon/attention.ts";
import { Store } from "../src/daemon/db.ts";
import { Messenger, type TerminalSender } from "../src/daemon/messaging.ts";
import { Registry } from "../src/daemon/registry.ts";
import { ClaudeSim } from "./sim/claude-sim.ts";

const cfg = { port: 0, longRunMs: 5 * 60_000, stalledMs: 600_000, endedRetentionMs: 6 * 3600_000, notifyDesktop: false, notifyFinished: false, notifyIgnore: [], modelClassifier: false, autoContinue: { enabled: false, graceMs: 0, maxConsecutive: 3, typingHoldMs: 0, offProjects: [] } };

let sim: ClaudeSim;
let dataDir: string;
beforeEach(() => {
  sim = new ClaudeSim();
  dataDir = mkdtempSync(join(tmpdir(), "sb-sim-data-"));
});
afterEach(async () => {
  await sim.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

/** One "daemon run": Store + Registry + AttentionEngine over the same on-disk data dir. */
function boot() {
  const store = new Store(dataDir);
  const registry = new Registry([new ClaudeAdapter(sim.sessionsDir, sim.projectsDir)], store, cfg);
  const pushed: AttentionItem[] = [];
  const notified: AttentionItem[] = [];
  const engine = new AttentionEngine(store, cfg, {
    pushItem: (i) => pushed.push(structuredClone(i)),
    notify: (i) => notified.push(i),
    setExecution: (s, x, c) =>
      registry.update(s.id, (t) => {
        t.execution = x;
        t.executionConfidence = c;
      }),
  });
  registry.attention = engine;
  const shutdown = () => {
    registry.stop(); // flushes sessions; tail offsets are already persisted per poll
    store.db.close();
  };
  return { store, registry, engine, pushed, notified, shutdown };
}

/** Force the transcript tailers to poll now instead of waiting for their 700 ms timers. */
const pollTails = (r: Registry) => {
  for (const w of (r as any).watches.values()) w.tail.poll();
};
const count = (store: Store, id: string) => (store.db.query("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(id) as { n: number }).n;

describe("simulator: restart reconciliation", () => {
  test("(a) a restart with persisted tail offsets does not duplicate events or re-raise attention", async () => {
    const s = sim.start("alpha");
    sim.user(s, "do the thing");
    sim.assistant(s, "Done with step 1.\n\nShould I continue with step 2?");
    sim.turnEnd(s);
    const id = `claude:${s.sessionId}`;

    const run1 = boot();
    await run1.registry.tick();
    expect(run1.engine.open(id)).toHaveLength(1);
    const events1 = count(run1.store, id);
    expect(events1).toBeGreaterThan(2);
    run1.shutdown();

    const run2 = boot();
    await run2.registry.tick();
    await run2.registry.tick();
    expect(count(run2.store, id)).toBe(events1); // nothing re-read, nothing duplicated
    expect(run2.engine.open(id)).toHaveLength(1); // same single item
    expect(run2.pushed).toHaveLength(0); // not re-raised
    expect(run2.notified).toHaveLength(0);
    // New transcript lines after the restart are still picked up.
    sim.user(s, "yes, continue");
    pollTails(run2.registry);
    expect(count(run2.store, id)).toBeGreaterThan(events1);
    expect(run2.engine.open(id)).toHaveLength(0); // the answer resolved it
    run2.shutdown();
  });

  test("(a2) offsets are what prevent the duplicates: events dedupe by source id even without them", async () => {
    const s = sim.start("alpha2");
    sim.turn(s, "hello", "hi there");
    const id = `claude:${s.sessionId}`;
    const run1 = boot();
    await run1.registry.tick();
    const n = count(run1.store, id);
    run1.store.db.exec("DELETE FROM tail_offsets"); // lose the offsets: the whole transcript is re-read
    run1.shutdown();
    const run2 = boot();
    await run2.registry.tick();
    expect(count(run2.store, id)).toBe(n);
    run2.shutdown();
  });

  test("(b) a question asked while the daemon was down is reconciled as open; an answered one is not", async () => {
    const asked = sim.start("asked");
    const answered = sim.start("answered");
    sim.turn(asked, "start", "Working on it.");
    sim.turn(answered, "start", "Working on it.");
    const idAsked = `claude:${asked.sessionId}`;
    const idAnswered = `claude:${answered.sessionId}`;

    const run1 = boot();
    await run1.registry.tick();
    expect(run1.engine.open()).toHaveLength(0);
    run1.shutdown(); // ---- daemon down ----

    sim.user(asked, "go on");
    sim.assistant(asked, "Which database should I use, Postgres or SQLite?");
    sim.turnEnd(asked);
    sim.user(answered, "go on");
    sim.assistant(answered, "Should I proceed with the migration?");
    sim.turnEnd(answered);
    sim.user(answered, "yes, proceed"); // the user answered before the daemon came back

    const run2 = boot();
    await run2.registry.tick();
    const open = run2.engine.open();
    expect(open.map((i) => i.sessionId)).toEqual([idAsked]);
    expect(open[0].kind).toBe("question");
    expect(open[0].text).toContain("Postgres or SQLite");
    expect(run2.engine.open(idAnswered)).toHaveLength(0);
    run2.shutdown();
  });

  test("(c) a session that disappears goes to ended after the grace ticks, and stays ended across a restart", async () => {
    const s = sim.start("goner");
    sim.turn(s, "hello", "hi");
    const id = `claude:${s.sessionId}`;
    const run1 = boot();
    await run1.registry.tick();
    expect(run1.registry.sessions.get(id)!.execution).not.toBe("ended");
    sim.kill(s);
    await s.proc.exited;
    await run1.registry.tick(); // missing once: still within the grace period
    expect(run1.registry.sessions.get(id)!.execution).not.toBe("ended");
    await run1.registry.tick(); // missing twice: ended
    const ended = run1.registry.sessions.get(id)!;
    expect(ended.execution).toBe("ended");
    expect(ended.connection).toBe("disconnected");
    expect(ended.endedAt).not.toBeNull();
    run1.shutdown();

    const run2 = boot();
    expect(run2.registry.sessions.get(id)!.execution).toBe("ended"); // restored
    await run2.registry.tick();
    await run2.registry.tick();
    expect(run2.registry.sessions.get(id)!.execution).toBe("ended"); // dead process: not revived
    run2.shutdown();
  });

  test("a session that vanished while the daemon was down is ended on the first ticks after restart", async () => {
    const s = sim.start("gone-while-down");
    sim.turn(s, "hello", "hi");
    const id = `claude:${s.sessionId}`;
    const run1 = boot();
    await run1.registry.tick();
    run1.shutdown();
    sim.kill(s);
    await s.proc.exited;
    const run2 = boot();
    await run2.registry.tick();
    await run2.registry.tick();
    expect(run2.registry.sessions.get(id)!.execution).toBe("ended");
    run2.shutdown();
  });
});

/** Fake terminal path that records every injection (no real terminal anywhere). */
class FakeTerminal implements TerminalSender {
  sent: { id: string; text: string }[] = [];
  canSend() {
    return true;
  }
  async send(s: Session, text: string) {
    this.sent.push({ id: s.id, text });
    return { ok: true };
  }
  async interrupt() {
    return { ok: true };
  }
}

function bootMessenger() {
  const run = boot();
  const term = new FakeTerminal();
  const pushed: OutboxMessage[] = [];
  const codex: any = { onReceipt: null };
  const uploads: any = { owns: () => false };
  const messenger = new Messenger(run.store, run.registry, codex, uploads, (m) => pushed.push(structuredClone(m)));
  messenger.terminal = term;
  return { ...run, term, messenger, pushed };
}

describe("simulator: outbox across restarts", () => {
  test("(d) idempotency survives a restart: the same clientId never sends twice", async () => {
    const s = sim.start("outbox");
    sim.turn(s, "hello", "hi");
    const id = `claude:${s.sessionId}`;
    const run1 = bootMessenger();
    await run1.registry.tick();
    const m1 = await run1.messenger.send({ sessionId: id, text: "please continue", clientId: "client-1" });
    expect(run1.term.sent).toHaveLength(1);
    const again = await run1.messenger.send({ sessionId: id, text: "please continue", clientId: "client-1" });
    expect(again.id).toBe(m1.id);
    expect(run1.term.sent).toHaveLength(1);
    run1.shutdown();

    const run2 = bootMessenger();
    await run2.registry.tick();
    const m2 = await run2.messenger.send({ sessionId: id, text: "please continue", clientId: "client-1" });
    expect(m2.id).toBe(m1.id);
    expect(run2.term.sent).toHaveLength(0); // no second send after the restart
    expect(run2.store.outboxFor(id)).toHaveLength(1);
    // A different clientId is a different message.
    await run2.messenger.send({ sessionId: id, text: "another", clientId: "client-2" });
    expect(run2.term.sent).toHaveLength(1);
    run2.shutdown();
  });

  test("(e) uncertain is never retried automatically, not by sweeps, restarts, or resubmits", async () => {
    const s = sim.start("uncertain");
    sim.turn(s, "hello", "hi");
    const id = `claude:${s.sessionId}`;
    const run1 = bootMessenger();
    await run1.registry.tick();
    const m = await run1.messenger.send({ sessionId: id, text: "are you there?", clientId: "client-u" });
    expect(m.state).toBe("sending"); // injected, but no transcript receipt yet
    expect(run1.term.sent).toHaveLength(1);
    run1.messenger.sweep(Date.now() + 120_000); // receipt timeout passes
    expect(run1.store.outboxByClientId("client-u")!.state).toBe("uncertain");
    run1.messenger.sweep(Date.now() + 600_000);
    expect(run1.term.sent).toHaveLength(1);
    run1.shutdown();

    const run2 = bootMessenger();
    await run2.registry.tick();
    run2.messenger.sweep(Date.now() + 900_000);
    const after = await run2.messenger.send({ sessionId: id, text: "are you there?", clientId: "client-u" });
    expect(after.state).toBe("uncertain");
    expect(run2.term.sent).toHaveLength(0);
    expect(run2.store.outboxInState(["queued", "sending"])).toHaveLength(0); // nothing left for a retry loop to pick up
    run2.shutdown();
  });

  test("a message left in 'sending' by a crash becomes uncertain after restart, not re-sent", async () => {
    const s = sim.start("crash");
    sim.turn(s, "hello", "hi");
    const id = `claude:${s.sessionId}`;
    const run1 = bootMessenger();
    await run1.registry.tick();
    await run1.messenger.send({ sessionId: id, text: "work on X", clientId: "client-c" });
    run1.shutdown(); // crash/stop before any receipt
    const run2 = bootMessenger();
    await run2.registry.tick();
    run2.messenger.sweep(Date.now() + 120_000);
    expect(run2.store.outboxByClientId("client-c")!.state).toBe("uncertain");
    expect(run2.term.sent).toHaveLength(0);
    run2.shutdown();
  });

  test("a transcript receipt after restart settles a message as accepted", async () => {
    const s = sim.start("receipt");
    sim.turn(s, "hello", "hi");
    const id = `claude:${s.sessionId}`;
    const run1 = bootMessenger();
    await run1.registry.tick();
    await run1.messenger.send({ sessionId: id, text: "work on Y", clientId: "client-r" });
    run1.shutdown();
    sim.user(s, "work on Y"); // the terminal injection arrived as a user turn while the daemon was down
    const run2 = bootMessenger();
    run2.registry.eventHooks.push((e) => run2.messenger.onEvent(e));
    await run2.registry.tick();
    expect(run2.store.outboxByClientId("client-r")!.receipt).toBe(true);
    run2.shutdown();
  });
});
