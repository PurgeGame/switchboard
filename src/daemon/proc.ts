// /proc helpers: process table, trees, foreground checks, CPU/RSS sampling.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { RunningCommand } from "../shared/types.ts";

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgrp: number;
  tpgid: number;
  ttyNr: number;
  comm: string;
  state: string;
  startTime: number; // clock ticks since boot (field 22)
  cpuTicks: number; // utime + stime
  rssPages: number;
}

const PAGE_KB = 4; // x86_64
const HZ = 100;

export function readStat(pid: number, procRoot = "/proc"): ProcInfo | null {
  try {
    const s = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const close = s.lastIndexOf(")");
    const comm = s.slice(s.indexOf("(") + 1, close);
    const f = s.slice(close + 2).split(" ");
    // f[0] = state (field 3)
    return {
      pid,
      comm,
      state: f[0],
      ppid: +f[1],
      pgrp: +f[2],
      ttyNr: +f[4],
      tpgid: +f[5],
      cpuTicks: +f[11] + +f[12],
      startTime: +f[19],
      rssPages: +f[21],
    };
  } catch {
    return null;
  }
}

export function listPids(procRoot = "/proc"): number[] {
  const out: number[] = [];
  for (const n of readdirSync(procRoot)) {
    if (/^\d+$/.test(n)) out.push(+n);
  }
  return out;
}

export function snapshot(): Map<number, ProcInfo> {
  const m = new Map<number, ProcInfo>();
  for (const pid of listPids()) {
    const p = readStat(pid);
    if (p) m.set(pid, p);
  }
  return m;
}

export function childrenIndex(procs: Map<number, ProcInfo>): Map<number, number[]> {
  const idx = new Map<number, number[]>();
  for (const p of procs.values()) {
    const arr = idx.get(p.ppid);
    if (arr) arr.push(p.pid);
    else idx.set(p.ppid, [p.pid]);
  }
  return idx;
}

export function descendants(root: number, kids: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    for (const c of kids.get(p) ?? []) stack.push(c);
  }
  return out;
}

export function cwdOf(pid: number, procRoot = "/proc"): string | null {
  try {
    return readlinkSync(`${procRoot}/${pid}/cwd`);
  } catch {
    return null;
  }
}

export function cmdlineOf(pid: number, procRoot = "/proc"): string[] {
  try {
    return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export function ttyOf(pid: number): string | null {
  try {
    const t = readlinkSync(`/proc/${pid}/fd/0`);
    return t.startsWith("/dev/pts/") ? t : null;
  } catch {
    return null;
  }
}

export function alive(pid: number, startTime?: number): boolean {
  const p = readStat(pid);
  if (!p || p.state === "Z") return false;
  return startTime === undefined || p.startTime === startTime;
}

/** True when the process is the foreground job of its controlling terminal. */
export function isForeground(pid: number): boolean {
  const p = readStat(pid);
  return !!p && p.ttyNr !== 0 && p.pgrp === p.tpgid;
}

const bootTimeMs = (() => {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
    return line ? +line.split(" ")[1] * 1000 : 0;
  } catch {
    return 0;
  }
})();

export function startedAtMs(p: ProcInfo): number {
  return bootTimeMs + (p.startTime / HZ) * 1000;
}

/** Tracks CPU deltas between samples. */
export class CpuSampler {
  private last = new Map<number, { ticks: number; t: number }>();
  /** percent of one core since the previous call for this pid */
  pct(p: ProcInfo, now: number): number {
    const prev = this.last.get(p.pid);
    this.last.set(p.pid, { ticks: p.cpuTicks, t: now });
    if (!prev || now <= prev.t) return 0;
    return ((p.cpuTicks - prev.ticks) / HZ / ((now - prev.t) / 1000)) * 100;
  }
  prune(live: Set<number>) {
    for (const pid of this.last.keys()) if (!live.has(pid)) this.last.delete(pid);
  }
}

export const rssMB = (p: ProcInfo) => (p.rssPages * PAGE_KB) / 1024;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
const TESTS = /\b(?:forge|cargo|go|bun|deno|hardhat|dotnet) test\b|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|\bplaywright test\b|\b(?:npm|pnpm|yarn)(?: run)? (?:test|e2e)\b|\btest[-_][\w-]*\.(?:py|sh|ts|js)\b/;
const BUILD = /\b(?:forge|cargo|go) build\b|\btsc\b|\bvite build\b|\bwebpack\b|\b(?:npm|pnpm|yarn)(?: run)? build\b|\bmake\b|\bgradle\b|\bmvn\b|\bsolc\b/;

/**
 * A command the agent started and is still running (often in the background after its turn
 * ended): a shell its process spawned with -c (Claude: `bash -c … eval '<cmd>'`, Codex: `bash -lc`).
 * Switchboard's own hooks don't count, nor do commands younger than minAgeMs (they'd flicker).
 */
export function runningCommand(root: number, procs: Map<number, ProcInfo>, kids: Map<number, number[]>, argv: (pid: number) => string[], now: number, minAgeMs = 5000): RunningCommand | undefined {
  let best: RunningCommand | undefined;
  for (const pid of kids.get(root) ?? []) {
    const p = procs.get(pid);
    if (!p || !SHELLS.has(p.comm)) continue;
    const args = argv(pid);
    const flag = args.findIndex((a, i) => i > 0 && /^-\w*c\w*$/.test(a));
    if (flag < 0) continue;
    const script = args.slice(flag + 1).join(" ");
    if (script.includes("/switchboard/") || script.includes("sb-hook") || script.includes("sb-permission")) continue;
    const since = startedAtMs(p);
    if (now - since < minAgeMs) continue;
    const cmd = (/\beval '((?:[^']|'\\'')*)'/.exec(script)?.[1] ?? script).replace(/'\\''/g, "'").replace(/\s+/g, " ").trim();
    const tree = [cmd, ...descendants(pid, kids).filter((d) => d !== pid).map((d) => argv(d).join(" "))].join("\n");
    const kind = TESTS.test(tree) ? "tests" : BUILD.test(tree) ? "build" : "command";
    // Prefer the oldest, and tests over builds over anything else.
    const rank = (k: RunningCommand["kind"]) => (k === "tests" ? 2 : k === "build" ? 1 : 0);
    if (!best || rank(kind) > rank(best.kind) || (rank(kind) === rank(best.kind) && since < best.since)) best = { kind, cmd: cmd.length > 160 ? `${cmd.slice(0, 157)}…` : cmd, since };
  }
  return best;
}

/** Does this process tree run Switchboard's MCP proxy (`sb mcp`)? That makes it a coordinator: yours, or the built-in one. */
export function runsSwitchboardMcp(root: number, kids: Map<number, number[]>, argv: (pid: number) => string[]): boolean {
  return descendants(root, kids).some((pid) => {
    if (pid === root) return false;
    const a = argv(pid);
    return a.some((x) => x.endsWith("/coordinator/mcp-server.ts")) || (a.some((x) => x.endsWith("/src/cli/sb.ts")) && a.includes("mcp"));
  });
}
