// MCP tool definitions for the coordinator. The surface is deliberately small: no tool answers
// approvals, runs commands or touches git (worktrees are created only inside launch_session).
const str = (description: string) => ({ type: "string", description });
const reason = str("Why you are doing this (logged; required for every action).");
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const TOOLS: ToolDef[] = [
  { name: "list_sessions", description: "List live AI sessions with your authority over each (autonomous / suggest / excluded) and their tasks.", inputSchema: { type: "object", properties: { includeEnded: { type: "boolean" } } } },
  { name: "get_session", description: "One session's details plus a recent transcript excerpt.", inputSchema: { type: "object", properties: { sessionId: str("session id") }, required: ["sessionId"] } },
  { name: "get_state", description: "Objectives, tasks, claims, conflicts, pending proposals, budget.", inputSchema: { type: "object", properties: {} } },
  { name: "get_resources", description: "Resource governor snapshot (CPU/memory per session, throttles).", inputSchema: { type: "object", properties: {} } },
  { name: "note", description: "Write a note to the activity log (thinking out loud for the user).", inputSchema: { type: "object", properties: { text: str("note") }, required: ["text"] } },
  { name: "create_objective", description: "Propose a new objective with the repository it covers. This only queues a proposal; you get no authority from it. If the human approves that exact proposal, the daemon creates the objective and grants it root (+ resources). Acceptance checks are the human's to declare.", inputSchema: { type: "object", properties: { title: str("title"), description: str("description"), priority: { enum: ["high", "normal", "low"] }, root: str("absolute path of the existing repository directory the objective covers"), resources: strs("non-path resources it needs, e.g. port:3000, db:name, branch:/repo@name"), reason }, required: ["title", "root", "reason"] } },
  {
    name: "create_task",
    description: "Create a task with acceptance criteria and prerequisites. The daemon suggests a tier from a rubric and Settings rules (rules always win). To override the rubric pass tier + tierReason.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("title"),
        description: str("what to do"),
        objectiveId: str("objective id"),
        scope: { type: "object", properties: { paths: strs("files/dirs/globs"), resources: strs("e.g. port:3000, db:name") } },
        prerequisites: strs("task ids that must be verified with eligible evidence first"),
        acceptance: strs("acceptance criteria (at least one)"),
        tier: { enum: ["deep", "standard", "light"] },
        tierReason: str("required when overriding the suggested tier"),
        decisionDepends: { type: "boolean", description: "a later decision depends on this result (marks it for review; all tiers require human or daemon-checked evidence)" },
        owner: str("session id (only sessions within your authority)"),
        priority: { enum: ["high", "normal", "low"] },
        reason,
      },
      required: ["title", "objectiveId", "scope", "acceptance", "reason"],
    },
  },
  {
    name: "propose_plan",
    description:
      "Delegate a piece of work: one plan (objective + tasks + which agent does each) shown to the user as ONE card. If they tap Go ahead, the daemon grants the root, creates every task, launches each task whose prerequisites are done (its own worktree, at its tier and provider; capped, the rest queue) and launches dependents automatically once their prerequisites are VERIFIED. Nothing exists until they approve. Settings tier rules override your tiers (recorded on the card).",
    inputSchema: {
      type: "object",
      properties: {
        title: str("what the user asked for, short"),
        root: str("absolute path of the existing repository directory all tasks work in"),
        resources: strs("non-path resources the work needs, e.g. port:3000"),
        tasks: {
          type: "array",
          description: "1-8 small, independent-where-possible tasks",
          items: {
            type: "object",
            properties: {
              key: str("short unique key, e.g. api, tests (used by prerequisites)"),
              title: str("one line"),
              brief: str("what to do: files/areas, constraints, anything the worker must know"),
              acceptance: strs("checkable acceptance criteria (at least one)"),
              prerequisites: strs("keys of tasks in this plan that must be verified first"),
              provider: { enum: ["claude", "codex"] },
              tier: { enum: ["light", "standard", "deep"] },
              tierReason: str("why this tier/provider (required when overriding the suggested tier)"),
              paths: strs("scope inside root (files/dirs); defaults to the whole root"),
            },
            required: ["key", "title", "brief", "acceptance", "provider", "tier"],
          },
        },
        reason,
      },
      required: ["title", "root", "tasks", "reason"],
    },
  },
  {
    name: "update_task",
    description: "Update a task: status (assigned|in_progress|blocked|finished_unverified|verified|rejected), result, owner, tier (+tierReason), scope. Only human-reviewed or daemon-checked evidence permits verified; acceptance criteria are human-editable only.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: str("task id"),
        status: { enum: ["unassigned", "assigned", "in_progress", "blocked", "finished_unverified", "verified", "rejected"] },
        result: str("result summary"),
        owner: str("session id"),
        tier: { enum: ["deep", "standard", "light"] },
        tierReason: str("reason for a tier override"),
        scope: { type: "object", properties: { paths: strs("paths"), resources: strs("resources") } },
        prerequisites: strs("task ids"),
        reason,
      },
      required: ["taskId", "reason"],
    },
  },
  { name: "record_evidence", description: "Record evidence for a criterion, referencing an observed source event from the task owner. Only human-declared daemon checks can automatically verify it; model claims/tier do not establish correctness.", inputSchema: { type: "object", properties: { taskId: str("task id"), text: str("evidence"), criterion: str("exact acceptance criterion"), sourceId: str("source event id in the task owner transcript"), reason }, required: ["taskId", "text", "criterion", "sourceId", "reason"] } },
  { name: "claim", description: "Atomically claim a resource for a session (path:/abs/dir/**, branch:/repo@name, port:3000…). Overlapping exclusive claims queue.", inputSchema: { type: "object", properties: { owner: str("session id"), resource: str("resource"), exclusive: { type: "boolean" }, taskId: str("task id"), reason }, required: ["owner", "resource", "reason"] } },
  { name: "release", description: "Release a claim you made.", inputSchema: { type: "object", properties: { claimId: { type: "number" }, reason }, required: ["claimId", "reason"] } },
  { name: "propose_action", description: "Put a proposal in the user's queue (anything outside your authority, new scope, decisions that are theirs).", inputSchema: { type: "object", properties: { title: str("one line"), detail: str("concise context and the exact action"), sessionId: str("session id"), taskId: str("task id"), reason }, required: ["title", "detail", "reason"] } },
  {
    name: "route_to_session",
    description:
      "Deliver one of the user's chat messages (verbatim, with any attached images) to the session it is meant for. Use this when the user's message is an instruction or question for a session rather than for you. You choose the destination; you can't change the words. Each chat message can be routed once. If it's unclear which session is meant, ask the user in your reply instead of guessing.",
    inputSchema: { type: "object", properties: { chatId: { type: "number", description: "the chat # from MESSAGE FROM THE USER" }, sessionId: str("destination session id"), reason }, required: ["chatId", "sessionId", "reason"] },
  },
  {
    name: "ask_several",
    description:
      "When the user wants several perspectives (\"ask Claude and Codex\", \"get a second opinion\", \"compare approaches\"): send one prompt to several new sessions, independently, then compare and synthesize. Always becomes a one-tap proposal for the user. Default members: one Claude and one Codex.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: str("the exact prompt every agent gets"),
        cwd: str("absolute folder they work in"),
        members: { type: "array", items: { type: "object", properties: { provider: { enum: ["claude", "codex"] }, model: str("optional model") }, required: ["provider"] } },
        reason,
      },
      required: ["prompt", "cwd", "reason"],
    },
  },
  {
    name: "tell_user",
    description:
      "Post a message in the user's chat with you when nobody asked, e.g. a group's synthesis is ready, or work they're waiting on finished. Your plain replies to background events are NOT shown to the user, so use this only for things they'd want to know now. Never for 'nothing to do'.",
    inputSchema: { type: "object", properties: { text: str("short, plain message"), reason }, required: ["text", "reason"] },
  },
  { name: "get_group", description: "Read a perspective group you started: each agent's answer and the synthesis.", inputSchema: { type: "object", properties: { groupId: str("group id") }, required: ["groupId"] } },
  {
    name: "refresh_context",
    description:
      "Keep a session's context healthy between turns. how=compact: summarize its context, keeping what matters (give a one-line focus). how=fresh: clear it and continue from your hand-off brief (Claude; Codex compacts then gets the brief). Only when its turn has ended. Sessions the user drives get a proposal.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: str("session id"),
        how: { enum: ["compact", "fresh"] },
        focus: str("compact: what to keep (one line)"),
        brief: str("fresh: hand-off brief - what's done, where (files/branch), how it was verified, exactly what to do next"),
        taskId: str("related task"),
        reason,
      },
      required: ["sessionId", "how", "reason"],
    },
  },
  { name: "send_message", description: "Message a session. Sessions you launched (or on autopilot) receive it directly; for sessions the user drives it becomes a proposal. Rate limited; prefixed [coordinator]; destructive-sounding text is held for approval.", inputSchema: { type: "object", properties: { sessionId: str("session id"), text: str("message"), taskId: str("related task"), reason }, required: ["sessionId", "text", "reason"] } },
  { name: "request_checkpoint", description: "Ask a session for a checkpoint: what's done, evidence, what remains vs acceptance criteria. Same gate as send_message.", inputSchema: { type: "object", properties: { sessionId: str("session id"), taskId: str("task id"), note: str("extra ask"), reason }, required: ["sessionId", "reason"] } },
  {
    name: "launch_session",
    description: "Launch a worker for a task (under an objective) at the task's tier, in its own git worktree by default (~/Dev/.switchboard-worktrees/<repo>/<slug>). Capped concurrency.",
    inputSchema: { type: "object", properties: { taskId: str("task id"), provider: { enum: ["claude", "codex"] }, repo: str("absolute path of the git repo (or folder with worktree:false)"), worktree: { type: "boolean" }, tier: { enum: ["deep", "standard", "light"] }, tierReason: str("reason when overriding"), prompt: str("the brief for the worker"), reason }, required: ["taskId", "repo", "reason"] },
  },
  { name: "flag_user", description: "Escalate to the user (raises an inbox item): new scope, conflicting requirements, destructive/irreversible steps, anything outside your authority.", inputSchema: { type: "object", properties: { title: str("one line"), text: str("concise context and the decision needed"), sessionId: str("related session") }, required: ["title", "text"] } },
  { name: "set_priority", description: "Set a session's resource priority (sessions within your authority only; the governor's rules apply).", inputSchema: { type: "object", properties: { sessionId: str("session id"), priority: { enum: ["high", "normal", "low"] }, reason }, required: ["sessionId", "priority", "reason"] } },
  { name: "throttle", description: "Ask the governor to throttle a session (1 = light, 2 = strong). Never kills.", inputSchema: { type: "object", properties: { sessionId: str("session id"), level: { enum: [1, 2] }, reason }, required: ["sessionId", "level", "reason"] } },
  { name: "restore", description: "Undo a throttle.", inputSchema: { type: "object", properties: { sessionId: str("session id"), reason }, required: ["sessionId", "reason"] } },
];

/** The built-in brain's tools (its --allowedTools list). */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * Only for an external agent (coordinator.agent "external", D34): nothing wakes it, so it polls.
 * Both are read-only. The built-in brain doesn't get them: its wakes already carry the digest.
 */
export const EXTERNAL_TOOLS: ToolDef[] = [
  {
    name: "get_updates",
    description:
      "What happened since your last call, then cleared: events (sessions starting/ending, turns ending, attention items, conflicts, user edits, proposals resolved), new chat messages from the user (answer with tell_user; route work with route_to_session and the chat id), and a one-line state summary. Call it in a loop; pass waitSeconds to wait for the next event instead of getting an empty answer.",
    inputSchema: { type: "object", properties: { waitSeconds: { type: "number", description: "0-50: wait this long for something to happen when nothing is pending (default 0)" } } },
  },
  { name: "get_instructions", description: "Your instructions as the Switchboard coordinator: read them before anything else.", inputSchema: { type: "object", properties: {} } },
];
export const EXTERNAL_TOOL_NAMES = EXTERNAL_TOOLS.map((t) => t.name);
