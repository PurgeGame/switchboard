// The coordinator agent, daemon side: mode, authority, the MCP tool implementations, the
// enforcement rules, wake digests, proposals and the activity log. Everything durable is in
// SQLite; the LLM process (runtime.ts) is disposable and gets a state digest when it restarts.
import { worktreeSlug } from "./worktree.ts";
import { contextPct } from "../../shared/models.ts";
import type { Database } from "bun:sqlite";
import { isAbsolute, relative, resolve } from "node:path";
import type { PerspectiveGroup, DispatchContext,
  Objective,
  CoordinatorActivity,
  CoordinatorChatEntry,
  CoordinatorMode,
  CoordinatorProposal,
  CoordinatorState,
  SbEvent,
  Session,
  Task,
  Tier,
} from "../../shared/types.ts";
import type { Coordination } from "../coordination.ts";
import type { CoordinatorConfig } from "./config.ts";
import {
  Budget,
  PREFIX,
  READ_ONLY_TOOLS,
  RepeatDetector,
  RetryLimiter,
  SCREEN_LABEL,
  checkSend,
  screenDestructive,
  withPrefix,
  type SentRecord,
} from "./policy.ts";
import { modelFor, resolveTier } from "./tiers.ts";
import { PROMPT_FILE, type RuntimeLike } from "./runtime.ts";
import { EXTERNAL_TOOLS, EXTERNAL_TOOL_NAMES, TOOLS, TOOL_NAMES } from "./tools.ts";
import { readFileSync } from "node:fs";
import { approvedSnapshot, planDigest, planDrift, planOrder, taskDrift, validatePlan, type PlanPayload, type PlanRecord } from "./plans.ts";
import { AUTO_TEMPLATE } from "../autocontinue.ts";
import { canonical, dirIdentity, resourceKey, verifyDir, within } from "../grants.ts";

/** The governor (src/daemon/governor.ts), coded against its interface. */
export interface GovernorLike {
  setPriority?(sessionId: string, p: "protected" | "high" | "normal" | "low"): unknown;
  throttle?(sessionId: string, level: 1 | 2, reason: string): unknown;
  restore?(sessionId: string, reason?: string): unknown;
  snapshot?(): unknown;
}

export interface LaunchSpec {
  provider: "claude" | "codex";
  cwd: string;
  name: string;
  model: string;
  effort: string | null;
  prompt: string;
  /** The task this launch is reserved for: the brief is delivered under that reservation. */
  taskId: string;
}

export interface CoordinatorDeps {
  db: Database;
  coordination: Coordination;
  cfg: CoordinatorConfig;
  sessions: () => Map<string, Session>;
  events: (sessionId: string, limit: number) => SbEvent[];
  /** Deliver a message with author "coordinator", carrying the authority checked for it. */
  send: (sessionId: string, text: string, ctx: DispatchContext) => Promise<{ ok: boolean; error?: string }>;
  launch?: (spec: LaunchSpec) => Promise<string>;
  /** Daemon git operation: create a worktree, return its path. */
  /** `repoId`: the granted directory's identity; creation refuses if `repo` no longer names it. */
  createWorktree?: (repo: string, slug: string, repoId?: string) => Promise<string>;
  escalate: (sessionId: string | null, title: string, text: string) => void;
  /**
   * Deliver the user's own chat message (verbatim, with its images) to a session the coordinator
   * picked. The words are the human's; the coordinator only chooses the destination.
   */
  route?: (sessionId: string, text: string, images: string[], chatId: number) => Promise<{ ok: boolean; error?: string }>;
  /** A perspective group (answers and synthesis), for the coordinator to summarize. */
  group?: (id: string) => PerspectiveGroup | null | undefined;
  /** Fan one prompt out to several new sessions (Claude and/or Codex) and compare their answers. */
  askSeveral?: (prompt: string, cwd: string, members: { provider: "claude" | "codex"; model?: string }[]) => Promise<{ id: string }>;
  /** Context maintenance: type /compact [focus] or /clear into a Claude session, or compact a Codex thread natively. */
  maintain?: (sessionId: string, command: "compact" | "clear", focus: string | null, ctx: DispatchContext) => Promise<{ ok: boolean; error?: string }>;
  governor?: GovernorLike | null;
  push: (s: CoordinatorState) => void;
  runtime?: RuntimeLike;
  now?: () => number;
  /** Disable timers in tests. */
  timers?: boolean;
}

type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };
interface WakeEvent {
  at: number;
  kind: string;
  sessionId: string | null;
  text: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "task";
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * What the coordinator may see of an objective: a human-declared check shows only its criterion
 * and kind. Expected values, hashes and check paths are the human's oracle; if the coordinator saw
 * them it could coach a worker to produce exactly that (H2). Human routes keep the full grant.
 */
export function coordinatorObjective(o: Objective): Objective {
  if (!o.grant) return o;
  return { ...o, grant: { ...o.grant, verification: o.grant.verification.map(({ criterion, kind }) => ({ criterion, kind }) as any) } };
}
export function coordinatorTask(t: Task): Task {
  return { ...t, verifiedEvidence: (t.verifiedEvidence ?? []).map(({ observedText: _o, ...e }) => e) };
}

/**
 * May the daemon's tool-free judge decide this session's permission prompts (D29)? Only with the
 * built-in coordinator switched on. No coordinator (null) or an external one: every prompt goes to
 * the user, and the daemon makes no model call for it (D34).
 */
export const permissionJudgeGate = (coord: CoordinatorAgent | null) => (sessionId: string) => !!coord && coord.mayJudgePermissions(sessionId);

/** Appended to the coordinator prompt for an external agent: nothing wakes it, and how to talk to the user. */
const EXTERNAL_ADDENDUM = `

## You are connected as an external agent
You run in the user's own agent, not as Switchboard's built-in process, so nothing wakes you.
- Call \`get_updates\` in a loop (pass \`waitSeconds\`, up to 50, to wait for the next event). It returns the events and the user's chat messages since your last call, once, plus a state line. "restarted: true" means Switchboard restarted: call \`get_state\` / \`list_sessions\` before acting.
- The user sees what you do through Switchboard's UI, not your own replies: answer their chat messages with \`tell_user\`, and route work with \`route_to_session\` and the chat id.
- Every rule above is enforced by the daemon exactly as for the built-in coordinator (mode, authority, approvals, holds, limits). If you have other tools (a shell, files), they are outside Switchboard's rules: don't use them to do what these tools refuse.`;

export class CoordinatorAgent {
  mode: CoordinatorMode = "manual";
  /** Who the brain is (D34). External: no runtime ever; the agent polls with get_updates. */
  readonly kind: "builtin" | "external";
  /** Last tool call through the MCP endpoints (any outcome): shows whether an external agent is connected. */
  private lastToolCallAt: number | null = null;
  /** get_updates calls waiting for the next event. */
  private waiters = new Set<() => void>();
  readonly budget: Budget;
  private excluded = new Set<string>();
  private autopilot = new Set<string>();
  private launched = new Map<string, { sessionId: string; objectiveId: string | null; taskId: string | null; tier: Tier; at: number }>();
  private sent: SentRecord[] = [];
  private hops = new Map<string, number>();
  private humanHold = new Map<string, number>();
  /** Tasks the user just edited: the coordinator's (possibly stale) task updates wait out the hold. */
  private taskHold = new Map<string, number>();
  private myClaims = new Set<number>();
  private retries: RetryLimiter;
  private repeats: RepeatDetector;
  private restarts = new RetryLimiter(3);
  private pending: (WakeEvent & { passive?: boolean })[] = [];
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextWakeAt: number | null = null;
  private wakeHop = 0;
  private fresh = true;
  private queuedTurns: { body: string; origin: "user" | "event"; images: string[] }[] = [];
  /** Who started the turn now running: only replies to the user's own messages go to the chat. */
  private turnOrigin: "user" | "event" = "event";
  /** Text the coordinator just routed into a session, so its arrival isn't mistaken for the user typing there. */
  private routedEcho = new Map<string, string>();
  private taskStatus = new Map<string, string>();
  private budgetFlagged = false;
  /** Approved delegation plans (D32): the daemon launches their tasks as they become ready. */
  private plans: PlanRecord[] = [];
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private readonly startedAt: number;
  private now: () => number;
  runtime: RuntimeLike | null;

  constructor(private d: CoordinatorDeps) {
    this.now = d.now ?? Date.now;
    d.coordination.session = (id) => d.sessions().get(id);
    this.startedAt = this.now();
    this.budget = new Budget(d.cfg.limits.dailyBudgetUsd, () => new Date(this.now()).toISOString().slice(0, 10));
    this.retries = new RetryLimiter(d.cfg.limits.maxRetries);
    this.repeats = new RepeatDetector(d.cfg.limits.repeatThreshold, d.cfg.limits.runawayThreshold);
    const db = d.db;
    db.run("CREATE TABLE IF NOT EXISTS coord_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS coord_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS coord_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS coord_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)");
    this.load();
    for (const t of d.coordination.snapshot().tasks) this.taskStatus.set(t.id, t.status);
    this.kind = d.cfg.agent === "external" ? "external" : "builtin";
    if (this.kind === "external" && d.runtime) throw new Error("an external coordinator has no runtime: the daemon never starts a model for it");
    this.runtime = d.runtime ?? null;
    if (this.runtime) this.wireRuntime(this.runtime);
    if (d.timers !== false) setInterval(() => this.heartbeat(), d.cfg.heartbeatMs).unref?.();
  }

