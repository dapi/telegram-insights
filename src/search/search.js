import { coverageNote, coverageReport, resolveAccountId } from '../archive/status.js';
import { messageLink } from '../links.js';

const RRF_K = 60;

// Words of a natural-language query for full-text matching (3+ letters/digits).
export function queryTerms(text) {
  const words = String(text)
    .toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words)].slice(0, 24);
}

// Natural-language questions rarely match with AND semantics, so the text side
// ORs the words and lets ranking prefer chunks that contain more of them.
export function orQuery(text) {
  return queryTerms(text).join(' | ');
}

export class SearchService {
  constructor({ pool, embedder = null, windowDays = 14, timeZone = 'Europe/Moscow' }) {
    this.pool = pool;
    this.embedder = embedder;
    this.windowDays = windowDays;
    this.timeZone = timeZone;
  }

  // Postgres ts_rank has no notion of term rarity, so with OR semantics common
  // words ("агентами", "подписка") outrank the one rare word that identifies the
  // message. Each matched term adds its BM25 idf instead; ts_rank_cd breaks ties.
  // CTEs are MATERIALIZED so document frequencies are computed once per query.
  async textCandidates(accountId, query, { from, to, limit, chatId = null }) {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const { rows } = await this.pool.query(
      `WITH terms AS MATERIALIZED (
         SELECT to_tsquery('russian', t) || to_tsquery('simple', t) AS q FROM unnest($2::text[]) AS t
       ), total AS MATERIALIZED (
         SELECT count(*)::float8 AS n FROM search.chunks WHERE account_id = $1
       ), weights AS MATERIALIZED (
         SELECT terms.q, ln(1 + (total.n - df.n + 0.5) / (df.n + 0.5)) AS idf
         FROM terms, total,
           LATERAL (SELECT count(*)::float8 AS n FROM search.chunks c WHERE c.account_id = $1 AND c.tsv @@ terms.q) AS df
         WHERE df.n > 0
       ), anyq AS MATERIALIZED (
         SELECT string_agg(q::text, ' | ')::tsquery AS q FROM weights
       ), cand AS MATERIALIZED (
         SELECT c.chat_id, c.topic_key, c.bucket_start, c.part, c.last_sent_at, c.tsv, ts_rank_cd(c.tsv, anyq.q) AS tie
         FROM search.chunks c, anyq
         WHERE c.account_id = $1 AND c.tsv @@ anyq.q
           AND ($3::timestamptz IS NULL OR c.last_sent_at >= $3) AND ($4::timestamptz IS NULL OR c.first_sent_at < $4)
           AND ($6::bigint IS NULL OR c.chat_id = $6)
       )
       SELECT cand.chat_id, cand.topic_key, cand.bucket_start, cand.part, sum(weights.idf) AS score
       FROM cand JOIN weights ON cand.tsv @@ weights.q
       GROUP BY cand.chat_id, cand.topic_key, cand.bucket_start, cand.part, cand.last_sent_at, cand.tie
       ORDER BY score DESC, cand.tie DESC, cand.last_sent_at DESC LIMIT $5`,
      [accountId, terms, from, to, limit, chatId],
    );
    return rows;
  }

  async vectorCandidates(accountId, query, { from, to, limit, chatId = null }) {
    if (!this.embedder) return { rows: [], used: false, error: null };
    let vector;
    try {
      vector = await this.embedder.embedQuery(query);
    } catch (error) {
      return { rows: [], used: false, error: error.message };
    }
    const { rows } = await this.pool.query(
      `SELECT chat_id, topic_key, bucket_start, part, embedding <=> $2::vector AS distance
       FROM search.chunks
       WHERE account_id = $1 AND embedding IS NOT NULL AND embedding_model = $7
         AND ($3::timestamptz IS NULL OR last_sent_at >= $3) AND ($4::timestamptz IS NULL OR first_sent_at < $4)
         AND ($6::bigint IS NULL OR chat_id = $6)
       ORDER BY embedding <=> $2::vector LIMIT $5`,
      [accountId, `[${vector.join(',')}]`, from, to, limit, chatId, this.embedder.id],
    );
    return { rows, used: true, error: null };
  }

