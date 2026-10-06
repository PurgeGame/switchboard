#!/usr/bin/env bash
# Switchboard PermissionRequest hook: asks switchboardd to decide a Claude permission prompt.
# The daemon either approves it (the coordinator judged it reasonable), relays your answer from
# Switchboard, or replies empty so Claude's own terminal dialog appears as usual.
# Fail-open: no daemon, no token, an error or a timeout all mean "show the normal dialog".
# usage (from ~/.claude/settings.json, hook timeout well above the hold window):
#   sb-permission.sh
cfg="${SB_CONFIG_DIR:-$HOME/.config/switchboard}"
hdr="$cfg/hook-header" # "Authorization: Bearer <token>", mode 0600 (never on the command line)
port="${SB_PORT:-7777}"
payload="$(timeout 1 cat 2>/dev/null)"
[ -r "$hdr" ] && [ -n "$payload" ] || exit 0
out="$(printf '%s' "$payload" | curl -s -m 840 -X POST -H @"$hdr" -H "Content-Type: application/json" \
  --data-binary @- "http://127.0.0.1:$port/api/hook/claude/PermissionRequest?wait=1" 2>/dev/null)" || exit 0
case "$out" in
  "{"*"}") printf '%s\n' "$out" ;;
esac
exit 0
