# Telegram Insights

Самостоятельный приватный продукт для архива личного Telegram, поиска,
ответов по нескольким перепискам и регулярных сводок. Основное хранилище
Telegram Insights — PostgreSQL. По умолчанию он загружает доступную историю
всех облачных чатов за последние 14 суток, начиная с самых новых сообщений.

## Текущий этап

Реализована первая версия по [PRD](docs/prd.md): Node.js CLI
`telegram-insights` (клиент mtcute, перенесённый из tgcli с историей Git),
архив PostgreSQL, отдельный индекс pgvector, поиск, ответы и локальный
черновик [ежедневной сводки](docs/daily-digest.md). Эксплуатация —
[docs/operations.md](docs/operations.md), архитектура —
[docs/architecture.md](docs/architecture.md).

Проверка: `npm test` (нужен Docker; тесты поднимают PostgreSQL 17 + pgvector и
работают только с синтетическими сообщениями).

## Границы

| Владелец | Ответственность |
| --- | --- |
| Этот репозиторий | Telegram-клиент, PostgreSQL-архив, индексация, поиск, ответы и сводки |
| `~/code/tgcli` | Действующее отдельное приложение с SQLite-архивом |
| `~/code/brandymint/infra` | PostgreSQL, pgvector, доступ и резервирование |
| `~/code/personal-ops` | Реестр и состояние фоновых заданий |

Следующие шаги и условия готовности записаны в [backlog](backlog.md).
