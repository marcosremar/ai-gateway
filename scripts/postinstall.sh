#!/bin/bash
#
# Postinstall hook — auto-links the ai-gateway CLI globally so users can run
# `ai-gateway` directly (not `bunx ai-gateway` or `bun run bin/ai-gateway.ts`).
#
# Runs automatically after `bun install` in this repo. Fails silently in
# environments where linking doesn't apply (CI, nested installs as a
# dependency, no write access to ~/.bun/bin, etc).
#

set +e  # never break the install if linking fails

# Only run in the actual repo (not when installed as a dep in someone else's node_modules)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Guard: must have bin/ai-gateway.ts (we are the source repo, not a consumer)
if [ ! -f "$REPO_DIR/bin/ai-gateway.ts" ]; then
  exit 0
fi

# Guard: bun must be available
if ! command -v bun &>/dev/null; then
  exit 0
fi

# Guard: skip in CI to avoid surprising behavior
if [ "$CI" = "true" ] || [ "$CI" = "1" ]; then
  exit 0
fi

# Already linked? verify the symlink resolves to this repo
EXPECTED="$REPO_DIR/bin/ai-gateway.ts"
if command -v ai-gateway &>/dev/null; then
  CURRENT="$(readlink "$(command -v ai-gateway)" 2>/dev/null || true)"
  # readlink returns relative path; resolve against the link's directory
  case "$CURRENT" in
    /*) RESOLVED="$CURRENT" ;;
    "")  RESOLVED="" ;;
    *)   RESOLVED="$(cd "$(dirname "$(command -v ai-gateway)")" && cd "$(dirname "$CURRENT")" 2>/dev/null && pwd)/$(basename "$CURRENT")" ;;
  esac
  if [ -f "$RESOLVED" ] && [ "$(readlink -f "$RESOLVED" 2>/dev/null || echo "$RESOLVED")" = "$(readlink -f "$EXPECTED" 2>/dev/null || echo "$EXPECTED")" ]; then
    # Already linked to THIS repo — nothing to do
    exit 0
  fi
fi

# Perform the link quietly; print a one-line hint on success
chmod +x "$EXPECTED" 2>/dev/null || true
cd "$REPO_DIR" && bun link >/dev/null 2>&1 && \
  echo "[ai-gateway] CLI linked globally — run: ai-gateway help"

exit 0
