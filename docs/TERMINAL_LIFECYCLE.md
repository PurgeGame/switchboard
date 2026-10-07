# Managed VS Code terminal lifecycle

How Switchboard opens, tracks and closes the VS Code terminals it launches agents in, and
how this composes with ending and resuming sessions from the UI.

## Cause and paths

Previously `BridgeHub.launch()` sent `create` to `bridge/extension.js`. The extension
called `window.createTerminal({name, cwd})`, then `sendText(command, true)`. This
starts an **interactive shell**, with Claude/Codex as its child. `/exit`, `/quit`, or
signalling the confirmed agent ends the child, leaving the shell/tab alive. Every
new launch adds another shell. The bridge had send/show/create, no disposal request.
The persisted `launched-terminals.json` contained terminal IDs, not proof that an
ended session still exclusively owned the shell.

The callers converge on the same launch method:

| Entry | Path |
| --- | --- |
| Launcher | `POST /api/launch` → `BridgeHub.launch` |
| Coordinator / Perspectives | `main.ts` → `Perspectives.launchAndSend` → `BridgeHub.launch` |
| One-tap Resume (fd31e472) | `POST /api/sessions/:id/resume` → `SessionResumer.resume` → `BridgeHub.launch` |
| Manual End | HTTP session end → `Messenger.end` → guarded quit / confirmed process signals |
| Background auto-end | coordinator auto-end guards → the same `Messenger.end` |
| Natural exit / closing the CLI | process exit; registry subsequently observes disappearance |

The verified End/Resume change confirms exit before persisting ended state and
releasing claims; it also deduplicates concurrent/uncertain Resume attempts. It
does **not** remove the interactive shell. This explains accumulation without a
duplicate attachment or a still-live agent. Source tracing and throwaway PTYs
establish this mechanism; no claim is made about the live process inside any
particular pre-existing user tab, and no live tabs were inspected or modified.

## Chosen behavior

New launches use the extension's `createManaged` capability. `createTerminal` starts
`python3 src/daemon/managed-terminal.py <launch UUID> <command>` as its dedicated
terminal process. The runner executes the existing generated command with
`/bin/bash -lc 'exec …'`; it never supplies an interactive shell or reads commands
after that agent exits. Command quoting, cwd, conversation IDs, and provider flags
are retained. Python 3, Linux child subreaping, and readable `/proc` are required.

Before launching the child, the runner enables `PR_SET_CHILD_SUBREAPER`. It waits
for the exact child, then uses `waitpid` to retain/reap all surviving descendants,
including double-forked jobs with a detached session or inherited terminal handles.
Once the kernel reports no children, a fresh `/proc` check verifies the runner's
PID **and start time**, tty identity, and absence of other processes on that tty.
Unknown/unreadable identity keeps the tab open. Only then does the runner exit and
VS Code perform its normal process-exit disposal. There is no daemon cleanup
timer, generic terminal manager, terminal kill request, or shell `exit` injection.

An idle or stopped agent is still live and is retained. Other live commands retain
the terminal even after the agent's exit, with a short message explaining why.
When the remaining work exits, the check runs again. The owner handles Ctrl-C so
End's draft clearing cannot accidentally terminate the terminal owner while work
survives. Normal VS Code terminal persistence remains enabled; a daemon/bridge
disconnect does not terminate the launch. This also works when the daemon is down.

Ownership is a random UUID per launch, carried in explicit creation options and
runner arguments. It gives the terminal a stable ID across bridge reconnects when
VS Code retains its creation options. The daemon persists that ownership **before**
sending the create request, including when the reply is lost. Session-to-terminal
mapping uses the current agent ancestry, optional captured agent start time, and
the exact current runner/launch arguments; it never uses the terminal title.
Duplicate attachments, conflicting launch requests, and stale identities refuse
mapping. A repeated create request for a still-open identical launch returns its
existing attachment without starting another command. Each actual Resume gets a
new launch UUID; fd31e472 remains responsible for deduplicating Resume requests.

Transcripts, database history, worktrees, staged/unstaged files, and untracked work
are not deleted or changed by terminal cleanup. One-tap Resume still uses the same
native conversation ID and cwd through `SessionResumer`; it gains this behavior
through the unchanged `BridgeHub.launch(cwd, name, command)` interface.

## Exact VS Code support and limits

