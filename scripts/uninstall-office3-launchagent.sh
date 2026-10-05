#!/bin/sh
# Stops and removes the Telegram Insights LaunchAgent. Keeps the session,
# the PostgreSQL archive and logs intact.
set -eu
label=${1:-com.dapi.telegram-insights}
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"
echo "Removed $label"
