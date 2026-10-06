// Types shared by the daemon and the web UI. This file is the API contract.

export type Provider = "claude" | "codex" | "other";

/** How the session is hosted. */
export type SessionKind =
  | "tui" // interactive terminal session (Claude TUI, Codex TUI on the shared daemon)
  | "vscode" // owned by a VS Code extension
  | "headless" // claude -p / Agent SDK
  | "appserver" // thread on a Switchboard-owned codex app-server
  | "background" // claude --bg
  | "process"; // found by the generic process scanner only

export type Connection = "controllable" | "observe-only" | "disconnected" | "unknown";

export type Execution =
  | "working"
  | "idle"
  | "waiting_answer"
  | "waiting_approval"
  | "stalled"
  | "failed"
  | "interrupted"
  | "ended"
  | "unknown";

/** confirmed = from an explicit event or hook; inferred = heuristic (UI shows "~"). */
export type Confidence = "confirmed" | "inferred";

export interface ResourceUsage {
  cpuPct: number; // percent of one core, summed over the tree (can exceed 100)
  rssMB: number;
  procs: number;
  top?: { pid: number; name: string; cpuPct: number; rssMB: number };
  /** true when part of the tree could not be attributed reliably (e.g. Codex daemon children). */
  inferred?: boolean;
  /** A command the agent started that is still running, e.g. tests it left going after its turn ended. */
  running?: RunningCommand;
}

export interface RunningCommand {
  kind: "tests" | "build" | "command";
  /** The command as the agent wrote it, one line, clipped. */
  cmd: string;
  since: number;
}

export interface Session {
  id: string; // stable: "<provider>:<nativeId>" or "proc:<pid>:<starttime>"
  provider: Provider;
  kind: SessionKind;
  nativeId: string;
  name: string | null;
  cwd: string | null;
  project: string | null; // git toplevel
  branch: string | null;
  pid: number | null;
  pidConfidence: Confidence;
  tty: string | null;
  transcriptPath: string | null;
  connection: Connection;
  /** Why the session is observe-only / what controls exist. Shown in the UI. */
  limitations: string[];
  /** Send methods available right now, best first. Empty = observe-only. */
  sendMethods: SendMethod[];
  /** Controls available right now. */
  controls: { interrupt: boolean; steer: boolean; queue: boolean; approve: boolean };
  /** What protection actually applies to this session. */
  enforcement: EnforcementLevel;
  /** Files this session edited recently (from edit tools), newest first. */
  filesTouched: { path: string; at: number; source: "edit-tool" | "worktree-diff" }[];
  execution: Execution;
  executionConfidence: Confidence;
  startedAt: number | null; // epoch ms
  lastActivityAt: number | null;
  endedAt: number | null;
  turnStartedAt: number | null; // set while a turn is running
  model: string | null;
  /** Reasoning effort of the latest turn ("low" … "xhigh"), when the provider records it. */
  effort: string | null;
  /** Tokens in the model's context as of the latest turn, and the window size. */
  contextTokens: number | null;
  contextWindow: number | null;
  firstPrompt: string | null;
  goal: string | null;
  goalInferred: boolean;
  lastAssistantText: string | null;
  /** Newest stored event id, for unread tracking across reloads. */
  lastEventId: number | null;
  resources: ResourceUsage | null;
  meta: Record<string, unknown>;
}

export type EventType =
  | "session_started"
  | "user_msg"
  | "peer_msg"
  | "coordinator_msg"
  | "auto_msg"
  | "assistant_msg"
  | "tool_call"
  | "tool_result"
  | "turn_started"
  | "turn_ended"
  | "needs_input"
  | "queued_input"
  | "error"
  | "interrupted"
  | "renamed"
  | "session_ended";

export interface SbEvent {
  id?: number;
  sessionId: string;
  sourceId: string; // dedupe key from the source (record uuid, rollout ordinal, hook id…)
  type: EventType;
  ts: number; // epoch ms, from the source
  data: Record<string, unknown>;
}

export interface SystemStats {
  ts: number;
  cpuPct: number; // 0-100, whole machine
  cores: number;
  memTotalMB: number;
  memAvailableMB: number;
  swapUsedMB: number;
  psi: { cpu: number; memory: number; io: number }; // "some avg10"
  gpu: { name: string; memUsedMB: number; memTotalMB: number; utilPct: number } | null;
  gameMode: boolean;
}

export type AttentionKind = "question" | "approval" | "finished" | "failed" | "stalled" | "conflict" | "escalation";
export type Outcome = "success" | "failure" | "incomplete" | "limit" | "unclear";
export type Resolution = "answered_ui" | "answered_terminal" | "acknowledged" | "auto" | "superseded";

