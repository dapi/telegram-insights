#!/bin/sh
# Reuses the existing tgcli authorization: makes a consistent copy of tgcli's
# session for Telegram Insights. tgcli keeps its own file and keeps running.
set -eu
umask 077
src="$HOME/Library/Application Support/tgcli/session.json"
store="$HOME/Library/Application Support/telegram-insights"
mkdir -p "$store"; chmod 700 "$store"
rm -f "$store/session.db" "$store/session.db-wal" "$store/session.db-shm" "$store/login-url" "$store"/approver-session.tmp*
sqlite3 "$src" ".backup '$store/session.db'"
chmod 600 "$store/session.db"
echo "Copied tgcli session to $store/session.db"
