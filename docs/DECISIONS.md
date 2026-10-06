# Decisions

Newest last. Each entry records the decision and the reason for it.

## 2026-10-06 — Phase 0

**D1. Spike sessions run in a private tmux server, not VS Code terminals.** `scripts/sandbox.sh` uses `tmux -L switchboard-sandbox`, so it can never touch another tmux server. The pty semantics (bracketed paste, foreground process group, queued input) are the same as a VS Code terminal. The VS Code-specific `sendText` path gets tested once the bridge extension is installed, which needs approval.

**D2. Existing Claude TUIs default to guarded terminal injection, not peer messages.** Peer messages reach the model wrapped as "not typed by your user", which changes how agents treat instructions (lower authority, cannot approve anything). Terminal injection is the only path that produces a genuine user turn. The peer socket stays available as a labeled "peer message" method, and the default per provider can be changed in Settings, as the build prompt requires.

**D3. Switchboard launches sessions in two modes.**
- **Interactive:** a VS Code terminal through the bridge, the same as your own sessions, controlled by guarded injection.
- **Managed:** Claude through `claude -p` stream-json, Codex through a private stdio `codex app-server`. Fully controllable: genuine turns, steer, interrupt and approvals over the protocol.

Coordinator-launched workers and the synthesizer default to managed mode. "New session" in the UI defaults to interactive. Managed Claude uses the Claude subscription login (`apiKeySource: none`); never pass `--bare`.

**D4. Never pass `-c` / `--enable` / `--disable` / `--search` to a Codex TUI that should stay on the shared daemon.** Any of them forces embedded mode.

**D5. The outbox, not the provider, owns idempotency.** Codex does not deduplicate `clientUserMessageId` (verified). It does echo the id back as the item's `clientId`, so it serves as a delivery receipt. Claude terminal injection has no ids at all; acceptance there means the text appeared as a user record in the transcript.

**D6. Gemini and other agents are out of scope for now.** The generic process scanner still lists them as observe-only.

**D7. Accepted race in the injection guard.** There is a small window between the `/proc` foreground check and the pty write. Mitigations:
- re-check immediately before the write
- bracketed paste, so a shell that somehow receives the text gets a single pasted block. Verified on bash 5.3: with `enable-bracketed-paste on` (the default), a pasted `echo X\n` sat unexecuted until a separate Enter. `sb doctor` should check this setting in your shell.
- the `\r` is sent only after a second check

The remaining risk is labeled in the UI.

## 2026-10-06 — Phases 1–2

**D8. Attention runs on normalized events, not on hooks.** Turn ends, registry status (Claude) and daemon status flags (Codex) drive every attention item, so attention works without any hooks. Hooks add only what nothing else provides. Claude permission prompts are never written to the transcript, so the `PermissionRequest` hook is the only source for *what* needs approval. Only two Claude hooks are installed: `PermissionRequest` and `Notification`.

**D9. No Codex hooks.** The shared daemon already reports `waitingOnApproval` and `waitingOnUserInput`, and rollouts carry `task_complete` with the last message. New Codex hooks would also need trust hashes written into `~/.codex/config.toml`. They're not worth that.

**D10. Login uses single-use codes.** `sb open` asks the daemon for a 60-second, single-use code and opens `/auth?code=…`. The long-lived token never appears in a URL or in browser history. Hooks authenticate with the token from a 0600 header file (`curl -H @file`), never on the command line, because `/proc/*/cmdline` is world-readable.

**D11. Hooks and registry polls race. Rules:**
- A tool_use record doesn't clear a pending approval; only the tool's result does. Claude writes the tool_use before showing the permission prompt.
- A registry status older than the latest hook (`statusUpdatedAt < hookAt`) is ignored.
- A late `PermissionRequest` fills in an approval item the registry already raised.

**D12. History replays through the same rules, without notifications.** On first sight of a transcript, its replayed history can open question items, and later replayed prompts resolve them. Whatever is still unanswered at the end is a real outstanding question, which is how a restart reconciles. Items from history are flagged `historical` and never notify. Finished items come from live turns only.

**D13. Config and data directories are 0700 and their files 0600; no process-wide umask.** Sessions the daemon launches would inherit a umask and create 0600 files in your repos.

