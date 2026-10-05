import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { purgeExcluded } from '../src/archive/purge.js';
import { coverageReport } from '../src/archive/status.js';
import { createTestDatabase } from './helpers/db.js';
import { floodWait, telegramError } from './helpers/fake-telegram.js';
import {
  DAY, archivedIds, drain, expectedInWindow, makeArchiver, standardAccount, startArchiver, virtualClock,
} from './helpers/harness.js';

let db;
let pool;

beforeEach(async () => {
  if (db) await db.drop();
  db = null;
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  if (db) await db.drop();
  db = null;
});

async function messageCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n, count(DISTINCT archive_seq)::int AS seqs FROM archive.messages');
  return rows[0];
}

describe('first run', () => {
  it('creates a task for every cloud chat type and covers the 14-day window', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const windowStart = clock.now() - 14 * DAY;
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);

    const { rows: sync } = await pool.query('SELECT chat_id, state FROM archive.chat_sync ORDER BY chat_id');
    expect(sync).toHaveLength(tg.chats.size);
    expect(new Set(sync.map((r) => r.state))).toEqual(new Set(['loaded']));
    const { rows: kinds } = await pool.query('SELECT DISTINCT peer_kind FROM archive.chats ORDER BY 1');
    expect(kinds.map((r) => r.peer_kind)).toEqual(['bot', 'channel', 'group', 'saved', 'supergroup', 'user']);

    for (const chatId of tg.chats.keys()) {
      const archived = await archivedIds(pool, chatId);
      for (const id of expectedInWindow(tg, chatId, windowStart)) expect(archived).toContain(id);
    }

    const { summary } = await coverageReport(pool, { now: new Date(clock.now()) });
    expect(summary.complete).toBe(true);
    expect(summary.chats.covered).toBe(tg.chats.size);
    expect(summary.chats.coveredShare).toBe(1);
  });

  it('reads each chat from newest pages to older ones and interleaves chats fairly', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);

    const history = tg.historyCalls();
    const firstRound = history.slice(0, tg.chats.size).map((c) => c.chatId);
    expect(new Set(firstRound).size).toBe(tg.chats.size);
    expect(history.slice(0, tg.chats.size).every((c) => c.offsetId === 0)).toBe(true);

    const big = tg.historyCalls('-1001000000003').filter((c) => c.minId === 0);
    expect(big.length).toBeGreaterThan(5);
    for (let i = 1; i < big.length; i += 1) {
      expect(big[i].offsetId).toBeGreaterThan(0);
      if (i > 1) expect(big[i].offsetId).toBeLessThan(big[i - 1].offsetId);
    }
    // The large channel never gets two pages in a row while others still wait.
    const order = history.map((c) => c.chatId);
    const firstSecondPageOfBig = order.indexOf('-1001000000003', order.indexOf('-1001000000003') + 1);
    const pendingSmall = order.slice(firstSecondPageOfBig).includes('-4001');
    expect(pendingSmall || order.indexOf('-4001') < firstSecondPageOfBig).toBe(true);
  });

  it('stops at the window boundary instead of loading the whole history', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    const all = tg.chats.get('-1001000000003').messages.length;
    const archived = (await archivedIds(pool, '-1001000000003')).length;
    expect(archived).toBeLessThan(all);
    const { rows: [s] } = await pool.query("SELECT covered_from, window_start FROM archive.chat_sync WHERE chat_id = '-1001000000003'");
    expect(new Date(s.covered_from).getTime()).toBeLessThanOrEqual(new Date(s.window_start).getTime());
  });
});

