import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Indexer } from '../src/index/indexer.js';
import { buildMcpServer } from '../src/mcp.js';
import { SearchService } from '../src/search/search.js';
import { createTestDatabase } from './helpers/db.js';
import { FakeEmbedder } from './helpers/fake-models.js';
import { drain, standardAccount, startArchiver, virtualClock } from './helpers/harness.js';

let db;
let client;
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

beforeAll(async () => {
  db = await createTestDatabase();
  const clock = virtualClock(Date.now());
  const tg = standardAccount(clock);
  tg.addMessage('-4001', { text: 'Синтетическое решение: релиз мобильного приложения переносим на пятницу', sentAt: new Date(Date.now() - 3_600_000) }, { live: false });
  tg.addMessage('-1001000000002', { text: 'Канал сообщает: новая версия приложения выйдет в пятницу', sentAt: new Date(Date.now() - 1_800_000) }, { live: false });
  await drain(await startArchiver(db.pool, tg, clock));
  const embedder = new FakeEmbedder();
  await new Indexer({ pool: db.pool, embedder }).runOnce();
  const server = buildMcpServer({ pool: db.pool, search: new SearchService({ pool: db.pool, embedder }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  await db.drop();
});

describe('MCP tools', () => {
  it('lists the read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['archive_status', 'find_chats', 'get_message_context', 'search_messages']);
  });

  it('searches across chats with vectors and returns refs', async () => {
    const r = await call('search_messages', { query: 'когда выйдет релиз приложения?', limit: 5 });
    expect(r.mode).toBe('hybrid');
    const chats = new Set(r.results.map((x) => x.chat_id));
    expect(chats.has('-4001') && chats.has('-1001000000002')).toBe(true);
    expect(r.coverage).toMatch(/Покрытие/);
  });

  it('filters by chat and opens context by ref', async () => {
    const [chat] = await call('find_chats', { query: 'Малая' });
    expect(chat.chat_id).toBe('-4001');
    const r = await call('search_messages', { query: 'релиз приложения', chat_id: chat.chat_id });
    expect(r.results.every((x) => x.chat_id === '-4001')).toBe(true);
    const ref = r.results[0].messages.find((m) => !m.context_only).ref;
    const ctx = await call('get_message_context', { ref, before: 2, after: 2 });
    expect(ctx.messages.some((m) => m.target)).toBe(true);
  });

  it('reports archive status', async () => {
    const r = await call('archive_status');
    expect(r.summary.complete).toBe(true);
  });
});
