import { describe, expect, test } from "bun:test";
import type { SbEvent } from "../src/shared/types.ts";
import { applyEvent, blankSession, checkStalled, mergeLiveStatus } from "../src/daemon/state.ts";
import { mapTuisToThreads } from "../src/daemon/adapters/codex.ts";
import { allowedHost, allowedOrigin } from "../src/daemon/http.ts";

let n = 0;
const ev = (type: SbEvent["type"], ts: number, data: Record<string, unknown> = {}): SbEvent => ({ sessionId: "s", sourceId: `e${n++}`, type, ts, data });

describe("session state", () => {
  test("turn lifecycle", () => {
    const s = blankSession("s", "claude", "tui", "x");
    applyEvent(s, ev("user_msg", 1000, { text: "Fix the parser\nplease" }));
    expect(s.firstPrompt).toBe("Fix the parser\nplease");
    expect(s.goal).toBe("Fix the parser");
    expect(s.goalInferred).toBe(true);
    applyEvent(s, ev("turn_started", 1000));
    expect(s.execution).toBe("working");
    expect(s.turnStartedAt).toBe(1000);
    applyEvent(s, ev("tool_call", 2000));
    expect(s.turnStartedAt).toBe(1000); // tool calls don't restart the turn
    applyEvent(s, ev("assistant_msg", 3000, { text: "Done." }));
    applyEvent(s, ev("turn_ended", 3001, { durationMs: 2001 }));
    expect(s.execution).toBe("idle");
    expect(s.turnStartedAt).toBeNull();
    expect(s.lastAssistantText).toBe("Done.");
  });

  test("interrupted sticks through provider 'idle' until the next turn", () => {
    const s = blankSession("s", "codex", "tui", "x");
    applyEvent(s, ev("turn_started", 1));
    applyEvent(s, ev("interrupted", 2));
    mergeLiveStatus(s, { execution: "idle", confidence: "confirmed" }, 3);
    expect(s.execution).toBe("interrupted");
    applyEvent(s, ev("turn_started", 4));
    expect(s.execution).toBe("working");
  });

  test("provider live status wins for working/waiting", () => {
    const s = blankSession("s", "claude", "tui", "x");
    mergeLiveStatus(s, { execution: "working", confidence: "confirmed" }, 50);
    expect(s.execution).toBe("working");
    expect(s.turnStartedAt).toBe(50);
    mergeLiveStatus(s, { execution: "waiting_approval", confidence: "confirmed" }, 60);
    expect(s.execution).toBe("waiting_approval");
    mergeLiveStatus(s, { execution: "idle", confidence: "confirmed" }, 70);
    expect(s.execution).toBe("idle");
  });

  test("a pending approval survives the tool_use record; the result clears it", () => {
    const s = blankSession("s", "claude", "tui", "x");
    applyEvent(s, ev("turn_started", 1));
    mergeLiveStatus(s, { execution: "waiting_approval", confidence: "confirmed" }, 2);
    applyEvent(s, ev("tool_call", 3));
    applyEvent(s, ev("assistant_msg", 3, { text: "running it" }));
    expect(s.execution).toBe("waiting_approval");
    applyEvent(s, ev("tool_result", 4));
    expect(s.execution).toBe("working");
  });

  test("stall needs silence AND no CPU", () => {
    const s = blankSession("s", "claude", "tui", "x");
    applyEvent(s, ev("turn_started", 0));
    s.resources = { cpuPct: 80, rssMB: 1, procs: 2 };
    expect(checkStalled(s, 11 * 60_000, 10 * 60_000)).toBe(false); // busy command
    s.resources.cpuPct = 0;
    expect(checkStalled(s, 11 * 60_000, 10 * 60_000)).toBe(true);
    expect(s.execution).toBe("stalled");
    expect(s.executionConfidence).toBe("inferred");
    applyEvent(s, ev("tool_call", 11 * 60_000 + 1));
    expect(checkStalled(s, 11 * 60_000 + 2, 10 * 60_000)).toBe(true);
    expect(s.execution).toBe("working");
  });
});

describe("codex TUI <-> thread mapping", () => {
  test("newest TUI that started before the thread; resume id is confirmed", () => {
    const tuis = [
      { pid: 1, cwd: "/w", startMs: 1000 },
      { pid: 2, cwd: "/w", startMs: 5000 },
      { pid: 3, cwd: "/a", startMs: 100, resumeId: "old" },
    ];
    const threads = [
      { id: "t1", cwd: "/w", createdAtMs: 2000, updatedAtMs: 2000 },
      { id: "t2", cwd: "/w", createdAtMs: 6000, updatedAtMs: 6000 },
      { id: "old", cwd: "/a", createdAtMs: 10, updatedAtMs: 10 },
    ];
    const m = mapTuisToThreads(tuis, threads);
    expect(m.get("t2")).toEqual({ pid: 2, confidence: "inferred" });
    expect(m.get("t1")).toEqual({ pid: 1, confidence: "inferred" });
    expect(m.get("old")).toEqual({ pid: 3, confidence: "confirmed" });
  });

  test("a TUI that ran /new leaves the older thread unmapped", () => {
    const m = mapTuisToThreads([{ pid: 1, cwd: "/w", startMs: 0 }], [
      { id: "a", cwd: "/w", createdAtMs: 100, updatedAtMs: 100 },
      { id: "b", cwd: "/w", createdAtMs: 900, updatedAtMs: 900 },
    ]);
    expect(m.get("b")?.pid).toBe(1);
    expect(m.has("a")).toBe(false);
  });

  test("resumed thread (created before the TUI started) still maps in pass 2", () => {
    const m = mapTuisToThreads([{ pid: 7, cwd: "/w", startMs: 10_000_000 }], [{ id: "r", cwd: "/w", createdAtMs: 5, updatedAtMs: 9_999_999 }]);
    expect(m.get("r")).toEqual({ pid: 7, confidence: "inferred" });
  });
});

describe("http guards", () => {
  test("host and origin", () => {
    expect(allowedHost("127.0.0.1:7777", 7777)).toBe(true);
    expect(allowedHost("localhost:7777", 7777)).toBe(true);
    expect(allowedHost("evil.com:7777", 7777)).toBe(false);
    expect(allowedHost("127.0.0.1:7777.evil.com", 7777)).toBe(false);
    expect(allowedOrigin(null, 7777)).toBe(true);
    expect(allowedOrigin("http://127.0.0.1:7777", 7777)).toBe(true);
    expect(allowedOrigin("http://evil.com", 7777)).toBe(false);
    expect(allowedOrigin("null", 7777)).toBe(false);
  });

  test("this machine's tailnet name is allowed exactly, over HTTPS only", () => {
    const remote = "pc.tail0000.ts.net";
    expect(allowedHost(remote, 7777, remote)).toBe(true);
    expect(allowedHost(`${remote}:443`, 7777, remote)).toBe(true);
    expect(allowedHost(`${remote}.evil.com`, 7777, remote)).toBe(false);
    expect(allowedHost("other.tail0000.ts.net", 7777, remote)).toBe(false);
    expect(allowedHost(remote, 7777)).toBe(false); // not configured
    expect(allowedOrigin(`https://${remote}`, 7777, remote)).toBe(true);
    expect(allowedOrigin(`http://${remote}`, 7777, remote)).toBe(false);
    expect(allowedOrigin(`https://${remote}.evil.com`, 7777, remote)).toBe(false);
    expect(allowedOrigin(`https://${remote}`, 7777)).toBe(false);
  });
});
