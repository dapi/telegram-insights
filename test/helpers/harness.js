import { Archiver } from '../../src/archive/archiver.js';
import { FakeTelegram } from './fake-telegram.js';

export const DAY = 86_400_000;

// Virtual clock: sleeping advances time instantly so FLOOD_WAIT and pacing can be
// asserted on timestamps without real waiting.
export function virtualClock(start = Date.parse('2026-10-05T09:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms); },
    advance: (ms) => { t += ms; },
  };
}

export function makeArchiver(pool, telegram, clock, options = {}) {
  return new Archiver({
    pool,
    gateway: telegram,
    clock,
    options: { pageSize: 20, dialogsIntervalMs: 30 * 60_000, ...options },
    limiterOptions: { minIntervalMs: 1000, initialIntervalMs: 1000, maxRequestsPerHour: 100_000 },
  });
}

export async function startArchiver(pool, telegram, clock, options = {}) {
  const archiver = makeArchiver(pool, telegram, clock, options);
  await archiver.init();
  await archiver.startLive();
  return archiver;
}

// Runs steps until the scheduler has nothing left (or a safety limit).
export async function drain(archiver, { maxSteps = 5000, onStep = null } = {}) {
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    const worked = await archiver.step();
    if (onStep) await onStep(steps);
    if (!worked) break;
  }
  await archiver.flushLive();
  return steps;
}

export function standardAccount(clock) {
  const tg = new FakeTelegram({ now: clock.now });
  tg.addChat({ chatId: '501', peerKind: 'user', title: 'Личный диалог' });
  tg.addChat({ chatId: '502', peerKind: 'bot', title: 'Бот' });
  tg.addChat({ chatId: tg.self.id, peerKind: 'saved', title: 'Избранное' });
  tg.addChat({ chatId: '-4001', peerKind: 'group', title: 'Малая группа' });
  tg.addChat({ chatId: '-1001000000001', peerKind: 'supergroup', title: 'Супергруппа', isForum: true });
  tg.addChat({ chatId: '-1001000000002', peerKind: 'channel', title: 'Канал', username: 'synthetic_channel' });
  tg.addChat({ chatId: '-1001000000003', peerKind: 'channel', title: 'Большой канал' });
  tg.addChat({ chatId: '503', peerKind: 'user', title: 'Пустой диалог' });
  tg.seed('501', 30);
  tg.seed('502', 5);
  tg.seed(tg.self.id, 12);
  tg.seed('-4001', 45);
  tg.seed('-1001000000001', 70);
  tg.seed('-1001000000002', 25);
  tg.seed('-1001000000003', 400);
  return tg;
}

export async function archivedIds(pool, chatId) {
  const { rows } = await pool.query(
    'SELECT message_id FROM archive.messages WHERE chat_id = $1 ORDER BY message_id',
    [chatId],
  );
  return rows.map((r) => Number(r.message_id));
}

export function expectedInWindow(tg, chatId, windowStart) {
  return tg.chats.get(String(chatId)).messages
    .filter((m) => m.sentAt.getTime() >= windowStart)
    .map((m) => m.messageId)
    .sort((a, b) => a - b);
}
