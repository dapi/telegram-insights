#!/bin/sh
# Installs and loads a Telegram Insights LaunchAgent on the service host.
# Usage: install-launchagent.sh [label]  (default com.dapi.telegram-insights;
# com.dapi.telegram-insights.digest for the daily local digest draft)
# Prerequisites: npm ci, the service env file (see ops/telegram-insights-with-pass),
# `telegram-insights-with-pass migrate`, an authorized session
# (`telegram-insights-with-pass login`). tgcli is not touched.
# The plist template gets the path of this checkout at install time.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label=${1:-com.dapi.telegram-insights}
template="$repo_root/ops/launchd/$label.plist.in"
service_env="${TELEGRAM_INSIGHTS_SERVICE_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/telegram-insights/service.env}"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$repo_root/log"
domain="gui/$(id -u)"
store="$HOME/Library/Application Support/telegram-insights"

if [ ! -f "$template" ]; then
  echo "Unknown label $label: no $template" >&2
  exit 2
fi
if [ ! -f "$service_env" ]; then
  echo "No service env file $service_env; see ops/telegram-insights-with-pass" >&2
  exit 2
fi
if [ ! -f "$store/session.db" ]; then
  echo "No Telegram Insights session in $store; run login first" >&2
  exit 2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
chmod 700 "$log_dir" "$store"
for f in telegram-insights.log telegram-insights.error.log digest.log digest.error.log; do
  touch "$log_dir/$f"; chmod 600 "$log_dir/$f"
done
launchctl bootout "$domain/$label" 2>/dev/null || true
sed "s|@REPO@|$repo_root|g" "$template" > "$installed_plist"
plutil -lint "$installed_plist" >/dev/null
chmod 644 "$installed_plist"
launchctl enable "$domain/$label"
if ! launchctl bootstrap "$domain" "$installed_plist" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "$domain" "$installed_plist"
fi
echo "Loaded $label from $installed_plist"
