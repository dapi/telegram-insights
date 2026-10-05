import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDigest } from '../src/digest/digest.js';
import { Indexer, buildChunks } from '../src/index/indexer.js';
import { assertLocalRoute } from '../src/llm/ollama.js';
import { messageLink } from '../src/links.js';
import { answerQuestion } from '../src/search/ask.js';
import { SearchService } from '../src/search/search.js';
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
  it('merges reposts across chats, cites sources and marks partial coverage', async () => {
    const llm = new FakeChat();
    const { markdown, meta } = await buildDigest({ pool, llm, day: DAY, now: new Date(clock.now()) });
    expect(meta.stories).toBeGreaterThan(0);
    expect(meta.periodMessages).toBe(8);
    const repostStory = markdown.split('### ').find((s) => s.includes('Новости конференции') && s.includes('Закрытый канал организаторов'));
    expect(repostStory).toBeTruthy();
    expect(repostStory).toMatch(/https:\/\/t\.me\/conf_news\/1/);
    expect(repostStory).toMatch(/https:\/\/t\.me\/c\/1000000011\/1/);
    expect(markdown).toMatch(/\*Вывод системы:\*/);
    expect(markdown).toMatch(/## Покрытие/);
    expect(markdown).toMatch(/Недоступный канал/);
    expect(markdown).toMatch(/\*\*частичный\*\*/);
    expect(markdown).not.toMatch(/Вчерашний разговор/);
    expect(meta.partial).toBe(true);
    const personal = markdown.split('### ').find((s) => s.includes('Иван (синтетический)'));
    expect(personal).toMatch(/важно: личный чат, есть твои сообщения/);
  });

  it('still produces an extractive draft without a model', async () => {
    const { markdown, meta } = await buildDigest({ pool, llm: null, day: DAY, now: new Date(clock.now()) });
    expect(meta.model).toBeNull();
    expect(markdown).toMatch(/Вывод системы отсутствует/);
    expect(markdown).toMatch(/локальная модель не использовалась/);
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
    expect(() => assertLocalRoute('http://192.168.88.14:30400/v1')).toThrow(/not local/);
    expect(() => assertLocalRoute('https://openrouter.ai/api')).toThrow(/not local/);
    expect(() => assertLocalRoute('http://192.168.88.14:30400', ['192.168.88.14'])).not.toThrow();
  });
});
