// Consume monitor snapshots only. Polling, last-good retention and retries belong to usage.ts.
import type { ProviderUsage, Tier, UsageSnapshot, UsageWindow, WorkerRecommendation } from "../../shared/types.ts";
import { usageStatus } from "../../shared/usage.ts";
import type { CoordinatorConfig } from "./config.ts";
import { modelFor, resolveTier, rubricTier, suggestTier, TIER_RANK, type TierInput } from "./tiers.ts";

type Provider = "claude" | "codex";
interface Capacity { known: boolean; left: number; score: number; soon: boolean; reason: string }

function capacity(p: ProviderUsage | undefined, model: string, cfg: CoordinatorConfig, now: number): Capacity {
  const unknown = (reason: string): Capacity => ({ known: false, left: 0, score: 0, soon: false, reason });
  if (!p?.available) return unknown(`usage unavailable${p?.note ? ` (${p.note})` : ""}`);
  const at = p.asOf;
  // A failed refresh may retain numbers even before the age threshold. Treat marked readings
  // conservatively, including monitors that expose a structured stale flag instead of a note.
  const freshness = usageStatus(p, now);
  if (freshness.stale || p.note || at === null || !Number.isFinite(at) || at > now || now - at > cfg.usageRecommendations.maxAgeMinutes * 60_000)
    return unknown(`usage stale or unconfirmed${at !== null && Number.isFinite(at) ? ` (as of ${new Date(at).toISOString()})` : ""}${p.note || freshness.staleReason ? `: ${p.note || freshness.staleReason}` : ""}`);
  const windows = p.windows.filter((w) => !/\b(opus|sonnet)\b/i.test(w.label) || /\b(opus|sonnet)\b/i.exec(w.label)![0].toLowerCase() === (/opus/i.test(model) ? "opus" : /sonnet/i.test(model) ? "sonnet" : "unknown"));
  if (!windows.length) return unknown("usage unavailable (no applicable windows)");
  if (windows.some((w) => (w as UsageWindow & { reset?: boolean }).reset || !Number.isFinite(w.remainingPct) || w.remainingPct < 0 || w.remainingPct > 100 || w.resetsAt === null || !Number.isFinite(w.resetsAt) || w.resetsAt <= now))
    return unknown(`usage unconfirmed (missing/expired reset or invalid window; as of ${new Date(at!).toISOString()})`);
  const left = Math.min(...windows.map((w) => w.remainingPct));
  // Every applicable window constrains capacity: a weekly limit can veto a generous 5h one.
  const score = Math.min(...windows.map((w) => w.remainingPct / Math.max(1 / 60, (w.resetsAt! - now) / 3_600_000)));
  const soon = left > cfg.usageRecommendations.lowRemainingPct && windows.some((w) => w.resetsAt! - now <= cfg.usageRecommendations.resetSoonMinutes * 60_000);
  return { known: true, left, score, soon, reason: `${windows.map((w) => `${w.label} ${w.remainingPct}% left, resets ${new Date(w.resetsAt!).toISOString()}`).join("; ")} (as of ${new Date(at!).toISOString()})` };
}

export interface RecommendationInput extends TierInput {
  /** Supplied selections are preserved; omitted values are automatic. */
  provider?: Provider;
  tier?: Tier;
  tierReason?: string;
  /** Saved automatic baseline: prevents successive launches lowering another tier. */
  baseline?: { tier: Tier; reason: string };
}

export function recommendWorker(input: RecommendationInput, cfg: CoordinatorConfig, usage?: UsageSnapshot, now = Date.now()): WorkerRecommendation {
  if (input.provider !== undefined && input.provider !== "claude" && input.provider !== "codex") throw Error("provider must be claude or codex");
  if (input.tier !== undefined && !["deep", "standard", "light"].includes(input.tier)) throw Error("tier must be deep, standard or light");
  const rubric = rubricTier(input);
  const suggestion = suggestTier(input, cfg.tierRules);
  const base = input.baseline && suggestion.source !== "rule" && (!input.tier || input.tier === input.baseline.tier) && (input.tier || TIER_RANK[input.baseline.tier] >= TIER_RANK[rubric.tier])
    ? { ...suggestion, tier: input.baseline.tier, reason: input.baseline.reason }
    : resolveTier(input, cfg.tierRules, { tier: input.tier, reason: input.tierReason });
  const requiresDeep = rubric.tier === "deep" || base.tier === "deep";
  const tierSelected = !!input.tier;
  let tier = base.tier;
  let provider = input.provider ?? cfg.provider;
  let queued = false;
  const reasons = [base.reason];
  if (base.source === "rule") reasons.push("Settings tier rule preserved");
  else if (tierSelected) reasons.push("Explicit tier selection preserved");
  // A conflicting selection is held for review, never launched below the rubric's deep floor.
  if (rubric.tier === "deep" && tier !== "deep") {
    queued = true;
    reasons.push(`Queued: ${rubric.reason}; selected ${tier} conflicts with the deep floor. Review the tier selection or Settings rule`);
    tier = "deep"; // Recommend the safe floor, but do not execute a conflicting selection.
  }
  if (!cfg.usageRecommendations.enabled) reasons.push("Usage recommendations disabled in Settings");
  else {
    const read = (p: Provider, t: Tier) => capacity(usage?.[p], modelFor(cfg, t, p).model, cfg, now);
    let capacities = { claude: read("claude", tier), codex: read("codex", tier) };
    const bothLow = Object.values(capacities).every((c) => c.known && c.left <= cfg.usageRecommendations.lowRemainingPct);
    if (bothLow && !requiresDeep && !tierSelected && base.source !== "rule" && tier === "standard") {
      tier = "light";
      reasons.push("Both providers low: one tier reduction (standard → light) for work not requiring deep");
      capacities = { claude: read("claude", tier), codex: read("codex", tier) };
    }
    if (!input.provider) {
      const other: Provider = provider === "claude" ? "codex" : "claude";
      const a = capacities[provider], b = capacities[other];
      // Usable wins over stopped, healthy over low; then expiring capacity and capacity/reset hour.
      const rank = (c: Capacity) => c.left > cfg.usageRecommendations.lowRemainingPct ? 2 : c.left > cfg.usageRecommendations.stopRemainingPct ? 1 : 0;
      if (b.known && (!a.known || rank(b) > rank(a) || (rank(b) === rank(a) && (Number(b.soon) > Number(a.soon) || (b.soon === a.soon && b.score > a.score))))) provider = other;
      const chosen = capacities[provider];
      reasons.push(chosen.known ? chosen.soon ? `${provider}: spend available capacity resetting soon` : `${provider}: remaining usage relative to reset time (most constrained window)` : `${provider}: Settings default; no fresh comparable usage`);
    } else reasons.push(`${provider}: explicit provider selection preserved`);
    const chosen = capacities[provider];
    if (chosen.known && (chosen.left <= cfg.usageRecommendations.stopRemainingPct || (requiresDeep && chosen.left <= cfg.usageRecommendations.lowRemainingPct))) {
      queued = true;
      reasons.push(`Queued: ${provider} has ${chosen.left}% remaining; ${requiresDeep ? "deep work keeps its tier and needs more capacity" : "below the stop threshold"}. Wait for a fresh reading with capacity or select a suitable provider`);
    }
    reasons.push(`Claude: ${capacities.claude.reason}. Codex: ${capacities.codex.reason}`);
  }
  return { provider, tier, ...modelFor(cfg, tier, provider), queued, reason: reasons.join(". "), at: now, baseTier: base.tier, baseReason: base.reason, tierSelected, providerSelected: !!input.provider };
}
