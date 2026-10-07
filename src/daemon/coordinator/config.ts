// Coordinator settings: the "coordinator" key of ~/.config/switchboard/config.json.
// Kept separate from config.ts so the coordinator owns its own defaults.
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AutoEndSettings, CoordinatorAgentKind, CoordinatorRuntimeSelection, CoordinatorRuntimeSettings, Tier, UsageRecommendationSettings } from "../../shared/types.ts";
import { paths } from "../config.ts";
import { CODEX_MODELS, codexCost } from "./codex-config.ts";

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
   * Who coordinates (D34): "builtin" = the daemon's own model process (default); "external" = your
   * own agent, connected with `sb mcp` (the daemon never starts a model for it); "none" = no
   * coordinator at all, just your sessions.
   */
  agent: CoordinatorAgentKind;
  /** Model for the coordinator itself (claude CLI alias or full id). */
  model: string;
  /** Reasoning effort for the coordinator (claude --effort). */
  effort: "low" | "medium" | "high" | "xhigh";
  /** Model and effort for the Codex runtime. Each provider remembers its own selection. */
  codex: TierModel;
  provider: "claude" | "codex";
  /** Debounce for batched wake digests. */
  debounceMs: number;
  /** Heartbeat while something is working. */
  heartbeatMs: number;
  /** Daemon cleanup of finished idle workers, independent of model wakes. */
  autoEnd: AutoEndSettings;
  limits: {
    /** Minimum gap between the coordinator's messages to one session (0 = none). */
    perSessionCooldownMs: number;
    /** Most messages to one session per hour (0 = no limit). */
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
    /** userChat: a chat message counts as the user's instruction only this long after it was sent... */
    userChatMaxAgeMs: number;
    /** ...and only while it is one of the user's last this-many chat messages. */
    userChatMaxBack: number;
    /** One chat message authorizes at most this many successful calls (a backstop, not a budget for normal use). */
    userChatMaxActions: number;
  };
  /** tier -> provider -> model/effort */
  tiers: Record<Tier, { claude: TierModel; codex: TierModel }>;
  /** Override the rubric; first match wins. */
  tierRules: TierRule[];
  usageRecommendations: UsageRecommendationSettings;
  /** Where launch_session creates worktrees: <root>/<repo>/<slug>. */
  worktreeRoot: string;
}

export const coordinatorDefaults: CoordinatorConfig = {
  agent: "builtin",
  // Conservative generic defaults; owners pick their own provider, models and limits in config.json.
  model: "opus",
  effort: "xhigh",
  // Used only when someone selects the Codex runtime.
  codex: { model: "gpt-6.1-sol", effort: "high" },
  provider: "claude",
  debounceMs: 60_000,
  heartbeatMs: 15 * 60_000,
  autoEnd: { enabled: true, idleMinutes: 10 },
  limits: {
    // 0 removes a per-time message limit, but only when configured explicitly (mergeLimits).
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
    userChatMaxAgeMs: 30 * 60_000,
    userChatMaxBack: 3,
    userChatMaxActions: 8,
  },
  tiers: {
    deep: { claude: { model: "opus", effort: "xhigh" }, codex: { model: "gpt-6-astra", effort: "xhigh" } },
    standard: { claude: { model: "sonnet", effort: null }, codex: { model: "gpt-6.1-sol", effort: null } },
    light: { claude: { model: "haiku", effort: null }, codex: { model: "gpt-6-luna", effort: null } },
  },
  tierRules: [],
  usageRecommendations: { enabled: true, lowRemainingPct: 20, stopRemainingPct: 5, resetSoonMinutes: 60, maxAgeMinutes: 15 },
  worktreeRoot: join(paths.home, "Dev/.switchboard-worktrees"),
};

export function mergeCoordinatorConfig(user: any): CoordinatorConfig {
  const d = coordinatorDefaults;
  const u = user ?? {};
  if (u.provider !== undefined && u.provider !== "claude" && u.provider !== "codex")
    throw new Error("coordinator.provider must be claude or codex");
  const tiers = { ...d.tiers } as CoordinatorConfig["tiers"];
  for (const t of ["deep", "standard", "light"] as Tier[])
    tiers[t] = { claude: { ...d.tiers[t].claude, ...(u.tiers?.[t]?.claude ?? {}) }, codex: { ...d.tiers[t].codex, ...(u.tiers?.[t]?.codex ?? {}) } };
  let agent: CoordinatorAgentKind = d.agent;
  if (u.agent !== undefined) {
    if (u.agent === "builtin" || u.agent === "external" || u.agent === "none") agent = u.agent;
    // Today's behavior; the built-in coordinator starts off, so nothing runs until it's switched on.
    else console.error(`[coordinator] unknown coordinator.agent ${JSON.stringify(u.agent)}: using "builtin" (valid: builtin, external, none)`);
  }
  return { ...d, ...u, agent, usageRecommendations: validateUsageRecommendationSettings({ ...d.usageRecommendations, ...u.usageRecommendations }), autoEnd: validateAutoEndSettings({ ...d.autoEnd, ...u.autoEnd }), codex: { ...d.codex, ...(u.codex ?? {}) }, limits: mergeLimits(d.limits, u.limits), tiers, tierRules: Array.isArray(u.tierRules) ? u.tierRules : [] };
}

