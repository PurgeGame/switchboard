import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recommendWorker } from "../src/daemon/coordinator/recommendations.ts";
import { mergeCoordinatorConfig, validateUsageRecommendationSettings } from "../src/daemon/coordinator/config.ts";
import { CoordinatorAgent, type CoordinatorDeps, type LaunchSpec } from "../src/daemon/coordinator/agent.ts";
import { Store } from "../src/daemon/db.ts";
import { Coordination } from "../src/daemon/coordination.ts";
import { blankSession } from "../src/daemon/state.ts";
import { startHttp } from "../src/daemon/http.ts";
import type { ProviderUsage, Session, UsageSnapshot, UsageWindow } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const MIN = 60_000;
const window = (left: number, minutes: number, label = "5h"): UsageWindow => ({ label, remainingPct: left, usedPct: 100 - left, resetsAt: NOW + minutes * MIN });
const reading = (left: number, minutes = 300, extra: Partial<ProviderUsage> = {}): ProviderUsage => ({ available: true, source: "fixture", asOf: NOW, windows: [window(left, minutes)], ...extra });
const snapshot = (claude = reading(80), codex = reading(50)): UsageSnapshot => ({ ts: NOW, claude, codex });
const cfg = mergeCoordinatorConfig({});
const normal = { title: "Add pagination" };
const recommend = (usage?: UsageSnapshot, task = normal, settings = cfg) => recommendWorker(task, settings, usage, NOW);

