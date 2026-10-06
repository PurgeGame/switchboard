// Live control of Codex threads on the shared daemon (approved 2026-10-06, verified on a
// throwaway thread: rejoining does not disturb the TUI, sends render as genuine user turns).
// - subscribe: thread/resume {excludeTurns} = join as an extra subscriber (the TUI keeps driving)
// - send: turn/start when idle, turn/steer (expectedTurnId) when busy, thread/queue/add to queue
// - approvals: server requests reach every subscriber; answering from here resolves it in the TUI
import type { SendMode } from "../../shared/types.ts";
import type { CodexDaemonClient } from "./codex-daemon.ts";

export interface CodexApproval {
  rpcId: number | string;
  threadId: string;
  method: string;
  kind: string;
  summary: string;
  reason: string | null;
  ts: number;
  /** The command, when it is one (for display). */
  command: string | null;
  /** The command as sent (argv or a string), for the permission checks: joining argv loses quoting. */
  rawCommand: string | string[] | null;
  /** Where the command runs, as Codex sent it (null: the thread's cwd). */
  cwd: string | null;
  /** Files a file-change approval would touch. */
  paths: string[];
  /** A file-change approval that also asks for a wider writable root. */
  grantRoot: string | null;
}

export interface SendResult {
  outcome: "accepted" | "failed" | "uncertain";
  detail: string;
  error?: string;
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

export class CodexLive {
  private subscribed = new Set<string>();
  private activeTurn = new Map<string, string>();
  readonly approvals = new Map<string, CodexApproval>(); // key: `${threadId}:${rpcId}`
  onApproval: (a: CodexApproval) => void = () => {};
  onApprovalResolved: (threadId: string, key: string) => void = () => {};
  onReceipt: (threadId: string, clientId: string) => void = () => {};

  constructor(private daemon: CodexDaemonClient) {
    daemon.onNotification((method, params, id) => this.onMessage(method, params, id));
    // After a reconnect the old subscriptions are gone: rejoin.
    daemon.onConnect(() => {
      const threads = [...this.subscribed];
      this.subscribed.clear();
      for (const t of threads) void this.subscribe(t).catch(() => {});
    });
  }

  isSubscribed(threadId: string) {
    return this.subscribed.has(threadId);
  }

  async subscribe(threadId: string) {
    if (this.subscribed.has(threadId)) return;
    if (!(await this.daemon.ensure())) throw new Error(this.daemon.lastError ?? "codex daemon unavailable");
    await this.daemon.call("thread/resume", { threadId, excludeTurns: true });
    this.subscribed.add(threadId);
  }

  async unsubscribe(threadId: string) {
    if (!this.subscribed.delete(threadId)) return;
    this.activeTurn.delete(threadId);
    await this.daemon.call("thread/unsubscribe", { threadId }).catch(() => {});
  }

  private onMessage(method: string, p: any, id?: number | string) {
    const threadId: string | undefined = p?.threadId ?? p?.thread?.id;
    if (!threadId || !this.subscribed.has(threadId)) return;
    if (method === "turn/started" && p.turn?.id) this.activeTurn.set(threadId, p.turn.id);
    else if (method === "turn/completed") this.activeTurn.delete(threadId);
    else if (method === "item/completed" && p.item?.type === "userMessage" && p.item.clientId) this.onReceipt(threadId, p.item.clientId);
    else if (id !== undefined && APPROVAL_METHODS.has(method)) {
      const a: CodexApproval = {
        rpcId: id,
        threadId,
        method,
        kind: p.kind ?? (method.includes("fileChange") || method.includes("Patch") ? "file change" : "command"),
        summary: approvalSummary(p),
        command: Array.isArray(p.command) ? p.command.join(" ") : typeof p.command === "string" ? p.command : null,
        rawCommand: Array.isArray(p.command) && p.command.every((x: unknown) => typeof x === "string") ? p.command : typeof p.command === "string" ? p.command : null,
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        paths: p.changes && typeof p.changes === "object" ? Object.keys(p.changes) : [],
        grantRoot: typeof p.grantRoot === "string" ? p.grantRoot : p.grantRoot != null ? String(p.grantRoot) : null,
        reason: typeof p.reason === "string" ? p.reason : null,
        ts: Date.now(),
      };
      this.approvals.set(`${threadId}:${id}`, a);
      this.onApproval(a);
    } else if (method === "serverRequest/resolved") {
      const key = `${threadId}:${p.requestId}`;
      if (this.approvals.delete(key)) this.onApprovalResolved(threadId, key);
    }
  }

