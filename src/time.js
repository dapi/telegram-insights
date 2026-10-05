export const DEFAULT_TZ = 'Europe/Moscow';

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

export function formatLocal(date, timeZone = DEFAULT_TZ) {
  const p = parts(new Date(date), timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatTime(date, timeZone = DEFAULT_TZ) {
  const p = parts(new Date(date), timeZone);
  return `${p.hour}:${p.minute}`;
}

export function localDate(date, timeZone = DEFAULT_TZ) {
  const p = parts(new Date(date), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function offsetMs(instant, timeZone) {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// Calendar day [start, end) in the given time zone, as UTC instants.
export function dayRange(day, timeZone = DEFAULT_TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid date ${day}; expected YYYY-MM-DD`);
  const midnightUtc = (y, mo, d) => {
    const guess = new Date(Date.UTC(y, mo - 1, d));
    return new Date(guess.getTime() - offsetMs(guess, timeZone));
  };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return {
    start: midnightUtc(y, mo, d),
    end: midnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}