  // ---------------------------------------------------------------- persistence
  private kv<T>(key: string, fallback: T): T {
    const r = this.d.db.query("SELECT value FROM coord_kv WHERE key = ?").get(key) as { value: string } | null;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  private setKv(key: string, v: unknown) {
    this.d.db
      .query("INSERT INTO coord_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(v));
  }
  private load() {
    this.mode = this.kv<CoordinatorMode>("mode", "manual");
    this.excluded = new Set(this.kv<string[]>("excluded", []));
    this.autopilot = new Set(this.kv<string[]>("autopilot", []));
    for (const l of this.kv<any[]>("launched", [])) this.launched.set(l.sessionId, l);
    this.sent = this.kv<SentRecord[]>("sent", []);
    this.myClaims = new Set(this.kv<number[]>("claims", []));
    this.humanHold = new Map(this.kv<[string, number][]>("humanHold", []));
    this.taskHold = new Map(this.kv<[string, number][]>("taskHold", []));
    this.budget.restore(this.kv("budget", {}));
    this.plans = this.kv<PlanRecord[]>("plans", []);
  }
  private persist() {
    this.setKv("mode", this.mode);
    this.setKv("excluded", [...this.excluded]);
    this.setKv("autopilot", [...this.autopilot]);
    this.setKv("launched", [...this.launched.values()]);
    this.setKv("sent", this.sent.filter((s) => this.now() - s.at < 24 * 3600_000).slice(-500));
    this.setKv("claims", [...this.myClaims]);
    this.setKv("humanHold", [...this.humanHold]);
    this.setKv("taskHold", [...this.taskHold].filter(([, at]) => this.now() - at < this.d.cfg.limits.humanHoldMs));
    this.setKv("budget", this.budget.toJSON());
    this.setKv("plans", this.plans);
  }

  log(
    action: string,
    outcome: CoordinatorActivity["outcome"],
    detail: string,
    x: { sessionId?: string | null; taskId?: string | null; reason?: string | null } = {},
  ): CoordinatorActivity {
    const a: Omit<CoordinatorActivity, "id"> = {
      at: this.now(),
      action,
      sessionId: x.sessionId ?? null,
      taskId: x.taskId ?? null,
      reason: x.reason ?? null,
      outcome,
      detail: clip(detail, 2000),
    };
    const r = this.d.db.query("INSERT INTO coord_activity (data) VALUES (?) RETURNING id").get(JSON.stringify(a)) as { id: number };
    this.changed();
    return { id: r.id, ...a };
  }
  activity(limit = 200): CoordinatorActivity[] {
    return (
      this.d.db.query("SELECT id, data FROM coord_activity ORDER BY id DESC LIMIT ?").all(limit) as { id: number; data: string }[]
    ).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
  }
  proposals(limit = 100): CoordinatorProposal[] {
    return (
      this.d.db.query("SELECT id, data FROM coord_proposals ORDER BY id DESC LIMIT ?").all(limit) as { id: number; data: string }[]
    ).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  }
  proposal(id: number): CoordinatorProposal | null {
    const r = this.d.db.query("SELECT id, data FROM coord_proposals WHERE id = ?").get(id) as { id: number; data: string } | null;
    return r ? { ...JSON.parse(r.data), id: r.id } : null;
  }
  private saveProposal(p: Omit<CoordinatorProposal, "id"> & { id?: number }): CoordinatorProposal {
    if (p.id) {
      this.d.db.query("UPDATE coord_proposals SET data = ? WHERE id = ?").run(JSON.stringify(p), p.id);
      this.changed();
      return p as CoordinatorProposal;
    }
    const r = this.d.db.query("INSERT INTO coord_proposals (data) VALUES (?) RETURNING id").get(JSON.stringify(p)) as { id: number };
    this.changed();
    return { ...p, id: r.id };
  }
  chat(limit = 200): CoordinatorChatEntry[] {
    return (this.d.db.query("SELECT id, data FROM coord_chat ORDER BY id DESC LIMIT ?").all(limit) as { id: number; data: string }[])
      .map((r) => ({ id: r.id, ...JSON.parse(r.data) }))
      .reverse();
  }
  private addChat(role: CoordinatorChatEntry["role"], text: string, images: string[] = []): number {
    const entry = { at: this.now(), role, text: clip(text, 8000), ...(images.length ? { images } : {}) };
    const r = this.d.db.query("INSERT INTO coord_chat (data) VALUES (?) RETURNING id").get(JSON.stringify(entry)) as { id: number };
    this.changed();
    return r.id;
  }
  private chatEntry(id: number): CoordinatorChatEntry | null {
    const r = this.d.db.query("SELECT id, data FROM coord_chat WHERE id = ?").get(id) as { id: number; data: string } | null;
    return r ? { id: r.id, ...JSON.parse(r.data) } : null;
  }

  /**
   * The user's chat message goes, verbatim and once, to the session the coordinator picked. This
   * carries the human's own instruction, so it needs no task grant; it can't alter the words.
   */
  private async routeChat(a: any, reason: string): Promise<ToolResult> {
    const fail = (why: string): ToolResult => (this.log("route_to_session", "refused", why, { sessionId: a.sessionId ?? null, taskId: null, reason }), { ok: false, error: why });
    // Paused means no actions, routing included.
    if (this.mode !== "active") return fail("Coordinator is paused or off");
    const e = this.chatEntry(Number(a.chatId));
    if (!e || e.role !== "user") return fail("chatId must be one of the user's chat messages");
    if (e.routedTo) return fail(`already routed to ${e.routedTo}`);
    if (this.now() - e.at > 60 * 60_000) return fail("that message is over an hour old: ask the user");
    const s = this.d.sessions().get(String(a.sessionId));
    if (!s || s.execution === "ended") return fail("no such live session");
    if (this.excluded.has(s.id)) return fail("session is excluded from coordination");
    if (!this.d.route) return fail("routing is not available");
    // The words are the user's, but the destination is the model's choice: anything that sounds
    // destructive waits for the user to confirm where it goes.
    const destructive = screenDestructive(e.text);
    if (destructive) {
      const proposal = this.propose({
        kind: "action",
        sessionId: s.id,
        taskId: null,
        title: `Send your message to ${s.name ?? s.id}`,
        text: e.text,
        reason,
        heldBecause: "destructive_screen",
        payload: { action: "route", chatId: e.id, sessionId: s.id },
      });
      return { ok: true, result: { held: true, proposal, note: `held for the user's confirmation: it matched "${destructive}"` } };
    }
    return this.deliverRoute(e.id, s.id, reason);
  }

  /** Deliver a user chat message once to a session (checks re-run: also used after the user's confirmation). */
  private async deliverRoute(chatId: number, sessionId: string, reason: string): Promise<ToolResult> {
    const fail = (why: string): ToolResult => (this.log("route_to_session", "refused", why, { sessionId, taskId: null, reason }), { ok: false, error: why });
    const e = this.chatEntry(chatId);
    if (!e || e.role !== "user") return fail("not a user chat message");
    if (e.routedTo) return fail(`already routed to ${e.routedTo}`);
    const s = this.d.sessions().get(sessionId);
    if (!s || s.execution === "ended") return fail("no such live session");
    if (this.excluded.has(s.id)) return fail("session is excluded from coordination");
    if (!this.d.route) return fail("routing is not available");
    // One-shot: mark before the asynchronous send, so a retry or a second call can't deliver twice.
    this.d.db.query("UPDATE coord_chat SET data = json_set(data, '$.routedTo', ?) WHERE id = ?").run(s.id, e.id);
    this.routedEcho.set(s.id, e.text.trim());
    this.changed();
    const r = await this.d.route(s.id, e.text, e.images ?? [], e.id);
    if (!r.ok) {
      this.log("route_to_session", "error", r.error ?? "send failed", { sessionId: s.id, taskId: null, reason });
      return { ok: false, error: `not delivered: ${r.error ?? "unknown"} (the user can see this)` };
    }
    this.log("route_to_session", "ok", `chat #${e.id} → ${s.name ?? s.id}`, { sessionId: s.id, taskId: null, reason });
    return { ok: true, result: { routed: true, to: s.id } };
  }

  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private changed() {
    if (this.d.timers === false) return this.d.push(this.state());
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = null;
      this.d.push(this.state());
    }, 200);
  }

  state(): CoordinatorState {
    const tasks = this.d.coordination.snapshot().tasks;
    return {
      agent: this.kind,
      lastToolCallAt: this.lastToolCallAt,
      mode: this.mode,
      model: this.d.cfg.model,
      running: !!this.runtime?.running,
      busy: !!this.runtime?.busy,
      budget: this.budget.toJSON(),
      limits: {
        perSessionCooldownMs: this.d.cfg.limits.perSessionCooldownMs,
        perSessionPerHour: this.d.cfg.limits.perSessionPerHour,
        maxLaunched: this.d.cfg.limits.maxLaunched,
        maxRelayHops: this.d.cfg.limits.maxRelayHops,
      },
      excluded: [...this.excluded],
      autopilot: [...this.autopilot],
      launched: [...this.launched.values()].map(({ sessionId, objectiveId, taskId, at }) => ({ sessionId, objectiveId, taskId, at })),
      nextWakeAt: this.nextWakeAt,
      pendingEvents: this.pending.length,
      activity: this.activity(200),
      proposals: this.proposals(100),
      plans: this.plans.map((p) => ({
        proposalId: p.proposalId,
        title: p.title,
        tasks: p.tasks.map((x) => ({ key: x.key, taskId: x.taskId, title: x.approved?.title ?? this.d.coordination.task(x.taskId)?.title ?? x.key, state: x.state, ...(x.error ? { error: x.error } : {}) })),
      })),
      chat: this.chat(200),
      needsVerification: tasks.filter((t) => t.needsVerification).map((t) => t.id),
      screenLabel: SCREEN_LABEL,
    };
  }

  // ---------------------------------------------------------------- authority
  /** Did the coordinator launch this session (a delegated task's worker)? */
  isLaunched(sessionId: string): boolean {
    return this.launched.has(sessionId);
  }

  /** Autonomous: launched by the coordinator for an objective, or granted autopilot by the user. */
  autonomous(sessionId: string): boolean {
    if (this.excluded.has(sessionId)) return false;
    const l = this.launched.get(sessionId);
    if (!(l?.objectiveId || this.autopilot.has(sessionId))) return false;
    const task = this.taskFor(sessionId);
    try {
      if (!task || task.owner !== sessionId) return false;
      this.d.coordination.assertRecipient(task, sessionId, true);
      return true;
    } catch {
      return false;
    }
  }
  /** May the coordinator judge this session's permission prompts right now (D29)? On, in budget, not excluded. */
  mayJudgePermissions(sessionId: string): boolean {
    // The judge is a model call the daemon makes: only the built-in coordinator does that (D34).
    return this.kind === "builtin" && this.mode === "active" && !this.budget.exhausted && !this.excluded.has(sessionId);
  }

  authority(sessionId: string): "excluded" | "autonomous" | "suggest" {
    return this.excluded.has(sessionId) ? "excluded" : this.autonomous(sessionId) ? "autonomous" : "suggest";
  }

  setMode(mode: CoordinatorMode, by = "user") {
    if (!["active", "paused", "manual"].includes(mode)) throw new Error("mode must be active, paused or manual");
    const prev = this.mode;
    this.mode = mode;
    this.persist();
    this.log("mode", "info", `${prev} → ${mode} (by ${by})${mode === "paused" ? "; workers keep running" : ""}`);
    if (mode === "manual") {
      this.runtime?.stop();
      this.clearWake();
      this.pending = [];
      this.wakeWaiters();
    } else if (mode === "active" && prev !== "active") {
      this.enqueue({ kind: "mode", sessionId: null, text: `You were switched to ${mode} by the user.` }, 2000);
      if (this.plans.some((p) => p.tasks.some((x) => x.state === "waiting"))) void this.pumpPlans(); // queued plan tasks resume
    }
    this.changed();
  }

  setExcluded(sessionId: string, excluded: boolean) {
    if (excluded) {
      this.excluded.add(sessionId);
      this.cancelPendingFor(sessionId, "session excluded by the user");
    } else this.excluded.delete(sessionId);
    this.persist();
    this.log("exclude", "info", `${excluded ? "excluded" : "included"} ${sessionId} (by user)`, { sessionId });
  }

  setAutopilot(sessionId: string, enabled: boolean) {
    if (enabled) this.autopilot.add(sessionId);
    else this.autopilot.delete(sessionId);
    this.persist();
    this.log("autopilot", "info", `${enabled ? "granted" : "revoked"} autopilot for ${sessionId} (by user)`, { sessionId });
  }

  // ---------------------------------------------------------------- human instructions win
  private cancelPendingFor(sessionId: string | null, why: string, taskId: string | null = null): number {
    let n = 0;
    for (const p of this.proposals(500))
      if (p.state === "pending" && ((sessionId && p.sessionId === sessionId) || (taskId && p.taskId === taskId))) {
        this.saveProposal({ ...p, state: "cancelled", resolvedAt: this.now(), detail: why });
        n++;
      }
    return n;
  }

  /** The user messaged a session (UI or terminal): cancel the coordinator's pending actions for it. */
  onHumanMessage(sessionId: string) {
    this.humanHold.set(sessionId, this.now());
    this.hops.delete(sessionId);
    const n = this.cancelPendingFor(sessionId, "the user messaged this session directly");
    this.persist();
    this.log(
      "human_override",
      "info",
      `user messaged ${sessionId}; ${n} pending action(s) cancelled; coordinator messages held for ${Math.round(this.d.cfg.limits.humanHoldMs / 60_000)} min`,
      { sessionId },
    );
    // Sessions the coordinator has nothing to do with ride along passively instead of waking it.
    this.enqueue(
      {
        kind: "human_message",
        sessionId,
        text: `The user messaged this session directly. Their instruction wins: ${n} pending proposal(s) for it were cancelled. Re-plan around it; don't message it for now.`,
      },
      undefined,
      !n && !this.relevant(sessionId),
    );
  }

  onHumanGrantChange(objectiveId: string) {
    for (const t of this.d.coordination.snapshot().tasks.filter((t) => t.objectiveId === objectiveId)) {
      this.cancelPendingFor(t.owner, "Human changed objective grant", t.id);
    }
    this.enqueue({ kind: "user_edit", sessionId: null, text: `The human changed grant ${objectiveId}. Re-read state before acting.` });
  }

  /** The user changed a task (assignment, status…) through the UI/API. */
  onHumanTaskEdit(task: Task, prevOwner: string | null) {
    let n = this.cancelPendingFor(null, "the user changed this task", task.id);
    for (const s of new Set([prevOwner, task.owner].filter(Boolean) as string[])) {
      n += this.cancelPendingFor(s, "the user changed this session's assignment");
      this.humanHold.set(s, this.now());
    }
    this.taskHold.set(task.id, this.now());
    this.persist();
    this.log("human_override", "info", `user edited task ${task.id} (${clip(task.title, 60)}); ${n} pending action(s) cancelled`, {
      taskId: task.id,
      sessionId: task.owner,
    });
    this.enqueue({
      kind: "user_edit",
      sessionId: task.owner,
      text: `The user edited task ${task.id} "${clip(task.title, 80)}" (owner ${prevOwner ?? "none"} → ${task.owner ?? "none"}, status ${task.status}). Human instructions win: re-plan around it.`,
    });
  }

