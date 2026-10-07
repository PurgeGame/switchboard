// A Claude session's subagents, read from <transcript>/subagents/agent-<id>.jsonl + .meta.json.
// How each ended comes from the <task-notification> its starter received; files are read incrementally.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityOf, ClaudeSubagents } from "../src/daemon/adapters/claude-subagents.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const line = (o: unknown) => JSON.stringify(o) + "\n";
const tool = (min: number, name: string, input: unknown) => line({ type: "assistant", timestamp: iso(min), message: { role: "assistant", content: [{ type: "tool_use", id: `t${min}`, name, input }] } });
const result = (min: number) => line({ type: "user", timestamp: iso(min), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
const note = (min: number, id: string, status: string) =>
  line({ type: "queue-operation", operation: "enqueue", timestamp: iso(min), content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>` });

function rig() {
  const root = mkdtempSync(join(tmpdir(), "sb-sub-"));
  dirs.push(root);
  const main = join(root, "sess.jsonl");
  const sub = join(root, "sess", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(main, line({ type: "user", timestamp: iso(0), message: { role: "user", content: "go" } }));
  const agent = (id: string, meta: Record<string, unknown>, body: string) => {
    writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", model: "opus", ...meta }));
    writeFileSync(join(sub, `agent-${id}.jsonl`), line({ type: "user", timestamp: iso(1), message: { role: "user", content: "brief" } }) + body);
  };
  return { main, sub, agent, r: new ClaudeSubagents(), at: (min: number) => T0 + min * 60_000 };
}

test("running agents with what they're doing; finished ones by their notification; nested ones name their parent", () => {
  const x = rig();
  x.agent("a1", { description: "Integration" }, tool(2, "Agent", { description: "Migrate tests" }) + result(3) + tool(4, "Bash", { command: "forge test", description: "Run the core suite" }));
  x.agent("a2", { description: "Migrate tests", parentAgentId: "a1" }, tool(3, "Edit", { file_path: "/r/test/Game.t.sol" }));
  x.agent("a3", { description: "Inventory" }, tool(2, "Read", { file_path: "/r/plan.md" }) + result(5));
  appendFileSync(x.main, note(6, "a3", "completed"));
  const list = x.r.read(x.main, true, null, x.at(10));
  expect(list.map((a) => [a.id, a.status, a.activity, a.parentId])).toEqual([
    ["a1", "running", "Run the core suite", null],
    ["a2", "running", "Editing Game.t.sol", "a1"],
    ["a3", "completed", null, null],
  ]);
  expect(list[2]).toMatchObject({ description: "Inventory", type: "general-purpose", model: "opus", startedAt: x.at(1), endedAt: x.at(6) });
  // A nested agent's notification lands in its parent agent's transcript.
  appendFileSync(join(x.sub, "agent-a1.jsonl"), note(11, "a2", "failed"));
  expect(x.r.read(x.main, true, null, x.at(12)).find((a) => a.id === "a2")).toMatchObject({ status: "failed", endedAt: x.at(11) });
});

test("reads only what's new: a later step updates the activity", () => {
  const x = rig();
  x.agent("a1", { description: "Work" }, tool(2, "Read", { file_path: "/r/a.ts" }));
  expect(x.r.read(x.main, true, null, x.at(3))[0].activity).toBe("Reading a.ts");
  appendFileSync(join(x.sub, "agent-a1.jsonl"), result(4) + tool(5, "Grep", { pattern: "resolveAccount" }));
  expect(x.r.read(x.main, true, null, x.at(6))[0]).toMatchObject({ activity: "Searching for resolveAccount", lastActivityAt: x.at(5) });
});

test("sent another message after it finished: running again", () => {
  const x = rig();
  x.agent("a1", { description: "Work" }, tool(2, "Read", { file_path: "/r/a.ts" }) + result(3));
  appendFileSync(x.main, note(4, "a1", "completed"));
  expect(x.r.read(x.main, true, null, x.at(5))[0].status).toBe("completed");
  appendFileSync(join(x.sub, "agent-a1.jsonl"), tool(20, "Bash", { command: "ls" }));
  expect(x.r.read(x.main, true, null, x.at(21))[0]).toMatchObject({ status: "running", activity: "Running ls" });
});

test("agents still running when the session ended, or silent since before its process started, are stopped", () => {
  const x = rig();
  x.agent("a1", { description: "Work" }, tool(2, "Bash", { command: "sleep 99" }));
  expect(x.r.read(x.main, false, null, x.at(3))[0]).toMatchObject({ status: "stopped", endedAt: x.at(2) });
  expect(new ClaudeSubagents().read(x.main, true, x.at(30), x.at(31))[0].status).toBe("stopped");
});

test("finished long ago, or files untouched for hours: not listed", () => {
  const x = rig();
  x.agent("old", { description: "Old" }, tool(2, "Read", { file_path: "/r/a.ts" }));
  appendFileSync(x.main, note(3, "old", "completed"));
  expect(x.r.read(x.main, true, null, x.at(4 * 60))).toEqual([]); // finished 4h ago
  const y = rig();
  y.agent("stale", { description: "Stale" }, tool(2, "Read", { file_path: "/r/a.ts" }));
  const past = (Date.now() - 7 * 3600_000) / 1000;
  utimesSync(join(y.sub, "agent-stale.jsonl"), past, past);
  expect(y.r.read(y.main, true, null, Date.now())).toEqual([]);
});

test("a session without subagents has none", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-sub-"));
  dirs.push(root);
  writeFileSync(join(root, "s.jsonl"), "");
  expect(new ClaudeSubagents().read(join(root, "s.jsonl"), true, null, Date.now())).toEqual([]);
});

test("activity reads as plain words", () => {
  expect(activityOf("Bash", { command: "forge build", description: "Build the contracts" })).toBe("Build the contracts");
  expect(activityOf("Bash", { command: "forge build" })).toBe("Running forge build");
  expect(activityOf("Write", { file_path: "/a/b/c.md" })).toBe("Writing c.md");
  expect(activityOf("Agent", { description: "Check gas" })).toBe("Started an agent: Check gas");
  expect(activityOf("mcp__github__get_issue", { number: 3 })).toMatch(/^get_issue: /);
});
