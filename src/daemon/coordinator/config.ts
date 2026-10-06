// Coordinator settings: the "coordinator" key of ~/.config/switchboard/config.json.
// Kept separate from config.ts so the coordinator owns its own defaults.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorAgentKind, Tier } from "../../shared/types.ts";
import { paths } from "../config.ts";

export interface TierModel {
  model: string;
  effort: string | null;
}

export interface TierRule {
  /** Glob over task scope paths, e.g. "contracts/**", "**\/*.sol". */
  glob?: string;
  /** Case-insensitive regex over title + description. */
  match?: string;
  tier: Tier;
  reason?: string;
}

export interface CoordinatorConfig {
  /**
   * Who coordinates (D34): "builtin" = the daemon's own Claude process (default); "external" = your
   * own agent, connected with `sb mcp` (the daemon never starts a model for it); "none" = no
   * coordinator at all, just your sessions.
   */
  agent: CoordinatorAgentKind;
  /** Model for the coordinator itself (claude CLI alias or full id). */
  model: string;
  /** Reasoning effort for the coordinator (claude --effort): it should think, not answer instantly. */
  effort: "low" | "medium" | "high" | "xhigh";
  provider: "claude";
  /** Debounce for batched wake digests. */
  debounceMs: number;
  /** Heartbeat while something is working. */
  heartbeatMs: number;
  limits: {
    perSessionCooldownMs: number;
    perSessionPerHour: number;
    maxLaunched: number;
    dailyBudgetUsd: number;
    maxRetries: number;
    maxRelayHops: number;
    /** The same action succeeding this many times within an hour = repeated work: that call is refused. */
    repeatThreshold: number;
    /** The same action attempted this many times within an hour, whatever the outcome = a runaway loop: halt and flag. */
    runawayThreshold: number;
    /** After you message a session, the coordinator may not message it (or refresh its context) for this long. */
    humanHoldMs: number;
    /** A turn ending at or above this context % wakes the coordinator to consider a refresh. */
    contextHighPct: number;
    /** Near-identical messages to the same session within this window are dropped. */
    dedupeWindowMs: number;
    /**
     * Unfinished launch reservations (reserved/launching/uncertain) count toward maxLaunched only
     * for this long. A stuck one stays held for the human but can't block every launch forever.
     */
    reservationCapWindowMs: number;
  };
  /** tier -> provider -> model/effort */
  tiers: Record<Tier, { claude: TierModel; codex: TierModel }>;
  /** Override the rubric; first match wins. */
  tierRules: TierRule[];
  /** Where launch_session creates worktrees: <root>/<repo>/<slug>. */
  worktreeRoot: string;
}

export const coordinatorDefaults: CoordinatorConfig = {
  agent: "builtin",
  model: "opus",
  effort: "xhigh",
  provider: "claude",
  debounceMs: 60_000,
  heartbeatMs: 15 * 60_000,
  limits: {
    perSessionCooldownMs: 10 * 60_000,
    contextHighPct: 70,
    perSessionPerHour: 6,
    maxLaunched: 3,
    dailyBudgetUsd: 10,
    maxRetries: 2,
    maxRelayHops: 4,
    repeatThreshold: 3,
    runawayThreshold: 10,
    humanHoldMs: 10 * 60_000,
    dedupeWindowMs: 60 * 60_000,
    reservationCapWindowMs: 30 * 60_000,
  },
  tiers: {
    deep: { claude: { model: "opus", effort: "xhigh" }, codex: { model: "gpt-6-astra", effort: "xhigh" } },
    standard: { claude: { model: "sonnet", effort: null }, codex: { model: "gpt-6.1-sol", effort: null } },
    light: { claude: { model: "haiku", effort: null }, codex: { model: "gpt-6-luna", effort: null } },
  },
  tierRules: [],
  worktreeRoot: join(paths.home, "Dev/.switchboard-worktrees"),
};

export function mergeCoordinatorConfig(user: any): CoordinatorConfig {
  const d = coordinatorDefaults;
  const u = user ?? {};
  const tiers = { ...d.tiers } as CoordinatorConfig["tiers"];
  for (const t of ["deep", "standard", "light"] as Tier[])
    tiers[t] = { claude: { ...d.tiers[t].claude, ...(u.tiers?.[t]?.claude ?? {}) }, codex: { ...d.tiers[t].codex, ...(u.tiers?.[t]?.codex ?? {}) } };
  let agent: CoordinatorAgentKind = d.agent;
  if (u.agent !== undefined) {
    if (u.agent === "builtin" || u.agent === "external" || u.agent === "none") agent = u.agent;
    // Today's behavior; the built-in coordinator starts off, so nothing runs until it's switched on.
    else console.error(`[coordinator] unknown coordinator.agent ${JSON.stringify(u.agent)}: using "builtin" (valid: builtin, external, none)`);
  }
  return { ...d, ...u, agent, limits: { ...d.limits, ...(u.limits ?? {}) }, tiers, tierRules: Array.isArray(u.tierRules) ? u.tierRules : [] };
}

export function loadCoordinatorConfig(): CoordinatorConfig {
  const f = join(paths.configDir, "config.json");
  try {
    if (existsSync(f)) return mergeCoordinatorConfig(JSON.parse(readFileSync(f, "utf8")).coordinator);
  } catch (e) {
    console.error("[coordinator] bad config, using defaults:", (e as Error).message);
  }
  return mergeCoordinatorConfig(null);
}