**D14. No autostart (your call, 2026-10-06).** No systemd unit. Start the daemon yourself (`bun run daemon`, or `scripts/dev-restart.sh` from the checkout), then `sb open`.

**D15. Attention stays in the web UI (your call).** `notify-send` is off by default; optional in-browser notifications cover urgent kinds only (question, approval, failed, escalation).

## 2026-10-06 — Phase 6 (coordinator)

**D16. The coordinator runs as `claude -p` stream-json, not the Agent SDK.** It's the same mechanism already proven for managed sessions (D3), it uses your Claude subscription login (`apiKeySource: none`, verified; never `--bare`, `ANTHROPIC_API_KEY` is stripped from its environment), and it needs no extra dependency. Its tool surface is cut down at the CLI: `--tools ""` (no built-ins, verified: the init event lists `tools: []`), `--strict-mcp-config` with only the `switchboard` MCP server, `--setting-sources ""` (your hooks, plugins and CLAUDE.md don't load), `--allowedTools` limited to `mcp__switchboard__*` and an explicit `--disallowedTools` list. Billing: it counts against your subscription's usage; the daily budget uses the CLI's own `total_cost_usd` estimate.

**D17. The MCP server is a stdio proxy; enforcement lives in the daemon.** `src/daemon/coordinator/mcp-server.ts` only calls `GET /api/coordinator/tools` and `POST /api/coordinator/tool/:name` with the token from `~/.config/switchboard/token`. Every rule (mode, exclusions, authority, rate limits, budget, loop prevention, the destructive screen) runs in `CoordinatorAgent.callTool`, so a confused or prompt-injected coordinator can't get past them. The token is the full API token; that is acceptable because the coordinator itself has no way to make HTTP calls other than through those tools.

**D18. Autonomy = launched by the coordinator for an objective, or autopilot granted by you per session.** Everything else gets proposals. Tmux sandbox sessions have no VS Code terminal, so the live tests granted them autopilot instead of launching through the bridge (launching would open terminals in your VS Code window). `launch_session` is covered by unit tests with a fake launcher.

**D19. Launches without a worktree, or with a brief that trips the destructive screen, are held for approval.** Worktrees are the strongest isolation available; a coordinator-launched worker sharing a working tree needs your OK. Codex workers get the tier's model but not its reasoning effort: passing `-c model_reasoning_effort=…` would force the TUI off the shared daemon (D4).

**D20. Events about sessions the coordinator has nothing to do with are passive.** They ride along in the next digest but never wake it on their own (cost). Relevant = it launched the session, the session is on autopilot, or the session owns a task.

**D21. Sandbox sessions inherit your global Claude plugins.** During the coordinator's live tests, a globally installed plugin's background review sent a sandbox worker a task-notification about `src/daemon/coordinator/agent.ts`, and the worker edited that file. Nobody was messaging sandbox sessions. Future test workers run with `--setting-sources project,local` (no user plugins or hooks) or outside the repo.

## 2026-10-06 — Phase 7 (hardening)

**D22. Tests get fake provider trees through env vars, not mocks.** `SB_CLAUDE_HOME` and `SB_CODEX_HOME` relocate the provider directories the adapters read (defaults `~/.claude`, `~/.codex`). The simulator (`test/sim/claude-sim.ts`) writes real-shaped registry files and transcripts there, backed by real `sleep` processes so `/proc` validation passes unchanged. The e2e runs an isolated daemon (port 7795, `.sandbox/p7-*`) against it, with the model classifier off so no real provider is ever called.

**D23. `/api/health` reports the checkout commit and start time** so `sb doctor` can flag a daemon older than the checkout. It stays unauthenticated (it reveals nothing else).

**D24. Install/uninstall scripts never start or stop the daemon and never install autostart (D14).** Both support `--dry-run`; `uninstall.sh --purge` needs an interactive typed confirmation.

## 2026-10-06 — Integration Phase 1 authority (`p1/authority`)