  // ---------------------------------------------------------------- events & wakes
  /** Registry event hook. */
  onEvent(e: SbEvent) {
    const s = this.d.sessions().get(e.sessionId);
    if (s && this.isSelf(s)) return;
    if (e.type === "user_msg") {
      // Claude Code records a pasted delivery inside <pasted_content> tags; unwrap it before checking whose it is.
      const text = typeof e.data.text === "string" ? e.data.text.replace(/<\/?pasted_content[^>]*>/g, "").trim() : "";
      if (!text || text.startsWith(PREFIX) || e.ts < this.startedAt) return; // never wake on our own messages; skip replayed history
      if (text === AUTO_TEMPLATE) return; // auto-continue is daemon policy, not the user
      if (this.routedEcho.get(e.sessionId) === text) {
        this.routedEcho.delete(e.sessionId); // our own routing arriving, not the user typing there
        return;
      }
      this.onHumanMessage(e.sessionId);
      return;
    }
    if (e.ts < this.startedAt - 5000) return;
    if (e.type === "session_ended" && this.launched.has(e.sessionId)) void this.pumpPlans(); // a slot may have freed up
    if (e.type === "session_started" || e.type === "session_ended")
      this.enqueue(
        {
          kind: e.type,
          sessionId: e.sessionId,
          text: `${s?.name ?? e.sessionId} (${s?.provider ?? "?"}, ${s?.cwd ?? "?"}) ${e.type === "session_started" ? "started" : "ended"}`,
        },
        undefined,
        !this.relevant(e.sessionId),
      );
    else if (e.type === "turn_ended" && this.relevant(e.sessionId)) {
      const last = typeof e.data.lastAgentMessage === "string" ? e.data.lastAgentMessage : s?.lastAssistantText;
      this.enqueue({ kind: "turn_ended", sessionId: e.sessionId, text: `turn ended: ${clip(last, 600)}` });
    }
    // A turn ended with the context getting full: the coordinator decides whether to refresh it.
    if (e.type === "turn_ended" && s && !this.excluded.has(s.id)) {
      const pct = contextPct(s.contextTokens, s.contextWindow);
      if (pct !== null && pct >= this.d.cfg.limits.contextHighPct)
        this.enqueue({ kind: "context_high", sessionId: s.id, text: `${s.name ?? s.id} ended a turn at ${pct}% context` }, undefined, !this.relevant(s.id));
    }
  }

  /** The coordinator's own session: the built-in process, or an external agent connected through `sb mcp`. */
  private isSelf(s: Session) {
    return (!!s.cwd && s.cwd.endsWith("/switchboard/coordinator")) || !!s.meta.coordinatorClient;
  }

  /** Sessions whose turn ends matter: they own a task, were launched by us, or are on autopilot. */
  private relevant(sessionId: string) {
    if (this.excluded.has(sessionId)) return false;
    return this.launched.has(sessionId) || this.autopilot.has(sessionId) || this.d.coordination.tasksOf(sessionId).length > 0;
  }

  onAttention(item: {
    id: number;
    sessionId: string;
    kind: string;
    title: string;
    text: string | null;
    status: string;
    historical?: boolean;
  }) {
    if (item.status !== "open" || item.historical || item.kind === "escalation" || this.excluded.has(item.sessionId)) return;
    this.enqueue({ kind: `attention_${item.kind}`, sessionId: item.sessionId, text: `${item.title}: ${clip(item.text, 300)}` });
  }

  onConflict(c: { id: string; kind: string; sessions: string[]; detail: string }) {
    this.enqueue({ kind: "conflict", sessionId: c.sessions.at(-1) ?? null, text: `${c.kind}: ${c.detail}` });
  }

  /** coordination.onChange: detect prerequisites landing (handoffs) and finished tasks. */
  onCoordinationChange() {
    const tasks = this.d.coordination.snapshot().tasks;
    for (const t of tasks) {
      const prev = this.taskStatus.get(t.id);
      this.taskStatus.set(t.id, t.status);
      if (prev === undefined || prev === t.status) continue;
      if (prev === "blocked" && (t.status === "assigned" || t.status === "unassigned"))
        this.enqueue({
          kind: "prerequisites_landed",
          sessionId: t.owner,
          text: this.planTask(t.id)?.state === "waiting" && !t.owner
            ? `Task ${t.id} "${clip(t.title, 80)}" is unblocked. It belongs to an approved plan: the daemon launches its worker with the prerequisites' results in the brief. No handoff needed.`
            : this.handoffSummary(t),
        });
      else if (t.status === "finished_unverified")
        this.enqueue({
          kind: "task_finished",
          sessionId: t.owner,
          text: `task ${t.id} "${clip(t.title, 80)}" finished (unverified): ${clip(t.result, 400)}`,
        });
    }
    if (this.plans.some((p) => p.tasks.some((x) => x.state === "waiting") || !p.doneNotified)) void this.pumpPlans();
  }

  // ---------------------------------------------------------------- delegation plans (D32)
  private planTask(taskId: string) {
    for (const p of this.plans) for (const x of p.tasks) if (x.taskId === taskId) return x;
    return undefined;
  }
  /** Is this objective one an approved plan created? Its tasks are exactly the approved ones. */
  private planObjective(objectiveId: string | null | undefined): PlanRecord | undefined {
    return objectiveId ? this.plans.find((p) => p.objectiveId === objectiveId) : undefined;
  }
  /**
   * The user retries a plan task whose launch failed (human-only route). Its approved snapshot is
   * unchanged, so the original approval still covers it; every gate re-runs at launch.
   */
  retryPlanTask(proposalId: number, key: string): { ok: boolean; error?: string } {
    const plan = this.plans.find((p) => p.proposalId === proposalId);
    const x = plan?.tasks.find((t) => t.key === key);
    if (!plan || !x) return { ok: false, error: "no such plan task" };
    if (x.state !== "failed") return { ok: false, error: `it's ${x.state}, not failed` };
    x.state = "waiting";
    x.attempts = 0;
    x.error = undefined;
    this.retries.clear(`launch:${x.taskId}`); // the user's go-ahead outranks the hourly failed-launch limit
    this.persist();
    this.log("plan_retry", "info", `user retried ${key} of plan #${proposalId}`);
    void this.pumpPlans();
    return { ok: true };
  }

  plansSnapshot(): PlanRecord[] {
    return structuredClone(this.plans);
  }
  /** Resolves when no plan launch is in flight (tests, shutdown). */
  async settled() {
    while (this.pumping) await this.pumping;
  }

