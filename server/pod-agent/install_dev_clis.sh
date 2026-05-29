#!/usr/bin/env bash
# install_dev_clis.sh — install agentic-coding CLIs INSIDE a GPU pod so you can
# SSH in and drive Claude Code / OpenCode on the box itself (fix training, etc.).
#
# Provisioned + invoked by the ai-gateway pod-agent (install.sh) when the gateway
# sets AIGW_DEV_CLIS. Opt-in so training-only pods stay lean. Always non-fatal —
# a failed CLI install must never block the GPU job.
#
# Selection (env AIGW_DEV_CLIS, csv): "claude" | "opencode" | "claude,opencode"
#                                     | "all" | "1"  (last two = both)
# Auth (passed by provisioner into the pod env):
#   ANTHROPIC_API_KEY   — Claude Code headless auth
#   OPENCODE_API_KEY / provider keys — OpenCode auth (optional)
#
# Usage:
#   AIGW_DEV_CLIS=claude,opencode bash install_dev_clis.sh
#   AIGW_DEV_CLIS=all            bash install_dev_clis.sh --dry-run   # plan only, no install
#
# --dry-run prints the parsed plan + the commands it WOULD run, installs nothing.
set -uo pipefail

WANT="${1:-${AIGW_DEV_CLIS:-}}"
DRYRUN=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRYRUN=1 ;;
  esac
done
# If $1 was the flag, fall back to env for the selection.
case "$WANT" in --dry-run|-n) WANT="${AIGW_DEV_CLIS:-}" ;; esac

log() { echo "[devcli] $*"; }

if [ -z "$WANT" ]; then
  log "AIGW_DEV_CLIS unset — nothing to install"
  exit 0
fi

# ── Parse selection ──────────────────────────────────────────────────────────
want_claude=0
want_opencode=0
case ",$WANT," in
  *,all,*|*,1,*) want_claude=1; want_opencode=1 ;;
  *)
    case ",$WANT," in *,claude,*) want_claude=1 ;; esac
    case ",$WANT," in *,opencode,*) want_opencode=1 ;; esac
    ;;
esac
log "plan: claude=$want_claude opencode=$want_opencode (from AIGW_DEV_CLIS='$WANT')"

if [ "$want_claude" = 0 ] && [ "$want_opencode" = 0 ]; then
  log "no recognized CLI in selection — nothing to do"
  exit 0
fi

run() {
  if [ "$DRYRUN" = 1 ]; then echo "[devcli][dry-run] $*"; return 0; fi
  eval "$@"
}

# ── Claude Code (needs Node 20) ──────────────────────────────────────────────
if [ "$want_claude" = 1 ]; then
  if ! command -v node >/dev/null 2>&1; then
    log "node missing — installing Node 20"
    if command -v apt-get >/dev/null 2>&1; then
      run "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -" || log "nodesource setup failed (non-fatal)"
      run "DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs" || log "node apt install failed (non-fatal)"
    else
      log "no apt-get — cannot auto-install node; skipping claude-code"
    fi
  fi
  if [ "$DRYRUN" = 1 ] || command -v npm >/dev/null 2>&1; then
    log "installing @anthropic-ai/claude-code"
    run "npm install -g @anthropic-ai/claude-code" || log "claude-code install failed (non-fatal)"
    [ "$DRYRUN" = 1 ] || log "claude: $(command -v claude 2>/dev/null || echo MISSING)"
    [ -n "${ANTHROPIC_API_KEY:-}" ] && log "ANTHROPIC_API_KEY present (headless auth ok)" || log "WARN: ANTHROPIC_API_KEY not set — claude will need interactive login"
  else
    log "npm unavailable — claude-code skipped"
  fi
fi

# ── OpenCode (standalone installer, no node needed) ──────────────────────────
if [ "$want_opencode" = 1 ]; then
  log "installing opencode"
  run "curl -fsSL https://opencode.ai/install | bash" || log "opencode install failed (non-fatal)"
  # Persist PATH for future interactive ssh sessions.
  if [ "$DRYRUN" = 1 ]; then
    echo "[devcli][dry-run] add \$HOME/.opencode/bin to PATH in ~/.bashrc"
  else
    export PATH="$HOME/.opencode/bin:$PATH"
    if ! grep -q '.opencode/bin' "$HOME/.bashrc" 2>/dev/null; then
      echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> "$HOME/.bashrc"
    fi
    log "opencode: $(command -v opencode 2>/dev/null || echo MISSING)"
  fi
fi

log "done (dry-run=$DRYRUN)"
exit 0
