/** Recognize provider permission failures, not shell EACCES or prose about a denial. */
export function toolDenialReason(text: string): string | null {
  const message = text.trim().replace(/^<tool_use_error>\s*/, "").replace(/\s*<\/tool_use_error>$/, "");
  // This decision already came from our human permission card.
  if (message.includes("Denied from Switchboard by the user.")) return null;
  const prefix = message.replace(/^(?:Error:\s*)?(?:[\w.]+ failed:\s*)?(?:Error:\s*)?/i, "");
  const denials = [
    /^Permission for this action was denied\b/i,
    /^Tool permission request failed\b/i,
    /^(?:The user|User) (?:doesn't want to proceed|denied|declined|rejected)\b/i,
    /^Permission to use .+ (?:has been |was )?denied\b/i,
    /^(?:Claude requested permissions to use .+|.+ requires permission), but you haven't granted it yet\b/i,
    /^(?:PreToolUse|PermissionRequest) hook (?:error|blocked|denied)\b/i,
    /^(?:Tool call|Tool use|Command|Execution|Approval|Permission (?:request|check))(?: request)? (?:was )?(?:denied|rejected|blocked)\b/i,
    /^(?:exec command|patch|tool call) rejected by\b/i,
    /^rejected by (?:user|configuration|automatic|approval)\b/i,
    /^automatic approval review (?:denied|rejected|failed|could not complete|was cancelled)\b/i,
    /^(?:CreateProcess \{\s*message:\s*")?Rejected\(/,
    /^.*rejected by user approval settings\b/i,
  ];
  return denials.some((p) => p.test(prefix)) ? message : null;
}

/**
 * A denial by a provider's own permission prompt that nobody could answer (Claude's auto-mode
 * classifier or a prompt it couldn't show; Codex's automatic approval review): the only kind
 * Switchboard's policy may approve and ask to retry. A rule in the user's own settings, a
 * PreToolUse/permission hook, or a configuration/policy rejection is the user's decision and is
 * never overridden by an automatic retry.
 */
export function providerPromptDenial(reason: string): boolean {
  // The first line says who denied it; later lines are the denier's explanation.
  const who = reason.trim().split("\n")[0];
  if (/\bhooks?\b|\bdeny rule\b|\bsettings\b|\bconfiguration\b|\bpolicy\b/i.test(who)) return false;
  if (/^(?:Error:\s*)?Permission to use .+ (?:has been |was )?denied\b/i.test(who)) return false; // a settings deny rule
  return /Permission for this action was denied by the Claude Code auto mode classifier/i.test(who)
    || /(?:requested permissions to use .+|requires permission), but you haven't granted it yet/i.test(who)
    || /\bautomatic approval review (?:denied|rejected|failed|could not complete|was cancelled)\b/i.test(who);
}

export interface DeniedToolCall {
  tool: string;
  toolUseId: string;
  input: unknown;
  cwd: string | null;
  reason: string;
}

export function deniedCallText(call: DeniedToolCall): string {
  return `${call.tool} (${call.toolUseId})\n${typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2)}${call.cwd ? `\nWorking directory: ${call.cwd}` : ""}`;
}

export function deniedCallReply(call: DeniedToolCall, allow: boolean): string {
  return `${allow
    ? "The user approved this exact tool call in Switchboard. Retry it with the same arguments and working directory. This approval applies only to this call."
    : "The user denied this tool call in Switchboard. Carry on without it; do not retry this call."}\n\n${deniedCallText(call)}\n\nOriginal denial reason:\n${call.reason}`;
}