**P1-A1. Human grants replace inferred objective authority.** Creating an objective, granting per-session autopilot or accepting an agent's new-scope proposal is insufficient by itself. Dispatch also needs an active human-issued objective grant, a canonical repository/task scope, eligible prerequisites and exclusive claims. Old objectives migrate ungranted, old unsupported verified tasks become historical claims, and existing resource owners remain intact. This supersedes D18's weaker objective authority rule. Grant revocation stops future dispatch; it neither stops workers nor releases their claims.

**P1-A2. Verification is evidence, not model rank.** D's verifier and completion gate are adapted to C's task/event records. Every criterion needs human-reviewed evidence or a human-declared narrow predicate (`response_equals`, `file_contains`, `file_sha256`) checked by the daemon. General model assertions remain pending human verification regardless of tier. The coordinator cannot alter criteria, waive verification, remove prerequisites or reopen rejected work. Evidence is bound to grant, task revision and owner/source event; file checks use the granted root or a recorded managed worktree. These predicates do not establish general software correctness or sandbox a worker.

**P1-A3. Reserve before launch; preserve uncertainty and manual edits.** Claims and a unique durable task reservation precede worktree creation and provider launch. Changed grants, prerequisites and human edits are rechecked. If a worker starts while its task changes, its identity and claims are retained for inspection without overwriting the human's task. Uncertain/reserved launches never retry automatically. Inspection/recovery is a separate operation; no timeout dispossesses an owner. Claim release remains explicit, including after verification.

**P1-A4. Approval is one attempt, not new authority.** A proposal approval is consumed durably before dispatch and reuses message rate limits and grant checks. Attempts reserve cooldown before asynchronous transport. The delivery branch supplies precise transport/outbox outcomes and the final transport-time policy hook. All human objective/task/evidence/claim routes must be denied to its scoped coordinator principal. The joint phase gate stays closed until those branches are integrated and their bypass/restart tests pass; D17's full-token assumption is not an acceptable final boundary.

## 2026-10-06 — Final-product integration, Phase 1 (delivery and auth, from the Codex build)

These port the Codex build's contracts into this codebase.