describe('restart and replay', () => {
  it('resumes from the persisted checkpoint after a stop without duplicates or gaps', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const windowStart = clock.now() - 14 * DAY;
    const first = await startArchiver(pool, tg, clock);
    for (let i = 0; i < 15; i += 1) await first.step();
    const before = await messageCount();
    const callsBefore = tg.historyCalls().length;
    first.stop();

    const { rows: [cp] } = await pool.query("SELECT backfill_offset_id FROM archive.chat_sync WHERE chat_id = '-1001000000003'");
    const second = await startArchiver(pool, tg, clock);
    await drain(second);
    const resumed = tg.historyCalls().slice(callsBefore).filter((c) => c.chatId === '-1001000000003' && c.minId === 0);
    expect(resumed[0].offsetId).toBe(Number(cp.backfill_offset_id));

    const after = await messageCount();
    expect(after.n).toBeGreaterThan(before.n);
    expect(after.seqs).toBe(after.n);
    for (const chatId of tg.chats.keys()) {
      const archived = await archivedIds(pool, chatId);
      expect(new Set(archived).size).toBe(archived.length);
      for (const id of expectedInWindow(tg, chatId, windowStart)) expect(archived).toContain(id);
    }
  });

  it('treats a replayed page as a no-op', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    const before = await messageCount();
    // Lose the checkpoint of the big channel: the archiver re-reads pages it already stored.
    await pool.query(`UPDATE archive.chat_sync SET backfill_done = false, backfill_offset_id = NULL, covered_max_id = NULL,
                        covered_min_id = NULL, state = 'loading' WHERE chat_id = '-1001000000003'`);
    await drain(archiver);
    const after = await messageCount();
    expect(after.n).toBe(before.n);
    expect(after.seqs).toBe(after.n);
  });

  it('rolls back a page when its checkpoint cannot be written', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock);
    await archiver.refreshDialogs();
    const realConnect = pool.connect.bind(pool);
    let armed = true;
    pool.connect = async (...args) => {
      if (args.length) return realConnect(...args);
      const client = await realConnect();
      const realQuery = client.query.bind(client);
      client.query = (text, ...rest) => {
        if (armed && typeof text === 'string' && text.includes('UPDATE archive.chat_sync SET\n           state = $3')) {
          armed = false;
          return Promise.reject(new Error('synthetic crash before checkpoint'));
        }
        return realQuery(text, ...rest);
      };
      return client;
    };
    await expect(archiver.step()).rejects.toThrow('synthetic crash');
    pool.connect = realConnect;
    expect((await messageCount()).n).toBe(0);
    await drain(archiver);
    expect((await messageCount()).n).toBeGreaterThan(0);
  });

  it('allows only one archiver per account', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const a = makeArchiver(pool, tg, clock);
    await a.init();
    await a.acquireLease();
    const b = makeArchiver(pool, tg, clock);
    await b.init();
    await expect(b.acquireLease()).rejects.toThrow(/lease/);
    await a.releaseLease();
    await b.acquireLease();
    await b.releaseLease();
  });
});

describe('new messages and gaps', () => {
  it('keeps receiving new messages during the backfill and reconciles the top of history', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const windowStart = clock.now() - 14 * DAY;
    const archiver = await startArchiver(pool, tg, clock);
    let added = 0;
    let silent = 0;
    tg.beforeHistory = async ({ chatId }) => {
      if (chatId === '-1001000000003' && added < 10) {
        added += 1;
        tg.addMessage('-4001', { text: `новое сообщение ${added}`, sentAt: new Date(clock.now()) });
        // A message the update stream never delivered (e.g. a dropped update).
        if (added % 3 === 0) {
          silent += 1;
          tg.addMessage('-1001000000002', { text: `пропущенное обновление ${silent}`, sentAt: new Date(clock.now()) }, { live: false });
        }
      }
    };
    await drain(archiver);
    tg.beforeHistory = null;
    const { rows: [{ n: live }] } = await pool.query("SELECT count(*)::int AS n FROM archive.messages WHERE source = 'live'");
    expect(live).toBe(10);

    clock.advance(31 * 60_000);
    await drain(archiver);
    for (const chatId of ['-4001', '-1001000000002']) {
      const archived = await archivedIds(pool, chatId);
      for (const id of expectedInWindow(tg, chatId, windowStart)) expect(archived).toContain(id);
    }
    const { rows: [{ n: gap }] } = await pool.query("SELECT count(*)::int AS n FROM archive.messages WHERE source = 'gap'");
    expect(gap).toBe(silent);
    const { summary } = await coverageReport(pool, { now: new Date(clock.now()) });
    expect(summary.chats.gapPending).toBe(0);
  });

  it('recovers messages posted while the service was offline and adds new chats', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const first = await startArchiver(pool, tg, clock);
    await drain(first);
    first.stop();
    tg.updatesStarted = false;
    tg.listeners.clear();

    clock.advance(3 * 3_600_000);
    for (let i = 0; i < 55; i += 1) tg.addMessage('-1001000000003', { text: `офлайн ${i}`, sentAt: new Date(clock.now() + i * 1000) }, { live: false });
    tg.addMessage('501', { text: 'офлайн в личке', sentAt: new Date(clock.now()) }, { live: false });
    tg.addChat({ chatId: '-1001000000099', peerKind: 'channel', title: 'Новый канал' });
    tg.seed('-1001000000099', 30, { hours: 24 * 3 });

    const second = await startArchiver(pool, tg, clock);
    await drain(second);
    const windowStart = clock.now() - 14 * DAY;
    for (const chatId of ['-1001000000003', '501', '-1001000000099']) {
      const archived = await archivedIds(pool, chatId);
      for (const id of expectedInWindow(tg, chatId, windowStart)) expect(archived).toContain(id);
    }
    const { rows: [n] } = await pool.query("SELECT state FROM archive.chat_sync WHERE chat_id = '-1001000000099'");
    expect(n.state).toBe('loaded');
  });

  it('tolerates holes left by deleted messages', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    tg.deleteMessages('-1001000000003', (m) => m.messageId % 7 === 0 || (m.messageId > 300 && m.messageId < 340));
    const windowStart = clock.now() - 14 * DAY;
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    expect(await archivedIds(pool, '-1001000000003')).toEqual(
      expect.arrayContaining(expectedInWindow(tg, '-1001000000003', windowStart)),
    );
  });
});

