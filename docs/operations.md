# Эксплуатация

## Где работает

| Что | Где |
| --- | --- |
| Служба `telegram-insights run` | LaunchAgent `com.dapi.telegram-insights` на `office3`; реестр — `~/code/personal-ops/launchd/registry.json` |
| Архив и индекс | БД `telegram_insights` на общем PostgreSQL `office` (192.168.88.10); runbook — `~/code/brandymint/infra/docs/runbooks/telegram-insights.md` |
| Сессия Telegram | `~/Library/Application Support/telegram-insights/session.db` на office3 — копия авторизации tgcli (решение Данила 2026-10-05), отдельный файл и состояние обновлений |
| Модели | локальный Ollama на office3: `qwen3-embedding:0.6b` (1024), `qwen3:8b` |
| Черновики сводок | `~/Library/Application Support/telegram-insights/digests/`, права 0600 |
| Логи службы | `~/code/telegram-insights/log/` (в Git не попадают; только счётчики и коды ошибок) |

Секреты читает `ops/office3/telegram-insights-with-pass` в момент запуска:
пароли БД — из `pass` (`telegram-insights/postgres/{owner,archiver,indexer,reader}-password`),
API app — из конфигурации tgcli, потому что сессия является копией его
авторизации.

Авторизация: `scripts/office3-copy-tgcli-session.sh` делает согласованную
копию `session.json` tgcli (`sqlite3 .backup`). Отдельного входа и кода не
требуется. Оба клиента используют один ключ авторизации с одного IP; если в
логах любой из служб появится `AUTH_KEY_DUPLICATED` или `AUTH_KEY_UNREGISTERED`,
остановить Telegram Insights и сообщить Данилу. Альтернатива — отдельная сессия:
`login --qr-file` и подтверждение `scripts/approve-login-with-session.js` из
копии сессии tgcli; аккаунт с облачным паролем тогда потребует
`--password-pass <entry>`.
Telegram доступен через SOCKS `office` (как у tgcli).

## Команды на office3

```sh
cd ~/code/telegram-insights
ops/office3/telegram-insights-with-pass migrate
scripts/office3-copy-tgcli-session.sh                     # один раз, авторизация tgcli
scripts/install-office3-launchagent.sh
ops/office3/telegram-insights-with-pass status            # сводка покрытия
ops/office3/telegram-insights-with-pass status --chats    # по каждому чату
ops/office3/telegram-insights-with-pass doctor
ops/office3/telegram-insights-with-pass search "запрос"
ops/office3/telegram-insights-with-pass ask "вопрос"
ops/office3/telegram-insights-with-pass digest --date 2026-10-04
~/code/personal-ops/scripts/personalctl launchd status
```

Ежедневный черновик (временно, только на период тестирования — решение Данила
2026-10-05; после тестирования выключить `scripts/uninstall-office3-launchagent.sh
com.dapi.telegram-insights.digest` и перевести реестр в `absent`): LaunchAgent
`com.dapi.telegram-insights.digest` в 07:30
МСК пишет сводку за прошлые сутки в каталог черновиков (`digest --skip-existing`;
готовый черновик не перезаписывается). Отправка никуда не выполняется.
Установка: `scripts/install-office3-launchagent.sh com.dapi.telegram-insights.digest`.
Проверка службы: `status --check` (код 2, если сигнал старше 10 минут).

## Поведение и настройки

- При первом запуске служба сначала подключает приём новых сообщений, затем
  получает все диалоги (включая архивные) и для каждого создаёт задачу на окно
  `TI_WINDOW_DAYS` (14). Страницы идут от новых к старым; следующий чат
  выбирается по давности последнего обслуживания (round-robin).
- Раз в `TI_DIALOGS_INTERVAL_MINUTES` (30) диалоги перечитываются: новые чаты
  получают задачу, а чаты, где верх истории ушёл дальше проверенного, —
  сверку сверху до проверенной границы.
- Темп: интервал между запросами истории от `TI_MIN_INTERVAL_MS` (1500), старт
  `TI_INITIAL_INTERVAL_MS` (3000), потолок `TI_MAX_REQUESTS_PER_HOUR` (1200).
  На `FLOOD_WAIT_X` пауза не меньше X секунд плюс jitter, интервал удваивается
  (до `TI_MAX_INTERVAL_MS`), затем медленно восстанавливается. Пауза хранится в
  БД и переживает перезапуск. Эти значения — стартовые, а не «безопасные».
- Один архиватор на аккаунт: advisory lock PostgreSQL. Второй экземпляр не
  стартует; при потере соединения служба завершается, launchd её перезапускает.
- Модель вне loopback запрещена без `TI_APPROVED_MODEL_HOSTS` (явное согласие).

## Откат

`scripts/uninstall-office3-launchagent.sh` останавливает службу; сессия,
архив и логи сохраняются. Действующий tgcli от службы не зависит.

## Проверка запуска 2026-10-05 (только метаданные)

- 15:13 МСК: 2157 чатов; окно 14 суток покрыто для 2156 из 2156 доступных;
  1 личный чат недоступен (`PEER_ID_INVALID`). 71 906 сообщений в архиве,
  индекс без отставания. FLOOD_WAIT не было; интервал 1,5 с.
- Восстановление после `kill -9`: launchd перезапустил службу, загрузка
  продолжилась с checkpoint.
- Найдено и исправлено при запуске: дубль чата в списке диалогов (SQLSTATE
  21000) и зависший запрос истории (добавлен таймаут 90 с). Ошибки
  «Peer is not found in local cache» в личных чатах ушли при повторе.
- Поиск и черновик сводки на реальном архиве отработали; содержимое не
  просматривалось.

## MCP

`telegram-insights mcp` — read-only MCP (stdio, роль `reader`): `search_messages`
(гибридный поиск pgvector + полнотекстовый, фильтры по чату и датам),
`get_message_context`, `find_chats`, `archive_status`. Запросы
векторизуются локальной моделью на office3.

Подключение с MacBook (Claude Code, уровень user):

```sh
claude mcp add telegram-insights -s user -- ssh -o BatchMode=yes office3 \
  ~/code/telegram-insights/ops/office3/telegram-insights-with-pass mcp
```
