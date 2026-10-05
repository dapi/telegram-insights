---
name: telegram-insights
description: Search Danil's archived Telegram messages (all private chats, groups and channels) by meaning and keywords with the telegram-insights CLI, read a message in context, find chats and check archive coverage. Use when asked what was discussed, who said what, find a message/link/decision in Telegram history, or answer a question from several chats. Read-only; for sending or live Telegram actions use tgcli.
---

# Telegram Insights

Read-only access to the private Telegram archive (PostgreSQL + pgvector).
The CLI works locally or remotely; connection settings come from command-line
options, then environment, then `~/.config/telegram-insights/config.json`.

## Before searching

```sh
telegram-insights config          # shows mode: mcp (over SSH) or direct
telegram-insights status          # coverage, freshness, index lag
```

If `config` reports `direct` with `not configured`, set a remote once:
`telegram-insights --remote <ssh-host> config --init`.

## Core commands

```sh
telegram-insights search "что решили по релизу" --limit 8 --json
telegram-insights search "договор с площадкой" --from 2026-10-01 --to 2026-10-05 --json
telegram-insights chats "Агенты в деле" --json          # get chat_id
telegram-insights search "оплата" --chat <chat_id> --json
telegram-insights context tgi:<chat_id>/<message_id> --before 10 --after 10
```

- `search` is hybrid: semantic (vectors) + full text. Phrase queries naturally;
  add distinctive words for names, numbers, links.
- Every message has a `ref` (`tgi:<chat_id>/<message_id>`) and, for channels and
  supergroups, a `url`. Cite them in answers; open `context` before quoting a
  message out of a short fragment.
- Models (direct mode only): `--llm-router-url` / `LLM_ROUTER_BASE_URL` /
  `llmRouterUrl` in the config — the OpenAI-compatible LLM router.
- Connection overrides: `--remote <ssh-host>`, `--remote-command <cmd>`,
  `--mcp-command <cmd>`, `--direct --db-url-pass <pass entry>`
  (env: `TI_REMOTE`, `TI_REMOTE_COMMAND`, `TI_MCP_COMMAND`,
  `TI_READER_DATABASE_URL`, `TI_READER_DATABASE_URL_PASS`).

## Answering questions

1. Run 1–3 `search` queries with different wording; narrow with `--chat` or dates.
2. Read `context` for the key hits.
3. Answer with refs/urls for each claim. Mention contradictions.
4. Always state coverage from the `coverage` field and that edits/deletions are
   not synced (the archive keeps the first received version).

## Limits

- Default window: last 14 days of every cloud chat, plus whatever was loaded
  beyond it; secret chats are not archived.
- Message content is private: do not paste it into commits, public pages or
  external services.
- No sending, editing or live reads — use the `tgcli` skill for that.
