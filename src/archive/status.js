// Coverage report built only from technical metadata (no message text).

const DAY_MS = 86_400_000;

export const STATE_LABELS = {
  loaded: 'загружено',
  loading: 'загружается',
  rate_limited: 'ожидание лимита',
  error: 'ошибка',
  unavailable: 'недоступно',
  not_checked: 'не проверено',
  excluded: 'исключено',
  left: 'нет в диалогах',
};

export async function resolveAccountId(pool, accountId = null) {
  if (accountId) return String(accountId);
  const { rows } = await pool.query('SELECT account_id FROM archive.accounts ORDER BY created_at LIMIT 2');
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error('Several accounts are archived; pass --account');
  return rows[0].account_id;
}

export async function coverageReport(pool, { accountId, windowDays = 14, now = new Date(), staleAfterMs = 2 * 3_600_000 } = {}) {
  const account = await resolveAccountId(pool, accountId);
  if (!account) return { account: null, chats: [], summary: null };
  const windowFrom = new Date(now.getTime() - windowDays * DAY_MS);
  const { rows: chats } = await pool.query(
    `SELECT c.chat_id, c.peer_kind, c.title, c.username, c.in_dialogs, c.excluded, c.top_message_id, c.dialog_rank,
            s.state, s.window_start, s.backfill_done, s.covered_from, s.covered_max_id, s.history_exhausted,
            s.gap_min_id IS NOT NULL AS gap_pending, s.pages_fetched, s.messages_fetched, s.last_page_at,
            s.last_reconciled_at, s.flood_wait_until, s.error_code, s.error_count, s.next_attempt_at,
            (SELECT count(*) FROM archive.messages m WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id) AS archived,
            (SELECT max(sent_at) FROM archive.messages m WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id) AS newest_at
     FROM archive.chats c LEFT JOIN archive.chat_sync s USING (account_id, chat_id)
     WHERE c.account_id = $1
     ORDER BY c.dialog_rank NULLS LAST, c.chat_id`,
    [account],
  );
  const report = chats.map((row) => {
    let state = row.state ?? 'not_checked';
    if (!row.in_dialogs) state = 'left';
    if (row.excluded) state = 'excluded';
    const coveredFrom = row.covered_from ? new Date(row.covered_from) : null;
    const windowCovered = Boolean(row.backfill_done && (row.history_exhausted || (coveredFrom && coveredFrom <= windowFrom)
      || (coveredFrom && coveredFrom <= new Date(row.window_start))));
    const reconciledAt = row.last_reconciled_at ? new Date(row.last_reconciled_at) : null;
    return {
      chatId: row.chat_id,
      kind: row.peer_kind,
      title: row.title,
      username: row.username,
      state,
      stateLabel: STATE_LABELS[state] ?? state,
      windowCovered,
      coveredFrom: coveredFrom?.toISOString() ?? null,
      historyExhausted: row.history_exhausted ?? false,
      verifiedTo: reconciledAt?.toISOString() ?? null,
      stale: Boolean(windowCovered && (!reconciledAt || now - reconciledAt > staleAfterMs)),
      gapPending: row.gap_pending ?? false,
      pages: row.pages_fetched ?? 0,
      archived: Number(row.archived),
      newestAt: row.newest_at ? new Date(row.newest_at).toISOString() : null,
      floodWaitUntil: row.flood_wait_until ? new Date(row.flood_wait_until).toISOString() : null,
      errorCode: row.error_code,
      errorCount: row.error_count ?? 0,
      nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    };
  });

  const active = report.filter((c) => c.state !== 'left' && c.state !== 'excluded');
  const byState = {};
  for (const c of report) byState[c.state] = (byState[c.state] ?? 0) + 1;
  const byKind = {};
  for (const c of active) {
    byKind[c.kind] ??= { total: 0, covered: 0 };
    byKind[c.kind].total += 1;
    if (c.windowCovered) byKind[c.kind].covered += 1;
  }
  const unavailable = active.filter((c) => c.state === 'unavailable').length;
  const available = active.length - unavailable;
  const covered = active.filter((c) => c.windowCovered && c.state !== 'unavailable').length;
  const { rows: [counts] } = await pool.query(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE sent_at >= $2) AS in_window,
            count(*) FILTER (WHERE source = 'live') AS live,
            max(archive_seq) AS max_seq,
            min(sent_at) AS oldest_at,
            max(sent_at) AS newest_at
     FROM archive.messages WHERE account_id = $1`,
    [account, windowFrom],
  );
  const runtime = {};
  const { rows: runtimeRows } = await pool.query(
    'SELECT key, value, updated_at FROM archive.runtime_state WHERE account_id = $1',
    [account],
  );
  for (const row of runtimeRows) runtime[row.key] = { ...row.value, updatedAt: row.updated_at };
  let indexer = null;
  try {
    const { rows: [cursor] } = await pool.query(
      `SELECT c.last_seq, c.updated_at,
              (SELECT count(*) FROM search.chunks WHERE account_id = $1) AS chunks,
              (SELECT count(*) FROM search.chunks WHERE account_id = $1 AND embedding IS NULL) AS pending_embeddings
       FROM search.cursor c JOIN archive.accounts a ON a.account_id = c.account_id AND a.generation = c.generation
       WHERE c.account_id = $1`,
      [account],
    );
    indexer = cursor
      ? {
        lastSeq: Number(cursor.last_seq),
        lag: Math.max(0, Number(counts.max_seq ?? 0) - Number(cursor.last_seq)),
        chunks: Number(cursor.chunks),
        pendingEmbeddings: Number(cursor.pending_embeddings),
        updatedAt: cursor.updated_at,
      }
      : { lastSeq: 0, lag: Number(counts.max_seq ?? 0), chunks: 0, pendingEmbeddings: 0, updatedAt: null };
  } catch {
    indexer = null;
  }

  const limiter = runtime.limiter ?? null;
  const pausedUntil = limiter?.pausedUntil && limiter.pausedUntil > now.getTime() ? new Date(limiter.pausedUntil).toISOString() : null;
  const summary = {
    account,
    windowDays,
    windowFrom: windowFrom.toISOString(),
    chats: {
      total: active.length,
      available,
      covered,
      coveredShare: available ? covered / available : 0,
      unavailable,
      byState,
      byKind,
      gapPending: active.filter((c) => c.gapPending).length,
      stale: active.filter((c) => c.stale).length,
      left: byState.left ?? 0,
      excluded: byState.excluded ?? 0,
    },
    messages: {
      total: Number(counts.total),
      inWindow: Number(counts.in_window),
      live: Number(counts.live),
      maxSeq: Number(counts.max_seq ?? 0),
      oldestAt: counts.oldest_at ? new Date(counts.oldest_at).toISOString() : null,
      newestAt: counts.newest_at ? new Date(counts.newest_at).toISOString() : null,
    },
    complete: available > 0 && covered === available,
    rateLimit: { pausedUntil, intervalMs: limiter?.intervalMs ?? null, floodCount: limiter?.floodCount ?? 0, lastFlood: limiter?.lastFlood ?? null },
    heartbeat: runtime.heartbeat ? { at: runtime.heartbeat.at, stats: runtime.heartbeat.stats } : null,
    indexer,
    limitations: [
      'Правки и удаления сообщений в v1 не синхронизируются: архив хранит первую полученную версию.',
      'Секретные чаты не входят в облачную историю и не архивируются.',
    ],
  };
  return { account, chats: report, summary };
}

// One-line coverage note for search answers and digests.
export function coverageNote(summary) {
  if (!summary) return 'Покрытие неизвестно: архив ещё не инициализирован.';
  const c = summary.chats;
  const pct = Math.round(c.coveredShare * 1000) / 10;
  const parts = [`окно ${summary.windowDays} сут.: покрыто ${c.covered} из ${c.available} доступных чатов (${pct}%)`];
  if (c.unavailable) parts.push(`недоступно ${c.unavailable}`);
  if (c.byState.loading) parts.push(`загружается ${c.byState.loading}`);
  if (c.byState.not_checked) parts.push(`не проверено ${c.byState.not_checked}`);
  if (c.byState.error) parts.push(`с ошибкой ${c.byState.error}`);
  if (c.byState.rate_limited || summary.rateLimit.pausedUntil) parts.push('есть ожидание лимита Telegram');
  if (summary.indexer?.lag) parts.push(`индекс отстаёт на ${summary.indexer.lag} записей архива`);
  return `${summary.complete ? 'Покрытие полное' : 'Покрытие неполное'}: ${parts.join('; ')}.`;
}
