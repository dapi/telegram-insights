import crypto from 'node:crypto';

import { withTransaction } from '../db.js';
import { DEFAULT_TZ, formatTime, localDate } from '../time.js';

const DEFAULTS = {
  bucketMinutes: 60,
  maxChunkChars: 1500,
  maxMessageChars: 4000,
  timeZone: DEFAULT_TZ,
  batchSize: 2000,
  embedBatch: 16,
};

export function bucketStart(date, minutes) {
  const ms = minutes * 60_000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

// Deterministic chunking of one (chat, topic, bucket): same messages, same chunks.
export function buildChunks(header, messages, { maxChunkChars, maxMessageChars, timeZone = DEFAULT_TZ }) {
  const parts = [];
  let current = null;
  for (const m of messages) {
    const text = (m.text ?? '').trim();
    if (!text) continue;
    const body = text.length > maxMessageChars ? `${text.slice(0, maxMessageChars)}…` : text;
    const line = `[${formatTime(m.sent_at, timeZone)}] ${m.sender_name ?? 'неизвестный отправитель'}: ${body}`;
    if (!current || (current.chars + line.length > maxChunkChars && current.ids.length)) {
      current = { ids: [], lines: [], chars: header.length, first: m.sent_at, last: m.sent_at };
      parts.push(current);
    }
    current.ids.push(Number(m.message_id));
    current.lines.push(line);
    current.chars += line.length + 1;
    current.last = m.sent_at;
  }
  return parts.map((p) => {
    const body = `${header}\n${p.lines.join('\n')}`;
    return {
      messageIds: p.ids,
      firstSentAt: p.first,
      lastSentAt: p.last,
      body,
      bodyHash: crypto.createHash('sha256').update(body).digest('hex'),
    };
  });
}

export function chatHeader(chat) {
  const kind = { user: 'личный диалог', bot: 'бот', saved: 'избранное', group: 'группа', supergroup: 'группа', channel: 'канал' }[chat?.peer_kind] ?? 'чат';
  return `Чат: ${chat?.title ?? 'без названия'} (${kind})`;
}

export class Indexer {
  constructor({ pool, embedder = null, options = {}, log = () => {} }) {
    this.pool = pool;
    this.embedder = embedder;
    this.options = { ...DEFAULTS, ...options };
    this.log = log;
  }

  async accounts() {
    const { rows } = await this.pool.query('SELECT account_id, generation FROM archive.accounts ORDER BY account_id');
    return rows;
  }

  // One projection step for one account: read archive_seq > cursor, rebuild the
  // touched buckets and move the cursor in the same transaction.
  async projectBatch(accountId, generation) {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO search.cursor (account_id, generation) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [accountId, generation],
      );
      const { rows: [cursor] } = await client.query(
        'SELECT last_seq FROM search.cursor WHERE account_id = $1 AND generation = $2 FOR UPDATE',
        [accountId, generation],
      );
      const { rows } = await client.query(
        `SELECT chat_id, COALESCE(topic_id, 0) AS topic_key, sent_at, archive_seq
         FROM archive.messages WHERE account_id = $1 AND archive_seq > $2
         ORDER BY archive_seq LIMIT $3`,
        [accountId, cursor.last_seq, this.options.batchSize],
      );
      if (!rows.length) return { processed: 0, buckets: 0 };
      const buckets = new Map();
      for (const row of rows) {
        const start = bucketStart(new Date(row.sent_at), this.options.bucketMinutes);
        const key = `${row.chat_id}|${row.topic_key}|${start.toISOString()}`;
        buckets.set(key, { chatId: row.chat_id, topicKey: row.topic_key, start });
      }
      const chats = new Map();
      for (const bucket of buckets.values()) {
        if (!chats.has(bucket.chatId)) {
          const { rows: [chat] } = await client.query(
            'SELECT title, peer_kind FROM archive.chats WHERE account_id = $1 AND chat_id = $2',
            [accountId, bucket.chatId],
          );
          chats.set(bucket.chatId, chat);
        }
        await this.rebuildBucket(client, accountId, bucket, `${chatHeader(chats.get(bucket.chatId))}, ${localDate(bucket.start, this.options.timeZone)}`);
      }
      const lastSeq = rows[rows.length - 1].archive_seq;
      await client.query(
        'UPDATE search.cursor SET last_seq = $3, updated_at = now() WHERE account_id = $1 AND generation = $2',
        [accountId, generation, lastSeq],
      );
      return { processed: rows.length, buckets: buckets.size, lastSeq: Number(lastSeq) };
    });
  }

  async rebuildBucket(client, accountId, { chatId, topicKey, start }, header) {
    const end = new Date(start.getTime() + this.options.bucketMinutes * 60_000);
    const { rows: messages } = await client.query(
      `SELECT message_id, sent_at, sender_name, text FROM archive.messages
       WHERE account_id = $1 AND chat_id = $2 AND COALESCE(topic_id, 0) = $3 AND sent_at >= $4 AND sent_at < $5
       ORDER BY sent_at, message_id`,
      [accountId, chatId, topicKey, start, end],
    );
    const chunks = buildChunks(header, messages, this.options);
    for (const [part, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO search.chunks AS c (account_id, chat_id, topic_key, bucket_start, part, message_ids,
                first_sent_at, last_sent_at, body, body_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (account_id, chat_id, topic_key, bucket_start, part) DO UPDATE SET
           message_ids = EXCLUDED.message_ids,
           first_sent_at = EXCLUDED.first_sent_at,
           last_sent_at = EXCLUDED.last_sent_at,
           body = EXCLUDED.body,
           embedding = CASE WHEN c.body_hash = EXCLUDED.body_hash THEN c.embedding ELSE NULL END,
           embedding_model = CASE WHEN c.body_hash = EXCLUDED.body_hash THEN c.embedding_model ELSE NULL END,
           body_hash = EXCLUDED.body_hash,
           indexed_at = now()`,
        [accountId, chatId, topicKey, start, part, chunk.messageIds, chunk.firstSentAt, chunk.lastSentAt, chunk.body, chunk.bodyHash],
      );
    }
    await client.query(
      `DELETE FROM search.chunks WHERE account_id = $1 AND chat_id = $2 AND topic_key = $3 AND bucket_start = $4 AND part >= $5`,
      [accountId, chatId, topicKey, start, chunks.length],
    );
  }

  // Fills missing embeddings, newest chunks first. The hash guard drops a vector
  // computed for text that was rebuilt meanwhile.
  async embedPending(accountId, { limit = this.options.embedBatch } = {}) {
    if (!this.embedder) return 0;
    const { rows } = await this.pool.query(
      `SELECT chat_id, topic_key, bucket_start, part, body, body_hash FROM search.chunks
       WHERE account_id = $1 AND embedding IS NULL ORDER BY last_sent_at DESC LIMIT $2`,
      [accountId, limit],
    );
    if (!rows.length) return 0;
    const vectors = await this.embedder.embed(rows.map((r) => r.body));
    let updated = 0;
    for (const [i, row] of rows.entries()) {
      const { rowCount } = await this.pool.query(
        `UPDATE search.chunks SET embedding = $7::vector, embedding_model = $8
         WHERE account_id = $1 AND chat_id = $2 AND topic_key = $3 AND bucket_start = $4 AND part = $5 AND body_hash = $6`,
        [accountId, row.chat_id, row.topic_key, row.bucket_start, row.part, row.body_hash, `[${vectors[i].join(',')}]`, this.embedder.id],
      );
      updated += rowCount;
    }
    return updated;
  }

  // Projects everything currently visible, then embeds up to `embedLimit` chunks.
  async runOnce({ embedLimit = Infinity } = {}) {
    const totals = { processed: 0, buckets: 0, embedded: 0 };
    for (const { account_id: accountId, generation } of await this.accounts()) {
      for (;;) {
        const r = await this.projectBatch(accountId, generation);
        totals.processed += r.processed;
        totals.buckets += r.buckets;
        if (r.processed < this.options.batchSize) break;
      }
      while (totals.embedded < embedLimit) {
        const n = await this.embedPending(accountId);
        if (!n) break;
        totals.embedded += n;
      }
    }
    return totals;
  }

  async loop({ intervalMs = 15_000, shouldStop = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    while (!shouldStop()) {
      try {
        // Small embedding batches keep projection of fresh messages responsive.
        const totals = await this.runOnce({ embedLimit: 256 });
        if (totals.processed || totals.embedded) this.log('indexer step', totals);
        if (totals.embedded >= 256) continue;
      } catch (error) {
        this.log('indexer step failed', { error: error.message });
      }
      await sleep(intervalMs);
    }
  }
}
