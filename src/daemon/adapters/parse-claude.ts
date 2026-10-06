// Claude Code transcript record -> normalized events. Pure; tested against fixtures.
import type { SbEvent } from "../../shared/types.ts";

export interface ParseResult {
  events: SbEvent[];
  /** State hints that are not stored as events. `softTurnEnd`: the model ended its turn (end_turn). */
  patch?: { name?: string; model?: string; branch?: string; cwd?: string; softTurnEnd?: boolean; effort?: string; contextTokens?: number };
}

const MAX_TEXT = 20_000;
/** Text the harness delivers as a "user" message that the human did not type. */
const SYSTEM_DELIVERY = /^\s*<(task-notification|cross-session-message|local-command-caveat|command-name)\b/;
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + "…" : s);
const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) || Date.now() : Date.now());

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  return "";
}

export function toolSummary(name: string, input: any): { summary: string; paths: string[] } {
  const paths: string[] = [];
  for (const k of ["file_path", "notebook_path", "path"]) if (typeof input?.[k] === "string") paths.push(input[k]);
  let summary = "";
  if (name === "Bash") summary = String(input?.command ?? "");
  else if (paths.length) summary = paths[0];
  else if (typeof input?.pattern === "string") summary = input.pattern;
  else if (typeof input?.description === "string") summary = input.description;
  else if (typeof input?.url === "string") summary = input.url;
  else summary = JSON.stringify(input ?? {});
  return { summary: clip(summary, 300), paths };
}

export function parseClaudeRecord(r: any, sessionId: string, offsetKey: string): ParseResult {
  const events: SbEvent[] = [];
  const ts = ms(r?.timestamp);
  const base = r?.uuid ?? offsetKey;
  const push = (suffix: string, type: SbEvent["type"], data: Record<string, unknown>) =>
    events.push({ sessionId, sourceId: suffix ? `${base}:${suffix}` : base, type, ts, data });
  const patch: ParseResult["patch"] = {};
  if (typeof r?.gitBranch === "string" && r.gitBranch) patch.branch = r.gitBranch;

  switch (r?.type) {
    case "user": {
      const content = r.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
        content.forEach((b: any, i: number) => {
          if (b?.type !== "tool_result") return;
          const preview = typeof b.content === "string" ? b.content : textOf(b.content);
          push(`r${i}`, "tool_result", { toolUseId: b.tool_use_id, isError: !!b.is_error, preview: clip(preview, 600) });
        });
        break;
      }
      const text = textOf(content);
      if (/^\[Request interrupted by user/.test(text)) {
        push("", "interrupted", { text });
        break;
      }
      const kind = r.origin?.kind;
      if (kind === "peer") {
        // Session senders get a tagged envelope; non-session senders a plain-text wrapper.
        const body =
          r.origin?.body ??
          text.match(/<cross-session-message[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/)?.[1] ??
          text.match(/sent a message:\n([\s\S]*?)\n\nThis came from another Claude session/)?.[1] ??
          text;
        push("", "peer_msg", {
          text: clip(String(body)),
          from: r.origin?.name ?? r.origin?.from ?? null,
          msgId: r.origin?.msg_id ?? null,
          peerPid: r.origin?.verifiedPeerPid ?? null, // kernel-verified sender pid
        });
        push("turn", "turn_started", { origin: "peer" });
      } else if (kind === "auto-continuation") {
        push("", "auto_msg", { text: clip(text) });
        push("turn", "turn_started", { origin: "auto" });
      } else if ((kind === "human" || (!r.isMeta && kind === undefined && text)) && !SYSTEM_DELIVERY.test(text)) {
        push("", "user_msg", { text: clip(text) });
        push("turn", "turn_started", { origin: "human" });
      }
      break;
    }
    case "assistant": {
      const m = r.message ?? {};
      if (typeof m.model === "string" && m.model !== "<synthetic>") patch.model = m.model;
      const effort = r.perTurnEffort ?? r.effort;
      if (typeof effort === "string") patch.effort = effort;
      // Context in use = everything the model read this turn (fresh + cached input).
      const u = m.usage;
      if (u && typeof u.input_tokens === "number" && !r.isSidechain)
        patch.contextTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (r.isApiErrorMessage) {
        push("", "error", { text: clip(textOf(m.content), 2000), status: r.apiErrorStatus ?? null, kind: r.error ?? null });
        break;
      }
      (Array.isArray(m.content) ? m.content : []).forEach((b: any, i: number) => {
        if (b?.type === "text" && b.text) push(`b${i}`, "assistant_msg", { text: clip(b.text), messageId: m.id ?? null });
        else if (b?.type === "tool_use") {
          const { summary, paths } = toolSummary(b.name, b.input);
          push(`b${i}`, "tool_call", { name: b.name, toolUseId: b.id, summary, paths });
        }
      });
      if (m.stop_reason === "end_turn") patch.softTurnEnd = true;
      if (m.stop_reason === "refusal") push("refusal", "error", { text: "Model refused", kind: "refusal" });
      break;
    }
    case "system":
      if (r.subtype === "turn_duration") push("", "turn_ended", { durationMs: r.durationMs ?? null });
      break;
    // queue-operation records are not surfaced: peer messages and task notifications pass
    // through the queue too (unwrapped), and human input typed mid-turn is delivered later as
    // a queued_command attachment, which becomes the user_msg below.
    case "attachment": {
      const a = r.attachment;
      const kind = a?.origin?.kind;
      if (a?.type === "queued_command" && typeof a.prompt === "string" && (kind === undefined || kind === "human") && !SYSTEM_DELIVERY.test(a.prompt))
        push("", "user_msg", { text: clip(a.prompt), queued: true });
      break;
    }
    case "custom-title":
    case "agent-name": {
      const name = r.customTitle ?? r.agentName;
      if (name) patch.name = name; // the registry emits `renamed` only when the name actually changes
      break;
    }
  }
  return { events, patch: Object.keys(patch).length ? patch : undefined };
}
