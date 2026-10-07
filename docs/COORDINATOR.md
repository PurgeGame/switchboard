# The coordinator agent

A long-lived Codex or Claude process, owned by the daemon, that breaks objectives into tasks, assigns and sequences them, hands work off between sessions, verifies results and brings decisions to you. Claude is the default; an explicitly saved Codex selection is respected. It starts **off** (mode `manual`) and stays off until you switch it on.

## Turning it on

- UI: the coordinator panel (mode switch). API: `POST /api/coordinator/mode {"mode":"active"}`.
- Talk to it: `POST /api/coordinator/chat {"text":"…"}`; its replies arrive as chat entries (`GET /api/coordinator`, WS `{type:"coordinator"}`).
- Let it act on a session you started: `POST /api/coordinator/autopilot {sessionId, enabled:true}`. Keep it away from one: `POST /api/coordinator/exclude {sessionId, excluded:true}`.
- Settings live under `"coordinator"` in `~/.config/switchboard/config.json`:

```json
{ "coordinator": {
    "agent": "builtin",
    "provider": "claude",
    "model": "opus", "effort": "xhigh",
    "codex": { "model": "gpt-6.1-sol", "effort": "high" },
    "debounceMs": 60000, "heartbeatMs": 900000,
    "autoEnd": { "enabled": true, "idleMinutes": 10 },
    "limits": { "perSessionCooldownMs": 600000, "perSessionPerHour": 6, "maxLaunched": 3, "dailyBudgetUsd": 10,
                "maxRetries": 2, "maxRelayHops": 4, "repeatThreshold": 3, "humanHoldMs": 600000, "dedupeWindowMs": 3600000 },
    "tiers": { "deep": { "claude": { "model": "opus", "effort": "xhigh" }, "codex": { "model": "gpt-6-astra", "effort": "xhigh" } },
               "standard": { "claude": { "model": "sonnet", "effort": null }, "codex": { "model": "gpt-6.1-sol", "effort": null } },
               "light": { "claude": { "model": "haiku", "effort": null }, "codex": { "model": "gpt-6-luna", "effort": null } } },
    "tierRules": [ { "glob": "contracts/**", "tier": "deep", "reason": "smart contracts" } ],
    "worktreeRoot": "~/Dev/.switchboard-worktrees"
} }
```

These are the defaults. Setting `perSessionCooldownMs` / `perSessionPerHour` explicitly to 0 removes that per-time limit on its messages (near-duplicates are still dropped, and relay chains still halt at `maxRelayHops`); a missing, negative or non-numeric limit keeps the default. The hourly cap also applies to messages you asked for in chat (`userChat`, D36), which skip only the cooldown. `maxLaunched` counts only real workers: ones working or waiting on a question or approval, or whose task is still open; an idle worker whose task is finished, verified or rejected doesn't hold a slot. `model` / `effort` select the Claude brain; `codex.model` / `codex.effort` select the Codex brain. Both choices are remembered when you switch.

`"agent"` picks who the coordinator is (D34): `"builtin"` (default; everything below), `"external"` (your own agent, next section) or `"none"` (no coordinator: no coordinator API or model judge; the Settings safe permission policy still works, and the home screen is a plain **Needs you** list). Restart the daemon after changing it.

## Switching Claude / Codex

Once this version is deployed, open **Settings → Coordinator → Use Codex now** to switch a running Claude coordinator in one click. This saves Codex as the selected runtime and replaces only the coordinator process. The daemon and workers keep running, and active/paused mode stays the same. If the coordinator is off, choose **Runtime: Codex**, then turn it on.

The **Runtime** and **Model** dropdowns save automatically for the next coordinator start. Click **Restart coordinator** to apply a pending choice immediately; no daemon restart is needed. Settings shows the current model separately from the saved choice. Changes require human credentials: the coordinator's MCP token cannot read or change these settings or restart itself. The equivalent human endpoints are `GET/POST /api/coordinator/runtime` (save `{provider, model, effort}`) and `POST /api/coordinator/restart`.