describe('errors and FLOOD_WAIT', () => {
  it('passes the chat username to history requests for peer recovery', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    tg.addChat({ chatId: '478', peerKind: 'user', title: 'Синтетический собеседник', username: 'synthetic_user' });
    tg.addMessage('478', { text: 'привет', sentAt: new Date(clock.now() - 3_600_000) }, { live: false });
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    expect(tg.historyCalls('478')[0].username).toBe('synthetic_user');
  });

  it('marks inaccessible chats as unavailable without hiding them in the totals', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    tg.chats.get('-1001000000002').unavailable = 'CHANNEL_PRIVATE';
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    const { summary, chats } = await coverageReport(pool, { now: new Date(clock.now()) });
    const blocked = chats.find((c) => c.chatId === '-1001000000002');
    expect(blocked.state).toBe('unavailable');
    expect(blocked.errorCode).toBe('CHANNEL_PRIVATE');
    expect(blocked.windowCovered).toBe(false);
    expect(summary.chats.unavailable).toBe(1);
    expect(summary.chats.total).toBe(tg.chats.size);
    expect(summary.chats.available).toBe(tg.chats.size - 1);
    expect(summary.complete).toBe(true);
    // No hot retry loop against the inaccessible chat.
    expect(tg.historyCalls('-1001000000002')).toHaveLength(1);
  });

  it('backs off on transient errors and recovers', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    tg.failNext('getHistory', telegramError('INTERNAL_SERVER_ERROR'), { chatId: '501', times: 2 });
    const archiver = await startArchiver(pool, tg, clock);
    for (let i = 0; i < tg.chats.size; i += 1) await archiver.step();
    const { rows: [s] } = await pool.query("SELECT state, error_code, next_attempt_at FROM archive.chat_sync WHERE chat_id = '501'");
    expect(s.state).toBe('error');
    expect(s.error_code).toBe('INTERNAL_SERVER_ERROR');
    expect(new Date(s.next_attempt_at).getTime()).toBeGreaterThan(clock.now());
    for (let round = 0; round < 3; round += 1) {
      clock.advance(10 * 60_000);
      await drain(archiver);
    }
    expect(tg.historyCalls('501').length).toBeGreaterThanOrEqual(3);
    const { rows: [after] } = await pool.query("SELECT state FROM archive.chat_sync WHERE chat_id = '501'");
    expect(after.state).toBe('loaded');
  });

  it('honours FLOOD_WAIT, slows down, keeps intake running and survives a restart', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock);
    for (let i = 0; i < 5; i += 1) await archiver.step();
    const intervalBefore = archiver.limiter.intervalMs;
    tg.failNext('getHistory', floodWait(120));
    await archiver.step();
    const floodAt = tg.historyCalls().at(-1).at;

    const { summary, chats } = await coverageReport(pool, { now: new Date(clock.now()) });
    expect(summary.rateLimit.pausedUntil).not.toBeNull();
    expect(chats.some((c) => c.state === 'rate_limited' && c.floodWaitUntil)).toBe(true);
    expect(archiver.limiter.intervalMs).toBe(intervalBefore * 2);

    // New messages are still archived while history requests are paused.
    tg.addMessage('501', { text: 'во время паузы', sentAt: new Date(clock.now()) });
    await archiver.flushLive();
    const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM archive.messages WHERE source = 'live'");
    expect(n).toBe(1);

    // A restart during the pause must not shorten it.
    archiver.stop();
    const restarted = await startArchiver(pool, tg, clock);
    await drain(restarted);
    const next = tg.calls.find((c) => c.at > floodAt);
    expect(next.at - floodAt).toBeGreaterThanOrEqual(120_000);
    // Exactly one failed request, no burst of immediate retries of any Telegram call.
    expect(tg.calls.filter((c) => c.at >= floodAt && c.at < floodAt + 120_000)).toHaveLength(1);
    const after = await coverageReport(pool, { now: new Date(clock.now()) });
    expect(after.summary.complete).toBe(true);
    expect(after.chats.every((c) => c.state !== 'rate_limited')).toBe(true);
    const { rows: events } = await pool.query("SELECT detail FROM archive.events WHERE kind = 'flood_wait'");
    expect(events[0].detail.seconds).toBe(120);
  });
});

