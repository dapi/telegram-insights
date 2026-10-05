import { AdaptiveLimiter } from './limiter.js';
import { ArchiveStore } from './store.js';

// The official "Telegram" service account (777000) sends login codes and new
// login alerts. They must not reach the archive, the index or agents over MCP.
export const ALWAYS_EXCLUDED_CHATS = ['777000'];

const DEFAULTS = {
  windowDays: 14,
  pageSize: 100,
  dialogsIntervalMs: 30 * 60_000,
  liveFlushMs: 500,
  liveBatchSize: 200,
  liveBufferLimit: 20_000,
  heartbeatMs: 60_000,
  idleMs: 5_000,
  requestTimeoutMs: 90_000,
  excludedChats: [],
};

class RequestTimeout extends Error {
  constructor(ms) {
    super(`Telegram request did not finish within ${ms} ms`);
    this.code = 'TIMEOUT';
  }
}

// A hung MTProto call must not stall the whole scheduler; the abandoned
// promise is left to settle on its own.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new RequestTimeout(ms)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Orchestrates one account: live intake first, then fair paged backfill and
// periodic gap reconciliation. All progress lives in PostgreSQL.
export class Archiver {
  constructor({ pool, gateway, options = {}, limiterOptions = {}, clock = {}, log = () => {} }) {
    this.pool = pool;
    this.gateway = gateway;
    this.options = { ...DEFAULTS, ...options };
    this.now = clock.now ?? (() => Date.now());
    this.sleep = clock.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.store = new ArchiveStore(pool, { now: () => new Date(this.now()) });
    this.limiterOptions = limiterOptions;
    this.log = log;
    this.liveBuffer = [];
    this.liveFlushing = null;
    this.stopped = false;
    this.lastDialogsAt = 0;
    this.stats = { pages: 0, inserted: 0, live: 0, floodWaits: 0, errors: 0 };
    this.leaseClient = null;
  }

  get excluded() {
    return new Set([...ALWAYS_EXCLUDED_CHATS, ...this.options.excludedChats.map(String)]);
  }

  // Session-level advisory lock: a second archiver for the same account refuses to start.
  async acquireLease() {
    const client = await this.pool.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock(7312, hashtext($1::text)) AS ok', [String(this.accountId)]);
    if (!rows[0].ok) {
      client.release();
      throw new Error('Another Telegram Insights archiver holds the lease for this account');
    }
    client.on('error', (error) => {
      this.log('lease connection lost', { error: error.message });
      this.leaseLost = true;
      this.stop();
    });
    this.leaseClient = client;
  }

  async releaseLease() {
    if (!this.leaseClient) return;
    try {
      await this.leaseClient.query('SELECT pg_advisory_unlock(7312, hashtext($1::text))', [String(this.accountId)]);
    } catch {
      // The lock dies with the session anyway.
    }
    this.leaseClient.release();
    this.leaseClient = null;
  }

  async init() {
    const self = await this.gateway.getSelf();
    this.accountId = self.id;
    await this.store.ensureAccount(this.accountId, self.username);
    this.limiter = new AdaptiveLimiter(this.limiterOptions, {
      now: this.now,
      sleep: this.sleep,
      persist: (state) => this.store.setRuntime(this.accountId, 'limiter', state),
    });
    this.limiter.restore(await this.store.getRuntime(this.accountId, 'limiter'));
    return self;
  }

  // PRD order: intake of new messages starts before any historical work.
  async startLive() {
    this.gateway.onMessage((message, chat) => this.enqueueLive(message, chat));
    this.gateway.onChannelTooLong?.((chatId) => {
      this.store.planGaps(this.accountId, [chatId]).catch((error) => this.log('plan gap failed', { error: error.message }));
    });
    await this.gateway.startUpdates();
    await this.store.logEvent(this.accountId, 'live_started');
  }

  enqueueLive(message, chat) {
    if (this.excluded.has(String(chat.chatId))) return;
    if (this.liveBuffer.length >= this.options.liveBufferLimit) {
      // Dropped live messages are recovered by the next gap reconciliation.
      this.stats.liveDropped = (this.stats.liveDropped ?? 0) + 1;
      return;
    }
    this.liveBuffer.push({ message, chat });
  }

  async flushLive() {
    if (this.liveFlushing) return this.liveFlushing;
    if (!this.liveBuffer.length) return 0;
    const batch = this.liveBuffer.splice(0, this.options.liveBatchSize);
    this.liveFlushing = this.store.insertLiveBatch(this.accountId, batch, { windowDays: this.options.windowDays })
      .then((inserted) => {
        this.stats.live += inserted;
        return inserted;
      })
      .catch((error) => {
        this.liveBuffer.unshift(...batch);
        this.log('live flush failed', { error: error.message });
        return 0;
      })
      .finally(() => {
        this.liveFlushing = null;
      });
    return this.liveFlushing;
  }

