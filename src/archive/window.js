const DAY_MS = 86_400_000;

export function archiveWindowStart(now, { windowDays = 14, windowMonths = null } = {}) {
  if (windowMonths != null) {
    if (!Number.isInteger(windowMonths) || windowMonths < 1) throw new Error('windowMonths must be a positive integer');
    const start = new Date(now);
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - windowMonths);
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
    return start;
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) throw new Error('windowDays must be positive');
  return new Date(now.getTime() - windowDays * DAY_MS);
}

export function withinArchiveWindow(message, start) {
  return new Date(message.sentAt).getTime() >= start.getTime();
}
