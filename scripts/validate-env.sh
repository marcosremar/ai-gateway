#!/bin/bash
# Environment Variable Validation Script
# Validates .env completeness before deploy
# Usage: bash scripts/validate-env.sh

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ENV_FILE="${1:-.env}"
ERRORS=0
WARNINGS=0

echo "======================================"
echo "Environment Variable Validation"
echo "File: $ENV_FILE"
echo "======================================"
echo ""

# Check if file exists
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}✗ ERROR: $ENV_FILE not found${NC}"
  echo "  Create from template: cp .env.example $ENV_FILE"
  exit 1
fi

echo -e "${GREEN}✓ File exists${NC}"

# Parse env file safely — never `source` it. `source` would execute arbitrary
# shell code (backticks, $(...), command substitution in values) if the file
# is tampered with. Parse `KEY=VAL` lines ourselves, strip a single pair of
# surrounding quotes, and assign via `printf -v` so values are treated as
# literal strings.
while IFS= read -r __line || [ -n "$__line" ]; do
  # Trim leading whitespace and skip blank/comment lines.
  __line="${__line#"${__line%%[![:space:]]*}"}"
  [ -z "$__line" ] && continue
  case "$__line" in \#*) continue ;; esac
  # Optional leading `export ` keyword.
  case "$__line" in export\ *) __line="${__line#export }" ;; esac
  # Must look like NAME=VALUE where NAME is a valid shell identifier.
  case "$__line" in
    [A-Za-z_]*=*) ;;
    *) continue ;;
  esac
  __key="${__line%%=*}"
  __val="${__line#*=}"
  # Only accept NAME chars.
  case "$__key" in
    *[!A-Za-z0-9_]*) continue ;;
  esac
  # Strip a matching pair of surrounding quotes; do not interpret escapes.
  case "$__val" in
    \"*\") __val="${__val#\"}"; __val="${__val%\"}" ;;
    \'*\') __val="${__val#\'}"; __val="${__val%\'}" ;;
  esac
  printf -v "$__key" '%s' "$__val"
  export "$__key"
done < "$ENV_FILE"
unset __line __key __val

# Required variables for production
REQUIRED_VARS=(
  "PORT"
  "NODE_ENV"
  "CORS_ORIGINS"
  "RATE_LIMIT_RPM"
)

# AI Provider variables (at least one required)
AI_VARS=(
  "OPENAI_API_KEY"
  "GROQ_API_KEY"
  "OPENROUTER_API_KEY"
  "FIREWORKS_API_KEY"
)

# GPU Provider variables (at least one required)
GPU_VARS=(
  "RUNPOD_API_KEY"
  "TENSORDOCK_API_TOKEN"
  "VAST_API_KEY"
  "MODAL_TOKEN_ID"
)

# Secret variables (should not contain placeholder values)
SECRET_VARS=(
  "GPU_ACCESS_SECRET"
)

echo ""
echo "--- Required Variables ---"
for var in "${REQUIRED_VARS[@]}"; do
  value="${!var}"
  if [ -z "$value" ]; then
    echo -e "${RED}✗ ERROR: $var is not set${NC}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "${GREEN}✓ $var is set${NC}"
  fi
done

echo ""
echo "--- AI Provider Variables (at least one required) ---"
AI_COUNT=0
for var in "${AI_VARS[@]}"; do
  value="${!var}"
  if [ -n "$value" ] && [ "$value" != "sk-..." ] && [ "$value" != "gsk_..." ]; then
    AI_COUNT=$((AI_COUNT + 1))
  fi
done
if [ $AI_COUNT -eq 0 ]; then
  echo -e "${RED}✗ ERROR: No AI provider configured. Set at least one of: ${AI_VARS[*]}${NC}"
  ERRORS=$((ERRORS + 1))
else
  echo -e "${GREEN}✓ $AI_COUNT AI provider(s) configured${NC}"
fi

echo ""
echo "--- GPU Provider Variables (at least one required) ---"
GPU_COUNT=0
for var in "${GPU_VARS[@]}"; do
  value="${!var}"
  if [ -n "$value" ] && [[ ! "$value" =~ ^test-mock ]] && [[ ! "$value" =~ ^sk-or ]]; then
    GPU_COUNT=$((GPU_COUNT + 1))
  fi
done
if [ $GPU_COUNT -eq 0 ]; then
  echo -e "${YELLOW}⚠ WARNING: No GPU provider configured (optional for CPU-only mode)${NC}"
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "${GREEN}✓ $GPU_COUNT GPU provider(s) configured${NC}"
fi

echo ""
echo "--- Secret Variables ---"
for var in "${SECRET_VARS[@]}"; do
  value="${!var}"
  if [ -z "$value" ]; then
    echo -e "${RED}✗ ERROR: $var is not set${NC}"
    ERRORS=$((ERRORS + 1))
  elif [[ "$value" =~ "min-32-char" ]] || [[ "$value" =~ "placeholder" ]] || [[ "$value" =~ "change-me" ]]; then
    echo -e "${RED}✗ ERROR: $var still contains placeholder value${NC}"
    ERRORS=$((ERRORS + 1))
  elif [ ${#value} -lt 32 ]; then
    echo -e "${RED}✗ ERROR: $var must be at least 32 characters (currently ${#value})${NC}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "${GREEN}✓ $var is set (${#value} chars)${NC}"
  fi
done

echo ""
echo "--- Security Checks ---"

# Check CORS
CORS="${CORS_ORIGINS:-}"
if [ "$CORS" = "*" ]; then
  ENV_TYPE="${NODE_ENV:-development}"
  if [ "$ENV_TYPE" = "production" ]; then
    echo -e "${RED}✗ ERROR: CORS_ORIGINS='*' in production is a security risk${NC}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "${YELLOW}⚠ WARNING: CORS_ORIGINS='*' (acceptable for development, restrict for production)${NC}"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# Check NODE_ENV
if [ -z "$NODE_ENV" ]; then
  echo -e "${YELLOW}⚠ WARNING: NODE_ENV not set (defaulting to 'production')${NC}"
  WARNINGS=$((WARNINGS + 1))
elif [ "$NODE_ENV" != "production" ] && [ "$NODE_ENV" != "test" ] && [ "$NODE_ENV" != "development" ]; then
  echo -e "${RED}✗ ERROR: NODE_ENV must be 'production', 'test', or 'development' (got: $NODE_ENV)${NC}"
  ERRORS=$((ERRORS + 1))
fi

# Check PORT
if [ -n "$PORT" ]; then
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo -e "${RED}✗ ERROR: PORT must be a number between 1-65535 (got: $PORT)${NC}"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""
echo "======================================"
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}✗ FAILED: $ERRORS error(s), $WARNINGS warning(s)${NC}"
  echo "Fix errors before deploying"
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}⚠ PASSED with $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${GREEN}✓ ALL CHECKS PASSED${NC}"
  exit 0
fi
