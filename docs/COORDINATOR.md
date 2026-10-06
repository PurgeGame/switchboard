# The coordinator agent

A long-lived Claude process, owned by the daemon, that breaks objectives into tasks, assigns and sequences them, hands work off between sessions, verifies results and brings decisions to you. It starts **off** (mode `manual`) and stays off until you switch it on.

## Turning it on

- UI: the coordinator panel (mode switch). API: `POST /api/coordinator/mode {"mode":"active"}`.
- Talk to it: `POST /api/coordinator/chat {"text":"…"}`; its replies arrive as chat entries (`GET /api/coordinator`, WS `{type:"coordinator"}`).
- Let it act on a session you started: `POST /api/coordinator/autopilot {sessionId, enabled:true}`. Keep it away from one: `POST /api/coordinator/exclude {sessionId, excluded:true}`.
- Settings live under `"coordinator"` in `~/.config/switchboard/config.json`:

```json
{ "coordinator": {
    "agent": "builtin",
    "model": "sonnet",
    "debounceMs": 60000, "heartbeatMs": 900000,
    "limits": { "perSessionCooldownMs": 600000, "perSessionPerHour": 6, "maxLaunched": 3, "dailyBudgetUsd": 10,
                "maxRetries": 2, "maxRelayHops": 4, "repeatThreshold": 3, "humanHoldMs": 600000, "dedupeWindowMs": 3600000 },
    "tiers": { "deep": { "claude": { "model": "opus", "effort": "xhigh" }, "codex": { "model": "gpt-6-astra", "effort": "xhigh" } },
               "standard": { "claude": { "model": "sonnet", "effort": null }, "codex": { "model": "gpt-6.1-sol", "effort": null } },
               "light": { "claude": { "model": "haiku", "effort": null }, "codex": { "model": "gpt-6-luna", "effort": null } } },
    "tierRules": [ { "glob": "contracts/**", "tier": "deep", "reason": "smart contracts" } ],
    "worktreeRoot": "~/Dev/.switchboard-worktrees"
} }
```

`"agent"` picks who the coordinator is (D34): `"builtin"` (default; everything below), `"external"` (your own agent, next section) or `"none"` (no coordinator: no coordinator API, no judge, every permission prompt comes to you, and the home screen is a plain **Needs you** list). Restart the daemon after changing it.

## Your own agent as the coordinator (`"agent": "external"`)

The daemon keeps the whole engine (tools, authority, proposals, approvals bound to digests, plans, holds, limits, the activity log) and drops only the brain: it never starts a model for the coordinator and spends nothing. Your agent drives the engine through the same MCP tools the built-in coordinator uses.

1. Set `"coordinator": { "agent": "external" }` in `~/.config/switchboard/config.json` and restart the daemon.
2. Register Switchboard's MCP server with your agent (once; `<checkout>` is this repository):
   - Claude Code: `claude mcp add switchboard -- bun <checkout>/src/cli/sb.ts mcp`
   - Codex: `codex mcp add switchboard -- bun <checkout>/src/cli/sb.ts mcp`
   - Anything else: a stdio MCP server, command `bun <checkout>/src/cli/sb.ts mcp`. It finds the daemon through `config.json` (`port`) and `SB_PORT` / `SB_CONFIG_DIR` if you set them.
3. Turn the coordinator on in the UI (or `POST /api/coordinator/mode {"mode":"active"}`). Off, every tool is refused, as for the built-in one.
4. Start your agent in a folder of its own (not a project it should coordinate) and tell it: "Call `get_instructions` from the switchboard tools and act as the coordinator." Allow its `mcp__switchboard__*` tools in its own permission settings, or each call becomes a permission prompt.