  /** Answer an approval. decision: accept | acceptForSession | decline | cancel. */
  answer(key: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
    const a = this.approvals.get(key);
    if (!a) throw new Error("approval no longer pending");
    this.daemon.respond(a.rpcId, { decision });
  }

  private async latestTurnId(threadId: string): Promise<string | null> {
    const known = this.activeTurn.get(threadId);
    if (known) return known;
    const r = await this.daemon.call<{ data: { id: string; status: string }[] }>("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
    const t = r.data[0];
    return t && t.status === "inProgress" ? t.id : null;
  }

  async send(threadId: string, text: string, images: string[], clientId: string, mode: SendMode): Promise<SendResult> {
    try {
      await this.subscribe(threadId);
    } catch (e) {
      return { outcome: "failed", detail: "subscribe", error: String((e as Error).message ?? e) };
    }
    const input = [{ type: "text", text, text_elements: [] }, ...images.map((path) => ({ type: "localImage", path }))];
    let detail = "turn/start";
    try {
      const { thread } = await this.daemon.call<{ thread: any }>("thread/read", { threadId, includeTurns: false });
      const busy = thread.status?.type === "active";
      if (!busy && mode !== "steer") {
        await this.daemon.call("turn/start", { threadId, input, clientUserMessageId: clientId });
        return { outcome: "accepted", detail };
      }
      if (mode === "queue") {
        detail = "thread/queue/add";
        await this.daemon.call("thread/queue/add", { threadId, input, clientUserMessageId: clientId });
        return { outcome: "accepted", detail };
      }
      detail = "turn/steer";
      for (let attempt = 0; attempt < 2; attempt++) {
        const turnId = await this.latestTurnId(threadId);
        if (!turnId) {
          // The turn ended between our read and now: start a new one instead.
          detail = "turn/start";
          await this.daemon.call("turn/start", { threadId, input, clientUserMessageId: clientId });
          return { outcome: "accepted", detail };
        }
        try {
          await this.daemon.call("turn/steer", { threadId, expectedTurnId: turnId, input, clientUserMessageId: clientId });
          return { outcome: "accepted", detail };
        } catch (e: any) {
          // A precondition failure means nothing was delivered; refresh and retry once.
          if (!/expected active turn id/i.test(e?.message ?? "")) throw e;
          this.activeTurn.delete(threadId);
        }
      }
      return { outcome: "failed", detail, error: "the active turn kept changing" };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Timeouts and dropped connections leave delivery unknown: never retry those blindly.
      if (/timeout|connection closed|not connected/i.test(msg)) return { outcome: "uncertain", detail, error: msg };
      return { outcome: "failed", detail, error: msg };
    }
  }

  /** Ask Codex to compact a thread's context (native thread/compact/start). */
  async compact(threadId: string): Promise<SendResult> {
    try {
      await this.subscribe(threadId);
      await this.daemon.call("thread/compact/start", { threadId });
      return { outcome: "accepted", detail: "thread/compact/start" };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      return { outcome: /timeout|connection closed|not connected/i.test(msg) ? "uncertain" : "failed", detail: "thread/compact/start", error: msg };
    }
  }

  async interrupt(threadId: string): Promise<SendResult> {
    try {
      await this.subscribe(threadId);
      const turnId = await this.latestTurnId(threadId);
      if (!turnId) return { outcome: "failed", detail: "turn/interrupt", error: "no turn is running" };
      await this.daemon.call("turn/interrupt", { threadId, turnId });
      return { outcome: "accepted", detail: "turn/interrupt" };
    } catch (e: any) {
      return { outcome: "failed", detail: "turn/interrupt", error: String(e?.message ?? e) };
    }
  }
}

function approvalSummary(p: any): string {
  if (Array.isArray(p.command)) return p.command.join(" ");
  if (typeof p.command === "string") return p.command;
  if (p.changes && typeof p.changes === "object") return `edit ${Object.keys(p.changes).join(", ")}`;
  if (typeof p.reason === "string") return p.reason;
  return JSON.stringify(p).slice(0, 300);
}
