#!/usr/bin/env bash
# Install Switchboard from this checkout. Idempotent: safe to run again.
#   scripts/install.sh [--dry-run] [--no-bridge] [--no-hooks]
# Does NOT install a systemd unit or any autostart (decision D14), and does not start the daemon.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dry=0; bridge=1; hooks=1
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --no-bridge) bridge=0 ;;
    --no-hooks) hooks=0 ;;
    -h|--help) sed -n 2,5p "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
run() { if [ "$dry" = 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@"; fi; }
cd "$root"
command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
run bun install
run bun run build
if [ "$hooks" = 1 ]; then run bun src/cli/sb.ts hooks install; fi
bridged=0
if [ "$bridge" = 1 ]; then
  if command -v code >/dev/null; then run scripts/bridge.sh install; bridged=1; else echo "skipping the VS Code bridge: \`code\` is not on PATH"; fi
fi
if [ "$dry" = 1 ]; then echo; echo "Dry run: nothing was changed."; exit 0; fi
cat <<EOF

Installed. Start the daemon yourself (there is no autostart):
  cd $root && bun run daemon        # foreground
  $root/scripts/dev-restart.sh      # detached; logs to .sandbox/switchboardd.log
Then open the UI:
  bun src/cli/sb.ts open            # or put \`sb\` on your PATH: ln -s $root/src/cli/sb.ts ~/.local/bin/sb
Check the setup with: bun src/cli/sb.ts doctor
EOF
if [ "$bridged" = 1 ]; then echo "Reload the VS Code window once so it activates the bridge extension."; fi