  /**
   * Launch every waiting task of an approved plan that is ready now, within the cap. Each launch
   * goes through doLaunch, which re-runs every gate (mode, budget, grant, scope, prerequisites
   * VERIFIED, cap, retries, reservation). The approval counts only for tasks this exact approved
   * proposal created. Calls while a pass runs schedule one more pass.
   */
  pumpPlans(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    const run = async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.pumpOnce();
        } while (this.pumpAgain);
      } finally {
        this.pumping = null;
      }
    };
    this.pumping = run();
    return this.pumping;
  }

  private async pumpOnce() {
    const c = this.d.coordination;
    for (const plan of this.plans) {
      // Only the human's approval of this exact plan proposal lets the daemon launch its tasks.
      const approval = this.proposal(plan.proposalId);
      if (approval?.state !== "approved" || approval.payload?.action !== "plan") continue;
      for (const x of plan.tasks) {
        if (x.state !== "waiting") continue;
        if (this.mode !== "active" || this.budget.exhausted) return;
        const t = c.task(x.taskId);
        if (!t || t.objectiveId !== plan.objectiveId || t.status === "rejected" || t.status === "verified" || t.owner) {
          // Someone else (the user, or the coordinator assigning an existing session) took it over.
          x.state = "skipped";
          this.persist();
          continue;
        }
        // Only what the human approved launches: a task edited since (by anyone), or one the current
        // Settings would give a different model, is left for the human and the coordinator is told.
        const drift = taskDrift(t, x.approved);
        const m = modelFor(this.d.cfg, t.tier, x.provider);
        if (x.approved && (m.model !== x.approved.model || (m.effort ?? null) !== (x.approved.effort ?? null))) drift.push("model");
        if (drift.length) {
          x.state = "skipped";
          x.error = `changed after approval (${drift.join(", ")}); not launched`;
          this.persist();
          this.log("launch_session", "refused", `plan #${plan.proposalId} task ${t.id}: ${x.error}`, { taskId: t.id, reason: null });
          this.enqueue({ kind: "plan_launch_failed", sessionId: null, text: `plan #${plan.proposalId}: task ${t.id} "${clip(t.title, 80)}" ${x.error}. Tell the user; only they can launch it now.` });
          continue;
        }
        if (t.status === "blocked" || c.blockedBy(t).length || c.reservation(t.id)) continue;
        // Its prerequisites are verified: the claims the plan's own workers took for them, inside this
        // task's scope, have served their purpose. Nobody else's claims are touched.
        const workers = new Map(plan.tasks.filter((q) => q.sessionId && x.approved!.prerequisites.includes(q.taskId)).map((q) => [q.taskId, q.sessionId!]));
        c.releaseVerifiedPrerequisiteClaims(t, workers);
        const blocker = c.scopeBlocker(t);
        if (blocker) {
          // Someone else holds part of its scope: wait (visible on the plan), don't count it as a failure.
          const why = `waiting for claim ${blocker.id} on ${blocker.resource} held by ${blocker.owner}`;
          if (x.error !== why) ((x.error = why), this.persist());
          continue;
        }
        if (this.launchLoad() >= this.d.cfg.limits.maxLaunched) return; // queued until a slot frees up
        const o = c.objective(plan.objectiveId);
        const r = await this.doLaunch(
          { taskId: t.id, provider: x.provider, repo: o?.grant?.root ?? "", prompt: this.planBrief(t), reason: `approved plan #${plan.proposalId}` },
          true,
          { model: x.approved!.model, effort: x.approved!.effort },
        );
        if (r.ok) {
          x.state = "launched";
          x.sessionId = (r.result as { sessionId: string }).sessionId;
          delete x.error;
        } else {
          x.attempts++;
          x.error = r.error;
          if (x.attempts >= Math.max(1, this.d.cfg.limits.maxRetries)) {
            x.state = "failed";
            this.enqueue({ kind: "plan_launch_failed", sessionId: null, text: `plan #${plan.proposalId}: couldn't launch task ${t.id} "${clip(t.title, 80)}": ${r.error}. Tell the user; only they can launch it now.` });
          }
        }
        this.persist();
      }
      if (!plan.doneNotified && plan.tasks.every((x) => c.task(x.taskId)?.status === "verified")) {
        plan.doneNotified = true;
        this.persist();
        this.enqueue({ kind: "plan_done", sessionId: null, text: `Every task of plan #${plan.proposalId} "${clip(plan.title, 80)}" is verified. Tell the user in one line (tell_user).` });
      }
    }
  }

  /** The worker's brief: the plan's brief plus what its prerequisites produced (doLaunch adds the acceptance criteria). */
  private planBrief(t: Task): string {
    const prior = t.prerequisites
      .map((id) => this.d.coordination.task(id))
      .filter((p): p is Task => !!p)
      .map((p) => `- ${p.title}: ${clip(p.result, 400) || "(no summary)"}${p.worktree ? ` (worktree: ${p.worktree})` : ""}`);
    return `${t.description}${prior.length ? `\n\nThis builds on work that is done and verified:\n${prior.join("\n")}` : ""}`;
  }

  /** Deterministic handoff material from the prerequisites: the LLM turns it into the message. */
  handoffSummary(t: Task): string {
    const lines = [
      `Task ${t.id} "${t.title}" is unblocked (owner: ${t.owner ?? "unassigned"}). Send its owner a handoff summary. Prerequisites that landed:`,
    ];
    for (const id of t.prerequisites) {
      const p = this.d.coordination.task(id);
      if (!p) continue;
      lines.push(
        `- ${p.id} "${p.title}" [${p.status}] result: ${clip(p.result, 300) || "(none)"}${p.worktree ? ` worktree: ${p.worktree}` : ""}${
          p.evidence.length
            ? ` evidence: ${p.evidence
                .slice(-3)
                .map((e) => clip(e.text, 150))
                .join(" | ")}`
            : ""
        }`,
      );
    }
    return lines.join("\n");
  }

  /** passive: recorded for the next digest, but doesn't wake the coordinator by itself. */
  enqueue(ev: Omit<WakeEvent, "at">, delayMs = this.d.cfg.debounceMs, passive = false) {
    if (this.mode !== "active") return;
    if (ev.sessionId && this.excluded.has(ev.sessionId)) return;
    this.pending.push({ ...ev, at: this.now(), passive });
    if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
    if (passive) return;
    // An external agent isn't woken: it collects this with get_updates (a waiting call returns now).
    if (this.kind === "external") return this.wakeWaiters();
    if (this.d.timers === false) return;
    const at = this.now() + delayMs;
    if (this.wakeTimer && this.nextWakeAt !== null && this.nextWakeAt <= at) return;
    this.clearWake();
    this.nextWakeAt = at;
    this.wakeTimer = setTimeout(() => this.flush(), delayMs);
    this.changed();
  }

  private wakeWaiters() {
    for (const w of [...this.waiters]) w();
  }

  /**
   * get_updates (external agent only): the digest the built-in brain would have been woken with,
   * drained. Same relay-hop accounting as flush(), so loop prevention works the same way. User chat
   * comes from coord_chat past a persisted cursor, so each message is handed over once.
   */
  private async updates(waitSeconds: number) {
    const userChat = () => {
      const cursor = this.kv<number>("externalChatCursor", 0);
      return this.chat(200).filter((e) => e.role === "user" && e.id > cursor);
    };
    const wait = Math.max(0, Math.min(50, Number.isFinite(waitSeconds) ? waitSeconds : 0));
    if (wait > 0 && !this.pending.some((e) => !e.passive) && !userChat().length) {
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(t);
          this.waiters.delete(finish);
          done();
        };
        const t = setTimeout(finish, wait * 1000);
        this.waiters.add(finish);
      });
    }
    const evs = this.pending.splice(0);
    const chat = userChat();
    if (chat.length) this.setKv("externalChatCursor", chat.at(-1)!.id);
    if (evs.length) this.wakeHop = Math.max(0, ...evs.filter((e) => e.kind === "turn_ended" && e.sessionId).map((e) => this.hops.get(e.sessionId!) ?? 0));
    const restarted = this.fresh;
    this.fresh = false;
    if (evs.length || chat.length) this.log("wake", "info", `get_updates: ${evs.length} event(s), ${chat.length} chat message(s)`);
    return {
      restarted,
      events: evs.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, sessionId: e.sessionId, text: e.text, ...(e.passive ? { background: true } : {}) })),
      chat: chat.map((e) => ({ id: e.id, at: new Date(e.at).toISOString(), text: e.text, ...(e.images?.length ? { images: e.images.length } : {}) })),
      relayHop: this.wakeHop,
      mode: this.mode,
      state: this.stateDigest(),
    };
  }

  private clearWake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.nextWakeAt = null;
  }

  private heartbeat() {
    if (this.mode !== "active") return;
    if (this.plans.some((p) => p.tasks.some((x) => x.state === "waiting"))) void this.pumpPlans(); // e.g. after a restart
    const working = [...this.d.sessions().values()].filter((s) => s.execution === "working" && this.relevant(s.id));
    if (working.length)
      this.enqueue(
        {
          kind: "heartbeat",
          sessionId: null,
          text: `heartbeat: ${working.length} relevant session(s) working: ${working.map((s) => s.name ?? s.id).join(", ")}`,
        },
        1000,
      );
  }

  /** Build and deliver the batched digest. Returns the digest text (for tests) or null. */
  flush(): string | null {
    this.clearWake();
    if (this.mode !== "active" || !this.pending.some((e) => !e.passive)) return null;
    if (this.budget.exhausted) return (this.budgetStop(), null);
    const rt = this.ensureRuntime();
    if (!rt) return null;
    if (rt.busy) {
      // Try again once the current turn ends.
      this.nextWakeAt = null;
      return null;
    }
    const evs = this.pending.splice(0);
    this.wakeHop = Math.max(0, ...evs.filter((e) => e.kind === "turn_ended" && e.sessionId).map((e) => this.hops.get(e.sessionId!) ?? 0));
    const text = this.digest(evs);
    this.deliver(text, `wake: ${evs.length} event(s) [${[...new Set(evs.map((e) => e.kind))].join(", ")}]`);
    return text;
  }

  private digest(evs: WakeEvent[]): string {
    const parts: string[] = [];
    if (this.fresh) {
      parts.push(
        "SWITCHBOARD (RE)STARTED. You are a fresh coordinator process; your memory is empty. Durable state is below. Rebuild your picture from it with get_state / list_sessions before acting.",
      );
      this.fresh = false;
    }
    parts.push(`EVENTS (${evs.length}, relay hop ${this.wakeHop}):`);
    for (const e of evs)
      parts.push(`- [${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}${e.sessionId ? ` ${e.sessionId}` : ""}: ${e.text}`);
    parts.push("", this.stateDigest());
    return parts.join("\n");
  }

  stateDigest(): string {
    const snap = this.d.coordination.snapshot();
    const lines = [
      `STATE: mode ${this.mode}; budget $${this.budget.spentUsd.toFixed(3)}/$${this.budget.limitUsd}; launched ${this.liveLaunched()}/${this.d.cfg.limits.maxLaunched}`,
    ];
    for (const o of snap.objectives.filter((o) => o.status === "active")) lines.push(`objective ${o.id} "${clip(o.title, 80)}"`);
    for (const t of snap.tasks.filter((t) => !["verified", "rejected"].includes(t.status)))
      lines.push(
        `task ${t.id} [${t.status}] ${t.tier} "${clip(t.title, 70)}" owner=${t.owner ?? "-"}${t.prerequisites.length ? ` after=${t.prerequisites.join(",")}` : ""}${t.needsVerification ? " NEEDS-HIGHER-TIER-VERIFICATION" : ""}`,
      );
    const pend = this.proposals(50).filter((p) => p.state === "pending");
    if (pend.length) lines.push(`pending proposals awaiting the user: ${pend.map((p) => `#${p.id} ${p.kind}`).join(", ")}`);
    if (snap.conflicts.length)
      lines.push(
        `conflicts: ${snap.conflicts
          .slice(0, 5)
          .map((c) => clip(c.detail, 100))
          .join(" | ")}`,
      );
    return lines.join("\n");
  }

  private liveLaunched() {
    const ss = this.d.sessions();
    return [...this.launched.values()].filter((l) => ss.get(l.sessionId)?.execution !== "ended" && ss.has(l.sessionId)).length;
  }

  /**
   * What counts toward maxLaunched: every live worker the coordinator launched (its launched set,
   * plus any worker recorded on a launch reservation, e.g. one whose launch was invalidated
   * mid-flight or confirmed by the human), plus unfinished reservations with no recorded worker.
   * Those count while recent, or for as long as a live session is working in the reserved
   * directory or below it (the worker may have started). Only a stuck reservation with no sign of a live
   * worker ages out, so it can't block every future launch, and nothing live escapes the cap.
   */
  private launchLoad() {
    const ss = this.d.sessions();
    const live = (id: string) => {
      const s = ss.get(id);
      return !!s && s.execution !== "ended";
    };
    const workers = new Set([...this.launched.keys()].filter(live));
    const reservations = this.d.coordination.reservations();
    // Recorded workers first, so an unrecorded reservation can't be "explained" by one of them.
    for (const r of reservations) if (r.sessionId && live(r.sessionId)) workers.add(r.sessionId);
    let pending = 0;
    const windowMs = this.d.cfg.limits.reservationCapWindowMs;
    for (const r of reservations) {
      if (r.sessionId || r.state === "launched") continue;
      // Live sessions working in (or below) the reserved directory. Each unrecorded reservation
      // counts on its own: one worker must not stand in for several reservations sharing a
      // directory (worktree: false launches all work in the grant root).
      const inDir = r.cwd
        ? [...ss.values()].filter((s) => {
            if (!s.cwd || s.execution === "ended") return false;
            try {
              return within(canonical(s.cwd), r.cwd!);
            } catch {
              return false;
            }
          })
        : [];
      // A session already counted (another launch's recorded worker) can't be this one's worker.
      const unexplained = inDir.find((s) => !workers.has(s.id));
      if (unexplained) workers.add(unexplained.id);
      else if (this.now() - r.at < windowMs) pending++;
    }
    return workers.size + pending;
  }

  private ensureRuntime(): RuntimeLike | null {
    const rt = this.runtime;
    if (!rt || this.kind !== "builtin") return null;
    if (!rt.running) {
      if (!this.restarts.allowed("start", this.now())) {
        this.log("runtime", "error", "coordinator process failed to stay up 3 times in an hour; not restarting");
        return null;
      }
      this.restarts.fail("start", this.now());
      this.fresh = true;
      this.budget.newProcess();
      rt.start();
      this.log("runtime", "info", `started coordinator process (model ${this.d.cfg.model})`);
    }
    return rt;
  }

  private deliver(text: string, label: string) {
    const rt = this.runtime;
    if (!rt) return;
    if (rt.busy) {
      this.queuedTurns.push({ body: text, origin: "event", images: [] });
      return;
    }
    if (rt.send(text)) {
      this.turnOrigin = "event";
      this.log("wake", "info", label);
    }
  }

  setRuntime(rt: RuntimeLike) {
    if (this.kind === "external") throw new Error("an external coordinator has no runtime: the daemon never starts a model for it");
    this.runtime = rt;
    this.wireRuntime(rt);
  }

  private wireRuntime(rt: RuntimeLike) {
    // Replies to the user's messages go to the chat. Thinking aloud about background events goes
    // to the activity log; to tell the user something unprompted it calls tell_user.
    rt.onText = (t) => (this.turnOrigin === "user" ? this.addChat("coordinator", t) : this.log("reply", "info", clip(t, 600)));
    rt.onResult = (r) => {
      this.budget.record(r.total_cost_usd, r.usage);
      this.persist();
      if (this.budget.exhausted) this.budgetStop();
      const next = this.queuedTurns.shift();
      if (next && rt.send(next.body, next.images)) {
        this.turnOrigin = next.origin;
        this.log("wake", "info", "queued turn");
      }
      else if (this.pending.length && this.mode === "active")
        this.enqueue({ kind: "followup", sessionId: null, text: "events arrived while you were busy" }, 5000);
      this.changed();
    };
    rt.onExit = (code) => {
      this.log("runtime", code === 0 ? "info" : "error", `coordinator process exited (${code})`);
      this.changed();
    };
  }

  private budgetStop() {
    this.runtime?.stop();
    if (!this.budgetFlagged) {
      this.budgetFlagged = true;
      this.log(
        "budget",
        "refused",
        `daily budget $${this.budget.limitUsd} reached ($${this.budget.spentUsd.toFixed(3)}): hard stop until tomorrow`,
      );
      this.d.escalate(
        null,
        "Coordinator budget reached",
        `The coordinator spent $${this.budget.spentUsd.toFixed(3)} of its $${this.budget.limitUsd} daily budget and has stopped.`,
      );
    }
  }

  /** The user talks to the coordinator. */
  userChat(text: string, images: string[] = []): { ok: boolean; error?: string; id?: number } {
    const t = text.trim();
    if (!t && !images.length) return { ok: false, error: "empty message" };
    if (this.mode === "manual") return { ok: false, error: "the coordinator is off (manual mode): switch it to active or paused first" };
    if (this.budget.exhausted) return { ok: false, error: "daily budget reached" };
    const id = this.addChat("user", t, images);
    if (this.kind === "external") {
      // The external agent picks it up with get_updates (a waiting call returns now).
      this.log("chat", "info", `user: ${clip(t, 200)}`);
      this.wakeWaiters();
      return { ok: true, id };
    }
    const rt = this.ensureRuntime();
    if (!rt) return { ok: false, error: "coordinator process unavailable" };
    const pics = images.length ? `\n[${images.length} image(s) attached: you can see them below; route_to_session also forwards them]` : "";
    const body = `${this.fresh ? "SWITCHBOARD (RE)STARTED: your memory is empty; use get_state before acting.\n" : ""}MESSAGE FROM THE USER (chat #${id}, mode ${this.mode}${this.mode === "paused" ? ": you may answer, read state and route this message, but take no other actions" : ""}):\n${t}${pics}`;
    this.fresh = false;
    if (rt.busy) this.queuedTurns.push({ body, origin: "user", images });
    else if (rt.send(body, images)) this.turnOrigin = "user";
    this.log("chat", "info", `user: ${clip(t, 200)}`);
    return { ok: true, id };
  }

  // ---------------------------------------------------------------- proposals
  private propose(
    p: Pick<CoordinatorProposal, "kind" | "sessionId" | "taskId" | "title" | "text" | "reason" | "heldBecause"> & {
      payload?: Record<string, unknown>;
    },
  ): CoordinatorProposal {
    const saved = this.saveProposal({
      ...p,
      payload: p.payload ?? {},
      ...(p.payload?.action === "plan" ? { digest: planDigest(p.payload) } : {}),
      createdAt: this.now(),
      state: "pending",
      resolvedAt: null,
      detail: null,
    });
    this.log(
      p.kind,
      p.heldBecause === "destructive_screen" ? "held" : "proposed",
      `proposal #${saved.id}: ${p.title} (${p.heldBecause.replace("_", " ")})`,
      { sessionId: p.sessionId, taskId: p.taskId, reason: p.reason },
    );
    return saved;
  }

  async approve(id: number, opts: { digest?: string } = {}): Promise<CoordinatorProposal> {
    const p = this.proposal(id);
    if (!p) throw new Error("unknown proposal");
    if (p.state !== "pending") throw new Error(`proposal is ${p.state}`);
    if (p.kind === "action" && p.payload?.action === "new_objective") return this.approveObjective(p);
    if (p.kind === "action" && p.payload?.action === "plan") return this.approvePlan(p, opts.digest);
    if (p.kind === "action" && p.payload?.action === "ask_several") {
      this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail: "Approval consumed; starting the sessions." });
      try {
        if (!this.d.askSeveral) throw new Error("not available");
        const g = await this.d.askSeveral(String(p.payload.prompt), String(p.payload.cwd), p.payload.members as any);
        this.enqueue({ kind: "perspectives_started", sessionId: null, text: `group ${g.id} started for "${clip(String(p.payload.prompt), 120)}": when the answers and synthesis arrive, summarize them for the user` });
        return this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail: `started group ${g.id}` });
      } catch (e) {
        return this.saveProposal({ ...p, state: "failed", resolvedAt: this.now(), detail: (e as Error).message });
      }
    }
    if (p.kind === "action" && p.payload?.action === "refresh_context") {
      this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail: "Approval consumed; refreshing." });
      const r = await this.refreshContext(p.payload, p.reason ?? "approved by the user", p.id);
      return this.saveProposal({ ...p, state: r.ok ? "approved" : "failed", resolvedAt: this.now(), detail: r.ok ? "done" : (r.error ?? "failed") });
    }
    if (p.kind === "action" && p.payload?.action === "route") {
      // The human confirmed this exact destination for their own message.
      this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail: "Approval consumed; delivering." });
      const r = await this.deliverRoute(Number(p.payload.chatId), String(p.payload.sessionId), p.reason ?? "approved by the user");
      return this.saveProposal({ ...p, state: r.ok ? "approved" : "failed", resolvedAt: this.now(), detail: r.ok ? "sent" : (r.error ?? "not delivered") });
    }
    const dispatches = (p.kind === "send_message" && !!p.sessionId) || p.kind === "launch_session";
    if (dispatches && this.mode !== "active")
      throw new Error(
        `Can't approve while the coordinator is ${this.mode}: approving sends this through the coordinator. Switch it to active, then approve. The proposal is still pending.`,
      );
    if (p.kind === "send_message" && p.sessionId)
      try {
        this.assertDispatch(p.sessionId, p.taskId, true);
      } catch (e) {
        throw new Error(`Can't approve proposal #${id} yet (it is still pending): ${(e as Error).message}`);
      }
    // Consume the human approval durably before crossing an asynchronous boundary. A crash
    // cannot turn a possibly dispatched action back into a pending/retryable proposal.
    this.saveProposal({
      ...p,
      state: "approved",
      resolvedAt: this.now(),
      detail: "Approval consumed; dispatch outcome pending or uncertain. Inspect the outbox/reservation before retrying.",
    });
    let state: CoordinatorProposal["state"] = "approved";
    let detail = "approved by the user";
    try {
      if (p.kind === "send_message" && p.sessionId) {
        const r = await this.sendMessage(p.sessionId, p.text, p.reason, p.taskId, "approved_message", true, p.id);
        if (!r.ok) ((state = "failed"), (detail = r.error));
      } else if (p.kind === "launch_session") {
        const r = await this.doLaunch(p.payload as any, true);
        if (!r.ok) ((state = "failed"), (detail = r.error));
        else detail = `launched ${JSON.stringify(r.result)}`;
      }
    } catch (e) {
      // Proposal status is not a delivery receipt. Never recycle it after an exception.
      state = "failed";
      detail = `Dispatch outcome uncertain: ${(e as Error).message}. Inspect the outbox/reservation; approval will not be retried.`;
    }
    const out = this.saveProposal({ ...p, state, resolvedAt: this.now(), detail });
    this.log("proposal_approved", state === "failed" ? "error" : "ok", `#${id} ${p.title}: ${detail}`, {
      sessionId: p.sessionId,
      taskId: p.taskId,
    });
    this.enqueue(
      {
        kind: "proposal_resolved",
        sessionId: p.sessionId,
        text: `the user approved proposal #${id} (${p.title})${state === "failed" ? `, but it failed: ${detail}` : ""}`,
      },
      5000,
    );
    return out;
  }

  /**
   * P1-A5: the human clicking approve on this exact create_objective proposal creates the
   * objective and issues a human grant for the proposal's root/resources. Never verification
   * checks: the coordinator must not declare its own oracle.
   */
  private approveObjective(p: CoordinatorProposal): CoordinatorProposal {
    const pl = p.payload as { title?: unknown; description?: unknown; priority?: unknown; root?: unknown; resources?: unknown };
    const root = typeof pl.root === "string" ? pl.root : "";
    const fail = (why: string) => new Error(`Can't approve proposal #${p.id}: ${why}. Nothing was created; reject it, or create the objective yourself.`);
    if (!root || !isAbsolute(root)) throw fail("it names no absolute root directory");
    let o: Objective;
    try {
      o = this.d.coordination.createGrantedObjective(
        {
          title: String(pl.title ?? "").slice(0, 200),
          description: String(pl.description ?? ""),
          priority: ["high", "normal", "low"].includes(pl.priority as string) ? (pl.priority as Objective["priority"]) : "normal",
          root,
          resources: Array.isArray(pl.resources) ? pl.resources.map(String) : [],
        },
        `human approved proposal #${p.id}`,
        "human",
      );
    } catch (e) {
      throw fail((e as Error).message);
    }
    const detail = `created objective ${o.id} with a human grant on ${o.grant!.root}${o.grant!.resources.length ? ` + ${o.grant!.resources.join(", ")}` : ""}`;
    const out = this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail });
    this.log("proposal_approved", "ok", `#${p.id} ${p.title}: ${detail}`);
    this.enqueue({ kind: "proposal_resolved", sessionId: null, text: `the user approved proposal #${p.id}: ${detail}` }, 5000);
    return out;
  }

  /**
   * D32: the human tapped Go ahead on one plan. Same grant path as approveObjective (P1-A5), then
   * the plan's tasks (prerequisites mapped to ids), then every ready task is launched. The approval
   * is consumed before anything asynchronous; dependents launch later as their prerequisites are
   * VERIFIED (pumpPlans).
   */
  private async approvePlan(p: CoordinatorProposal, digest: string | undefined): Promise<CoordinatorProposal> {
    const pl = p.payload as unknown as PlanPayload;
    const fail = (why: string) => new Error(`Can't approve plan #${p.id} (it is still pending): ${why}`);
    // The tap approves exactly the plan the card rendered: its digest, recomputed from what is stored now.
    if (!digest || digest !== planDigest(p.payload)) throw fail("the plan changed since it was shown (or the card sent no digest); review it again");
    if (this.mode !== "active") throw fail(`the coordinator is ${this.mode}; switch it to active first`);
    if (this.budget.exhausted) throw fail("the daily budget is reached");
    if (!Array.isArray(pl.tasks) || !pl.tasks.length) throw fail("it has no tasks");
    const drift = planDrift(pl, this.d.cfg);
    if (drift.length) throw fail(`Settings changed since it was proposed, so it would run differently than shown (${drift.join("; ")}). Ask the coordinator to propose it again`);
    let o: Objective;
    try {
      o = this.d.coordination.createGrantedObjective(
        { title: String(pl.title ?? "").slice(0, 200), description: p.text ?? "", priority: "normal", root: String(pl.root ?? ""), resources: pl.resources ?? [] },
        `human approved plan #${p.id}`,
        "human",
      );
    } catch (e) {
      throw fail(`${(e as Error).message}. Nothing was created`);
    }
    this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail: `Approval consumed; created objective ${o.id}, creating tasks.` });
    const c = this.d.coordination;
    const ids = new Map<string, string>();
    const record: PlanRecord = { proposalId: p.id, objectiveId: o.id, title: String(pl.title ?? ""), tasks: [] };
    try {
      const byKey = new Map(pl.tasks.map((t) => [t.key, t]));
      for (const key of planOrder(pl.tasks)) {
        const pt = byKey.get(key)!;
        const t = c.createTask(
          {
            title: pt.title,
            description: pt.brief,
            objectiveId: o.id,
            scope: { paths: pt.paths, resources: [] },
            prerequisites: pt.prerequisites.map((k) => ids.get(k)!),
            acceptance: pt.acceptance,
            tier: pt.tier,
            tierReason: pt.tierReason,
          },
          "coordinator",
        );
        ids.set(key, t.id);
        this.taskStatus.set(t.id, t.status);
        record.tasks.push({ key, taskId: t.id, provider: pt.provider, state: "waiting", attempts: 0, approved: approvedSnapshot(c.task(t.id)!, pt) });
      }
    } catch (e) {
      const detail = `created objective ${o.id}, but task creation failed: ${(e as Error).message}`;
      this.log("proposal_approved", "error", `#${p.id} ${p.title}: ${detail}`);
      this.d.escalate(null, "Plan only partly set up", `${detail}. Nothing was launched.`);
      return this.saveProposal({ ...p, state: "failed", resolvedAt: this.now(), detail });
    }
    this.plans.push(record);
    this.persist();
    await this.pumpPlans();
    const rec = this.plans.find((x) => x.proposalId === p.id)!;
    const launched = rec.tasks.filter((x) => x.state === "launched").length;
    const detail = `created objective ${o.id} (grant ${o.grant!.root}) and ${rec.tasks.length} task(s); launched ${launched}, ${rec.tasks.length - launched} waiting`;
    const out = this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail });
    this.log("proposal_approved", "ok", `#${p.id} ${p.title}: ${detail}`);
    this.enqueue(
      {
        kind: "proposal_resolved",
        sessionId: null,
        text: `the user approved plan #${p.id}: ${detail}. Tasks: ${rec.tasks.map((x) => `${x.key}=${x.taskId} (${x.state})`).join(", ")}. Watch the workers; verify their results.`,
      },
      5000,
    );
    return out;
  }

  /**
   * Human-only recovery for a stuck launch reservation (HTTP: POST /api/tasks/:id/reservation/clear).
   * "launched" confirms the worker as this coordinator's launch for the task.
   */
  clearReservation(taskId: string, as: "not_launched" | "launched", sessionId?: string | null) {
    const r = this.d.coordination.clearReservation(taskId, { as, sessionId }, "human");
    const t = r.task;
    if (as === "launched" && r.reservation?.sessionId && t?.owner === r.reservation.sessionId) {
      this.launched.set(t.owner, { sessionId: t.owner, objectiveId: t.objectiveId, taskId, tier: t.tier, at: this.now() });
      this.persist();
    }
    this.log("reservation_cleared", "info", `user cleared the launch reservation for task ${taskId} as ${as}`, { taskId, sessionId: sessionId ?? null });
    this.enqueue({ kind: "user_edit", sessionId: null, text: `The user cleared the launch reservation for task ${taskId} as ${as}. Re-read state before acting.` });
    return r;
  }

  reject(id: number, note = ""): CoordinatorProposal {
    const p = this.proposal(id);
    if (!p) throw new Error("unknown proposal");
    if (p.state !== "pending") throw new Error(`proposal is ${p.state}`);
    const out = this.saveProposal({ ...p, state: "rejected", resolvedAt: this.now(), detail: note || "rejected by the user" });
    this.log("proposal_rejected", "info", `#${id} ${p.title}`, { sessionId: p.sessionId, taskId: p.taskId });
    this.enqueue(
      { kind: "proposal_resolved", sessionId: p.sessionId, text: `the user rejected proposal #${id} (${p.title}). Don't retry it.` },
      5000,
    );
    return out;
  }

  private recordSent(sessionId: string, text: string) {
    this.sent.push({ sessionId, at: this.now(), text });
    this.hops.set(sessionId, this.wakeHop + 1);
    this.persist();
  }

  // ---------------------------------------------------------------- tools
  tools() {
    return this.kind === "external" ? [...TOOLS, ...EXTERNAL_TOOLS] : TOOLS;
  }
  private toolNames() {
    return this.kind === "external" ? [...TOOL_NAMES, ...EXTERNAL_TOOL_NAMES] : TOOL_NAMES;
  }

  /** Every MCP tool call lands here. Enforcement happens before any handler runs. */
  async callTool(name: string, args: any = {}): Promise<ToolResult> {
    args = args && typeof args === "object" ? args : {};
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const ctx = {
      sessionId: typeof args.sessionId === "string" ? args.sessionId : null,
      taskId: typeof args.taskId === "string" ? args.taskId : null,
      reason: reason || null,
    };
    const refuse = (why: string, outcome: CoordinatorActivity["outcome"] = "refused"): ToolResult => {
      this.log(name, outcome, why, ctx);
      return { ok: false, error: why };
    };
    // Seen: an external agent is connected (pushed at most once a minute, so polling stays cheap).
    const prevCall = this.lastToolCallAt;
    this.lastToolCallAt = this.now();
    if (prevCall === null || this.lastToolCallAt - prevCall > 60_000) this.changed();
    if (!this.toolNames().includes(name)) return refuse(`unknown tool ${name} (there is no tool to answer approvals, run commands or use git)`);
    if (this.mode === "manual") return refuse("the coordinator is off (manual mode)");
    const acting = !READ_ONLY_TOOLS.has(name) && name !== "flag_user";
    if (name === "flag_user") {
      const row = this.d.db
        .query(
          "SELECT COUNT(*) AS n FROM coord_activity WHERE json_extract(data,'$.action')='flag_user' AND json_extract(data,'$.outcome')='ok' AND json_extract(data,'$.at')>?",
        )
        .get(this.now() - 3600000) as { n: number };
      if (row.n >= 6) return refuse("Escalation rate limit reached");
    }
    if (acting && this.mode === "paused") return refuse("paused: no new actions (workers keep running)");
    if (acting && this.budget.exhausted) return refuse("daily budget reached: hard stop");
    if (acting && !reason && name !== "flag_user") return refuse("every action needs a reason");
    const { reason: _r, ...rest } = args;
    const sig = `${name} ${JSON.stringify(rest)}`;
    if (acting) {
      const seen = this.repeats.attempt(sig, this.now());
      // A runaway loop halts everything; merely redoing finished work refuses just that call.
      if (seen === "runaway") {
        this.setMode("paused", "loop prevention");
        this.d.escalate(
          ctx.sessionId,
          "Coordinator halted: repeated work",
          `It attempted ${name} with the same arguments ${this.d.cfg.limits.runawayThreshold} times within an hour. It is paused; check the activity log and switch it back to active when ready.`,
        );
        return refuse(`repeated work detected (${name} x${this.d.cfg.limits.runawayThreshold}/h): halted and flagged the user`);
      }
      if (seen === "repeat")
        return refuse(`repeated work: ${name} with these arguments already succeeded ${this.d.cfg.limits.repeatThreshold - 1} times this hour. Don't redo it; do something else or tell the user`);
    }
    try {
      const r = await this.dispatch(name, args, reason);
      if (acting && r.ok) this.repeats.succeeded(sig);
      // get_updates logs only when it delivers something (polling would flood the log).
      if (r.ok && name !== "send_message" && name !== "request_checkpoint" && name !== "launch_session" && name !== "get_updates" && name !== "get_instructions")
        this.log(name, name === "note" ? "info" : "ok", clip(JSON.stringify(args), 400), ctx);
      return r;
    } catch (e) {
      return refuse((e as Error).message, "error");
    }
  }

  private session(id: unknown): Session {
    const s = typeof id === "string" ? this.d.sessions().get(id) : undefined;
    if (!s) throw new Error(`unknown session ${String(id)}`);
    return s;
  }

  private sessionView(s: Session) {
    return {
      id: s.id,
      name: s.name,
      provider: s.provider,
      kind: s.kind,
      cwd: s.cwd,
      execution: s.execution,
      firstPrompt: clip(s.firstPrompt, 200),
      authority: this.authority(s.id),
      launchedByCoordinator: this.launched.has(s.id),
      tasks: this.d.coordination.tasksOf(s.id).map((t) => t.id),
      canMessage: s.sendMethods?.length > 0,
      model: s.model,
      effort: s.effort,
      contextPct: contextPct(s.contextTokens, s.contextWindow),
      // Where it actually writes (its starting folder can differ): check this before calling anything a conflict.
      recentFiles: s.filesTouched.filter((f) => this.now() - f.at < 3600_000).slice(-15).map((f) => f.path),
    };
  }

  private async dispatch(name: string, a: any, reason: string): Promise<ToolResult> {
    const c = this.d.coordination;
    const ok = (result: unknown): ToolResult => ({ ok: true, result });
    switch (name) {
      case "list_sessions":
        return ok(
          [...this.d.sessions().values()]
            .filter((s) => !this.isSelf(s) && (a.includeEnded || s.execution !== "ended"))
            .map((s) => this.sessionView(s)),
        );
      case "get_session": {
        const s = this.session(a.sessionId);
        const recent = this.d
          .events(s.id, 80)
          .filter((e) => ["user_msg", "assistant_msg", "turn_ended", "tool_call"].includes(e.type))
          .slice(-25)
          .map((e) => ({
            sourceId: e.sourceId,
            type: e.type,
            ts: e.ts,
            text: clip(
              typeof e.data.text === "string"
                ? e.data.text
                : typeof e.data.name === "string"
                  ? `${e.data.name} ${JSON.stringify(e.data.paths ?? "")}`
                  : "",
              500,
            ),
          }));
        return ok({ ...this.sessionView(s), lastAssistantText: clip(s.lastAssistantText, 800), recent });
      }
      case "get_state": {
        const snap = c.snapshot();
        return ok({
          ...snap,
          objectives: snap.objectives.map(coordinatorObjective),
          tasks: snap.tasks.map(coordinatorTask),
          proposals: this.proposals(30).filter((p) => p.state === "pending"),
          budget: this.budget.toJSON(),
          launched: [...this.launched.values()],
        });
      }
      case "get_resources":
        return ok(this.d.governor?.snapshot?.() ?? { available: false, note: "resource governor not running" });
      case "get_updates":
        return ok(await this.updates(Number(a.waitSeconds ?? 0)));
      case "get_instructions": {
        let text: string;
        try {
          text = readFileSync(PROMPT_FILE, "utf8");
        } catch {
          text = "# You are the Switchboard coordinator\n(The full instructions file is missing from this checkout.)";
        }
        return ok({ text: text + EXTERNAL_ADDENDUM });
      }
      case "note":
        return ok({ noted: true });
      case "create_objective": {
        const root = typeof a.root === "string" ? a.root.trim() : "";
        if (!root || !isAbsolute(root)) throw new Error("create_objective needs root: the absolute path of the repository directory");
        // Existence is checked when the human approves (the grant is built then, not now).
        if (a.resources !== undefined && !Array.isArray(a.resources)) throw new Error("resources must be a list");
        const resources = Array.isArray(a.resources) ? a.resources.map(String) : [];
        return ok({
          proposed: true,
          proposal: this.propose({
            kind: "action",
            sessionId: null,
            taskId: null,
            title: `New objective: ${String(a.title ?? "").slice(0, 160)} (grant ${root}${resources.length ? ` + ${resources.join(", ")}` : ""})`,
            text: String(a.description ?? ""),
            reason,
            heldBecause: "outside_authority",
            payload: {
              action: "new_objective",
              title: String(a.title ?? ""),
              description: String(a.description ?? ""),
              priority: a.priority,
              root,
              resources,
            },
          }),
          note: "Only the human can approve this. Approval creates the objective and grants it this root and these resources; until then you have no authority.",
        });
      }
      case "propose_plan": {
        const root = typeof a.root === "string" ? a.root.trim() : "";
        if (!root || !isAbsolute(root)) throw new Error("propose_plan needs root: the absolute path of an existing repository directory");
        // The same root checks the approval will run (P1-A5): fail now rather than on the user's tap.
        const grant = c.checkProposedGrant({ root, resources: Array.isArray(a.resources) ? a.resources.map(String) : a.resources }, "check");
        const plan = validatePlan({ ...a, resources: grant.resources }, grant.root, this.d.cfg);
        const overrides = plan.tasks.filter((t) => t.tierOverride).map((t) => `${t.key}: ${t.tierOverride}`);

        return ok({
          proposed: true,
          proposal: this.propose({
            kind: "action",
            sessionId: null,
            taskId: null,
            title: clip(plan.title, 160),
            text: String(a.reason ?? ""),
            reason,
            heldBecause: "outside_authority",
            payload: plan as unknown as Record<string, unknown>,
          }),
          ...(overrides.length ? { tierOverrides: overrides } : {}),
          note: "One card for the user. Nothing exists until they tap Go ahead; then the daemon creates and launches the tasks. Don't create or launch them yourself.",
        });
      }
      case "create_task": {
        const acceptance = Array.isArray(a.acceptance) ? a.acceptance.map(String).filter(Boolean) : [];
        if (!acceptance.length) throw new Error("a task needs at least one acceptance criterion");
        if (this.planObjective(a.objectiveId))
          throw new Error("that objective belongs to an approved plan: it holds only the tasks the user approved. Propose a new plan for more work");
        const scope = {
          paths: Array.isArray(a.scope?.paths) ? a.scope.paths.map(String) : [],
          resources: Array.isArray(a.scope?.resources) ? a.scope.resources.map(String) : [],
        };
        const tier = resolveTier({ title: String(a.title ?? ""), description: a.description, paths: scope.paths }, this.d.cfg.tierRules, {
          tier: a.tier,
          reason: a.tierReason,
        });
        if (a.owner) this.requireRouting(a.owner);
        const t = c.createTask(
          {
            title: String(a.title ?? "").slice(0, 200),
            description: String(a.description ?? ""),
            objectiveId: a.objectiveId ?? null,
            owner: a.owner ?? null,
            scope,
            priority: a.priority,
            prerequisites: Array.isArray(a.prerequisites) ? a.prerequisites : [],
            acceptance,
            tier: tier.tier,
            tierReason: tier.reason,
          },
          "coordinator",
        );
        if (tier.tier === "light" && a.decisionDepends) c.updateTask(t.id, { needsVerification: true }, "coordinator");
        this.taskStatus.set(t.id, c.task(t.id)!.status);
        return ok(coordinatorTask(c.task(t.id)!));
      }
      case "update_task": {
        const t = c.task(a.taskId);
        if (!t) throw new Error("unknown task");
        const edited = this.taskHold.get(t.id);
        if (edited && this.now() - edited < this.d.cfg.limits.humanHoldMs) throw Error("Human instruction hold is active: the user just edited this task");
        if (t.owner) {
          this.requireAutonomous(t.owner, "update work owned by");
          this.requireRouting(t.owner);
        }
        if (a.acceptance !== undefined) throw Error("Only the human may change acceptance criteria");
        if (this.planObjective(t.objectiveId)) {
          const frozen = ["description", "scope", "tier", "tierReason", "prerequisites", "owner"].filter((k) => a[k] !== undefined);
          if (frozen.length)
            throw new Error(`task ${t.id} belongs to an approved plan: its ${frozen.join(", ")} are what the user approved and can't be changed by you. Tell the user, or propose a new plan`);
        }
        const patch: Partial<Task> = {};
        for (const k of ["status", "result", "acceptance", "description", "priority", "prerequisites"] as const)
          if (a[k] !== undefined) (patch as any)[k] = a[k];
        if (a.owner !== undefined && a.owner !== t.owner) {
          if (a.owner) this.requireRouting(a.owner);
          if (t.owner && !this.autonomous(t.owner))
            throw new Error(`task ${t.id} is owned by ${t.owner}, a session the user drives: use propose_action to suggest reassigning it`);
          patch.owner = a.owner;
          if (!a.status && a.owner && t.status === "unassigned") patch.status = "assigned";
        }
        if (a.tier || a.scope) {
          const scope = a.scope ? { paths: a.scope.paths ?? t.scope.paths, resources: a.scope.resources ?? t.scope.resources } : t.scope;
          const r = resolveTier({ title: t.title, description: t.description, paths: scope.paths }, this.d.cfg.tierRules, {
            tier: a.tier ?? t.tier,
            reason: a.tierReason,
          });
          Object.assign(patch, { scope, tier: r.tier, tierReason: r.reason });
        }
        const u = c.updateTask(t.id, patch, "coordinator");
        // Prerequisites added after creation must block the task (so their landing triggers a handoff).
        if ((u.status === "assigned" || u.status === "unassigned") && c.blockedBy(u).length) c.updateTask(u.id, { status: "blocked" }, "coordinator");
        return ok(coordinatorTask(c.task(u.id)!));
      }
      case "record_evidence": {
        const t = c.task(a.taskId);
        if (!t) throw new Error("unknown task");
        if (t.owner) this.requireAutonomous(t.owner, "record evidence for");
        c.recordEvidence(t.id, "coordinator", String(a.text ?? ""), { criterion: a.criterion, sourceId: a.sourceId });
        return ok(coordinatorTask(c.task(t.id)!));
      }
      case "claim": {
        const owner = String(a.owner ?? "");
        this.requireAutonomous(owner, "claim for");
        const task = a.taskId ? c.task(a.taskId) : this.taskFor(owner);
        if (!task || task.owner !== owner) throw Error("Claim needs the recipient's task");
        c.checkDispatch(task.id, owner);
        const resource = resourceKey(String(a.resource ?? ""));
        if (
          !task.scope.resources.includes(resource) &&
          !(resource.startsWith("path:") && task.scope.paths.some((p) => within(resource.slice(5), p)))
        )
          throw Error("Claim is outside task scope");
        const r = c.claim(owner, resource, { exclusive: a.exclusive !== false, taskId: task.id, note: `coordinator: ${reason}` });
        this.myClaims.add(r.claim.id);
        this.persist();
        return ok(r);
      }
      case "release": {
        const id = Number(a.claimId);
        if (!this.myClaims.has(id)) throw new Error("the coordinator can only release claims it made");
        const claim = c.claims(["active", "suspect", "waiting"]).find((x) => x.id === id);
        if (!claim) throw Error("Claim missing");
        this.requireAutonomous(claim.owner, "release claims for");
        this.myClaims.delete(id);
        this.persist();
        return ok(c.release(id, claim.owner));
      }
      case "propose_action":
        return ok(
          this.propose({
            kind: "action",
            sessionId: a.sessionId ?? null,
            taskId: a.taskId ?? null,
            title: clip(String(a.title ?? "proposal"), 120),
            text: String(a.detail ?? ""),
            reason,
            heldBecause: "coordinator_proposal",
          }),
        );
      case "flag_user":
        this.d.escalate(a.sessionId ?? null, clip(String(a.title ?? "Coordinator needs you"), 120), String(a.text ?? ""));
        return ok({ flagged: true });
      case "route_to_session":
        return this.routeChat(a, reason);
      case "tell_user": {
        // Unprompted messages to the user's chat: rare, and only when they'd want to know now.
        const text = String(a.text ?? "").trim();
        if (!text) throw new Error("text required");
        // A runaway backstop, not etiquette: only unprompted posts since the user last spoke count.
        const chat = this.chat(50);
        const lastUser = chat.findLastIndex((e) => e.role === "user");
        const unprompted = chat.slice(lastUser + 1).filter((e) => e.role === "coordinator" && this.now() - e.at < 3600_000).length;
        if (unprompted >= 10) throw new Error("you've posted a lot this hour: hold it unless the user asks");
        this.addChat("coordinator", clip(text, 2000));
        return ok({ told: true });
      }
      case "refresh_context":
        return this.refreshContext(a, reason);
      case "get_group": {
        const g = this.d.group?.(String(a.groupId ?? ""));
        if (!g) throw new Error("unknown group");
        return ok({
          id: g.id,
          prompt: clip(g.prompt, 1000),
          status: g.status,
          answers: g.members.map((m) => ({ from: m.label, state: m.state, answer: clip(m.answer, 4000) })),
          synthesis: { state: g.synthesis.state, text: clip(g.synthesis.text ?? null, 8000) },
        });
      }
      case "ask_several": {
        // Launching sessions is the user's call: always a one-tap proposal.
        const prompt = String(a.prompt ?? "").trim();
        const cwd = String(a.cwd ?? "");
        const members = (Array.isArray(a.members) ? a.members : [{ provider: "claude" }, { provider: "codex" }])
          .filter((m: any) => m && (m.provider === "claude" || m.provider === "codex"))
          .slice(0, 4)
          .map((m: any) => ({ provider: m.provider, ...(typeof m.model === "string" && /^[\w.:-]{1,60}$/.test(m.model) ? { model: m.model } : {}) }));
        if (prompt.length < 5) throw new Error("a prompt is required");
        if (!cwd.startsWith("/")) throw new Error("an absolute folder is required (where the sessions should work)");
        if (members.length < 2) throw new Error("ask at least two agents");
        const who = members.map((m: any) => (m.model ? `${m.provider} (${m.model})` : m.provider)).join(" and ");
        return ok({
          proposed: true,
          proposal: this.propose({
            kind: "action",
            sessionId: null,
            taskId: null,
            title: `Ask ${who} the same question`,
            text: prompt,
            reason,
            heldBecause: "coordinator_proposal",
            payload: { action: "ask_several", prompt, cwd, members },
          }),
        });
      }
      case "send_message":
        return this.sendMessage(a.sessionId, String(a.text ?? ""), reason, a.taskId ?? null, name);
      case "request_checkpoint": {
        const t = a.taskId ? c.task(a.taskId) : null;
        const text = `Checkpoint please${t ? ` on task ${t.id} "${t.title}"` : ""}: reply with (1) what is done, (2) evidence (tests run, commands and their output, files changed), (3) what remains${t?.acceptance.length ? `, checked against the acceptance criteria: ${t.acceptance.join("; ")}` : ""}.${a.note ? ` ${a.note}` : ""}`;
        return this.sendMessage(a.sessionId, text, reason, a.taskId ?? null, name);
      }
      case "launch_session":
        return this.doLaunch({ ...a, reason }, false);
      case "set_priority":
      case "throttle":
      case "restore": {
        const s = this.session(a.sessionId);
        this.requireAutonomous(s.id, `${name.replace("_", " ")} for`);
        const g = this.d.governor;
        if (!g) throw new Error("resource governor not running");
        const r =
          name === "set_priority"
            ? g.setPriority?.(s.id, a.priority)
            : name === "throttle"
              ? g.throttle?.(s.id, a.level === 2 ? 2 : 1, `coordinator: ${reason}`)
              : g.restore?.(s.id, `coordinator: ${reason}`);
        return ok({ result: r ?? null });
      }
    }
    throw new Error(`unhandled tool ${name}`);
  }

  private taskFor(sessionId: string, taskId?: string | null) {
    if (taskId) return this.d.coordination.task(taskId);
    const launched = this.launched.get(sessionId)?.taskId;
    return (
      (launched ? this.d.coordination.task(launched) : undefined) ??
      this.d.coordination.snapshot().tasks.find((t) => t.owner === sessionId && t.status !== "rejected")
    );
  }
  /** Sessions the coordinator runs: it launched them, or the user put them on autopilot. Upkeep needs no task. */
  private runs(sessionId: string): boolean {
    return !this.excluded.has(sessionId) && (this.launched.has(sessionId) || this.autopilot.has(sessionId));
  }

  /** May the coordinator refresh this session's context now? It runs it, or the user approved this proposal. */
  private assertMaintenance(sessionId: string, proposalId: number | null) {
    if (this.mode !== "active") throw Error("Coordinator is paused or off");
    if (this.budget.exhausted) throw Error("Daily budget reached");
    if (this.excluded.has(sessionId)) throw Error("Session is excluded from coordination");
    const held = this.humanHold.get(sessionId);
    if (proposalId === null && held && this.now() - held < this.d.cfg.limits.humanHoldMs) throw Error("Human instruction hold is active");
    if (this.runs(sessionId)) return;
    const p = proposalId !== null ? this.proposal(proposalId) : null;
    if (!p || p.kind !== "action" || p.payload?.action !== "refresh_context" || p.sessionId !== sessionId || p.state !== "approved")
      throw Error("refreshing a session the user drives needs their OK");
  }

  /**
   * Keep a session's context healthy between turns: compact it (with a focus), or start it fresh
   * (Claude: /clear, then the hand-off brief as the next message). Sessions the user drives get a
   * proposal. Never mid-turn.
   */
  private async refreshContext(a: any, reason: string, approvedProposal: number | null = null): Promise<ToolResult> {
    const s = this.d.sessions().get(String(a.sessionId));
    const fail = (why: string): ToolResult => (this.log("refresh_context", "refused", why, { sessionId: s?.id ?? null, taskId: a.taskId ?? null, reason }), { ok: false, error: why });
    if (this.mode !== "active") return fail("Coordinator is paused or off");
    if (!s || s.execution === "ended") return fail("no such live session");
    if (this.excluded.has(s.id)) return fail("session is excluded from coordination");
    if (s.execution === "working") return fail("it's mid-turn: wait for the turn to end");
    const how = a.how === "fresh" ? "fresh" : "compact";
    const focus = String(a.focus ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500) || null;
    const brief = String(a.brief ?? "").trim();
    if (how === "fresh" && brief.length < 40) return fail("a fresh start needs a hand-off brief: what's done, where, how it was verified, what's next");
    if (how === "fresh" && s.provider !== "claude" && s.provider !== "codex") return fail("unsupported provider");
    if (!this.runs(s.id) && approvedProposal === null) {
      const pct = contextPct(s.contextTokens, s.contextWindow);
      return {
        ok: true,
        result: {
          proposed: true,
          proposal: this.propose({
            kind: "action",
            sessionId: s.id,
            taskId: a.taskId ?? null,
            title: `${how === "fresh" ? "Start" : "Compact"} ${s.name ?? s.id}'s context${pct !== null ? ` (${pct}% full)` : ""}`,
            text: how === "fresh" ? brief : (focus ?? ""),
            reason,
            heldBecause: "outside_authority",
            payload: { action: "refresh_context", sessionId: s.id, how, focus, brief, taskId: a.taskId ?? null },
          }),
          note: "the user drives this session: sent to them as a proposal",
        },
      };
    }
    if (!this.d.maintain) return fail("context maintenance is not available");
    // Same gates as a message: the user's hold, the per-session cooldown and hourly cap.
    if (approvedProposal === null) {
      const held = this.humanHold.get(s.id);
      if (held && this.now() - held < this.d.cfg.limits.humanHoldMs) return fail("the user messaged this session recently: human instructions win");
      const gate = checkSend(this.sent, s.id, `[context] ${how} ${focus ?? ""}`, this.d.cfg.limits, this.now());
      if (!gate.ok) return fail(gate.reason);
    }
    this.recordSent(s.id, `[context] ${how} ${focus ?? ""}`);
    // Fresh: make sure the brief will be deliverable before clearing anything.
    if (how === "fresh")
      try {
        this.assertDispatch(s.id, a.taskId ?? null, approvedProposal !== null);
      } catch (e) {
        return fail(`can't start fresh: the hand-off brief couldn't be delivered (${(e as Error).message}). Use how=compact instead.`);
      }
    const ctx: DispatchContext = { taskId: null, proposalId: approvedProposal, humanApproved: approvedProposal !== null, maintenance: "compact" };
    if (how === "compact" || s.provider === "codex") {
      const r = await this.d.maintain(s.id, "compact", focus, ctx);
      if (!r.ok) return fail(`compact failed: ${r.error ?? "unknown"}`);
    } else {
      const r = await this.d.maintain(s.id, "clear", null, { ...ctx, maintenance: "clear" });
      if (!r.ok) return fail(`clear failed: ${r.error ?? "unknown"}`);
    }
    if (how === "fresh") {
      // The brief goes as the first message of the new context, through the normal gated path.
      const sent = await this.sendMessage(s.id, brief, reason, a.taskId ?? null, "refresh_context", approvedProposal !== null, approvedProposal);
      if (!sent.ok) return { ok: false, error: `context cleared, but the hand-off brief wasn't sent: ${sent.error}. Send it again with send_message.` };
    }
    this.log("refresh_context", "ok", `${how} ${s.name ?? s.id}`, { sessionId: s.id, taskId: a.taskId ?? null, reason });
    return { ok: true, result: { refreshed: how } };
  }

  /**
   * The outbox's transport-time check for a coordinator message. A human approval counts only for
   * the exact approved proposal and payload; everything else re-runs the full dispatch gate.
   */
  authorizeDelivery(sessionId: string, text: string, ctx: DispatchContext | undefined) {
    if (!ctx) throw Error("coordinator message without a dispatch context");
    if (ctx.launch) {
      // A launch brief: only into a new worker inside the folder its task's live reservation pinned.
      if (this.mode !== "active") throw Error("Coordinator is paused or off");
      if (this.budget.exhausted) throw Error("Daily budget reached");
      const r = this.d.coordination.reservation(ctx.launch);
      if (!r || (r.state !== "reserved" && r.state !== "launching")) throw Error("no live launch reservation for this brief");
      const s = this.d.sessions().get(sessionId);
      const cwd = ctx.launchCwd;
      if (!s?.cwd || !cwd || !(s.cwd === cwd || s.cwd.startsWith(cwd + "/"))) throw Error("the brief's session isn't the reserved worker");
      // Exactly the process the launcher started (a same-named or same-folder session doesn't qualify).
      if (!ctx.launchPid || s.pid !== ctx.launchPid || s.pidConfidence !== "confirmed") throw Error("the brief's session isn't the process this launch started");
      if (this.excluded.has(sessionId)) throw Error("Session is excluded from coordination");
      return;
    }
    if (ctx.maintenance) {
      // Only the exact command may go through this way: no other text can ride on it.
      const okText = ctx.maintenance === "clear" ? text === "/clear" : /^\/compact( [^\n\r]{1,500})?$/.test(text);
      if (!okText) throw Error("maintenance delivery must be exactly /compact [focus] or /clear");
      this.assertMaintenance(sessionId, ctx.proposalId);
      return;
    }
    let approved = false;
    if (ctx.humanApproved) {
      const p = ctx.proposalId !== null ? this.proposal(ctx.proposalId) : null;
      const brief = p?.kind === "action" && p.payload?.action === "refresh_context" ? String(p.payload.brief ?? "") : null;
      if (!p || (p.kind !== "send_message" && brief === null) || p.state !== "approved" || p.sessionId !== sessionId || withPrefix(brief ?? p.text).trim() !== text)
        throw Error("the human approval doesn't match this message");
      approved = true;
    }
    const task = this.assertDispatch(sessionId, ctx.taskId, approved);
    if (ctx.taskId !== null && task.id !== ctx.taskId) throw Error("the checked task changed before delivery");
  }

  /** Public gate for delivery/auth integration. A human proposal approval is one scoped action, not autopilot. */
  assertDispatch(sessionId: string, taskId?: string | null, humanApproved = false) {
    if (this.mode !== "active") throw Error("Coordinator is paused or off; no dispatch");
    if (this.budget.exhausted) throw Error("Daily budget reached");
    if (this.excluded.has(sessionId)) throw Error("Session is excluded from coordination");
    if (!humanApproved) this.requireAutonomous(sessionId, "message");
    const task = this.taskFor(sessionId, taskId);
    if (!task) throw Error("Dispatch needs a task under a human grant");
    this.d.coordination.checkDispatch(task.id, sessionId);
    const held = this.humanHold.get(sessionId);
    if (held && this.now() - held < this.d.cfg.limits.humanHoldMs) throw Error("Human instruction hold is active");
    return task;
  }

  /** Task bookkeeping for a session. The user's hold doesn't apply: it stops messages, not record-keeping. */
  private requireRouting(sessionId: string) {
    if (this.excluded.has(sessionId)) throw Error("Session is excluded");
    if (!this.launched.has(sessionId) && !this.autopilot.has(sessionId)) throw Error("Outside authority: session is user-driven");
    this.session(sessionId);
  }
  private requireAutonomous(sessionId: string, what: string) {
    if (this.excluded.has(sessionId)) throw new Error(`session ${sessionId} is excluded from coordination`);
    if (!this.autonomous(sessionId))
      throw new Error(`outside authority: can't ${what} ${sessionId} (the user drives it). Use propose_action.`);
  }

  /** The single gate for every outgoing coordinator message. Order matters: cheap refusals first. */
  async sendMessage(
    sessionId: unknown,
    raw: string,
    reason: string,
    taskId: string | null,
    tool = "send_message",
    humanApproved = false,
    proposalId: number | null = null,
  ): Promise<ToolResult> {
    const ctx = { sessionId: typeof sessionId === "string" ? sessionId : null, taskId, reason };
    const refuse = (why: string, outcome: CoordinatorActivity["outcome"] = "refused"): ToolResult => {
      this.log(tool, outcome, why, ctx);
      return { ok: false, error: why };
    };
    const s = this.session(sessionId);
    if (this.mode !== "active") return refuse("Coordinator is paused or off");
    if (this.budget.exhausted) return refuse("Daily budget reached");
    const L = this.d.cfg.limits;
    if (!raw.trim()) return refuse("empty message");
    if (s.execution === "ended") return refuse("session has ended");
    if (this.excluded.has(s.id)) return refuse("session is excluded from coordination");
    const held = this.humanHold.get(s.id);
    if (held && this.now() - held < L.humanHoldMs)
      return refuse(
        `the user messaged this session ${Math.round((this.now() - held) / 60_000)} min ago: human instructions win; hold for ${Math.ceil((L.humanHoldMs - (this.now() - held)) / 60_000)} more min`,
      );
    const hop = this.wakeHop + 1;
    if (hop > L.maxRelayHops) {
      this.setMode("paused", "loop prevention");
      this.d.escalate(
        s.id,
        "Coordinator halted: relay chain too long",
        `A chain of ${hop} agent-to-agent relays was cut at ${L.maxRelayHops}. The coordinator is paused.`,
      );
      return refuse(`relay hop cap (${L.maxRelayHops}) reached: halted and flagged the user`);
    }
    const text = withPrefix(raw);
    const gate = checkSend(this.sent, s.id, text, L, this.now());
    if (!gate.ok) return refuse(gate.reason, gate.outcome);
    const destructive = screenDestructive(text);
    if (destructive && !humanApproved)
      return {
        ok: true,
        result: {
          held: true,
          proposal: this.propose({
            kind: "send_message",
            sessionId: s.id,
            taskId,
            title: `Message to ${s.name ?? s.id} (matched "${destructive}")`,
            text,
            reason,
            heldBecause: "destructive_screen",
          }),
          note: `held for the user's approval: the best-effort destructive-intent screen matched "${destructive}"`,
        },
      };
    if (!humanApproved && !this.autonomous(s.id))
      return {
        ok: true,
        result: {
          proposed: true,
          proposal: this.propose({
            kind: "send_message",
            sessionId: s.id,
            taskId,
            title: `Message to ${s.name ?? s.id}`,
            text,
            reason,
            heldBecause: "outside_authority",
          }),
          note: "the user drives this session: sent to them as a proposal",
        },
      };
    const key = `send:${s.id}`;
    if (!this.retries.allowed(key, this.now())) return refuse(`retry limit: ${L.maxRetries} failed sends to this session in the last hour`);
    const checked = this.assertDispatch(s.id, taskId, humanApproved);
    // Count attempts before dispatch, including ambiguous outcomes. Concurrent requests and
    // daemon restarts cannot bypass the cooldown while the first transport is pending.
    this.recordSent(s.id, text);
    // The outbox rechecks exactly this task and approval right before transport (authorizeDelivery).
    const r = await this.d.send(s.id, text, { taskId: checked.id, proposalId: humanApproved ? proposalId : null, humanApproved });
    if (!r.ok) {
      this.retries.fail(key, this.now());
      return refuse(`send failed: ${r.error ?? "unknown"}`, "error");
    }
    this.retries.clear(key);
    this.log(tool, "ok", clip(text, 400), ctx);
    return { ok: true, result: { sent: true, hop } };
  }

  /** `plan`: set only by pumpPlans for a task of an approved plan, with the model the human was shown. */
  private async doLaunch(a: any, approved: boolean, plan?: { model: string; effort: string | null }): Promise<ToolResult> {
    const c = this.d.coordination;
    const ctx = { taskId: a.taskId ?? null, reason: a.reason ?? null };
    const fail = (why: string, outcome: CoordinatorActivity["outcome"] = "refused"): ToolResult => {
      this.log("launch_session", outcome, why, ctx);
      return { ok: false, error: why };
    };
    const t = c.task(a.taskId);
    if (!t) return fail("launch_session needs an existing taskId");
    if (this.mode !== "active" || this.budget.exhausted) return fail("Coordinator paused/off or daily budget reached");
    if (!t.objectiveId) return fail("launch_session is only for tasks under an objective");
    if (!plan && this.planObjective(t.objectiveId))
      return fail("this task belongs to an approved plan: only the plan launches it, as the user approved it");
    if (plan && a.tier) return fail("a plan task launches at its approved tier");
    if (t.status === "verified") return fail("Task is verified; only the human may reopen it");
    if (t.owner && this.excluded.has(t.owner)) return fail("Task owner is excluded");
    let grant;
    try {
      grant = c.assertTaskReady(t);
    } catch (e) {
      return fail((e as Error).message);
    }
    const provider: "claude" | "codex" = a.provider === "codex" ? "codex" : "claude";
    let tier = t.tier;
    if (a.tier && a.tier !== t.tier) {
      const r = resolveTier({ title: t.title, description: t.description, paths: t.scope.paths }, this.d.cfg.tierRules, {
        tier: a.tier,
        reason: a.tierReason,
      });
      tier = r.tier;
      c.updateTask(t.id, { tier, tierReason: r.reason }, "coordinator");
    }
    if (this.launchLoad() >= this.d.cfg.limits.maxLaunched)
      return fail(`cap reached: ${this.d.cfg.limits.maxLaunched} coordinator-launched sessions are live`);
    const key = `launch:${t.id}`;
    if (!this.retries.allowed(key, this.now()))
      return fail(`retry limit: ${this.d.cfg.limits.maxRetries} failed launches for this task in the last hour`);
    if (!this.d.launch) return fail("launching is not available (no VS Code bridge)");
    const repo = String(a.repo ?? a.cwd ?? "");
    if (!repo.startsWith("/")) return fail("repo must be an absolute path");
    if (canonical(repo) !== grant.root) return fail("Launch repository is outside human grant");
    if (!approved) {
      // Held for the user, before anything is created: a destructive-looking brief (best-effort
      // screen over the coordinator's own text, not our fixed footer), or no worktree isolation.
      const destructive = screenDestructive(`${String(a.prompt ?? "")}\n${t.title}\n${t.description}`);
      if (destructive || a.worktree === false) {
        const why = destructive ? `matched "${destructive}"` : "no worktree: it would share a working tree";
        const proposal = this.propose({
          kind: "launch_session",
          sessionId: null,
          taskId: t.id,
          title: `Launch a ${tier} worker for task ${t.id} (${why})`,
          text: String(a.prompt ?? t.description),
          reason: String(a.reason ?? ""),
          heldBecause: destructive ? "destructive_screen" : "outside_authority",
          payload: a,
        });
        return { ok: true, result: { held: true, proposal, note: `held for the user's approval: ${why}` } };
      }
    }
    // From here on only the validated grant root is used. The caller's `repo` string may be a
    // symlink that a worker repoints between this check and the git/provider calls below.
    let cwd = grant.root;
    let reservation: ReturnType<Coordination["reserveLaunch"]>;
    try {
      reservation = c.reserveLaunch(t.id, grant.root);
    } catch (e) {
      this.retries.fail(key, this.now());
      return fail(`launch failed: ${(e as Error).message}`, "error");
    }
    // Until the provider is invoked, a failure provably launched nothing: release everything.
    // After that, the outcome is uncertain: keep the reservation and claims for the human.
    let providerInvoked = false,
      finished = false;
    try {
      if (a.worktree !== false) {
        if (!this.d.createWorktree) throw Error("worktree creation unavailable");
        cwd = await this.d.createWorktree(grant.root, worktreeSlug(t.id, t.title), grant.rootId);
      }
      // The worker directory is never re-resolved: it must already be canonical (a symlink swapped
      // in after creation is refused, not followed). Its identity is pinned here; this exact
      // directory is recorded, launched into, bound and later read for file checks.
      if (canonical(cwd) !== cwd) throw Error(`Worker directory ${cwd} resolves through a symlink; refusing to launch there`);
      const cwdId = dirIdentity(cwd);
      // After the await: the grant root must still be the granted directory (checkReservation
      // re-runs requireGrant, which compares its inode), and a worktree-less worker gets exactly it.
      c.checkReservation(reservation);
      if (a.worktree === false && cwdId !== grant.rootId) throw Error("Granted root changed while preparing the launch");
      verifyDir(cwd, cwdId, "Worker directory");
      if (this.mode !== "active" || this.budget.exhausted) throw Error("Coordinator stopped before launch");
      const m = modelFor(this.d.cfg, tier, provider);
      if (plan && (m.model !== plan.model || (m.effort ?? null) !== (plan.effort ?? null)))
        throw Error(`Settings now resolve ${m.model} instead of the approved ${plan.model}`);
      const workerScope = [...t.scope.paths, ...t.scope.resources.filter((r) => r.startsWith("path:")).map((r) => r.slice(5))].map((path) =>
        resolve(cwd, relative(grant.root, path)),
      );
      const prompt = withPrefix(
        `${String(a.prompt ?? "").trim() || t.description}\n\nTask ${t.id}: ${t.title}\nAcceptance criteria:\n${t.acceptance.map((x) => `- ${x}`).join("\n")}${workerScope.length ? `\nScope in this working tree: ${workerScope.join(", ")}` : ""}\nWork only inside ${cwd}. Never discard, reset or force-push anyone's work. When done, reply with what you did and how you verified it (tests or commands run and their results).`,
      );
      const name = `sb-${t.id}-${tier}`;
      c.updateReservation({ ...reservation, state: "launching", cwd, cwdId });
      reservation = { ...reservation, cwd, cwdId };
      providerInvoked = true;
      const sessionId = await this.d.launch({ provider, cwd, name, model: m.model, effort: m.effort, prompt, taskId: t.id });
      const valid = c.finishLaunch(reservation, sessionId, cwd);
      finished = true;
      if (!valid) {
        const detail = `Worker ${sessionId} started after its task or grant changed. Human changes were preserved; inspect the worker and retained claims before continuing.`;
        this.d.escalate(sessionId, "Launch needs inspection", detail);
        return fail(detail, "error");
      }
      this.retries.clear(key);
      this.launched.set(sessionId, { sessionId, objectiveId: t.objectiveId, taskId: t.id, tier, at: this.now() });
      this.sent.push({ sessionId, at: this.now(), text: prompt });
      this.persist();
      this.log(
        "launch_session",
        "ok",
        `${provider} ${m.model}${m.effort ? ` (${m.effort})` : ""} at tier ${tier} in ${cwd}${approved ? " (approved)" : ""} → ${sessionId}`,
        { ...ctx, sessionId },
      );
      return { ok: true, result: { sessionId, cwd, model: m.model, effort: m.effort, tier } };
    } catch (e) {
      const msg = (e as Error).message;
      this.retries.fail(key, this.now());
      if (!providerInvoked) {
        c.abandonReservation(reservation, msg);
        return fail(`launch failed before any worker started (reservation and claims released): ${msg}`, "error");
      }
      if (!finished) {
        c.updateReservation({ ...reservation, state: "uncertain", cwd, detail: msg });
        this.d.escalate(
          null,
          "Launch reservation needs a look",
          `A worker for task ${t.id} "${clip(t.title, 80)}" may or may not have started in ${cwd} (${msg}). Its reservation and claims are held. Check whether a worker is running there, then clear the reservation as launched or not launched.`,
        );
      }
      return fail(`launch failed: ${msg}`, "error");
    }
  }
}
