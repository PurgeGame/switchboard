# Capability matrix (Phase 0)

Verified on 2026-10-06 against Claude Code 2.1.291 and Codex CLI 0.160.1 on Linux.

**Legend:** ✅ verified live on a throwaway session · 📄 documented / from generated protocol, not yet exercised · ⏳ pending a spike that needs your OK · ❌ not possible.

Evidence lives in `test/fixtures/` (captured payloads) and in `docs/research/codex-protocol/` (Codex CLI help). All spikes ran in `.sandbox/` on haiku and gpt-6-luna. No existing session was messaged, resumed or attached.

## Where your sessions actually run

- **TUIs started in VS Code run in its integrated terminals** (`systemd → code → code → bash → agent`). Each agent is the foreground process group of its pty.
- **Every Codex TUI is a client of one shared app-server daemon** (`codex app-server --listen unix:// --managed-daemon`). It reaches the daemon through `~/.codex/app-server-control/app-server-control.sock` (WebSocket over a unix socket), so each TUI's thread lives in the daemon process.
- **VS Code Codex extension:** each window runs its own private stdio `codex app-server`. Those threads are reachable only from disk.
- **VS Code Claude extension:** sessions run `claude --output-format stream-json --input-format stream-json --permission-mode bypassPermissions` as children of the extension host.

## Claude Code

