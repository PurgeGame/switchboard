// Attention engine: turns events and status changes into persistent attention items.
// Rules:
// - question/approval resolve only when actually answered (never by opening the session)
// - finished/failed/stalled resolve on acknowledgment; superseded items close with a note
// - dedupe by (session, kind, source event); at most one notification per item
import type { AttentionItem, AttentionKind, Execution, OutboxMessage, Resolution, SbEvent, Session, StallCheck } from "../shared/types.ts";
import { AmbiguityResolver, classifyTurnEnd } from "./classify.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { deniedCallText, providerPromptDenial, type DeniedToolCall } from "./adapters/tool-denial.ts";

export interface AttentionSink {
  classifyDenial?(s: Session, call: DeniedToolCall): { decision: "allow" | "ask"; rule?: string; reason: string };
  retryDenied?(s: Session, item: AttentionItem): void;
  pushItem(item: AttentionItem): void;
  notify(item: AttentionItem, session: Session): void;
  /** Execution changes the engine decides (e.g. a turn that ended with a question). */
  setExecution(session: Session, x: Execution, confidence: "confirmed" | "inferred"): void;
  /** A new live question item (auto-continue candidate). */
  questionRaised?(item: AttentionItem): void;
  /** A live turn ended without a question but reports unfinished work. */
  stoppedShort?(session: Session, text: string, meta: Record<string, unknown>): void;
}

export interface PendingApproval {
  tool: string;
  summary: string;
  ts: number;
  /** Set when Switchboard itself can answer it (Codex daemon server request). */
  answerKey?: string;
}

const ACKABLE: AttentionKind[] = ["finished", "failed", "stalled", "conflict", "escalation"];

export class AttentionEngine {
  /** Events older than this (ms epoch) are history: items may open, but nothing notifies. */
  readonly liveSince: number;
  private permissionChecks = new Map<string, number>();
  private latestTurn = new Map<string, string>();
  private pendingApproval = new Map<string, PendingApproval>();
  /** Approval item ids answered from the UI, so resolution is recorded as answered_ui. */
  private answeredHere = new Set<number>();

  markAnsweredHere(id: number) {
    this.answeredHere.add(id);
  }

  constructor(
    private store: Store,
    private cfg: Config,
    private sink: AttentionSink,
    private resolver = new AmbiguityResolver(null),
    now = Date.now(),
  ) {
    this.liveSince = now - 30_000;
    // Old versions raised guesses directly. Retire them when upgrading, without notifying.
    for (const item of store.openAttention())
      if (item.kind === "stalled") this.resolve(item, "superseded", "unconfirmed stall; coordinator verification required", now);
    // Auto-continue timers do not survive a restart; these questions now need a human.
    for (const item of store.openAttention()) if (item.meta.autoPending || item.meta.permissionPending) {
      item.meta.autoPending = false;
      item.meta.permissionPending = false;
      store.updateAttention(item);
    }
  }

  open(sessionId?: string) {
    return this.store.openAttention(sessionId);
  }

  private raise(s: Session, kind: AttentionKind, sourceKey: string, title: string, text: string | null, ts: number, extra: Partial<AttentionItem> = {}) {
    const historical = ts < this.liveSince;
    const item = this.store.insertAttention({
      sessionId: s.id,
      sessionName: s.name ?? s.goal ?? null,
      kind,
      sourceKey,
      createdAt: ts,
      title,
      text,
      outcome: null,
      status: "open",
      resolvedAt: null,
      resolution: null,
      resolutionNote: null,
      historical,
      ...extra,
      meta: { ...extra.meta, permissionPending: kind === "approval" && this.permissionChecks.has(s.id), autoPending: kind === "question" && !!this.sink.questionRaised && !historical },
    });
    if (!item) return null;
    this.sink.pushItem(item);
    if (!historical && item.status === "open") {
      // Auto-continue gets first look at questions; the notification waits for its verdict.
      if (kind === "question" && this.sink.questionRaised) this.sink.questionRaised(item);
      else this.sink.notify(item, s);
    }
    return item;
  }

  private resolve(item: AttentionItem, resolution: Resolution, note: string | null, ts = Date.now()) {
    if (item.status !== "open") return;
    item.status = "resolved";
    item.resolution = resolution;
    item.resolutionNote = note;
    item.resolvedAt = ts;
    this.store.updateAttention(item);
    this.sink.pushItem(item);
  }

  private resolveKinds(sessionId: string, kinds: AttentionKind[], resolution: Resolution, note: string, ts?: number) {
    for (const it of this.store.openAttention(sessionId)) if (kinds.includes(it.kind)) this.resolve(it, resolution, note, ts);
  }

