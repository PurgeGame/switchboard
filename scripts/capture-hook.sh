#!/usr/bin/env bash
# Spike-only hook: dump the hook's stdin JSON to the sandbox capture dir. Always exits 0.
# usage: capture-hook.sh <provider> <event>
dir="${SB_CAPTURE_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.sandbox/capture}"
mkdir -p "$dir" 2>/dev/null
timeout 1 cat > "$dir/$1-$2-$(date +%s%N).json" 2>/dev/null
exit 0
