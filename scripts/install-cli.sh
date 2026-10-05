#!/bin/sh
# Installs the telegram-insights CLI from this checkout and its agent skill.
# Usage: scripts/install-cli.sh [ssh-host]   (with a host, writes the user
# config for MCP over SSH when it does not exist yet)
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"
npm install --no-audit --no-fund >/dev/null
mkdir -p "$HOME/.local/bin"
ln -sf "$repo/bin/telegram-insights.js" "$HOME/.local/bin/telegram-insights"
echo "Installed $HOME/.local/bin/telegram-insights -> $repo/bin/telegram-insights.js"
config="${TELEGRAM_INSIGHTS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/telegram-insights/config.json}"
if [ -n "${1:-}" ] && [ ! -f "$config" ]; then
  "$HOME/.local/bin/telegram-insights" --remote "$1" config --init >/dev/null
  echo "Wrote $config (remote $1)"
fi
npx -y skills add "$repo" --skill telegram-insights --agent '*' -g -y