  /** Called for every stored transcript event, before state is applied. */
  onEvent(s: Session, e: SbEvent, prevTurnStartedAt: number | null) {
    switch (e.type) {
      case "tool_result": {
        if (typeof e.data.denialReason !== "string" || typeof e.data.toolUseId !== "string") break;
        const call = this.store.toolCall(s.id, e.data.toolUseId);
        // Never guess the command from the assistant's explanation or a nearby unrelated call.
        if (!call || typeof call.name !== "string" || call.input === undefined) break;
        const deniedToolCall: DeniedToolCall = { tool: call.name, toolUseId: e.data.toolUseId, input: call.input, cwd: typeof call.cwd === "string" ? call.cwd : s.cwd, reason: e.data.denialReason };
        const answerKey = `tool-denial:${s.id}:${e.data.toolUseId}`;
        // Replay and explicit human denials never trigger autonomous retries. One retry per
        // exact request until it actually executes also bounds repeated provider denials.
        const fingerprint = JSON.stringify([s.id, deniedToolCall.tool, deniedToolCall.input, deniedToolCall.cwd]);
        const previous = this.store.db.query("SELECT data FROM attention WHERE session_id=? AND json_extract(data, '$.meta.autoFingerprint')=? ORDER BY id DESC LIMIT 1").get(s.id, fingerprint) as { data: string } | null;
        const after = previous ? JSON.parse(previous.data).meta.autoEventId : null;
        const executed = typeof after === "number" && this.store.db.query(`
          SELECT 1 FROM events r JOIN events c ON c.session_id=r.session_id AND c.type='tool_call'
            AND json_extract(c.data, '$.toolUseId')=json_extract(r.data, '$.toolUseId')
          WHERE r.session_id=? AND r.type='tool_result' AND r.id>?
            AND json_extract(r.data, '$.denialReason') IS NULL
            AND json_extract(c.data, '$.name')=? AND json_extract(c.data, '$.input')=?
            AND COALESCE(json_extract(c.data, '$.cwd'), ?)=? LIMIT 1
        `).get(s.id, after, call.name, JSON.stringify(call.input), s.cwd, deniedToolCall.cwd);
        // Only a provider prompt nobody could answer is retried; the user's own deny rules and hooks stand.
        const verdict = e.ts >= this.liveSince && (!previous || executed) && providerPromptDenial(deniedToolCall.reason) && !/(?:user|human) (?:denied|declined|rejected|doesn't want)|rejected by (?:the )?user/i.test(deniedToolCall.reason)
          ? this.sink.classifyDenial?.(s, deniedToolCall) : null;
        const automatic = verdict?.decision === "allow" && !!this.sink.retryDenied;
        const item = this.raise(s, "approval", answerKey, automatic ? `Auto-approved: ${call.name}` : `Needs approval: ${call.name}`, deniedCallText(deniedToolCall), e.ts, {
          ...(automatic ? { status: "resolved", resolution: "auto", resolvedAt: Date.now(), resolutionNote: verdict.reason } as const : {}),
          meta: { tool: call.name, answerKey, denialReason: e.data.denialReason, deniedToolCall,
            ...(automatic ? { autoApproved: true, autoRule: verdict.rule, recommendation: verdict.reason, autoFingerprint: fingerprint, autoEventId: e.id, retryPending: true } : {}) },
        });
        if (item && automatic) this.sink.retryDenied!(s, item);
        break;
      }
      case "user_msg":
      case "peer_msg":
      case "auto_msg":
      case "coordinator_msg":
      case "turn_started": {
        this.latestTurn.delete(s.id);
        const who = e.type === "peer_msg" ? "a peer message" : e.type === "auto_msg" ? "auto-continue" : e.type === "coordinator_msg" ? "the coordinator" : "a new prompt in the session";
        this.resolveKinds(s.id, ["question"], e.type === "user_msg" ? "answered_terminal" : "superseded", `answered by ${who}`, e.ts);
        if (e.type === "user_msg") {
          const decisionReply = this.store.outboxFor(s.id, 20).some((m) => m.clientId.startsWith("tool-denial-reply:") && m.text === e.data.text);
          if (!decisionReply) for (const it of this.store.openAttention(s.id)) if (it.meta.deniedToolCall && !it.meta.replyOutboxId) this.resolve(it, "superseded", "a new prompt in the session", e.ts);
        }
        // A new turn means the session moved on: an earlier "finished"/"stalled" notice is stale
        // (otherwise a working session also shows as finished).
        if (e.type === "turn_started" || e.type === "user_msg") this.resolveKinds(s.id, ["finished", "stalled"], "superseded", "the session started a new turn", e.ts);
        break;
      }
      case "turn_ended":
        this.onTurnEnded(s, e, prevTurnStartedAt);
        break;
    }
  }

  private onTurnEnded(s: Session, e: SbEvent, prevTurnStartedAt: number | null) {
    this.latestTurn.set(s.id, e.sourceId);
    // The denial card already asks the human; don't also ask auto-continue to answer the prose.
    const autoHandledTurn = this.store.db.query("SELECT 1 FROM attention WHERE session_id=? AND (json_extract(data, '$.meta.retryPending')=1 OR (json_extract(data, '$.meta.autoFingerprint') IS NOT NULL AND created_at>=? AND created_at<=?)) LIMIT 1").get(s.id, prevTurnStartedAt ?? e.ts + 1, e.ts);
    if (this.store.openAttention(s.id).some((it) => it.meta.deniedToolCall) || autoHandledTurn) return;
    const text = (typeof e.data.lastAgentMessage === "string" && e.data.lastAgentMessage) || s.lastAssistantText;
    const cls = classifyTurnEnd(text);
    const durationMs = typeof e.data.durationMs === "number" ? e.data.durationMs : prevTurnStartedAt ? e.ts - prevTurnStartedAt : null;
    const meta = { continuationAsk: cls.continuationAsk, realChoice: cls.realChoice, durationMs };

    const asQuestion = () => {
      this.raise(s, "question", `turn:${e.sourceId}`, cls.continuationAsk ? "Asks whether to continue" : "Asked you a question", cls.questionText, e.ts, { meta });
      this.sink.setExecution(s, "waiting_answer", "inferred");
    };
    const asFinished = () => {
      if (e.ts < this.liveSince || durationMs === null || durationMs < this.cfg.longRunMs) return;
      const mins = Math.round(durationMs / 60_000);
      this.raise(s, "finished", `turn:${e.sourceId}`, `Finished after ${mins}m`, text ? text.slice(-1500) : null, e.ts, { outcome: cls.outcome, meta });
    };

    const maybeStoppedShort = () => {
      if (e.ts >= this.liveSince && cls.outcome === "incomplete" && text) this.sink.stoppedShort?.(s, text, meta);
    };
    if (cls.question === "yes") return asQuestion();
    if (cls.question === "no") {
      maybeStoppedShort();
      return asFinished();
    }
    // Ambiguous: ask the cheap model only for live turns; history stays heuristic.
    if (e.ts < this.liveSince || !text) return asFinished();
    void this.resolver.isQuestion(e.sourceId, text).then((isQ) => {
      // Ignore the answer if the session already moved on.
      if (s.turnStartedAt !== null || this.latestTurn.get(s.id) !== e.sourceId || s.execution === "ended") return;
      if (isQ) asQuestion();
      else {
        maybeStoppedShort();
        asFinished();
      }
    });
  }

  /** Execution transitions after each discovery tick / hook. */
  onExecutionChange(s: Session, prev: Execution, now = Date.now()) {
    const x = s.execution;
    if (prev === x) return;
    if (x === "waiting_approval" && s.executionConfidence === "confirmed" && !this.store.openAttention(s.id).some((it) => it.kind === "approval" && it.meta.answerKey)) {
      const p = this.pendingApproval.get(s.id);
      this.raise(s, "approval", `approval:${p?.ts ?? now}`, p ? `Needs approval: ${p.tool}` : "Needs approval", p?.summary ?? null, p?.ts ?? now, {
        meta: p ? { tool: p.tool, answerKey: p.answerKey ?? null } : {},
      });
    }
    if (prev === "waiting_approval" && x !== "waiting_approval") {
      for (const it of this.store.openAttention(s.id)) {
        if (it.kind !== "approval" || it.meta.deniedToolCall) continue;
        const fromUi = this.answeredHere.delete(it.id);
        this.resolve(it, fromUi ? "answered_ui" : "answered_terminal", fromUi ? "answered from Switchboard" : "answered in the session", now);
      }
      this.pendingApproval.delete(s.id);
    }
    if (x === "waiting_answer" && s.executionConfidence === "confirmed" && !this.open(s.id).some((i) => i.kind === "question")) {
      // Provider-confirmed (e.g. Codex waitingOnUserInput).
      this.raise(s, "question", `input:${s.turnStartedAt ?? now}`, "Waiting for your input", s.lastAssistantText, now);
    }
    if (prev === "waiting_answer" && (x === "working" || x === "ended")) this.resolveKinds(s.id, ["question"], x === "ended" ? "superseded" : "answered_terminal", x === "ended" ? "session ended" : "the session resumed", now);
    if (prev === "stalled" && x !== "stalled") this.resolveKinds(s.id, ["stalled"], "superseded", "activity resumed", now);
    if (x === "failed") this.raise(s, "failed", `fail:${s.lastActivityAt ?? now}`, "Failed", (s.meta.lastError as string) ?? null, now);
    if (x === "ended") this.resolveKinds(s.id, ["question", "approval", "stalled"], "superseded", "session ended", now);
  }

  /** Claude PermissionRequest / Notification hooks carry what the approval is for. */
  noteApproval(sessionId: string, p: PendingApproval) {
    this.pendingApproval.set(sessionId, p);
    // The registry poll can see "waiting" before the hook arrives: fill in the open item.
    for (const it of this.store.openAttention(sessionId))
      if (it.kind === "approval" && (!it.text || (p.answerKey && !it.meta.answerKey))) {
        it.title = `Needs approval: ${p.tool}`;
        it.text = p.summary;
        it.meta = { ...it.meta, tool: p.tool, answerKey: p.answerKey ?? it.meta.answerKey ?? null };
        this.store.updateAttention(it);
        this.sink.pushItem(it);
      }
  }

  /** A coordinator permission check has first refusal; only its human fallback belongs in Needs you. */
  setPermissionChecking(sessionId: string, checking: boolean) {
    const count = Math.max(0, (this.permissionChecks.get(sessionId) ?? 0) + (checking ? 1 : -1));
    if (count) this.permissionChecks.set(sessionId, count);
    else this.permissionChecks.delete(sessionId);
    for (const item of this.open(sessionId)) if (item.kind === "approval" && !item.meta.answerKey) this.annotate(item.id, { permissionPending: count > 0 });
  }

  /**
   * A permission prompt held for the human in Switchboard (answerKey routes the answer back).
   * recommendation: the coordinator's one-line view, shown with the prompt.
   */
  raisePermission(s: Session, p: { tool: string; summary: string; answerKey: string; recommendation: string | null; questions?: unknown[] }) {
    const title = p.questions ? "Asks you a question" : `Needs approval: ${p.tool}`;
    const meta = { tool: p.tool, answerKey: p.answerKey, recommendation: p.recommendation, permissionPending: false, ...(p.questions ? { questions: p.questions } : {}) };
    // Discovery/hook and the held prompt describe the same decision. Upgrade the existing
    // item in place so the count, notification identity and history remain one item.
    const existing = this.open(s.id).find((i) => i.kind === "approval" && (!i.meta.answerKey || i.meta.answerKey === p.answerKey));
    if (existing) {
      Object.assign(existing, { title, text: p.summary, meta: { ...existing.meta, ...meta } });
      this.store.updateAttention(existing);
      this.sink.pushItem(existing);
      return;
    }
    this.raise(s, "approval", p.answerKey, title, p.summary, Date.now(), { meta });
  }

  /** Terminal/peer replies settle when their transcript receipt confirms delivery. */
  onDelivery(message: OutboxMessage) {
    const matches = this.store.db.query("SELECT data FROM attention WHERE session_id=? AND json_extract(data, '$.meta.replyOutboxId')=?").all(message.sessionId, message.id) as { data: string }[];
    for (const row of matches) {
      const it = JSON.parse(row.data) as AttentionItem;
      if (!it.meta.deniedToolCall || it.meta.replyOutboxId !== message.id) continue;
      if (it.meta.autoFingerprint && message.author === "auto") {
        if (message.state === "accepted") {
          this.annotate(it.id, { retryPending: false, replyState: message.state });
          this.resolve(this.store.getAttention(it.id)!, "auto", `Automatic retry delivered (${it.meta.autoRule})`);
        } else if (message.state === "failed" || message.state === "uncertain") {
          this.annotate(it.id, { replyState: message.state });
          this.retryFailed(it.id, message.error ?? "Retry delivery was not confirmed");
        }
      } else if (message.state === "accepted") this.settlePermission(String(it.meta.answerKey), "answered in Switchboard");
      else this.annotate(it.id, { replyState: message.state, replyError: message.error });
    }
  }

  /** Failed or uncertain automatic delivery returns the exact call to the human. */
  retryFailed(id: number, error: string) {
    const item = this.store.getAttention(id);
    if (!item || !item.meta.autoApproved) return;
    item.status = "open";
    item.resolution = null;
    item.resolvedAt = null;
    item.resolutionNote = null;
    item.title = `Needs approval: ${item.meta.tool}`;
    item.meta = { ...item.meta, autoApproved: false, retryPending: false, replyError: error };
    this.store.updateAttention(item);
    this.sink.pushItem(item);
  }

  /** A held prompt is over: answered here, or it moved back to the session's own terminal. */
  settlePermission(answerKey: string, how: string) {
    const outcome = how === "answered in Switchboard" ? "answered_ui" : "superseded";
    const sessions = new Set<string>();
    for (const it of this.store.openAttention())
      if (it.kind === "approval" && it.meta.answerKey === answerKey) {
        sessions.add(it.sessionId);
        this.resolve(it, outcome, how);
      }
    // The registry's own "waiting for approval" item for the same prompt (it has no answer key)
    // would otherwise stay counted until the session's status moves on.
    for (const sid of sessions)
      for (const it of this.store.openAttention(sid)) if (it.kind === "approval" && !it.meta.answerKey) this.resolve(it, outcome, how);
  }

  /** Silent, already-resolved activity entry: never flashes an actionable card or notification. */
  recordAutoApproval(s: Session, p: { tool: string; summary: string; reason: string; key: string; rule?: string }) {
    for (const item of this.open(s.id)) if (item.kind === "approval" && !item.meta.answerKey) this.resolve(item, "auto", p.reason);
    this.raise(s, "approval", `auto:${p.key}`, `Auto-approved: ${p.tool}`, p.summary, Date.now(), {
      status: "resolved", resolution: "auto", resolvedAt: Date.now(), resolutionNote: p.reason,
      meta: { tool: p.tool, recommendation: p.reason, autoRule: p.rule, autoApproved: true },
    });
  }

  /** Group-level items (perspectives). sessionId is "group:<id>". */
  raiseGroup(groupId: string, name: string, title: string, text: string, key: string, cwd: string) {
    const pseudo = { id: `group:${groupId}`, name, goal: null, cwd } as unknown as Session;
    this.raise(pseudo, "finished", key, title, text, Date.now(), { meta: { groupId } });
  }

  raiseConflict(s: Session, key: string, detail: string, meta: Record<string, unknown>) {
    this.raise(s, "conflict", key, "Possible conflict with another session", detail, Date.now(), { meta });
  }

  /** Only a coordinator verdict creates a user-facing stall card. */
  confirmStall(s: Session, check: StallCheck) {
    if (check.status !== "stuck" || !check.reason?.trim() || !check.suggestedAction?.trim()) throw new Error("a confirmed stall needs a reason and suggested action");
    this.raise(s, "escalation", `confirmed-stall:${check.id}`, check.reason, `Suggested action: ${check.suggestedAction}`, Date.now(), {
      meta: { from: "coordinator", stallCheckId: check.id, suggestedAction: check.suggestedAction },
    });
  }

  resolveStall(sessionId: string, reason: string, now = Date.now()) {
    for (const item of this.store.openAttention(sessionId))
      if (item.meta.stallCheckId) this.resolve(item, "superseded", reason, now);
  }

  /** Coordinator escalations (flag_user, loop/budget halts). Session-less ones use "coordinator". */
  raiseEscalation(s: Session | null, title: string, text: string) {
    const target = s ?? ({ id: "coordinator", name: "Coordinator", goal: null, cwd: null } as unknown as Session);
    this.raise(target, "escalation", `escalation:${Date.now()}:${title}`, title, text, Date.now(), { meta: { from: "coordinator" } });
  }

  /** Resolve a question that auto-continue answered. */
  resolveAuto(id: number, note: string, meta: Record<string, unknown>) {
    const it = this.store.getAttention(id);
    if (!it || it.status !== "open") return;
    it.meta = { ...it.meta, ...meta };
    this.resolve(it, "auto", note);
  }

  annotate(id: number, meta: Record<string, unknown>) {
    const it = this.store.getAttention(id);
    if (!it) return;
    it.meta = { ...it.meta, ...meta };
    this.store.updateAttention(it);
    this.sink.pushItem(it);
  }

  /** Notify for an item whose notification was deferred (auto-continue declined it). */
  notifyDeferred(id: number, s: Session) {
    const it = this.store.getAttention(id);
    if (it && it.status === "open") {
      it.meta.autoPending = false;
      this.annotate(id, { autoPending: false });
      this.sink.notify(it, s);
    }
  }

  acknowledge(id: number): { ok: boolean; error?: string; item?: AttentionItem } {
    const it = this.store.getAttention(id);
    if (!it) return { ok: false, error: "not found" };
    if (it.status !== "open") return { ok: true, item: it };
    if (!ACKABLE.includes(it.kind)) return { ok: false, error: `${it.kind} items resolve only when answered` };
    this.resolve(it, "acknowledged", null);
    return { ok: true, item: it };
  }
}
