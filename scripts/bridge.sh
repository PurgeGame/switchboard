#!/usr/bin/env bash
# Package and install (or uninstall) the local Switchboard Bridge VS Code extension.
# usage: scripts/bridge.sh install|uninstall|package
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
id="switchboard-local.switchboard-bridge"
ver=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$root/bridge/package.json")
out="$root/dist/switchboard-bridge-$ver.vsix"
package() {
  local tmp; tmp=$(mktemp -d)
  mkdir -p "$tmp/extension"
  cp "$root/bridge/package.json" "$root/bridge/extension.js" "$tmp/extension/"
  cat > "$tmp/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
XML
  cat > "$tmp/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="switchboard-bridge" Version="$ver" Publisher="switchboard-local"/>
    <DisplayName>Switchboard Bridge</DisplayName>
    <Description xml:space="preserve">Local-only bridge between VS Code terminals and the Switchboard daemon.</Description>
    <Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0"/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
XML
  mkdir -p "$root/dist"; rm -f "$out"
  (cd "$tmp" && zip -q -r -X "$out" "[Content_Types].xml" extension.vsixmanifest extension)
  rm -rf "$tmp"
  echo "$out"
}
case "${1:-}" in
  package) package ;;
  install) package >/dev/null; code --install-extension "$out" --force ;;
  uninstall) code --uninstall-extension "$id" ;;
  *) echo "usage: $0 install|uninstall|package" >&2; exit 2 ;;
esac
