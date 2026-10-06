#!/usr/bin/env bash
# Dev helper: (re)start switchboardd from this checkout, detached, logging to .sandbox/switchboardd.log.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${SB_PORT:-7777}"
pid=$(ss -ltnp 2>/dev/null | grep "127.0.0.1:$port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
if [ -n "${pid:-}" ]; then
  [ "$(readlink /proc/$pid/cwd)" = "$root" ] || { echo "port $port is held by pid $pid outside $root; not touching it" >&2; exit 1; }
  kill "$pid"; for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
fi
mkdir -p "$root/.sandbox"
cd "$root" && setsid nohup bun src/daemon/main.ts >>"$root/.sandbox/switchboardd.log" 2>&1 < /dev/null &
for _ in $(seq 50); do curl -s "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && { echo "switchboardd up on $port"; exit 0; }; sleep 0.1; done
echo "switchboardd did not come up; see .sandbox/switchboardd.log" >&2; exit 1
