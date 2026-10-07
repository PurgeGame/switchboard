// Pure session state transitions. Tested in test/state.test.ts.
import type { Confidence, Execution, SbEvent, Session } from "../shared/types.ts";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const CONTENT: SbEvent["type"][] = ["user_msg", "peer_msg", "auto_msg", "coordinator_msg", "assistant_msg", "tool_call", "tool_result", "turn_started", "turn_ended", "interrupted", "error", "queued_input"];

export function blankSession(id: string, provider: Session["provider"], kind: Session["kind"], nativeId: string): Session {
  return {
    id, provider, kind, nativeId,
    name: null, cwd: null, project: null, branch: null,
    pid: null, pidConfidence: "inferred", tty: null, transcriptPath: null,
    connection: "unknown", limitations: [], sendMethods: [],
    controls: { interrupt: false, steer: false, queue: false, approve: false },
    enforcement: "observed", filesTouched: [],
    execution: "unknown", executionConfidence: "inferred",
    startedAt: null, lastActivityAt: null, endedAt: null, turnStartedAt: null,
    model: null, effort: null, contextTokens: null, contextWindow: null, firstPrompt: null, goal: null, goalInferred: true,
    lastAssistantText: null, lastEventId: null, resources: null, meta: {},
  };
}

/** Apply one transcript event. Returns true if the session changed. */
export function applyEvent(s: Session, e: SbEvent): boolean {
  const before = JSON.stringify([s.execution, s.turnStartedAt, s.lastActivityAt, s.lastAssistantText, s.firstPrompt, s.goal]);
  if (CONTENT.includes(e.type)) {
    // Preserve the progress baseline in snapshots from before progress was tracked separately.
    if (typeof s.meta.lastProgressAt !== "number" && s.lastActivityAt !== null) {
      s.meta.lastProgressAt = s.lastActivityAt;
      s.meta.lastProgressType = s.meta.lastContentType;
    }
    s.lastActivityAt = Math.max(s.lastActivityAt ?? 0, e.ts);
    s.meta.lastContentType = e.type;
  }
  const text = typeof e.data.text === "string" ? e.data.text : "";
  // A delivered checkpoint is our own input, not evidence that the worker made progress.
  const coordinatorEcho = (e.type === "user_msg" || e.type === "peer_msg") && text.replace(/<\/?pasted_content[^>]*>/g, "").trim().startsWith("[coordinator]");
  if (coordinatorEcho || e.type === "coordinator_msg") s.meta.lastCoordinatorInputAt = e.ts;
  const checkpointTurn = e.type === "turn_started" && s.meta.lastCoordinatorInputAt === e.ts;
  if (CONTENT.includes(e.type) && !["coordinator_msg", "auto_msg", "queued_input"].includes(e.type) && !coordinatorEcho && !checkpointTurn && e.ts >= (stallActivityAt(s) ?? 0)) {
    s.meta.lastProgressAt = e.ts;
    s.meta.lastProgressType = e.type;
    if (e.type === "tool_call") s.meta.lastStep = stepSummary(e);
    else if (text) s.meta.lastStep = clip(text.replace(/\s+/g, " "), 300);
    else if (e.type !== "tool_result") s.meta.lastStep = e.type;
  }

  const startTurn = () => {
    if (s.turnStartedAt === null || !isRunning(s.execution)) s.turnStartedAt = e.ts;
    set(s, "working", "confirmed");
  };

  switch (e.type) {
    case "user_msg":
      if (!s.firstPrompt && text && !e.data.queued) {
        s.firstPrompt = clip(text.trim(), 1000);
        if (!s.goal) {
          s.goal = clip(text.trim().split("\n").find((l) => l.trim()) ?? "", 200);
          s.goalInferred = true;
        }
      }
      break;
    case "turn_started":
      startTurn();
      break;
    case "assistant_msg":
      if (text) s.lastAssistantText = clip(text, 4000);
      if (isIdleLike(s.execution) && s.execution !== "interrupted") startTurn();
      break;
    case "tool_call":
      // The tool_use record is written before the permission prompt shows, so it must not
      // clear a pending approval; the tool's result is what proves the prompt was answered.
      if (isIdleLike(s.execution)) startTurn();
      break;
    case "tool_result":
      if (s.execution === "waiting_approval") set(s, "working", "confirmed");
      break;
    case "turn_ended":
      if (typeof e.data.lastAgentMessage === "string" && e.data.lastAgentMessage) s.lastAssistantText = clip(e.data.lastAgentMessage, 4000);
      if (typeof e.data.durationMs === "number") s.meta.lastTurnDurationMs = e.data.durationMs;
      s.turnStartedAt = null;
      set(s, "idle", "confirmed");
      break;
    case "interrupted":
      s.turnStartedAt = null;
      set(s, "interrupted", "confirmed");
      break;
    case "error":
      s.meta.lastError = clip(text, 500);
      if (e.data.kind === "rate_limit" || e.data.status === 429) {
        s.turnStartedAt = null;
        set(s, "failed", "confirmed");
      }
      break;
  }
  return before !== JSON.stringify([s.execution, s.turnStartedAt, s.lastActivityAt, s.lastAssistantText, s.firstPrompt, s.goal]);
}

