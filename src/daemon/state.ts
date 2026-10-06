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
  if (CONTENT.includes(e.type)) s.lastActivityAt = Math.max(s.lastActivityAt ?? 0, e.ts);
  const text = typeof e.data.text === "string" ? e.data.text : "";

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

/**
 * Working but silent for `stalledMs` and not using CPU -> suspected stalled (inferred).
 * A long-running command keeps the tree busy, so CPU use vetoes the stall.
 */
export function checkStalled(s: Session, now: number, stalledMs: number): boolean {
  const cpu = s.resources?.cpuPct ?? 0;
  const silentFor = s.lastActivityAt === null ? 0 : now - s.lastActivityAt;
  if (s.execution === "working" && silentFor > stalledMs && cpu < 5) {
    set(s, "stalled", "inferred");
    return true;
  }
  if (s.execution === "stalled" && (silentFor <= stalledMs || cpu >= 5)) {
    set(s, "working", "inferred");
    return true;
  }
  return false;
}
