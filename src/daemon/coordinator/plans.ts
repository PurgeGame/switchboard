// Delegation plans (D32): the coordinator proposes one plan (objective + tasks + the agent for
// each); the human's single approval grants the root, creates the tasks and lets the daemon launch
// them as they become ready. This file holds the pure parts: validation and ordering.
import { createHash } from "node:crypto";
import type { Task, Tier, UsageSnapshot, WorkerRecommendation } from "../../shared/types.ts";
import { pathScope, within } from "../grants.ts";
import { overlaps } from "../coordination.ts";
import type { CoordinatorConfig } from "./config.ts";
import { recommendWorker } from "./recommendations.ts";
import { modelFor, resolveTier } from "./tiers.ts";

export const MAX_PLAN_TASKS = 8;

export interface PlanTask {
  key: string;
  title: string;
  brief: string;
  acceptance: string[];
  prerequisites: string[];
  provider: "claude" | "codex";
  /** Final tier (Settings rules win over the requested one). */
  tier: Tier;
  requestedTier: Tier;
  recommendation?: WorkerRecommendation;
  tierReason: string;
  /** Set when a Settings rule replaced the coordinator's requested tier. */
  tierOverride: string | null;
  /** Canonical scope paths inside the root. */
  paths: string[];
  /** Resolved at proposal time so the card shows exactly who will do it. */
  model: string;
  effort: string | null;
}

export interface PlanPayload {
  action: "plan";
  title: string;
  root: string;
  resources: string[];
  tasks: PlanTask[];
}

/** One task of an approved plan, as the daemon tracks it. */
export interface PlanTaskState {
  key: string;
  taskId: string;
  provider: "claude" | "codex";
  /** waiting: not launched yet (blocked or queued); launched; failed (gave up); skipped (owned/rejected elsewhere). */
  state: "waiting" | "launched" | "failed" | "skipped";
  sessionId?: string;
  attempts: number;
  error?: string;
  /** What the human approved for this task, as created. A task that no longer matches is never auto-launched. */
  approved?: ApprovedTask;
}

export interface ApprovedTask {
  title: string;
  description: string;
  acceptance: string[];
  paths: string[];
  resources: string[];
  prerequisites: string[];
  tier: Tier;
  provider: "claude" | "codex";
  model: string;
  effort: string | null;
}

export interface PlanRecord {
  proposalId: number;
  objectiveId: string;
  title: string;
  tasks: PlanTaskState[];
  doneNotified?: boolean;
}

const KEY = /^[A-Za-z0-9_-]{1,40}$/;

/** Prerequisites before dependents; throws on a cycle. */
export function planOrder(tasks: { key: string; prerequisites: string[] }[]): string[] {
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const visit = (k: string, path: string[]) => {
    const s = state.get(k);
    if (s === "done") return;
    if (s === "visiting") throw Error(`prerequisites form a cycle: ${[...path, k].join(" → ")}`);
    state.set(k, "visiting");
    for (const p of byKey.get(k)!.prerequisites) visit(p, [...path, k]);
    state.set(k, "done");
    out.push(k);
  };
  for (const t of tasks) visit(t.key, []);
  return out;
}

/**
 * Validate and normalize a propose_plan call. `root` must already be the checked grant root
 * (the caller runs the same root checks as approve-to-grant). Throws with a message for the model.
 */
export function validatePlan(a: any, root: string, cfg: CoordinatorConfig, usage?: UsageSnapshot, now = Date.now()): PlanPayload {
  const title = typeof a.title === "string" ? a.title.trim() : "";
  if (!title) throw Error("a plan needs a title");
  if (a.resources !== undefined && !Array.isArray(a.resources)) throw Error("resources must be a list");
  const raw = a.tasks;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PLAN_TASKS) throw Error(`a plan needs 1-${MAX_PLAN_TASKS} tasks`);
  const keys = new Set<string>();
  const tasks: PlanTask[] = raw.map((t: any, i: number) => {
    const where = `task ${i + 1}${typeof t?.key === "string" ? ` (${t.key})` : ""}`;
    if (!t || typeof t !== "object") throw Error(`${where}: not an object`);
    const key = typeof t.key === "string" ? t.key.trim() : "";
    if (!KEY.test(key)) throw Error(`${where}: key must be 1-40 letters, digits, - or _`);
    if (keys.has(key)) throw Error(`${where}: duplicate key ${key}`);
    keys.add(key);
    const tTitle = typeof t.title === "string" ? t.title.trim() : "";
    const brief = typeof t.brief === "string" ? t.brief.trim() : "";
    if (!tTitle) throw Error(`${where}: title required`);
    if (brief.length < 10) throw Error(`${where}: brief required (what to do, where, constraints)`);
    const acceptance = Array.isArray(t.acceptance) ? [...new Set(t.acceptance.map((x: unknown) => String(x ?? "").trim()).filter(Boolean))] as string[] : [];
    if (!acceptance.length) throw Error(`${where}: at least one acceptance criterion`);
    if (t.prerequisites !== undefined && !Array.isArray(t.prerequisites)) throw Error(`${where}: prerequisites must be a list of keys`);
    const prerequisites = [...new Set(((t.prerequisites ?? []) as unknown[]).map(String))];
    if (t.provider !== undefined && t.provider !== "claude" && t.provider !== "codex") throw Error(`${where}: provider must be claude or codex`);
    if (t.tier !== undefined && !["light", "standard", "deep"].includes(t.tier)) throw Error(`${where}: tier must be light, standard or deep`);
    if (t.paths !== undefined && !Array.isArray(t.paths)) throw Error(`${where}: paths must be a list`);
    const paths = ((t.paths ?? []) as unknown[]).length
      ? [
          ...new Set(
            (t.paths as unknown[]).map((p) => {
              const abs = pathScope(String(p), root);
              if (!within(abs, root)) throw Error(`${where}: path ${String(p)} is outside ${root}`);
              return abs;
            }),
          ),
        ]
      : [root];
    const requestedTier = t.tier as Tier;
    let r;
    try {
      r = resolveTier({ title: tTitle, description: brief, paths }, cfg.tierRules, { tier: requestedTier, reason: t.tierReason });
    } catch (e) {
      throw Error(`${where}: ${(e as Error).message}`);
    }
    const tierOverride = requestedTier && r.source === "rule" && r.tier !== requestedTier ? `asked for ${requestedTier}; ${r.reason}` : null;
    const why = typeof t.tierReason === "string" && t.tierReason.trim() ? t.tierReason.trim() : "";
    const recommendation = recommendWorker({ title: tTitle, description: `${brief}\n${acceptance.join("\n")}`, paths, provider: t.provider, tier: t.tier, tierReason: t.tierReason }, cfg, usage, now);
    const m = recommendation;
    return {
      key,
      title: tTitle.slice(0, 200),
      brief,
      acceptance,
      prerequisites,
      provider: recommendation.provider,
      tier: recommendation.tier,
      requestedTier: requestedTier ?? r.tier,
      recommendation,
      tierReason: r.overridden || r.source === "rule" ? r.reason : why ? `${r.reason}. ${why}` : r.reason,
      tierOverride,
      paths,
      model: m.model,
      effort: m.effort,
    };
  });
  for (const t of tasks)
    for (const p of t.prerequisites) {
      if (!keys.has(p)) throw Error(`task ${t.key}: unknown prerequisite ${p}`);
      if (p === t.key) throw Error(`task ${t.key}: can't depend on itself`);
    }
  planOrder(tasks);
  // Parallel tasks with overlapping scope would block each other's claims (and edit the same files).
  const clash = overlappingTasks(tasks);
  if (clash.length) throw Error(`${clash.join("; ")} can run at the same time but share scope paths: give them disjoint paths, or make one a prerequisite of the other`);
  return { action: "plan", title: title.slice(0, 160), root, resources: (a.resources ?? []).map(String), tasks };
}

