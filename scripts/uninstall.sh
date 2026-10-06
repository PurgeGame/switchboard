#!/usr/bin/env bash
# Uninstall Switchboard's footprint outside this checkout. Idempotent.
#   scripts/uninstall.sh [--dry-run] [--purge]
#   --dry-run  print what would be done and change nothing
#   --purge    also delete ~/.local/share/switchboard and ~/.config/switchboard (asks first)
# Stop the daemon yourself first (kill it, or Ctrl-C). Sessions are never affected.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dry=0; purge=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --purge) purge=1 ;;
    -h|--help) sed -n 2,6p "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
run() { if [ "$dry" = 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; "$@" || echo "  (non-fatal: $* failed or was already done)"; fi; }
cd "$root"
# Hooks first: they reference files in the data dir. Removes only our entries from ~/.claude/settings.json.
run bun src/cli/sb.ts hooks uninstall
if command -v code >/dev/null; then
  if [ "$dry" = 1 ] || code --list-extensions 2>/dev/null | grep -q '^switchboard-local.switchboard-bridge$'; then
    run scripts/bridge.sh uninstall
  else
    echo "bridge extension not installed: nothing to do"
  fi
else
  echo "\`code\` not on PATH: skipping the bridge extension"
fi
if [ "$purge" = 1 ]; then
  dirs=("$HOME/.local/share/switchboard" "$HOME/.config/switchboard")
  echo "--purge deletes (the event database, the outbox, uploads, tokens):"
  for d in "${dirs[@]}"; do [ -e "$d" ] && echo "  $d" || echo "  $d (absent)"; done
  if [ "$dry" = 1 ]; then
    echo "[dry-run] would ask for confirmation, then: rm -rf ${dirs[*]}"
  else
    [ -t 0 ] || { echo "--purge needs an interactive terminal for its confirmation; not deleting." >&2; exit 1; }
    read -r -p "Type 'purge' to delete them: " ans
    if [ "$ans" = "purge" ]; then rm -rf "${dirs[@]}"; echo "deleted"; else echo "cancelled; nothing deleted"; fi
  fi
fi
echo "Done. Remove this checkout to remove the rest. Running sessions were not touched."
