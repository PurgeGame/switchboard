import { describe, expect, test } from "bun:test";
import { decide, defaultGovernorConfig as cfg, type SessionGov } from "../src/daemon/governor.ts";
import { blankSession } from "../src/daemon/state.ts";
import type { SystemStats } from "../src/shared/types.ts";

const sys = (psiMem: number, availMB = 40_000): SystemStats => ({ ts: 0, cpuPct: 10, cores: 32, memTotalMB: 64_000, memAvailableMB: availMB, swapUsedMB: 0, psi: { cpu: 0, memory: psiMem, io: 0 }, gpu: null, gameMode: false });
const sess = (id: string, rss: number) => Object.assign(blankSession(id, "claude", "tui", id), { execution: "working" as const, resources: { cpuPct: 50, rssMB: rss, procs: 3 } });

describe("governor decisions", () => {
  test("no pressure, nothing happens", () => {
    expect(decide([sess("a", 9000)], sys(0), new Map(), cfg, null, 0)).toEqual([]);
  });
  test("pressure throttles the biggest low-priority tree first, never a protected one", () => {
    const gov = new Map<string, SessionGov>([
      ["big", { priority: "protected", level: 0, reason: null, since: null, scope: null }],
      ["low", { priority: "low", level: 0, reason: null, since: null, scope: null }],
    ]);
    const a = decide([sess("big", 20_000), sess("low", 3_000), sess("mid", 8_000)], sys(25), gov, cfg, null, 0);
    expect(a).toMatchObject([{ kind: "throttle", sessionId: "low", level: 1 }]);
  });
  test("escalates one level at a time, then stops at MemoryHigh", () => {
    const gov = new Map<string, SessionGov>([["a", { priority: "normal", level: 1, reason: "x", since: 0, scope: "s" }]]);
    expect(decide([sess("a", 9000)], sys(0, 5_000), gov, cfg, null, 0)[0]).toMatchObject({ level: 2 });
    gov.get("a")!.level = 2;
    expect(decide([sess("a", 9000)], sys(30), gov, cfg, null, 0)).toEqual([]);
  });
  test("restores only after pressure stays clear (hysteresis)", () => {
    const gov = new Map<string, SessionGov>([["a", { priority: "normal", level: 2, reason: "x", since: 0, scope: "s" }]]);
    expect(decide([sess("a", 100)], sys(0), gov, cfg, 1000, 1000 + 60_000)).toEqual([]);
    expect(decide([sess("a", 100)], sys(0), gov, cfg, 1000, 1000 + 121_000)).toMatchObject([{ kind: "restore", sessionId: "a" }]);
  });
});