export const isRunning = (x: Execution) => x === "working" || x === "stalled";
/** Not running and not waiting on the user. */
const isIdleLike = (x: Execution) => !isRunning(x) && x !== "waiting_approval" && x !== "waiting_answer";

function set(s: Session, x: Execution, c: Confidence) {
  s.execution = x;
  s.executionConfidence = c;
}

/** Merge the provider's own live status (registry / daemon), which is fresher than the transcript. */
export function mergeLiveStatus(s: Session, live: { execution: Execution; confidence: Confidence } | undefined, now: number): boolean {
  if (!live) return false;
  const before = `${s.execution}|${s.turnStartedAt}|${s.executionConfidence}`;
  switch (live.execution) {
    case "working":
      if (!isRunning(s.execution)) {
        s.turnStartedAt ??= now;
        set(s, "working", live.confidence);
      }
      break;
    case "idle":
      // Keep interrupted/failed until the next turn, and keep waiting_answer: a turn that
      // ended with a question looks "idle" to the provider until the user replies.
      if (s.execution !== "interrupted" && s.execution !== "failed" && s.execution !== "waiting_answer") {
        s.turnStartedAt = null;
        set(s, "idle", live.confidence);
      }
      break;
    case "waiting_answer":
    case "waiting_approval":
      set(s, live.execution, live.confidence);
      break;
    case "failed":
    case "ended":
      s.turnStartedAt = null;
      set(s, live.execution, live.confidence);
      break;
  }
  return before !== `${s.execution}|${s.turnStartedAt}|${s.executionConfidence}`;
}

export function stepSummary(e: SbEvent): string {
  const text = e.type === "tool_call"
    ? `${e.data.name ?? "tool"} ${e.data.summary ?? JSON.stringify(e.data.input ?? e.data.arguments ?? e.data.paths ?? "")}`
    : String(e.data.text ?? e.type);
  return clip(text.replace(/\s+/g, " "), 300);
}

export const stallActivityAt = (s: Session): number | null => typeof s.meta.lastProgressAt === "number" ? s.meta.lastProgressAt : s.lastActivityAt;

/** Silence is only a lead for the coordinator. Waiting and live work always veto it. */
export function canSuspectStall(s: Session): boolean {
  return s.execution === "working"
    && (s.meta.lastProgressType ?? s.meta.lastContentType) !== "turn_ended"
    && (s.resources?.cpuPct ?? 0) < 5
    && !s.resources?.running
    && (s.resources?.liveChildren ?? Math.max(0, (s.resources?.procs ?? 1) - 1)) === 0
    && !s.subagents?.some((a) => a.status === "running");
}

/** Does not change execution: unconfirmed suspicions are invisible to the user. */
export function checkStalled(s: Session, now: number, stalledMs: number): boolean {
  const at = stallActivityAt(s);
  return at !== null && now - at > stalledMs && canSuspectStall(s);
}