What changes for an external agent:
- **Nothing wakes it.** `get_updates` returns, once, what the built-in coordinator would have been woken with: the events since the last call, new chat messages from you (with their chat id for `route_to_session`), the relay hop and a state line; `restarted: true` after a daemon restart. `waitSeconds` (up to 50) makes it wait for the next event instead of returning empty. `get_instructions` returns `coordinator/COORDINATOR.md` plus a short note on polling. Both are read-only and exist only in external mode.
- **No chat box in the UI.** You talk to your agent in its own window. The UI keeps the coordinator row and pane (Needs you cards with Go ahead / No thanks, Looks good, Retry, permission prompts; What's happening; Pause / Turn on) and shows whether the agent has called in recently. Its `tell_user` messages still show there, and "Not yet…" on a finished task reaches it through `get_updates`.
- **Permission prompts are never judged automatically.** The judge (D29) is a model call the daemon makes for the built-in coordinator only. With an external agent every prompt comes to you, and there is no tool to answer one.
- **Budget:** the daemon spends nothing, so the daily budget is never consumed; your agent's own costs are its own.
- **Credentials:** `sb mcp` reads `coordinator-token`, which reaches only the coordinator tool endpoints. The token rotates on every daemon start; the proxy re-reads it and retries once after a 401, so a restart doesn't break the connection.
- **What the rules can't cover:** every rule in the table below binds what your agent does *through these tools*. Unlike the built-in coordinator (no built-in tools, no settings, only this MCP server), your agent may have a shell and file access as you: it can then read the root token or run commands, and Switchboard can't stop that. Give it only the tools you'd trust it with.

## How it works

- **Process:** `claude -p --input-format stream-json --output-format stream-json --verbose --model <model>` in `~/.local/share/switchboard/coordinator/`, system prompt `coordinator/COORDINATOR.md`, on your Claude subscription login (see DECISIONS D16). No built-in tools; its only tools are the `switchboard` MCP server (`src/daemon/coordinator/mcp-server.ts`), which proxies to the daemon.
- **State:** everything durable is in SQLite: objectives, tasks, claims (Phase 5 tables), plus `coord_kv` (mode, exclusions, autopilot, launched sessions, sent-message history, budget), `coord_activity`, `coord_proposals` and `coord_chat`. When the daemon restarts, a fresh process is started on the next wake and its first message says it restarted, with a state digest.
- **Wakes:** a batched digest, debounced (~60 s), when a relevant session starts or ends, a turn ends, a conflict or stall or other attention item is raised, you edit tasks/objectives, a task finishes, or a task's prerequisites land (the digest includes the prerequisites' results, worktrees and evidence so it can write the handoff). A 15-minute heartbeat runs only while a relevant session is working. Its own `[coordinator]` messages never wake it. Events about unrelated sessions ride along without waking it.
- **Tiers:** `suggestTier` (rules first, then the rubric in `tiers.ts`) runs on every `create_task`. Deep: contracts / `*.sol` / security / funds / auth / crypto / game theory and economics / hard-to-reverse architecture. Light: renames, typos, formatting, greps, scans, docs touch-ups. Otherwise standard. A Settings rule always wins; the coordinator can override the rubric only with a `tierReason`. Every task records why. A light task created with `decisionDepends` can't be marked verified until a session launched at a higher tier is recorded as having checked it.
- **Tools:** `list_sessions`, `get_session`, `get_state`, `get_resources`, `note`, `create_objective`, `create_task`, `update_task`, `record_evidence`, `claim`, `release`, `propose_action`, `send_message`, `request_checkpoint`, `launch_session`, `flag_user`, `set_priority`, `throttle`, `restore`. The last three go to the resource governor and only work for sessions within its authority. An external agent also gets `get_updates` and `get_instructions` (read-only).

## Enforced in daemon code (unit tested in `test/coordinator.test.ts`)

| Rule | Behavior |
|---|---|
| Mode | `manual`: off, every tool refused, process stopped. `paused`: read-only tools only; workers keep running; nothing is killed. `active`: acts. |
| Exclusion | Excluded sessions can't be messaged, assigned or throttled; their pending proposals are cancelled. |
| Recipient routing | Direct messages only to sessions it launched for an objective, or that you put on autopilot. To anyone else, `send_message` becomes a proposal you approve or reject. |
| Prefix and author | Every message starts with `[coordinator]` and goes through the outbox with author `coordinator`. |
| Rate limits | At most 1 message per session per 10 min and 6 per session per hour. A near-identical message to the same session within an hour is dropped. |
| Human instructions win | When you message a session (UI or terminal) or edit a task, its pending proposals are cancelled and the coordinator may not message that session for 10 min. |
| Launch cap | At most 3 live coordinator-launched sessions. Launches without a worktree are held for approval. |
| Budget | Daily cost limit from the CLI's `total_cost_usd`. When reached, the process stops, acting tools are refused, chat is refused and you get an escalation. It resets at UTC midnight. |
| Retry limits | 2 failed sends per session, or 2 failed launches per task, per hour; after that the tool is refused. |
| Loop prevention | Relay hop cap (default 4) for agent → coordinator → agent chains. The same action with the same arguments 3 times in an hour is treated as repeated work. Both pause the coordinator and flag you. |
| Tool surface | No tool answers approvals, runs commands or uses git. The only git operation is `git worktree add` inside `launch_session`. Unknown tools are refused. Every acting tool needs a `reason`. |
| Activity log | Every tool call, refusal, proposal, wake, mode change and override is logged with its reason. |

**Best-effort (labeled in the UI):** a keyword screen for destructive intent (reset, force-push, `rm -rf`, drop table, delete/discard/revert work, …). A matching message or launch brief is held as a proposal and isn't sent. It's a heuristic: it can miss things phrased differently, and it can flag harmless text.

**Behavioral (prompt only, not guaranteed):** never ask sessions to discard, revert, reset, force-push or delete work. Never decide questions addressed to you. Never tell perspective-group members to diverge. Escalate new scope, conflicting requirements and anything irreversible.

## Known gaps

- `launch_session` opens a VS Code terminal through the bridge (same path as Perspectives), so it needs a connected VS Code window. It's tested with a fake launcher, not live.
- Codex workers get the tier's model but not its effort (D4).
- The budget counts only the coordinator's own process, not the workers it launches.
- Stalls reach the coordinator only as attention items; it doesn't detect drift on its own beyond what it reads with `get_session`.
