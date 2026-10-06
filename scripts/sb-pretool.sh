#!/usr/bin/env bash
# Switchboard soft-lock (Claude PreToolUse on edit tools): asks the daemon (<=300 ms) whether
# the target file is claimed or was recently edited by another session, and prints the
# daemon's hook JSON (a warning, or a block in strict repos). Fail-open: any problem -> exit 0
# with no output, so the edit proceeds normally.
cfg="${SB_CONFIG_DIR:-$HOME/.config/switchboard}"
hdr="$cfg/hook-header"
payload="$(timeout 1 cat 2>/dev/null)"
[ -r "$hdr" ] && [ -n "$payload" ] || exit 0
printf '%s' "$payload" | curl -s -m 0.3 -X POST -H @"$hdr" -H "Content-Type: application/json" \
  --data-binary @- "http://127.0.0.1:${SB_PORT:-7777}/api/hook/claude/PreToolUse" 2>/dev/null
exit 0
