# Remaining limitations

Precise and current as of Phase 7. "Verified" means exercised on this machine against the real provider; see the test report in the Phase 7 commit message and `docs/DECISIONS.md`.

## Discovery and identification

- **Codex TUI pid mapping is inferred.** The shared daemon reports threads, not which TUI process owns one. Switchboard matches TUIs to threads by working directory and start time (`mapTuisToThreads`). Two TUIs in the same folder started close together can be swapped. Such sessions are marked `inferred`, and their CPU/RAM figures are labeled inferred. A TUI started with `codex resume <id>` maps with confidence.
- **VS Code extension sessions (Claude and Codex) are observe-only.** Each Codex extension window runs a private stdio app-server, reachable only from disk; Claude extension sessions are owned by the extension host and have no injectable terminal.
- **Non-daemon Codex sessions** (embedded mode, from `-c`/`--enable`/`--disable`/`--search`) are found by their open rollout file, are observe-only, and have no live status.
- **A session that disappears** is shown as ended after two missed discovery ticks (about 4 s). A crashed process and a clean exit look the same.
- **First sight of a transcript replays only the last 3 MB.** The first prompt is read from the head of the file, but a very long session's middle history isn't in the database.
- Linux and `/proc` only. The page size is hard-coded to 4 KiB (x86_64).

## Messaging and control

- **A small race in the injection guards (D7).** Between the `/proc` foreground check and the pty write there is a window in which the agent could exit. Mitigations: a re-check right before the write, bracketed paste, and the `\r` sent only after a second check. The risk is labeled in the UI. Bracketed paste was verified for bash 5.3; other shells (zsh, fish) are not verified, and `sb doctor` checks only bash.
- **Claude TUI without a reachable terminal** can only receive peer messages, which Claude wraps as "not typed by your user"; they can't approve anything. VS Code extension peers are held and dropped after 5 minutes.
- **Claude interrupt and approvals go through terminal keystrokes** (`Esc`, answer keys). Claude has no external control channel for a TUI. Codex uses the daemon protocol.
- **Codex effort tiers can't be set without leaving the shared daemon (D4, D19).** `-c model_reasoning_effort=...` forces embedded mode. Codex sessions launched by the coordinator or Perspectives get the tier's model but not its effort.
- **`codex resume` / `claude --resume` on a live session creates a second driver.** Switchboard's single-driver lock covers only Switchboard's own control paths; it can't stop you or another tool from resuming a session that's running.
- **Uncertain deliveries need a human.** A message with no transcript receipt within 90 s becomes `uncertain` and is never retried. You must check the session and resend on purpose.
- **Images:** Claude's TUI turns a pasted image path into a real attachment (verified); Codex terminal paths can only send a file reference as text (labeled "path" in the UI). The Codex daemon path sends a real `localImage`.
- A raw-input endpoint exists only for terminals Switchboard launched itself.

## Hooks and interference

- **Codex hooks are not installed (D9).** Codex attention comes from daemon status flags and rollouts. As a result there is no soft-lock warning for Codex sessions, and Codex edits made through Bash (`printf >> file`) bypass edit-tool detection; they appear only through worktree diffs.
- **Only two Claude hooks plus the soft-lock hook are installed** (`PermissionRequest`, `Notification`, `PreToolUse` on edit tools). The soft-lock is cooperative and fail-open (300 ms budget): the agent can ignore a warning, and a slow daemon means no warning at all. It denies edits only in repos configured as strict.
- **Hot reload of global Claude settings is unverified.** Hook changes were verified to reach a running session through a project `.claude/settings.local.json`. For `~/.claude/settings.json` the documented behavior is that running sessions pick them up; if one doesn't, restart that session.
- **Enforcement is cooperative for Claude TUIs and observed otherwise** (`enforcement` field in the UI). Only coordinator-launched worktree sessions are isolated.

## Coordinator

- **The budget counts only the coordinator's own process,** not the workers it launches.
- **`launch_session` has not run live.** It opens a VS Code terminal through the bridge, which would open terminals in your window. It is unit tested with a fake launcher (D18). Sandbox workers were given autopilot instead.
- **The destructive-intent screen is a keyword heuristic.** It can miss rephrased intent and can flag harmless text. Never-discard-work rules are behavioral (prompt) rather than enforced.
- The coordinator reads Claude usage from the CLI's own `total_cost_usd` estimate. It runs on your Claude subscription login and counts against your plan's usage limits.
- Stalls reach the coordinator only as attention items; it doesn't detect drift on its own.
- Synthesis (Perspectives) is done by a fresh read-only Claude session only.

## Resource governor

- **cpuset isn't delegated to the user,** so `AllowedCPUs` has no effect. Game mode uses CPU affinity (`taskset`) instead. Affinity is inherited by children, but a process can change its own, and processes outside the agent trees (and anything started by other means) aren't pinned.
- Game mode pins agents to specific CPUs only when `governor.eCores` is set in `config.json` (there's no default: it depends on the CPU). Detecting a game by process name needs `governor.gameProcesses`. Without them, game mode only lowers agent weight, triggered by a GameMode client or the manual toggle.
- Throttling relies on transient systemd user scopes (`systemctl --user`). Nothing is ever killed automatically, and nothing persists across a reboot.
- Resource figures for Codex sessions on the shared daemon include the daemon's children and are labeled inferred.

## Reliability

- **Restart reconciliation is tested against the simulator for Claude only** (`test/restart.test.ts`). The Codex adapter's restart path (daemon reconnect, rollout offsets) has no simulator coverage.
- The Playwright e2e covers the real UI with simulated Claude sessions. It doesn't exercise Codex-specific UI states, the bridge, or sending.
- The outbox receipt window (90 s) and the 2-tick end grace are fixed constants, not settings.
- `/api/health` is unauthenticated (it is needed by the install scripts and `sb doctor`); it reveals only `ok`, the checkout commit and the daemon start time.

## Delivery

- **No autostart (D14).** You start the daemon. There is no systemd unit.
- The install script was not run in Phase 7 (everything was already installed); it and the uninstall script were exercised only with `--dry-run`.
- The Chrome-based e2e needs a Chrome installation; no browsers are downloaded.
