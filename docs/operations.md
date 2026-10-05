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

Расписание сводок и их отправка не включены (см. backlog).

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
