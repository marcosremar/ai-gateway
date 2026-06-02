#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

echo "Process audit for $ROOT"
echo
ps -axo pid,ppid,pgid,stat,etime,%cpu,%mem,command |
  awk -v root="$ROOT" '
    NR == 1 { print; next }
    /node|npm|npx|pnpm|yarn|bun|vite|vitest|playwright|tsx|ts-node|next|claude|opencode|codex/ {
      if (index($0, root)) print
    }
  '

echo
echo "Listening ports owned by this repo:"
while IFS= read -r pid; do
  cwd="$(lsof -a -p "$pid" -d cwd 2>/dev/null | awk 'NR==2{print $NF}')"
  if [[ "$cwd" == "$ROOT"* ]]; then
    lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null || true
  fi
done < <(pgrep -f 'node|npm|npx|pnpm|yarn|bun|vite|vitest|playwright|tsx|ts-node|next' || true) || true

echo
echo "Tip: run 'bun run stop:orphans -- --yes' to stop known orphan dev/watch processes."
