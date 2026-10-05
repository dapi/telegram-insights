import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDigest } from '../src/digest/digest.js';
import { Indexer, buildChunks } from '../src/index/indexer.js';
import { assertLocalRoute } from '../src/llm/ollama.js';
import { messageLink } from '../src/links.js';
import { answerQuestion } from '../src/search/ask.js';
import { SearchService, queryTerms } from '../src/search/search.js';
import { dayRange } from '../src/time.js';
import { createTestDatabase } from './helpers/db.js';
import { FakeTelegram } from './helpers/fake-telegram.js';
import { FakeChat, FakeEmbedder } from './helpers/fake-models.js';
import { drain, startArchiver, virtualClock } from './helpers/harness.js';

const DAY = '2026-10-04';
const REPOST = 'Организаторы конференции утвердили бюджет на площадку и питание, регистрация участников откроется в понедельник.';

let db;
let pool;
let tg;
let clock;
let archiver;
let indexer;
const embedder = new FakeEmbedder();

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  clock = virtualClock(Date.parse('2026-10-05T06:00:00Z'));
  tg = new FakeTelegram({ now: clock.now });
  tg.addChat({ chatId: '-1001000000010', peerKind: 'channel', title: 'Новости конференции', username: 'conf_news' });
  tg.addChat({ chatId: '-1001000000011', peerKind: 'channel', title: 'Закрытый канал организаторов' });
  tg.addChat({ chatId: '-1001000000012', peerKind: 'supergroup', title: 'Рабочая группа', isForum: true });
  tg.addChat({ chatId: '601', peerKind: 'user', title: 'Иван (синтетический)' });
  tg.addChat({ chatId: '-1001000000013', peerKind: 'channel', title: 'Недоступный канал' });
  tg.chats.get('-1001000000013').unavailable = 'CHANNEL_PRIVATE';
  const at = (h, m) => new Date(Date.parse(`${DAY}T00:00:00Z`) + (h - 3) * 3_600_000 + m * 60_000);
  tg.addMessage('-1001000000010', { text: REPOST, sentAt: at(10, 5) }, { live: false });
  tg.addMessage('-1001000000011', { text: REPOST, sentAt: at(10, 40) }, { live: false });
  tg.addMessage('-1001000000012', { text: 'Кто готовит договор с площадкой?', sentAt: at(11, 0), topicId: 7 }, { live: false });
  tg.addMessage('-1001000000012', { text: 'Договор с площадкой готовит Мария, срок пятница.', sentAt: at(11, 3), topicId: 7 }, { live: false });
  tg.addMessage('-1001000000012', { text: 'В другой теме обсуждаем мерч и футболки.', sentAt: at(11, 4), topicId: 9 }, { live: false });
  tg.addMessage('601', { text: 'Бюджет конференции увеличили до 500 тысяч, подтверди питание.', sentAt: at(15, 20) }, { live: false });
  tg.addMessage('601', { text: 'Подтверждаю питание на 120 человек.', sentAt: at(15, 25), senderId: '777000111', senderName: 'Владелец' }, { live: false });
  tg.addMessage('601', { text: 'Вчерашний разговор про отпуск.', sentAt: at(-10, 0) }, { live: false });
  archiver = await startArchiver(pool, tg, clock);
  await drain(archiver);
  indexer = new Indexer({ pool, embedder, options: { batchSize: 3 } });
  await indexer.runOnce();
});

afterAll(async () => {
  await db.drop();
});

