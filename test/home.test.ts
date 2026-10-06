// The home row/pane model (D34): the coordinator row for builtin/external, a plain "Needs you" row
// with no coordinator at all; permission prompts and waiting sessions count in every mode.
import { expect, test } from "bun:test";
import { agentSeen, homeRow, needsYou } from "../src/web/src/home.ts";
import type { AttentionItem, CoordinatorState, Task } from "../src/shared/types.ts";

let n = 0;
const item = (kind: AttentionItem["kind"], meta: Record<string, unknown> = {}, status: AttentionItem["status"] = "open"): AttentionItem =>
  ({ id: ++n, sessionId: "s1", kind, status, title: kind, text: null, createdAt: n, meta }) as unknown as AttentionItem;
const byId = (...items: AttentionItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));
const prompt = item("approval", { answerKey: "claude-hook:1" });
const question = item("question");
const finished = item("finished"); // the coordinator's business, never yours
const answered = item("approval", { answerKey: "claude-hook:2" }, "resolved");
const attention = byId(prompt, question, finished, answered);
const coord = (patch: Partial<CoordinatorState> = {}) =>
  ({ agent: "builtin", mode: "active", busy: false, proposals: [{ id: 1, state: "pending" }, { id: 2, state: "approved" }], lastToolCallAt: null, ...patch }) as unknown as CoordinatorState;
const tasks = [{ id: "t1", status: "finished_unverified" }, { id: "t2", status: "in_progress" }] as Task[];

test("needsYou: open permission prompts with an answer key, and how many other things are waiting", () => {
  const m = needsYou(attention);
  expect(m.prompts.map((i) => i.id)).toEqual([prompt.id]);
  expect(m.waiting).toBe(1); // the question; finished notices and answered prompts don't count
});

test("no coordinator: the home row is 'Needs you', counting prompts and waiting sessions", () => {
  const r = homeRow("none", null, [], attention);
  expect(r).toMatchObject({ title: "Needs you", waiting: 2, lamp: "off" });
  expect(r.status).toBe("2 need you");
  expect(homeRow("none", null, [], {}).status).toBe("Nothing right now");
});

test("built-in and external: the coordinator row counts proposals, done tasks and prompts", () => {
  const b = homeRow("builtin", coord(), tasks, attention);
  expect(b).toMatchObject({ title: "Coordinator", waiting: 3, lamp: "on", status: "On" });
  expect(homeRow("builtin", coord({ busy: true }), [], {})).toMatchObject({ lamp: "busy", status: "Thinking…" });
  const e = homeRow("external", coord({ agent: "external", busy: true }), [], {});
  expect(e).toMatchObject({ title: "Coordinator", lamp: "on", status: "On · your agent" }); // never "thinking": we can't see it
  expect(homeRow("external", coord({ agent: "external", mode: "manual" }), [], {}).status).toBe("Off · your agent");
  // Unknown yet (before the first message): today's coordinator row.
  expect(homeRow(null, null, [], {}).title).toBe("Coordinator");
});

test("agentSeen: whether the external agent has called in", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  expect(agentSeen(null, now)).toEqual({ connected: false, text: "Not connected since Switchboard started." });
  expect(agentSeen(now - 30_000, now)).toEqual({ connected: true, text: "Connected: last call 30s ago." });
  expect(agentSeen(now - 20 * 60_000, now).connected).toBe(false);
  expect(agentSeen(now - 20 * 60_000, now).text).toBe("Last call 20m ago.");
});