/** Attention items are their own records, separate from session execution state. */
export interface AttentionItem {
  id: number;
  sessionId: string;
  /** Session name when raised, so resolved items stay readable after the session is gone. */
  sessionName: string | null;
  kind: AttentionKind;
  createdAt: number;
  /** One line: what happened. */
  title: string;
  /** The actual question / approval request / final message excerpt. */
  text: string | null;
  /** finished items: the agent's own claim about the result. */
  outcome: Outcome | null;
  status: "open" | "resolved";
  resolvedAt: number | null;
  resolution: Resolution | null;
  resolutionNote: string | null;
  /** Dedupe key: (session, kind, sourceKey) is unique. */
  sourceKey: string;
  /** Raised from replayed history (no notification was sent). */
  historical: boolean;
  meta: Record<string, unknown>;
}

export type SendMethod = "codex-daemon" | "terminal" | "peer" | "stdin";
/** queued → sending → accepted | failed | uncertain. Uncertain is never retried automatically. */
export type DeliveryState = "queued" | "sending" | "accepted" | "failed" | "uncertain";
export type Author = "human" | "coordinator" | "auto";
/** auto: start a turn if idle, steer if busy. queue: deliver after the current turn. */
export type SendMode = "auto" | "steer" | "queue";

export interface OutboxMessage {
  id: number;
  sessionId: string;
  /** Idempotency key, also the provider-side message id where supported. */
  clientId: string;
  author: Author;
  method: SendMethod;
  mode: SendMode;
  state: DeliveryState;
  text: string;
  /** Absolute paths of uploaded images. */
  images: string[];
  /** How images were delivered: as real images, or only as path references in the text. */
  imageDelivery: "image" | "path" | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  /** The message was observed in the target's own transcript. */
  receipt: boolean;
  /** e.g. "turn/start", "turn/steer", "thread/queue/add". */
  detail: string | null;
  // p1/delivery-auth
  /** Versioned hash of the request (session, author, method, mode, text, images): a reused key must match it. */
  fingerprint?: string;
  /** Set when the human settled an uncertain delivery by inspecting the session. */
  resolution?: "delivered" | "not_delivered";
  /** Coordinator sends: the authority checked when it was queued, rechecked right before transport. */
  context?: DispatchContext;
}

/** Trusted dispatch context for a coordinator message (set by the daemon, never by the model). */
export interface DispatchContext {
  /** The task whose grant/claims/prerequisites were checked. */
  taskId: string | null;
  /** The exact human-approved proposal this message carries out, if any. */
  proposalId: number | null;
  humanApproved: boolean;
  /** Context maintenance (a typed /compact or /clear), not a message: needs autonomy or the user's OK, not a task. */
  maintenance?: "compact" | "clear";
  /** A launch brief for this task (delivered under its live launch reservation). */
  launch?: string;
  /** The worker folder that launch pinned (set by the daemon's launcher, not the model). */
  launchCwd?: string;
  /** The exact agent process the launcher started (the brief goes to it and nothing else). */
  launchPid?: number;
}

export interface PerspectiveMember {
  sessionId: string | null;
  provider: Provider;
  model: string | null;
  /** e.g. "Claude · opus" */
  label: string;
  state: "launching" | "working" | "answered" | "failed";
  promptSentAt: number | null;
  answer: string | null;
  answeredAt: number | null;
  error: string | null;
}

export interface PerspectiveGroup {
  id: string;
  createdAt: number;
  prompt: string;
  images: string[];
  cwd: string;
  source: "ui" | "detected";
  /** suggested = auto-detected, waiting for one-click confirmation */
  status: "suggested" | "running" | "answered" | "dismissed";
  members: PerspectiveMember[];
  round: number; // 1 = original answers, 2+ = after cross-review
  /** Started by the coordinator: synthesize as soon as everyone has answered. */
  autoSynthesize?: boolean;
  /** Started by the coordinator: its members are background agents, not sessions of the user's. */
  background?: boolean;
  synthesis: {
    state: "none" | "running" | "done" | "failed";
    model: string | null;
    path: string | null;
    text: string | null;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
  };
}

export type TaskStatus = "unassigned" | "assigned" | "in_progress" | "blocked" | "finished_unverified" | "verified" | "rejected";

export interface Objective {
  id: string;
  title: string;
  description: string;
  status: "active" | "done" | "dropped";
  priority: "high" | "normal" | "low";
  createdAt: number;
  updatedAt: number;
}

export type Tier = "deep" | "standard" | "light";