The stable API in the extension's declared minimum VS Code **1.90** supports
`TerminalOptions.shellPath`, `shellArgs`, `env`, `isTransient`, `processId`,
`creationOptions`, `exitStatus`, `onDidCloseTerminal`, and `Terminal.dispose()`.
`processId` is the terminal's initial process, not proof of which agent/thread it
runs. `dispose()` can kill a live terminal; `exitStatus` concerns the terminal root,
not an agent child returning to a shell. The public API has **no atomic conditional
dispose/reuse operation that proves an interactive shell has no other work**.
Optional shell-integration command completion does not establish that either.

Normal `createTerminal` process exit disposes the terminal in VS Code's
`TerminalInstance._onProcessExit`. The internal `waitOnExit` option is **not** a
public `TerminalOptions` field; this implementation neither sends that unsupported
option nor relies on shell-integration events. Sources:

- [VS Code 1.90 public terminal API](https://github.com/microsoft/vscode/blob/1.90.0/src/vscode-dts/vscode.d.ts)
- [Extension terminal creation transport](https://github.com/microsoft/vscode/blob/1.90.0/src/vs/workbench/api/common/extHostTerminalService.ts)
- [VS Code process-exit disposal](https://github.com/microsoft/vscode/blob/1.90.0/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts)
- [Linux subreaper semantics](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)
- [Kernel child-exit confirmation](https://man7.org/linux/man-pages/man2/waitpid.2.html)

Pre-existing **legacy interactive shells are left alone**, even if their names
look like Switchboard launches or their recorded agent PID has disappeared.
Neither the old bridge nor its ID-only ledger proves continued exclusive session
ownership, and even an empty process scan cannot atomically prevent a user command
from starting before disposal. Upgrading does not manufacture that missing proof.
Existing dedicated runners from this version already self-clean after exit,
including across daemon/extension reconnects. Unattributable restored terminals
remain untouched. There is no retroactive cleanup of ambiguous tabs.

New launches fail with an explicit capability error on old bridges rather than
silently falling back to accumulating interactive shells. Legacy messaging/End
continues to work. Installing bridge **0.1.2** and activating the updated extension
is an integration/deployment step; this task packaged it but did not install it,
restart/reload VS Code, or restart the user's daemon. The daemon and runner must
be deployed together, with Python 3 available to the local extension host.

## Verification

`test/bridge-extension.test.ts` executes the actual extension in a VM with an
isolated VS Code API. It covers dedicated creation, stable ownership, reconnect
attachment, conflicting/ambiguous ownership, user and legacy shells, repeated
process-exit removal, and refusal of arbitrary disposal requests.

`test/managed-terminal.test.ts` uses synthetic `/proc` trees and real throwaway
PTYs (`test/fixtures/managed-pty.py`). It covers both providers, manual End and
guarded auto-end, repeated launch/exit, idle agents, stale identity, malformed
process data, unrelated processes, duplicate attachments, active child commands,
double-forked detached work, and Ctrl-C. It verifies preserved transcript/work
files and that typing after exit cannot execute a shell command.

Two further tests activate only when fd31e472's `resume.ts` is present. They use
the real `SessionResumer`, `Registry`, `Messenger`, and `BridgeHub`, with an isolated
PTY transport/provider stand-in, for three concurrent-Resume/End cycles per
provider. The reference commit's own End/Resume, process-resolution,
launch-linking and Codex pin tests are also run in an archive under this worktree's
`.sandbox/end-resume-integration`, with this patch applied. No other worktree is
modified. API-adapter tests and upstream source inspection validate VS Code's
tab lifecycle; no live VS Code UI smoke test was performed.

Integration note: fd31e472's snapshot predates the current branch's `EndGuard`
parameter and auto-end suite. Its older `Messenger.end` ignores a second argument.
The current branch's auto-end tests run separately; the integration worker must
preserve those guards when merging the verified End/Resume implementation. This
terminal patch does not replace either implementation.

Validation commands/results:

- `bun test test/`: 862 passed, 2 Resume-dependency tests skipped, 0 failed.
- In the fd31e472 archive: `bun test test/managed-terminal.test.ts test/bridge-extension.test.ts test/end-session.test.ts test/session-process.test.ts test/launch-linking.test.ts test/codex-pins.test.ts`: 55 passed, 0 failed; both additional Resume tests ran.
- `bun run typecheck` and `bun run build`: passed in both trees.
- `bash scripts/bridge.sh package`: produced `dist/switchboard-bridge-0.1.2.vsix`; no installation.
