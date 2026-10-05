#!/bin/sh
# Installs and loads the Telegram Insights LaunchAgent on office3 only.
# Prerequisites: npm ci, `telegram-insights-with-pass migrate`, an authorized
# session (`telegram-insights-with-pass login`). tgcli is not touched.
set -eu

if [ "$(hostname)" != "Danils-iMac-Home" ]; then
  echo "This installer is only for office3" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label=com.dapi.telegram-insights
source_plist="$repo_root/ops/office3/$label.plist"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$repo_root/log"
domain="gui/$(id -u)"
store="$HOME/Library/Application Support/telegram-insights"

if [ ! -f "$store/session.db" ]; then
  echo "No Telegram Insights session in $store; run login first" >&2
  exit 2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
chmod 700 "$log_dir" "$store"
touch "$log_dir/telegram-insights.log" "$log_dir/telegram-insights.error.log"
chmod 600 "$log_dir/telegram-insights.log" "$log_dir/telegram-insights.error.log"
launchctl bootout "$domain/$label" 2>/dev/null || true
cp "$source_plist" "$installed_plist"
chmod 644 "$installed_plist"
launchctl enable "$domain/$label"
if ! launchctl bootstrap "$domain" "$installed_plist" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "$domain" "$installed_plist"
fi
echo "Loaded $label from $installed_plist"
