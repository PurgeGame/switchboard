// Tier dispatch: a pure rubric, config rules that override it, and tier -> model mapping.
import type { Tier } from "../../shared/types.ts";
import type { CoordinatorConfig, TierModel, TierRule } from "./config.ts";

export interface TierInput {
  title: string;
  description?: string;
  paths?: string[];
}

export interface TierSuggestion {
  tier: Tier;
  reason: string;
  source: "rubric" | "rule";
}

const DEEP_TEXT: [RegExp, string][] = [
  [/\bsmart[- ]?contracts?\b|\bsolidity\b|\.sol\b|\bon[- ]chain\b/i, "smart contracts"],
  [/\bsecurity\b|\bvulnerab|\bexploit|\baudit\b|\bxss\b|\bcsrf\b|\binjection\b|\bsandbox(ing)? escape/i, "security"],
  [/\bmoney\b|\bfinancial\b|\bfunds?\b|\bpayments?\b|\bwallet|\btreasury\b|\bwithdraw|\bdeposit|\btoken(omics)?\b|\bbilling\b/i, "touches funds"],
  [/\bauth(entication|orization|n|z)?\b|\blogin\b|\bpermissions?\b|\baccess control\b|\bsessions? tokens?\b|\boauth\b|\bpasswords?\b/i, "auth"],
  [/\bcrypto(graph\w*)?\b|\bsignatures?\b|\bencrypt|\bdecrypt|\bhash(ing)?\b|\bnonce\b|\bkeys? (management|derivation)\b|\brng\b|\brandomness\b/i, "cryptography"],
  [/\bgame[- ]theor|\bmechanism design\b|\beconomic|\bincentive|\btokenomics\b/i, "game theory / economics"],
  [/\barchitecture decision|\bmigration\b.*\b(schema|database)\b|\birreversib|\bhard to reverse\b/i, "hard-to-reverse architecture"],
];

const DEEP_PATH: [RegExp, string][] = [
  [/(^|\/)contracts\//i, "path under contracts/"],
  [/\.sol$/i, "Solidity file"],
  [/(^|\/)(auth|security|crypto)([./_-]|$)/i, "security-sensitive path"],
  [/(^|\/)(money|payments?|billing|wallet|funds|treasury)([./_-]|$)/i, "money-sensitive path"],
];

const LIGHT_TEXT =
  /\b(rename|renaming|typo|typos|format(ting)?|lint(ing)?|prettier|grep|scan|list (all|every)|find (all|every|usages)|count|docs? touch[- ]?ups?|readme|comment(s)? only|bump (the )?version|sort imports|mechanical|boilerplate|changelog|spelling)\b/i;

/** Minimal glob: ** = any depth, * = within a segment, ? = one char. Matches anywhere a suffix of the path fits. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.startsWith("/") ? `^${re}$` : `(^|/)${re}$`);
}

/** Does any path fall under the glob? A glob "contracts/**" also matches the dir "contracts" itself. */
export function pathsMatch(glob: string, paths: string[]): boolean {
  const re = globToRegex(glob);
  const bare = glob.replace(/\/\*\*$/, "");
  return paths.some((p) => re.test(p) || re.test(p + "/") || p === bare || p.endsWith("/" + bare));
}

/** The rubric alone (pure). */
export function rubricTier(t: TierInput): TierSuggestion {
  const text = `${t.title}\n${t.description ?? ""}`;
  const paths = t.paths ?? [];
  const reasons: string[] = [];
  for (const [re, why] of DEEP_TEXT) if (re.test(text)) reasons.push(why);
  for (const [re, why] of DEEP_PATH) if (paths.some((p) => re.test(p))) reasons.push(why);
  if (reasons.length) return { tier: "deep", reason: `Deep: ${[...new Set(reasons)].join(", ")}`, source: "rubric" };
  const m = text.match(LIGHT_TEXT);
  if (m) return { tier: "light", reason: `Light: mechanical work ("${m[0].toLowerCase()}")`, source: "rubric" };
  return { tier: "standard", reason: "Standard: routine feature/refactor/test work", source: "rubric" };
}

/** Config rules first (first match wins), then the rubric. */
export function suggestTier(t: TierInput, rules: TierRule[] = []): TierSuggestion {
  const text = `${t.title}\n${t.description ?? ""}`;
  for (const r of rules) {
    const byGlob = r.glob ? pathsMatch(r.glob, t.paths ?? []) : null;
    let byText: boolean | null = null;
    if (r.match) {
      try {
        byText = new RegExp(r.match, "i").test(text);
      } catch {
        byText = false;
      }
    }
    if (byGlob === null && byText === null) continue;
    if (byGlob !== false && byText !== false)
      return { tier: r.tier, reason: `Rule${r.glob ? ` ${r.glob}` : ""}${r.match ? ` /${r.match}/` : ""} → ${r.tier}${r.reason ? `: ${r.reason}` : ""}`, source: "rule" };
  }
  return rubricTier(t);
}

/**
 * Final tier for a task. A rule always wins; otherwise the coordinator may override the rubric
 * but must give a reason.
 */
export function resolveTier(t: TierInput, rules: TierRule[], requested?: { tier?: Tier; reason?: string }): TierSuggestion & { overridden: boolean } {
  const s = suggestTier(t, rules);
  if (s.source === "rule" || !requested?.tier || requested.tier === s.tier) return { ...s, overridden: false };
  if (!requested.reason?.trim()) throw new Error(`tier override to ${requested.tier} needs a tierReason (rubric suggests ${s.tier}: ${s.reason})`);
  return { tier: requested.tier, reason: `Coordinator override (${s.tier} → ${requested.tier}): ${requested.reason.trim()}`, source: "rubric", overridden: true };
}

export function modelFor(cfg: CoordinatorConfig, tier: Tier, provider: "claude" | "codex"): TierModel {
  return cfg.tiers[tier][provider];
}

export const TIER_RANK: Record<Tier, number> = { light: 0, standard: 1, deep: 2 };
