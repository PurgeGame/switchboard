// Codex workers the coordinator launched get pinned to their process only when its launch record,
// the terminal Switchboard named for that task, and a single codex process under that terminal agree.
import { expect, test } from "bun:test";
import type { Session } from "../src/shared/types.ts";
import { pinCodexWorkers } from "../src/daemon/codex-pins.ts";
import { blankSession } from "../src/daemon/state.ts";
import type { ProcInfo } from "../src/daemon/proc.ts";

const proc = (pid: number, ppid: number, comm: string, startTime = pid * 10): ProcInfo =>
  ({ pid, ppid, pgrp: pid, tpgid: pid, ttyNr: 0, comm, state: "S", startTime, cpuTicks: 0, rssPages: 0 }) as ProcInfo;
const CODEX = "/home/u/.local/lib/node_modules/@openai/codex/vendor/bin/codex";

function rig() {
  const sessions: Session[] = [
    { ...blankSession("codex:t1", "codex", "tui", "t1"), execution: "idle" },
    { ...blankSession("codex:t2", "codex", "tui", "t2"), execution: "idle" },
    { ...blankSession("codex:t3", "codex", "tui", "t3"), execution: "ended" },
  ];
  const tasks: Record<string, string> = { "codex:t1": "task-a", "codex:t2": "task-b", "codex:t3": "task-c" };
  // Shell 100 (terminal sb-task-a-deep) -> node 101 -> codex 102. Shell 200 (sb-task-b-standard) runs two codex processes.
  const procs = new Map<number, ProcInfo>(
    [proc(100, 1, "bash"), proc(101, 100, "node"), proc(102, 101, "codex"), proc(200, 1, "bash"), proc(201, 200, "codex"), proc(202, 200, "codex"), proc(300, 1, "bash"), proc(301, 300, "codex")].map((p) => [p.pid, p]),
  );
  const pins: [string, number, number][] = [];
  const terminals = [
    { id: "T1", name: "sb-task-a-deep", processId: 100 },
    { id: "T2", name: "sb-task-b-standard", processId: 200 },
    { id: "T3", name: "sb-task-c-light", processId: 300 },
  ];
  const run = (over: Partial<Parameters<typeof pinCodexWorkers>[0]> = {}) =>
    pinCodexWorkers({ terminals: () => terminals, sessions: () => sessions, taskOf: (id) => tasks[id] ?? null, pin: (...a) => pins.push(a), procs, cmdline: (pid) => (procs.get(pid)?.comm === "codex" ? [CODEX, "-m", "gpt-6-astra"] : ["node"]), ...over });
  return { run, pins, terminals, tasks };
}

test("the one codex process under the terminal Switchboard named for the session's task is pinned to it", () => {
  const x = rig();
  x.run();
  expect(x.pins).toEqual([["t1", 102, 1020]]); // not t2 (two codex processes: not certain), not t3 (ended)
});

test("no pin without the coordinator's own launch record, or with a terminal named for another task", () => {
  const x = rig();
  x.run({ taskOf: () => null });
  expect(x.pins).toEqual([]);
  x.terminals[0].name = "sb-task-z-deep";
  x.run();
  expect(x.pins).toEqual([]);
});
