import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Indexer } from '../src/index/indexer.js';
import { createTestDatabase } from './helpers/db.js';
import { drain, standardAccount, startArchiver, virtualClock } from './helpers/harness.js';

const run = promisify(execFile);
const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'telegram-insights.js');
let db;
let env;
let tmp;

beforeAll(async () => {
  db = await createTestDatabase();
  const clock = virtualClock(Date.now());
  const tg = standardAccount(clock);
  tg.addMessage('-4001', { text: 'Синтетическое обсуждение релиза мобильного приложения', sentAt: new Date(Date.now() - 3_600_000) }, { live: false });
  const archiver = await startArchiver(db.pool, tg, clock);
  await drain(archiver);
  await new Indexer({ pool: db.pool, embedder: null }).runOnce();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-cli-'));
  env = {
    ...process.env,
    TI_DATABASE_URL: db.url,
    TI_DISABLE_EMBEDDINGS: '1',
    TELEGRAM_INSIGHTS_STORE: tmp,
  };
});

afterAll(async () => {
  await db.drop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cli = (...args) => run('node', [bin, ...args], { env });

describe('command line', () => {
  it('migrate is idempotent', async () => {
    const { stdout } = await cli('migrate');
    expect(stdout).toMatch(/up to date/);
  });

  it('status prints coverage without chat titles when redacted', async () => {
    const { stdout } = await cli('status', '--chats', '--redact');
    expect(stdout).toMatch(/окно покрыто для всех доступных чатов/);
    expect(stdout).not.toMatch(/Малая группа/);
    const json = JSON.parse((await cli('status', '--json')).stdout);
    expect(json.summary.chats.covered).toBe(json.summary.chats.available);
  });

  it('search returns references that show can open', async () => {
    const { stdout } = await cli('search', 'релиз', 'мобильного', 'приложения', '--json');
    const found = JSON.parse(stdout);
    expect(found.mode).toBe('text');
    const message = found.results[0].messages.find((m) => !m.context);
    expect(message.link.ref).toMatch(/^tgi:-4001\//);
    const shown = await cli('show', message.link.ref);
    expect(shown.stdout).toMatch(/релиза мобильного приложения/);
  });

  it('digest writes an owner-only local draft and refuses to overwrite it', async () => {
    const day = new Date(Date.now() - 3_600_000).toISOString().slice(0, 10);
    const out = path.join(tmp, 'digest.md');
    const first = await cli('digest', '--date', day, '--no-llm', '--out', out);
    expect(JSON.parse(first.stdout).written).toBe(out);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    await expect(cli('digest', '--date', day, '--no-llm', '--out', out)).rejects.toThrow(/already exists/);
  });

  it('ask without a model lists sources', async () => {
    const { stdout } = await cli('ask', 'релиз', 'приложения', '--no-llm');
    expect(stdout).toMatch(/## Источники/);
    expect(stdout).toMatch(/Модель ответа не настроена/);
  });
});
