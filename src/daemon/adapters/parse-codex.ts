// Codex rollout line -> normalized events. Pure; tested against fixtures.
// Handles 0.160 (`event_msg/item_completed` with PascalCase items) and older
// `user_message` / `agent_message` event_msgs.
import type { SbEvent } from "../../shared/types.ts";

export interface CodexParseResult {
  events: SbEvent[];
  patch?: {
    cwd?: string;
    model?: string;
    originator?: string;
    branch?: string;
    tokens?: number;
    rateLimitPct?: number;
    effort?: string;
    contextTokens?: number;
    contextWindow?: number;
  };
}

const clip = (s: string, n = 20_000) => (s.length > n ? s.slice(0, n) + "…" : s);
const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) || Date.now() : Date.now());

function itemText(item: any): string {
  const c = item?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: any) => x?.text ?? "").filter(Boolean).join("\n");
  return typeof item?.text === "string" ? item.text : "";
}

export function parseCodexLine(line: any, sessionId: string, offsetKey: string): CodexParseResult {
  const events: SbEvent[] = [];
  const ts = ms(line?.timestamp);
  const base = line?.ordinal !== undefined ? `o${line.ordinal}` : offsetKey;
  const push = (suffix: string, type: SbEvent["type"], data: Record<string, unknown>) =>
    events.push({ sessionId, sourceId: suffix ? `${base}:${suffix}` : base, type, ts, data });
  const patch: NonNullable<CodexParseResult["patch"]> = {};
  const p = line?.payload ?? {};

  switch (line?.type) {
    case "session_meta":
      if (p.cwd) patch.cwd = p.cwd;
      if (p.originator) patch.originator = p.originator;
      if (p.git?.branch) patch.branch = p.git.branch;
      push("", "session_started", { cwd: p.cwd ?? null, originator: p.originator ?? null, cliVersion: p.cli_version ?? null });
      break;
    case "turn_context":
      if (p.model) patch.model = p.model;
      if (typeof p.effort === "string") patch.effort = p.effort;
      break;
    case "event_msg":
      switch (p.type) {
        case "task_started":
          push("", "turn_started", { turnId: p.turn_id ?? null });
          break;
        case "task_complete":
          push("", "turn_ended", {
            turnId: p.turn_id ?? null,
            durationMs: p.duration_ms ?? null,
            lastAgentMessage: p.last_agent_message ? clip(String(p.last_agent_message), 4000) : null,
          });
          break;
        case "turn_aborted":
          push("", "interrupted", { turnId: p.turn_id ?? null, reason: p.reason ?? null });
          break;
        case "thread_settings_applied":
          if (p.thread_settings?.model) patch.model = p.thread_settings.model;
          break;
        case "token_count": {
          const total = p.info?.total_token_usage?.total_tokens;
          if (typeof total === "number") patch.tokens = total;
          const last = p.info?.last_token_usage?.input_tokens;
          if (typeof last === "number") patch.contextTokens = last;
          if (typeof p.info?.model_context_window === "number") patch.contextWindow = p.info.model_context_window;
          const pct = p.rate_limits?.primary?.used_percent;
          if (typeof pct === "number") patch.rateLimitPct = pct;
          break;
        }
        case "user_message": // older versions
          push("", "user_msg", { text: clip(String(p.message ?? "")) });
          break;
        case "agent_message": // older versions
          push("", "assistant_msg", { text: clip(String(p.message ?? "")) });
          break;
        case "error":
        case "stream_error":
          push("", "error", { text: clip(String(p.message ?? p.error ?? "error"), 2000) });
          break;
        case "item_completed": {
          const it = p.item ?? {};
          switch (it.type) {
            case "UserMessage":
              push("", "user_msg", { text: clip(itemText(it)), clientId: it.client_id ?? null });
              break;
            case "AgentMessage":
              push("", "assistant_msg", { text: clip(itemText(it)), phase: it.phase ?? null });
              break;
            case "CommandExecution": {
              const cmd = Array.isArray(it.command) ? it.command.join(" ") : String(it.command ?? "");
              push("", "tool_call", { name: "exec", summary: clip(cmd, 300), exitCode: it.exit_code ?? null, status: it.status ?? null, paths: [] });
              break;
            }
            case "FileChange": {
              const paths = Object.keys(it.changes ?? {});
              push("", "tool_call", { name: "apply_patch", summary: paths.join(", ").slice(0, 300), paths });
              break;
            }
            case "Extension":
              push("", "tool_call", { name: it.kind ?? "extension", summary: clip(String(it.query ?? ""), 300), paths: [] });
              break;
          }
          break;
        }
      }
      break;
  }
  return { events, patch: Object.keys(patch).length ? patch : undefined };
}
