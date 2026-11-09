#!/usr/bin/env bash
#
# Rebuild, repackage, and reinstall the Waypoint extension into your running
# VS Code -- the dev cycle for testing in *this* window (which has the real
# .waypoint/plans/). Run after every change:
#
#   ./reload.sh
#
# Then reload the VS Code window (Cmd+R, or "Developer: Reload Window") to pick
# up the freshly installed build.
set -euo pipefail

cd "$(dirname "$0")"

VSIX="waypoint.vsix"

echo "==> Building + packaging"
# vsce runs the `vscode:prepublish` build first; --no-dependencies skips the
# npm dependency scan (nothing from node_modules ships); -o pins the name.
bunx @vscode/vsce package --no-dependencies -o "${VSIX}" >/dev/null

if ! command -v code >/dev/null 2>&1; then
  echo "ERROR: the 'code' CLI isn't on your PATH." >&2
  echo "  In VS Code: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'." >&2
  echo "  Packaged ${VSIX} -- install it manually via 'Extensions: Install from VSIX...'." >&2
  exit 1
fi

echo "==> Installing ${VSIX}"
code --install-extension "${VSIX}" --force >/dev/null

echo "OK: installed ${VSIX}"
echo "--> Reload the VS Code window (Cmd+R) to load the new build."
