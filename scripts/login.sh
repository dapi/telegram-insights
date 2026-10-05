#!/bin/sh
# Interactive one-time login of the separate Telegram Insights session on the service host.
# Takes the account phone number from the existing tgcli config without printing it.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TELEGRAM_PHONE_NUMBER="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/Library/Application Support/tgcli/config.json")))["phoneNumber"])')"
export TELEGRAM_PHONE_NUMBER
exec "$repo/ops/telegram-insights-with-pass" login "$@"
