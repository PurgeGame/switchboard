// A shared-worktree conflict needs two live sessions editing files in the same git working tree.
// Starting in the same folder isn't one (the false alarm the coordinator raised on 2026-10-06).
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordination } from "../src/daemon/coordination.ts";
import { Store } from "../src/daemon/db.ts";
import { blankSession } from "../src/daemon/state.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function trees() {
  const base = mkdtempSync(join(tmpdir(), "sb-trees-"));
  dirs.push(base);
  const main = join(base, "coordinator"), wtA = join(base, "wt-a"), wtB = join(base, "wt-b");
  for (const d of [main, wtA, wtB]) mkdirSync(join(d, ".git"), { recursive: true });
  return { main, wtA, wtB };
}

function session(id: string, cwd: string, touched: string[], now: number) {
  const s = { ...blankSession(id, "claude", "tui", id), cwd, project: cwd, execution: "idle" as const };
  s.filesTouched = touched.map((path) => ({ path, at: now - 1000, source: "edit-tool" as const }));
  return s;
}

test("same starting folder, edits in different worktrees: no conflict", () => {
  const t = trees();
  const store = new Store("", ":memory:");
  const c = new Coordination(store);
  const now = Date.now();
  const sessions = new Map([
    ["a", session("a", t.main, [join(t.wtA, "src/x.ts")], now)],
    ["b", session("b", t.main, [join(t.wtB, "src/y.ts")], now)],
  ]);
  c.checkSharedWorktrees(sessions, now);
  expect(c.snapshot().conflicts.filter((x) => x.kind === "shared_worktree")).toHaveLength(0);
  store.db.close();
});

test("two sessions editing files in the same worktree: conflict", () => {
  const t = trees();
  const store = new Store("", ":memory:");
  const c = new Coordination(store);
  const now = Date.now();
  const sessions = new Map([
    ["a", session("a", t.main, [join(t.wtA, "src/x.ts")], now)],
    ["b", session("b", "/elsewhere", [join(t.wtA, "docs/y.md")], now)],
  ]);
  c.checkSharedWorktrees(sessions, now);
  const found = c.snapshot().conflicts.filter((x) => x.kind === "shared_worktree");
  expect(found).toHaveLength(1);
  expect(found[0].path).toBe(t.wtA);
  store.db.close();
});