/**
 * Limits from config.json over the defaults. A value that isn't a finite number of 0 or more is
 * ignored with a warning, so a typo can never become 0, which means "no limit" for the
 * per-session message limits: only an explicit 0 removes those caps.
 */
function mergeLimits(defaults: CoordinatorConfig["limits"], user: unknown): CoordinatorConfig["limits"] {
  const out = { ...defaults };
  if (!user || typeof user !== "object" || Array.isArray(user)) return out;
  for (const [key, value] of Object.entries(user as Record<string, unknown>)) {
    if (!(key in defaults)) continue;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) (out as Record<string, number>)[key] = value;
    else console.error(`[coordinator] ignoring coordinator.limits.${key}=${JSON.stringify(value)}: expected a number of 0 or more`);
  }
  return out;
}

export function validateUsageRecommendationSettings(v: any): UsageRecommendationSettings {
  if (!v || typeof v.enabled !== "boolean" ||
    !Number.isFinite(v.lowRemainingPct) || v.lowRemainingPct <= 0 || v.lowRemainingPct > 100 ||
    !Number.isFinite(v.stopRemainingPct) || v.stopRemainingPct < 0 || v.stopRemainingPct >= v.lowRemainingPct ||
    !Number.isInteger(v.resetSoonMinutes) || v.resetSoonMinutes < 1 || v.resetSoonMinutes > 10080 ||
    !Number.isInteger(v.maxAgeMinutes) || v.maxAgeMinutes < 1 || v.maxAgeMinutes > 1440)
    throw Error("Usage recommendations need 0 ≤ stop < low ≤ 100%, reset soon 1–10080 minutes, and maximum age 1–1440 minutes");
  return { enabled: v.enabled, lowRemainingPct: v.lowRemainingPct, stopRemainingPct: v.stopRemainingPct, resetSoonMinutes: v.resetSoonMinutes, maxAgeMinutes: v.maxAgeMinutes };
}

export function validateAutoEndSettings(value: any): AutoEndSettings {
  if (!value || typeof value.enabled !== "boolean" || !Number.isInteger(value.idleMinutes) || value.idleMinutes < 1 || value.idleMinutes > 1440)
    throw new Error("auto-end requires enabled (boolean) and idleMinutes (a whole number from 1 to 1440)");
  return { enabled: value.enabled, idleMinutes: value.idleMinutes };
}

export function loadCoordinatorConfig(configDir = paths.configDir): CoordinatorConfig {
  const f = join(configDir, "config.json");
  try {
    if (existsSync(f)) return mergeCoordinatorConfig(JSON.parse(readFileSync(f, "utf8")).coordinator);
  } catch (e) {
    console.error("[coordinator] bad config, using defaults:", (e as Error).message);
  }
  return mergeCoordinatorConfig(null);
}

export type RuntimeSelection = CoordinatorRuntimeSelection;

export function runtimeSelection(cfg: CoordinatorConfig): RuntimeSelection {
  return { provider: cfg.provider, ...(cfg.provider === "codex" ? cfg.codex : { model: cfg.model, effort: cfg.effort }) };
}

/** Human Settings route only. Never exposed as an MCP tool, and never changes limits or authority. */
export function saveRuntimeSelection(value: unknown, configDir = paths.configDir): CoordinatorConfig {
  const v = value as RuntimeSelection;
  if (!v || typeof v !== "object" || Object.keys(v).some((k) => !["provider", "model", "effort"].includes(k)))
    throw new Error("only provider, model and effort can be changed here");
  if (v.provider !== "claude" && v.provider !== "codex") throw new Error("provider must be claude or codex");
  if (typeof v.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v.model)) throw new Error("invalid model");
  if (v.provider === "codex") codexCost(v.model, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  const efforts = v.provider === "codex" ? [null, "low", "medium", "high", "xhigh", "max", "ultra"] : ["low", "medium", "high", "xhigh"];
  if (!efforts.includes(v.effort)) throw new Error("invalid effort for provider");
  const file = join(configDir, "config.json");
  // Do not overwrite a malformed file or drop unrelated settings.
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config file");
  const coordinator = { ...config.coordinator, provider: v.provider,
    ...(v.provider === "codex" ? { codex: { ...config.coordinator?.codex, model: v.model, effort: v.effort } } : { model: v.model, effort: v.effort }) };
  const merged = mergeCoordinatorConfig(coordinator);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = join(configDir, `.config-${randomUUID()}.json`);
  try {
    writeFileSync(tmp, JSON.stringify({ ...config, coordinator }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return merged;
}

export function readRuntimeSettings(current: RuntimeSelection | null, configDir = paths.configDir): CoordinatorRuntimeSettings {
  const cfg = loadCoordinatorConfig(configDir);
  return { selected: runtimeSelection(cfg), current,
    choices: { claude: { provider: "claude", model: cfg.model, effort: cfg.effort }, codex: { provider: "codex", ...cfg.codex } },
    models: { claude: [...new Set(["opus", "sonnet", "haiku", cfg.model])], codex: [...CODEX_MODELS] } };
}
