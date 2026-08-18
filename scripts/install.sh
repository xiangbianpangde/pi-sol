#!/usr/bin/env bash
# Copy /sol into the local Pi agent home. Does not touch ChatGPT cookies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${PI_AGENT_HOME:-$HOME/.pi/agent}"

mkdir -p "$DEST/extensions/lib" "$DEST/skills"
cp "$ROOT/extensions/sol.ts" "$DEST/extensions/sol.ts"
rm -rf "$DEST/extensions/lib/sol"
cp -R "$ROOT/extensions/lib/sol" "$DEST/extensions/lib/sol"
rm -rf "$DEST/skills/sol"
cp -R "$ROOT/skills/sol" "$DEST/skills/sol"

echo "installed /sol → $DEST"
echo "in Pi: /reload   then   /sol-auth   then   /sol ping"
