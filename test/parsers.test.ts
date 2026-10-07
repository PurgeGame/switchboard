import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseClaudeRecord } from "../src/daemon/adapters/parse-claude.ts";
import { parseCodexLine } from "../src/daemon/adapters/parse-codex.ts";

const lines = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("claude transcript parser", () => {
  const recs = lines("./fixtures/claude/transcripts/sandbox-c1.jsonl");
  const events = recs.flatMap((r, i) => parseClaudeRecord(r, "s", `@${i}`).events);
  const count = (t: string) => events.filter((e) => e.type === t).length;

  test("fixture: one turn per prompt, tool calls paired with results", () => {
    expect(count("user_msg")).toBe(4);
    expect(count("turn_started")).toBe(4);
    expect(count("turn_ended")).toBe(4); // turn_duration only; end_turn is a soft hint
    expect(count("tool_call")).toBe(count("tool_result"));
  });

  test("source ids are unique (dedupe key)", () => {
    const ids = events.map((e) => e.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("peer message is not a user message", () => {
    const r = parseClaudeRecord(
      { type: "user", uuid: "u1", isMeta: true, timestamp: "2026-10-06T16:00:00Z", origin: { kind: "peer", name: "other-1", body: "hello" }, message: { role: "user", content: "wrapped" } },
      "s",
      "@0",
    );
    expect(r.events.map((e) => e.type)).toEqual(["peer_msg", "turn_started"]);
    expect(r.events[0].data).toMatchObject({ text: "hello", from: "other-1" });
  });

  test("a subagent's brief (sidechain) is not a user message", () => {
    const r = parseClaudeRecord({ type: "user", uuid: "u9", isSidechain: true, timestamp: "2026-10-06T16:00:00Z", message: { role: "user", content: "Search the repo for X" } }, "s", "@0");
    expect(r.events).toEqual([]);
  });

  test("interrupt, api error, soft turn end, rename", () => {
    expect(parseClaudeRecord({ type: "user", uuid: "a", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }, "s", "x").events[0].type).toBe("interrupted");
    const err = parseClaudeRecord({ type: "assistant", uuid: "b", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "limit" }] } }, "s", "x");
    expect(err.events[0]).toMatchObject({ type: "error", data: { status: 429 } });
    const end = parseClaudeRecord({ type: "assistant", uuid: "c", message: { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }, "s", "x");
    expect(end.patch?.softTurnEnd).toBe(true);
    expect(end.events.map((e) => e.type)).toEqual(["assistant_msg"]);
    expect(parseClaudeRecord({ type: "agent-name", agentName: "n1" }, "s", "x").patch?.name).toBe("n1");
  });

  test("tool summaries carry paths", () => {
    const r = parseClaudeRecord({ type: "assistant", uuid: "d", message: { content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/a/b.ts" } }] } }, "s", "x");
    expect(r.events[0].data).toMatchObject({ name: "Edit", paths: ["/a/b.ts"] });
  });
});

describe("codex rollout parser", () => {
  const recs = lines("./fixtures/codex/rollouts/sandbox-x1.jsonl");
  const events = recs.flatMap((r, i) => parseCodexLine(r, "s", `@${i}`).events);

  test("fixture: full turn lifecycle", () => {
    expect(events.map((e) => e.type)).toEqual(["session_started", "turn_started", "user_msg", "assistant_msg", "tool_call", "tool_call", "tool_result", "tool_call", "tool_result", "assistant_msg", "turn_ended"]);
    const end = events.at(-1)!;
    expect(end.data.lastAgentMessage).toContain("codex spike 1");
    expect(typeof end.data.durationMs).toBe("number");
  });

  test("older event_msg shapes and aborts", () => {
    expect(parseCodexLine({ type: "event_msg", ordinal: 1, payload: { type: "user_message", message: "hi" } }, "s", "x").events[0].type).toBe("user_msg");
    expect(parseCodexLine({ type: "event_msg", ordinal: 2, payload: { type: "turn_aborted", turn_id: "t", reason: "interrupted" } }, "s", "x").events[0].type).toBe("interrupted");
  });

  test("file changes list paths; token counts become a patch", () => {
    const fc = parseCodexLine({ type: "event_msg", ordinal: 3, payload: { type: "item_completed", item: { type: "FileChange", changes: { "/r/a.ts": {}, "/r/b.ts": {} } } } }, "s", "x");
    expect(fc.events[0].data.paths).toEqual(["/r/a.ts", "/r/b.ts"]);
    const tc = parseCodexLine({ type: "event_msg", ordinal: 4, payload: { type: "token_count", info: { total_token_usage: { total_tokens: 1234 } }, rate_limits: { primary: { used_percent: 12.5 } } } }, "s", "x");
    expect(tc.patch).toMatchObject({ tokens: 1234, rateLimitPct: 12.5 });
    expect(tc.events).toHaveLength(0);
  });
});

describe("claude peer messages from a non-session sender", () => {
  test("plain-text wrapper is unwrapped and the verified pid kept", () => {
    const content = "Another Claude session sent a message:\nhello there\n\nThis came from another Claude session — not typed by your user.";
    const r = parseClaudeRecord({ type: "user", uuid: "p", isMeta: true, origin: { kind: "peer", from: "unknown", verifiedPeerPid: 42 }, message: { role: "user", content } }, "s", "x");
    expect(r.events[0]).toMatchObject({ type: "peer_msg", data: { text: "hello there", peerPid: 42 } });
  });
  test("queue operations are not surfaced", () => {
    expect(parseClaudeRecord({ type: "queue-operation", operation: "enqueue", content: "hello there" }, "s", "x").events).toHaveLength(0);
  });
});
