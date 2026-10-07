# Эксплуатация

Конкретное развёртывание (хост, адреса, решения об авторизации и журнал
проверок) описано в runbook `telegram-insights` инфраструктурного
репозитория, состояние фоновых заданий — в реестре launchd Personal OS. Здесь —
только то, что не зависит от хоста.

## Состав службы

| Что | Где |
| --- | --- |
| Архиватор и индексатор | `telegram-insights run`, LaunchAgent `com.dapi.telegram-insights` |
| Черновик сводки | `telegram-insights digest --skip-existing`, LaunchAgent `com.dapi.telegram-insights.digest` (07:30) |
| Архив и индекс | PostgreSQL с pgvector, БД `telegram_insights`, роли `owner`/`archiver`/`indexer`/`reader` |
| Сессия и черновики | `TELEGRAM_INSIGHTS_STORE` (по умолчанию `~/Library/Application Support/telegram-insights` на macOS, `~/.local/share/telegram-insights` на Linux), права 0700/0600 |
| Логи службы | `log/` в checkout (в Git не попадают; только счётчики и коды ошибок) |

## Запуск на хосте службы

`ops/telegram-insights-with-pass` читает пароли ролей из `pass`
(`telegram-insights/postgres/{owner,archiver,indexer,reader}-password`) в
момент запуска, а несекретные настройки хоста — из файла вне репозитория
`~/.config/telegram-insights/service.env` (путь меняет
`TELEGRAM_INSIGHTS_SERVICE_ENV`):

```sh
TI_PG_HOST=<postgres host>                # либо локальный TI_PG_SOCKET_DIR=/run/postgresql
TI_PG_DATABASE=telegram_insights          # необязательное имя БД
TI_PG_PASS_PREFIX=telegram-insights/postgres
TELEGRAM_API_ID=<app id>                  # для отдельной сессии без tgcli
TELEGRAM_API_HASH_PASS=<pass entry>       # API hash для отдельной сессии
TELEGRAM_PROXY=socks5://<host>:<port>     # если Telegram доступен только через прокси
TELEGRAM_PROXY_URL_PASS=<pass entry>      # если URL прокси содержит пароль
LLM_ROUTER_BASE_URL=http://<router>/v1    # embeddings и ответы
```

При заданных `TELEGRAM_API_ID` и `TELEGRAM_API_HASH_PASS` launcher использует
отдельное приложение Telegram. Иначе API app для `run`/`login` берётся из
конфигурации tgcli, если сессия является
копией его авторизации (`scripts/copy-tgcli-session.sh`, согласованная копия
через `sqlite3 .backup`). Оба клиента тогда используют один ключ авторизации;
при `AUTH_KEY_DUPLICATED` или `AUTH_KEY_UNREGISTERED` в логах любой из служб
остановить Telegram Insights. Альтернатива — отдельная сессия: `login
--qr-file` и подтверждение `scripts/approve-login-with-session.js`; аккаунт с
облачным паролем потребует `--password-pass <entry>`.

```sh
ops/telegram-insights-with-pass migrate
scripts/copy-tgcli-session.sh                       # один раз
scripts/install-launchagent.sh                      # архиватор
scripts/install-launchagent.sh com.dapi.telegram-insights.digest
ops/telegram-insights-with-pass status              # сводка покрытия
ops/telegram-insights-with-pass status --chats      # по каждому чату
ops/telegram-insights-with-pass status --check      # код 2, если сигнал старше 10 минут
ops/telegram-insights-with-pass doctor
ops/telegram-insights-with-pass digest --date 2026-10-04
```

Шаблоны `ops/launchd/*.plist.in` содержат `@REPO@`; установщик подставляет
путь текущего checkout. Черновик сводки никуда не отправляется и готовый файл
не перезаписывает. Включение расписаний — решение владельца эксплуатации, а не
побочный эффект разработки.

## Поведение и настройки

- При первом запуске служба сначала подключает приём новых сообщений, затем
  получает все диалоги (включая архивные) и для каждого создаёт задачу на окно
  `TI_WINDOW_DAYS` (14). Для окна в целых календарных месяцах задайте
  `TI_WINDOW_MONTHS`; оно имеет приоритет над днями, а сообщения старше границы
  из последней страницы не сохраняются. Страницы идут от новых к старым; следующий чат
  выбирается по давности последнего обслуживания (round-robin).
