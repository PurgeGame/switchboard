// The coordinator agent, daemon side: mode, authority, the MCP tool implementations, the
// enforcement rules, wake digests, proposals and the activity log. Everything durable is in
// SQLite; the LLM process (runtime.ts) is disposable and gets a state digest when it restarts.
import { worktreeSlug } from "./worktree.ts";
import { canSuspectStall } from "../state.ts";
import { contextPct } from "../../shared/models.ts";
import type { Database } from "bun:sqlite";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { PerspectiveGroup, DispatchContext,
  Objective,
  CoordinatorActivity,
  CoordinatorChatEntry,
  CoordinatorMode,
  CoordinatorProposal,
  CoordinatorState,
  SbEvent,
  Session,
  StallCheck,
  Task,
  Tier,
  UsageSnapshot,
  WorkerRecommendation,
} from "../../shared/types.ts";
import type { Coordination } from "../coordination.ts";
import { runtimeSelection, validateAutoEndSettings, validateUsageRecommendationSettings, type CoordinatorConfig } from "./config.ts";
import { AUTO_END_HUMAN_HOLD_MS, AUTO_END_INTERVAL_MS, type EndGuard } from "./auto-end.ts";
import {
  Budget,
  PREFIX,
  READ_ONLY_TOOLS,
  RepeatDetector,
  RetryLimiter,
  SCREEN_LABEL,
  checkSend,
  screenDestructive,
  similarity,
  withPrefix,
  type SentRecord,
} from "./policy.ts";
import { recommendWorker } from "./recommendations.ts";
import { modelFor, resolveTier } from "./tiers.ts";
import { PROMPT_FILE, type RuntimeLike } from "./runtime.ts";
import { compactState } from "./state-view.ts";
import { EXTERNAL_TOOLS, EXTERNAL_TOOL_NAMES, TOOLS, TOOL_NAMES, USER_CHAT_TOOLS } from "./tools.ts";
import { readFileSync } from "node:fs";
import { approvedSnapshot, planDigest, planDrift, planOrder, taskDrift, validatePlan, type PlanPayload, type PlanRecord, type PlanTask } from "./plans.ts";
import { compactUsage } from "../usage.ts";
import { AUTO_TEMPLATE } from "../autocontinue.ts";
import { canonical, dirIdentity, resourceKey, verifyDir, within } from "../grants.ts";
import { CoordinatorMemory, validateLessonText } from "./memory.ts";
import type { LessonInput } from "../../shared/coordinator-memory.ts";

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
  reportStall?: (sessionId: string, checkId: string, status: "working" | "stuck", reason: string, suggestedAction?: string) => unknown;
  escalate: (sessionId: string | null, title: string, text: string) => void;
  /**
   * Deliver the user's own chat message (verbatim, with its images) to a session the coordinator
   * picked. The words are the human's; the coordinator only chooses the destination.
   */
  route?: (sessionId: string, text: string, images: string[], chatId: number) => Promise<{ ok: boolean; error?: string }>;
  /** A perspective group (answers and synthesis), for the coordinator to summarize. */
  group?: (id: string) => PerspectiveGroup | null | undefined;
  groups?: () => PerspectiveGroup[];
  /** Fan one prompt out to several new sessions (Claude and/or Codex) and compare their answers. */
  askSeveral?: (prompt: string, cwd: string, members: { provider: "claude" | "codex"; model?: string }[]) => Promise<{ id: string }>;
  /** Context maintenance: type /compact [focus] or /clear into a Claude session, or compact a Codex thread natively. */
  maintain?: (sessionId: string, command: "compact" | "clear", focus: string | null, ctx: DispatchContext) => Promise<{ ok: boolean; error?: string }>;
  /** End a session (types its exit command, or signals the agent process): close_session, for idle workers it launched. */
  end?: (sessionId: string, guard?: EndGuard) => Promise<{ ok: boolean; how?: string; error?: string; releasedClaims?: number[] }>;
  /** Fresh process and pending-input checks; absence disables automatic ending. */
  autoEndBlocker?: (s: Session) => string | null;
  worktreeState?: (cwd: string | null) => Promise<"clean" | "dirty" | "unknown">;
  governor?: GovernorLike | null;
  /** Claude and Codex rate-limit usage (src/daemon/usage.ts). */
  usage?: () => UsageSnapshot;
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
  data?: { checkId: string; silentForMs: number; lastStep: string }
    | { taskId: string; note: string; outboxId?: number; deliveryState?: string };
}
interface CoordinatorTurn { body: string; origin: "user" | "event"; images: string[]; relayHop: number }

