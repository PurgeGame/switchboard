// Messaging: every send (human, coordinator, auto) goes through here.
// - persistent outbox with idempotency keys: a repeated POST never re-sends
// - a reused idempotency key must carry the same request (versioned fingerprint), else 409
// - exactly one control path per session (pinned, persisted), used by sends, interrupts and approvals;
//   switching needs an explicit flag and is refused while any delivery is unresolved
// - delivery states: queued → sending → accepted | failed | uncertain. "failed" only when provably
//   nothing was written; anything ambiguous is "uncertain", never retried, settled by a receipt or the human
// - receipts: the message's id in the target's own transcript, or a one-to-one text match
import { createHash, randomUUID } from "node:crypto";
import type { Author, DispatchContext, OutboxMessage, SbEvent, SendMethod, SendMode, Session } from "../shared/types.ts";
import { DeliveryError, sendPeerMessage } from "./adapters/claude-peer.ts";
import type { CodexLive } from "./adapters/codex-live.ts";
import { cmdlineOf } from "./proc.ts";
import type { Store } from "./db.ts";
import type { Registry } from "./registry.ts";
import type { Uploads } from "./uploads.ts";

export interface TerminalSender {
  /** Can we inject into this session's terminal right now (bridge connected, terminal mapped)? */
  canSend(s: Session): boolean;
  /**
   * images are pasted separately so the TUI can attach them (Claude does; Codex keeps paths as text).
   * On failure, wrote: false means provably nothing reached the terminal (refused before any write).
   * Anything else (timeouts, failures after a paste) may have arrived and is treated as uncertain.
   */
  send(s: Session, text: string, images?: string[]): Promise<TerminalResult>;
  interrupt(s: Session): Promise<TerminalResult>;
}

export interface TerminalResult {
  ok: boolean;
  error?: string;
  wrote?: boolean;
}

