// Hook payloads (sent by scripts/sb-hook.sh). Only what transcripts and registries can't
// provide: Claude permission prompts are never written to the transcript, so the
// PermissionRequest hook is the only way to know *what* needs approval.
import type { AttentionEngine } from "./attention.ts";
import { toolSummary } from "./adapters/parse-claude.ts";
import type { Registry } from "./registry.ts";
import type { Coordination } from "./coordination.ts";

/** Soft-lock: returns Claude hook JSON (warning, or deny in strict repos) or null. */
export function preToolUse(p: any, registry: Registry, coord: Coordination, strictRepos: string[]): object | null {
  if (typeof p?.session_id !== "string") return null;
  const sid = `claude:${p.session_id}`;
  const path = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
  if (typeof path !== "string") return null;
  const { claimedBy, recentEditors } = coord.lookup(path, sid);
  if (!claimedBy && !recentEditors.length) return null;
  const who = (id: string) => {
    const s = registry.sessions.get(id);
    const task = coord.tasksOf(id)[0];
    return `${s?.name ?? id}${task ? ` (task: ${task.title})` : s?.goal ? ` (goal: ${s.goal})` : ""}`;
  };
  const msg = claimedBy
    ? `Switchboard: ${path} is inside ${claimedBy.resource}, claimed by another session: ${who(claimedBy.owner)}. Coordinate before editing it.`
    : `Switchboard: ${path} was edited in the last hour by another session: ${[...new Set(recentEditors.map((e) => e.session))].map(who).join(", ")}. Check its changes before editing to avoid overwriting them.`;
  const s = registry.sessions.get(sid);
  const strict = !!claimedBy && strictRepos.some((r) => s?.project === r || path.startsWith(r + "/"));
  return strict
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: msg } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: msg } };
}

export function handleHook(provider: string, event: string, p: any, registry: Registry, attention: AttentionEngine) {
  if (provider !== "claude" || typeof p.session_id !== "string") return;
  const sid = `claude:${p.session_id}`;
  const now = Date.now();
  console.log(`[hook] ${provider} ${event} ${sid}${p.notification_type ? ` (${p.notification_type})` : ""}`);
  switch (event) {
    case "PermissionRequest": {
      const tool = String(p.tool_name ?? "tool");
      const { summary } = toolSummary(tool, p.tool_input ?? {});
      const desc = typeof p.tool_input?.description === "string" ? `${p.tool_input.description}\n` : "";
      attention.noteApproval(sid, { tool, summary: `${desc}${summary}`, ts: now });
      registry.update(sid, (s) => {
        s.execution = "waiting_approval";
        s.executionConfidence = "confirmed";
        s.meta.statusDetail = `hook: PermissionRequest (${tool})`;
        s.meta.hookAt = now;
      });
      break;
    }
    case "Notification":
      if (p.notification_type === "permission_prompt")
        registry.update(sid, (s) => {
          if (s.execution !== "waiting_approval") {
            s.execution = "waiting_approval";
            s.executionConfidence = "confirmed";
            s.meta.statusDetail = "hook: permission prompt";
            s.meta.hookAt = now;
          }
        });
      break;
  }
}
