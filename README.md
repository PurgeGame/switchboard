# Switchboard

A local control room for your AI coding sessions. One web page shows every running Claude Code and Codex session on this machine, tells you which ones need you, lets you message them, and can coordinate and throttle them. It is a Bun + TypeScript daemon (`switchboardd`), a React UI and a small CLI (`sb`).

- **Observe:** every live Claude and Codex session, with provider, folder, name, status, transcript and process-tree CPU/RAM.
- **Attention:** a persistent inbox of questions, approvals, finished long turns, failures and coordinator escalations. Suspected stalls are investigated silently; only confirmed problems appear in **Needs you**, with a reason and suggested action. An item stays until it is actually answered.
- **Control:** send messages (genuine user turns where the provider allows it), queue, steer, interrupt, approve, paste screenshots, launch sessions.
- **Coordinate:** Perspectives (ask several agents, compare, synthesize), tasks, claims, conflict detection, an optional coordinator agent, and a resource governor with a game mode.

The daemon binds `127.0.0.1` only. Closing the browser or stopping the daemon never affects a session: sessions live in their own processes and VS Code terminals, and the daemon re-attaches to them when it starts.

## Quick start

Requirements: Linux, [Bun](https://bun.sh), Claude Code and/or Codex CLI. VS Code with the `code` command is optional (needed for the bridge). Google Chrome is needed only for `bun run e2e`.

```bash
git clone https://github.com/PurgeGame/switchboard && cd switchboard
scripts/install.sh            # bun install, build the UI, Claude hooks (edits ~/.claude/settings.json), VS Code bridge extension
                              # --no-hooks / --no-bridge to skip those; --dry-run to see what it would do
bun run daemon                # or: scripts/dev-restart.sh (detached, logs to .sandbox/switchboardd.log)
bun src/cli/sb.ts open        # opens the UI, already logged in
```

Optional: `ln -s "$PWD/src/cli/sb.ts" ~/.local/bin/sb` so you can type `sb`. The examples below use `sb`.

There is **no autostart** (a deliberate choice, see `docs/DECISIONS.md` D14). Start the daemon yourself when you want it. `sb doctor` checks the setup.

## Setting it up for someone (step by step, for people and AI agents)

Run these from the checkout. Each step says what it changes and how to check it worked. Steps 3 and 4 change the user's global config, so ask them first.

Every command honors `SB_PORT` (default 7777), `SB_DATA_DIR` and `SB_CONFIG_DIR`, so substitute your port in the checks below if you changed it.

1. **Requirements.** Linux, `bun --version` (install from https://bun.sh if missing), and at least one of `claude` / `codex` on PATH. Optional: `code` (VS Code) for messaging Claude sessions in VS Code terminals, `tmux` for sessions over SSH, Google Chrome for `bun run e2e`, `tailscale` for phone access.
2. **Dependencies and UI build.** `bun install && bun run build`. Changes only the checkout (`node_modules/`, `dist/`). Check: `ls dist/web/index.html`.
3. **Claude hooks** (optional, recommended): `bun src/cli/sb.ts hooks install`. Edits `~/.claude/settings.json`, adding only Switchboard's entries and keeping a timestamped backup next to it. Running Claude sessions pick it up without a restart. Without hooks, Switchboard still sees every session, but permission prompts don't reach the UI. Check: `bun src/cli/sb.ts hooks status`. Undo: `bun src/cli/sb.ts hooks uninstall`.
4. **VS Code bridge** (optional): `scripts/bridge.sh install`, then reload VS Code windows once. Installs a small local extension. Check: `code --list-extensions | grep -i switchboard`.
5. **Start the daemon.** `scripts/dev-restart.sh` (detached, logs to `.sandbox/switchboardd.log`) or `bun run daemon` (foreground). There is no autostart. Check: `curl -s 127.0.0.1:${SB_PORT:-7777}/api/health` returns `{"ok":true,…}`.
6. **Open the UI.** `bun src/cli/sb.ts open` opens a logged-in browser tab. `bun src/cli/sb.ts login` instead prints a single-use login URL (valid 60 s) to open in any browser that can reach the port. On a headless machine, use it with the SSH steps below, or use `bun src/cli/sb.ts phone` for Tailscale. Check: after opening the link, the page shows the session list, not "run `sb open` to log in".
7. **Verify.** `bun src/cli/sb.ts doctor` prints ✓ (fine), – (optional and not set up, with how to add it) or ✗ (broken, with the reason). It exits 0 when nothing is ✗.

Notes:
- **The `sb` name:** on some distros `sb` is already taken (lrzsz's file transfer tool). Run `bun src/cli/sb.ts …`, or link it under another name: `ln -s "$PWD/src/cli/sb.ts" ~/.local/bin/switchboard`.
- **Trying it without touching anything:** export `SB_DATA_DIR` and `SB_CONFIG_DIR` (fresh directories) and `SB_PORT` (a free port, e.g. 7790) for every command, and skip steps 3–4. The daemon only reads `~/.claude` and `~/.codex`, so it still lists the machine's real sessions (read-only). `doctor` still reports on the machine's real Claude hooks and VS Code, since those are global. `bun test test/` needs no setup at all.
- **The coordinator** is optional. Ask the user which they want and set `coordinator.agent` in `config.json`: `"builtin"` (default; off until they turn it on in the UI, runs on their own Claude login within a daily budget), `"external"` (their own agent connects with `bun src/cli/sb.ts mcp`), or `"none"` (just session management). See "Coordinator: built-in, your own, or none" below and `docs/COORDINATOR.md`.
- **Removing it:** `scripts/uninstall.sh --dry-run`, then `scripts/uninstall.sh`. See Uninstall below.

## Connecting existing sessions

Nothing needs to be launched through Switchboard. The daemon finds sessions that are already running:

| Provider | How it is found | Restart needed? |
|---|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json` (the live registry) plus the transcript in `~/.claude/projects/` | **No.** Hooks live in `~/.claude/settings.json`, and running Claude sessions pick up settings changes without a restart. Attention works without hooks too; hooks add the exact text of permission requests and the soft-lock warning. |
| Codex | the shared Codex app-server daemon (`~/.codex/app-server-control/app-server-control.sock`) plus rollouts in `~/.codex/sessions/` | **No.** Codex needs no hooks and no changes. Switchboard rejoins threads through the daemon. |

What you can do with a session depends on how it runs (the full table is in `docs/CAPABILITIES.md`):

- **Codex TUI on the shared daemon:** send, steer, queue, interrupt, approve, all through the daemon.
- **Claude TUI in a VS Code terminal:** guarded terminal injection through the bridge extension (reload the VS Code window once after `scripts/bridge.sh install`).
- **Claude or Codex TUI inside tmux** (typical over SSH): guarded injection into the tmux pane.
- **VS Code extension sessions** (Claude or Codex panel): observe-only.
- A Claude TUI with no terminal Switchboard can reach gets only "peer messages", which Claude is told were not typed by you. The UI labels this.

A Codex TUI started with `-c`, `--enable`, `--disable` or `--search` leaves the shared daemon and becomes invisible to live control.

## The UI

One page, built to show decisions rather than plumbing.

- **Session list:** every live session, grouped by project, with status ("Working 3m", "Needs answer", "Tests running 12m"…). Filters: All / Needs you / Working; `/` searches. Sessions the coordinator started for its own work collapse into "Background agents" at the bottom.
- **Session pane:** transcript, model · effort · context %, one message box (attach, Stop, Send). Messages to a busy session show "Queued" and deliver when its turn ends.
- **Coordinator** (pinned first): a chat with the coordinator agent, plus **Needs you** cards pinned above the chat (plans to approve, finished work to OK, permission prompts, failed launches with Retry) and **What's happening**. It's off until you turn it on. See `docs/COORDINATOR.md`. With `coordinator.agent: "external"` your own agent is the brain and the chat box gives way to a connection note; with `"none"` this is a plain **Needs you** home instead.
- **Needs you**: pinned above every screen, with a count. Pending proposals, permission prompts, finished work awaiting “Looks good”, failed plan launches, coordinator escalations (including confirmed stalls), and sessions requesting your reply appear together. Actions are inline; tap the summary for full details or Reply to focus the session composer. Resolved items disappear, including after reconnecting. Routine coordinator notices and questions being auto-continued are excluded.
- **Attention history** (`i`): resolved and auto-handled attention items.

**Phone notifications:** open Switchboard over HTTPS and tap **Enable notifications** once in Needs you. On iPhone, first add Switchboard to the Home Screen and open it there. Web push works with the PWA closed; there is no polling tab to keep open. The daemon stores the VAPID key, subscriptions and per-device delivery ledger in its database, so reconnects and restarts do not repeat alerts. Transient delivery failures retry; expired subscriptions are removed. Disable notifications in Settings. Signing out or revoking browser sessions removes their subscriptions. Browser-login expiry alone does not disable phone alerts; opening the UI may require signing in again. The service worker caches no transcripts or authenticated pages.

Push uses the browser vendor’s delivery service (encrypted payloads, via the `web-push` library). The browser and OS still control permission and delivery. Background notifications require the daemon to remain running. By default a notification says only how many items need you (open it for the details); `push.details: true` in `config.json` shows each item's text, including commands and paths, on the lock screen.

Auto-continue: when a session stops only to ask "shall I continue?" about work you already asked for, Switchboard replies after a cancellable grace period, labeled as auto and logged with the quoted authorization. Real choices, new scope, destructive actions and approvals always come to you.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | next / previous session |
| `Enter` | open the selected session |
| `/` | search sessions |
| `i` | toggle attention history |
| `r` | reply: focus the selected session's message box |
| `g` then `c` (or `h`) / `s` | the coordinator / the session list |
| `Esc` | close the topmost thing, then back to the list |

Shortcuts are ignored while you type in a field.

## Using it from your phone (Tailscale)

`sb phone` sets up `tailscale serve` once (a private HTTPS name only your tailnet can reach, forwarding to the loopback daemon) and shows a QR code that logs the phone in. Details in `docs/PHONE_ACCESS.md`.

## Using it from your laptop (SSH)

One command on the laptop. Your SSH key is the only credential: the daemon stays on the PC's loopback, and no token is stored on the laptop.

```bash
# once: install the script (needs only sh + OpenSSH on the laptop)
ssh my-pc cat switchboard/scripts/sb-connect > ~/.local/bin/sb-connect && chmod +x ~/.local/bin/sb-connect

sb-connect my-pc           # tunnel + single-use login link + opens the browser
sb-connect --stop my-pc    # close the background tunnel
```

`my-pc` is any SSH host alias. Put the PC's port (e.g. `Port 2222`) and address (e.g. its Tailscale name) in the laptop's `~/.ssh/config`. The tunnel runs on a persistent SSH control connection, so running `sb-connect` again only fetches a fresh login link. Browser sessions last 12 hours.

By hand, it is the same thing:

```bash
ssh -L 7777:127.0.0.1:7777 my-pc         # on your laptop
sb login                                 # on the PC: prints a 60-second, single-use login URL
```

Open that URL in the laptop's browser (keep the same port, 7777, on both sides: the Host and Origin checks are strict). Sessions started over SSH usually live in tmux, and Switchboard can message them through the pane with the same foreground-process guard it uses for VS Code terminals.

## Configuration

State lives in `~/.local/share/switchboard` (SQLite database, uploads, bridge socket; mode 0700) and `~/.config/switchboard` (token, hook header, `config.json`; mode 0700, files 0600). Override with `SB_DATA_DIR`, `SB_CONFIG_DIR` and `SB_PORT`. Tests use `SB_CLAUDE_HOME` and `SB_CODEX_HOME` to point discovery at fake session trees.

`~/.config/switchboard/config.json`. Every key is optional. The example below shows the defaults, except `offProjects`, `governor` and `coordinator.tierRules`, which are examples to adapt:

```json
{
  "port": 7777,
  "longRunMs": 300000,
  "stalledMs": 600000,
  "endedRetentionMs": 21600000,
  "notifyDesktop": false,
  "notifyFinished": false,
  "notifyIgnore": ["/.sandbox/"],
  "modelClassifier": true,
  "autoContinue": { "enabled": true, "graceMs": 10000, "maxConsecutive": 3, "typingHoldMs": 120000, "offProjects": ["/home/me/Dev/secret-repo"] },
  "autoApproveSafePermissions": false,
  "usage": { "claudeOAuth": false },
  "push": { "details": false, "subject": "mailto:switchboard@localhost" },
  "governor": { "memPressureHigh": 10, "memAvailableLowPct": 15, "restoreAfterMs": 120000, "eCores": "16-31", "allCores": "0-31", "gameProcesses": ["SomeGame.exe"] },
  "coordinator": {
    "agent": "builtin",
    "provider": "claude",
    "model": "opus",
    "effort": "xhigh",
    "codex": { "model": "gpt-6.1-sol", "effort": "high" },
    "limits": { "maxLaunched": 3, "dailyBudgetUsd": 10, "perSessionCooldownMs": 600000, "perSessionPerHour": 6 },
    "tierRules": [{ "glob": "contracts/**", "tier": "deep", "reason": "smart contracts" }],
    "worktreeRoot": "~/Dev/.switchboard-worktrees"
  }
}
```

- `longRunMs`: turns at least this long that end without a question raise a Finished item.
- `notifyDesktop`: desktop notifications (`notify-send`) are off; attention lives in the web UI. Phone web push for the Needs you list is opt-in using its Enable notifications button.
- `modelClassifier`: a cheap Haiku call (your Claude login) for turn endings the rules can't classify. Set `false` to never call a model.
- `governor.eCores` / `allCores`: the CPU lists used by game mode. The defaults match one particular CPU: set them for yours.
- `autoApproveSafePermissions`: `false` (default), `true` or `"all"`. See [the safe permission policy](#coordinator-built-in-your-own-or-none) below.
- `usage.claudeOAuth`: **off by default.** When `true`, the daemon reads your Claude Code login's OAuth access token from `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`; never refreshed or written by Switchboard) and calls `GET https://api.anthropic.com/api/oauth/usage` (the undocumented endpoint the Claude CLI itself uses) to show your 5-hour and 7-day usage windows. It polls at most every 2 minutes (checked every 30 seconds), backs off 10 minutes after an error (doubling, up to an hour), and only while the daemon runs. The token is sent only to that endpoint. Codex usage needs no setting: it comes from your local Codex rollout logs.
- `push.details`: phone notifications pass through the browser vendor's push service and show on a lock screen, so by default they say only "N items need you" with a link; `true` puts each item's text (commands, paths, questions) in the notification. `push.subject` is the VAPID contact sent to push services (generic by default).
- `coordinator.agent`: who coordinates: `"builtin"` (default), `"external"` (your own agent) or `"none"`. See the next section. Restart the daemon after changing it.
- **Settings → Coordinator** selects Claude (default) or Codex and its model for the next coordinator start. **Use Codex now** switches a running Claude coordinator in one click; **Restart coordinator** applies other saved choices without restarting the daemon or losing work. Codex requires exactly CLI 0.160.1 and a ChatGPT file login (with another version the coordinator does not start, and its header and Settings say why); see [runtime setup and differences](docs/COORDINATOR.md#switching-claude--codex).
- `coordinator`: full key list and meaning in `docs/COORDINATOR.md`.

## Coordinator: built-in, your own, or none

Session management (the list, transcripts, messaging, the inbox, permission prompts) works the same with any of these. Set `coordinator.agent` in `config.json`:

- **`"builtin"`** (default): Switchboard runs its own Codex or Claude process as the coordinator, off until you turn it on. You chat with it on the home screen.
- **`"external"`**: your own agent (Claude Code, Codex, anything that speaks MCP) is the coordinator. Switchboard never starts a model or spends anything for it. The coordinator's rules (on/paused/off, authority, approvals, holds, rate and launch limits) are enforced by the daemon exactly as for the built-in one. The home screen keeps the coordinator's cards and progress, without a chat box: you talk to your agent in its own window. Connect it once:

  ```bash
  claude mcp add switchboard -- bun "$PWD/src/cli/sb.ts" mcp     # Claude Code (run in the checkout)
  codex mcp add switchboard -- bun "$PWD/src/cli/sb.ts" mcp      # Codex
  ```

  Then turn the coordinator on in the UI and tell your agent to call `get_instructions` and follow it. Details, and what an external agent can and can't do, in `docs/COORDINATOR.md`.
- **`"none"`**: no coordinator anywhere. The home row becomes **Needs you**: permission prompts (Allow / Deny) and sessions waiting for you. The safe permission policy still works; all other permission prompts come to you. `/api/coordinator*` answers 404.

Settings → **Auto-approve safe permissions** is **off by default** (D44). When off, every permission request is an Allow/Deny card. The switch applies to every device, persists across daemon restarts, and works with any coordinator mode. `autoApproveSafePermissions` in `config.json` sets the switch's initial state and how far it reaches when on:

| `autoApproveSafePermissions` | Read-only rules | Verification commands (run project code) |
|---|---|---|
| `false` (default) | off until switched on in Settings (then as `true`) | as `true` once switched on |
| `true` | any session not excluded from coordination | only coordinator-launched workers running inside their own Switchboard worktree (under `coordinator.worktreeRoot`) |
| `"all"` | any session not excluded | any session not excluded |

Sessions excluded from coordination are never auto-approved. Codex approvals follow the same switch and rules as Claude's permission hook.

The read-only rules approve a reviewed subset of `cat`, `ls`, `head`, `tail`, `wc`, `rg`, `grep`, `pwd`, Claude `Read`, and local `git status/log/diff`, after checking the session's recorded worktree or project, actual cwd, resolved paths and relevant Git configuration. Each approval records the exact call and rule in the inbox's **Auto-handled** activity and, when a coordinator exists, its activity log. A call denied by a provider prompt nobody could answer (Claude's auto-mode classifier or a prompt it couldn't show, Codex's automatic approval review) that the policy approves gets one exact-call retry. Denials from your own settings deny rules, hooks or configuration, explicit human denials, historical events and repeated denials without execution remain cards. Once the command executes, later runs can be approved again. Failed or uncertain retry delivery returns to a card.

Verification commands: Bun tests and `test/e2e/*.ts` entrypoints; package scripts through Bun/npm/pnpm/Yarn; Cargo test/build/check/clippy; pytest and `python -m pytest`; Go test/vet; Forge test/build; and `make test`. Package scripts must be defined in the nearest in-repository `package.json` and named `test`, `typecheck`, `build`, `lint` (including colon variants), or `e2e*`. These execute arbitrary repository code (which the agent may have just written); the policy does not audit script bodies or impose runtime isolation. That is why, by default, only coordinator workers in their own worktree get them automatically.

Every command in a `;`, `&&`, `||` or `|` chain must be approved. Explicit paths and output redirections must stay inside the worktree, including outputs that do not exist yet. A redirection never writes `.mcp.json`, `.vscode/`, `.husky/`, `.github/`, `package.json`, `Makefile`/`makefile`, lockfiles (`package-lock.json`, `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`), `.git/`, `.claude/`, `.codex/`, `.envrc` or `.env*`, and a `>` that would overwrite an existing file tracked by Git asks. Symlinks, traversal, sensitive explicit paths, substitutions, environment overrides, sudo, unknown options and direct installs stay Allow/Deny cards. Ordinary recursive reads still require a bounded metadata check for hidden/ignored secrets and links. Git helpers, alternate object stores, submodules, partial clones and staged secrets prevent automatic Git approval. These checks assume trusted binaries/provider environments and inspect the filesystem at decision time.


## Resource governor and game mode

Under memory pressure the governor deprioritizes, then applies `MemoryHigh` to, the biggest low-priority session tree, one step at a time, and restores after pressure has cleared. It never kills anything and never touches sessions marked protected. Game mode (a game process or GameMode client detected, or the manual toggle) pins agent process trees to the E-cores at minimum weight and restores them when the game exits. Everything is runtime-only: nothing survives a reboot.

## Security model

- The daemon listens on `127.0.0.1` only, sends no CORS headers, and validates `Host` and `Origin` on every HTTP and WebSocket request (DNS rebinding, CSRF).
- Three credentials, each with its own reach:
  - **Root bearer token** (`~/.config/switchboard/token`, 0600): the CLI, hooks and scripts. Full API. It never goes in a cookie or a URL.
  - **Browser session:** `sb open` mints a single-use login code (60 s). `/auth?code=...` swaps it for a random session secret in an HttpOnly, SameSite=Strict cookie. Only its SHA-256 is stored; it expires after 12 hours. Sign out in Settings, or sign every browser out with `sb signout`.
  - **Coordinator token** (`coordinator-token`, rotated on each daemon start): only the coordinator's MCP tool endpoints, nothing else. `sb mcp` (your own agent as the coordinator) uses this token too, re-reading it after a restart.
- WebSockets open only with a single-use 10-second ticket (`POST /api/ws-ticket`) or the root bearer; the cookie alone isn't enough. Request bodies are capped (1 MB JSON, 21 MB uploads), and cross-site `Sec-Fetch-Site` requests are refused.
- Hooks authenticate with a 0600 header file (`curl -H @file`), never a command-line argument.
- The VS Code bridge uses a unix socket inside the 0700 data dir (no port, no token on the wire), and the extension checks the directory's owner and mode before connecting.
- **Anything that can message a session can run code as you** (Codex runs with full access). Treat the token like an SSH key. Anyone with a shell as your user can read it.
- Terminal injection is guarded: the agent must be alive, on the terminal's tty and the foreground job of it, checked before the paste and again before Enter, and text goes in as a bracketed paste. A small race remains (see `docs/LIMITATIONS.md`).
- Delivery is never retried when uncertain. "Failed" means provably nothing was written; anything ambiguous (timeouts, failures after a paste, a daemon restart mid-send) is "uncertain" until a receipt shows up or you mark it "arrived" / "didn't arrive". A reused client id must carry the same request, or it's rejected.
- Each session has one control path (terminal, Codex daemon or peer), persisted across restarts, used by sends, interrupts and approvals alike. Switching paths needs confirmation and is refused while a delivery on the session is unresolved.
- The coordinator can only act through daemon-enforced tools (see `docs/COORDINATOR.md`). That binds what an external agent does *through Switchboard*; if your agent also has a shell, it can do whatever you can (D34).

## Health check

```bash
sb doctor
```

Checks the daemon, that it matches this checkout's commit, token and data-dir modes, Claude hooks and the soft-lock hook, the bridge socket (0600 in a 0700 dir) and extension, the Codex daemon socket and a read-only `thread/loaded/list`, bash bracketed paste, and the `claude`, `codex` and `notify-send` binaries.

## Tests

```bash
bun test test/            # unit and simulator tests (no real providers)
bunx tsc --noEmit -p .    # types
bun run e2e               # Playwright end-to-end tests with your installed Chrome
```

The simulator (`test/sim/claude-sim.ts`) writes fake Claude registry files and transcripts into a temp directory, backed by harmless `sleep` processes. The e2e run starts an isolated daemon on an unused local port with its own data and config directories (under `.sandbox/`), discovering only simulated sessions. Local protocol stand-ins exercise Claude/Codex Settings switches without provider calls. It restarts that daemon as `coordinator.agent` "none" and "external" for the UI checks of each, and never touches the daemon on 7777.

## Uninstall

```bash
scripts/uninstall.sh --dry-run     # show what it would do
scripts/uninstall.sh               # remove the Claude hooks and the VS Code bridge
scripts/uninstall.sh --purge       # also delete ~/.local/share/switchboard and ~/.config/switchboard (asks first)
```

Stop the daemon first. Hook removal edits only Switchboard's entries in `~/.claude/settings.json` and keeps a timestamped backup next to it. Running sessions are never touched. Delete the checkout to remove the rest.

## Troubleshooting

- **`sb open` says it can't reach the daemon:** start it (`bun run daemon`). Run `sb doctor`.
- **"Not signed in" in the UI:** the browser session expired (12 hours), was signed out, or predates the session upgrade. Run `sb open` again.
- **`sb doctor` says the daemon doesn't match the checkout:** the daemon predates your latest commit. Restart it with `scripts/dev-restart.sh` (it only restarts a daemon running from this checkout).
- **"cannot listen on 127.0.0.1:7777":** another instance is running. Use `SB_PORT=7790` for a second one with its own `SB_DATA_DIR` and `SB_CONFIG_DIR`.
- **A session shows as observe-only:** it is a VS Code extension session, or no terminal (VS Code bridge or tmux) could be mapped to it. The session card says which. For VS Code terminals, check that the bridge is installed (`code --list-extensions`) and reload the window.
- **A Codex session isn't controllable:** it was started with `-c`/`--enable`/`--disable`/`--search` (embedded mode), or the Codex daemon isn't running (`sb doctor`).
- **Messages show "uncertain":** the text was sent but never appeared in the session's transcript. Check the session yourself, then resend deliberately. It is never retried automatically.
- **No attention item for a permission prompt:** install the hooks (`sb hooks install`); Claude doesn't write prompts to its transcript.
- **Port is in use during `bun run e2e`:** the e2e uses 7795. Stop whatever holds it.

## Adding an adapter

An adapter teaches Switchboard about one kind of session. The interface is in `src/daemon/adapters/types.ts`:

1. Implement `Adapter`: `provider`, `discover(ctx)` returning `Discovered[]` (stable `id`, `nativeId`, `cwd`, `pid`, `transcriptPath`, optional `liveStatus`), `parse(record, sessionId, offsetKey)` turning one transcript line into normalized `SbEvent`s (give each a stable `sourceId` so replays dedupe), `initialTranscriptBytes`, and `claimedPids()` so the generic process scanner skips what you own. `src/daemon/adapters/claude.ts` and `parse-claude.ts` are the smallest working example.
2. Add the provider name to the `Provider` type in `src/shared/types.ts`.
3. Register it in the adapter list in `src/daemon/main.ts`. The registry does discovery ticks, transcript tailing with persisted offsets, state, attention and persistence for you.
4. Sending: add a send method in `src/daemon/messaging.ts` (`methods()` and `send()`) and return the right `controls()`. Until you do, the session is observe-only.
5. Test the parser against captured fixtures in `test/fixtures/`, and add a simulator in `test/sim/` that writes your adapter's on-disk shapes. `test/restart.test.ts` shows how to test restart behavior.

## Documents

- `docs/CAPABILITIES.md`: the verified capability matrix.
- `docs/LIMITATIONS.md`: precise remaining limitations.
- `docs/DECISIONS.md`: design decisions and why.
- `docs/COORDINATOR.md`: the coordinator agent.
- `docs/SSH_ACCESS.md`, `docs/PHONE_ACCESS.md`: using it from another machine.

## License

MIT. See `LICENSE`.
