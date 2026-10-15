import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { coverageReport } from '../src/archive/status.js';
import { createTestDatabase } from './helpers/db.js';
import { FakeTelegram, floodWait } from './helpers/fake-telegram.js';
import { DAY, archivedIds, drain, expectedInWindow, startArchiver, virtualClock } from './helpers/harness.js';

let db;
let pool;
beforeEach(async () => {
  if (db) await db.drop();
  db = await createTestDatabase();
  pool = db.pool;
});
afterAll(async () => { if (db) await db.drop(); });

async function fixture(options = {}) {
  const clock = virtualClock();
  const tg = new FakeTelegram({ now: clock.now });
  for (const id of ['801', '802']) {
    tg.addChat({ chatId: id });
    tg.seed(id, 120, { hours: 24 * 120 });
  }
  const archiver = await startArchiver(pool, tg, clock, options);
  await drain(archiver);
  return { clock, tg, archiver };
}
const sync = async (id = '801') => (await pool.query('SELECT * FROM archive.chat_sync WHERE chat_id = $1', [id])).rows[0];

describe('addressed history extensions', () => {
  it('extends only the requested chat, resumes its checkpoint after restart and preserves global-window coverage', async () => {
    const { clock, tg, archiver } = await fixture();
    const before = await sync();
    const other = await sync('802');
    const target = new Date(clock.now() - 90 * DAY);
    await archiver.store.requestBackfill(tg.self.id, '801', target);
    let report = await coverageReport(pool, { now: new Date(clock.now()) });
    let chat = report.chats.find((c) => c.chatId === '801');
    expect(chat.windowCovered).toBe(true);
    expect(chat.requestedCovered).toBe(false);
    expect(chat.requestedFrom).toBe(target.toISOString());
    expect(chat.coveredFrom).toBe(before.covered_from.toISOString());
    expect(report.summary.chats.historyPending).toBe(1);
    const n = tg.historyCalls('801').length;
    await archiver.step();
    expect(tg.historyCalls('801')[n].offsetId).toBe(Number(before.backfill_offset_id));
    const checkpoint = await sync();
    archiver.stop();
    const second = await startArchiver(pool, tg, clock);
    await drain(second);
    expect(tg.historyCalls('801')[n + 1].offsetId).toBe(Number(checkpoint.backfill_offset_id));
    expect(await archivedIds(pool, '801')).toEqual(expect.arrayContaining(expectedInWindow(tg, '801', target.getTime())));
    expect((await sync('802')).window_start).toEqual(other.window_start);
    expect((await sync('802')).backfill_offset_id).toBe(other.backfill_offset_id);
    report = await coverageReport(pool, { now: new Date(clock.now()) });
    chat = report.chats.find((c) => c.chatId === '801');
    expect(chat.requestedCovered).toBe(true);
    expect(chat.backfillPending).toBe(false);
    expect(report.summary.chats.historyPending).toBe(0);
    expect(new Set(await archivedIds(pool, '801')).size).toBe((await archivedIds(pool, '801')).length);
  });

  it('fills the filtered tail of a calendar-window page instead of skipping it', async () => {
    const { clock, tg, archiver } = await fixture({ windowMonths: 1 });
    const before = await archivedIds(pool, '801');
    const target = new Date(clock.now() - 90 * DAY);
    await archiver.store.requestBackfill(tg.self.id, '801', target);
    const n = tg.historyCalls('801').length;
    await drain(archiver);
    expect(tg.historyCalls('801')[n].offsetId).toBe(Math.min(...before));
    expect(await archivedIds(pool, '801')).toEqual(expect.arrayContaining(expectedInWindow(tg, '801', target.getTime())));
  });

  it('does not treat an exhausted but filtered calendar page as a fully retained history', async () => {
    const clock = virtualClock();
    const tg = new FakeTelegram({ now: clock.now });
    tg.addChat({ chatId: '801' });
    tg.seed('801', 5, { hours: 24 * 120 });
    const archiver = await startArchiver(pool, tg, clock, { windowMonths: 1 });
    await drain(archiver);
    expect((await sync()).history_exhausted).toBe(true);
    expect((await archivedIds(pool, '801')).length).toBeLessThan(5);
    const report = await coverageReport(pool, { now: new Date(clock.now()), windowDays: 130 });
    expect(report.summary.complete).toBe(false);
    await archiver.store.requestBackfill(tg.self.id, '801', new Date(clock.now() - 130 * DAY));
    await drain(archiver);
    expect(await archivedIds(pool, '801')).toEqual([1, 2, 3, 4, 5]);
    expect((await sync()).history_exhausted).toBe(true);
  });

  it('honours an extension arriving while the last old-window page is in flight', async () => {
    const { clock, tg, archiver } = await fixture();
    const firstTarget = new Date(clock.now() - 50 * DAY);
    const deeper = new Date(clock.now() - 100 * DAY);
    await archiver.store.requestBackfill(tg.self.id, '801', firstTarget);
    let extended = false;
    tg.beforeHistory = async ({ chatId }) => {
      if (chatId === '801' && !extended) {
        extended = true;
        await archiver.store.requestBackfill(tg.self.id, '801', deeper);
      }
    };
    await drain(archiver);
    expect((await sync()).requested_from.toISOString()).toBe(deeper.toISOString());
    expect(await archivedIds(pool, '801')).toEqual(expect.arrayContaining(expectedInWindow(tg, '801', deeper.getTime())));
  });

  it('keeps live intake and gap reconciliation running before the deep pass completes', async () => {
    const { clock, tg, archiver } = await fixture();
    await archiver.store.requestBackfill(tg.self.id, '801', new Date(clock.now() - 120 * DAY));
    const live = tg.addMessage('801', { text: 'synthetic live', sentAt: new Date(clock.now()) });
    const missed = tg.addMessage('801', { text: 'synthetic missed update', sentAt: new Date(clock.now()) }, { live: false });
    await archiver.flushLive();
    expect(await archivedIds(pool, '801')).toContain(live.messageId);
    await archiver.refreshDialogs();
    expect((await archiver.store.nextTask(tg.self.id)).kind).toBe('gap');
    await archiver.step();
    expect(await archivedIds(pool, '801')).toContain(missed.messageId);
    expect((await sync()).backfill_done).toBe(false);
    await drain(archiver);
    expect((await sync()).backfill_done).toBe(true);
  });

  it('keeps the earlier target and all existing server backoffs on repeat requests', async () => {
    const { clock, tg, archiver } = await fixture();
    const target = new Date(clock.now() - 90 * DAY);
    await archiver.store.requestBackfill(tg.self.id, '801', target);
    tg.failNext('getHistory', floodWait(120), { chatId: '801' });
    const n = tg.historyCalls('801').length;
    await archiver.step();
    const before = await sync();
    await archiver.store.requestBackfill(tg.self.id, '801', new Date(clock.now() - 30 * DAY));
    const after = await sync();
    expect(after.requested_from.toISOString()).toBe(target.toISOString());
    expect(after.state).toBe('rate_limited');
    expect(after.flood_wait_until).toEqual(before.flood_wait_until);
    expect(after.backfill_offset_id).toBe(before.backfill_offset_id);
    await drain(archiver);
    const calls = tg.historyCalls('801');
    expect(calls[n + 1].at - calls[n].at).toBeGreaterThanOrEqual(120_000);
    expect((await sync()).backfill_done).toBe(true);
  });

  it('reports a larger global window as incomplete instead of equating it to the old configured window', async () => {
    const { clock } = await fixture();
    const report = await coverageReport(pool, { now: new Date(clock.now()), windowDays: 110 });
    expect(report.summary.complete).toBe(false);
    expect(report.chats.every((c) => !c.windowCovered)).toBe(true);
  });

  it('finishes a targeted initial multi-page pass with a verification timestamp', async () => {
    const clock = virtualClock();
    const tg = new FakeTelegram({ now: clock.now });
    tg.addChat({ chatId: '801' });
    tg.seed('801', 60, { hours: 24 * 120 });
    const archiver = await startArchiver(pool, tg, clock);
    await archiver.refreshDialogs();
    await archiver.store.requestBackfill(tg.self.id, '801', new Date(clock.now() - 90 * DAY));
    await drain(archiver);
    expect((await sync()).last_reconciled_at).not.toBeNull();
    expect((await sync()).backfill_done).toBe(true);
  });

  it('rejects unknown, excluded, future and invalid requests without changing the queue', async () => {
    const { clock, tg, archiver } = await fixture();
    const target = new Date(clock.now() - 90 * DAY);
    await expect(archiver.store.requestBackfill(tg.self.id, '999', target)).rejects.toThrow('not in the archive');
    await expect(archiver.store.requestBackfill(tg.self.id, '801', new Date(clock.now() + DAY))).rejects.toThrow('past');
    await expect(archiver.store.requestBackfill(tg.self.id, '801', 'garbage')).rejects.toThrow('valid date');
    await pool.query('UPDATE archive.chats SET excluded = true WHERE chat_id = 801');
    await expect(archiver.store.requestBackfill(tg.self.id, '801', target)).rejects.toThrow('excluded');
    expect((await sync()).requested_from).toBeNull();
  });
});