Codex uses the installed **codex-cli 0.160.1** and the existing ChatGPT file login (`codex login`, `~/.codex/auth.json`, or `SB_CODEX_HOME`). The version is pinned because its model catalog can enable built-in tools independently of feature flags; a different version is refused until its tool surface is revalidated: the coordinator then does not start, and the coordinator header and Settings show the installed and required versions and what to do. Supported models are `gpt-6-astra`, `gpt-6.1-sol` (default), `gpt-6-sol` and `gpt-6-luna`. A token refresh inside the private `CODEX_HOME` is copied back to your `~/.codex/auth.json` (atomically, mode 0600, never over a newer login) every minute while it runs, when it stops, and when the daemon exits, so your own Codex keeps a working refresh token. It starts a private stdio app-server with an isolated configuration, no shell/file/edit/browser/agent tools, no user or project instructions, hooks, skills or plugins, and the same Switchboard MCP tools and `coordinator/COORDINATOR.md`. Codex additionally advertises three inert MCP resource-discovery helpers; the proxy rejects those methods and exposes no resources.

Objectives, grants, tasks, claims, plans, proposals, chat provenance and uses, holds, limits and daily spend remain in daemon SQLite. Pending events and queued/in-flight turns are journaled before delivery. A new brain has no private conversation memory: it receives a restart digest and can fetch `get_state` with `include: ["history"]` for recent chat, plans and unfinished turns. An interrupted turn is marked for reconciliation because some actions may already have succeeded; the daemon's existing deduplication, reservations and authority checks still apply. A switch does not grant fresh chat authority or reset the budget.

The private Switchboard MCP server pre-authorizes its explicit tool allowlist with `default_tools_approval_mode = "approve"`. This avoids Codex's redundant MCP approval gate under `approval_policy = "never"`; it does not authorize an action in the daemon. The daemon still enforces chat provenance, grants, exclusions, destructive screening and budgets, and creates approval cards when those checks require human review. Built-in tools and other MCP servers remain unavailable.

Codex reports token usage rather than Claude's cumulative dollar cost. The daemon charges the same daily cap using pinned standard API-equivalent token rates (including cache and long-context rates), as an estimate rather than a subscription bill. Unknown models, model reroutes and invalid token accounting stop the brain. Provider replies and latency can differ. Safe worker permission asks use the daemon's deterministic policy; the optional Haiku message classifier still uses Claude, and worker provider choices are unchanged.

`test/coordinator-codex.test.ts` exercises both provider protocols through the real MCP proxy and daemon, including matching refusals and recovery from SQLite. Its installed-Codex wire tests use local fake inference to verify the actual advertised tool surface and execute direct chat requests without extra approval cards. They also verify that background and destructive actions still become daemon proposals and fabricated chat authority is refused, without spending provider quota. Browser e2e uses protocol stand-ins to exercise Settings and verify the daemon PID survives a switch.

## Ending finished background workers

The daemon checks every 30 seconds while the coordinator is **active**, without waking a model. It ends a worker only when all of these hold:

- The coordinator launched it (including background perspective members), or you explicitly enabled its autopilot. User-driven and excluded sessions stay open.
- Its turn has ended and it is confirmed idle, with no open question, permission prompt or pending message delivery.
- Every task it owns is **verified or rejected**. `finished_unverified` does not qualify. A task it was launched for must also be verified or rejected. A worker owning no tasks needs a completed perspective group (including automatic synthesis) or a plan whose tasks are all verified or rejected.
- You have not typed in its Switchboard composer or sent it a message in the last **30 minutes**. Terminal messages also count; unsent terminal keystrokes are not observable. This hold survives daemon restarts and is independent of the coordinator's messaging cooldown.
- It has remained idle for the grace period, **10 minutes** by default. A new turn or activity restarts the timer. Restarting the daemon also starts a fresh idle observation.
- It has no running subagents or live child processes, and its entire Git worktree is clean, including staged, unstaged and untracked changes. Codex subagents inside the shared daemon count even when they have no separate process. If the process, subagent state or worktree cannot be checked reliably, it stays open.