describe('search projection', () => {
  it('indexes every text message exactly once without crossing chat or topic boundaries', async () => {
    const { rows: chunks } = await pool.query('SELECT chat_id, topic_key, message_ids FROM search.chunks');
    const seen = new Map();
    for (const c of chunks) {
      for (const id of c.message_ids) {
        const key = `${c.chat_id}/${id}`;
        expect(seen.has(key)).toBe(false);
        seen.set(key, c.topic_key);
      }
    }
    const { rows: messages } = await pool.query("SELECT chat_id, message_id, COALESCE(topic_id, 0) AS topic FROM archive.messages WHERE text <> ''");
    expect(seen.size).toBe(messages.length);
    for (const m of messages) expect(seen.get(`${m.chat_id}/${m.message_id}`)).toBe(m.topic);
    const { rows: [cursor] } = await pool.query('SELECT last_seq FROM search.cursor');
    const { rows: [max] } = await pool.query('SELECT max(archive_seq) AS s FROM archive.messages');
    expect(cursor.last_seq).toBe(max.s);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM search.chunks WHERE embedding IS NULL');
    expect(n).toBe(0);
  });

  it('is idempotent and rebuilds only the bucket that received a late message', async () => {
    const before = await pool.query('SELECT chat_id, bucket_start, part, body_hash, embedding IS NOT NULL AS e FROM search.chunks ORDER BY 1, 2, 3');
    const callsBefore = embedder.calls;
    await indexer.runOnce();
    const again = await pool.query('SELECT chat_id, bucket_start, part, body_hash, embedding IS NOT NULL AS e FROM search.chunks ORDER BY 1, 2, 3');
    expect(again.rows).toEqual(before.rows);
    expect(embedder.calls).toBe(callsBefore);

    // A backfilled older message lands in an existing bucket of the private chat.
    const late = tg.addMessage('601', { text: 'Поздно дозагруженное сообщение про питание.', sentAt: new Date(Date.parse(`${DAY}T12:21:00Z`)) }, { live: false });
    await pool.query(
      `INSERT INTO archive.messages (account_id, chat_id, message_id, sent_at, archive_seq, source, text, sender_name)
       SELECT account_id, '601', $1, $2, nextval('archive.archive_seq'), 'history', $3, 'Синтетический автор' FROM archive.accounts`,
      [late.messageId, late.sentAt, late.text],
    );
    await indexer.projectBatch((await pool.query('SELECT account_id FROM archive.accounts')).rows[0].account_id, 1);
    const { rows: pending } = await pool.query('SELECT chat_id, message_ids FROM search.chunks WHERE embedding IS NULL');
    expect(pending).toHaveLength(1);
    expect(pending[0].chat_id).toBe('601');
    expect(pending[0].message_ids.map(Number)).toContain(late.messageId);
    await indexer.runOnce();
  });

  it('chunks by size deterministically', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ message_id: i + 1, sent_at: new Date(Date.UTC(2026, 9, 4, 10, i)), sender_name: 'A', text: 'x'.repeat(200) }));
    const a = buildChunks('Чат: тест', msgs, { maxChunkChars: 1500, maxMessageChars: 4000 });
    const b = buildChunks('Чат: тест', msgs, { maxChunkChars: 1500, maxMessageChars: 4000 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    expect(a.flatMap((c) => c.messageIds)).toEqual(msgs.map((m) => m.message_id));
  });
});

