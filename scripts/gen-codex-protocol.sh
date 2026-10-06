#!/usr/bin/env bash
# Regenerate Codex app-server protocol bindings for the installed Codex version.
# Output is gitignored; re-run after every Codex upgrade.
set -euo pipefail
out="$(dirname "$0")/../docs/research/codex-protocol"
codex app-server generate-ts --out "$out/ts"
codex app-server generate-json-schema --out "$out/schema"
codex app-server generate-ts --experimental --out "$out/ts-experimental"
codex --version > "$out/VERSION"