export interface SendRequest {
  sessionId: string;
  text: string;
  images?: string[];
  clientId?: string;
  mode?: SendMode;
  method?: SendMethod;
  /** Required to move a session to a different control path than the one it is pinned to. */
  switchMethod?: boolean;
  author?: Author;
  /** Coordinator sends only: what was authorized, rechecked by `authorize` right before transport. */
  context?: DispatchContext;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const RECEIPT_TIMEOUT_MS = 90_000;
const FINGERPRINT_VERSION = 1;
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/** Versioned identity of a send request: a reused idempotency key must carry the same request. */
export function fingerprint(req: SendRequest): string {
  const parts: unknown[] = [FINGERPRINT_VERSION, req.sessionId, req.author ?? "human", req.method ?? null, req.mode ?? "auto", req.text.trim(), req.images ?? []];
  // The authority context is part of the request: the same key can't carry a different task or approval.
  if (req.context) parts.push(req.context.taskId, req.context.proposalId, req.context.humanApproved);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export class Messenger {
  /** The one control path each session is driven through. Persisted: survives restarts. */
  private pinned: Map<string, SendMethod>;
  terminal: TerminalSender | null = null;
  /**
   * Transport-time policy for coordinator messages: throws to refuse. Runs after every queueing
   * and locking step, immediately before anything is written, so a message can't outlive a
   * revoked grant, a pause, an exclusion or a manual override that happened while it waited.
   */
  authorize: ((m: OutboxMessage) => void) | null = null;

  constructor(
    private store: Store,
    private registry: Registry,
    private codex: CodexLive,
    private uploads: Uploads,
    private push: (m: OutboxMessage) => void,
  ) {
    codex.onReceipt = (thread, clientId) => this.markReceipt(clientId, thread);
    this.pinned = new Map(store.loadLocks());
    // Anything in flight when the previous daemon stopped has an unknown outcome. Never resend
    // it; a receipt in the transcript (tailing resumes from saved offsets) can still confirm it.
    for (const m of store.outboxInState(["queued", "sending"]))
      this.update(m, { state: "uncertain", error: m.error ?? "the daemon restarted before delivery was confirmed" });
  }

  /** Available send methods for a session, best first. */
  methods(s: Session): SendMethod[] {
    if (s.execution === "ended") return [];
    const out: SendMethod[] = [];
    if (s.provider === "codex" && s.meta.onDaemon) out.push("codex-daemon");
    if (this.terminal?.canSend(s)) out.push("terminal");
    if (s.provider === "claude" && s.kind !== "vscode" && typeof s.meta.messagingSocketPath === "string") out.push("peer");
    return out;
  }

  controls(s: Session): Session["controls"] {
    const daemon = s.provider === "codex" && !!s.meta.onDaemon && s.execution !== "ended";
    const term = !!this.terminal?.canSend(s);
    const pin = this.pinned.get(s.id);
    // Controls follow the pinned path: a session driven through its terminal isn't also steered over the daemon.
    const viaDaemon = daemon && (!pin || pin === "codex-daemon");
    const viaTerm = term && (!pin || pin === "terminal");
    return { interrupt: viaDaemon || viaTerm, steer: viaDaemon, queue: viaDaemon, approve: viaDaemon };
  }

  pinnedMethod(sessionId: string) {
    return this.pinned.get(sessionId) ?? null;
  }

  /**
   * Take (or confirm) the session's control path for an operation. Switching paths needs explicit
   * confirmation and is refused while any delivery on the session is unresolved: a second path
   * could duplicate a message that already arrived.
   */
  acquire(sessionId: string, method: SendMethod, switchMethod = false): void {
    const pinned = this.pinned.get(sessionId);
    if (pinned === method) return;
    if (pinned) {
      if (!switchMethod) throw new SendError(`this session is driven via ${pinned}; switching to ${method} needs explicit confirmation`, 409, { pinnedTo: pinned });
      const open = this.store.unresolvedOutbox(sessionId);
      if (open.length)
        throw new SendError(`can't switch to ${method} while ${open.length} message(s) on ${pinned} are unresolved: check the session, then mark them delivered or not delivered`, 409, {
          pinnedTo: pinned,
          unresolved: open.map((m) => m.id),
        });
    }
    this.pinned.set(sessionId, method);
    this.store.setLock(sessionId, method);
  }

  private release(sessionId: string) {
    const recent = this.store.outboxFor(sessionId, 5);
    if (recent.some((x) => x.state === "accepted") || this.store.unresolvedOutbox(sessionId).length) return;
    this.pinned.delete(sessionId);
    this.store.deleteLock(sessionId);
  }

  async send(req: SendRequest): Promise<OutboxMessage> {
    const s = this.registry.sessions.get(req.sessionId);
    if (!s) throw new SendError("unknown session", 404);
    const text = req.text.trim();
    const images = req.images ?? [];
    if (!text && !images.length) throw new SendError("empty message", 400);
    for (const p of images) if (!this.uploads.owns(p)) throw new SendError(`not an uploaded image: ${p}`, 400);

    // Idempotency first: a retried POST returns the original message untouched. A key reused for a
    // different request is an error, never a misleading success.
    const fp = fingerprint({ ...req, text, images });
    if (req.clientId) {
      const existing = this.store.outboxByClientId(req.clientId);
      if (existing) {
        const same = existing.fingerprint ? existing.fingerprint === fp : existing.sessionId === req.sessionId && existing.text === text;
        if (!same) throw new SendError("this idempotency key was already used for a different message", 409, { existingId: existing.id });
        return existing;
      }
    }
    const available = this.methods(s);
    const pinned = this.pinned.get(s.id);
    const method = req.method ?? pinned ?? available[0];
    if (!method || !available.includes(method)) throw new SendError(available.length ? `method ${method} is not available for this session` : "this session is observe-only", 409);
    this.acquire(s.id, method, req.switchMethod);

    const now = Date.now();
    const { message: m, created } = this.store.insertOutbox({
      sessionId: s.id,
      clientId: req.clientId ?? randomUUID(),
      author: req.author ?? "human",
      method,
      mode: req.mode ?? "auto",
      state: "queued",
      text,
      images,
      // Claude's TUI turns a pasted image path into a real attachment (verified); Codex's does not.
      imageDelivery: images.length ? (method === "codex-daemon" || (method === "terminal" && s.provider === "claude") ? "image" : "path") : null,
      createdAt: now,
      updatedAt: now,
      error: null,
      receipt: false,
      detail: null,
      fingerprint: fp,
      context: req.context,
    });
    if (!created) return m;
    if (m.author === "coordinator") {
      // A coordinator message with no policy hook installed is refused, never sent unchecked.
      try {
        if (!this.authorize) throw new Error("no delivery policy is installed");
        this.authorize(m);
      } catch (e) {
        this.update(m, { state: "failed", detail: "refused at delivery", error: `refused at delivery: ${(e as Error).message}` });
        this.release(s.id);
        return m;
      }
    }
    this.update(m, { state: "sending" });

    if (method === "codex-daemon") {
      const r = await this.codex.send(s.nativeId, text, images, m.clientId, m.mode);
      this.update(m, { state: m.receipt ? "accepted" : r.outcome, detail: r.detail, error: r.error ?? null });
    } else if (method === "peer") {
      const body = images.length ? `${text}\n\n[Images attached as files: ${images.join(", ")}]` : text;
      try {
        await sendPeerMessage(String(s.meta.messagingSocketPath), body, m.clientId);
        this.update(m, { detail: "peer socket" }); // stays "sending" until the transcript shows it
      } catch (e: any) {
        const definite = e instanceof DeliveryError && !e.wrote;
        this.update(m, { state: definite ? "failed" : "uncertain", detail: "peer socket", error: String(e?.message ?? e) });
      }
    } else if (method === "terminal" && this.terminal) {
      const asImages = s.provider === "claude";
      const body = images.length && !asImages ? `${text}\n\n${images.join("\n")}` : text;
      const r = await this.terminal.send(s, body, asImages ? images : []);
      if (r.ok) this.update(m, m.context?.maintenance ? { state: "accepted", detail: "command typed" } : { detail: "terminal" });
      else this.update(m, { state: r.wrote === false ? "failed" : "uncertain", detail: "terminal", error: r.error ?? "terminal send failed" });
    }
    if (m.state === "failed") this.release(s.id);
    return m;
  }

  /** Interrupt through the session's control path (taking it if none is pinned yet). */
  async interrupt(sessionId: string) {
    const s = this.registry.sessions.get(sessionId);
    if (!s) throw new SendError("unknown session", 404);
    const pinned = this.pinned.get(s.id);
    const daemon = s.provider === "codex" && !!s.meta.onDaemon;
    const term = !!this.terminal?.canSend(s);
    const method: SendMethod | null = pinned ? pinned : daemon ? "codex-daemon" : term ? "terminal" : null;
    if (method === "codex-daemon" && daemon) {
      this.acquire(s.id, method);
      return this.codex.interrupt(s.nativeId);
    }
    if (method === "terminal" && term) {
      this.acquire(s.id, method);
      const r = await this.terminal!.interrupt(s);
      return { outcome: r.ok ? "accepted" : r.wrote === false ? "failed" : "uncertain", detail: "terminal Esc", error: r.error };
    }
    throw new SendError(pinned ? `this session is driven via ${pinned}, which can't interrupt it` : "interrupt is not supported for this session", 409);
  }

  /**
   * End a session for the user: stop its turn if it's working, then type its own exit command
   * (/exit for Claude, /quit for Codex) through the guarded terminal path. Without a reachable
   * terminal, signal the agent process, but only a confirmed pid that really is claude/codex.
   * History stays on disk either way.
   */
  async end(sessionId: string): Promise<{ ok: boolean; how: string; error?: string }> {
    const s = this.registry.sessions.get(sessionId);
    if (!s) throw new SendError("unknown session", 404);
    if (s.execution === "ended") return { ok: true, how: "already ended" };
    if (s.execution === "working") {
      await this.interrupt(sessionId).catch(() => null);
      await Bun.sleep(1500);
    }
    if (this.terminal?.canSend(s)) {
      const r = await this.terminal.send(s, s.provider === "codex" ? "/quit" : "/exit");
      if (r.ok) return { ok: true, how: "typed the exit command" };
      if (r.wrote !== false) return { ok: false, how: "terminal", error: `may not have ended: ${r.error ?? "unknown"}` };
    }
    const pid = s.pid;
    if (pid && s.pidConfidence === "confirmed") {
      const cmd = cmdlineOf(pid).join(" ");
      if (!/(^|\/)(claude|codex)(\s|$)|@openai\/codex|claude-code/.test(cmd)) return { ok: false, how: "signal", error: "that process doesn't look like the agent; not touching it" };
      try {
        process.kill(pid, "SIGTERM");
        return { ok: true, how: "asked the process to exit" };
      } catch (e) {
        return { ok: false, how: "signal", error: (e as Error).message };
      }
    }
    throw new SendError("Switchboard can't reach this session to end it: close it in its own window", 409);
  }

  /** The human settles an uncertain delivery after looking at the session. */
  resolve(id: number, as: "delivered" | "not_delivered"): OutboxMessage {
    const m = this.store.outboxById(id);
    if (!m) throw new SendError("unknown message", 404);
    if (m.state !== "uncertain" && m.state !== "sending") throw new SendError(`message is ${m.state}, not uncertain`, 409);
    this.update(m, {
      state: as === "delivered" ? "accepted" : "failed",
      resolution: as,
      detail: as === "delivered" ? "you confirmed it arrived" : "you confirmed it did not arrive",
    });
    if (as === "not_delivered") this.release(m.sessionId);
    return m;
  }

  private update(m: OutboxMessage, patch: Partial<OutboxMessage>) {
    Object.assign(m, patch, { updatedAt: Date.now() });
    this.store.updateOutbox(m);
    this.push(m);
  }

  /** A native receipt names its message; when it names a thread too, that must be the message's target. */
  markReceipt(clientId: string, thread?: string) {
    const m = this.store.outboxByClientId(clientId);
    if (!m || m.receipt) return;
    if (thread !== undefined && this.registry.sessions.get(m.sessionId)?.nativeId !== thread) return;
    // The transcript is the ground truth: an arrival beats any earlier guess.
    this.update(m, { receipt: true, state: "accepted" });
  }

  /**
   * Text-matched receipts are one-to-one: an observed turn confirms a send only when exactly one
   * unconfirmed send could have produced it. Ambiguous matches confirm nothing.
   */
  private matchOne(sessionId: string, method: SendMethod, ts: number, fits: (sent: string) => boolean) {
    const candidates = this.store
      .outboxFor(sessionId, 20)
      .filter((x) => x.method === method && !x.receipt && x.state !== "failed" && x.createdAt <= ts + 5000 && fits(norm(x.text)));
    if (candidates.length === 1) this.markReceipt(candidates[0].clientId);
  }

  /** Transcript events carry the ids we sent (Codex clientId, Claude peer msg_id). */
  onEvent(e: SbEvent) {
    const id = e.data.clientId ?? e.data.msgId;
    if (typeof id === "string" && id) return this.markReceipt(id);
    // Peer frames from a non-session sender keep no msg_id; the recipient records the
    // kernel-verified sender pid (ours) and the body, so match on both.
    if (e.type === "peer_msg" && e.data.peerPid === process.pid && typeof e.data.text === "string") {
      const body = norm(e.data.text);
      this.matchOne(e.sessionId, "peer", e.ts, (sent) => body === sent || body.startsWith(sent + " [Images attached"));
    }
    // Terminal sends arrive as ordinary user turns: the whole sent text must be there.
    if (e.type === "user_msg" && typeof e.data.text === "string") {
      const got = norm(e.data.text);
      this.matchOne(e.sessionId, "terminal", e.ts, (sent) => sent.length > 0 && got.includes(sent));
    }
  }

  /** Sends still unconfirmed after the timeout become uncertain (and are never retried). */
  sweep(now = Date.now()) {
    for (const m of this.store.outboxInState(["sending", "queued"])) {
      const s = this.registry.sessions.get(m.sessionId);
      // A busy session takes typed input at its next pause: that's waiting, not lost.
      if (s?.execution === "working") {
        if (m.detail !== "queued" && m.method !== "codex-daemon") this.update(m, { detail: "queued" });
        continue;
      }
      // Only after it has been quiet for the whole window without showing the message is it in doubt.
      const since = Math.max(m.updatedAt, s?.lastActivityAt ?? 0);
      if (now - since > RECEIPT_TIMEOUT_MS) this.update(m, { state: "uncertain", error: m.error ?? "no confirmation from the session" });
    }
  }
}