**D25. Three principals instead of one bearer.** The browser cookie used to be the raw root token with a one-year life, so a stolen cookie was a permanent, unrevocable full credential. Now:
- `sb open`'s single-use code mints a random session secret, stored only as its SHA-256, with a 12-hour life and revocation.
- The coordinator's MCP proxy gets its own token (rotated each start) that reaches only `/api/coordinator/tools` and `/api/coordinator/tool/*`.
- Only the root token can mint login codes.
- WebSockets need a single-use ticket bound to the browser session that requested it. Signing out, `sb signout` and expiry close that session's open sockets (an expiry sweep runs every 30 s). Without this, a revoked browser kept its live feed until it reconnected; a background security review caught it.
- There is no global failed-login lockout (Codex's limiter let any local process lock the user out). Login codes are minted by the root token, so there's nothing to brute-force anonymously.

**D26. "Failed" must be provable.** Adapters report `wrote: false` only for refusals before any byte could reach the session: no terminal, a failed guard, a missing socket. Everything else is "uncertain": bridge timeouts, a failure after a paste, a peer socket error after connect, a daemon restart mid-send. The human settles uncertain sends from the UI (`POST /api/outbox/:id/resolve`).

**D27. One persisted control path per session, for every operation.** Locks live in `control_locks`; interrupts and Codex approvals take the same lock as sends. A switch is refused while anything on the session is queued, sending or uncertain, because a second path could duplicate a message that already arrived.

**D28. Receipts are one-to-one.**
- Native ids (Codex `clientId`, Claude `msg_id`) must name the right thread.
- Text matching needs the full sent text, not a 120-character prefix.
- A transcript record confirms a send only when exactly one unconfirmed send fits. Two identical "continue" sends plus one observed "continue" confirm neither.
- Idempotency keys carry a versioned request fingerprint, and reuse with a different request is a 409.

## 2026-10-06 — Phase 1 authority fixes (`p1/fixes`, after the adversarial review)

**P1-A5. Approving a coordinator's `create_objective` proposal grants it (your call).** You want a simple UI where the coordinator handles the details. So `create_objective` now proposes a root directory (and optional non-path resources) along with the title. When you click approve on that exact proposal, the daemon creates the objective *and* issues an active human grant for that root and those resources, with provenance `human approved proposal #<id>`. The root must canonicalize to an existing directory (not `/` or your home directory), or the approval fails with a clear error and creates nothing; the proposal stays pending. The proposal can't carry acceptance checks: the coordinator must never declare its own oracle. This supersedes the part of P1-A1 that said accepting an agent's new-scope proposal never grants. Everything else in P1-A1 stands, and the coordinator still cannot grant itself anything: without your click there is only a proposal (`claudeSelfGrantViaMcp` still guards this).

**P1-A6. Recovery and human edits.** Refines P1-A3 and P1-A1.
- A launch that fails before the provider is invoked (worktree error, missing launcher dependency, authority changed while preparing) provably started nothing: its reservation and claims are released at once.
- A launch whose outcome is uncertain stays held and raises an escalation. It counts toward the concurrent-launch cap only for `limits.reservationCapWindowMs` (30 min), so stuck reservations can't block all launching. Only you can resolve it: `POST /api/tasks/:id/reservation/clear {as: "not_launched" | "launched", sessionId?}` (inspect with `GET /api/tasks/:id/reservation`). Clearing it also lets the objective be re-granted. No timeout ever releases claims.
- An explicit human reassignment of a task releases the previous owner's claims for that task, as your instruction, recorded in the audit. Removing the owner of a launched worker also ends that launch binding.
- Human bookkeeping edits (title, description, priority) and owners recorded on ungranted objectives don't pass the dispatch gate; dispatch itself still does.
- Re-granting an objective with the same or a containing root keeps workers in their recorded worktrees.
- Human verification evidence can't be overwritten by the coordinator. The coordinator can't reject tasks you created, change a verified task's status, or rewrite a verified task's description.
- Coordinator-visible tool output never shows a check's expected value, hash or path, only its criterion and kind.

## 2026-10-06 — Simple UI and coordinator-run details (user direction)

**D29. The coordinator approves permission prompts it judges reasonable.** The user chose this over rules-only approval. A fixed always-ask list goes to the user whatever the judge thinks: push, discarding work, deletes, sudo, network, publishing, cloud/deploy tools, permission changes, system services, writes outside the project, credentials, unknown tools. It fails closed. A shell command reaches the judge only if every program in it is on a short reviewed list (reading files, `ls`/`cat`/`grep`-style tools, `mkdir`/`touch`/`cp`/`mv`, `cd`, simple `sed`, local git work such as status/diff/log/add/commit/branch, and `bun|npm|pnpm|yarn test`); running scripts (`npm run`, `make`, `./x.sh`, `python x.py`), installing packages, `bunx`/`npx`, git global options and `git config`, environment assignments, here-docs, subshells, brace expansion, background jobs, backslashes, `$`, newlines, tabs and non-ASCII always ask, as do nested or obfuscated commands (`$( )`, backticks, `eval`, `sh -c`, inline interpreters, base64). Every word that could be a path, every option value and every redirection target must land inside the project, read the way the shell will read it: words are unquoted as bash does (quotes, escapes, adjacent parts joined) before options and paths are told apart, so a quoted option is still an option; an option word is checked whole, after any `=`, and at every tail of a short-option cluster (`-rt/etc`); `>&word` is a file unless the word is a descriptor; an operand after `--` is never mistaken for a grep/sed pattern; comments ask; and paths are checked from where the agent is actually working (the hook's or Codex's cwd, which must itself be inside the project), through symlinks, `..` after symlinks, globs and earlier `cd`s. Writes to `.git/`, `.claude/`, `.codex/`, `.mcp.json` and `.envrc` always ask (they become code execution or wider permissions later). The project folder comes from Switchboard's record of the session, never from the request; with no usable project (unknown, `/`, or the home folder) everything asks. Tool names are checked per provider, and a Codex approval's tool comes from its request method (permission-widening requests and `grantRoot` always ask); Codex argv is checked per argument. The judge is a tool-free model call (no tools, MCP, settings or API key). It only runs while the coordinator is active, in budget, and the session isn't excluded. Anything not approved is held for the user in Switchboard (Allow / Deny, with the coordinator's one-line view). After `permissionHoldMinutes` (default 10), or if the prompt goes away, the session's own terminal dialog appears. Every automatic approval is recorded. Known limits: the judge reads agent-controlled text, so it can be argued with; the always-ask list is what that can't move. A test run (and a commit, via the project's hooks) executes project code the agent may have written; that is the judge's call, not the list's.

**D30. The UI shows decisions, not plumbing.** The UI has three views: Home (coordinator chat, Needs you, What's happening), Sessions and Compare. It shows only items that need a decision: questions, permission prompts, coordinator escalations and failures. Finished, stalled and conflict notices stay in the daemon for the coordinator. A new turn closes a stale Finished notice. Empty sessions are hidden unless Switchboard started them. Delivery methods, grants, tiers, budget, claims, enforcement and resources live in the daemon and CLI.

**D31. The coordinator routes the user's messages.** `route_to_session` delivers a chat message verbatim, with its images, once, to the session the coordinator picks. It doesn't route while paused, and a destructive-sounding message waits for the user to confirm the destination.

## 2026-10-06 — Delegation plans (`coord/delegate`)

**D32. One approved plan delegates a request to the right agents.** When you ask the coordinator for work, it calls `propose_plan` with a title, a root, and 1–8 tasks. Each task has a brief, acceptance criteria, prerequisites (by key), scope paths inside the root, a provider and a tier. The daemon validates the plan before you ever see it:
- keys are unique, prerequisites exist and form no cycle, and paths stay inside the root;
- tasks that could run at the same time can't share scope paths;
- the root passes the same checks as P1-A5 approval (`Coordination.checkProposedGrant`, shared code): an existing plain directory, no symlink and no `..`, not `/` or your home folder.

Settings `tierRules` still win over the coordinator's tier, and the override is recorded on the task. The model and effort for each task are resolved then (`modelFor`), so the card shows exactly who does what ("Design the limiter · Claude Opus · xhigh"). The plan is one proposal. Nothing exists until you tap **Go ahead**. That tap:
1. creates the objective and its human grant through the P1-A5 path (provenance `human approved plan #<id>`);
2. creates every task, with prerequisites mapped to ids;
3. launches each ready task through the normal `doLaunch` gates, in its own worktree.

The approval counts only for tasks created by that exact approved proposal, and it is used up the first time. Approving needs an active coordinator; otherwise the plan stays pending. The `maxLaunched` cap holds: the remaining tasks queue and launch as slots free up. A dependent launches automatically only when its prerequisites are **VERIFIED** (by you or a daemon check), never on `finished_unverified`. Every gate runs again at that point: mode, budget, grant, scope, cap, retries and reservation. Its brief carries the prerequisites' results. Just before a dependent launches, its verified prerequisites' claims on its scope are released and audited, so a follow-up task on the same files isn't blocked by finished work. A task whose scope is held by someone else waits; it isn't counted as a failed launch. Repeated launch failures stop that task and tell the coordinator. Workers report back with what they did and how they verified it. The coordinator checks the work, marks it `finished_unverified` for your one-tap "Looks good", and tells you in one line when the whole plan is done.

*Hardening (coord/delegate-fixes).* An approval authorizes exactly what the card shows, and nothing more:
- **Digest-bound.** A plan proposal carries `digest`, the sha256 of its stable-JSON payload. Go ahead sends the digest it rendered back. The daemon recomputes it from the stored payload and refuses a missing or different one (the plan stays pending).
- **Re-checked when you tap.** Approval re-resolves every task's tier and model under the current Settings. If anything would differ from what was shown, it's refused; the coordinator re-proposes.
- **Frozen after approval.** Each plan task records an approved snapshot: title, brief, acceptance, scope, prerequisites, tier, provider, model and effort. The daemon auto-launches a task only while it still matches that snapshot and Settings still resolve the same model. Otherwise the task is `skipped` ("changed after approval"), it isn't launched, and the coordinator tells you. This covers your own edits too: you launch the changed task yourself.
- **The coordinator can't touch a plan's objective.** It can't `create_task` under it. It can't `update_task` a plan task's description, scope, tier, prerequisites or owner (status and result stay writable for reporting). It can't `launch_session` a plan task, including through a held launch proposal. Only the plan pump launches, with the approved model passed through and checked again just before the provider starts.
- **The card shows everything approval authorizes, with nothing clipped:**
  - the folder, the resources and the task count;
  - for every task: its title, agent, model and effort, any Settings tier override, its scope paths and its prerequisites (by title);
  - the brief and acceptance checks on expand.

  The coordinator's reason is labelled "Coordinator's note".
- **Narrow claim release.** The only claims released are those that meet all of these:
  - tagged with one of the task's approved prerequisites;
  - that prerequisite is VERIFIED;
  - held by exactly the worker the plan launched for it;
  - the claim lies wholly inside the dependent's scope.

  Wider claims and other owners' claims stay put, and the dependent waits on them.

**D33. Limits on *what* may happen stay hard; limits on *when* or *how often* are the coordinator's judgment, with only a runaway backstop.** The user chose this after a live delegation test stalled on rules firing during normal work (2026-10-06). D29's always-ask list, budget, grants and authority, digest-bound approval, the relay-hop cap and per-session message cooldown are unchanged. Changed:
  - **Repeat guard.** Only calls that succeeded count as repeated work: the third identical successful call within an hour is refused (that call only; nothing pauses). Refused or failed attempts don't count there. The halt-and-flag now fires only at `runawayThreshold` (default 10) identical attempts of any outcome within an hour.
  - **Human hold.** Typing into a session stops the coordinator from messaging it or refreshing its context for `humanHoldMs`. It no longer blocks task bookkeeping for that session (owner checks in `create_task` / `update_task`). A human *task* edit still holds the coordinator's `update_task` on that task for the same window, so stale scheduling can't overwrite it.
  - **`tell_user` cap.** Counts only unprompted posts since the user last spoke (10 within an hour), not every reply.

## 2026-10-06 — Pluggable coordinator (`coord/pluggable`)

**D34. The coordinator is optional and its brain is replaceable: `coordinator.agent` = `builtin` | `external` | `none`.** Session management (list, transcripts, messaging, inbox, permission prompts) never depended on the coordinator, so it now works without one, and the rules engine (`CoordinatorAgent`) is separate from the model that drives it. `builtin` (default) is today's behavior, unchanged.
- **`none`:** no `CoordinatorAgent` is constructed. Every `/api/coordinator*` route is a 404 `{error: "no coordinator configured"}`, and the WS hello says `coordinatorAgent: "none"`. The judge never runs (`permissionJudgeGate(null)` is false): every permission prompt is held for you. Messages authored by the coordinator can't exist (the outbox refuses any without the policy hook); your own sends are unaffected. The UI replaces the coordinator row and pane with a plain **Needs you** home (permission prompts, waiting sessions; `g h` / `g c` go there).
- **`external`:** the engine without a runtime: no model process is ever started (`setRuntime` throws), no daemon spend. Your own agent connects through `sb mcp`, the same stdio proxy the built-in brain uses (`mcp-server.ts`), and drives the same `callTool`, so mode, exclusion, authority, digest-bound approvals, holds, rate/launch/retry limits, loop prevention and the destructive screen apply unchanged. Nothing wakes it, so it gets two read-only tools, `get_updates` (the drained wake digest with the same relay-hop accounting, your new chat messages once via a persisted cursor, a state line, an optional wait of up to 50 s) and `get_instructions` (`coordinator/COORDINATOR.md` plus a polling note). The built-in brain doesn't get them. The UI keeps the coordinator's cards and progress but has no chat box, and shows when the agent last called (`lastToolCallAt` in the state).
- **Security.** The proxy holds only the coordinator token, which reaches only `/api/coordinator/tools` and `/api/coordinator/tool/*`; it rotates each start and the proxy re-reads it once after a 401. The judge stays builtin-only: it's a model call the daemon makes, and no tool answers a prompt, so an external agent can't approve anything. The real difference is the agent itself: the built-in brain has no built-in tools, no settings and only this MCP server, so the engine is its whole reach. An external agent usually has a shell and files as you, so it can read the root token or act directly; the engine binds only what it does through Switchboard. That's your trust decision, stated in the docs, not something the daemon can enforce.