| Capability | Interactive TUI (yours) | Headless `-p` stream-json (Switchboard-launched) | VS Code extension |
|---|---|---|---|
| Discover | ✅ `claude agents --json` (`pid, sessionId, name, cwd, kind, status`) plus `~/.claude/sessions/<pid>.json` (adds `messagingSocketPath`, `entrypoint`, `statusUpdatedAt`, and `tmux` when inside tmux) | ✅ own child; also gets a messaging socket | ✅ same registry (`entrypoint: claude-vscode`) |
| Read history | ✅ `~/.claude/projects/<cwd, every non-alphanumeric → "-">/<sessionId>.jsonl` | ✅ stdout stream plus the same JSONL | ✅ JSONL (created on the first message) |
| Live activity | ✅ registry `status` idle/busy/**waiting** (it flips to `waiting` on a permission prompt); transcript tail; hooks | ✅ stdout events (`system/init`, `assistant`, `result` with cost) | ✅ registry plus transcript tail |
| Attach to the running process | ❌ there is no external attach for a TUI (`claude attach` covers `--bg` only) | n/a, Switchboard owns the pipes | ❌ |
| Send as a **genuine user turn** | ✅ **terminal injection only.** A bracketed paste then `\r` arrives as one multi-line user turn (tested through a pty; the VS Code `sendText` path is ⏳ until the bridge is installed) | ✅ stdin `{"type":"user",…}`. Multiple turns over one process verified | ❌ (no injectable terminal) |
| Send as a **peer message** | ✅ NDJSON `{"type":"user","message":…}` to `messagingSocketPath` starts a turn when idle. The model sees it wrapped as a cross-session message "not typed by your user" that cannot approve prompts. No ack on the same connection | n/a | 📄 held for approval and dropped after 5 min, because the session is `bypassPermissions` |
| Queue / mid-turn | ✅ text injected mid-turn is queued and delivered at the next tool boundary ("Press up to edit queued messages") | 📄 `priority: now/next/later` on user messages | — |
| Approvals: detect | ✅ `PermissionRequest` hook (immediate; `tool_name`, `tool_input`), `Notification` `permission_prompt` (about 6s later), registry `status: waiting` | 📄 `--permission-prompt-tool` / `can_use_tool` control request | — |
| Approvals: answer | ✅ keystrokes into the terminal (tested through a pty). Peers cannot approve, by design | 📄 control response allow/deny | ❌ |
| Interrupt | 📄 `Esc` keystroke through the terminal | 📄 `control_request {subtype:"interrupt"}` | ❌ |
| Resume | 📄 `claude --resume <id>` = **a second driver if the original is still running.** Never do this on a live session | 📄 `--resume` | ❌ |
| Launch new | needs a pty: VS Code terminal through the bridge ⏳ | ✅ `claude -p --input-format stream-json --output-format stream-json --verbose --model … -n …` | ❌ |

**Auth and billing:** headless `-p` reports `apiKeySource: "none"`, so it runs on your Claude subscription login with no API key or separate billing. `--bare` would require an API key, so don't use it.

**Hooks (Claude):** payloads are captured in `test/fixtures/claude/hooks/`.
- Every event carries `session_id`, `transcript_path`, `cwd` and `prompt_id` (which groups one turn).
- `Stop` carries `last_assistant_message`, which drives question and outcome detection.
- `Notification.notification_type` is `idle_prompt` or `permission_prompt`.
- `Stop` does not fire on a user interrupt (documented).
- **Hot reload:** hooks and permission rules added to a project `.claude/settings.local.json` took effect in an already-running session without a restart. Global `settings.json` reload is still unverified.
- **How often permission prompts appear depends on your Claude permission settings;** with permissive global rules they are rare. "Needs you" for Claude mostly means a turn-end question, `AskUserQuestion`, or plan approval.

## Codex

| Capability | TUI (yours, on the shared daemon) | Private stdio app-server (Switchboard-launched) | VS Code extension |
|---|---|---|---|
| Discover | ✅ `ps`/`/proc`; rollouts `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`session_meta.originator: codex-tui`; note that `source` reads `vscode` even for TUIs); `session_index.jsonl` gives names; `state_5.sqlite` 📄 | ✅ `thread/start` returns the id | ✅ disk only |
| Read history | ✅ rollout JSONL (content arrives as `event_msg/item_completed` with typed items) | ✅ notifications plus rollout (unless `ephemeral`) | ✅ rollout |
| Live activity | ✅ rollout tail; hooks (global `hooks.json` only, see below) | ✅ `turn/*`, `item/*`, `thread/status/changed` (`active{waitingOnApproval}` / `idle`), `hook/started` / `hook/completed` | ✅ rollout tail |
| Attach | ✅ daemon `thread/resume {threadId}` rejoins the running thread. The second client receives every event of turns typed in the TUI, and the TUI is unaffected. `thread/unsubscribe` detaches cleanly. Rejoining does not clear thread goals (verified) | n/a | ❌ private stdio server |
| Send as a genuine user turn | ✅ **daemon `turn/start`**: renders in the TUI exactly like typed input, with the `clientId` receipt. ✅ terminal injection as a fallback | ✅ `turn/start {threadId, input, clientUserMessageId}` | ❌ |
| Queue / steer | ✅ daemon `turn/steer` (shown in the TUI; the reply honored it). ✅ text injected mid-turn is held for the next tool call. 📄 `codex queue --thread` | ✅ `turn/steer {expectedTurnId}`. A wrong id is rejected with `-32600 expected active turn id …` | ❌ |
| Approvals | ✅ the request goes to **both** the TUI dialog and every rejoined client. Answering from the client resolves it in the TUI. (rare in practice with a permissive `approval_policy`) | ✅ `item/commandExecution/requestApproval` → reply `{decision:"accept"}` → `serverRequest/resolved` | ❌ |
| Interrupt | ✅ daemon `turn/interrupt` (the TUI shows "Conversation interrupted") | ✅ `turn/interrupt` → `turn/completed {status:"interrupted"}` | ❌ |
| Resume | 📄 `codex resume` = a second driver on a live thread. Never | 📄 `thread/resume` | ❌ |
| Launch new | needs a pty: VS Code terminal through the bridge ⏳ | ✅ `thread/start {model, cwd, approvalPolicy, sandbox, ephemeral}` | ❌ |

**Daemon transport:** WebSocket over the unix socket `~/.codex/app-server-control/app-server-control.sock`, reached via `ws+unix://<sock>:/` (the Node `ws` package; Bun's WebSocket client can't dial a unix socket). The handshake is `initialize` then `initialized`. `thread/loaded/list` returned all live TUI threads. Run with your OK on 2026-10-06, touching only the throwaway thread.

**Codex goals:** `thread/goal/set {objective}` makes Codex keep working toward the objective on its own (the thread went active straight away). That's a possible native mechanism for Auto-continue, and the reason Switchboard must never set goals casually.

**Gotchas (Codex):**
- **`clientUserMessageId` is not deduplicated.** Resending the same id created a second turn. It is echoed back as `clientId` on the `userMessage` item, so it serves as a delivery receipt but not as idempotency. The Switchboard outbox must check for the `clientId` before any retry.
- **Any `-c` / `--enable` / `--disable` / `--search` override forces a TUI into "embedded mode",** which bypasses the shared daemon. Switchboard must launch daemon-attached TUIs without them.
- Codex frequently edits files through Bash (`printf >> file`) rather than apply_patch, so edit-tool hooks miss those writes. Worktree diffs are the reliable signal.
- `agentMessage.phase` is `commentary` or `final_answer`. Use `final_answer` for "last message" and outcome extraction.

**Hooks (Codex):** payloads are captured in `test/fixtures/codex/hooks/`. Their shape matches Claude's: `session_id`, `turn_id`, `transcript_path` (the rollout) and `last_assistant_message` on Stop. Hooks for one throwaway session work through `-c 'hooks.<Event>=[…]' --dangerously-bypass-hook-trust`, but that forces embedded mode. Hooks for daemon TUIs come only from `~/.codex/hooks.json`, which is global and needs your OK. A project `.codex/hooks.json` needs the folder trusted, which writes `~/.codex/config.toml`.

## Terminal-injection safety check (both providers)

Read live from `/proc` for all 5 sampled sessions: the agent's `pgrp` equals its tty's `tpgid`. The guard before every injected send is:
1. the agent PID is alive
2. its tty equals the VS Code terminal's tty
3. `pgrp == tpgid`, so the agent is the foreground job

If the agent has exited, `tpgid` reverts to the shell and the send is refused. A small race remains between the check and the write; it is documented in DECISIONS.

## Summary: the best path per session kind

| Session kind | Observe | Send (genuine turn) | Approvals | Interrupt |
|---|---|---|---|---|
| Claude TUI (yours) | registry + transcript + hooks | guarded terminal injection; peer socket offered as a labeled alternative | detect via hooks/registry; answer via terminal keys | `Esc` via terminal |
| Codex TUI (yours) | daemon rejoin (live events) + rollout + `ps` | **daemon `turn/start` / `turn/steer`**; terminal as a fallback | daemon (rare: policy never) | daemon `turn/interrupt` |
| Claude, launched by Switchboard | stream-json | stdin | permission-prompt tool | control request |
| Codex, launched by Switchboard | app-server notifications | `turn/start` / `turn/steer` | server requests | `turn/interrupt` |
| VS Code extension sessions (both) | disk/registry | ❌ observe-only | ❌ | ❌ |


## Changes since Phase 0

The matrix above is the Phase 0 baseline. What later phases proved or added (details in `docs/DECISIONS.md` and the git log):

- **Terminal injection is live (VS Code bridge).** The `sendText` path that was pending in Phase 0 now runs through the bridge extension. Guard: the agent is alive, on the terminal's tty, and the foreground job, checked before the bracketed paste and again before Enter. Refusal was verified with Claude suspended. Raw input is accepted only for terminals Switchboard launched itself.
- **The bridge talks over a unix socket,** `~/.local/share/switchboard/bridge.sock` (mode 0600 inside the 0700 data dir). There is no port and no token on the wire; the extension verifies the directory's owner and mode before connecting and reconnects as soon as the socket reappears. Install with `scripts/bridge.sh install`.
- **tmux injection (SSH).** Sessions inside any of your tmux servers get the same `terminal` send method: `tmux paste-buffer -p` (bracketed paste) with the same foreground guard on the pane's tty. Claude's registry records the tmux pane; other panes are found with `tmux list-panes -a`. Verified live with a transcript receipt.
- **Images.** Codex through the daemon: a real `localImage` input item. Claude through terminal injection: image paths pasted separately so the TUI attaches them (real image blocks verified in the transcript). Paths that can only send a reference (Codex through a terminal) are labeled "path" in the UI. Uploads are content-addressed files in the data dir.
- **The Codex daemon.** Attach, `turn/start`, `turn/steer` (with `expectedTurnId`), `thread/queue/add`, `turn/interrupt` and approval answering are verified against the shared app-server, over the hand-written RFC 6455 client in `src/daemon/wsunix.ts` (Bun cannot dial a unix-socket WebSocket). The `clientId` echo is used as the delivery receipt, and the Switchboard outbox owns idempotency. `sb doctor` checks reachability with a read-only `thread/loaded/list`.
- **Peer messages** to Claude TUIs are an available, labeled alternative to terminal injection; receipts are matched on the kernel-verified sender pid plus body.
- **Claude hooks:** `PermissionRequest` and `Notification` for approvals, and a `PreToolUse` soft-lock for edit tools (verified live: the warning reached the second session's context). Codex has no hooks installed (D9).
- **Perspectives, auto-continue, coordination (claims, conflicts), the coordinator agent and the resource governor with game mode** were added and verified live on sandbox sessions, except coordinator `launch_session` (unit tested only).
- **Still unverified from Phase 0:** hot reload of the *global* `~/.claude/settings.json` (project settings verified), and `claude --resume`/`codex resume` semantics (never run on a live session by design).
- **Test layers now:** unit and fixture tests, a simulator (`test/sim/`) with restart/reconnect tests, and Playwright e2e on the real UI. Real-provider checks are listed separately in the Phase 7 report.
