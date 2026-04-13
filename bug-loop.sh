#!/bin/bash
# AI Gateway Bug Fix Loop
# Para o loop: kill o PID ou delete o arquivo /tmp/bug-loop-stop

export PATH="$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"
cd /data/ai-gateway
ROUND=15

while [ ! -f /tmp/bug-loop-stop ]; do
  echo "=== ROUND $ROUND === $(date)"

  # Modulos para auditar (rotaciona)
  MODULES=("src/proxy/routes/" "src/cpu-providers/" "src/gpu-providers/" "src/browser/" "src/sdk/" "server/" "src/streaming-stt.ts" "src/ensemble-stt.ts" "src/config/" "src/deps.ts")
  MOD=${MODULES[$((ROUND % ${#MODULES[@]}))]}
  echo "Target: $MOD"

  opencode run "Audit $MOD in /data/ai-gateway for bugs: race conditions, missing error handling, resource leaks, unsafe type assertions, unbounded memory, security issues. Fix every bug found. Do NOT break existing code." --model "opencode/minimax-m2.5-free" 2>&1 | tail -5

  # Commit and push if changes
  CHANGES=$(git diff --stat 2>/dev/null | tail -1)
  if [ -n "$CHANGES" ]; then
    git add -A
    MSG=$(git diff --cached --stat | tail -1 | tr '\n' ', ')
    git commit -m "fix: round $ROUND — $MSG" 2>&1 | tail -1
    git push origin main 2>&1 | tail -1
    echo "COMMIT: round $ROUND pushed"
  else
    echo "NO CHANGES in round $ROUND"
  fi

  ROUND=$((ROUND + 1))
  echo ""
done

echo "=== LOOP STOPPED (bug-loop-stop detected) ==="