- Раз в `TI_DIALOGS_INTERVAL_MINUTES` (30) диалоги перечитываются: новые чаты
  получают задачу, а чаты, где верх истории ушёл дальше проверенного, —
  сверку сверху до проверенной границы.
- Темп: интервал между запросами истории от `TI_MIN_INTERVAL_MS` (1500), старт
  `TI_INITIAL_INTERVAL_MS` (3000), потолок `TI_MAX_REQUESTS_PER_HOUR` (1200).
  На `FLOOD_WAIT_X` пауза не меньше X секунд плюс jitter, интервал удваивается
  (до `TI_MAX_INTERVAL_MS`), затем медленно восстанавливается. Пауза хранится в
  БД и переживает перезапуск. Эти значения — стартовые, а не «безопасные».
- Исключённые чаты не загружаются и не индексируются. Всегда исключены
  служебные аккаунты Telegram с секретами: «Telegram» (777000, коды входа),
  «Verification Codes» (489000, одноразовые коды сервисов), BotFather
  (93372553, токены ботов). Свои исключения — `TI_EXCLUDED_CHATS` (ID через
  запятую, например в `service.env`). Исключение действует со следующей сверки
  диалогов (при старте и раз в 30 минут); уже сохранённое удаляет
  `ops/telegram-insights-with-pass purge-excluded` (роль owner).
- Один архиватор на аккаунт: advisory lock PostgreSQL. Второй экземпляр не
  стартует; при потере соединения служба завершается, launchd её перезапускает.
- Адрес router не зашит в код: `LLM_ROUTER_BASE_URL`, `llmRouterUrl` в
  `~/.config/telegram-insights/config.json` или `--llm-router-url`;
  `LLM_ROUTER_API_KEY` необязателен. Aliases меняются `TI_EMBED_MODEL` и
  `TI_LLM_MODEL`. При смене embedding-модели индексатор сам пересчитывает
  векторы, а поиск по смыслу сравнивает только векторы текущей модели.
- Для `TI_MODEL_PROVIDER=ollama` адрес вне loopback запрещён без
  `TI_APPROVED_MODEL_HOSTS`.

## Откат

`scripts/uninstall-launchagent.sh [label]` останавливает службу; сессия,
архив и логи сохраняются. Действующий tgcli от службы не зависит.

## MCP

`telegram-insights mcp` — read-only MCP (stdio, роль `reader`): `search_messages`
(гибридный поиск pgvector + полнотекстовый, фильтры по чату и датам),
`get_message_context`, `find_chats`, `archive_status`. Запросы
векторизуются той же моделью, что и индекс.

Подключение с другого компьютера (Claude Code, уровень user):

```sh
claude mcp add telegram-insights -s user -- ssh -o BatchMode=yes <ssh-host> \
  <checkout>/ops/telegram-insights-with-pass mcp
```

## CLI и skill без MCP

`scripts/install-cli.sh [ssh-host]` ставит `~/.local/bin/telegram-insights`,
при указанном хосте создаёт `~/.config/telegram-insights/config.json`
(`{"remote": "<ssh-host>"}`), если его нет, и устанавливает skill `telegram-insights` (`skills/telegram-insights`).

Команды чтения `search`, `context`, `chats`, `status` работают в двух режимах:

- **mcp** — запускают MCP-сервер по SSH (`--remote`, `TI_REMOTE`, `remote`; на хосте
  выполняется `remoteCommand`, по умолчанию `telegram-insights mcp`, — для
  обёртки с `pass` укажите `<checkout>/ops/telegram-insights-with-pass mcp`) или
  любую команду (`--mcp-command`, `TI_MCP_COMMAND`, `mcpCommand`);
- **direct** — PostgreSQL роли reader (`--db-url`, `TI_READER_DATABASE_URL`,
  `--db-url-pass`/`databaseUrlPass` — запись `pass`) и Ollama для векторизации запроса.

Приоритет: аргументы → env → конфиг пользователя (`TELEGRAM_INSIGHTS_CONFIG`
меняет путь) → значения по умолчанию. Пароли в конфиг не пишутся.
`telegram-insights config` показывает выбранный режим без секретов.
