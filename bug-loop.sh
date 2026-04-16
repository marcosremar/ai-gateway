#!/bin/bash
# AI Gateway Bug Fix Loop v4 — SAFETY: Never pushes to main directly
# Creates feature branches for review instead of direct main pushes
# Para: touch /tmp/bug-loop-stop

export PATH="$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"
cd /data/ai-gateway

# SAFETY CHECK: Never operate on main branch directly
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "ERROR: bug-loop.sh cannot run on main/master branch for safety reasons."
  echo "Please create a feature branch first: git checkout -b bugfix/ai-audit"
  exit 1
fi

# Detecta último round
LAST=$(git log --oneline -1 --grep="round" 2>/dev/null | grep -oP 'round \K\d+')
ROUND=${LAST:-17}
ROUND=$((ROUND + 1))

MODULES=("src/proxy/routes/" "src/cpu-providers/" "src/gpu-providers/" "src/browser/" "src/sdk/" "server/" "src/streaming-stt.ts" "src/ensemble-stt.ts" "src/config/" "src/deps.ts")
MODCOUNT=${#MODULES[@]}

echo "SAFETY MODE: Changes will be committed to current branch ($CURRENT_BRANCH)"
echo "SAFETY MODE: Push to main is DISABLED. Push to feature branch instead."
echo "SAFETY MODE: To stop: touch /tmp/bug-loop-stop"
echo ""

while [ ! -f /tmp/bug-loop-stop ]; do
  MOD=${MODULES[$((ROUND % MODCOUNT))]}
  echo "=== ROUND $ROUND === $(date) | Target: $MOD"

  # Roda opencode num subprocess com timeout de 3 min
  timeout 180 opencode run "Audit $MOD in /data/ai-gateway for NEW bugs not yet fixed. Focus on: race conditions, missing error handling, resource leaks, unsafe casts, unbounded memory. Fix every bug. Do NOT break existing code." --model "opencode/minimax-m2.5-free" 2>&1 | tail -3

  # Commit if changes
  if ! git diff --quiet 2>/dev/null; then
    git add -A
    DESC=$(git diff --cached --stat | tail -1)
    git commit -m "fix: round $ROUND — $DESC" 2>&1 | tail -1
    HASH=$(git log --oneline -1 | cut -d' ' -f1)

    # SAFETY: Push to current branch (NOT main) for review
    git push origin "$CURRENT_BRANCH" 2>&1 | tail -1
    echo ">>> COMMIT $HASH: round $ROUND (pushed to $CURRENT_BRANCH, NOT main)"
  else
    echo ">>> NO CHANGES round $ROUND"
  fi

  ROUND=$((ROUND + 1))
done

echo "=== LOOP STOPPED at round $ROUND ==="
echo "Next step: Create a PR from $CURRENT_BRANCH to main for review"
