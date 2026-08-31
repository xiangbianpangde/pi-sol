#!/usr/bin/env bash
# Copy /sol into the local Pi agent home. Does not touch ChatGPT cookies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${PI_AGENT_HOME:-$HOME/.pi/agent}"

# ---- P1-2: protocol epoch migration guard ----
# The flock-based coordination protocol (ac52249+) replaces the pathname-based
# protocol (<ac52249).  These are NOT wire-compatible — an old Pi process
# using the old pathname lock and a new process using the kernel flock have
# no shared mutex.  Detect live Pi processes and refuse, unless overridden.
PI_PIDS="$(pgrep -f 'pi-coding-agent' 2>/dev/null || true)"
if [ -n "$PI_PIDS" ]; then
  echo ""
  echo "WARNING: Pi processes detected (PIDs: $(echo "$PI_PIDS" | tr '\n' ' '))."
  echo ""
  echo "This upgrade changes the /sol admission coordination protocol from"
  echo "pathname-based (< ac52249) to kernel-level flock (ac52249+).  These"
  echo "are NOT compatible — an old and new Pi session have no shared mutex."
  echo ""
  echo "Before installing:"
  echo "  1. Close ALL Pi sessions (terminal TUI, desktop app, etc.)"
  echo "  2. Run this installer"
  echo "  3. Start Pi and /reload"
  echo ""
  echo "To override (only if you are SURE no old Pi will run concurrently):"
  echo "  PI_SOL_FORCE_UPGRADE=1 $0"
  echo ""
  if [ -z "${PI_SOL_FORCE_UPGRADE:-}" ]; then
    exit 1
  fi
  echo "Override active — upgrading with live Pi processes (not recommended)."
fi

# ---- copy extension + skill files ----
mkdir -p "$DEST/extensions/lib" "$DEST/skills"
cp "$ROOT/extensions/sol.ts" "$DEST/extensions/sol.ts"
rm -rf "$DEST/extensions/lib/sol"
cp -R "$ROOT/extensions/lib/sol" "$DEST/extensions/lib/sol"
rm -rf "$DEST/skills/sol"
cp -R "$ROOT/skills/sol" "$DEST/skills/sol"

# ---- install native dependency (fs-ext) for the extension ----
# The extension at $DEST/extensions/lib/sol/admission.ts resolves bare imports
# from $DEST/extensions/node_modules upward.  Install fs-ext there so the
# extension can load the kernel-flock primitive (audit round P1-1).
if [ -f "$DEST/extensions/package.json" ] || [ ! -f "$DEST/extensions/package.json" ]; then
  # Create a minimal package.json if missing; npm init below handles it.
  true
fi
cd "$DEST/extensions"
npm init -y --silent 2>/dev/null || true
npm install fs-ext@^2.1.1 --no-audit --no-fund --no-progress 2>&1 | tail -2 || {
  echo "ERROR: Could not install fs-ext native dependency."
  echo "  /sol admission requires the kernel flock primitive (fs-ext)."
  echo "  Check build tools (node-gyp, Xcode CLI tools) and retry."
  echo "  If fs-ext cannot be built, /sol will not work — there is"
  echo "  no pathname fallback (that would reintroduce the audit P1 TOCTOU)."
  exit 1
}

echo "installed /sol → $DEST"
echo ""
echo "  Chrome UI must be English (chrome://settings/languages)"
echo "  or /sol-auth will fail."
echo ""
echo "  in Pi:  /reload  then  /sol-auth  then  /sol ping"