#!/usr/bin/env node
// Known-item retrieval check for search quality. Each line of the query file
// names a message and a query that should find it:
//   <chat_id>\t<message_id>\t<kind>\t<query>
// kind groups the metrics (e.g. "sem" for paraphrases, "kw" for keywords).
// The query file describes real messages, so it lives outside Git
// (default ~/.local/share/telegram-insights/eval/queries.tsv, mode 0600).
// Direct mode: needs TI_READER_DATABASE_URL and the embedding route settings.
// Usage: node scripts/eval-search.mjs [queries.tsv] [--limit 10] [--verbose]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveSettings } from '../src/client/settings.js';
import { createPool } from '../src/db.js';
import { createEmbedder } from '../src/llm/models.js';
import { SearchService } from '../src/search/search.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit')
  ?? join(homedir(), '.local/share/telegram-insights/eval/queries.tsv');
const limit = Number(value('--limit', 10));

const cases = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
  const [chatId, messageId, kind, query] = l.split('\t');
  return { chatId, messageId, kind, query };
});

const url = process.env.TI_READER_DATABASE_URL;
if (!url) throw new Error('TI_READER_DATABASE_URL is required');
const pool = createPool(url, { max: 1, applicationName: 'telegram-insights-eval' });
const search = new SearchService({ pool, embedder: createEmbedder(resolveSettings({ direct: true }).models) });

const results = [];
try {
  for (const c of cases) {
    const started = Date.now();
    const found = await search.search(c.query, { limit });
    const index = found.results.findIndex((hit) => String(hit.chatId) === c.chatId
      && hit.messages.some((m) => String(m.messageId) === c.messageId && !m.context));
    results.push({ ...c, rank: index < 0 ? null : index + 1, ms: Date.now() - started });
  }
} finally {
  await pool.end();
}

for (const kind of [...new Set(results.map((r) => r.kind))]) {
  const group = results.filter((r) => r.kind === kind);
  const hits = (k) => group.filter((r) => r.rank && r.rank <= k).length;
  const mrr = group.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / group.length;
  const p50 = group.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(group.length / 2)];
  console.log(`${kind}: n=${group.length} hit@1=${hits(1)} hit@3=${hits(3)} hit@${limit}=${hits(limit)} MRR=${mrr.toFixed(2)} p50=${p50}ms`);
}
// Verbose output names chats and message ids only, never message text.
if (flag('--verbose')) {
  for (const r of results) if (!r.rank || r.rank > 3) console.log(`${r.rank ?? 'miss'}\t${r.kind}\ttgi:${r.chatId}/${r.messageId}`);
}
