import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import { Archiver } from './archive/archiver.js';
import { createBackend } from './client/backend.js';
import { configPath, readConfigFile, resolveSettings } from './client/settings.js';
import { coverageReport, STATE_LABELS } from './archive/status.js';
import { createPool, migrate } from './db.js';
import { buildDigest } from './digest/digest.js';
import { Indexer } from './index/indexer.js';
import { parseArchiveRef, messageLink, markdownLink } from './links.js';
import { OllamaChat, OllamaEmbedder } from './llm/ollama.js';
import { answerQuestion } from './search/ask.js';
import { EDITS_LIMITATION, SearchService } from './search/search.js';
import { loadConfig, validateTelegramConfig } from './telegram/config.js';
import { formatLocal, localDate } from './time.js';

// Service logs carry counters and error codes only, never message text or titles.
function log(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

function requireUrl(url, name) {
  if (!url) throw new Error(`${name} is not configured (TI_DATABASE_URL or the role-specific variable)`);
  return url;
}

async function makeGateway(config, loginOptions = {}) {
  const missing = validateTelegramConfig(config);
  if (missing.length) throw new Error(`Missing Telegram configuration: ${missing.join(', ')}`);
  process.env.MTCUTE_LOG_LEVEL ??= '2';
  const { MtcuteGateway } = await import('./telegram/gateway.js');
  fs.mkdirSync(config.storeDir, { recursive: true, mode: 0o700 });
  return new MtcuteGateway({
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    phoneNumber: config.telegram.phoneNumber,
    sessionPath: config.sessionPath,
    proxy: config.telegram.proxy,
    loginOptions,
  });
}

function embedderFor(config) {
  if (!config.models.embeddingsEnabled) return null;
  return new OllamaEmbedder({ baseUrl: config.models.baseUrl, model: config.models.embedModel, approvedHosts: config.models.approvedHosts });
}

function chatFor(config, enabled = true) {
  if (!enabled) return null;
  return new OllamaChat({ baseUrl: config.models.baseUrl, model: config.models.chatModel, approvedHosts: config.models.approvedHosts });
}

async function waitForFile(file, timeoutMs = 10 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      fs.rmSync(file, { force: true });
      if (value) return value;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timed out waiting for the login code');
}

function printChatTable(chats, { redact }) {
  for (const c of chats) {
    const name = redact ? `${c.kind}:${c.chatId}` : `${c.title ?? c.chatId}`;
    const coverage = c.windowCovered ? 'окно покрыто' : 'окно не покрыто';
    const extra = [
      c.verifiedTo ? `сверено ${formatLocal(c.verifiedTo)}` : null,
      c.gapPending ? 'ожидает сверки' : null,
      c.floodWaitUntil ? `пауза до ${formatLocal(c.floodWaitUntil)}` : null,
      c.errorCode ? `ошибка ${c.errorCode}` : null,
      c.nextAttemptAt ? `повтор ${formatLocal(c.nextAttemptAt)}` : null,
    ].filter(Boolean).join(', ');
    console.log(`${(STATE_LABELS[c.state] ?? c.state).padEnd(16)} ${coverage.padEnd(15)} ${String(c.archived).padStart(6)} сообщ.  ${name}${extra ? `  (${extra})` : ''}`);
  }
}

function printSummary(s) {
  const c = s.chats;
  console.log(`Аккаунт: ${s.account}; окно ${s.windowDays} сут. (с ${formatLocal(s.windowFrom)})`);
  console.log(`Чаты: всего ${c.total}, доступно ${c.available}, окно покрыто ${c.covered} (${(c.coveredShare * 100).toFixed(1)}%), недоступно ${c.unavailable}`);
  console.log(`Состояния: ${Object.entries(c.byState).map(([k, v]) => `${STATE_LABELS[k] ?? k} ${v}`).join(', ')}`);
  console.log(`По типам: ${Object.entries(c.byKind).map(([k, v]) => `${k} ${v.covered}/${v.total}`).join(', ')}`);
  console.log(`Ожидают сверки: ${c.gapPending}; давно не сверялись: ${c.stale}`);
  console.log(`Сообщения: всего ${s.messages.total}, в окне ${s.messages.inWindow}, принято онлайн ${s.messages.live}, archive_seq ${s.messages.maxSeq}`);
  const rl = s.rateLimit;
  console.log(`Темп: интервал ${rl.intervalMs ?? '—'} мс, FLOOD_WAIT всего ${rl.floodCount}${rl.pausedUntil ? `, пауза до ${formatLocal(rl.pausedUntil)}` : ''}${rl.lastFlood ? `, последний ${rl.lastFlood.seconds} с в ${formatLocal(rl.lastFlood.at)}` : ''}`);
  console.log(`Служба: ${s.heartbeat ? `последний сигнал ${formatLocal(s.heartbeat.at)}` : 'сигналов нет'}`);
  if (s.indexer) console.log(`Индекс: позиция ${s.indexer.lastSeq}, отставание ${s.indexer.lag}, фрагментов ${s.indexer.chunks}, без embeddings ${s.indexer.pendingEmbeddings}`);
  console.log(`Итог: ${s.complete ? 'окно покрыто для всех доступных чатов' : 'покрытие неполное'}`);
  for (const l of s.limitations) console.log(`Ограничение: ${l}`);
}

export function buildProgram() {
  const program = new Command();
  program.name('telegram-insights').description('Private Telegram archive in PostgreSQL with search and daily digests')
    .option('--remote <ssh-host>', 'read through MCP over SSH on this host (env TI_REMOTE)')
    .option('--remote-command <cmd>', 'remote command that serves MCP (env TI_REMOTE_COMMAND)')
    .option('--mcp-command <cmd>', 'any local command that serves MCP on stdio (env TI_MCP_COMMAND)')
    .option('--db-url <url>', 'reader PostgreSQL URL for direct mode (env TI_READER_DATABASE_URL)')
    .option('--db-url-pass <entry>', 'pass entry with the reader PostgreSQL URL (env TI_READER_DATABASE_URL_PASS)')
    .option('--ollama-url <url>', 'local Ollama for query embeddings in direct mode (env TI_OLLAMA_URL)')
    .option('--direct', 'ignore remote/MCP settings and query PostgreSQL directly')
    .option('--config <path>', 'user config file (env TELEGRAM_INSIGHTS_CONFIG)');

  // Read commands go through the configured backend: local PostgreSQL or MCP.
  const withBackend = async (fn) => {
    const backend = createBackend(resolveSettings(program.opts()));
    try {
      return await fn(backend);
    } finally {
      await backend.close();
    }
  };

  program.command('migrate').description('Apply database migrations (owner role)').action(async () => {
    const config = loadConfig();
    const pool = createPool(requireUrl(config.db.owner, 'TI_OWNER_DATABASE_URL'), { max: 1 });
    try {
      const applied = await migrate(pool, { log: (m) => console.log(m) });
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is up to date');
    } finally {
      await pool.end();
    }
  });

  program.command('login').description('Authorize the separate Telegram Insights session')
    .option('--qr', 'log in by scanning a QR code')
    .option('--code-file <path>', 'read the login code from this file instead of the terminal')
    .option('--sms', 'ask Telegram to resend the code by SMS')
    .option('--password-pass <entry>', 'read the Telegram cloud password (2FA) from this pass entry')
    .option('--qr-file <path>', 'with --qr: write the login URL to this owner-only file for approval by another session')
    .action(async (opts) => {
      const config = loadConfig();
      const loginOptions = { useQr: Boolean(opts.qr), forceSms: Boolean(opts.sms) };
      if (opts.passwordPass) {
        const { execFileSync } = await import('node:child_process');
        loginOptions.passwordProvider = async () => execFileSync('pass', ['show', opts.passwordPass], { encoding: 'utf8' }).split('\n')[0];
      }
      if (opts.qrFile) {
        loginOptions.useQr = true;
        loginOptions.qrUrlHandler = (url) => {
          fs.writeFileSync(opts.qrFile, url, { mode: 0o600 });
          console.log(`Login token written to ${opts.qrFile}`);
        };
      }
      if (opts.codeFile) {
        loginOptions.codeProvider = async () => {
          console.log(`Waiting for the login code in ${opts.codeFile}`);
          return waitForFile(opts.codeFile);
        };
      }
      const gateway = await makeGateway(config, loginOptions);
      try {
        const self = await gateway.login();
        console.log(`Authorized account ${self.id}; session stored in ${config.sessionPath}`);
      } finally {
        await gateway.destroy();
      }
    });

  program.command('run').description('Run the archiver and indexer service').action(async () => {
    const config = loadConfig();
    const archivePool = createPool(requireUrl(config.db.archiver, 'TI_ARCHIVER_DATABASE_URL'), { max: 4, applicationName: 'telegram-insights-archiver' });
    const indexPool = createPool(requireUrl(config.db.indexer, 'TI_INDEXER_DATABASE_URL'), { max: 2, applicationName: 'telegram-insights-indexer' });
    const gateway = await makeGateway(config);
    const archiver = new Archiver({
      pool: archivePool,
      gateway,
      options: config.archive,
      limiterOptions: config.limiter,
      log: (event, detail) => log(event, detail),
    });
    let stopping = false;
    const indexer = new Indexer({ pool: indexPool, embedder: embedderFor(config), options: { timeZone: config.timeZone }, log: (event, detail) => log(event, detail) });
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      log('stopping', { signal });
      archiver.stop();
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    try {
      const self = await gateway.connect();
      await archiver.init();
      await archiver.acquireLease();
      log('started', { account: self.id, windowDays: config.archive.windowDays, embeddings: config.models.embeddingsEnabled });
      await archiver.startLive();
      const indexing = indexer.loop({ shouldStop: () => stopping });
      await archiver.run();
      stopping = true;
      await indexing;
    } finally {
      await archiver.releaseLease();
      await gateway.destroy().catch(() => {});
      await archivePool.end();
      await indexPool.end();
      log('stopped', { leaseLost: Boolean(archiver.leaseLost) });
      if (archiver.leaseLost) process.exitCode = 75;
    }
  });

  program.command('index').description('Project new archive records into the search index once')
    .option('--no-embeddings', 'skip embedding computation')
    .action(async (opts) => {
      const config = loadConfig();
      const pool = createPool(requireUrl(config.db.indexer, 'TI_INDEXER_DATABASE_URL'), { max: 2 });
      try {
        const indexer = new Indexer({ pool, embedder: opts.embeddings ? embedderFor(config) : null, options: { timeZone: config.timeZone } });
        console.log(JSON.stringify(await indexer.runOnce()));
      } finally {
        await pool.end();
      }
    });

  program.command('search').description('Search all archived chats by meaning and words')
    .argument('<query...>')
    .option('--limit <n>', 'number of fragments', '8')
    .option('--from <date>', 'from date (YYYY-MM-DD)')
    .option('--to <date>', 'to date (YYYY-MM-DD, exclusive)')
    .option('--chat <id>', 'only this chat (id from `chats`)')
    .option('--json', 'machine-readable output')
    .action((words, opts) => withBackend(async (b) => {
      const r = await b.searchMessages({
        query: words.join(' '), limit: Number(opts.limit), from: opts.from, to: opts.to, chat_id: opts.chat,
      });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      for (const [i, x] of r.results.entries()) {
        console.log(`\n[${i + 1}] «${x.chat ?? x.chat_id}» (${x.chat_kind}, chat ${x.chat_id}) ${x.period} [${x.matched_by.join('+')}]`);
        for (const m of x.messages) {
          console.log(`  ${m.context_only ? '·' : '-'} ${m.at} ${m.sender ?? ''}: ${(m.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}  ${m.url ?? m.ref}`);
        }
      }
      if (!r.results.length) console.log('Ничего не найдено.');
      console.log(`\nРежим: ${r.mode}. ${r.coverage}\n${r.note}`);
    }));

  program.command('context').alias('show').description('Read a message and its neighbours by ref tgi:<chat_id>/<message_id>')
    .argument('<ref>')
    .option('--before <n>', 'messages before', '5')
    .option('--after <n>', 'messages after', '5')
    .option('--json', 'machine-readable output')
    .action((ref, opts) => withBackend(async (b) => {
      const r = await b.messageContext({ ref, before: Number(opts.before), after: Number(opts.after) });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`«${r.chat ?? r.chat_id}» (${r.chat_kind})`);
      for (const m of r.messages) console.log(`${m.target ? '>' : ' '} ${m.at} ${m.sender ?? ''}: ${m.text}  ${m.url ?? m.ref}`);
      console.log(`\n${r.note}`);
    }));

  program.command('chats').description('Find archived chats by title or username')
    .argument('<query...>')
    .option('--limit <n>', 'number of chats', '20')
    .option('--json', 'machine-readable output')
    .action((words, opts) => withBackend(async (b) => {
      const r = await b.findChats({ query: words.join(' '), limit: Number(opts.limit) });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      for (const c of r) console.log(`${c.chat_id.padStart(16)}  ${(c.kind ?? '').padEnd(10)} ${(c.state ?? '').padEnd(12)} ${c.newest ?? '—'}  ${c.title ?? ''}${c.username ? ` @${c.username}` : ''}`);
      if (!r.length) console.log('Чаты не найдены.');
    }));

  program.command('status').description('Coverage of the archive (metadata only)')
    .option('--json', 'machine-readable output')
    .option('--chats', 'list every chat (direct mode only)')
    .option('--redact', 'with --chats: show chat ids instead of titles')
    .option('--check', 'exit with code 2 if the service heartbeat is older than 10 minutes')
    .action((opts) => withBackend(async (b) => {
      const { summary } = await b.archiveStatus();
      if (!summary) return console.log('Архив пуст: служба ещё не запускалась.');
      if (opts.check) {
        const at = summary.heartbeat?.at ? new Date(summary.heartbeat.at) : null;
        const stale = !at || Date.now() - at.getTime() > 10 * 60_000;
        console.log(stale ? `UNHEALTHY: heartbeat ${at ? formatLocal(at) : 'missing'}` : `OK: heartbeat ${formatLocal(at)}`);
        if (stale) process.exitCode = 2;
        return undefined;
      }
      let chats;
      if (opts.chats) {
        if (!b.pool) throw new Error('--chats needs direct mode (--direct with a reader database URL)');
        chats = (await coverageReport(b.pool, { windowDays: summary.windowDays })).chats;
      }
      if (opts.json) {
        return console.log(JSON.stringify({ summary, chats: chats?.map((c) => (opts.redact ? { ...c, title: null, username: null } : c)) }, null, 2));
      }
      printSummary(summary);
      if (chats) printChatTable(chats, { redact: opts.redact });
      return undefined;
    }));

  program.command('config').description('Show the resolved connection settings (no secrets) or create the user config')
    .option('--init', 'write the user config file from the given global options')
    .action((opts) => {
      const global = program.opts();
      const file = global.config ?? configPath();
      if (opts.init) {
        const current = readConfigFile(file);
        const next = { ...current };
        if (global.remote) next.remote = global.remote;
        if (global.remoteCommand) next.remoteCommand = global.remoteCommand;
        if (global.mcpCommand) next.mcpCommand = global.mcpCommand;
        if (global.dbUrlPass) next.databaseUrlPass = global.dbUrlPass;
        if (global.ollamaUrl) next.ollamaUrl = global.ollamaUrl;
        if (global.dbUrl) throw new Error('Do not store database URLs with passwords in the config; use --db-url-pass <pass entry>');
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        console.log(`Written ${file}`);
      }
      const s = resolveSettings(global, process.env, { readPass: () => '(from pass)' });
      console.log(JSON.stringify({
        configFile: s.configFile,
        mode: s.mode,
        command: s.mode === 'mcp' ? s.command.join(' ') : undefined,
        database: s.mode === 'direct' ? (s.databaseUrl ? s.databaseUrl.replace(/\/\/([^:@]+):[^@]*@/, '//$1:***@') : 'not configured') : undefined,
        ollamaUrl: s.mode === 'direct' ? s.ollamaUrl : undefined,
      }, null, 2));
    });

  program.command('ask').description('Answer a question from several chats with sources (local model)')
    .argument('<question...>')
    .option('--limit <n>', 'number of source fragments', '8')
    .option('--no-llm', 'only list the sources')
    .action(async (words, opts) => {
      const config = loadConfig();
      const pool = createPool(requireUrl(config.db.reader, 'TI_READER_DATABASE_URL'), { max: 2 });
      try {
        const service = new SearchService({ pool, embedder: embedderFor(config), windowDays: config.archive.windowDays });
        const { text } = await answerQuestion({ search: service, llm: chatFor(config, opts.llm), question: words.join(' '), limit: Number(opts.limit) });
        console.log(text);
      } finally {
        await pool.end();
      }
    });

  program.command('digest').description('Write a local Markdown draft of the daily digest')
    .option('--date <YYYY-MM-DD>', 'calendar day (default: yesterday)')
    .option('--out <path>', 'output file')
    .option('--stdout', 'print instead of writing a file')
    .option('--force', 'overwrite an existing draft')
    .option('--skip-existing', 'exit successfully if the draft already exists (for schedules)')
    .option('--no-llm', 'extractive draft without the local model')
    .action(async (opts) => {
      const config = loadConfig();
      const day = opts.date ?? localDate(new Date(Date.now() - 86_400_000), config.timeZone);
      const pool = createPool(requireUrl(config.db.reader, 'TI_READER_DATABASE_URL'), { max: 2 });
      try {
        const { markdown, meta } = await buildDigest({ pool, llm: chatFor(config, opts.llm), day, timeZone: config.timeZone, windowDays: config.archive.windowDays });
        if (opts.stdout) {
          console.log(markdown);
          return;
        }
        const out = opts.out ?? path.join(config.digestDir, `${day}.md`);
        if (fs.existsSync(out) && opts.skipExisting && !opts.force) {
          console.log(JSON.stringify({ skipped: out, day }));
          return;
        }
        if (fs.existsSync(out) && !opts.force) throw new Error(`${out} already exists; drafts are not updated automatically (use --force)`);
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
        fs.writeFileSync(out, markdown, { mode: 0o600 });
        console.log(JSON.stringify({ written: out, ...meta }));
      } finally {
        await pool.end();
      }
    });

  program.command('mcp').description('Serve read-only MCP tools (search, context, chats, status) over stdio')
    .action(async () => {
      const config = loadConfig();
      const pool = createPool(requireUrl(config.db.reader, 'TI_READER_DATABASE_URL'), { max: 3, applicationName: 'telegram-insights-mcp' });
      const { runMcpStdio } = await import('./mcp.js');
      const search = new SearchService({ pool, embedder: embedderFor(config), windowDays: config.archive.windowDays });
      await runMcpStdio({ pool, search, windowDays: config.archive.windowDays });
    });

  program.command('doctor').description('Check database roles, schema, models and the Telegram session (no message content)')
    .action(async () => {
      const config = loadConfig();
      const checks = [];
      for (const [role, url] of Object.entries(config.db)) {
        if (!url) {
          checks.push([`db:${role}`, 'not configured']);
          continue;
        }
        const pool = createPool(url, { max: 1 });
        try {
          const { rows: [r] } = await pool.query("SELECT current_user, (SELECT count(*) FROM pg_extension WHERE extname = 'vector') AS vector, to_regclass('archive.messages') IS NOT NULL AS schema");
          checks.push([`db:${role}`, `ok user=${r.current_user} schema=${r.schema} vector=${r.vector === '1'}`]);
        } catch (error) {
          checks.push([`db:${role}`, `error ${error.code ?? error.message}`]);
        } finally {
          await pool.end();
        }
      }
      try {
        const res = await fetch(new URL('/api/tags', config.models.baseUrl));
        const names = (await res.json()).models.map((m) => m.name);
        checks.push(['model:embed', names.includes(config.models.embedModel) ? `ok ${config.models.embedModel}` : `missing ${config.models.embedModel}`]);
        checks.push(['model:chat', names.includes(config.models.chatModel) ? `ok ${config.models.chatModel}` : `missing ${config.models.chatModel}`]);
      } catch (error) {
        checks.push(['models', `unreachable ${error.message}`]);
      }
      checks.push(['session', fs.existsSync(config.sessionPath) ? `present ${config.sessionPath}` : 'absent (run login)']);
      for (const [name, result] of checks) console.log(`${name.padEnd(14)} ${result}`);
    });

  return program;
}
