#!/bin/bash
#
# Install the ai-gateway CLI globally.
#
# Usage:
#   ./scripts/install-cli.sh                    # install via bun link
#   ./scripts/install-cli.sh --symlink          # install via symlink to /usr/local/bin
#   ./scripts/install-cli.sh --uninstall        # remove the CLI
#
# After installation:
#   ai-gateway help
#   ai-gateway health
#   ai-gateway chat "Hello"
#
# Environment variables (set in ~/.zshrc or ~/.bashrc):
#   export AI_GATEWAY_URL=https://parle-ai-gateway.fly.dev
#   export AI_GATEWAY_KEY=your-api-key
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CLI_PATH="$REPO_DIR/bin/ai-gateway.ts"

if [ "$1" = "--uninstall" ]; then
  echo "Removing ai-gateway CLI..."
  rm -f /usr/local/bin/ai-gateway 2>/dev/null || true
  cd "$REPO_DIR" && bun unlink 2>/dev/null || true
  echo "Done."
  exit 0
fi

# Check bun is installed
if ! command -v bun &>/dev/null; then
  echo "Error: bun is required. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

chmod +x "$CLI_PATH"

if [ "$1" = "--symlink" ]; then
  # Symlink method — works without bun link
  echo "Installing ai-gateway CLI via symlink..."

  # Create a wrapper script that calls bun
  cat > /usr/local/bin/ai-gateway <<WRAPPER
#!/bin/bash
exec bun "$CLI_PATH" "\$@"
WRAPPER
  chmod +x /usr/local/bin/ai-gateway
  echo "Installed: /usr/local/bin/ai-gateway"
else
  # bun link method — registers in bun's global bin
  echo "Installing ai-gateway CLI via bun link..."
  cd "$REPO_DIR"
  bun link
  echo "Linked via bun."
fi

echo ""
echo "Verify: ai-gateway help"
echo ""
echo "Configure (add to ~/.zshrc):"
echo "  export AI_GATEWAY_URL=https://parle-ai-gateway.fly.dev"
echo "  export AI_GATEWAY_KEY=your-api-key"