  async refreshDialogs() {
    const dialogs = await withTimeout(this.gateway.listDialogs({
      beforeChunk: () => this.limiter.acquire(),
    }), this.options.requestTimeoutMs * 20);
    const result = await this.store.syncDialogs(this.accountId, dialogs, {
      windowDays: this.options.windowDays,
      excluded: this.excluded,
    });
    const planned = await this.store.planGaps(this.accountId);
    this.lastDialogsAt = this.now();
    await this.store.logEvent(this.accountId, 'dialogs_synced', { ...result, gapsPlanned: planned });
    this.log('dialogs synced', { ...result, gapsPlanned: planned });
    return { ...result, planned };
  }

  async handleTelegramError(task, error) {
    if (error.code === 'FLOOD_WAIT') {
      this.stats.floodWaits += 1;
      const until = await this.limiter.onFloodWait(error.waitSeconds);
      if (task) await this.store.markFloodWait(this.accountId, task.chat_id, until);
      await this.store.logEvent(this.accountId, 'flood_wait', { seconds: error.waitSeconds, until: new Date(until).toISOString() }, task?.chat_id ?? null);
      this.log('flood wait', { seconds: error.waitSeconds });
      return;
    }
    this.stats.errors += 1;
    if (task) {
      const { unavailable } = await this.store.markError(this.accountId, task.chat_id, error.code ?? 'UNKNOWN');
      await this.store.logEvent(this.accountId, unavailable ? 'chat_unavailable' : 'chat_error', { code: error.code ?? 'UNKNOWN', hint: error.hint ?? String(error.message ?? '').replace(/\d+/g, '#').slice(0, 120) }, task.chat_id);
    } else {
      await this.store.logEvent(this.accountId, 'error', { code: error.code ?? 'UNKNOWN' });
    }
  }

  // Serves one page of one chat. Returns false when there is nothing to do.
  async step() {
    await this.flushLive();
    await this.store.clearExpiredFloodWaits(this.accountId);
    if (this.now() - this.lastDialogsAt >= this.options.dialogsIntervalMs) {
      try {
        await this.refreshDialogs();
      } catch (error) {
        this.lastDialogsAt = this.now();
        await this.handleTelegramError(null, error);
      }
      return true;
    }
    const task = await this.store.nextTask(this.accountId);
    if (!task) return false;
    await this.limiter.acquire();
    let page;
    try {
      page = await withTimeout(task.kind === 'backfill'
        ? this.gateway.getHistoryPage(task.chat_id, {
          offsetId: Number(task.backfill_offset_id ?? 0),
          limit: this.options.pageSize,
          username: task.username,
        })
        : this.gateway.getHistoryPage(task.chat_id, {
          offsetId: Number(task.gap_offset_id ?? 0),
          minId: Number(task.gap_min_id ?? 0),
          limit: this.options.pageSize,
          username: task.username,
        }), this.options.requestTimeoutMs);
    } catch (error) {
      await this.handleTelegramError(task, error);
      return true;
    }
    await this.limiter.onSuccess();
    const result = await this.store.applyPage(this.accountId, task, page, { windowDays: this.options.windowDays });
    this.stats.pages += 1;
    this.stats.inserted += result.inserted;
    if (result.done) {
      await this.store.logEvent(this.accountId, task.kind === 'backfill' ? 'backfill_done' : 'gap_closed', { pages: task.pages_fetched + 1 }, task.chat_id);
    }
    return true;
  }

  async heartbeat() {
    await this.store.setRuntime(this.accountId, 'heartbeat', {
      at: new Date(this.now()).toISOString(),
      pid: process.pid,
      stats: this.stats,
      limiter: this.limiter.snapshot(),
      liveBuffered: this.liveBuffer.length,
    });
  }

  async run() {
    let lastHeartbeat = 0;
    const flushTimer = setInterval(() => { void this.flushLive(); }, this.options.liveFlushMs);
    try {
      while (!this.stopped) {
        let worked = false;
        try {
          worked = await this.step();
        } catch (error) {
          this.log('step failed', { error: error.message });
          await this.sleep(5_000);
        }
        if (this.now() - lastHeartbeat >= this.options.heartbeatMs) {
          lastHeartbeat = this.now();
          await this.heartbeat().catch((error) => this.log('heartbeat failed', { error: error.message }));
        }
        if (!worked && !this.stopped) await this.sleep(this.options.idleMs);
      }
    } finally {
      clearInterval(flushTimer);
      await this.flushLive();
    }
  }

  stop() {
    this.stopped = true;
  }
}
