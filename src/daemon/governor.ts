// Resource governor + game mode.
// Mechanisms (no root needed):
// - per-session transient systemd scopes (StartTransientUnit with existing PIDs), then
//   CPUWeight / IOWeight / MemoryHigh via `systemctl --user set-property --runtime`
// - E-core pinning via CPU affinity (taskset): the cpuset controller is NOT delegated to the
//   user, so AllowedCPUs has no effect; affinity is inherited by children
// Everything is runtime-only: nothing survives a reboot, no config is written.
// Automatic actions are reversible only (deprioritize, MemoryHigh); never kills anything.
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import type { Session, SystemStats } from "../shared/types.ts";
import { childrenIndex, descendants, snapshot } from "./proc.ts";

export type Priority = "protected" | "high" | "normal" | "low";
export interface GovernorConfig {
  memPressureHigh: number; // PSI memory some avg10 (%)
  memAvailableLowPct: number; // MemAvailable below this % of total
  restoreAfterMs: number; // pressure must stay clear this long
  eCores: string; // CPUs agents are pinned to in game mode, e.g. "16-31" (efficiency cores). Empty: no pinning.
  allCores: string; // CPUs to restore afterwards, e.g. "0-31". Empty: every CPU on this machine.
  gameProcesses: string[]; // process names that mean "a game is running"
}

export const defaultGovernorConfig: GovernorConfig = {
  memPressureHigh: 10,
  memAvailableLowPct: 15,
  restoreAfterMs: 2 * 60_000,
  // Machine-specific: set these in config.json. Game mode still works through GameMode clients and the manual toggle.
  eCores: "",
  allCores: "",
  gameProcesses: [],
};

export interface SessionGov {
  priority: Priority;
  level: 0 | 1 | 2; // 0 none, 1 deprioritized, 2 MemoryHigh
  reason: string | null;
  since: number | null;
  scope: string | null;
}

export type Action =
  | { kind: "throttle"; sessionId: string; level: 1 | 2; reason: string }
  | { kind: "restore"; sessionId: string; reason: string };

