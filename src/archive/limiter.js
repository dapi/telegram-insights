// Adaptive pacing for Telegram history requests.
//
// There is no request rate that Telegram guarantees to be safe, so the limiter
// only enforces a configurable floor, backs off multiplicatively on FLOOD_WAIT,
// honours the server-provided wait (plus jitter) and speeds up again slowly.
// Its state is persisted so a restart never cuts a FLOOD_WAIT short.

const DEFAULTS = {
  minIntervalMs: 1500,
  maxIntervalMs: 60_000,
  initialIntervalMs: 3000,
  backoffFactor: 2,
  recoverAfterSuccesses: 25,
  recoverFactor: 0.85,
  jitterRatio: 0.2,
  floodJitterMs: 3000,
  maxRequestsPerHour: 1200,
};

export class AdaptiveLimiter {
  constructor(options = {}, { now = () => Date.now(), sleep, random = Math.random, persist = async () => {} } = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = random;
    this.persist = persist;
    this.intervalMs = this.options.initialIntervalMs;
    this.pausedUntil = 0;
    this.nextAllowedAt = 0;
    this.successStreak = 0;
    this.floodCount = 0;
    this.lastFlood = null;
    this.requestTimes = [];
    this.queue = Promise.resolve();
  }

  restore(state) {
    if (!state) return;
    if (Number.isFinite(state.intervalMs)) {
      this.intervalMs = Math.min(this.options.maxIntervalMs, Math.max(this.options.minIntervalMs, state.intervalMs));
    }
    if (Number.isFinite(state.pausedUntil)) this.pausedUntil = state.pausedUntil;
    if (Number.isFinite(state.floodCount)) this.floodCount = state.floodCount;
    if (state.lastFlood) this.lastFlood = state.lastFlood;
  }

  snapshot() {
    return {
      intervalMs: Math.round(this.intervalMs),
      pausedUntil: this.pausedUntil,
      floodCount: this.floodCount,
      lastFlood: this.lastFlood,
      requestsLastHour: this._requestsInLastHour(),
    };
  }

  isPaused() {
    return this.pausedUntil > this.now();
  }

  _requestsInLastHour() {
    const cutoff = this.now() - 3_600_000;
    while (this.requestTimes.length && this.requestTimes[0] < cutoff) this.requestTimes.shift();
    return this.requestTimes.length;
  }

  _jittered(ms) {
    const ratio = this.options.jitterRatio;
    return ms * (1 - ratio + 2 * ratio * this.random());
  }

  // Waits for a slot. Calls are serialized so the configured spacing holds even
  // if several callers share one limiter.
  acquire() {
    const run = async () => {
      for (;;) {
        const now = this.now();
        let waitUntil = Math.max(this.pausedUntil, this.nextAllowedAt);
        if (this._requestsInLastHour() >= this.options.maxRequestsPerHour) {
          waitUntil = Math.max(waitUntil, this.requestTimes[0] + 3_600_000);
        }
        if (waitUntil <= now) break;
        await this.sleep(Math.min(waitUntil - now, 60_000));
      }
      const now = this.now();
      this.requestTimes.push(now);
      this.nextAllowedAt = now + this._jittered(this.intervalMs);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async onSuccess() {
    this.successStreak += 1;
    if (this.successStreak >= this.options.recoverAfterSuccesses && this.intervalMs > this.options.minIntervalMs) {
      this.intervalMs = Math.max(this.options.minIntervalMs, this.intervalMs * this.options.recoverFactor);
      this.successStreak = 0;
      await this.persist(this.snapshot());
    }
  }

  async onFloodWait(seconds) {
    const waitMs = Math.max(1, Number(seconds) || 1) * 1000 + this.random() * this.options.floodJitterMs;
    const until = this.now() + waitMs;
    this.pausedUntil = Math.max(this.pausedUntil, until);
    this.intervalMs = Math.min(this.options.maxIntervalMs, this.intervalMs * this.options.backoffFactor);
    this.successStreak = 0;
    this.floodCount += 1;
    this.lastFlood = { at: new Date(this.now()).toISOString(), seconds: Number(seconds) };
    await this.persist(this.snapshot());
    return this.pausedUntil;
  }
}
