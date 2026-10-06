import { expect, test } from "bun:test";
import { childrenIndex, runningCommand, type ProcInfo } from "../src/daemon/proc.ts";

const proc = (pid: number, ppid: number, comm: string): ProcInfo => ({ pid, ppid, pgrp: pid, tpgid: 0, ttyNr: 0, comm, state: "S", startTime: 0, cpuTicks: 0, rssPages: 0 });

function table(rows: [number, number, string, string[]][]) {
  const procs = new Map(rows.map(([pid, ppid, comm]) => [pid, proc(pid, ppid, comm)]));
  const argv = new Map(rows.map(([pid, , , a]) => [pid, a]));
  return { procs, kids: childrenIndex(procs), argv: (pid: number) => argv.get(pid) ?? [] };
}

test("an agent's background test run is seen through its shell, wrappers and all", () => {
  // The live shape: claude -> bash -c "... eval '<cmd>' < /dev/null ..." -> script -> python -> forge test -> solc
  const t = table([
    [100, 1, "claude", ["claude"]],
    [200, 100, "bash", ["/bin/bash", "-c", "source /x/snapshot.sh && eval '/tmp/tr.sh test/a.t.sol' < /dev/null && pwd -P >| /tmp/cwd"]],
    [300, 200, "bash", ["/bin/bash", "/tmp/tr.sh", "test/a.t.sol"]],
    [400, 300, "python3", ["python3", "scripts/groups.py"]],
    [500, 400, "forge", ["forge", "test", "-vv"]],
    [600, 500, "solc-0.8.34", ["/home/u/.svm/solc-0.8.34", "--standard-json"]],
    [700, 100, "node", ["node", "/mcp/server.js"]], // an MCP server: not a command
  ]);
  const r = runningCommand(100, t.procs, t.kids, t.argv, Date.now());
  expect(r).toMatchObject({ kind: "tests", cmd: "/tmp/tr.sh test/a.t.sol" });
});

test("builds and plain commands are told apart; hooks and nothing-running give nothing", () => {
  const build = table([
    [100, 1, "codex", ["codex"]],
    [200, 100, "bash", ["bash", "-lc", "cargo build --release"]],
  ]);
  expect(runningCommand(100, build.procs, build.kids, build.argv, Date.now())).toMatchObject({ kind: "build", cmd: "cargo build --release" });
  const other = table([
    [100, 1, "claude", ["claude"]],
    [200, 100, "bash", ["/bin/bash", "-c", "eval 'sleep 600' < /dev/null"]],
  ]);
  expect(runningCommand(100, other.procs, other.kids, other.argv, Date.now())).toMatchObject({ kind: "command", cmd: "sleep 600" });
  // A background command (no < /dev/null), with a quote escaped inside it.
  const bg = table([
    [100, 1, "claude", ["claude"]],
    [200, 100, "bash", ["/bin/bash", "-c", "source /x/s.sh && eval 'echo '\\''hi'\\''; ./run.sh' && pwd -P >| /tmp/cwd"]],
  ]);
  expect(runningCommand(100, bg.procs, bg.kids, bg.argv, Date.now())).toMatchObject({ cmd: "echo 'hi'; ./run.sh" });
  const hook = table([
    [100, 1, "claude", ["claude"]],
    [200, 100, "sh", ["sh", "-c", "/home/u/.local/share/switchboard/bin/sb-permission.sh"]],
  ]);
  expect(runningCommand(100, hook.procs, hook.kids, hook.argv, Date.now())).toBeUndefined();
  const idle = table([[100, 1, "claude", ["claude"]]]);
  expect(runningCommand(100, idle.procs, idle.kids, idle.argv, Date.now())).toBeUndefined();
});