/** A launch with no session in its folder this long after it was reserved never started one. */
const UNSETTLED_GRACE_MS = 3 * 60_000;
/** A lesson's source citation: a chat/event/proposal/activity/plan number, a task or session id, or the Settings default. */
const CITATION = /\b(?:chat|event|proposal|activity|plan)\s*#?\d+\b|\b(?:task|session)\s+[0-9a-f]{8}(?:-[0-9a-f]{4,12}){0,4}\b|\buser: Settings\b/gi;

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
/** Like clip, but keeps line breaks: chat messages have paragraphs and lists. */
const clipText = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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
  /** Why the coordinator process last failed to start (cleared by the next start), shown in the UI. */
  private runtimeError: string | null = null;
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
  private queuedTurns: CoordinatorTurn[] = [];
  private activeTurn: CoordinatorTurn | null = null;
  /** Who started the turn now running: only replies to the user's own messages go to the chat. */
  private turnOrigin: "user" | "event" = "event";
  /** Text the coordinator just routed into a session, so its arrival isn't mistaken for the user typing there. */
  private routedEcho = new Map<string, string>();
  private taskStatus = new Map<string, string>();
  private budgetFlagged = false;
  /** Counts the times the mode became active: a chat message from an earlier period can't serve as userChat. */
  private activePeriod = 0;
  /** Successful calls each chat message has authorized (userChat), capped by limits.userChatMaxActions. */
  private chatUses = new Map<number, number>();
  /** Which chat message last lifted a task's failed-launch limit: one retry per instruction. */
  private retryLiftedBy = new Map<string, number>();
  /** Tasks whose launch is running in this process right now (their reservation isn't stuck). */
  private inFlight = new Set<string>();
  /** The brief each unsettled launch typed into its worker: only a session that started with it can be linked as that worker. */
  private launchBriefs = new Map<string, { provider: "claude" | "codex"; prompt: string }>();
  /** Approved delegation plans (D32): the daemon launches their tasks as they become ready. */
  private plans: PlanRecord[] = [];
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private idleSince = new Map<string, number>();
  private closing = new Set<string>();
  private autoEnded = new Set<string>();
  private dirtyWorkers = new Set<string>();
  private autoEndFailures = new Map<string, string>();
  private sweeping = false;
  private readonly startedAt: number;
  private now: () => number;
  runtime: RuntimeLike | null;
  readonly memory: CoordinatorMemory;

  constructor(private d: CoordinatorDeps) {
    this.now = d.now ?? Date.now;
    this.memory = new CoordinatorMemory(d.db, this.now);
    d.coordination.session = (id) => d.sessions().get(id);
    // Rejecting its own task frees only the claims it could release itself (D37).
    d.coordination.coordinatorMayRelease = (owner) => this.runs(owner);
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
    d.cfg.usageRecommendations = validateUsageRecommendationSettings(this.kv("usageRecommendations", d.cfg.usageRecommendations));
    d.cfg.autoEnd = validateAutoEndSettings(this.kv("autoEnd", d.cfg.autoEnd));
    this.autoEnded = new Set(this.kv<string[]>("autoEnded", []));
    this.dirtyWorkers = new Set(this.kv<string[]>("dirtyWorkers", []));
    for (const t of d.coordination.snapshot().tasks) this.taskStatus.set(t.id, t.status);
    this.kind = d.cfg.agent === "external" ? "external" : "builtin";
    if (this.kind === "external" && d.runtime) throw new Error("an external coordinator has no runtime: the daemon never starts a model for it");
    this.runtime = d.runtime ?? null;
    if (this.runtime) this.wireRuntime(this.runtime);
    if (this.kind === "builtin" && this.mode === "active" && (this.activeTurn || this.queuedTurns.length || this.pending.length))
      this.enqueue({ kind: "recovery", sessionId: null, text: "The daemon restarted with unfinished turns. Reconcile durable state before continuing." }, 2000);
    if (d.timers !== false) setInterval(() => this.heartbeat(), d.cfg.heartbeatMs).unref?.();
    if (d.timers !== false) setInterval(() => void this.sweepIdleWorkers().catch((e) => console.error("[auto-end]", e)), AUTO_END_INTERVAL_MS).unref?.();
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
    this.hops = new Map(this.kv<[string, number][]>("hops", []));
    this.wakeHop = this.kv<number>("wakeHop", 0);
    this.myClaims = new Set(this.kv<number[]>("claims", []));
    this.humanHold = new Map(this.kv<[string, number][]>("humanHold", []));
    this.taskHold = new Map(this.kv<[string, number][]>("taskHold", []));
    this.budget.restore(this.kv("budget", {}));
    this.plans = this.kv<PlanRecord[]>("plans", []);
    this.activePeriod = this.kv<number>("activePeriod", 0);
    this.chatUses = new Map(this.kv<[number, number][]>("chatUses", []));
    this.launchBriefs = new Map(this.kv<[string, { provider: "claude" | "codex"; prompt: string }][]>("launchBriefs", []));
    // External agents keep their existing polling contract: state is rebuilt on reconnect.
    this.pending = this.d.cfg.agent === "external" ? [] : this.kv("pending", []);
    this.queuedTurns = this.kv("queuedTurns", []);
    this.activeTurn = this.kv("activeTurn", null);
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
    this.setKv("activePeriod", this.activePeriod);
    this.setKv("chatUses", [...this.chatUses].slice(-50));
    this.setKv("launchBriefs", [...this.launchBriefs].slice(-50));
    this.persistTurns();
  }

  private persistTurns() {
    this.d.db.transaction(() => {
      this.setKv("pending", this.pending);
      this.setKv("queuedTurns", this.queuedTurns);
      this.setKv("activeTurn", this.activeTurn);
      this.setKv("hops", [...this.hops]);
      this.setKv("wakeHop", this.wakeHop);
    })();
  }

  log(
    action: string,
    outcome: CoordinatorActivity["outcome"],
    detail: string,
    x: { sessionId?: string | null; taskId?: string | null; reason?: string | null; userChat?: number | null } = {},
  ): CoordinatorActivity {
    const a: Omit<CoordinatorActivity, "id"> = {
      at: this.now(),
      action,
      sessionId: x.sessionId ?? null,
      taskId: x.taskId ?? null,
      reason: x.reason ?? null,
      outcome,
      // Every action run on the user's chat instruction names that message.
      detail: action === "permission_auto_approval" ? detail : clip(x.userChat ? `[chat #${x.userChat}] ${detail}` : detail, 2000),
      ...(x.userChat ? { userChat: x.userChat } : {}),
    };
    const r = this.d.db.query("INSERT INTO coord_activity (data) VALUES (?) RETURNING id").get(JSON.stringify(a)) as { id: number };
    if (["refused", "error", "dropped"].includes(outcome) && action !== "runtime")
      this.memory.reflect("daemon_refusal", `activity #${r.id}`, `${action}: ${clip(detail, 240)}`);
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
  private addChat(role: CoordinatorChatEntry["role"], text: string, images: string[] = [], extra: Partial<CoordinatorChatEntry> = {}): number {
    const entry = { at: this.now(), role, text: clipText(text, 8000), ...(images.length ? { images } : {}), ...extra };
    const r = this.d.db.query("INSERT INTO coord_chat (data) VALUES (?) RETURNING id").get(JSON.stringify(entry)) as { id: number };
    this.changed();
    return r.id;
  }
  private chatEntry(id: number): CoordinatorChatEntry | null {
    const r = this.d.db.query("SELECT id, data FROM coord_chat WHERE id = ?").get(id) as { id: number; data: string } | null;
    return r ? { id: r.id, ...JSON.parse(r.data) } : null;
  }

  /**
   * userChat: the coordinator says the user asked for this call in chat message #N, so it runs as
   * the user's own action, with no card. It counts only for a message the user typed into this chat
   * (role user: only the human chat route writes those; never a transcript, tool output or the
   * coordinator's own lines), with no pasted text, sent while the coordinator was active and not
   * paused since. `recent`: also within userChatMaxAgeMs and among the user's last userChatMaxBack
   * messages (checked when the call is made; the transport-time recheck skips it). Returns the id.
   */
  private chatAuthority(raw: unknown, recent = true): number {
    const id = typeof raw === "number" ? raw : typeof raw === "string" && /^#?\d{1,12}$/.test(raw.trim()) ? Number(raw.trim().replace("#", "")) : NaN;
    const no = (why: string) =>
      new Error(`userChat ${Number.isSafeInteger(id) ? `#${id}` : JSON.stringify(raw)} doesn't count as the user's go-ahead: ${why}. Call again without userChat to put it to the user as a card`);
    if (!Number.isSafeInteger(id) || id <= 0) throw no("it isn't a chat #");
    const e = this.chatEntry(id);
    if (!e || e.role !== "user") throw no("it isn't one of the user's own messages in this chat");
    if (e.pasted || /<\/?pasted_content/i.test(e.text)) throw no("it contains pasted text, not only the user's own words");
    if (e.images?.length) throw no("it has attached images (pasted content)");
    if (e.mode !== "active") throw no("you weren't active when it was sent");
    if (e.activePeriod !== this.activePeriod) throw no("you were paused or off since it was sent");
    if (recent) {
      const L = this.d.cfg.limits;
      if (this.now() - e.at > L.userChatMaxAgeMs) throw no(`it's over ${Math.round(L.userChatMaxAgeMs / 60_000)} min old`);
      const last = this.d.db
        .query("SELECT id FROM coord_chat WHERE json_extract(data,'$.role')='user' ORDER BY id DESC LIMIT ?")
        .all(L.userChatMaxBack) as { id: number }[];
      if (!last.some((r) => r.id === id)) throw no(`it isn't one of the user's last ${L.userChatMaxBack} messages`);
      // One instruction is a handful of calls, not a standing authority.
      if ((this.chatUses.get(id) ?? 0) >= L.userChatMaxActions) throw no(`it has already been used for ${L.userChatMaxActions} actions`);
    }
    return id;
  }

  /**
   * userChat on a grant (create_objective, propose_plan) skips the card only for a folder the user's
   * message names: its absolute path, its ~/ path, or its folder name as a whole word (any case; not
   * inside another word or file name), or one an existing active grant already covers. Otherwise
   * the call is a card, as without userChat: the coordinator can't grant a folder of its choosing.
   */
  private chatCoversRoot(chat: number, root: string): boolean {
    const r = root.replace(/(.)\/+$/, "$1");
    if (this.d.coordination.snapshot().objectives.some((o) => o.grant && !o.grant.revokedAt && within(r, o.grant.root))) return true;
    const text = this.chatEntry(chat)?.text ?? "";
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A path ends at the text's end, a slash, or anything that can't continue a name.
    const path = (p: string) => new RegExp(`(?<![\\w.~/-])${esc(p)}(?![\\w-]|\\.\\w)`).test(text);
    const home = homedir();
    if (path(r) || (r.startsWith(`${home}/`) && path(`~/${r.slice(home.length + 1)}`))) return true;
    const name = basename(r);
    return !!name && new RegExp(`(?<![\\w.-])${esc(name)}(?![\\w-]|\\.\\w)`, "i").test(text);
  }

  /** The user's hold on a session (they typed there) while it lasts, unless their chat instruction came after it. */
  private holdActive(sessionId: string, chat: number | null = null): number | null {
    const held = this.humanHold.get(sessionId);
    if (!held || this.now() - held >= this.d.cfg.limits.humanHoldMs) return null;
    if (chat !== null && (this.chatEntry(chat)?.at ?? 0) > held) return null;
    return held;
  }

  /**
   * close_session: end an idle worker the coordinator launched once every task it had is verified
   * or rejected. Its launch slot frees now (queued plan tasks go) and any claims it still holds are
   * released. Never a session the user drives, one that's busy or waiting, or one with open work.
   */
  private async closeSession(sessionId: string, reason: string) {
    const s = this.session(sessionId);
    if (this.excluded.has(s.id)) throw new Error(`session ${s.id} is excluded from coordination`);
    const l = this.launched.get(s.id);
    if (!l) throw new Error("you can only close workers you launched; the user closes their own sessions");
    if (s.execution === "ended") return { closed: true, already: "ended" };
    if (s.execution !== "idle") throw new Error(`it's ${s.execution.replace("_", " ")}: close it only when it's idle`);
    if (this.holdActive(s.id)) throw new Error("the user messaged it recently: it's theirs to close");
    const c = this.d.coordination;
    const open = c.snapshot().tasks.filter((t) => (t.owner === s.id || t.id === l.taskId) && t.status !== "verified" && t.status !== "rejected");
    if (open.length) throw new Error(`its work isn't finished: task ${open[0].id} is ${open[0].status} (close it once its tasks are verified or rejected)`);
    return this.endWorker(s, reason);
  }

  /** Both close_session and daemon cleanup use this shutdown and claim/slot release path. */
  private async endWorker(s: Session, reason: string, guard?: EndGuard) {
    if (!this.d.end) throw new Error("closing sessions isn't available");
    if (this.closing.has(s.id)) throw new Error("session is already closing");
    this.closing.add(s.id);
    try {
      if (guard) {
        const blocked = await guard();
        if (blocked) throw new Error(blocked);
      }
      const taskId = this.launched.get(s.id)?.taskId ?? null;
      const r = await this.d.end(s.id, guard);
      if (!r.ok) throw new Error(`couldn't close it: ${r.error ?? "unknown"}`);
      const released = [...new Set([...(r.releasedClaims ?? []), ...this.onSessionClosed(s.id)])];
      if (guard) {
        this.autoEnded.add(s.id);
        this.setKv("autoEnded", [...this.autoEnded]);
      }
      this.persist();
      this.log(guard ? "auto_end_session" : "close_session", "ok", `closed ${s.name ?? s.id} (${r.how ?? "ended"}); released ${released.length} claim(s)`, { sessionId: s.id, taskId, reason });
      if (this.plans.some((p) => p.tasks.some((x) => x.state === "waiting"))) void this.pumpPlans();
      return { closed: true, how: r.how ?? null, releasedClaims: released };
    } finally {
      this.closing.delete(s.id);
    }
  }

  /** Human-only Settings route. Changes apply now and survive daemon restarts. */
  usageRecommendationSettings() { return { ...this.d.cfg.usageRecommendations }; }

  setUsageRecommendationSettings(value: unknown) {
    this.d.cfg.usageRecommendations = validateUsageRecommendationSettings(value);
    this.setKv("usageRecommendations", this.d.cfg.usageRecommendations);
    this.log("usage_recommendation_settings", "info", "User updated usage recommendation thresholds");
    this.changed();
    return this.usageRecommendationSettings();
  }

  private saveRecommendation(t: Task, recommendation: WorkerRecommendation, preserveTier = false) {
    // Avoid a coordination-change/pump loop while a plan is waiting on unchanged usage.
    const old = t.recommendation;
    if (old && JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...recommendation, at: 0 })) return;
    this.d.coordination.updateTask(t.id, { recommendation,
      ...(!preserveTier ? { tier: recommendation.tier, tierReason: recommendation.reason } : {}) }, "coordinator");
  }

  setAutoEndSettings(value: unknown) {
    this.d.cfg.autoEnd = validateAutoEndSettings(value);
    this.setKv("autoEnd", this.d.cfg.autoEnd);
    this.idleSince.clear(); // enabling/changing the grace period starts a fresh observation
    this.log("auto_end_settings", "info", `auto-end ${this.d.cfg.autoEnd.enabled ? "enabled" : "disabled"}; idle grace ${this.d.cfg.autoEnd.idleMinutes} min (by user)`);
    this.changed();
  }

  /** Observe actual execution transitions, including brief turns between cleanup ticks. */
  onSessionExecution(s: Session) {
    if (s.execution !== "idle" || s.executionConfidence !== "confirmed" || s.turnStartedAt !== null) this.idleSince.delete(s.id);
    else if (!this.idleSince.has(s.id)) this.idleSince.set(s.id, this.now());
  }

  /** Draft typing is activity even before a message is submitted. No wake or log per keystroke. */
  onHumanTyping(sessionId: string) {
    this.humanHold.set(sessionId, this.now());
    this.idleSince.delete(sessionId);
    this.setKv("humanHold", [...this.humanHold]);
  }

  private completedWork(s: Session): string | null {
    const tasks = this.d.coordination.snapshot().tasks;
    const owned = tasks.filter((t) => t.owner === s.id);
    const terminal = (t: Task) => t.status === "verified" || t.status === "rejected";
    // A recorded launch's task also protects against closing a worker after reassignment.
    const launchTask = tasks.find((t) => t.id === this.launched.get(s.id)?.taskId);
    if (launchTask && !terminal(launchTask)) return null;
    if (owned.length) return owned.every(terminal) ? "all owned tasks are verified or rejected" : null;
    const groups = (this.d.groups?.() ?? []).filter((g) => g.members.some((m) => m.sessionId === s.id));
    if (groups.length && groups.every((g) => g.status === "answered" && (!g.autoSynthesize || g.synthesis.state === "done") && g.synthesis.state !== "running"))
      return "no owned tasks; perspective group is complete";
    const plans = this.plans.filter((p) => p.tasks.some((t) => t.sessionId === s.id));
    if (plans.length && plans.every((p) => p.tasks.length && p.tasks.every((x) => {
      const t = this.d.coordination.task(x.taskId);
      return !!t && terminal(t);
    }))) return "no owned tasks; plan is complete";
    return null;
  }

  private autoEndReason(s: Session): string | null {
    if (this.mode !== "active" || !this.d.cfg.autoEnd.enabled || this.excluded.has(s.id) || this.isSelf(s) || this.autoEnded.has(s.id)) return null;
    const background = this.d.groups?.().some((g) => g.background && g.members.some((m) => m.sessionId === s.id));
    if (!this.launched.has(s.id) && !this.autopilot.has(s.id) && !background) return null;
    if (s.execution !== "idle" || s.executionConfidence !== "confirmed" || s.turnStartedAt !== null) return null;
    if (s.subagents?.some((a) => a.status === "running") || s.resources?.running || (s.resources?.procs ?? 0) > 1 || s.resources?.inferred) return null;
    if (s.meta.runningSubagents || (s.meta.onDaemon && s.meta.subagentStateKnown !== true)) return null;
    // Embedded Codex subagent rollouts can share their parent's process.
    if (s.pid && [...this.d.sessions().values()].some((other) => other.id !== s.id && other.pid === s.pid && !["idle", "ended", "failed", "interrupted"].includes(other.execution))) return null;
    const human = this.humanHold.get(s.id);
    if (human !== undefined && this.now() - human < AUTO_END_HUMAN_HOLD_MS) return null;
    const since = this.idleSince.get(s.id);
    if (since === undefined || this.now() - since < this.d.cfg.autoEnd.idleMinutes * 60_000) return null;
    return this.completedWork(s);
  }

  /** Runs without a model wake, even when every worker is idle. Public for deterministic tests. */
  async sweepIdleWorkers() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const s of this.d.sessions().values()) {
        this.onSessionExecution(s);
        const reason = this.autoEndReason(s);
        if (!reason || this.closing.has(s.id) || !this.d.end || !this.d.autoEndBlocker || !this.d.worktreeState) continue;
        const identity = { pid: s.pid, cwd: s.cwd, startedAt: s.startedAt };
        const unchanged = () => this.d.sessions().get(s.id) === s && s.pid === identity.pid && s.cwd === identity.cwd && s.startedAt === identity.startedAt;
        const guard: EndGuard = async () => {
          if (!unchanged() || !this.autoEndReason(s)) return "worker is no longer eligible for auto-end";
          const blocked = this.d.autoEndBlocker!(s);
          if (blocked) return blocked;
          const cwd = s.cwd;
          const tree = await this.d.worktreeState!(cwd);
          // Recheck authority, input, process activity and identity after the asynchronous git read.
          if (!unchanged() || !this.autoEndReason(s)) return "worker changed while checking its worktree";
          if (tree === "dirty") {
            if (!this.dirtyWorkers.has(s.id)) {
              this.dirtyWorkers.add(s.id);
              this.setKv("dirtyWorkers", [...this.dirtyWorkers]);
              this.d.escalate(s.id, "Finished worker has uncommitted changes", `${s.name ?? s.id} was left open because ${cwd} has uncommitted changes. Review and commit the work, or end the session yourself.`);
            }
            return "worktree has uncommitted changes";
          }
          if (tree !== "clean") return "could not verify a clean worktree";
          if (this.dirtyWorkers.delete(s.id)) this.setKv("dirtyWorkers", [...this.dirtyWorkers]);
          return this.d.autoEndBlocker!(s);
        };
        try {
          await this.endWorker(s, `${reason}; idle for at least ${this.d.cfg.autoEnd.idleMinutes} min; no user activity in 30 min`, guard);
          this.autoEndFailures.delete(s.id);
        } catch (e) {
          const message = (e as Error).message;
          if (this.autoEndFailures.get(s.id) !== message) {
            this.autoEndFailures.set(s.id, message);
            this.log("auto_end_session", "refused", message, { sessionId: s.id, reason });
          }
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** UI End and close_session share the same release path, after verified process exit. */
  onSessionClosed(sessionId: string): number[] {
    const released = this.d.coordination.releaseSessionClaims(sessionId);
    this.launched.delete(sessionId);
    this.autopilot.delete(sessionId);
    this.persist();
    this.onSessionEnded(sessionId);
    return released;
  }

  /** userChat: the user's say-so reaches sessions they drive; excluded sessions stay off-limits. */
  private requireIncluded(sessionId: string) {
    if (this.excluded.has(sessionId)) throw new Error(`session ${sessionId} is excluded from coordination`);
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
      runtimeError: this.runtimeError,
      mode: this.mode,
      autoEnd: { ...this.d.cfg.autoEnd },
      model: this.runtime?.selection?.model ?? runtimeSelection(this.d.cfg).model,
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
  /** Every setting that shapes the coordinator, as in effect now, so it never has to guess one. */
  private settings() {
    const { agent, debounceMs, heartbeatMs, autoEnd, limits, tiers, tierRules, usageRecommendations, worktreeRoot } = this.d.cfg;
    return {
      where: "the \"coordinator\" key of ~/.config/switchboard/config.json, read when the daemon starts",
      whoChanges:
        "Only the user. You have no tool that writes settings: they are the user's limits on you. Auto-end and usage recommendation thresholds can be changed live in Settings. Runtime and model can be saved in Settings for the next coordinator start, or applied with Restart coordinator; other settings are edited in config.json.",
      coordinator: { agent, ...(this.runtime?.selection ?? runtimeSelection(this.d.cfg)), debounceMs, heartbeatMs, autoEnd },
      limits,
      tiers,
      tierRules,
      usageRecommendations,
      worktreeRoot,
    };
  }

  isLaunched(sessionId: string): boolean {
    return this.launched.has(sessionId);
  }

  /** The task a worker it launched is for, from its own launch record. */
  launchedTask(sessionId: string): string | null {
    return this.launched.get(sessionId)?.taskId ?? null;
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
    if (mode === "active" && prev !== "active") this.activePeriod++; // older chat no longer counts as userChat
    this.persist();
    this.log("mode", "info", `${prev} → ${mode} (by ${by})${mode === "paused" ? "; workers keep running" : ""}`);
    if (mode === "manual") {
      this.runtime?.stop();
      this.clearWake();
      this.pending = [];
      this.stallWakes.clear();
      this.persistTurns();
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
      this.stallWakes.delete(sessionId);
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
  onHumanMessage(sessionId: string, eventId?: number) {
    this.onHumanTyping(sessionId);
    this.hops.delete(sessionId);
    const n = this.cancelPendingFor(sessionId, "the user messaged this session directly");
    // One signal per session (coalesced), not one per message: someone typing back and forth with
    // a worker would otherwise fill the reflection queue with identical rows.
    if (n || this.relevant(sessionId))
      this.memory.reflect("session_override", `session ${sessionId}`, `The user overrode coordinator work by messaging the session${eventId ? ` (latest: event #${eventId})` : ""}. Review their correction before recording a lesson.`);
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
    if (task.status === "rejected")
      this.memory.reflect("task_rejected", `task ${task.id}`, "The user rejected this task. Consider what should change next time.");
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

  /** Feedback supersedes pending actions, but lets the coordinator arrange recovery immediately. */
  onHumanTaskFeedback(task: Task) {
    this.memory.reflect("task_rejected", `task ${task.id}`, "The user sent this task back with feedback. Review the saved note before recording a lesson.");
    const n = this.cancelPendingFor(task.owner, "the user sent this task back with feedback", task.id);
    this.log("human_override", "info", `user sent back task ${task.id}; ${n} pending action(s) cancelled`, { taskId: task.id, sessionId: task.owner });
  }

  private stallWakes = new Map<string, string>();
  private stallReads = new Map<string, string>();
  private stallCheckpoints = new Map<string, string>();

  onStallSuspected(s: Session, check: StallCheck) {
    if (this.mode !== "active" || this.excluded.has(s.id) || this.isSelf(s) || !canSuspectStall(s)) return;
    if (check.status !== "suspected" || this.stallWakes.get(s.id) === check.id) return;
    this.stallWakes.set(s.id, check.id);
    this.enqueue({
      kind: "stall_suspected", sessionId: s.id,
      data: { checkId: check.id, silentForMs: check.silentForMs, lastStep: check.lastStep },
      text: `checkId=${check.id}; silentForMs=${check.silentForMs}; last step: ${clip(check.lastStep, 300)}. Check get_session; request_checkpoint only if you may message it. Report working or stuck with report_stall.`,
    });
  }

  // ---------------------------------------------------------------- events & wakes
  /** Registry event hook. */
  onEvent(e: SbEvent) {
    const s = this.d.sessions().get(e.sessionId);
    if (s && this.isSelf(s)) return;
    if (e.ts >= this.startedAt && ["turn_started", "turn_ended", "user_msg", "assistant_msg", "tool_call", "tool_result", "needs_input", "queued_input"].includes(e.type)) {
      this.idleSince.delete(e.sessionId);
      if (s && e.type === "turn_ended") this.onSessionExecution(s);
    }
    if (e.type === "user_msg") {
      // Claude Code records a pasted delivery inside <pasted_content> tags; unwrap it before checking whose it is.
      const text = typeof e.data.text === "string" ? e.data.text.replace(/<\/?pasted_content[^>]*>/g, "").trim() : "";
      if (text.startsWith(PREFIX)) return; // never wake on our own messages
      if (text === AUTO_TEMPLATE) return; // auto-continue is daemon policy, not the user
      if (this.routedEcho.get(e.sessionId) === text) {
        this.routedEcho.delete(e.sessionId); // our own routing arriving, not the user typing there
        return;
      }
      // Only a session the coordinator can see and a person can type into: a headless SDK run (a
      // review job's one-shot prompt) or an unknown id isn't human-driven, and mustn't wake it.
      if (!s || ((s.kind === "headless" || String(s.meta.entrypoint ?? "").startsWith("sdk")) && !this.relevant(s.id))) return;
      if (e.ts < this.startedAt) {
        // Replay may contain typing while the daemon was down. Preserve its original timestamp.
        if (e.ts > (this.humanHold.get(e.sessionId) ?? 0)) {
          this.humanHold.set(e.sessionId, e.ts);
          this.setKv("humanHold", [...this.humanHold]);
        }
        return;
      }
      this.onHumanMessage(e.sessionId, e.id);
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

  /**
   * The registry saw a session end (main.ts wires registry.execHooks here; transcripts carry no
   * session_ended event). A worker that ends frees its launch slot, so queued plan tasks go now.
   */
  onSessionEnded(_sessionId: string) {
    if (this.plans.some((p) => p.tasks.some((x) => x.state === "waiting"))) void this.pumpPlans();
  }

  /**
   * A session appeared or changed state (main.ts: registry.execHooks). If it works in the folder of
   * a launch whose outcome was uncertain (the launcher gave up waiting, e.g. a Codex thread that
   * showed up late), it may be that launch's worker: link it when the daemon's checks find exactly
   * one candidate (resolveLaunch).
   */
  linkWorker(s: Session) {
    if (this.mode === "manual" || s.execution === "ended" || !s.cwd || this.launched.has(s.id)) return;
    for (const r of this.d.coordination.reservations())
      if (r.state === "uncertain" && r.cwd && !this.inFlight.has(r.taskId) && this.inDir(s.cwd, r.cwd)) this.autoLink(r.taskId);
  }

  /** Try to settle an uncertain launch on the daemon's own checks; quietly leaves it when they can't tell. */
  private autoLink(taskId: string): boolean {
    try {
      const r = this.resolveLaunch(taskId, null, "linked automatically: the only session working in the launch's folder", true);
      return r.as === "launched";
    } catch {
      return false;
    }
  }

  /** Did this session start with the brief this task's launch typed (the same 1000-character prefix discovery records)? */
  private startedByLaunch(s: Session, taskId: string) {
    const b = this.launchBriefs.get(taskId);
    if (!b || s.provider !== b.provider || !s.firstPrompt) return false;
    return similarity(s.firstPrompt, b.prompt.trim().slice(0, s.firstPrompt.length)) > 0.9;
  }

  private sameDir(cwd: string, dir: string) {
    try {
      return canonical(cwd) === dir;
    } catch {
      return false;
    }
  }

  private inDir(cwd: string, dir: string) {
    try {
      return within(canonical(cwd), dir);
    } catch {
      return false;
    }
  }

  /**
   * Settle a launch whose outcome is unknown (resolve_launch, and automatically when a session
   * shows up in its folder). The checks are the daemon's, not the model's: sessions (not the
   * coordinator's own) working in the reserved folder that started since the reservation was made.
   * - exactly one live one (or the named one), not already some task's worker: it is the worker;
   * - none ever, UNSETTLED_GRACE_MS after the reservation: nothing ran there, so the launch and its
   *   claims are released (never automatically: a late thread must not be mistaken for none);
   * - otherwise (several live, or one that ran and ended): refused, for the coordinator to tell the user.
   */
  private resolveLaunch(taskId: string, sessionId: string | null, reason: string, auto = false): { as: "launched" | "not_launched"; sessionId?: string } {
    const c = this.d.coordination;
    const r = c.reservation(taskId);
    if (!r) throw new Error("this task has no launch to settle");
    if (r.state === "launched") throw new Error("its launch already completed");
    if (this.inFlight.has(taskId)) throw new Error("its launch is still in progress");
    const since = r.at - 5000;
    const here = r.cwd ? [...this.d.sessions().values()].filter((s) => !this.isSelf(s) && !!s.cwd && this.inDir(s.cwd, r.cwd!) && (s.startedAt ?? 0) >= since) : [];
    // A worker runs in the reserved folder itself and started with this launch's brief: a session you
    // opened there yourself is never taken over. Anything in or below the folder counts as "something ran there".
    const free = here.filter(
      (s) => s.execution !== "ended" && !this.launched.has(s.id) && !c.tasksOf(s.id).length && this.sameDir(s.cwd!, r.cwd!) && this.startedByLaunch(s, taskId),
    );
    const t = c.task(taskId);
    const x = this.planTask(taskId);
    let pick: Session | undefined;
    if (sessionId) {
      pick = free.find((s) => s.id === sessionId);
      if (!pick) throw new Error(`${sessionId} isn't a free live session in ${r.cwd} that started with this launch's brief`);
    } else if (free.length === 1) pick = free[0];
    if (pick) {
      c.settleUncertainLaunch(taskId, { as: "launched", sessionId: pick.id }, false);
      this.launchBriefs.delete(taskId);
      this.launched.set(pick.id, { sessionId: pick.id, objectiveId: t?.objectiveId ?? null, taskId, tier: t?.tier ?? "standard", at: this.now() });
      if (x) {
        x.state = "launched";
        x.sessionId = pick.id;
        delete x.error;
      }
      this.persist();
      this.log("resolve_launch", "ok", `${pick.name ?? pick.id} in ${r.cwd} is task ${taskId}'s worker${auto ? " (linked automatically)" : ""}`, { sessionId: pick.id, taskId, reason });
      if (auto) this.enqueue({ kind: "launch_linked", sessionId: pick.id, text: `The uncertain launch of task ${taskId} "${clip(t?.title, 80)}" is settled: ${pick.name ?? pick.id} is working in its folder and is now its worker.` });
      return { as: "launched", sessionId: pick.id };
    }
    if (auto) throw new Error("no single session to link yet");
    if (!here.length) {
      if (this.now() - r.at < UNSETTLED_GRACE_MS) throw new Error(`no session has shown up in ${r.cwd} yet; a slow one can take a few minutes: check again later`);
      c.settleUncertainLaunch(taskId, { as: "not_launched" }, false);
      this.launchBriefs.delete(taskId);
      if (x && x.state === "launched") x.state = "waiting";
      this.persist();
      this.log("resolve_launch", "ok", `no session ever worked in ${r.cwd ?? "the reserved folder"}: launch released`, { taskId, reason });
      if (x?.state === "waiting") void this.pumpPlans();
      return { as: "not_launched" };
    }
    if (free.length > 1) throw new Error(`${free.length} sessions started with this launch's brief in ${r.cwd} (${free.map((s) => s.id).join(", ")}): name the worker with sessionId`);
    throw new Error(`a session worked in ${r.cwd} since the launch and isn't free (${here.map((s) => `${s.id} ${s.execution}`).join(", ")}): its work may be there. Tell the user (flag_user) instead of launching again`);
  }

  /**
   * A live session already working on this task: its owner, the worker recorded for it, or one in
   * the worktree named for it (a relaunch reuses that worktree). A second worker would race it.
   */
  private liveWorkerFor(t: Task): Session | undefined {
    const r = this.d.coordination.reservation(t.id);
    const tag = worktreeSlug(t.id, "");
    const inTaskTree = (cwd: string | null) => {
      if (!cwd) return false;
      const rel = relative(this.d.cfg.worktreeRoot, cwd);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
      const slug = rel.split("/")[1] ?? "";
      return slug === tag || slug.startsWith(`${tag}-`);
    };
    return [...this.d.sessions().values()].find(
      (s) =>
        s.execution !== "ended" &&
        !this.isSelf(s) &&
        (s.id === t.owner || s.id === r?.sessionId || this.launched.get(s.id)?.taskId === t.id || inTaskTree(s.cwd)),
    );
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
        // Never a second worker beside a live one (e.g. a launch cleared as not launched that did start).
        const busy = this.liveWorkerFor(t);
        if (busy) {
          const why = `${busy.name ?? busy.id} is already working in its folder`;
          if (x.error !== why) {
            x.error = why;
            this.persist();
            this.enqueue({ kind: "plan_task_busy", sessionId: busy.id, text: `plan #${plan.proposalId}: task ${t.id} "${clip(t.title, 80)}" isn't launched again because ${why} without being its worker. Check it; tell the user if you can't sort it out.` });
          }
          continue;
        }
        // Its prerequisites are verified: the claims the plan's own workers took for them, inside this
        // task's scope, have served their purpose. Nobody else's claims are touched.
        const workers = new Map(plan.tasks.filter((q) => q.sessionId && x.approved!.prerequisites.includes(q.taskId)).map((q) => [q.taskId, q.sessionId!]));
        c.releaseVerifiedPrerequisiteClaims(t, workers);
        const blocker = c.scopeBlocker(t, true); // plan tasks launch into worktrees of their own
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
        } else if (r.error.startsWith("waiting:")) {
          x.error = r.error; // Usage holds consume no launch retry and remain queued.
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
        this.memory.reflect("plan_finished", `proposal #${plan.proposalId}`, `Plan finished. Review provider/tier outcomes: ${plan.tasks.map((x) => { const t = c.task(x.taskId); return `${t?.id}: ${x.provider}/${t?.tier}`; }).join(", ")}`);
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
    this.persistTurns();
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
    const evs = this.takeEvents();
    this.persistTurns();
    const chat = userChat();
    if (chat.length) this.setKv("externalChatCursor", chat.at(-1)!.id);
    if (evs.length) this.wakeHop = Math.max(0, ...evs.filter((e) => e.kind === "turn_ended" && e.sessionId).map((e) => this.hops.get(e.sessionId!) ?? 0));
    const restarted = this.fresh;
    this.fresh = false;
    if (evs.length || chat.length) this.log("wake", "info", `get_updates: ${evs.length} event(s), ${chat.length} chat message(s)`);
    return {
      restarted,
      ...(restarted ? { startupContext: this.startupContext() } : {}),
      reflect: this.memory.drainReflections(),
      events: evs.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, sessionId: e.sessionId, text: e.text, ...(e.passive ? { background: true } : {}), ...(e.data ? { data: e.data } : {}) })),
      chat: chat.map((e) => ({ id: e.id, at: new Date(e.at).toISOString(), text: e.text, ...(e.images?.length ? { images: e.images.length } : {}), ...(e.pasted ? { pasted: true } : {}) })),
      relayHop: this.wakeHop,
      mode: this.mode,
      state: this.stateDigest(),
    };
  }

  private takeEvents() {
    return this.pending.splice(0).filter((e) => {
      if (e.kind !== "stall_suspected") return true;
      const s = this.d.sessions().get(e.sessionId!);
      return s && !this.excluded.has(s.id) && canSuspectStall(s) && s.stallCheck?.status === "suspected" && e.data && "checkId" in e.data && s.stallCheck.id === e.data.checkId;
    });
  }

  private clearWake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.nextWakeAt = null;
  }

  private heartbeat() {
    if (this.mode !== "active") return;
    // A late worker the registry hook missed: link it to its uncertain launch.
    for (const r of this.d.coordination.reservations()) if (r.state === "uncertain" && !this.inFlight.has(r.taskId)) this.autoLink(r.taskId);
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
    const evs = this.takeEvents();
    this.wakeHop = Math.max(0, ...evs.filter((e) => e.kind === "turn_ended" && e.sessionId).map((e) => this.hops.get(e.sessionId!) ?? 0));
    if (!evs.some((e) => !e.passive)) return null;
    const text = this.digest(evs);
    return this.deliver(text, `wake: ${evs.length} event(s) [${[...new Set(evs.map((e) => e.kind))].join(", ")}]`);
  }

  private digest(evs: WakeEvent[]): string {
    const parts: string[] = [];
    parts.push(`EVENTS (${evs.length}, relay hop ${this.wakeHop}):`);
    for (const e of evs)
      parts.push(`- [${new Date(e.at).toISOString().slice(11, 19)}] ${e.kind}${e.sessionId ? ` ${e.sessionId}` : ""}: ${e.text}`);
    parts.push("", this.stateDigest(), this.memory.drainReflections());
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
    return [...this.launched.values()].filter((l) => this.holdsSlot(ss.get(l.sessionId))).length;
  }

  /**
   * A real worker, the only kind that holds one of the maxLaunched slots (the user's rule, chat
   * #205): it's working or waiting on a question or approval, or its task (including one it's
   * recorded on through a launch reservation) is still open. An idle worker whose task is
   * finished, verified or rejected doesn't, nor does one that ended.
   */
  private holdsSlot(s: Session | undefined): boolean {
    if (!s || s.execution === "ended") return false;
    if (["working", "waiting_answer", "waiting_approval", "stalled"].includes(s.execution)) return true;
    const c = this.d.coordination;
    const tasks = [this.taskFor(s.id), ...c.reservations().filter((r) => r.sessionId === s.id).map((r) => c.task(r.taskId))];
    return tasks.some((t) => !!t && ["unassigned", "assigned", "in_progress", "blocked"].includes(t.status));
  }

  /**
   * What counts toward maxLaunched: every real worker (holdsSlot) the coordinator launched (its launched set,
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
      return this.holdsSlot(s);
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
      if (this.activeTurn) {
        this.queuedTurns.unshift({ ...this.activeTurn, body: `INTERRUPTED TURN: some actions may already have succeeded. Check get_state and reconcile before continuing; do not blindly repeat actions.\n${this.activeTurn.body}` });
        this.activeTurn = null;
        this.persistTurns();
      }
      try { rt.start(); }
      catch (e) {
        const message = (e as Error).message;
        this.log("runtime", "error", message);
        // Surfaced in the coordinator state (Settings shows it), not only in the activity log.
        if (this.runtimeError !== message) {
          this.runtimeError = message;
          this.changed();
        }
        return null;
      }
      if (this.runtimeError !== null) {
        this.runtimeError = null;
        this.changed();
      }
      const s = rt.selection ?? runtimeSelection(this.d.cfg);
      this.log("runtime", "info", `started coordinator process (${s.provider}, model ${s.model})`);
    }
    return rt;
  }

  /** Model-independent startup context: every RuntimeLike receives this on its first turn. */
  startupContext(): string {
    const snap = this.d.coordination.snapshot();
    const repos = [
      ...snap.objectives.filter((o) => o.status === "active").map((o) => o.grant?.root),
      ...[...this.d.sessions().values()].filter((s) => s.execution !== "ended" && this.relevant(s.id)).map((s) => s.cwd),
    ].filter((p): p is string => !!p);
    return "SWITCHBOARD (RE)STARTED. Rebuild current state with get_state / list_sessions before acting.\n" + this.memory.context(repos);
  }

  private deliver(text: string, label: string): string | null {
    const rt = this.runtime;
    if (!rt) return null;
    if (rt.busy) {
      this.queuedTurns.push({ body: text, origin: "event", images: [], relayHop: this.wakeHop });
      this.persistTurns();
      return null;
    }
    const sent = this.sendTurn({ body: text, origin: "event", images: [], relayHop: this.wakeHop });
    if (sent) {
      this.log("wake", "info", label);
    }
    return sent;
  }

  /** Journal before transport, so switching a process cannot drop an in-flight user turn. */
  private sendTurn(turn: CoordinatorTurn): string | null {
    this.activeTurn = turn;
    this.turnOrigin = turn.origin;
    this.wakeHop = turn.relayHop ?? 0;
    this.persistTurns();
    const body = this.fresh ? `${this.startupContext()}\n\n${turn.body}` : turn.body;
    if (!this.runtime?.send(body, turn.images)) return null;
    this.fresh = false;
    return body;
  }

  setRuntime(rt: RuntimeLike) {
    if (this.kind === "external") throw new Error("an external coordinator has no runtime: the daemon never starts a model for it");
    if (this.runtime !== rt) this.runtime?.stop();
    this.runtime = rt;
    this.fresh = true;
    this.wireRuntime(rt);
  }

  /** Human HTTP route only. Keep mode, chat provenance, grants, plans, workers and daily spend. */
  restartRuntime() {
    if (this.kind !== "builtin" || !this.runtime) throw new Error("only the built-in coordinator has a runtime");
    if (this.mode === "manual") throw new Error("the coordinator is off; turn it on first");
    if (this.budget.exhausted) throw new Error("daily budget reached");
    this.runtime.stop();
    this.restarts.clear("start"); // an explicit human retry, never available through MCP
    this.clearWake();
    if (!this.ensureRuntime()?.running) throw new Error(this.runtimeError ? `coordinator could not start: ${this.runtimeError}` : "coordinator could not start; check its activity log");
    if (this.mode === "active") {
      this.enqueue({ kind: "restart", sessionId: null, text: "The user restarted the coordinator. Reconcile durable state and unfinished turns before acting." }, 0);
      this.flush();
    }
    this.changed();
  }

  private wireRuntime(rt: RuntimeLike) {
    // Replies to the user's messages go to the chat. Thinking aloud about background events goes
    // to the activity log; to tell the user something unprompted it calls tell_user.
    rt.onText = (t) => { if (this.runtime === rt) this.turnOrigin === "user" ? this.addChat("coordinator", t) : this.log("reply", "info", clip(t, 600)); };
    rt.onUsage = (r) => {
      if (this.runtime !== rt) return;
      this.budget.record(r.total_cost_usd, r.usage);
      this.persist();
      if (this.budget.exhausted) this.budgetStop();
      this.changed();
    };
    rt.onResult = (r) => {
      if (this.runtime !== rt) return;
      this.budget.record(r.total_cost_usd, r.usage);
      if (!r.is_error) this.activeTurn = null;
      this.persist();
      if (r.is_error) this.log("runtime", "error", r.result ?? "coordinator turn failed");
      if (this.budget.exhausted) { this.budgetStop(); this.changed(); return; }
      if (r.is_error) { rt.stop(); this.changed(); return; }
      const next = this.queuedTurns.shift();
      if (next && this.sendTurn(next)) {
        this.log("wake", "info", "queued turn");
      }
      else if (this.pending.some((e) => !e.passive) && this.mode === "active")
        this.enqueue({ kind: "followup", sessionId: null, text: "events arrived while you were busy" }, 5000);
      this.changed();
    };
    rt.onExit = (code) => {
      if (this.runtime !== rt) return;
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
  userChat(text: string, images: string[] = [], opts: { pasted?: boolean } = {}): { ok: boolean; error?: string; id?: number } {
    const t = text.trim();
    if (!t && !images.length) return { ok: false, error: "empty message" };
    if (this.mode === "manual") return { ok: false, error: "the coordinator is off (manual mode): switch it to active or paused first" };
    if (this.budget.exhausted) return { ok: false, error: "daily budget reached" };
    // The mode it was sent in and whether it holds pasted text decide whether it can serve as userChat.
    const id = this.addChat("user", t, images, { mode: this.mode, activePeriod: this.activePeriod, ...(opts.pasted ? { pasted: true } : {}) });
    this.memory.reflect("chat_correction", `chat #${id}`, "Check whether this user message corrects your work or states a lasting preference. Ordinary requests need no lesson.");
    if (this.kind === "external") {
      // The external agent picks it up with get_updates (a waiting call returns now).
      this.log("chat", "info", `user: ${clip(t, 200)}`);
      this.wakeWaiters();
      return { ok: true, id };
    }
    const rt = this.ensureRuntime();
    if (!rt) return { ok: false, error: "coordinator process unavailable" };
    const pics = images.length ? `\n[${images.length} image(s) attached: you can see them below; route_to_session also forwards them]` : "";
    const body = `MESSAGE FROM THE USER (chat #${id}, mode ${this.mode}${this.mode === "paused" ? ": you may answer, read state and route this message, but take no other actions" : ""}${opts.pasted ? "; it includes pasted text, so it can't serve as userChat" : ""}):\n${t}${pics}${this.memory.drainReflections()}`;
    if (rt.busy) { this.queuedTurns.push({ body, origin: "user", images, relayHop: this.wakeHop }); this.persistTurns(); }
    else this.sendTurn({ body, origin: "user", images, relayHop: this.wakeHop });
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

  /** `userChat`: the user asked for this in chat (checked by callTool); the card is approved without a tap. */
  async approve(id: number, opts: { digest?: string; userChat?: number } = {}): Promise<CoordinatorProposal> {
    const p = this.proposal(id);
    if (!p) throw new Error("unknown proposal");
    if (p.state !== "pending") throw new Error(`proposal is ${p.state}`);
    if (p.kind === "action" && p.payload?.action === "new_objective") return this.approveObjective(p);
    if (p.kind === "action" && p.payload?.action === "plan") return this.approvePlan(p, opts.digest, opts.userChat);
    if (p.kind === "action" && p.payload?.action === "ask_several") {
      this.saveProposal({ ...p, state: "approved", resolvedAt: this.now(), detail: `Approval consumed${opts.userChat ? ` (chat #${opts.userChat})` : ""}; starting the sessions.` });
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
   * userChat: the user already asked for this in chat, so the card is approved at once and never
   * waits for a tap. Approval runs every check it normally runs; if one refuses, the card stays
   * pending for the user and the coordinator is told why.
   */
  private async approveFromChat(p: CoordinatorProposal, chat: number) {
    try {
      const out = await this.approve(p.id, { digest: p.digest, userChat: chat });
      return { approvedInChat: chat, proposal: out, ...(out.state === "failed" ? { error: out.detail } : {}) };
    } catch (e) {
      return { proposed: true, proposal: this.proposal(p.id), note: `couldn't run it now (${(e as Error).message}); it waits for the user as a card` };
    }
  }

  /**
   * The user changed a plan task in chat (userChat on update_task): what they said is what's
   * approved now, so the plan launches it as edited instead of skipping it as changed.
   */
  private reapprovePlanTask(t: Task) {
    const x = this.planTask(t.id);
    if (!x?.approved) return;
    const m = modelFor(this.d.cfg, t.tier, x.provider);
    x.approved = approvedSnapshot(t, { provider: x.provider, model: m.model, effort: m.effort } as PlanTask);
    if (x.state === "skipped" && !t.owner && t.status !== "verified" && t.status !== "rejected") {
      x.state = "waiting";
      delete x.error;
    }
    this.persist();
    void this.pumpPlans();
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
  private async approvePlan(p: CoordinatorProposal, digest: string | undefined, userChat?: number): Promise<CoordinatorProposal> {
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
        userChat ? `human asked in chat #${userChat} (plan #${p.id})` : `human approved plan #${p.id}`,
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
            recommendation: pt.recommendation,
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
    this.log("proposal_approved", "ok", `#${p.id} ${p.title}: ${detail}`, { userChat });
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
    this.launchBriefs.delete(taskId);
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
    this.memory.reflect("proposal_rejected", `proposal #${id}`, `The user tapped No thanks.${note ? ` Their note: ${clip(note, 180)}` : ""}`);
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
  rememberLesson(input: LessonInput, actor: "user" | "coordinator") {
    // Worker output is evidence to summarize, never durable instructions to copy. Check both
    // stored transcript text (including ended workers) and the registry's current excerpts.
    const fields = [validateLessonText(input.text, "text", 400), validateLessonText(input.reason, "reason", 240)];
    // A source made only of citations ("chat #42", "task <id>", "event #9 and proposal #3") names
    // what transcripts mention by design, and carries no words of its own: it isn't screened.
    // Any other source, however short, is screened like the text.
    const source = validateLessonText(input.source, "source", 160);
    if (source.replace(CITATION, "").replace(/[\s,;&+/()]|\band\b/gi, "")) fields.push(source);
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    // Padded so spans match whole words: "event 5" isn't inside "event 512".
    const excerpts = [...this.d.sessions().values()].flatMap((s) => [s.lastAssistantText ?? "", ...this.d.events(s.id, 100).filter((e) => ["assistant_msg", "tool_result", "turn_ended"].includes(e.type)).map((e) => String(e.data.text ?? e.data.lastAgentMessage ?? e.data.preview ?? ""))]).map((t) => ` ${norm(t)} `);
    for (const text of fields) {
      // Check overlapping literal excerpts too: wrapping a worker's words in "Lesson: …"
      // must not turn them into trusted memory, even after that worker leaves the registry.
      const tokens = [...text.matchAll(/\S+/g)];
      const fragments = tokens.length < 12 ? [text] : tokens.slice(0, tokens.length - 11).map((t, i) => text.slice(t.index, tokens[i + 11].index! + tokens[i + 11][0].length));
      const copied = this.d.db.query(`SELECT id FROM events
        WHERE type IN ('assistant_msg','tool_result','turn_ended') AND EXISTS (
          SELECT 1 FROM json_each(?) AS fragment
          WHERE instr(json_extract(data,'$.text'), fragment.value) > 0
             OR instr(json_extract(data,'$.lastAgentMessage'), fragment.value) > 0
             OR instr(json_extract(data,'$.preview'), fragment.value) > 0
        ) LIMIT 1`).get(JSON.stringify(fragments));
      const lesson = norm(text);
      const words = lesson.split(" ");
      const spans = words.length < 12 ? [lesson] : words.slice(0, words.length - 11).map((_, i) => words.slice(i, i + 12).join(" "));
      if (copied || excerpts.some((t) => spans.some((span) => span && t.includes(` ${span} `))))
        throw Error("Summarize the outcome in your own words; worker transcripts cannot be stored verbatim");
    }
    const before = input.id ? this.memory.list().find((l) => l.id === input.id) : undefined;
    const lesson = this.memory.remember(input, actor);
    // A preference about the user that the coordinator inferred applies only once the user keeps it.
    if (lesson.pending && !(before?.pending && before.text === lesson.text)) {
      this.log("remember", "info", `waiting for the user to keep a preference: ${clip(lesson.text, 200)}`);
      this.d.escalate(null, "Keep this preference?", `The coordinator wants to remember: "${lesson.text}". It isn't used until you choose Keep in Settings → Coordinator memory (or Discard).`);
    }
    return lesson;
  }

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
      userChat: null as number | null,
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
    // userChat: the user's own chat instruction is the authority for this one call (no card).
    // A forged, stale, pasted or non-human chat # refuses the call; nothing falls back silently.
    if (args.userChat !== undefined && args.userChat !== null) {
      if (!USER_CHAT_TOOLS.has(name)) return refuse(`${name} doesn't take userChat`);
      try {
        ctx.userChat = this.chatAuthority(args.userChat);
      } catch (e) {
        return refuse((e as Error).message);
      }
      // Take the use now, before anything asynchronous, so concurrent calls can't all pass the cap.
      this.chatUses.set(ctx.userChat, (this.chatUses.get(ctx.userChat) ?? 0) + 1);
      this.persist();
    }
    // A call that doesn't go through gives its use back.
    const refund = () => {
      if (ctx.userChat === null) return;
      this.chatUses.set(ctx.userChat, Math.max(0, (this.chatUses.get(ctx.userChat) ?? 1) - 1));
      this.persist();
    };
    const { reason: _r, ...rest } = args;
    const sig = `${name} ${JSON.stringify(rest)}`;
    if (acting) {
      const seen = this.repeats.attempt(sig, this.now());
      // A runaway loop halts everything; merely redoing finished work refuses just that call.
      if (seen === "runaway") {
        refund();
        this.setMode("paused", "loop prevention");
        this.d.escalate(
          ctx.sessionId,
          "Coordinator halted: repeated work",
          `It attempted ${name} with the same arguments ${this.d.cfg.limits.runawayThreshold} times within an hour. It is paused; check the activity log and switch it back to active when ready.`,
        );
        return refuse(`repeated work detected (${name} x${this.d.cfg.limits.runawayThreshold}/h): halted and flagged the user`);
      }
      if (seen === "repeat")
        return refund(), refuse(`repeated work: ${name} with these arguments already succeeded ${this.d.cfg.limits.repeatThreshold - 1} times this hour. Don't redo it; do something else or tell the user`);
    }
    try {
      const r = await this.dispatch(name, args, reason, ctx.userChat);
      if (acting && r.ok) this.repeats.succeeded(sig);
      if (!r.ok) refund();
      // get_updates logs only when it delivers something (polling would flood the log).
      if (r.ok && name !== "send_message" && name !== "request_checkpoint" && name !== "launch_session" && name !== "get_updates" && name !== "get_instructions")
        this.log(name, name === "note" ? "info" : "ok", clip(JSON.stringify(args), 400), ctx);
      return r;
    } catch (e) {
      refund();
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

  /** `chat`: a userChat callTool already checked: the user asked for this call in that chat message. */
  private async dispatch(name: string, a: any, reason: string, chat: number | null = null): Promise<ToolResult> {
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
        if (s.stallCheck) this.stallReads.set(s.id, s.stallCheck.id);
        return ok({ ...this.sessionView(s), lastAssistantText: clip(s.lastAssistantText, 800), recent,
          lastActivityAt: s.lastActivityAt, resources: s.resources, subagents: s.subagents ?? [], stallCheck: s.stallCheck ?? null,
          canRequestCheckpoint: this.autonomous(s.id) && s.sendMethods.length > 0,
        });
      }
      case "get_state": {
        const view = compactState({ ...c.snapshot(), proposals: this.proposals(30) }, a, { objective: coordinatorObjective, task: coordinatorTask });
        return ok({
          ...view,
          budget: this.budget.toJSON(),
          launched: [...this.launched.values()],
          // A fresh provider has no transcript memory. Chat provenance still comes exclusively
          // from the daemon's original rows; including them here grants no new authority.
          recovery: { unfinishedTurns: this.queuedTurns.length + Number(!!this.activeTurn), hint: "include: ['history'] returns recent chat, plans and unfinished turns after a runtime switch" },
          ...(Array.isArray(a.include) && a.include.includes("history") ? {
            chat: this.chat(200), plans: this.state().plans,
            unfinishedTurns: [this.activeTurn, ...this.queuedTurns].filter(Boolean),
          } : {}),
          settings: this.settings(),
        });
      }
      case "get_usage":
        return ok(this.d.usage ? compactUsage(this.d.usage()) : { available: false, note: "usage monitor not running" });
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
        return ok({ text: text + EXTERNAL_ADDENDUM + "\n\n" + this.startupContext() });
      }
      case "list_lessons":
        return ok(this.memory.snapshot());
      case "remember":
        return ok(this.rememberLesson(a, "coordinator"));
      case "forget":
        return ok({ forgotten: this.memory.forget(String(a.id ?? ""), "coordinator") });
      case "note":
        return ok({ noted: true });
      case "create_objective": {
        const root = typeof a.root === "string" ? a.root.trim() : "";
        if (!root || !isAbsolute(root)) throw new Error("create_objective needs root: the absolute path of the repository directory");
        if (!String(a.title ?? "").trim()) throw new Error("create_objective needs a title");
        if (a.resources !== undefined && !Array.isArray(a.resources)) throw new Error("resources must be a list");
        const resources = Array.isArray(a.resources) ? a.resources.map(String) : [];
        // The same root checks the approval will run (P1-A5): fail now rather than on the user's tap.
        // Approval runs them again (the directory may change in between) and builds the grant then.
        c.checkProposedGrant({ root, resources }, "check");
        const grantInChat = chat !== null && this.chatCoversRoot(chat, root);
        if (grantInChat) {
          // The user asked for it in chat: create and grant it now, as their approval would (P1-A5).
          const o = c.createGrantedObjective(
            {
              title: String(a.title).slice(0, 200),
              description: String(a.description ?? ""),
              priority: ["high", "normal", "low"].includes(a.priority) ? a.priority : "normal",
              root,
              resources,
            },
            `human asked in chat #${chat}`,
            "human",
          );
          return ok({ created: true, objective: coordinatorObjective(o) });
        }
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
          note: `Only the human can approve this${chat !== null ? ` (their chat message doesn't name ${root} and no grant covers it, so it's a card)` : ""}. Approval creates the objective and grants it this root and these resources; until then you have no authority.`,
        });
      }
      case "propose_plan": {
        const root = typeof a.root === "string" ? a.root.trim() : "";
        if (!root || !isAbsolute(root)) throw new Error("propose_plan needs root: the absolute path of an existing repository directory");
        // The same root checks the approval will run (P1-A5): fail now rather than on the user's tap.
        const grant = c.checkProposedGrant({ root, resources: Array.isArray(a.resources) ? a.resources.map(String) : a.resources }, "check");
        const plan = validatePlan({ ...a, resources: grant.resources }, grant.root, this.d.cfg, this.d.usage?.(), this.now());
        const overrides = plan.tasks.filter((t) => t.tierOverride).map((t) => `${t.key}: ${t.tierOverride}`);
        // A chat instruction doesn't cover destructive steps: such a plan is still a card.
        const destructive = screenDestructive(plan.tasks.map((t) => `${t.title}\n${t.brief}`).join("\n"));
        const proposal = this.propose({
          kind: "action",
          sessionId: null,
          taskId: null,
          title: clip(plan.title, 160),
          text: String(a.reason ?? ""),
          reason,
          heldBecause: destructive && chat !== null ? "destructive_screen" : "outside_authority",
          payload: plan as unknown as Record<string, unknown>,
        });
        const grantInChat = chat !== null && this.chatCoversRoot(chat, grant.root);
        if (grantInChat && !destructive) return ok({ ...(await this.approveFromChat(proposal, chat!)), ...(overrides.length ? { tierOverrides: overrides } : {}) });
        const why =
          chat === null ? "" : destructive ? ` (it matched "${destructive}": a chat instruction doesn't cover destructive steps)` : ` (their chat message doesn't name ${grant.root} and no grant covers it)`;
        return ok({
          proposed: true,
          proposal,
          ...(overrides.length ? { tierOverrides: overrides } : {}),
          note: `One card for the user${why}. Nothing exists until they tap Go ahead; then the daemon creates and launches the tasks. Don't create or launch them yourself.`,
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
        const recommendation = recommendWorker({ title: String(a.title ?? ""), description: `${a.description ?? ""}\n${acceptance.join("\n")}`, paths: scope.paths,
          provider: a.provider, tier: a.tier, tierReason: a.tierReason }, this.d.cfg, this.d.usage?.(), this.now());
        if (a.owner) chat !== null ? (this.requireIncluded(a.owner), this.session(a.owner)) : this.requireRouting(a.owner);
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
            tier: recommendation.tier,
            tierReason: recommendation.reason,
            recommendation,
          },
          "coordinator",
        );
        if (a.decisionDepends) c.updateTask(t.id, { needsVerification: true }, "coordinator");
        this.taskStatus.set(t.id, c.task(t.id)!.status);
        return ok(coordinatorTask(c.task(t.id)!));
      }
      case "update_task": {
        const t = c.task(a.taskId);
        if (!t) throw new Error("unknown task");
        const edited = this.taskHold.get(t.id);
        // A chat instruction newer than the user's own edit of this task is the latest word on it.
        const saidAfter = chat !== null && (this.chatEntry(chat)?.at ?? 0) > (edited ?? 0);
        if (edited && this.now() - edited < this.d.cfg.limits.humanHoldMs && !saidAfter) throw Error("Human instruction hold is active: the user just edited this task");
        if (t.owner) {
          if (chat !== null) this.requireIncluded(t.owner);
          else {
            this.requireAutonomous(t.owner, "update work owned by");
            this.requireRouting(t.owner);
          }
        }
        if (a.acceptance !== undefined) throw Error("Only the human may change acceptance criteria");
        // The user may change a plan task's approved fields in chat (userChat); the coordinator alone can't.
        if (this.planObjective(t.objectiveId) && chat === null) {
          const frozen = ["description", "scope", "tier", "tierReason", "prerequisites", "owner"].filter((k) => a[k] !== undefined);
          if (frozen.length)
            throw new Error(`task ${t.id} belongs to an approved plan: its ${frozen.join(", ")} are what the user approved and can't be changed by you. Tell the user, or propose a new plan`);
        }
        const patch: Partial<Task> = {};
        for (const k of ["status", "result", "acceptance", "description", "priority", "prerequisites"] as const)
          if (a[k] !== undefined) (patch as any)[k] = a[k];
        if (a.owner !== undefined && a.owner !== t.owner) {
          if (a.owner) chat !== null ? (this.requireIncluded(a.owner), this.session(a.owner)) : this.requireRouting(a.owner);
          if (t.owner && !this.autonomous(t.owner) && chat === null)
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
          Object.assign(patch, { scope, tier: r.tier, tierReason: r.reason, recommendation: undefined });
        }
        const u = c.updateTask(t.id, patch, "coordinator");
        // Prerequisites added after creation must block the task (so their landing triggers a handoff).
        if ((u.status === "assigned" || u.status === "unassigned") && c.blockedBy(u).length) c.updateTask(u.id, { status: "blocked" }, "coordinator");
        if (chat !== null) this.reapprovePlanTask(c.task(u.id)!);
        return ok(coordinatorTask(c.task(u.id)!));
      }
      case "record_evidence": {
        const t = c.task(a.taskId);
        if (!t) throw new Error("unknown task");
        // Still coordinator evidence with userChat: only the human's own or a daemon check verifies (P1-A2).
        if (t.owner) chat !== null ? this.requireIncluded(t.owner) : this.requireAutonomous(t.owner, "record evidence for");
        c.recordEvidence(t.id, "coordinator", String(a.text ?? ""), { criterion: a.criterion, sourceId: a.sourceId });
        return ok(coordinatorTask(c.task(t.id)!));
      }
      case "claim": {
        const owner = String(a.owner ?? "");
        if (chat !== null) (this.requireIncluded(owner), this.session(owner));
        else this.requireAutonomous(owner, "claim for");
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
        if (!this.myClaims.has(id) && chat === null) throw new Error("the coordinator can only release claims it made (any claim only when the user asked in chat: userChat)");
        const claim = c.claims(["active", "suspect", "waiting"]).find((x) => x.id === id);
        if (!claim) throw Error("Claim missing");
        if (chat !== null) this.requireIncluded(claim.owner);
        else this.requireAutonomous(claim.owner, "release claims for");
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
        this.addChat("coordinator", clipText(text, 2000));
        return ok({ told: true });
      }
      case "refresh_context":
        return this.refreshContext(a, reason, null, chat);
      case "resolve_launch":
        return ok(this.resolveLaunch(String(a.taskId ?? ""), typeof a.sessionId === "string" && a.sessionId ? a.sessionId : null, reason));
      case "close_session":
        return ok(await this.closeSession(String(a.sessionId ?? ""), reason));
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
        if (!this.d.askSeveral) throw new Error("asking several agents is not available");
        const who = members.map((m: any) => (m.model ? `${m.provider} (${m.model})` : m.provider)).join(" and ");
        const destructive = screenDestructive(prompt);
        const proposal = this.propose({
          kind: "action",
          sessionId: null,
          taskId: null,
          title: `Ask ${who} the same question`,
          text: prompt,
          reason,
          heldBecause: destructive && chat !== null ? "destructive_screen" : "coordinator_proposal",
          payload: { action: "ask_several", prompt, cwd, members },
        });
        // The user asked for it in chat: start it now (a destructive-sounding prompt still waits for a tap).
        if (chat !== null && !destructive) return ok(await this.approveFromChat(proposal, chat));
        return ok({ proposed: true, proposal });
      }
      case "send_message":
        return this.sendMessage(a.sessionId, String(a.text ?? ""), reason, a.taskId ?? null, name, false, null, false, chat);
      case "report_stall": {
        const s = this.session(a.sessionId);
        this.requireIncluded(s.id);
        if (this.isSelf(s)) throw new Error("cannot assess the coordinator itself");
        if (a.status !== "working" && a.status !== "stuck") throw new Error("status must be working or stuck");
        if (typeof a.checkId !== "string" || this.stallReads.get(s.id) !== a.checkId) throw new Error("call get_session for this stall check first");
        if (a.status === "stuck" && this.autonomous(s.id) && s.sendMethods.length && this.stallCheckpoints.get(s.id) !== a.checkId)
          throw new Error("request_checkpoint before confirming this worker is stuck; existing message limits apply");
        const action = typeof a.suggestedAction === "string" ? clip(a.suggestedAction, 500) : "";
        if (a.status === "stuck" && !action) throw new Error("a confirmed problem needs a suggestedAction");
        if (!this.d.reportStall) throw new Error("stall reporting is unavailable");
        return ok(this.d.reportStall(s.id, a.checkId, a.status, clip(reason, 300), action || undefined));
      }
      case "request_checkpoint": {
        const s = this.session(a.sessionId);
        if (s.stallCheck && this.stallReads.get(s.id) === s.stallCheck.id) this.stallCheckpoints.set(s.id, s.stallCheck.id);
        const t = a.taskId ? c.task(a.taskId) : null;
        const text = `Checkpoint please${t ? ` on task ${t.id} "${t.title}"` : ""}: reply with (1) what is done, (2) evidence (tests run, commands and their output, files changed), (3) what remains${t?.acceptance.length ? `, checked against the acceptance criteria: ${t.acceptance.join("; ")}` : ""}.${a.note ? ` ${a.note}` : ""}`;
        return this.sendMessage(a.sessionId, text, reason, a.taskId ?? null, name, false, null, false, chat);
      }
      case "launch_session":
        return this.doLaunch({ ...a, reason }, false, undefined, chat);
      case "set_priority":
      case "throttle":
      case "restore": {
        const s = this.session(a.sessionId);
        if (chat !== null) this.requireIncluded(s.id);
        else this.requireAutonomous(s.id, `${name.replace("_", " ")} for`);
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

  /** May the coordinator refresh this session's context now? It runs it, the user approved this proposal, or asked in chat. */
  private assertMaintenance(sessionId: string, proposalId: number | null, chat: number | null = null) {
    if (this.mode !== "active") throw Error("Coordinator is paused or off");
    if (this.budget.exhausted) throw Error("Daily budget reached");
    if (this.excluded.has(sessionId)) throw Error("Session is excluded from coordination");
    if (proposalId === null && this.holdActive(sessionId, chat)) throw Error("Human instruction hold is active");
    if (this.runs(sessionId)) return;
    if (chat !== null) return void this.chatAuthority(chat, false);
    const p = proposalId !== null ? this.proposal(proposalId) : null;
    if (!p || p.kind !== "action" || p.payload?.action !== "refresh_context" || p.sessionId !== sessionId || p.state !== "approved")
      throw Error("refreshing a session the user drives needs their OK");
  }

  /**
   * Keep a session's context healthy between turns: compact it (with a focus), or start it fresh
   * (Claude: /clear, then the hand-off brief as the next message). Sessions the user drives get a
   * proposal. Never mid-turn.
   */
  private async refreshContext(a: any, reason: string, approvedProposal: number | null = null, chat: number | null = null): Promise<ToolResult> {
    const s = this.d.sessions().get(String(a.sessionId));
    const fail = (why: string): ToolResult => (this.log("refresh_context", "refused", why, { sessionId: s?.id ?? null, taskId: a.taskId ?? null, reason, userChat: chat }), { ok: false, error: why });
    if (this.mode !== "active") return fail("Coordinator is paused or off");
    if (!s || s.execution === "ended") return fail("no such live session");
    if (this.excluded.has(s.id)) return fail("session is excluded from coordination");
    if (s.execution === "working") return fail("it's mid-turn: wait for the turn to end");
    const how = a.how === "fresh" ? "fresh" : "compact";
    const focus = String(a.focus ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500) || null;
    const brief = String(a.brief ?? "").trim();
    if (how === "fresh" && brief.length < 40) return fail("a fresh start needs a hand-off brief: what's done, where, how it was verified, what's next");
    if (how === "fresh" && s.provider !== "claude" && s.provider !== "codex") return fail("unsupported provider");
    if (!this.d.maintain) return fail("context maintenance is not available");
    // Asked for in chat, it runs now; a hand-off brief that sounds destructive still waits for a tap.
    const asked = chat !== null && !(how === "fresh" && screenDestructive(brief));
    if (!this.runs(s.id) && approvedProposal === null && !asked) {
      // Approving delivers the brief under the task named here: refuse now if that would already fail.
      const bad = how === "fresh" && a.taskId ? this.taskProblem(s.id, String(a.taskId)) : null;
      if (bad) return fail(`can't propose a fresh start under task ${a.taskId}: ${bad}. Leave taskId out (the user's approval of the brief is enough), or fix the task first`);
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
    // Same gates as a message: the user's hold, the per-session cooldown and hourly cap (asked for
    // in chat: the hold only if they typed in the session after asking, and only the duplicate drop).
    if (approvedProposal === null) {
      if (this.holdActive(s.id, chat)) return fail("the user messaged this session recently: human instructions win");
      const gate = checkSend(this.sent, s.id, `[context] ${how} ${focus ?? ""}`, this.d.cfg.limits, this.now(), { noCooldown: chat !== null });
      if (!gate.ok) return fail(gate.reason);
    }
    // Fresh: make sure the brief will be deliverable before clearing anything. It is this refresh's
    // own message: its rate gate runs here, once (the record below would otherwise refuse it).
    if (how === "fresh") {
      try {
        this.assertDispatch(s.id, a.taskId ?? null, approvedProposal !== null, chat);
      } catch (e) {
        return fail(`can't start fresh: the hand-off brief couldn't be delivered (${(e as Error).message}). Use how=compact instead.`);
      }
      const gate = checkSend(this.sent, s.id, withPrefix(brief), this.d.cfg.limits, this.now(), { noCooldown: chat !== null });
      if (!gate.ok) return fail(`can't start fresh: the hand-off brief would be refused (${gate.reason})`);
    }
    this.recordSent(s.id, `[context] ${how} ${focus ?? ""}`);
    const ctx: DispatchContext = {
      taskId: null,
      proposalId: approvedProposal,
      humanApproved: approvedProposal !== null,
      maintenance: "compact",
      ...(chat !== null ? { userChat: chat } : {}),
    };
    if (how === "compact" || s.provider === "codex") {
      const r = await this.d.maintain(s.id, "compact", focus, ctx);
      if (!r.ok) return fail(`compact failed: ${r.error ?? "unknown"}`);
    } else {
      const r = await this.d.maintain(s.id, "clear", null, { ...ctx, maintenance: "clear" });
      if (!r.ok) return fail(`clear failed: ${r.error ?? "unknown"}`);
    }
    if (how === "fresh") {
      // The brief goes as the first message of the new context, through the normal gated path.
      const sent = await this.sendMessage(s.id, brief, reason, a.taskId ?? null, "refresh_context", approvedProposal !== null, approvedProposal, true, chat);
      if (!sent.ok) return { ok: false, error: `context cleared, but the hand-off brief wasn't sent: ${sent.error}. Send it again with send_message.` };
    }
    this.log("refresh_context", "ok", `${how} ${s.name ?? s.id}`, { sessionId: s.id, taskId: a.taskId ?? null, reason, userChat: chat });
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
      this.assertMaintenance(sessionId, ctx.proposalId, ctx.userChat ?? null);
      return;
    }
    // userChat: still the user's own message in this chat, typed while active (recency was checked when queued).
    const chat = ctx.userChat !== undefined ? this.chatAuthority(ctx.userChat, false) : null;
    let approved = false;
    if (ctx.humanApproved) {
      const p = ctx.proposalId !== null ? this.proposal(ctx.proposalId) : null;
      const brief = p?.kind === "action" && p.payload?.action === "refresh_context" ? String(p.payload.brief ?? "") : null;
      if (!p || (p.kind !== "send_message" && brief === null) || p.state !== "approved" || p.sessionId !== sessionId || withPrefix(brief ?? p.text).trim() !== text)
        throw Error("the human approval doesn't match this message");
      // The approval covers the task its proposal named, or none: the context can't drop or swap it.
      if ((p.taskId || null) !== ctx.taskId) throw Error("the human approval doesn't match this message");
      approved = true;
    }
    const task = this.assertDispatch(sessionId, ctx.taskId, approved, chat);
    if (ctx.taskId !== null && task?.id !== ctx.taskId) throw Error("the checked task changed before delivery");
  }

  /**
   * Public gate for delivery/auth integration. A human proposal approval is one scoped action, not autopilot.
   * An approved message that names no task needs none: the user approved this exact text to this
   * session, and that is the authority. Mode, budget, exclusion and the user's hold still apply.
   * `chat` (userChat): the user asked for this message in chat; the same holds, except a hold from
   * before they asked.
   */
  assertDispatch(sessionId: string, taskId?: string | null, humanApproved = false, chat: number | null = null): Task | null {
    if (this.mode !== "active") throw Error("Coordinator is paused or off; no dispatch");
    if (this.budget.exhausted) throw Error("Daily budget reached");
    if (this.excluded.has(sessionId)) throw Error("Session is excluded from coordination");
    const human = humanApproved || chat !== null;
    if (!human) this.requireAutonomous(sessionId, "message");
    const task = human && !taskId ? null : this.taskFor(sessionId, taskId);
    if (task === undefined) throw Error("Dispatch needs a task under a human grant");
    if (task) this.d.coordination.checkDispatch(task.id, sessionId);
    if (this.holdActive(sessionId, chat)) throw Error("Human instruction hold is active");
    return task;
  }

  /**
   * Read-only: what an approved dispatch under this task would be refused for now (checkDispatch
   * without taking claims), or null. A proposal naming a task is refused up front with this,
   * instead of queueing a card whose approval would fail.
   */
  private taskProblem(sessionId: string, taskId: string): string | null {
    const t = this.d.coordination.task(taskId);
    if (!t) return `unknown task ${taskId}`;
    if (t.owner !== sessionId) return `task ${taskId} isn't owned by ${sessionId}`;
    try {
      this.d.coordination.assertRecipient(t, sessionId);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
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
    /** The caller already ran the rate gate for this text (a fresh refresh's brief, checked before clearing). */
    gated = false,
    /** userChat: the user asked for this message in chat: no card, no pacing limits; everything else holds. */
    chat: number | null = null,
  ): Promise<ToolResult> {
    const ctx = { sessionId: typeof sessionId === "string" ? sessionId : null, taskId, reason, userChat: chat };
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
    const held = this.holdActive(s.id, chat);
    if (held)
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
    if (!gated) {
      const gate = checkSend(this.sent, s.id, text, L, this.now(), { noCooldown: chat !== null });
      if (!gate.ok) return refuse(gate.reason, gate.outcome);
    }
    const destructive = screenDestructive(text);
    // Held or proposed, the user approves exactly this text, and that is enough: no task needed. A
    // task it names is still checked on approval, so refuse now rather than queue a card that fails.
    if (!humanApproved && taskId && (destructive || (chat === null && !this.autonomous(s.id)))) {
      const bad = this.taskProblem(s.id, taskId);
      if (bad) return refuse(`can't propose this under task ${taskId}: ${bad}. Leave taskId out (the user's approval of the text is enough), or fix the task first`);
    }
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
          note: `held for the user's approval: the best-effort destructive-intent screen matched "${destructive}"${chat !== null ? " (a chat instruction doesn't cover destructive steps)" : ""}`,
        },
      };
    if (!humanApproved && chat === null && !this.autonomous(s.id))
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
    const checked = this.assertDispatch(s.id, taskId, humanApproved, chat);
    // Count attempts before dispatch, including ambiguous outcomes. Concurrent requests and
    // daemon restarts cannot bypass the cooldown while the first transport is pending.
    this.recordSent(s.id, text);
    // The outbox rechecks exactly this task and approval right before transport (authorizeDelivery).
    const r = await this.d.send(s.id, text, {
      taskId: checked?.id ?? null,
      proposalId: humanApproved ? proposalId : null,
      humanApproved,
      ...(chat !== null ? { userChat: chat } : {}),
    });
    if (!r.ok) {
      this.retries.fail(key, this.now());
      return refuse(`send failed: ${r.error ?? "unknown"}`, "error");
    }
    this.retries.clear(key);
    this.log(tool, "ok", clip(text, 400), ctx);
    return { ok: true, result: { sent: true, hop } };
  }

  /**
   * `plan`: set only by pumpPlans for a task of an approved plan, with the model the human was shown.
   * `chat` (userChat): the user asked for this launch in chat: a plan task may be launched or retried
   * now, and a launch without a worktree needs no card. A destructive-looking brief still does.
   */
  private async doLaunch(a: any, approved: boolean, plan?: { model: string; effort: string | null }, chat: number | null = null): Promise<ToolResult> {
    const c = this.d.coordination;
    const ctx = { taskId: a.taskId ?? null, reason: a.reason ?? null, userChat: chat };
    const fail = (why: string, outcome: CoordinatorActivity["outcome"] = "refused"): ToolResult => {
      this.log("launch_session", outcome, why, ctx);
      return { ok: false, error: why };
    };
    const t = c.task(a.taskId);
    if (!t) return fail("launch_session needs an existing taskId");
    if (this.mode !== "active" || this.budget.exhausted) return fail("Coordinator paused/off or daily budget reached");
    if (!t.objectiveId) return fail("launch_session is only for tasks under an objective");
    const planned = !plan && chat !== null ? this.planTask(t.id) : undefined;
    if (!plan && !planned && this.planObjective(t.objectiveId))
      return fail("this task belongs to an approved plan: only the plan launches it, as the user approved it (or the user asks you in chat: userChat)");
    if (plan && a.tier) return fail("a plan task launches at its approved tier");
    if (t.status === "verified") return fail("Task is verified; only the human may reopen it");
    if (t.owner && this.excluded.has(t.owner)) return fail("Task owner is excluded");
    let grant;
    try {
      grant = c.assertTaskReady(t);
    } catch (e) {
      return fail((e as Error).message);
    }
    const saved = t.recommendation;
    const humanSelection = t.humanTierSelection ?? ((t.createdBy ?? "human") === "human" || !!t.humanRevision);
    if (chat === null && (humanSelection || saved?.tierSelected) && a.tier && a.tier !== (saved?.tierSelected && !humanSelection ? saved.baseTier : t.tier))
      return fail("Explicit tier selection preserved; a different tier needs a new human selection");
    if (chat === null && saved?.providerSelected && a.provider && a.provider !== saved.provider)
      return fail("Explicit provider selection preserved; a different provider needs a new human selection");
    const pinnedTier = !!plan || !!planned || humanSelection || !saved || saved.tierSelected || saved.tier !== t.tier;
    const recommendation = recommendWorker({ title: t.title, description: `${t.description}\n${t.acceptance.join("\n")}\n${a.prompt ?? ""}`, paths: t.scope.paths,
      provider: a.provider ?? planned?.provider ?? (saved?.providerSelected ? saved.provider : undefined),
      tier: a.tier ?? (saved?.tierSelected && !humanSelection && saved.tier === t.tier ? saved.baseTier : pinnedTier ? t.tier : undefined),
      tierReason: a.tierReason ?? saved?.baseReason ?? t.tierReason ?? "Saved task selection",
      baseline: saved && !a.tier && !humanSelection && saved.tier === t.tier ? { tier: saved.baseTier, reason: saved.baseReason } : undefined,
    }, this.d.cfg, this.d.usage?.(), this.now());
    const { provider, tier } = recommendation;
    // Approved tiers/models remain exact even if a later Settings rule resolves differently.
    if ((plan || planned || humanSelection) && tier !== (a.tier ?? t.tier)) {
      recommendation.queued = true;
      recommendation.reason += ". Queued: Settings or the deep floor conflict with the selected tier; review the selection before launch";
      this.saveRecommendation(t, recommendation, true);
      return fail(`waiting: ${recommendation.reason}`);
    }
    this.saveRecommendation(t, recommendation, !!plan || !!planned || (humanSelection && !a.tier));
    if (recommendation.queued) return fail(`waiting: ${recommendation.reason}`);
    if (this.launchLoad() >= this.d.cfg.limits.maxLaunched)
      return fail(`cap reached: ${this.d.cfg.limits.maxLaunched} coordinator-launched sessions are live`);
    const key = `launch:${t.id}`;
    // The user's go-ahead outranks the hourly failed-launch limit: one retry per chat instruction.
    if (chat !== null && this.retryLiftedBy.get(key) !== chat) {
      this.retries.clear(key);
      this.retryLiftedBy.set(key, chat);
    }
    if (!this.retries.allowed(key, this.now()))
      return fail(`retry limit: ${this.d.cfg.limits.maxRetries} failed launches for this task in the last hour`);
    if (!this.d.launch) return fail("launching is not available (no VS Code bridge)");
    const repo = String(a.repo ?? a.cwd ?? "");
    if (!repo.startsWith("/")) return fail("repo must be an absolute path");
    if (canonical(repo) !== grant.root) return fail("Launch repository is outside human grant");
    if (!approved) {
      // Held for the user, before anything is created: a destructive-looking brief (best-effort
      // screen over the coordinator's own text, not our fixed footer), or no worktree isolation
      // (unless the user asked for this launch in chat).
      const destructive = screenDestructive(`${String(a.prompt ?? "")}\n${t.title}\n${t.description}`);
      if (destructive || (a.worktree === false && chat === null)) {
        // What the approved launch would refuse anyway is refused now, not queued as a card.
        if (t.owner || c.reservation(t.id)) return fail("Task already has an owner or launch reservation; inspect before retrying");
        if (a.worktree !== false && !this.d.createWorktree) return fail("worktree creation unavailable");
        const why = destructive ? `matched "${destructive}"` : "no worktree: it would share a working tree";
        const proposal = this.propose({
          kind: "launch_session",
          sessionId: null,
          taskId: t.id,
          title: `Launch a ${tier} worker for task ${t.id} (${why})`,
          text: String(a.prompt ?? t.description),
          reason: String(a.reason ?? ""),
          heldBecause: destructive ? "destructive_screen" : "outside_authority",
          payload: { ...a, provider, tier, tierReason: recommendation.reason, recommendation },
        });
        return { ok: true, result: { held: true, proposal, note: `held for the user's approval: ${why}` } };
      }
    }
    // Never a second worker for a task that already has a live one (a relaunch would share its tree).
    const busy = this.liveWorkerFor(t);
    if (busy) return fail(`${busy.name ?? busy.id} is already working on this task (in ${busy.cwd}): use resolve_launch if its launch looked uncertain, or close it first`);
    // From here on only the validated grant root is used. The caller's `repo` string may be a
    // symlink that a worker repoints between this check and the git/provider calls below.
    let cwd = grant.root;
    // A worker in a worktree of its own claims its paths there, so only shared resources (or, with
    // no worktree, the shared tree) can be held by someone else. Then it waits: that's no failure.
    const inWorktree = a.worktree !== false;
    const held = c.scopeBlocker(t, inWorktree);
    if (held) return fail(`waiting: claim ${held.id} on ${held.resource} is held by ${held.owner}; launch it again once that's released (not counted as a failed launch)`);
    let reservation: ReturnType<Coordination["reserveLaunch"]>;
    try {
      reservation = c.reserveLaunch(t.id, grant.root, inWorktree);
    } catch (e) {
      const msg = (e as Error).message;
      // A claim taken since the check above: still waiting, not a failed launch.
      if (/^Dispatch blocked by claim/.test(msg)) return fail(`waiting: ${msg}; launch it again once that's released (not counted as a failed launch)`);
      this.retries.fail(key, this.now());
      return fail(`launch failed: ${msg}`, "error");
    }
    // Until the provider is invoked, a failure provably launched nothing: release everything.
    // After that, the outcome is uncertain: keep the reservation and claims until it's settled.
    let providerInvoked = false,
      finished = false;
    this.inFlight.add(t.id);
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
      c.checkReservation(reservation, cwd);
      if (a.worktree === false && cwdId !== grant.rootId) throw Error("Granted root changed while preparing the launch");
      verifyDir(cwd, cwdId, "Worker directory");
      if (this.mode !== "active" || this.budget.exhausted) throw Error("Coordinator stopped before launch");
      const m = modelFor(this.d.cfg, tier, provider);
      const heldSelection = approved && !plan ? a.recommendation : null;
      if (heldSelection && (m.model !== heldSelection.model || m.effort !== heldSelection.effort))
        throw Error("Settings changed the model/effort shown on the approved launch card; review a new launch");
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
      // Recorded before the provider runs: if the outcome turns out uncertain, only a session that
      // started with this exact brief can be linked as the worker.
      this.launchBriefs.set(t.id, { provider, prompt });
      this.persist();
      providerInvoked = true;
      const sessionId = await this.d.launch({ provider, cwd, name, model: m.model, effort: m.effort, prompt, taskId: t.id });
      const valid = c.finishLaunch(reservation, sessionId, cwd);
      finished = true;
      this.launchBriefs.delete(t.id);
      if (!valid) {
        const detail = `Worker ${sessionId} started after its task or grant changed. Human changes were preserved; inspect the worker and retained claims before continuing.`;
        this.d.escalate(sessionId, "Launch needs inspection", detail);
        return fail(detail, "error");
      }
      this.retries.clear(key);
      this.launched.set(sessionId, { sessionId, objectiveId: t.objectiveId, taskId: t.id, tier, at: this.now() });
      this.sent.push({ sessionId, at: this.now(), text: prompt });
      if (planned) {
        // A plan task the user had launched (or retried) through chat: the plan shows it as launched.
        planned.state = "launched";
        planned.sessionId = sessionId;
        planned.attempts = 0;
        delete planned.error;
      }
      this.persist();
      this.log(
        "launch_session",
        "ok",
        `${provider} ${m.model}${m.effort ? ` (${m.effort})` : ""} at tier ${tier} in ${cwd}${approved ? " (approved)" : ""} → ${sessionId}`,
        { ...ctx, sessionId },
      );
      return { ok: true, result: { sessionId, cwd, provider, model: m.model, effort: m.effort, tier, recommendation } };
    } catch (e) {
      const msg = (e as Error).message;
      this.inFlight.delete(t.id);
      this.retries.fail(key, this.now());
      if (!providerInvoked) {
        c.abandonReservation(reservation, msg);
        return fail(`launch failed before any worker started (reservation and claims released): ${msg}`, "error");
      }
      if (!finished) {
        c.updateReservation({ ...reservation, state: "uncertain", cwd, detail: msg });
        // The worker may well be running (a Codex thread can show up after the launcher stops
        // waiting): link it now if the folder holds exactly one; the registry hook links a late one.
        if (this.autoLink(t.id)) {
          const worker = c.task(t.id)!.owner!;
          this.retries.clear(key);
          this.log("launch_session", "ok", `${provider} at tier ${tier} in ${cwd}: the launcher gave up (${msg}), but ${worker} is working there and is now the task's worker`, { ...ctx, sessionId: worker });
          return { ok: true, result: { sessionId: worker, cwd, tier, linkedAfter: msg } };
        }
        // Otherwise it's for the coordinator to settle with resolve_launch (the daemon checks the folder).
        this.enqueue({
          kind: "launch_uncertain",
          sessionId: null,
          text: `A worker for task ${t.id} "${clip(t.title, 80)}" may or may not have started in ${cwd} (${msg}). Its reservation and claims are held. Check with resolve_launch once a session shows up there (or if none does); if it can't tell, flag the user.`,
        });
      }
      return fail(`launch failed: ${msg}`, "error");
    } finally {
      this.inFlight.delete(t.id);
    }
  }
}