describe('cross-chat search and answers', () => {
  it('finds a topic across several chats and links to exact messages', async () => {
    const service = new SearchService({ pool, embedder });
    const found = await service.search('какой бюджет у конференции и кто подтвердил питание?', { limit: 6 });
    expect(found.mode).toBe('hybrid');
    const chats = new Set(found.results.map((r) => r.chatId));
    expect(chats.has('601')).toBe(true);
    expect(chats.has('-1001000000010') || chats.has('-1001000000011')).toBe(true);
    const all = found.results.flatMap((r) => r.messages);
    const fromPublic = all.find((m) => m.link.url?.startsWith('https://t.me/conf_news/'));
    const fromPrivate = all.find((m) => m.link.url === null && m.link.ref.startsWith('tgi:601/'));
    expect(fromPublic ?? found.results.some((r) => r.chatId === '-1001000000011')).toBeTruthy();
    expect(fromPrivate).toBeTruthy();
    expect(found.coverageNote).toMatch(/недоступно 1/);
  });

  it('falls back to text search when the embedding route is unavailable', async () => {
    const broken = { id: 'broken', embedQuery: async () => { throw new Error('connection refused'); } };
    const service = new SearchService({ pool, embedder: broken });
    const found = await service.search('договор площадка');
    expect(found.mode).toBe('text');
    expect(found.results[0].chatId).toBe('-1001000000012');
  });

  it('ranks a chunk with a rare query word above chunks that repeat common ones', async () => {
    // A separate synthetic account so the shared fixture stays untouched.
    const account = '990001';
    const chunk = (chatId, body) => pool.query(
      `INSERT INTO search.chunks (account_id, chat_id, bucket_start, part, message_ids, first_sent_at, last_sent_at, body, body_hash)
       VALUES ($1, $2, '2026-10-04T10:00:00Z', 0, '{1}', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z', $3, md5($3))`,
      [account, chatId, body],
    );
    for (let i = 0; i < 6; i += 1) {
      await chunk(`70${i}`, `Подписка на агентов: агентами пользуемся, подписка с агентами, лимит подписки ${i}.`);
    }
    await chunk('799', 'Длинное обсуждение докладов и поездки в Казань, время выезда и темы. Второй доклад будет про солопренерство.');
    const service = new SearchService({ pool, embedder: null });
    const rows = await service.textCandidates(account, 'солопренерство с агентами подписка', { limit: 3 });
    expect(String(rows[0].chat_id)).toBe('799');
    await pool.query('DELETE FROM search.chunks WHERE account_id = $1', [account]);
  });

  it('keeps dotted and hyphenated query tokens whole', async () => {
    expect(queryTerms('z.ai подписка, GPT-6 и prompt-audit — ок')).toEqual(['z.ai', 'подписка', 'gpt-6', 'prompt-audit']);
    const account = '990002';
    await pool.query(
      `INSERT INTO search.chunks (account_id, chat_id, bucket_start, part, message_ids, first_sent_at, last_sent_at, body, body_hash)
       VALUES ($1, 801, '2026-10-04T10:00:00Z', 0, '{1}', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z', $2, md5($2))`,
      [account, 'Купил подписку z.ai и за два часа сжёг лимит; по ощущениям как GPT-6.'],
    );
    const service = new SearchService({ pool, embedder: null });
    const rows = await service.textCandidates(account, 'z.ai gpt-6', { limit: 3 });
    expect(rows.map((r) => String(r.chat_id))).toEqual(['801']);
    await pool.query('DELETE FROM search.chunks WHERE account_id = $1', [account]);
  });

  it('prefers recent messages only when asked to', async () => {
    const account = '990003';
    await pool.query('INSERT INTO archive.accounts (account_id) VALUES ($1)', [account]);
    const chunk = async (chatId, at, body) => {
      await pool.query("INSERT INTO archive.chats (account_id, chat_id, peer_kind, title) VALUES ($1, $2, 'user', $3)", [account, chatId, `Чат ${chatId}`]);
      await pool.query(
        `INSERT INTO search.chunks (account_id, chat_id, bucket_start, part, message_ids, first_sent_at, last_sent_at, body, body_hash)
         VALUES ($1, $2, $3, 0, '{1}', $3, $3, $4, md5($4))`,
        [account, chatId, at, body],
      );
    };
    try {
      await chunk('901', '2024-10-04T10:00:00Z', 'Поздравляем с днём рождения, счастья и здоровья!');
      await chunk('902', '2026-10-04T10:00:00Z', 'С днём рождения!');
      const service = new SearchService({ pool, embedder: null, now: () => Date.parse('2026-10-05T10:00:00Z') });
      const order = async (opts) => (await service.search('поздравляем с днём рождения счастья', { accountId: account, limit: 2, ...opts }))
        .results.map((r) => String(r.chatId));
      expect(await order({})).toEqual(['901', '902']);
      expect(await order({ recent: true })).toEqual(['902', '901']);
      expect(await order({ recent: true, from: new Date('2020-01-01') })).toEqual(['901', '902']);
    } finally {
      await pool.query('DELETE FROM search.chunks WHERE account_id = $1', [account]);
      await pool.query('DELETE FROM archive.chats WHERE account_id = $1', [account]);
      await pool.query('DELETE FROM archive.accounts WHERE account_id = $1', [account]);
    }
  });

  it('gives half of the answer sources to the last 30 days when no dates are set', async () => {
    const hit = (chatId, at) => ({ chatId, chatTitle: chatId, firstSentAt: new Date(at), lastSentAt: new Date(at), messages: [] });
    const calls = [];
    const search = {
      async search(question, { limit, from }) {
        calls.push({ limit, from });
        const results = from ? [hit('new', '2026-10-04')] : [hit('old1', '2024-10-04'), hit('old2', '2023-10-04'), hit('new', '2026-10-04')];
        return { results: results.slice(0, limit), coverageNote: 'покрытие', mode: 'text' };
      },
    };
    const { found } = await answerQuestion({ search, llm: null, question: 'кто поздравил?', limit: 2, now: Date.parse('2026-10-05T10:00:00Z') });
    expect(found.results.map((r) => r.chatId)).toEqual(['new', 'old1']);
    expect(calls.find((c) => c.from).from.toISOString()).toBe('2026-09-05T10:00:00.000Z');
  });

  it('answers with source references, coverage and the edits limitation', async () => {
    const service = new SearchService({ pool, embedder });
    const { text } = await answerQuestion({ search: service, llm: new FakeChat(), question: 'Какой бюджет конференции?' });
    expect(text).toMatch(/\[S1\]/);
    expect(text).toMatch(/## Источники/);
    expect(text).toMatch(/tgi:601\//);
    expect(text).toMatch(/правки и удаления в v1 не синхронизируются/);
    expect(text).toMatch(/Покрытие/);
  });

  it('says so when nothing relevant is archived', async () => {
    const service = new SearchService({ pool, embedder: null });
    const { text } = await answerQuestion({ search: service, llm: new FakeChat(), question: 'квантовая хромодинамика' });
    expect(text).toMatch(/нет данных/);
  });
});

describe('daily digest draft', () => {
  it('shows what needs the owner: awaiting replies, promises, unread groups and coverage', async () => {
    const llm = new FakeChat();
    const { markdown, meta, data } = await buildDigest({ pool, llm, day: DAY, now: new Date(clock.now()) });
    expect(meta.periodMessages).toBe(8);
    // Ivan's request was answered by the owner, so it does not wait.
    expect(data.awaiting).toEqual([]);
    expect(data.promises[0]).toMatchObject({ chat: 'Иван (синтетический)', text: 'Синтетическое обещание', due: 'пятница' });
    // Without read markers yet, unread falls back to chats the owner did not write in.
    const unreadChats = data.unread.stories.flatMap((s) => s.chats);
    expect(unreadChats).toContain('Новости конференции');
    expect(unreadChats).not.toContain('Иван (синтетический)');
    const repost = data.unread.stories.find((s) => s.chats.includes('Новости конференции') && s.chats.includes('Закрытый канал организаторов'));
    expect(repost.sources.map((x) => x.url)).toContain('https://t.me/conf_news/1');
    expect(markdown).toMatch(/## Ждут твоего ответа \(0\)/);
    expect(markdown).toMatch(/## Ты обещал \(1\)/);
    expect(markdown).toMatch(/## Непрочитанное/);
    expect(markdown).toMatch(/\*\*частичный\*\*/);
    expect(markdown).toMatch(/отметки прочтения есть для 0/);
    expect(markdown).not.toMatch(/Вчерашний разговор/);
  });

  it('finds a request still waiting for the owner in a rolling window', async () => {
    // Ends between Ivan's request (15:20 MSK) and the owner's answer (15:25).
    const end = new Date(`${DAY}T12:22:00Z`);
    const { data, markdown } = await buildDigest({ pool, llm: new FakeChat(), range: { start: new Date(end.getTime() - 24 * 3_600_000), end }, now: end });
    expect(data.period.day).toBeNull();
    expect(data.awaiting).toHaveLength(1);
    expect(data.awaiting[0]).toMatchObject({ chat: 'Иван (синтетический)', personal: true, ask: 'Синтетическая просьба', ref: expect.stringMatching(/^tgi:601\//) });
    expect(markdown).toMatch(/## Ждут твоего ответа \(1\)/);
  });

  it('still produces a draft without a model', async () => {
    const { markdown, meta } = await buildDigest({ pool, llm: null, day: DAY, now: new Date(clock.now()) });
    expect(meta.model).toBeNull();
    expect(markdown).toMatch(/Без модели обещания не извлекаются/);
    expect(markdown).toMatch(/модель не использовалась/);
  });
});

describe('helpers', () => {
  it('builds links for public, private-channel and archive-only messages', () => {
    expect(messageLink({ chatId: '-1001000000010', messageId: 5, peerKind: 'channel', username: 'conf_news' }).url).toBe('https://t.me/conf_news/5');
    expect(messageLink({ chatId: '-1001000000012', messageId: 5, topicId: 7, peerKind: 'supergroup' }).url).toBe('https://t.me/c/1000000012/7/5');
    expect(messageLink({ chatId: '601', messageId: 5, peerKind: 'user', username: 'ivan' })).toEqual({ url: null, ref: 'tgi:601/5' });
  });

  it('uses Moscow calendar days', () => {
    const { start, end } = dayRange('2026-10-04', 'Europe/Moscow');
    expect(start.toISOString()).toBe('2026-10-03T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-04T21:00:00.000Z');
  });

  it('refuses non-local model endpoints without explicit approval', () => {
    expect(() => assertLocalRoute('http://127.0.0.1:11434')).not.toThrow();
    expect(() => assertLocalRoute('http://10.20.30.40:30400/v1')).toThrow(/not local/);
    expect(() => assertLocalRoute('https://openrouter.ai/api')).toThrow(/not local/);
    expect(() => assertLocalRoute('http://10.20.30.40:30400', ['10.20.30.40'])).not.toThrow();
  });
});