export interface Task {
  id: string;
  objectiveId: string | null;
  title: string;
  description: string;
  owner: string | null; // sessionId
  scope: { paths: string[]; resources: string[] };
  priority: "high" | "normal" | "low";
  /** Deep = strongest model/high effort (contracts, security…); light = cheap/fast. */
  tier: Tier;
  tierReason: string | null;
  /** Light-tier result that a decision depends on: must be checked by a higher tier before "verified". */
  needsVerification?: boolean;
  prerequisites: string[]; // task ids
  acceptance: string[];
  status: TaskStatus;
  result: string | null;
  evidence: { at: number; by: string; text: string }[];
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Claim {
  id: number;
  /** "path:/abs/dir/**", "path:/abs/file.ts", "branch:/repo@name", "port:3000", "db:name", "deploy:target" */
  resource: string;
  owner: string; // sessionId
  taskId: string | null;
  exclusive: boolean;
  state: "active" | "suspect" | "released" | "waiting";
  createdAt: number;
  heartbeatAt: number;
  note: string | null;
}

export interface Conflict {
  id: string;
  kind: "same_file" | "claimed_area" | "shared_worktree";
  sessions: string[];
  path: string | null;
  detail: string;
  at: number;
  /** Members of one perspective group: expected to share a task (same-file writes still count). */
  sameGroup: boolean;
}

export type EnforcementLevel = "isolated" | "cooperative" | "observed";

/** Messages pushed over the WebSocket. */
export type ServerPush =
  | { type: "hello"; sessions: Session[]; system: SystemStats | null; attention?: AttentionItem[]; groups?: PerspectiveGroup[]; coordinatorAgent?: CoordinatorAgentKind }
  | { type: "attention"; item: AttentionItem }
  | { type: "outbox"; message: OutboxMessage }
  | { type: "group"; group: PerspectiveGroup }
  | { type: "coordination"; objectives: Objective[]; tasks: Task[]; claims: Claim[]; conflicts: Conflict[] }
  | { type: "auto"; sessionId: string; itemId: number | null; state: "pending" | "cancelled" | "sent" | "declined"; deadline?: number; reason?: string; quote?: string | null }
  | { type: "session"; session: Session }
  | { type: "session_removed"; id: string }
  | { type: "event"; event: SbEvent }
  | { type: "system"; system: SystemStats }
  | ({ type: "coordinator" } & CoordinatorState);

// ---- Coordinator agent (Phase 6). REST contract:
//   GET  /api/coordinator                         -> CoordinatorState
//   POST /api/coordinator/mode {mode}             -> CoordinatorState
//   POST /api/coordinator/chat {text}             -> { ok } (reply arrives as chat entries via WS)
//   POST /api/coordinator/proposals/:id/approve   -> CoordinatorProposal
//   POST /api/coordinator/proposals/:id/reject    -> CoordinatorProposal
//   POST /api/coordinator/exclude {sessionId, excluded}   -> CoordinatorState
//   POST /api/coordinator/autopilot {sessionId, enabled}  -> CoordinatorState (grant autonomy for a session you drive)
//   GET  /api/coordinator/tools, POST /api/coordinator/tool/:name  (the coordinator's MCP proxy only)
// WS: { type: "coordinator", ...CoordinatorState } on every change.
// With coordinator.agent "none" there is no coordinator: every /api/coordinator* route is a 404
// {error: "no coordinator configured"}, and the WS hello says coordinatorAgent: "none".

/**
 * Who the coordinator's brain is (config `coordinator.agent`, D34): the daemon's own Claude process
 * (builtin), the user's own agent connected through `sb mcp` (external), or no coordinator at all
 * (none: /api/coordinator* is a 404).
 */
export type CoordinatorAgentKind = "builtin" | "external" | "none";

/** active = acts; paused = no new actions, workers keep running; manual = off. */
export type CoordinatorMode = "active" | "paused" | "manual";

export interface CoordinatorActivity {
  id: number;
  at: number;
  /** MCP tool name or a daemon-side action ("wake", "mode", "proposal_approved", "blocked", …). */
  action: string;
  sessionId: string | null;
  taskId: string | null;
  /** The coordinator's stated reason (required for acting tools). */
  reason: string | null;
  outcome: "ok" | "refused" | "proposed" | "held" | "dropped" | "error" | "info";
  detail: string;
}

export interface CoordinatorProposal {
  id: number;
  createdAt: number;
  kind: "send_message" | "launch_session" | "action";
  sessionId: string | null;
  taskId: string | null;
  title: string;
  /** For send_message: the exact text that would be sent (already prefixed). */
  text: string;
  reason: string;
  /** Why it is a proposal and not an action. */
  heldBecause: "outside_authority" | "destructive_screen" | "coordinator_proposal";
  state: "pending" | "approved" | "rejected" | "cancelled" | "failed";
  resolvedAt: number | null;
  detail: string | null;
  payload: Record<string, unknown>;
  /** Plans (D32): sha256 of the payload as shown. Approving must send it back; the daemon recomputes it. */
  digest?: string;
}

export interface CoordinatorChatEntry {
  id: number;
  at: number;
  role: "user" | "coordinator" | "system";
  text: string;
  /** Uploaded images the user attached (user entries only). */
  images?: string[];
  /** Where the coordinator routed this user message, once (session id). */
  routedTo?: string | null;
}

/** An approved delegation plan and where each of its tasks stands (retry applies to "failed"). */
export interface CoordinatorPlan {
  proposalId: number;
  title: string;
  tasks: { key: string; taskId: string; title: string; state: "waiting" | "launched" | "failed" | "skipped"; error?: string }[];
}

export interface CoordinatorState {
  /** builtin: the daemon runs the brain; external: the user's own agent polls through `sb mcp`. */
  agent: Exclude<CoordinatorAgentKind, "none">;
  /** Last MCP tool call (any outcome) since the daemon started: is an external agent connected? */
  lastToolCallAt: number | null;
  mode: CoordinatorMode;
  model: string;
  /** Is the coordinator process running right now. */
  running: boolean;
  busy: boolean;
  budget: { day: string; spentUsd: number; limitUsd: number; inputTokens: number; outputTokens: number; exhausted: boolean };
  limits: { perSessionCooldownMs: number; perSessionPerHour: number; maxLaunched: number; maxRelayHops: number };
  excluded: string[];
  autopilot: string[];
  /** Sessions it launched (autonomous authority), with their objective. */
  launched: { sessionId: string; objectiveId: string | null; taskId: string | null; at: number }[];
  nextWakeAt: number | null;
  pendingEvents: number;
  activity: CoordinatorActivity[];
  proposals: CoordinatorProposal[];
  plans: CoordinatorPlan[];
  chat: CoordinatorChatEntry[];
  /** Tasks whose light-tier result a decision depends on: need verification by a higher tier. */
  needsVerification: string[];
  /** The destructive-intent screen is a keyword heuristic, not a guarantee. */
  screenLabel: string;
}

// p1/authority — additive contracts; existing UI/API fields remain compatible.
export interface AcceptanceCheck {
  criterion: string;
  kind: "response_equals" | "file_contains" | "file_sha256";
  expected: string;
  path?: string;
}
export interface HumanGrant {
  id: string;
  root: string;
  resources: string[];
  verification: AcceptanceCheck[];
  issuedBy: "human";
  issuedAt: number;
  revokedAt: number | null;
}
export interface Objective { grant?: HumanGrant | null; }
export interface VerifiedEvidence {
  criterion: string;
  text: string;
  by: "human" | "coordinator";
  at: number;
  verifiedBy: string;
  revision: string;
  grantId: string | null;
  sourceId?: string;
  sourceSessionId?: string;
  observedText?: string;
}
export interface Task {
  /** Incremented by every human task edit; in-flight launches may not overwrite it. */
  humanRevision?: number;
  verifiedEvidence?: VerifiedEvidence[];
  evidenceSince?: number;
  historicalVerified?: { at: number; reason: string };
}
export interface LaunchReservation {
  id: string;
  taskId: string;
  grantId: string;
  revision: string;
  state: "reserved" | "launching" | "launched" | "uncertain";
  at: number;
  sessionId?: string;
  cwd?: string;
  detail?: string;
}
// end p1/authority
// p1/fixes — additive.
export interface HumanGrant {
  /** How the human issued it: the grant route, or approving one exact coordinator proposal. */
  provenance?: string;
}
export interface Task {
  /** Who created the task. Missing on older tasks, which are treated as human-created. */
  createdBy?: "human" | "coordinator";
}
export interface LaunchReservation {
  /** Grant root at reservation time; the worker's cwd holds this directory's files. */
  root?: string;
}
// end p1/fixes
// p1/fixes4 — additive.
export interface HumanGrant {
  /** The granted directory itself ("dev:ino"), recorded at grant time and re-checked on every use. */
  rootId?: string;
}
export interface LaunchReservation {
  /** Identity ("dev:ino") of `cwd` when it was recorded; the binding holds only while it matches. */
  cwdId?: string;
}
// end p1/fixes4
