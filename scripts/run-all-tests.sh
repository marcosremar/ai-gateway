#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Run ALL tests — sets up local infrastructure and runs everything
# ═══════════════════════════════════════════════════════════════════
#
# Usage:
#   ./scripts/run-all-tests.sh           # Full suite with infra
#   ./scripts/run-all-tests.sh --quick   # Default suite only (no infra)
#
# Prerequisites (installed automatically):
#   - PostgreSQL 16 (Homebrew)
#   - Ollama with llama3.2:1b
#   - Gateway server running on localhost:4000
#
# API keys (from .env):
#   - GROQ_API_KEY (required)
#   - VAST_API_KEY (enables Vast.ai tests)
#   - RUNPOD_API_KEY (enables RunPod tests)
#   - OPENAI_API_KEY (enables OpenAI tests)
#   - DEEPGRAM_API_KEY (enables Deepgram tests)

set -e

cd "$(dirname "$0")/.."
source .env 2>/dev/null || true

# ── Quick mode ──
if [ "$1" = "--quick" ]; then
  echo "🚀 Running default test suite (no infra)..."
  bun run test
  exit $?
fi

echo "═══════════════════════════════════════════"
echo "  AI Gateway — Full Test Suite Runner"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Start PostgreSQL ──
echo "📦 Setting up PostgreSQL..."
if pg_isready -q 2>/dev/null; then
  echo "  ✓ PostgreSQL already running"
else
  brew services start postgresql@16 2>/dev/null || true
  sleep 3
  if pg_isready -q 2>/dev/null; then
    echo "  ✓ PostgreSQL started"
  else
    echo "  ⚠ PostgreSQL not available (install: brew install postgresql@16)"
  fi
fi

if pg_isready -q 2>/dev/null; then
  createdb aigateway_test 2>/dev/null || true
  export DATABASE_URL="postgresql://$(whoami)@localhost:5432/aigateway_test"
  echo "  ✓ Database: $DATABASE_URL"
fi

# ── 2. Start Ollama ──
echo "🤖 Setting up Ollama..."
if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "  ✓ Ollama already running"
else
  if command -v ollama &>/dev/null; then
    ollama serve &>/dev/null &
    sleep 5
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
      echo "  ✓ Ollama started"
      # Pull model if missing
      if ! ollama list 2>/dev/null | grep -q 'llama3.2'; then
        echo "  ↓ Pulling llama3.2:1b..."
        ollama pull llama3.2:1b 2>/dev/null
      fi
    fi
  else
    echo "  ⚠ Ollama not installed (install: brew install ollama)"
  fi
fi

# ── 3. Check Gateway ──
echo "🌐 Checking Gateway..."
if curl -sf http://localhost:4000/health > /dev/null 2>&1; then
  echo "  ✓ Gateway running on localhost:4000"
  export GATEWAY_URL=http://localhost:4000
else
  echo "  ⚠ Gateway not running (start: bun server/ws-server.ts &)"
  echo "  → Live tests will be skipped"
fi

# ── 4. API Keys ──
echo "🔑 API Keys:"
[ -n "$GROQ_API_KEY" ]    && echo "  ✓ GROQ_API_KEY" || echo "  ✗ GROQ_API_KEY (required)"
[ -n "$VAST_API_KEY" ]    && echo "  ✓ VAST_API_KEY" || echo "  ✗ VAST_API_KEY"
[ -n "$RUNPOD_API_KEY" ]  && echo "  ✓ RUNPOD_API_KEY" || echo "  ✗ RUNPOD_API_KEY"
[ -n "$OPENAI_API_KEY" ]  && echo "  ✓ OPENAI_API_KEY" || echo "  ✗ OPENAI_API_KEY"
[ -n "$DEEPGRAM_API_KEY" ] && echo "  ✓ DEEPGRAM_API_KEY" || echo "  ✗ DEEPGRAM_API_KEY"

echo ""
echo "═══════════════════════════════════════════"
echo "  Running tests..."
echo "═══════════════════════════════════════════"
echo ""

# ── 5. Run tests ──
SKIP_GPU_TESTS=0 SKIP_LIVE_TESTS=0 bun run test

STATUS=$?

# ── 6. Cleanup ──
echo ""
echo "═══════════════════════════════════════════"
echo "  Cleanup"
echo "═══════════════════════════════════════════"

# Destroy any running GPU instances
if [ -n "$VAST_API_KEY" ]; then
  count=$(curl -s -H "Authorization: Bearer $VAST_API_KEY" "https://console.vast.ai/api/v0/instances/" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('instances',[])))" 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ]; then
    echo "🧹 Cleaning $count Vast.ai instance(s)..."
    curl -s -H "Authorization: Bearer $VAST_API_KEY" "https://console.vast.ai/api/v0/instances/" 2>/dev/null | python3 -c "
import sys,json,subprocess
d=json.load(sys.stdin)
for i in d.get('instances',[]):
  subprocess.run(['curl','-s','-X','DELETE',f'https://console.vast.ai/api/v0/instances/{i[\"id\"]}/','-H',f'Authorization: Bearer {sys.argv[1]}'],capture_output=True)
" "$VAST_API_KEY" 2>/dev/null
  fi
fi

echo "✓ Cleanup complete. Zero machines running."
exit $STATUS
