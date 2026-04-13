#!/bin/bash
# AI Gateway Bug Fix Loop (auto-resume)
# Para: touch /tmp/bug-loop-stop

export PATH="$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"
cd /data/ai-gateway

# Detecta último round a partir do git log
LAST=$(git log --oneline -1 --grep="round" 2>/dev/null | grep -oP 'round \K\d+')
ROUND=${LAST:-14}
ROUND=$((ROUND + 1))

MODULES=("src/proxy/routes/" "src/cpu-providers/" "src/gpu-providers/" "src/browser/" "src/sdk/" "server/" "src/streaming-stt.ts" "src/ensemble-stt.ts" "src/config/" "src/deps.ts")
MODCOUNT=${#MODULES[@]}

while [ ! -f /tmp/bug-loop-stop ]; do
  MOD=${MODULES[$((ROUND % MODCOUNT))]}
  echo "=== ROUND $ROUND === $(date) | Target: $MOD"

  opencode run "Audit $MOD in /data/ai-gateway for NEW bugs not yet fixed. Focus on: race conditions, missing error handling, resource leaks, unsafe casts, unbounded memory. Fix every bug. Do NOT break existing code." --model "opencode/minimax-m2.5-free" 2>&1 | tail -3

  # Commit if changes
  if ! git diff --quiet 2>/dev/null; then
    git add -A
    DESC=$(git diff --cached --stat | tail -1)
    git commit -m "fix: round $ROUND — $DESC" 2>&1 | tail -1
    HASH=$(git log --oneline -1 | cut -d' ' -f1)
    git push origin main 2>&1 | tail -1
    echo ">>> COMMIT $HASH: round $ROUND pushed"
  else
    echo ">>> NO CHANGES in round $ROUND"
  fi

  ROUND=$((ROUND + 1))
done

echo "=== LOOP STOPPED at round $ROUND ==="
