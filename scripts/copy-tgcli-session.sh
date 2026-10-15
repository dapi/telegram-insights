#!/bin/sh
# Make a consistent, owner-only copy of tgcli's existing MTProto authorization.
# The source stays in place; this command never connects to Telegram or imports chats.
set -eu
umask 077

if [ -z "${TI_TGCLI_STORE:-}" ]; then
  case "$(uname -s)" in
    Darwin) TI_TGCLI_STORE="$HOME/Library/Application Support/tgcli" ;;
    *) TI_TGCLI_STORE="${XDG_DATA_HOME:-$HOME/.local/share}/tgcli" ;;
  esac
fi
if [ -z "${TELEGRAM_INSIGHTS_STORE:-}" ]; then
  case "$(uname -s)" in
    Darwin) TELEGRAM_INSIGHTS_STORE="$HOME/Library/Application Support/telegram-insights" ;;
    *) TELEGRAM_INSIGHTS_STORE="${XDG_DATA_HOME:-$HOME/.local/share}/telegram-insights" ;;
  esac
fi

python3 - "$TI_TGCLI_STORE/session.json" "$TELEGRAM_INSIGHTS_STORE/session.db" <<'PY'
import os
import pathlib
import sqlite3
import sys
import tempfile

source, target = map(pathlib.Path, sys.argv[1:])
if not source.is_file():
    raise SystemExit('tgcli session is missing')
if target.exists():
    raise SystemExit('Telegram Insights session already exists; refusing to replace it')
target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
target.parent.chmod(0o700)

temporary = None
try:
    fd, temporary = tempfile.mkstemp(prefix='.session-copy-', dir=target.parent)
    os.close(fd)
    os.chmod(temporary, 0o600)
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src:
        if src.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('tgcli session failed SQLite integrity check')
        with sqlite3.connect(temporary) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Copied session failed SQLite integrity check')
    os.replace(temporary, target)
    temporary = None
finally:
    if temporary is not None:
        pathlib.Path(temporary).unlink(missing_ok=True)

print(f'Copied tgcli authorization to {target}')
PY