describe("usage recommendation rules", () => {
  test("favors more remaining usage, then remaining capacity per reset hour", () => {
    expect(recommend(snapshot()).provider).toBe("claude");
    expect(recommend(snapshot(reading(80, 1200), reading(50, 120))).provider).toBe("codex");
    expect(recommend(snapshot(reading(50), reading(50))).provider).toBe(cfg.provider);
  });
  test("spends a healthy window resetting soon, but not at the expense of a low longer window", () => {
    const soon = reading(60, 6000, { windows: [window(60, 30), window(80, 6000, "7d")] });
    const r = recommend(snapshot(soon, reading(90, 120)));
    expect(r.provider).toBe("claude");
    expect(r.reason).toContain("resetting soon");
    soon.windows[1] = window(10, 6000, "7d");
    expect(recommend(snapshot(soon, reading(90, 120))).provider).toBe("codex");
  });
  test("uses every applicable window and ignores other models' windows", () => {
    const claude = reading(90, 300, { windows: [window(90, 300), window(1, 1000, "7d opus"), window(70, 300, "7d sonnet")] });
    expect(recommend(snapshot(claude, reading(40))).provider).toBe("claude");
    expect(recommend(snapshot(claude, reading(40)), { title: "Security review" }).provider).toBe("codex");
  });
  test("both low allow exactly one tier reduction; light has no further reduction", () => {
    const usage = snapshot(reading(20), reading(15));
    const r = recommend(usage);
    expect(r).toMatchObject({ tier: "light", baseTier: "standard", queued: false });
    expect(r.reason).toContain("one tier reduction");
    expect(recommendWorker({ ...normal, baseline: { tier: r.baseTier, reason: r.baseReason } }, cfg, usage, NOW).tier).toBe("light");
    expect(recommend(usage, { title: "Fix typos" }).tier).toBe("light");
    expect(recommend(snapshot(reading(20.1), reading(15))).tier).toBe("standard");
  });
  test.each(["Security review", "Harden authentication", "Move money", "Fix billing", "Smart contract review", "Cryptography", "Architecture decision"])("%s stays deep and queues when both low", (title) => {
    const r = recommend(snapshot(reading(10), reading(15)), { title });
    expect(r).toMatchObject({ tier: "deep", queued: true });
    expect(r.reason).toContain("deep work keeps its tier");
    expect(recommend(snapshot(reading(10), reading(80)), { title })).toMatchObject({ tier: "deep", provider: "codex", queued: false });
  });
  test("sensitive paths enforce deep even for a mechanical title", () => {
    for (const path of ["src/auth.ts", "src/security/check.ts", "src/payments/ledger.ts", "contracts/Game.sol"])
      expect(recommendWorker({ title: "Rename helper", paths: [path] }, cfg, snapshot(reading(10), reading(15)), NOW)).toMatchObject({ tier: "deep", queued: true });
  });
  test("explicit provider/tier and Settings models/effort/rules retain precedence", () => {
    const custom = mergeCoordinatorConfig({ tiers: { standard: { claude: { model: "chosen-sonnet", effort: "high" } } }, tierRules: [{ match: "pagination", tier: "standard" }] });
    const r = recommendWorker({ ...normal, provider: "claude", tier: "light", tierReason: "cheap" }, custom, snapshot(reading(10), reading(15)), NOW);
    expect(r).toMatchObject({ provider: "claude", tier: "standard", model: "chosen-sonnet", effort: "high" });
    expect(r.reason).toContain("Settings tier rule preserved");
    expect(recommendWorker({ ...normal, tier: "standard" }, cfg, snapshot(reading(10), reading(15)), NOW).tier).toBe("standard");
  });
  test("a lower selection conflicting with deep is queued for review, never launched", () => {
    expect(recommendWorker({ title: "Security fix", tier: "light", tierReason: "explicit choice" }, cfg, snapshot(), NOW).queued).toBe(true);
    const settings = mergeCoordinatorConfig({ tierRules: [{ match: "Security", tier: "light" }] });
    expect(recommend(snapshot(), { title: "Security fix" }, settings).reason).toContain("conflicts with the deep floor");
  });
  test("stop threshold queues ordinary work and explicit providers aren't silently switched", () => {
    expect(recommend(snapshot(reading(5), reading(3))).queued).toBe(true);
    expect(recommendWorker({ ...normal, provider: "claude" }, cfg, snapshot(reading(0), reading(90)), NOW)).toMatchObject({ provider: "claude", queued: true });
  });
  test("a stopped window resetting soon cannot outrank usable low capacity", () => {
    expect(recommend(snapshot(reading(1, 1), reading(15, 300)))).toMatchObject({ provider: "codex", tier: "light", queued: false });
  });
  test("unknown readings cannot trigger a reduction; missing monitor keeps the baseline", () => {
    expect(recommend()).toMatchObject({ provider: cfg.provider, tier: "standard", queued: false });
    expect(recommend().reason).toContain("no fresh comparable usage");
    expect(recommend(undefined, { title: "Security review" }).tier).toBe("deep");
    expect(recommend(snapshot(reading(10), reading(0, 300, { available: false }))).tier).toBe("standard");
  });
  const untrusted: [string, Partial<ProviderUsage>][] = [
    ["age", { asOf: NOW - 16 * MIN }], ["missing time", { asOf: null }], ["future time", { asOf: NOW + MIN }],
    ["refresh failed", { note: "HTTP 429 (retained reading)" }], ["stale flag", { stale: true } as Partial<ProviderUsage>],
    ["refresh error metadata", { error: "HTTP 429", stale: false }],
    ["empty windows", { windows: [] }], ["unconfirmed reset", { windows: [{ ...window(100, 300), reset: true } as UsageWindow & { reset: boolean }] }],
    ["expired reset", { windows: [window(100, -1)] }], ["unknown reset", { windows: [{ ...window(10, 300), resetsAt: null }] }],
    ["invalid number", { windows: [window(NaN, 300)] }],
  ];
  test.each(untrusted)("%s is labeled and excluded from reductions and fresh capacity", (_name, extra) => {
    const usage = snapshot(reading(10), reading(10, 300, extra));
    const r = recommend(usage);
    expect(r.tier).toBe("standard");
    expect(r.reason).toMatch(/Codex: usage (unavailable|stale|unconfirmed)/);
    expect(recommend(usage, { title: "Security review" }).tier).toBe("deep");
  });
  test("thresholds change decisions and disabled recommendations preserve baseline", () => {
    expect(recommend(snapshot(reading(30), reading(25)), normal, mergeCoordinatorConfig({ usageRecommendations: { lowRemainingPct: 30 } })).tier).toBe("light");
    expect(recommend(snapshot(reading(10), reading(15)), normal, mergeCoordinatorConfig({ usageRecommendations: { enabled: false } })).tier).toBe("standard");
    expect(recommend(snapshot(reading(0), reading(0)), { title: "Security review" }, mergeCoordinatorConfig({ usageRecommendations: { enabled: false } })).tier).toBe("deep");
    expect(recommend(snapshot(reading(10, 300, { asOf: NOW - 16 * MIN }), reading(10)), normal, mergeCoordinatorConfig({ usageRecommendations: { maxAgeMinutes: 20 } })).tier).toBe("light");
  });
  test("invalid thresholds are refused", () => {
    for (const v of [{ lowRemainingPct: 0 }, { stopRemainingPct: 20 }, { stopRemainingPct: -1 }, { maxAgeMinutes: 0 }, { resetSoonMinutes: NaN }, { enabled: 1 }])
      expect(() => validateUsageRecommendationSettings({ ...cfg.usageRecommendations, ...v })).toThrow();
  });
});

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
function fixture(config: any = {}) {
  const root = mkdtempSync(join(tmpdir(), "sb-recommend-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store("", ":memory:");
  cleanup.push(() => store.db.close());
  const c = new Coordination(store), sessions = new Map<string, Session>(), launches: LaunchSpec[] = [];
  let usage = snapshot();
  const deps: CoordinatorDeps = { db: store.db, coordination: c, cfg: mergeCoordinatorConfig(config), sessions: () => sessions, events: () => [], send: async () => ({ ok: true }), escalate: () => {}, push: () => {}, timers: false, now: () => NOW, usage: () => usage,
    createWorktree: async (_repo, slug) => { const dir = join(root, "wt", slug); mkdirSync(dir, { recursive: true }); return dir; },
    launch: async (spec) => { launches.push(spec); const id = `w${launches.length}`; sessions.set(id, { ...blankSession(id, spec.provider, "tui", id), cwd: spec.cwd, execution: "working" }); return id; } };
  const agent = new CoordinatorAgent(deps);
  agent.setMode("active");
  c.onChange = () => agent.onCoordinationChange();
  const o = c.createObjective("Feature", "", undefined, "human");
  c.grantObjective(o.id, { root }, "human");
  const create = async (extra: any = {}) => {
    const r: any = await agent.callTool("create_task", { objectiveId: o.id, title: "Add pagination", scope: { paths: ["src/list.ts"] }, acceptance: ["works"], reason: "requested", ...extra });
    expect(r.ok).toBe(true); return r.result;
  };
  const launch = (id: string, extra: any = {}): Promise<any> => agent.callTool("launch_session", { taskId: id, repo: root, reason: "ready", ...extra });
  const propose = async (extra: any = {}) => {
    const r: any = await agent.callTool("propose_plan", { title: "Implement list", root, reason: "requested", tasks: [{ key: "list", title: "Add pagination", brief: "Implement a paginated list.", acceptance: ["works"], paths: ["src/list.ts"], ...extra }] });
    expect(r.ok).toBe(true); return r.result.proposal;
  };
  return { root, store, c, agent, deps, launches, sessions, create, launch, propose, setUsage: (next: UsageSnapshot) => { usage = next; } };
}

describe("tool integration and persistence", () => {
  test("create_task records choice; launch re-evaluates and can recover the baseline", async () => {
    const x = fixture(); x.setUsage(snapshot(reading(10), reading(15)));
    const t = await x.create({ decisionDepends: true });
    expect(t).toMatchObject({ tier: "light", needsVerification: true, recommendation: { provider: "codex" } });
    x.setUsage(snapshot(reading(80), reading(30)));
    const l = await x.launch(t.id);
    expect(l.ok).toBe(true);
    expect(x.launches[0]).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(x.c.task(t.id)?.tier).toBe("standard");
  });
  test("sensitive acceptance/launch instructions require deep; no override via cheap launch", async () => {
    const x = fixture(); x.setUsage(snapshot(reading(10), reading(15)));
    const t = await x.create({ acceptance: ["Authentication stays safe"] });
    expect(t.tier).toBe("deep");
    expect((await x.launch(t.id, { tier: "light", tierReason: "save capacity" })).error).toContain("deep floor");
    expect(x.launches).toHaveLength(0);
    expect(x.c.task(t.id)?.tier).toBe("deep");
  });
  test("deep queues without a reservation or retry use and launches with fresh capacity", async () => {
    const x = fixture(); x.setUsage(snapshot(reading(10), reading(15)));
    const t = await x.create({ title: "Security review" });
    for (let i = 0; i < 3; i++) expect((await x.launch(t.id)).error).toContain("waiting:");
    expect(x.c.reservation(t.id)).toBeNull();
    expect(x.c.task(t.id)?.tier).toBe("deep");
    x.setUsage(snapshot(reading(80), reading(15)));
    expect((await x.launch(t.id)).ok).toBe(true);
    expect(x.launches[0]).toMatchObject({ provider: "claude", model: "opus", effort: "xhigh" });
  });
  test("explicit selections and subsequent human edits remain pinned", async () => {
    const x = fixture(); x.setUsage(snapshot(reading(10), reading(15)));
    const t = await x.create({ provider: "claude", tier: "standard" });
    x.c.updateTask(t.id, { tier: "deep", tierReason: "Human wants careful work" }, "human");
    const restored = new CoordinatorAgent({ ...x.deps });
    const r: any = await restored.callTool("launch_session", { taskId: t.id, repo: x.root, reason: "ready" });
    expect(r.ok).toBe(false);
    expect(x.c.task(t.id)?.tier).toBe("deep");
    expect(x.c.task(t.id)?.recommendation?.provider).toBe("claude");
  });
  test("human tier selections without a reason stay pinned after recreation", async () => {
    const x = fixture();
    const original = await x.create();
    const t = x.c.updateTask(original.id, { tier: "deep", tierReason: null }, "human");
    const restored = new CoordinatorAgent({ ...x.deps });
    const r: any = await restored.callTool("launch_session", { taskId: t.id, repo: x.root, tier: "light", tierReason: "usage", reason: "ready" });
    expect(r.error).toContain("Explicit tier selection preserved");
    expect(x.c.task(t.id)?.tier).toBe("deep");
    expect(x.launches).toHaveLength(0);
  });
  test("plans show automatic lowered tier; approval pins the exact provider/model/effort", async () => {
    const x = fixture(); x.setUsage(snapshot(reading(15), reading(10)));
    const p = await x.propose();
    expect(p.payload.tasks[0]).toMatchObject({ tier: "light", provider: "claude", recommendation: { baseTier: "standard" } });
    x.setUsage(snapshot(reading(50), reading(90)));
    expect((await x.agent.approve(p.id, { digest: p.digest })).state).toBe("approved");
    await x.agent.settled();
    expect(x.launches[0]).toMatchObject({ provider: "claude", model: p.payload.tasks[0].model, effort: p.payload.tasks[0].effort });
    expect(x.c.snapshot().tasks[0].tier).toBe("light");
  });
  test("approved deep plans wait repeatedly without using retries or rewriting approval", async () => {
    const x = fixture();
    const p = await x.propose({ title: "Security review" });
    x.setUsage(snapshot(reading(10), reading(15)));
    await x.agent.approve(p.id, { digest: p.digest });
    for (let i = 0; i < 4; i++) await x.agent.pumpPlans();
    const waiting = x.agent.plansSnapshot()[0].tasks[0];
    expect(waiting).toMatchObject({ state: "waiting", attempts: 0, approved: { tier: "deep", provider: "claude" } });
    expect(waiting.error).toContain("deep work keeps its tier");
    expect(x.launches).toHaveLength(0);
    x.setUsage(snapshot(reading(80), reading(90)));
    await x.agent.pumpPlans();
    expect(x.launches[0].provider).toBe("claude");
  });
  test("coordinator launch arguments cannot replace an existing explicit selection", async () => {
    const x = fixture();
    const t = await x.create({ provider: "claude", tier: "standard" });
    expect((await x.launch(t.id, { provider: "codex" })).error).toContain("Explicit provider selection preserved");
    expect((await x.launch(t.id, { tier: "light", tierReason: "cheap" })).error).toContain("Explicit tier selection preserved");
    expect(x.launches).toHaveLength(0);
    expect(x.c.task(t.id)?.tier).toBe("standard");
  });
  test("sensitive work with a conflicting Settings rule stays deep and waits repeatedly", async () => {
    const x = fixture({ tierRules: [{ match: "Security", tier: "light" }] });
    const p = await x.propose({ title: "Security review" });
    expect(p.payload.tasks[0]).toMatchObject({ tier: "deep", recommendation: { queued: true } });
    expect((await x.agent.approve(p.id, { digest: p.digest })).state).toBe("approved");
    for (let i = 0; i < 3; i++) await x.agent.pumpPlans();
    expect(x.launches).toHaveLength(0);
    expect(x.agent.plansSnapshot()[0].tasks[0]).toMatchObject({ state: "waiting", attempts: 0 });
    expect(x.c.snapshot().tasks[0].tier).toBe("deep");
  });
  test("a conflicting explicit lower tier is retained as a hold, not silently replaced", async () => {
    const x = fixture();
    const p = await x.propose({ title: "Security review", tier: "light", tierReason: "explicit selection" });
    await x.agent.approve(p.id, { digest: p.digest });
    for (let i = 0; i < 3; i++) await x.agent.pumpPlans();
    expect(x.launches).toHaveLength(0);
    expect(x.agent.plansSnapshot()[0].tasks[0]).toMatchObject({ state: "waiting", attempts: 0 });
    expect(x.c.snapshot().tasks[0].tier).toBe("deep");
  });
  test("updated sensitive work is reevaluated before an automatic launch", async () => {
    const x = fixture();
    const t = await x.create();
    expect((await x.launch(t.id, { prompt: "Review authentication middleware" })).ok).toBe(true);
    expect(x.c.task(t.id)?.tier).toBe("deep");
    expect(x.launches[0].model).toBe("opus");
  });
  test("held launch card pins the displayed choice", async () => {
    const x = fixture();
    const t = await x.create();
    const r = await x.launch(t.id, { worktree: false });
    expect(r.result.proposal.payload.recommendation.provider).toBe("claude");
    x.setUsage(snapshot(reading(50), reading(90)));
    await x.agent.approve(r.result.proposal.id);
    expect(x.launches[0].provider).toBe("claude");
  });
  test("live Settings thresholds persist across coordinator recreation", () => {
    const x = fixture();
    const settings = { ...cfg.usageRecommendations, lowRemainingPct: 30, maxAgeMinutes: 7 };
    x.agent.setUsageRecommendationSettings(settings);
    const restored = new CoordinatorAgent({ ...x.deps, cfg: mergeCoordinatorConfig({}) });
    expect(restored.usageRecommendationSettings()).toEqual(settings);
  });
  test("Settings HTTP writes require the browser and validate before persisting", async () => {
    const x = fixture();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!; probe.stop(true);
    const token = "test-root", coordinatorToken = "test-coordinator";
    const { server } = startHttp({ port, token, coordinatorToken, store: x.store, coordination: x.c, coordinator: x.agent, registry: { sessions: x.sessions, onPush: () => {} }, webDist: x.root, system: () => null } as any);
    cleanup.push(() => server.stop(true));
    const base = `http://127.0.0.1:${port}`;
    const path = `${base}/api/coordinator/usage-recommendations`;
    const value = { ...cfg.usageRecommendations, lowRemainingPct: 35 };
    const post = (headers: Record<string, string>, body: unknown = value) => fetch(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${coordinatorToken}` })).status).toBe(403);
    const login: any = await (await fetch(`${base}/api/login-code`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json();
    const auth = await fetch(login.url, { redirect: "manual" });
    const cookie = auth.headers.get("set-cookie")!.split(";")[0];
    expect((await post({ cookie }, { ...value, stopRemainingPct: 50 })).status).toBe(409);
    expect(await (await post({ cookie })).json()).toEqual(value);
    expect(await (await fetch(path, { headers: { cookie } })).json()).toEqual(value);
  });
});
