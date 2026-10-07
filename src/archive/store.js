import { withTransaction } from '../db.js';
import { archiveWindowStart, withinArchiveWindow } from './window.js';

const SEQ_LOCK_CLASS = 7311;
const DAY_MS = 86_400_000;

// Telegram ids are numbers in JS; PostgreSQL returns bigint as strings.
const num = (value) => (value === null || value === undefined ? null : Number(value));

function clean(value) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '') : value;
}

function messageRows(chatId, messages) {
  return messages.map((m) => ({
    chat_id: String(chatId ?? m.chatId),
    message_id: m.messageId,
    topic_id: m.topicId ?? null,
    sent_at: m.sentAt instanceof Date ? m.sentAt.toISOString() : m.sentAt,
    sender_id: m.senderId ?? null,
    sender_name: clean(m.senderName ?? null),
    sender_username: m.senderUsername ?? null,
    text: clean(m.text ?? ''),
    media_type: m.mediaType ?? null,
    media: m.media ?? null,
    reply_to_id: m.replyToId ?? null,
    forward: m.forward ?? null,
    grouped_id: m.groupedId ?? null,
    is_service: Boolean(m.isService),
  }));
}

export const UNAVAILABLE_CODES = new Set([
  'CHANNEL_PRIVATE',
  'CHANNEL_INVALID',
  'CHANNEL_PUBLIC_GROUP_NA',
  'CHAT_FORBIDDEN',
  'CHAT_ID_INVALID',
  'CHAT_RESTRICTED',
  'PEER_ID_INVALID',
  'USER_BANNED_IN_CHANNEL',
  'INPUT_USER_DEACTIVATED',
]);

// An invalid access hash (a min peer from an update can replace the full one
// in the session cache) is repaired by the next dialogs refresh, so these codes
// become "unavailable" only when they persist.
export const RECOVERABLE_CODES = new Set(['CHANNEL_INVALID', 'PEER_ID_INVALID']);
const RECOVERABLE_ATTEMPTS = 3;
const RECOVERABLE_DELAY_MS = 3_600_000;

export class ArchiveStore {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async ensureAccount(accountId, username = null) {
    const { rows } = await this.pool.query(
      `INSERT INTO archive.accounts (account_id, username) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET username = COALESCE(EXCLUDED.username, archive.accounts.username)
       RETURNING generation`,
      [accountId, username],
    );
    return rows[0].generation;
  }

  async logEvent(accountId, kind, detail = null, chatId = null) {
    await this.pool.query(
      'INSERT INTO archive.events (account_id, chat_id, kind, detail) VALUES ($1, $2, $3, $4)',
      [accountId, chatId, kind, detail],
    );
  }

  async getRuntime(accountId, key) {
    const { rows } = await this.pool.query(
      'SELECT value FROM archive.runtime_state WHERE account_id = $1 AND key = $2',
      [accountId, key],
    );
    return rows[0]?.value ?? null;
  }