A dirty worktree raises a **Finished worker has uncommitted changes** attention item instead of ending the session. Repeated checks do not create duplicate notices while it stays dirty, including after a restart. Commit the work or end the session yourself; cleanup never commits or discards files.

Open **Settings → End finished background workers** to switch cleanup off, or set **Idle grace (minutes)** and save (1–1440). Changes apply immediately, start a fresh grace period and persist in SQLite. `coordinator.autoEnd` in `config.json` supplies the defaults until you save a Settings override. The human-only API is `POST /api/coordinator/auto-end {"enabled":true,"idleMinutes":10}`; current values are in `GET /api/coordinator`. Pausing or turning off the coordinator also stops automatic ending.

Cleanup uses the same shutdown and cleanup path as `close_session`: the provider's exit command or a guarded process signal, then claim release and removal from launch tracking so queued work can proceed. It rechecks eligibility before shutdown and before a fallback signal. Each successful closure records `auto_end_session`, the completion reason and idle/user-activity limits in the activity log. Refusals and transport failures leave claims and launch tracking intact. Coverage is in `test/auto-end.test.ts`, `test/end-session.test.ts`, the daemon API tests and the browser Settings checks.

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
- **No chat box in the UI.** You talk to your agent in its own window. The UI keeps the coordinator row and pane (Needs you cards with Go ahead / No thanks, Looks good, Retry, permission prompts; What's happening; Pause / Turn on) and shows whether the agent has called in recently. Its `tell_user` messages still show there. "Not yet…" feedback goes to the task's live worker; if it cannot take the note, `get_updates` returns `task_rejected_with_feedback`.
- **Safe permission policy is independent of the coordinator (D44).** Settings → Auto-approve safe permissions is off by default. On (`autoApproveSafePermissions: true`), it approves reviewed reads for any session not excluded, and repository test/typecheck/build/lint commands, which run project code, only for workers the coordinator launched inside their own Switchboard worktree; `"all"` extends those to every session not excluded. Excluded sessions are never auto-approved. All others come to you; there is no coordinator tool to answer them. The former model judge is not used by the daemon.
- **Budget:** the daemon spends nothing, so the daily budget is never consumed; your agent's own costs are its own.
- **Credentials:** `sb mcp` reads `coordinator-token`, which reaches only the coordinator tool endpoints. The token rotates on every daemon start; the proxy re-reads it and retries once after a 401, so a restart doesn't break the connection.
- **What the rules can't cover:** every rule in the table below binds what your agent does *through these tools*. Unlike the built-in coordinator (no built-in tools, no settings, only this MCP server), your agent may have a shell and file access as you: it can then read the root token or run commands, and Switchboard can't stop that. Give it only the tools you'd trust it with.

## How it works

### Coordinator memory

Settings → **Coordinator memory** lists durable lessons with their sources, categories and reinforcement counts. The scrollable editor works on a phone: add, edit or delete a lesson, optionally scoped to an absolute repository path. Changes apply to the next coordinator startup; the running coordinator can also call `list_lessons`.

Memory starts empty. (Earlier versions seeded four lessons; databases that already have them keep them until you delete them.)

**What the coordinator writes, you review.** Lessons you write in Settings apply at once. A `user preference` lesson the coordinator records about you is **pending**: it is never put in the memory block until you choose **Keep** in Settings (or **Discard** it), and it raises a Needs you notice. Keep is bound to the exact text and version you saw, so a lesson the coordinator changed after you looked must be reviewed again. A coordinator change to a kept preference makes it pending again; reinforcing it word for word does not. The coordinator's other lessons (process, provider+tier, repo-specific) apply right away but are listed as **New** until you tap **Got it**. The coordinator can't edit, delete, merge away or evict a lesson you wrote (a near-duplicate only reinforces yours); authorship comes from the credential that wrote it, not from the request.

The daemon stores lessons in SQLite (`coord_lessons`), independently of the model process. Each has an id, one or two lines of text, category (`user preference`, `process`, `provider+tier`, `repo-specific`), optional repo path, source, reason, creation/update timestamps and hit count. `remember` adds or updates, merging near-duplicates within a category/repo; `forget` removes an obsolete lesson. Updating/reinforcing increments the hit count. Memory is capped at about 4,000 estimated tokens including metadata (UTF-8 bytes / 3 plus block overhead); the oldest, least reinforced entries go first (a coordinator write only evicts the coordinator's own lessons). Merely reading memory does not inflate usefulness.

Record repeated corrections, explicit user preferences, approaches that failed or were refused, and provider/tier outcomes worth carrying forward. Keep lessons short, cite a chat/event/task/proposal/activity source with a reason, and **prefer updating an existing lesson** by id. Summarize outcomes in your own words; never copy worker transcripts. A refusal is evidence to improve planning, never permission to work around authority checks.

At each process start, the agent prepends the same delimited `coordinator_memory` block before its first actual runtime message, whether the first turn is a digest or chat. This lives above `RuntimeLike`, with no Claude/model branching; both the Codex and Claude runtimes use the same path. External Claude/Codex agents receive it via `get_instructions` and the first `get_updates` after daemon restart. Repo lessons with a path appear only for active objective roots or relevant live sessions within that path. Unscoped repo lessons remain compact in the shared block.

No thanks, task rejection, a direct session override, daemon refusals and completed plans produce bounded reflection signals with source ids. User chat asks the coordinator to decide whether the message contains a correction or lasting preference. Signals are kept in `coord_reflections` (32 entries, repeated source/kind coalesced; a session override is one signal per session, naming its latest event) and included as `coordinator_reflect` in the next normal event digest, chat turn or external poll. They never schedule a separate wake, including after a busy turn, and do not automatically become lessons.

**Guidance only, never authority.** The block explicitly says memory cannot grant permission, bypass approvals, change scope or override daemon checks or current user instructions. Approval-bypass language and instruction delimiters are rejected on write. Known verbatim worker output (any 12-word run of a stored transcript) is refused; a source made only of citations (`chat #42`, `task <id>`) isn't screened, since transcripts mention what it cites; any other source is. Every record in the memory and reflect blocks is JSON with angle brackets escaped, so no field can close its block; transcript events are never automatically written as lessons. Memory is not consulted by dispatch, grants, mode, budget or approval gates. MCP writes require the coordinator credential; Settings writes require an authenticated browser session, even while the coordinator is off. Root-bearer worker/script calls cannot write through either memory route, and a caller-supplied actor field grants nothing. As with the existing credential model, this is an API boundary, not isolation from a process with the user's full filesystem access and credentials.

### Runtime and coordination

- **Process:** Codex runs a private `codex app-server --listen stdio://`; Claude uses `claude -p --input-format stream-json --output-format stream-json --verbose --model <model>` on your Claude subscription login (see DECISIONS D16). Both run below `~/.local/share/switchboard/coordinator/`, use the exact prompt `coordinator/COORDINATOR.md`, and act only through the same `switchboard` MCP server (`src/daemon/coordinator/mcp-server.ts`), which proxies to the daemon.
- **State:** everything durable is in SQLite: objectives, tasks, claims (Phase 5 tables), plus `coord_kv` (mode, exclusions, autopilot, launched sessions, sent-message history, budget, pending events and unfinished turns), `coord_activity`, `coord_proposals` and `coord_chat`. When the daemon restarts, a fresh process is started on the next wake and its first message says it restarted, with a state digest. Unfinished active work schedules its own recovery wake.
- **Wakes:** a batched digest, debounced (~60 s), when a relevant session starts or ends, a turn ends, a conflict or attention item is raised, a `stall_suspected` check is needed, you edit tasks/objectives, a task finishes, or a task's prerequisites land (the digest includes the prerequisites' results, worktrees and evidence so it can write the handoff). A 15-minute heartbeat runs only while a relevant session is working. Its own `[coordinator]` messages never wake it. Events about unrelated sessions ride along without waking it.
- **Tiers:** `suggestTier` (rules first, then the rubric in `tiers.ts`) runs on every `create_task`. Deep: contracts / `*.sol` / security / funds / auth / crypto / game theory and economics / hard-to-reverse architecture. Light: renames, typos, formatting, greps, scans, docs touch-ups. Otherwise standard. A Settings rule always wins; the coordinator can override the rubric only with a `tierReason`. Every task records why. A light task created with `decisionDepends` can't be marked verified until a session launched at a higher tier is recorded as having checked it.
- **Tools:** `list_sessions`, `get_session`, `get_state`, `get_resources`, `get_usage`, `note`, `create_objective`, `create_task`, `update_task`, `record_evidence`, `claim`, `release`, `propose_action`, `send_message`, `request_checkpoint`, `report_stall`, `launch_session`, `resolve_launch`, `close_session`, `flag_user`, `set_priority`, `throttle`, `restore`. The last three go to the resource governor and only work for sessions within its authority. An external agent also gets `get_updates` and `get_instructions` (read-only).

## Needs you and denied tool calls

One pinned **Needs you** list appears above every workspace view. It combines human decisions on proposals, finished tasks awaiting review, failed plan launches, permission prompts, worker questions and coordinator escalations. Confirmed stalls and uncommitted-work warnings from automatic cleanup use this same list. Phone push and the item count use the same selection, with persistent notification identities across reconnects and restarts. Enable phone notifications from the list; disable them in Settings alongside the worker cleanup controls.

A transcript-recorded tool denial appears as an Allow/Deny item when its result can be matched to the original call. Expand it to see the exact command or input, working directory and denial reason. Allow sends human authorization for that exact call back to the worker; Deny tells it to continue without retrying the call. This does not grant broader permission or execute the command itself. The card stays open until delivery is confirmed. Sending, queued and uncertain replies disable both the compact and expanded buttons; only a confirmed delivery failure permits retry. These decisions remain human-only, and an open denial or unresolved reply prevents automatic worker cleanup.

### Sending finished work back

**Not yet… → Send back** requires a nonblank note. The human-only `POST /api/tasks/:id/feedback` action records it in the task's `feedback` history and the authority audit, changes `finished_unverified` to `in_progress`, and publishes the change before waiting for delivery. The note is visible under **Task history** in What's happening and subsequent review cards. Earlier verification eligibility is cleared; recorded evidence history stays. The Needs you card disappears immediately and returns only after the task finishes again. Opening or cancelling Not yet without a note leaves the task unchanged; duplicate or stale submissions are refused.

The note is sent as a human message through the existing outbox to the current worker if it is alive and reachable. Pending coordinator proposals for that task/worker are cancelled. When the worker is ended, missing, unreachable, or delivery fails, the daemon queues **`task_rejected_with_feedback`** for the coordinator. External coordinators receive it through `get_updates`; the built-in coordinator receives it in its wake digest. It is a task-level event (`sessionId: null`) with `data: { taskId, note }`, plus `outboxId` and `deliveryState` when a send was attempted and returned an outbox entry. The digest text also includes the task id, full note and delivery problem. Normal coordinator mode rules still apply; the task and its feedback remain saved when the coordinator is off.

On this event, inspect the task, its worker and any outbox entry. Decide whether to resume or relaunch the worker, or route the note to a follow-up task, using existing grant, scope and launch checks. The feedback action does not launch anything or expand authority. An uncertain delivery also raises this event: check whether the note arrived before sending it again. Sending or queued messages stay on their existing delivery path.

## Suspected stalls

Quiet working sessions generate an internal `stall_suspected` event, never a status icon or attention item. The event carries `sessionId`, `checkId`, `silentForMs` and `lastStep` (last tool call or step); external agents receive `sessionId` on the event and the other fields under `data` in `get_updates`. The built-in coordinator receives the same details in its wake digest. Waiting for an answer or permission, an ended turn, running subagents, CPU activity, or any live child process (including a sleeping command) suppress detection. Excluded sessions and the coordinator itself do not wake the coordinator.

On `stall_suspected`:
1. Call `get_session`. Inspect `stallCheck`, the recent transcript, resources and subagents. A stale event may already have resolved.
2. For sessions you may message (`canRequestCheckpoint`), call `request_checkpoint`: ask what is running, whether progress is happening, and what would unblock it. Existing cooldowns, hourly limits, duplicate suppression and human holds still apply. A refused checkpoint or a slow reply is not evidence of a stall. For sessions the user drives, inspect only; don't make a message proposal just because they went quiet.
3. Call `report_stall` with `sessionId`, `checkId`, `status` and a one-line `reason`. Use `working` for a long build, test run, subagents, or an API wait supported by evidence. It resolves silently and suppresses repeat checks for the same silent episode. If the evidence confirms a stuck session, use `stuck` and include `suggestedAction`: a concrete action the user can take in Switchboard (for example, reply with a missing credential or approve a recovery proposal). Never confirm based only on elapsed time.

Only `stuck` creates a **Needs you** attention card with the reason and suggested action. It does not change the session's execution status or add a stall icon. `report_stall` requires inspection first and a checkpoint attempt before confirming workers you may message. Stale confirmations are refused. New activity, a wait on the user, live work, an explicit `working` verdict, or session end clears an existing confirmed card. Check ids and verdicts survive daemon restart; pending checks are offered again when the coordinator is active. Existing unconfirmed stall notices are retired on upgrade.

## Enforced in daemon code (unit tested in `test/coordinator.test.ts`)

| Rule | Behavior |
|---|---|
| Mode | `manual`: off, every tool refused, process stopped. `paused`: read-only tools only; workers keep running; nothing is killed. `active`: acts. |
| Exclusion | Excluded sessions can't be messaged, assigned or throttled; their pending proposals are cancelled. |
| Recipient routing | Direct messages only to sessions it launched for an objective, or that you put on autopilot. To anyone else, `send_message` becomes a proposal you approve or reject. Approving sends exactly that text; it needs no task. A proposal that approval would refuse for a reason already known (a task that session doesn't own, a root that isn't an existing plain directory) is refused when the coordinator makes it, so every card can be approved (D35). |
| Your chat instructions | A mutating call can pass `userChat`, the chat # of your message. If it's a message you typed in the coordinator chat (no pasted text or images), sent in the last 30 min while the coordinator was on, and one of your last 3, the call runs as your own action with no card (D36): messages and refreshes for sessions you drive, objectives and plans (only for a folder your message names, or one already granted; otherwise a card), `ask_several`, tasks and claims for any session, launching, retrying or editing plan tasks, releasing any claim. Exclusion, the destructive screen, permission prompts, the budget, near-duplicates, the hourly cap and the relay-chain halt still apply; one message covers at most 8 calls. |
| Prefix and author | Every message starts with `[coordinator]` and goes through the outbox with author `coordinator`. |
| Rate limits | At most 1 message per session per 10 min and 6 per session per hour. A near-identical message to the same session within an hour is dropped. |
| Human instructions win | When you message a session (UI or terminal) or edit a task, its pending proposals are cancelled and the coordinator may not message that session for 10 min. |
| Launch cap | At most `maxLaunched` real coordinator workers (default 3). Launches without a worktree are held for approval. The coordinator can close an idle worker once its tasks are verified or rejected (`close_session`); the daemon also ends eligible finished workers after the configured grace period, as above. It settles a launch whose outcome was uncertain after the daemon's checks (`resolve_launch`); a task with a live worker is never launched again (D39). |
| Budget | One daily cost limit across runtime switches: Claude's `total_cost_usd`, or Codex token usage priced at pinned API-equivalent rates. When reached, the process stops, acting tools are refused, chat is refused and you get an escalation. It resets at UTC midnight. |
| Retry limits | 2 failed sends per session, or 2 failed launches per task, per hour; after that the tool is refused. |
| Loop prevention | Relay hop cap (default 4) for agent → coordinator → agent chains. The same action with the same arguments 3 times in an hour is treated as repeated work. Both pause the coordinator and flag you. |
| Tool surface | No tool answers approvals, runs commands or uses git. The launch path uses `git worktree add`; automatic worker cleanup reads `git status` to protect uncommitted work. Unknown tools are refused. Every acting tool needs a `reason`. |
| Activity log | Every tool call, refusal, proposal, wake, mode change and override is logged with its reason. |

**Best-effort (labeled in the UI):** a keyword screen for destructive intent (reset, force-push, `rm -rf`, drop table, delete/discard/revert work, …). A matching message or launch brief is held as a proposal and isn't sent. It's a heuristic: it can miss things phrased differently, and it can flag harmless text.

**Behavioral (prompt only, not guaranteed):** never ask sessions to discard, revert, reset, force-push or delete work. Never decide questions addressed to you. Never tell perspective-group members to diverge. Escalate new scope, conflicting requirements and anything irreversible.

## Known gaps

- `launch_session` opens a VS Code terminal through the bridge (same path as Perspectives), so it needs a connected VS Code window. It's tested with a fake launcher, not live.
- Codex workers get the tier's model but not its effort (D4).
- The budget counts only the coordinator's own process, not the workers it launches.
- Silence is only a lead. The coordinator must inspect the session and its checkpoint/evidence; the daemon cannot prove an API wait or a deadlock from silence alone.

## Compact state (`get_state`)

By default, `get_state` returns open tasks, their active objectives, short descriptions and acceptance previews, pending proposal summaries, bounded claim/conflict lists, counts of hidden work, budget and current settings. Verified and rejected tasks are counted rather than expanded. `objectiveId` selects an objective and its open tasks; `taskId` returns the matching task in full, including finished work. `include: ["finished"]` adds completed work, `include: ["details"]` restores full fields, and `include: ["history"]` adds recent chat, plans and unfinished turns for restart recovery. Detailed views retain the coordinator's authority redactions.

Run `bun scripts/measure-get-state.ts` for a synthetic, in-memory project-history measurement. The integration fixture has 40 tasks (30 verified, 10 open), four objectives, six sessions, eight active claims and two pending proposals. This is a measurement, not a hard output-size guarantee: the default response still grows with the number of open tasks.

## Usage limits (`get_usage`)

Read-only, small: per provider, each limit window as `{w, used, left, resets}` (percent, ISO reset time) plus the reading's age (`asOf`). A provider without a reading says why (`available:false, note`). Use it to pick provider and tier by remaining usage and reset timing. It is separate from `get_state` on purpose. The same data is `GET /api/usage`, a `usage` WebSocket push, and the chip in the web top bar.

Sources (src/daemon/usage.ts):
- **Codex**: the `rate_limits` of the newest `token_count` event in `~/.codex/sessions/**/rollout-*.jsonl` (primary and secondary windows: used %, window minutes, reset epoch). Exactly what Codex's server last told Codex. Limit: it is as old as the last Codex turn on this machine; a window past its reset shows as "reset" (0%, unconfirmed).
- **Claude**: the CLI's own call, `GET api.anthropic.com/api/oauth/usage`, with the login's OAuth access token from `~/.claude/.credentials.json` (5h and 7d windows, plus Opus/Sonnet 7d when the plan has them). Limits: undocumented and may change; **off by default; `usage.claudeOAuth: true` in the daemon config turns it on** (see the README for what it reads and sends); the token is never refreshed by us (the CLI refreshes it when a Claude session runs), so an expired token reads as unavailable; polled at most every 2 minutes, backed off 10 minutes after an error, last good reading kept and marked. Nothing local to Claude Code carries these numbers (transcripts only record the "you've hit your limit" error).

`create_task`, `propose_plan` and `launch_session` recommend providers by remaining usage relative to reset time, including usable windows resetting soon. Settings → **Worker usage recommendations** controls low/stop percentages, reset-soon time and maximum reading age (defaults: 20%, 5%, 60 minutes, 15 minutes). Omit provider/tier for automatic selection. Settings rules, explicit selections and approved models/effort stay pinned. Only two fresh low readings permit one standard-to-light reduction; security/auth/money and other deep work stay deep or queue. Unknown, stale, failed-refresh and unconfirmed-reset readings cannot justify reductions. Cards show reasons and evaluation times. Approved plans recheck capacity without spending retries; standalone launches return a waiting reason for later retry.