  async search(query, { accountId = null, limit = 8, from = null, to = null, candidates = 50, chatId = null } = {}) {
    const account = await resolveAccountId(this.pool, accountId);
    if (!account) throw new Error('Archive is empty: no account has been archived yet');
    const [text, vector] = await Promise.all([
      this.textCandidates(account, query, { from, to, limit: candidates, chatId }),
      this.vectorCandidates(account, query, { from, to, limit: candidates, chatId }),
    ]);
    const fused = new Map();
    const key = (r) => `${r.chat_id}|${r.topic_key}|${new Date(r.bucket_start).toISOString()}|${r.part}`;
    text.forEach((r, i) => {
      const k = key(r);
      fused.set(k, { row: r, score: (fused.get(k)?.score ?? 0) + 1 / (RRF_K + i + 1), text: true });
    });
    vector.rows.forEach((r, i) => {
      const k = key(r);
      const prev = fused.get(k);
      fused.set(k, { row: r, score: (prev?.score ?? 0) + 1 / (RRF_K + i + 1), text: prev?.text ?? false, vector: true, distance: Number(r.distance) });
    });
    const top = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    const results = [];
    for (const hit of top) results.push(await this.loadHit(account, hit));
    const { summary } = await coverageReport(this.pool, { accountId: account, windowDays: this.windowDays });
    return {
      account,
      query,
      results,
      mode: vector.used ? 'hybrid' : 'text',
      vectorError: vector.error,
      coverage: summary,
      coverageNote: coverageNote(summary),
    };
  }

  // Re-reads the exact messages from the archive and adds one neighbour on each side.
  async loadHit(accountId, hit) {
    const { rows: [chunk] } = await this.pool.query(
      `SELECT c.*, ch.title, ch.peer_kind, ch.username FROM search.chunks c
       JOIN archive.chats ch ON ch.account_id = c.account_id AND ch.chat_id = c.chat_id
       WHERE c.account_id = $1 AND c.chat_id = $2 AND c.topic_key = $3 AND c.bucket_start = $4 AND c.part = $5`,
      [accountId, hit.row.chat_id, hit.row.topic_key, hit.row.bucket_start, hit.row.part],
    );
    const ids = chunk.message_ids.map(Number);
    const { rows: messages } = await this.pool.query(
      `(SELECT message_id, topic_id, sent_at, sender_name, text, false AS context FROM archive.messages
         WHERE account_id = $1 AND chat_id = $2 AND message_id = ANY($3::bigint[]))
       UNION ALL
       (SELECT message_id, topic_id, sent_at, sender_name, text, true FROM archive.messages
         WHERE account_id = $1 AND chat_id = $2 AND sent_at < $4 AND text <> ''
           AND COALESCE(topic_id, 0) = $6 ORDER BY sent_at DESC LIMIT 1)
       UNION ALL
       (SELECT message_id, topic_id, sent_at, sender_name, text, true FROM archive.messages
         WHERE account_id = $1 AND chat_id = $2 AND sent_at > $5 AND text <> ''
           AND COALESCE(topic_id, 0) = $6 ORDER BY sent_at LIMIT 1)
       ORDER BY sent_at, message_id`,
      [accountId, chunk.chat_id, ids, chunk.first_sent_at, chunk.last_sent_at, chunk.topic_key],
    );
    return {
      chatId: chunk.chat_id,
      chatTitle: chunk.title,
      peerKind: chunk.peer_kind,
      firstSentAt: chunk.first_sent_at,
      lastSentAt: chunk.last_sent_at,
      score: hit.score,
      matchedBy: [hit.text ? 'text' : null, hit.vector ? 'vector' : null].filter(Boolean),
      messages: messages.map((m) => ({
        messageId: Number(m.message_id),
        sentAt: m.sent_at,
        sender: m.sender_name,
        text: m.text,
        context: m.context,
        link: messageLink({ chatId: chunk.chat_id, messageId: Number(m.message_id), topicId: m.topic_id, peerKind: chunk.peer_kind, username: chunk.username }),
      })),
    };
  }
}

export const EDITS_LIMITATION = 'Архив хранит первую полученную версию сообщения: правки и удаления в v1 не синхронизируются, поэтому текст может отличаться от Telegram.';
