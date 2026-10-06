// Attention engine: turns events and status changes into persistent attention items.
// Rules:
// - question/approval resolve only when actually answered (never by opening the session)
// - finished/failed/stalled resolve on acknowledgment; superseded items close with a note
// - dedupe by (session, kind, source event); at most one notification per item
import type { AttentionItem, AttentionKind, Execution, Resolution, SbEvent, Session } from "../shared/types.ts";
import { AmbiguityResolver, classifyTurnEnd } from "./classify.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";

export interface AttentionSink {
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
      meta: {},
      ...extra,
    });
    if (!item) return null;
    this.sink.pushItem(item);
    if (!historical) {
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
      case "user_msg":
      case "peer_msg":
      case "auto_msg":
      case "coordinator_msg":
      case "turn_started": {
        const who = e.type === "peer_msg" ? "a peer message" : e.type === "auto_msg" ? "auto-continue" : e.type === "coordinator_msg" ? "the coordinator" : "a new prompt in the session";
        this.resolveKinds(s.id, ["question"], e.type === "user_msg" ? "answered_terminal" : "superseded", `answered by ${who}`, e.ts);
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
      if (s.turnStartedAt !== null) return;
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
    if (x === "waiting_approval" && s.executionConfidence === "confirmed") {
      const p = this.pendingApproval.get(s.id);
      this.raise(s, "approval", `approval:${p?.ts ?? now}`, p ? `Needs approval: ${p.tool}` : "Needs approval", p?.summary ?? null, p?.ts ?? now, {
        meta: p ? { tool: p.tool, answerKey: p.answerKey ?? null } : {},
      });
    }
    if (prev === "waiting_approval" && x !== "waiting_approval") {
      for (const it of this.store.openAttention(s.id)) {
        if (it.kind !== "approval") continue;
        const fromUi = this.answeredHere.delete(it.id);
        this.resolve(it, fromUi ? "answered_ui" : "answered_terminal", fromUi ? "answered from Switchboard" : "answered in the session", now);
      }
      this.pendingApproval.delete(s.id);
    }
    if (x === "waiting_answer" && s.executionConfidence === "confirmed") {
      // Provider-confirmed (e.g. Codex waitingOnUserInput).
      this.raise(s, "question", `input:${s.turnStartedAt ?? now}`, "Waiting for your input", s.lastAssistantText, now);
    }
    if (prev === "waiting_answer" && (x === "working" || x === "ended")) this.resolveKinds(s.id, ["question"], x === "ended" ? "superseded" : "answered_terminal", x === "ended" ? "session ended" : "the session resumed", now);
    if (x === "stalled") this.raise(s, "stalled", `stall:${s.lastActivityAt ?? now}`, "Suspected stalled", `No activity since ${new Date(s.lastActivityAt ?? now).toLocaleTimeString()} and no CPU use.`, now);
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

  /**
   * A permission prompt held for the human in Switchboard (answerKey routes the answer back).
   * recommendation: the coordinator's one-line view, shown with the prompt.
   */
  raisePermission(s: Session, p: { tool: string; summary: string; answerKey: string; recommendation: string | null }) {
    this.raise(s, "approval", p.answerKey, `Needs approval: ${p.tool}`, p.summary, Date.now(), {
      meta: { tool: p.tool, answerKey: p.answerKey, recommendation: p.recommendation },
    });
  }

  /** A held prompt is over: answered here, or it moved back to the session's own terminal. */
  settlePermission(answerKey: string, how: string) {
    for (const it of this.store.openAttention())
      if (it.kind === "approval" && it.meta.answerKey === answerKey) this.resolve(it, how === "answered in Switchboard" ? "answered_ui" : "superseded", how);
  }

  /** Visible record of a prompt the coordinator approved on its own. */
  recordAutoApproval(s: Session, p: { tool: string; summary: string; reason: string; key: string }) {
    const it = this.raise(s, "approval", `auto:${p.key}`, `Approved by the coordinator: ${p.tool}`, p.summary, Date.now(), { meta: { tool: p.tool, recommendation: p.reason, autoApproved: true } });
    if (it) this.resolve(it, "auto", `coordinator: ${p.reason}`);
  }

  /** Group-level items (perspectives). sessionId is "group:<id>". */
  raiseGroup(groupId: string, name: string, title: string, text: string, key: string, cwd: string) {
    const pseudo = { id: `group:${groupId}`, name, goal: null, cwd } as unknown as Session;
    this.raise(pseudo, "finished", key, title, text, Date.now(), { meta: { groupId } });
  }

  raiseConflict(s: Session, key: string, detail: string, meta: Record<string, unknown>) {
    this.raise(s, "conflict", key, "Possible conflict with another session", detail, Date.now(), { meta });
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
    if (it && it.status === "open") this.sink.notify(it, s);
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
