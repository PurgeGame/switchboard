#!/usr/bin/env bash
# Throwaway-session harness for integration spikes. Uses a private tmux socket
# (-L switchboard-sandbox) so it can never touch the user's own tmux sessions.
set -euo pipefail
T="tmux -L switchboard-sandbox"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/.sandbox"
cmd="${1:-}"; shift || true
case "$cmd" in
  start)   # start <name> <dir-under-sandbox> <command...>
    name=$1 dir=$ROOT/$2; shift 2; mkdir -p "$dir"
    $T new-session -d -s "$name" -x 200 -y 50 -c "$dir" "$*" ;;
  send)    # send <name> <text>   (literal text, then Enter)
    $T send-keys -t "$1" -l -- "$2"; sleep 0.3; $T send-keys -t "$1" Enter ;;
  keys)    # keys <name> <tmux key names...>
    n=$1; shift; $T send-keys -t "$n" "$@" ;;
  cap)     # cap <name> [lines]
    $T capture-pane -p -t "$1" -S "-${2:-60}" ;;
  pid)     # pid <name>  -> pane process pid
    $T display -p -t "$1" '#{pane_pid}' ;;
  ls)      $T ls 2>/dev/null || true ;;
  stop)    $T kill-session -t "$1" ;;
  nuke)    $T kill-server 2>/dev/null || true ;;
  *) echo "usage: sandbox.sh start|send|keys|cap|pid|ls|stop|nuke" >&2; exit 2 ;;
esac