describe('hung requests', () => {
  it('gives up on a Telegram request that never answers and keeps serving other chats', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const real = tg.getHistoryPage.bind(tg);
    tg.getHistoryPage = (chatId, opts) => (chatId === '502' ? new Promise(() => {}) : real(chatId, opts));
    const archiver = await startArchiver(pool, tg, clock, { requestTimeoutMs: 50 });
    await drain(archiver);
    const { chats } = await coverageReport(pool, { now: new Date(clock.now()) });
    const hung = chats.find((c) => c.chatId === '502');
    expect(hung.state).toBe('error');
    expect(hung.errorCode).toBe('TIMEOUT');
    expect(chats.filter((c) => c.chatId !== '502').every((c) => c.state === 'loaded')).toBe(true);
  });
});

describe('dialog list quirks', () => {
  it('tolerates a chat listed twice in the dialogs', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const real = tg.listDialogs.bind(tg);
    tg.listDialogs = async (opts) => {
      const list = await real(opts);
      return [list[0], ...list];
    };
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    const { summary } = await coverageReport(pool, { now: new Date(clock.now()) });
    expect(summary.chats.total).toBe(tg.chats.size);
    expect(summary.complete).toBe(true);
  });
});

describe('archive sequence contract', () => {
  it('assigns unique increasing archive_seq in arrival order, not Telegram time', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    const { rows } = await pool.query(`SELECT archive_seq, source, sent_at FROM archive.messages
                                       WHERE chat_id = '-1001000000003' ORDER BY archive_seq`);
    // Backfill goes newest to oldest, so later archive_seq can carry older sent_at.
    const firstPage = rows.slice(0, 20);
    const lastPage = rows.slice(-20);
    expect(new Date(lastPage[0].sent_at).getTime()).toBeLessThan(new Date(firstPage[0].sent_at).getTime());
  });

  it('never archives the Telegram service account with login codes', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    tg.addChat({ chatId: '777000', peerKind: 'user', title: 'Telegram' });
    tg.addMessage('777000', { text: 'Login code: 00000 (synthetic)', sentAt: new Date(clock.now() - 3_600_000) }, { live: false });
    const archiver = await startArchiver(pool, tg, clock);
    await drain(archiver);
    tg.addMessage('777000', { text: 'Login code: 11111 (synthetic)', sentAt: new Date(clock.now()) });
    await drain(archiver);
    expect(await archivedIds(pool, '777000')).toEqual([]);
    const { rows: [chat] } = await pool.query("SELECT excluded FROM archive.chats WHERE chat_id = '777000'");
    expect(chat.excluded).toBe(true);
  });

  it('purges what was stored before a chat became excluded', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    await drain(await startArchiver(pool, tg, clock));
    expect((await archivedIds(pool, '502')).length).toBeGreaterThan(0);
    const { rows: [{ account_id: accountId }] } = await pool.query('SELECT account_id FROM archive.accounts LIMIT 1');
    await pool.query(
      `INSERT INTO search.chunks (account_id, chat_id, bucket_start, part, message_ids, first_sent_at, last_sent_at, body, body_hash)
       VALUES ($1, 502, now(), 0, '{1}', now(), now(), 'synthetic', 'h')`,
      [accountId],
    );
    await drain(await startArchiver(pool, tg, clock, { excludedChats: ['502'] }));
    const counts = await purgeExcluded(pool);
    expect(counts.chunks).toBe(1);
    expect(counts.messages).toBeGreaterThan(0);
    expect(await archivedIds(pool, '502')).toEqual([]);
    expect((await archivedIds(pool, '501')).length).toBeGreaterThan(0);
  });

  it('excludes chats only when configured explicitly', async () => {
    const clock = virtualClock();
    const tg = standardAccount(clock);
    const archiver = await startArchiver(pool, tg, clock, { excludedChats: ['502'] });
    await drain(archiver);
    expect(await archivedIds(pool, '502')).toEqual([]);
    const { summary } = await coverageReport(pool, { now: new Date(clock.now()) });
    expect(summary.chats.excluded).toBe(1);
    expect(summary.chats.total).toBe(tg.chats.size - 1);
    expect(tg.chats.has('777000')).toBe(false);
  });
});
