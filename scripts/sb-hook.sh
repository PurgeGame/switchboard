#!/usr/bin/env bash
# Switchboard hook: forwards the hook's stdin JSON to switchboardd and exits immediately.
# Fail-open by design: whether or not the daemon is running, the agent is never blocked,
# delayed (stdin read is capped at 1s, the POST runs detached) or shown an error.
# usage (from ~/.claude/settings.json): sb-hook.sh <provider> <event>
cfg="${SB_CONFIG_DIR:-$HOME/.config/switchboard}"
hdr="$cfg/hook-header" # "Authorization: Bearer <token>", mode 0600 (never on the command line)
port="${SB_PORT:-7777}"
payload="$(timeout 1 cat 2>/dev/null)"
[ -r "$hdr" ] && [ -n "$payload" ] || exit 0
(
  printf '%s' "$payload" | curl -s -m 1 -o /dev/null -X POST -H @"$hdr" -H "Content-Type: application/json" \
    --data-binary @- "http://127.0.0.1:$port/api/hook/$1/$2" >/dev/null 2>&1 &
) >/dev/null 2>&1 </dev/null
exit 0
