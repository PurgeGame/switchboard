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

test("background agents are out of the projects and counted; collapsed they add no rows to keyboard order", () => {
  const m = buildListModel(sessions, f());
  expect(m.projects.flatMap((p) => p.sessions.map((s) => s.id))).toEqual(["mine"]);
  expect(m.background.map((s) => s.id).sort()).toEqual(["w1", "w2"]);
  expect(m.backgroundWaiting).toBe(1);
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
