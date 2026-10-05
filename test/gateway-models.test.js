import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createChat, createEmbedder } from '../src/llm/models.js';
import { modelSettings } from '../src/telegram/config.js';

let server;
let url;
const seen = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body);
      seen.push({ path: req.url, auth: req.headers.authorization ?? null, model: json.model });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/embeddings') {
        res.end(JSON.stringify({ data: json.input.map((_, i) => ({ index: i, embedding: new Array(1024).fill(i) })).reverse() }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});

afterAll(() => new Promise((r) => server.close(r)));

describe('LLM router models', () => {
  it('requires an explicit router URL', () => {
    const models = modelSettings({}, {});
    expect(models.provider).toBe('gateway');
    expect(() => createEmbedder(models)).toThrow(/LLM_ROUTER_BASE_URL/);
  });

  it('takes the URL from env before the user config', () => {
    expect(modelSettings({ LLM_ROUTER_BASE_URL: 'http://env/v1' }, { llmRouterUrl: 'http://file/v1' }).llmRouterUrl).toBe('http://env/v1');
    expect(modelSettings({}, { llmRouterUrl: 'http://file/v1' }).llmRouterUrl).toBe('http://file/v1');
  });

  it('embeds in input order and talks to the configured aliases', async () => {
    const models = modelSettings({ LLM_ROUTER_BASE_URL: url, LLM_ROUTER_API_KEY: 'k' }, {});
    const embedder = createEmbedder(models);
    const vectors = await embedder.embed(['a', 'b', 'c']);
    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(embedder.id).toBe('gateway:telegram-insights-embedding');
    const reply = await createChat(models).complete({ prompt: 'x', json: true });
    expect(JSON.parse(reply)).toEqual({ ok: true });
    expect(seen.map((s) => s.model)).toEqual(['telegram-insights-embedding', 'telegram-insights-chat']);
    expect(seen[0].auth).toBe('Bearer k');
  });
});