/** Pairs of tasks that could run at once (neither depends on the other) but share scope paths. */
export function overlappingTasks(tasks: PlanTask[]): string[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const deps = (k: string, seen = new Set<string>()): Set<string> => {
    for (const p of byKey.get(k)?.prerequisites ?? []) if (!seen.has(p)) (seen.add(p), deps(p, seen));
    return seen;
  };
  const out: string[] = [];
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i],
        b = tasks[j];
      if (deps(a.key).has(b.key) || deps(b.key).has(a.key)) continue;
      if (a.paths.some((p) => b.paths.some((q) => overlaps("path:" + p, "path:" + q)))) out.push(`${a.key} and ${b.key}`);
    }
  return out;
}

/** Stable JSON (sorted keys) of a value: what the digest covers. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** sha256 of the exact plan payload the card renders. Approval must present the digest of what was shown. */
export function planDigest(payload: unknown): string {
  return createHash("sha256").update(stable(payload)).digest("hex");
}

/**
 * Re-resolve each task's tier and model with the current Settings. Anything that would now differ
 * from what the card showed is returned; the approval is refused rather than running something else.
 */
export function planDrift(pl: PlanPayload, cfg: CoordinatorConfig): string[] {
  const out: string[] = [];
  for (const t of pl.tasks) {
    try {
      const r = t.recommendation
        ? recommendWorker({ title: t.title, description: `${t.brief}\n${t.acceptance.join("\n")}`, paths: t.paths, provider: t.provider, tier: t.tier, tierReason: t.tierReason },
            { ...cfg, usageRecommendations: { ...cfg.usageRecommendations, enabled: false } })
        : resolveTier({ title: t.title, description: t.brief, paths: t.paths }, cfg.tierRules, { tier: t.requestedTier, reason: t.tierReason });
      const m = modelFor(cfg, r.tier, t.provider);
      if (r.tier !== t.tier || m.model !== t.model || (m.effort ?? null) !== (t.effort ?? null))
        out.push(`${t.key}: now ${r.tier} ${m.model}${m.effort ? ` ${m.effort}` : ""} (shown ${t.tier} ${t.model}${t.effort ? ` ${t.effort}` : ""})`);
    } catch (e) {
      out.push(`${t.key}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function approvedSnapshot(t: Task, pt: PlanTask): ApprovedTask {
  return {
    title: t.title,
    description: t.description,
    acceptance: [...t.acceptance],
    paths: [...t.scope.paths],
    resources: [...t.scope.resources],
    prerequisites: [...t.prerequisites],
    tier: t.tier,
    provider: pt.provider,
    model: pt.model,
    effort: pt.effort,
  };
}

/** Fields of a plan task that differ from what the human approved (empty: unchanged). */
export function taskDrift(t: Task, a: ApprovedTask | undefined): string[] {
  if (!a) return ["no approved snapshot"];
  const same = (x: unknown, y: unknown) => stable(x) === stable(y);
  const out: string[] = [];
  if (t.title !== a.title) out.push("title");
  if (t.description !== a.description) out.push("brief");
  if (!same(t.acceptance, a.acceptance)) out.push("acceptance");
  if (!same(t.scope.paths, a.paths) || !same(t.scope.resources, a.resources)) out.push("scope");
  if (!same([...t.prerequisites].sort(), [...a.prerequisites].sort())) out.push("prerequisites");
  if (t.tier !== a.tier) out.push("tier");
  return out;
}