/** Pure decision: under pressure, throttle the biggest non-protected, lowest-priority tree. */
export function decide(sessions: Session[], sys: SystemStats, gov: Map<string, SessionGov>, cfg: GovernorConfig, clearSince: number | null, now: number): Action[] {
  const pressured = sys.psi.memory >= cfg.memPressureHigh || sys.memAvailableMB < (sys.memTotalMB * cfg.memAvailableLowPct) / 100;
  const rank: Record<Priority, number> = { low: 0, normal: 1, high: 2, protected: 3 };
  if (pressured) {
    const cands = sessions
      .filter((s) => s.execution !== "ended" && s.resources && (gov.get(s.id)?.priority ?? "normal") !== "protected")
      .sort((a, b) => rank[gov.get(a.id)?.priority ?? "normal"] - rank[gov.get(b.id)?.priority ?? "normal"] || (b.resources!.rssMB - a.resources!.rssMB));
    const top = cands[0];
    if (!top) return [];
    const cur = gov.get(top.id)?.level ?? 0;
    if (cur >= 2) return [];
    const r = top.resources!;
    const what = r.top ? `${r.top.name} ${r.top.rssMB} MB` : `${r.rssMB} MB`;
    return [{ kind: "throttle", sessionId: top.id, level: (cur + 1) as 1 | 2, reason: `memory pressure (PSI ${sys.psi.memory}, ${Math.round(sys.memAvailableMB / 1024)} GB free): ${what}` }];
  }
  if (clearSince !== null && now - clearSince >= cfg.restoreAfterMs)
    return [...gov.entries()].filter(([, g]) => g.level > 0).map(([id]) => ({ kind: "restore", sessionId: id, reason: "pressure cleared" }));
  return [];
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", timeout: 3000 });

export class Governor {
  readonly state = new Map<string, SessionGov>();
  gameMode = false;
  gameManual: boolean | null = null; // user toggle overrides detection
  private gameOffSince: number | null = null;
  private clearSince: number | null = null;
  private confined = new Set<number>(); // pids pinned to E-cores
  log: { at: number; text: string }[] = [];
  onChange: () => void = () => {};

  constructor(
    private cfg: GovernorConfig,
    private sessions: () => Session[],
    private extraRoots: () => number[], // e.g. the shared Codex daemon (all Codex tool processes)
  ) {}

  private gov(id: string): SessionGov {
    let g = this.state.get(id);
    if (!g) this.state.set(id, (g = { priority: "normal", level: 0, reason: null, since: null, scope: null }));
    return g;
  }

  private note(text: string) {
    this.log.unshift({ at: Date.now(), text });
    this.log.length = Math.min(this.log.length, 200);
    this.onChange();
  }

  private treePids(roots: number[]): number[] {
    const kids = childrenIndex(snapshot());
    return [...new Set(roots.flatMap((r) => descendants(r, kids)))];
  }

  private ensureScope(s: Session): string | null {
    const g = this.gov(s.id);
    if (g.scope) return g.scope;
    if (!s.pid) return null;
    const pids = this.treePids([s.pid]);
    const unit = `sb-${s.id.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 60)}.scope`;
    const r = sh("busctl", ["--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "1", "PIDs", "au", String(pids.length), ...pids.map(String), "0"]);
    if (r.status !== 0) return null;
    g.scope = unit;
    return unit;
  }

  private setProps(unit: string, props: string[]) {
    return sh("systemctl", ["--user", "set-property", "--runtime", unit, ...props]).status === 0;
  }

  setPriority(sessionId: string, p: Priority) {
    this.gov(sessionId).priority = p;
    this.note(`priority of ${sessionId} → ${p}`);
  }

  throttle(sessionId: string, level: 1 | 2, reason: string): boolean {
    const s = this.sessions().find((x) => x.id === sessionId);
    const g = this.gov(sessionId);
    if (!s || g.priority === "protected") return false;
    const unit = this.ensureScope(s);
    if (!unit) return false;
    const props = ["CPUWeight=20", "IOWeight=20"];
    if (level >= 2 && s.resources) props.push(`MemoryHigh=${Math.max(512, Math.round(s.resources.rssMB * 1.1))}M`);
    if (!this.setProps(unit, props)) return false;
    Object.assign(g, { level, reason, since: Date.now() });
    this.note(`throttled ${s.name ?? s.id} (level ${level}): ${reason}`);
    return true;
  }

  restore(sessionId: string, reason = "restored") {
    const g = this.gov(sessionId);
    if (g.scope) this.setProps(g.scope, [`CPUWeight=${this.gameMode ? 1 : 100}`, `IOWeight=${this.gameMode ? 1 : 100}`, "MemoryHigh=infinity"]);
    Object.assign(g, { level: 0, reason: null, since: null });
    this.note(`restored ${sessionId}: ${reason}`);
  }

  /** Is a game running? GameMode clients, a known game process, or a Heroic-launched process. */
  detectGame(): boolean {
    const gm = sh("busctl", ["--user", "get-property", "com.feralinteractive.GameMode", "/com/feralinteractive/GameMode", "com.feralinteractive.GameMode", "ClientCount"]);
    if (gm.status === 0 && /i\s+([1-9]\d*)/.test(gm.stdout)) return true;
    for (const name of this.cfg.gameProcesses) if (sh("pgrep", ["-f", name]).status === 0) return true;
    return false;
  }

  private setGameMode(on: boolean) {
    if (on === this.gameMode) return;
    this.gameMode = on;
    const sessions = this.sessions().filter((s) => s.execution !== "ended" && s.pid);
    const pids = this.treePids([...sessions.map((s) => s.pid!), ...this.extraRoots()]);
    const cores = on ? this.cfg.eCores : this.cfg.allCores || `0-${cpus().length - 1}`;
    if (cores) for (const pid of pids) sh("taskset", ["-a", "-p", "-c", cores, String(pid)]);
    if (on) pids.forEach((p) => this.confined.add(p));
    else this.confined.clear();
    for (const s of sessions) {
      const unit = this.ensureScope(s);
      if (unit) this.setProps(unit, on ? ["CPUWeight=1", "IOWeight=1"] : ["CPUWeight=100", "IOWeight=100"]);
    }
    this.note(on ? `🎮 game mode on: ${pids.length} agent processes at minimum weight${this.cfg.eCores ? `, pinned to CPUs ${this.cfg.eCores}` : ""}` : "game mode off: limits restored");
  }

  setGameManual(v: boolean | null) {
    this.gameManual = v;
    this.tick(null);
  }

  /** Every few seconds. */
  tick(sys: SystemStats | null, now = Date.now()) {
    const detected = this.gameManual ?? this.detectGame();
    if (detected) {
      this.gameOffSince = null;
      this.setGameMode(true);
      // New processes spawned while gaming also go to the E-cores.
      const pids = this.treePids([...this.sessions().filter((s) => s.pid && s.execution !== "ended").map((s) => s.pid!), ...this.extraRoots()]);
      for (const p of pids) if (!this.confined.has(p)) {
        sh("taskset", ["-a", "-p", "-c", this.cfg.eCores, String(p)]);
        this.confined.add(p);
      }
    } else if (this.gameMode) {
      this.gameOffSince ??= now;
      // Detected exit waits a minute in case of a quick relaunch; a manual "off" is immediate.
      if (this.gameManual === false || now - this.gameOffSince > 60_000) this.setGameMode(false);
    }
    if (!sys) return;
    const pressured = sys.psi.memory >= this.cfg.memPressureHigh || sys.memAvailableMB < (sys.memTotalMB * this.cfg.memAvailableLowPct) / 100;
    if (pressured) this.clearSince = null;
    else this.clearSince ??= now;
    for (const a of decide(this.sessions(), sys, this.state, this.cfg, this.clearSince, now)) {
      if (a.kind === "throttle") this.throttle(a.sessionId, a.level, a.reason);
      else this.restore(a.sessionId, a.reason);
    }
  }

  snapshot() {
    return { gameMode: this.gameMode, gameManual: this.gameManual, sessions: Object.fromEntries(this.state), log: this.log.slice(0, 50) };
  }
}