  async setRuntime(accountId, key, value) {
    await this.pool.query(
      `INSERT INTO archive.runtime_state (account_id, key, value, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [accountId, key, JSON.stringify(value)],
    );
  }

  // Registers every dialog; new chats get a 14-day (configurable) task anchored at discovery.
  async syncDialogs(accountId, dialogs, { windowDays, windowMonths, excluded = new Set() }) {
    const now = this.now();
    const windowStart = archiveWindowStart(now, { windowDays, windowMonths });
    return withTransaction(this.pool, async (client) => {
      // A dialog can be listed twice (pinned and in the main list); keep the first.
      const unique = [...new Map(dialogs.map((d) => [String(d.chatId), d])).values()]
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      const firstRank = new Map();
      for (const d of dialogs) if (!firstRank.has(String(d.chatId))) firstRank.set(String(d.chatId), d.rank);
      const payload = unique.map((d) => ({
        chat_id: d.chatId,
        peer_kind: d.peerKind,
        title: clean(d.title ?? null),
        username: d.username ?? null,
        is_forum: Boolean(d.isForum),
        dialog_rank: firstRank.get(String(d.chatId)) ?? null,
        top_message_id: d.topMessageId ?? null,
        top_message_at: d.topMessageAt instanceof Date ? d.topMessageAt.toISOString() : (d.topMessageAt ?? null),
        excluded: excluded.has(String(d.chatId)),
        read_inbox_max_id: d.readInboxMaxId ?? null,
        unread_count: d.unreadCount ?? null,
      }));
      const { rows: inserted } = await client.query(
        `INSERT INTO archive.chats AS c (account_id, chat_id, peer_kind, title, username, is_forum, dialog_rank,
                                    top_message_id, top_message_at, in_dialogs, excluded, discovered_at, last_seen_at,
                                    read_inbox_max_id, unread_count, read_state_at)
         SELECT $1, x.chat_id, x.peer_kind, x.title, x.username, x.is_forum, x.dialog_rank,
                x.top_message_id, x.top_message_at, true, x.excluded, $3, $3,
                x.read_inbox_max_id, x.unread_count, CASE WHEN x.read_inbox_max_id IS NULL THEN NULL ELSE $3::timestamptz END
         FROM jsonb_to_recordset($2::jsonb) AS x(chat_id bigint, peer_kind text, title text, username text,
              is_forum boolean, dialog_rank integer, top_message_id bigint, top_message_at timestamptz, excluded boolean,
              read_inbox_max_id bigint, unread_count integer)
         ON CONFLICT (account_id, chat_id) DO UPDATE SET
           peer_kind = EXCLUDED.peer_kind,
           title = EXCLUDED.title,
           username = EXCLUDED.username,
           is_forum = EXCLUDED.is_forum,
           dialog_rank = EXCLUDED.dialog_rank,
           top_message_id = GREATEST(c.top_message_id, EXCLUDED.top_message_id),
           top_message_at = GREATEST(c.top_message_at, EXCLUDED.top_message_at),
           in_dialogs = true,
           excluded = EXCLUDED.excluded,
           last_seen_at = EXCLUDED.last_seen_at,
           read_inbox_max_id = COALESCE(EXCLUDED.read_inbox_max_id, c.read_inbox_max_id),
           unread_count = COALESCE(EXCLUDED.unread_count, c.unread_count),
           read_state_at = COALESCE(EXCLUDED.read_state_at, c.read_state_at)
         RETURNING chat_id, (xmax = 0) AS created`,
        [accountId, JSON.stringify(payload), now.toISOString()],
      );
      const created = inserted.filter((row) => row.created).length;
      await client.query(
        `INSERT INTO archive.chat_sync (account_id, chat_id, window_start, state)
         SELECT c.account_id, c.chat_id, $2, CASE WHEN c.excluded THEN 'excluded' ELSE 'not_checked' END
         FROM archive.chats c WHERE c.account_id = $1
         ON CONFLICT (account_id, chat_id) DO NOTHING`,
        [accountId, windowStart.toISOString()],
      );
      await client.query(
        `UPDATE archive.chat_sync s SET state = CASE WHEN c.excluded THEN 'excluded'
                                          WHEN s.state = 'excluded' THEN 'not_checked' ELSE s.state END
         FROM archive.chats c
         WHERE c.account_id = s.account_id AND c.chat_id = s.chat_id AND s.account_id = $1
           AND (c.excluded OR s.state = 'excluded')`,
        [accountId],
      );
      const seen = payload.map((d) => d.chat_id);
      const { rowCount: missing } = await client.query(
        `UPDATE archive.chats SET in_dialogs = false
         WHERE account_id = $1 AND in_dialogs AND NOT (chat_id::text = ANY($2::text[]))`,
        [accountId, seen],
      );
      return { total: unique.length, created, missing };
    });
  }

  // A live message may come from a chat the dialogs sweep has not seen yet.
  async ensureChat(client, accountId, chat, { windowDays, windowMonths }) {
    const now = this.now();
    const windowStart = archiveWindowStart(now, { windowDays, windowMonths });
    const { rows } = await client.query(
      `INSERT INTO archive.chats (account_id, chat_id, peer_kind, title, username)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, chat_id) DO NOTHING
       RETURNING chat_id`,
      [accountId, chat.chatId, chat.peerKind ?? 'unknown', clean(chat.title ?? null), chat.username ?? null],
    );
    await client.query(
      `INSERT INTO archive.chat_sync (account_id, chat_id, window_start) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, chat_id) DO NOTHING`,
      [accountId, chat.chatId, windowStart.toISOString()],
    );
    return rows.length > 0;
  }

  // Inserts messages; duplicates by (account_id, chat_id, message_id) are ignored.
  // The per-account advisory lock serialises sequence assignment with commit order,
  // so a smaller archive_seq can never become visible after a larger one.
  async insertMessages(client, accountId, chatId, messages, source) {
    if (!messages.length) return 0;
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2::text))', [SEQ_LOCK_CLASS, String(accountId)]);
    const { rowCount } = await client.query(
      `INSERT INTO archive.messages (account_id, chat_id, message_id, topic_id, sent_at, archive_seq, source,
              sender_id, sender_name, sender_username, text, media_type, media, reply_to_id, forward, grouped_id, is_service)
       SELECT $1, x.chat_id, x.message_id, x.topic_id, x.sent_at, nextval('archive.archive_seq'), $3,
              x.sender_id, x.sender_name, x.sender_username, x.text, x.media_type, x.media, x.reply_to_id,
              x.forward, x.grouped_id, x.is_service
       FROM (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(chat_id bigint, message_id bigint, topic_id bigint,
                sent_at timestamptz, sender_id bigint, sender_name text, sender_username text, text text,
                media_type text, media jsonb, reply_to_id bigint, forward jsonb, grouped_id text, is_service boolean)
             ORDER BY sent_at, message_id) AS x
       ON CONFLICT (account_id, chat_id, message_id) DO NOTHING`,
      [accountId, JSON.stringify(messageRows(chatId, messages)), source],
    );
    return rowCount;
  }

  async insertLiveBatch(accountId, items, { windowDays, windowMonths }) {
    const windowStart = archiveWindowStart(this.now(), { windowDays, windowMonths });
    return withTransaction(this.pool, async (client) => {
      let inserted = 0;
      const byChat = new Map();
      for (const { message, chat } of items) {
        if (windowMonths != null && !withinArchiveWindow(message, windowStart)) continue;
        if (!byChat.has(chat.chatId)) byChat.set(chat.chatId, { chat, messages: [] });
        byChat.get(chat.chatId).messages.push(message);
      }
      for (const { chat, messages } of byChat.values()) {
        await this.ensureChat(client, accountId, chat, { windowDays, windowMonths });
        inserted += await this.insertMessages(client, accountId, chat.chatId, messages, 'live');
        const top = messages.reduce((acc, m) => (m.messageId > acc.messageId ? m : acc));
        await client.query(
          `UPDATE archive.chats SET top_message_id = GREATEST(COALESCE(top_message_id, 0), $3),
                  top_message_at = GREATEST(top_message_at, $4)
           WHERE account_id = $1 AND chat_id = $2`,
          [accountId, chat.chatId, top.messageId, top.sentAt.toISOString()],
        );
      }
      return inserted;
    });
  }

  // Next chat to serve: least recently served first (fair round-robin), gap
  // reconciliation before backfill, and more recently active dialogs first.
  async nextTask(accountId) {
    const { rows } = await this.pool.query(
      `SELECT s.*, c.peer_kind, c.top_message_id, c.username
       FROM archive.chat_sync s JOIN archive.chats c USING (account_id, chat_id)
       WHERE s.account_id = $1 AND NOT c.excluded AND c.in_dialogs
         AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= $2)
         AND (NOT s.backfill_done OR s.gap_min_id IS NOT NULL)
       ORDER BY s.last_page_at NULLS FIRST, (s.gap_min_id IS NULL), c.dialog_rank NULLS LAST, s.chat_id
       LIMIT 1`,
      [accountId, this.now().toISOString()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      kind: row.backfill_done ? 'gap' : 'backfill',
    };
  }

  // Plans a top-of-history reconciliation for every chat whose newest known
  // message is beyond the verified range, and stamps the rest as reconciled.
  async planGaps(accountId, chatIds = null) {
    const now = this.now().toISOString();
    const filter = chatIds ? 'AND s.chat_id::text = ANY($3::text[])' : '';
    const params = chatIds ? [accountId, now, chatIds.map(String)] : [accountId, now];
    const { rowCount: planned } = await this.pool.query(
      `UPDATE archive.chat_sync s SET gap_min_id = s.covered_max_id, gap_offset_id = 0, gap_target_id = NULL,
              updated_at = $2
       FROM archive.chats c
       WHERE c.account_id = s.account_id AND c.chat_id = s.chat_id AND s.account_id = $1
         AND s.backfill_done AND s.gap_min_id IS NULL AND NOT c.excluded AND c.in_dialogs
         AND (${chatIds ? 'true' : 'COALESCE(c.top_message_id, 0) > COALESCE(s.covered_max_id, 0)'}) ${filter}`,
      params,
    );
    if (!chatIds) {
      await this.pool.query(
        `UPDATE archive.chat_sync s SET last_reconciled_at = $2
         FROM archive.chats c
         WHERE c.account_id = s.account_id AND c.chat_id = s.chat_id AND s.account_id = $1
           AND s.backfill_done AND s.gap_min_id IS NULL
           AND COALESCE(c.top_message_id, 0) <= COALESCE(s.covered_max_id, 0)`,
        [accountId, now],
      );
    }
    return planned;
  }

  // Stores one history page and advances the chat checkpoint in one transaction.
  async applyPage(accountId, task, page, { windowDays, windowMonths }) {
    const now = this.now();
    const msgs = page.messages;
    const ids = msgs.map((m) => m.messageId);
    const maxId = ids.length ? Math.max(...ids) : null;
    const minId = ids.length ? Math.min(...ids) : null;
    const oldestAt = msgs.length
      ? new Date(Math.min(...msgs.map((m) => (m.sentAt instanceof Date ? m.sentAt : new Date(m.sentAt)).getTime())))
      : null;
    const windowStart = new Date(task.window_start);
    const currentWindowStart = archiveWindowStart(now, { windowDays, windowMonths });
    const insertFrom = new Date(Math.max(windowStart.getTime(), currentWindowStart.getTime()));

    return withTransaction(this.pool, async (client) => {
      const toInsert = windowMonths == null ? msgs : msgs.filter((message) => withinArchiveWindow(message, insertFrom));
      const inserted = await this.insertMessages(client, accountId, task.chat_id,
        toInsert, task.kind === 'gap' ? 'gap' : 'history');
      const s = {
        backfill_done: task.backfill_done,
        backfill_anchor_id: num(task.backfill_anchor_id),
        backfill_offset_id: num(task.backfill_offset_id),
        covered_min_id: num(task.covered_min_id),
        covered_max_id: num(task.covered_max_id),
        covered_from: task.covered_from ? new Date(task.covered_from) : null,
        history_exhausted: task.history_exhausted,
        gap_min_id: num(task.gap_min_id),
        gap_offset_id: num(task.gap_offset_id),
        gap_target_id: num(task.gap_target_id),
        last_reconciled_at: task.last_reconciled_at,
      };
      let done = false;
      if (task.kind === 'backfill') {
        const first = s.backfill_offset_id === null;
        if (!msgs.length) {
          done = true;
          s.history_exhausted = true;
          if (first) {
            s.covered_max_id = 0;
            s.covered_min_id = 0;
            s.backfill_anchor_id = 0;
          }
          s.covered_from = s.covered_from && s.covered_from < windowStart ? s.covered_from : windowStart;
        } else {
          if (first) {
            s.backfill_anchor_id = maxId;
            s.covered_max_id = maxId;
          }
          s.backfill_offset_id = minId;
          s.covered_min_id = minId;
          s.covered_from = oldestAt;
          if (page.complete) {
            s.history_exhausted = true;
            s.covered_from = oldestAt < windowStart ? oldestAt : windowStart;
            done = true;
          } else if (oldestAt < windowStart) {
            done = true;
          }
        }
        if (done) {
          s.backfill_done = true;
          s.last_reconciled_at = now;
        }
      } else {
        if (s.gap_target_id === null) {
          s.gap_target_id = Math.max(maxId ?? 0, s.gap_min_id ?? 0);
        }
        const gapDone = !msgs.length || page.complete || minId <= (s.gap_min_id ?? 0);
        const pastWindow = oldestAt && oldestAt < currentWindowStart;
        if (gapDone) {
          s.covered_max_id = s.gap_target_id;
          done = true;
        } else if (pastWindow) {
          // Offline longer than the window: restart the verified range at the
          // window boundary instead of walking arbitrarily far back.
          s.covered_min_id = minId;
          s.covered_from = oldestAt;
          s.covered_max_id = s.gap_target_id;
          done = true;
        } else {
          s.gap_offset_id = minId;
        }
        if (done) {
          s.gap_min_id = null;
          s.gap_offset_id = null;
          s.gap_target_id = null;
          s.last_reconciled_at = now;
        }
      }
      const state = s.backfill_done ? 'loaded' : 'loading';
      await client.query(
        `UPDATE archive.chat_sync SET
           state = $3, backfill_done = $4, backfill_anchor_id = $5, backfill_offset_id = $6,
           covered_min_id = $7, covered_max_id = $8, covered_from = $9, history_exhausted = $10,
           gap_min_id = $11, gap_offset_id = $12, gap_target_id = $13,
           pages_fetched = pages_fetched + 1, messages_fetched = messages_fetched + $14,
           last_page_at = $15, last_reconciled_at = $16, flood_wait_until = NULL,
           error_code = NULL, error_count = 0, next_attempt_at = NULL, updated_at = $15
         WHERE account_id = $1 AND chat_id = $2`,
        [accountId, task.chat_id, state, s.backfill_done, s.backfill_anchor_id, s.backfill_offset_id,
          s.covered_min_id, s.covered_max_id, s.covered_from, s.history_exhausted,
          s.gap_min_id, s.gap_offset_id, s.gap_target_id, msgs.length, now, s.last_reconciled_at],
      );
      if (maxId !== null) {
        await client.query(
          `UPDATE archive.chats SET top_message_id = GREATEST(COALESCE(top_message_id, 0), $3)
           WHERE account_id = $1 AND chat_id = $2`,
          [accountId, task.chat_id, maxId],
        );
      }
      return { inserted, fetched: msgs.length, done, state };
    });
  }

  async markFloodWait(accountId, chatId, until) {
    await this.pool.query(
      `UPDATE archive.chat_sync SET state = 'rate_limited', flood_wait_until = $3, last_page_at = $4,
              updated_at = $4
       WHERE account_id = $1 AND chat_id = $2`,
      [accountId, chatId, new Date(until), this.now()],
    );
  }

  async markError(accountId, chatId, code) {
    const now = this.now();
    const { rows } = await this.pool.query(
      'SELECT error_count FROM archive.chat_sync WHERE account_id = $1 AND chat_id = $2',
      [accountId, chatId],
    );
    const count = (rows[0]?.error_count ?? 0) + 1;
    const retrying = RECOVERABLE_CODES.has(code) && count < RECOVERABLE_ATTEMPTS;
    const unavailable = UNAVAILABLE_CODES.has(code) && !retrying;
    const delayMs = unavailable ? DAY_MS
      : retrying ? RECOVERABLE_DELAY_MS
        : Math.min(6 * 3_600_000, 30_000 * 2 ** Math.min(count - 1, 10));
    await this.pool.query(
      `UPDATE archive.chat_sync SET state = $3, error_code = $4, error_count = $5, next_attempt_at = $6,
              last_page_at = $7, updated_at = $7
       WHERE account_id = $1 AND chat_id = $2`,
      [accountId, chatId, unavailable ? 'unavailable' : 'error', code, count, new Date(now.getTime() + delayMs), now],
    );
    return { unavailable, count };
  }

  // After a FLOOD_WAIT ends the paused chat goes back to its working state.
  async clearExpiredFloodWaits(accountId) {
    await this.pool.query(
      `UPDATE archive.chat_sync SET state = CASE WHEN backfill_done THEN 'loaded' ELSE 'loading' END,
              flood_wait_until = NULL
       WHERE account_id = $1 AND state = 'rate_limited' AND flood_wait_until <= $2`,
      [accountId, this.now()],
    );
  }
}
