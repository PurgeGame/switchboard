// The list model: background agents (meta.background, set by the daemon) leave the projects and
// form their own section, but filters and search still reach them.
import { expect, test } from "bun:test";
import { blankSession } from "../src/daemon/state.ts";
import { buildListModel, type ListFilters } from "../src/web/src/sessionList.ts";
import type { Session } from "../src/shared/types.ts";

const mk = (id: string, patch: Partial<Session> = {}, meta: Record<string, unknown> = {}): Session => ({
  ...blankSession(id, "claude", "tui", id),
  cwd: "/repo",
  firstPrompt: "do the thing",
  execution: "idle",
  ...patch,
  meta,
});
const f = (patch: Partial<ListFilters> = {}): ListFilters => ({ search: "", provider: "all", group: "all", endedOpen: false, backgroundOpen: false, attention: new Map(), ...patch });
const sessions = [
  mk("mine"),
  mk("w1", { execution: "working" }, { background: "worker" }),
  mk("w2", { execution: "waiting_answer" }, { background: "perspective" }),
  mk("gone", { execution: "ended" }, { background: "worker" }),
];

test("background agents are out of the projects; collapsed they add no rows to keyboard order", () => {
  const m = buildListModel(sessions, f());
  expect(m.projects.flatMap((p) => p.sessions.map((s) => s.id))).toEqual(["mine"]);
  expect(m.background.map((s) => s.id).sort()).toEqual(["w1", "w2"]);
  expect(m.orderedIds).toEqual(["mine"]);
  expect(buildListModel(sessions, f({ backgroundOpen: true })).orderedIds).toContain("w2");
});

test("filters apply to the section, and a filter or search opens it", () => {
  const needs = buildListModel(sessions, f({ group: "attention" }));
  expect(needs.background.map((s) => s.id)).toEqual(["w2"]);
  expect(needs.orderedIds).toEqual(["w2"]);
  const working = buildListModel(sessions, f({ group: "active" }));
  expect(working.background.map((s) => s.id)).toEqual(["w1"]);
  expect(buildListModel(sessions, f({ search: "repo" })).orderedIds).toContain("w1");
});

test("Active filters assistant output across projects, background and ended sessions; seen markers clear matches", () => {
  const input = [mk("read"), mk("unread"), ...sessions.slice(1)];
  const filters = f({
    group: "unread",
    lastSeen: { read: 8, unread: 5, w1: 1, w2: 4, gone: 2 },
    lastAssistantEvent: { read: 8, unread: 6, w1: 3, w2: 2, gone: 7 },
  });
  const model = buildListModel(input, filters);
  expect(model.projects.flatMap((p) => p.sessions.map((s) => s.id))).toEqual(["unread"]);
  expect(model.background.map((s) => s.id)).toEqual(["w1"]);
  expect(model.ended.map((s) => s.id)).toEqual(["gone"]);
  expect(model.orderedIds).toEqual(["unread", "w1", "gone"]);
  expect(model.unreadCount).toBe(3);
  expect(buildListModel(input, { ...filters, group: "active" }).unreadCount).toBe(3);
  const read = buildListModel(input, { ...filters, lastSeen: { ...filters.lastSeen, unread: 6 } });
  expect(read.orderedIds).not.toContain("unread");
  expect(read.unreadCount).toBe(2);
});

test("Active's count follows search/provider and excludes empty sessions or input without assistant output", () => {
  const input = [mk("output", { provider: "codex", lastEventId: 12 }), mk("input", { lastEventId: 15 }), mk("empty", { firstPrompt: null })];
  const filters = f({ lastSeen: { output: 3, input: 10 }, lastAssistantEvent: { output: 8, input: 9, empty: 4 } });
  expect(buildListModel(input, filters).unreadCount).toBe(1);
  expect(buildListModel(input, { ...filters, group: "unread" }).orderedIds).toEqual(["output"]);
  expect(buildListModel(input, { ...filters, provider: "claude" }).unreadCount).toBe(0);
  expect(buildListModel(input, { ...filters, search: "input" }).unreadCount).toBe(0);
});

test("a frozen order holds rows still while their status changes; sessions it hasn't seen go first", () => {
  const a = mk("a", { execution: "idle", lastActivityAt: 1 });
  const b = mk("b", { execution: "idle", lastActivityAt: 2 });
  const live = buildListModel([a, b], f());
  const order = live.orderedIds; // what the list showed at the last reorder
  // b starts needing you: the live sort would move it, the frozen order doesn't.
  const b2 = { ...b, execution: "waiting_answer" as const };
  expect(buildListModel([a, b2], f({ order })).orderedIds).toEqual(order);
  // A brand-new session appears at the top right away.
  const c = mk("c", { execution: "idle", lastActivityAt: 0 });
  expect(buildListModel([a, b2, c], f({ order })).orderedIds[0]).toBe("c");
});

test("stateSummary: a folder's sessions by state, most urgent first, one entry per state present", async () => {
  const { stateSummary } = await import("../src/web/src/sessionList.ts");
  const s = (execution: string) => ({ execution }) as any;
  expect(stateSummary([s("idle"), s("working"), s("waiting_approval"), s("idle"), s("failed")])).toEqual([
    { execution: "waiting_approval", count: 1, label: "Needs approval" },
    { execution: "failed", count: 1, label: "Failed" },
    { execution: "working", count: 1, label: "Working" },
    { execution: "idle", count: 2, label: "Idle" },
  ]);
  expect(stateSummary([])).toEqual([]);
});

test("a session in a coordinator worktree is a background agent even when the daemon lost track of it (a /clear gives it a new id)", () => {
  const wt = "/home/u/Dev/.switchboard-worktrees/coordinator/a89c9ab8-chat-instructions-count-as-approval-fix";
  const m = buildListModel([mk("mine"), mk("cleared", { cwd: wt, name: "sb-a89c9ab8-8210-4fb9-8adb-ab4541bb66a3-deep" })], f());
  expect(m.projects.map((p) => p.key)).toEqual(["/repo"]);
  expect(m.background.map((s) => s.id)).toEqual(["cleared"]);
});

test("a worker goes by its task's title, or its folder's words before tasks load; a name you gave it stays", async () => {
  const { rememberTasks, sessionTitle } = await import("../src/web/src/status.ts");
  const wt = "/home/u/Dev/.switchboard-worktrees/coordinator/a89c9ab8-chat-instructions-count-as-approval-fix";
  const auto = mk("w", { cwd: wt, name: "sb-a89c9ab8-8210-4fb9-8adb-ab4541bb66a3-deep" });
  const relaunched = mk("r", { cwd: wt, name: "a89c9ab8-chat-instructions-count-as-appr-ae" });
  rememberTasks([]);
  expect(sessionTitle(auto)).toBe("Chat instructions count as approval fix");
  rememberTasks([{ id: "a89c9ab8-8210-4fb9-8adb-ab4541bb66a3", title: "Chat instructions count as approval; fix claims" }]);
  expect(sessionTitle(auto)).toBe("Chat instructions count as approval; fix claims");
  expect(sessionTitle(relaunched)).toBe("Chat instructions count as approval; fix claims");
  expect(sessionTitle(mk("n", { cwd: wt, name: "my poke-around" }))).toBe("my poke-around");
  expect(sessionTitle(mk("o", { name: "sb-a89c9ab8-x" }))).toBe("sb-a89c9ab8-x"); // not in a worktree: left alone
  // Search finds a worker by the title it shows.
  expect(buildListModel([auto], f({ search: "fix claims" })).orderedIds).toEqual(["w"]);
  rememberTasks([]);
});
