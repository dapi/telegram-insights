import { describe, expect, it } from 'vitest';

import { archiveWindowStart, withinArchiveWindow } from '../src/archive/window.js';

describe('archive window', () => {
  it('subtracts whole calendar months and clamps short months', () => {
    expect(archiveWindowStart(new Date('2026-03-31T12:30:00Z'), { windowMonths: 1 }).toISOString())
      .toBe('2026-02-28T12:30:00.000Z');
    expect(archiveWindowStart(new Date('2024-03-31T12:30:00Z'), { windowMonths: 1 }).toISOString())
      .toBe('2024-02-29T12:30:00.000Z');
    expect(archiveWindowStart(new Date('2026-10-07T12:30:00Z'), { windowMonths: 2 }).toISOString())
      .toBe('2026-08-07T12:30:00.000Z');
  });

  it('includes the boundary and excludes older messages', () => {
    const start = archiveWindowStart(new Date('2026-10-07T12:30:00Z'), { windowMonths: 2 });
    expect(withinArchiveWindow({ sentAt: '2026-08-07T12:30:00Z' }, start)).toBe(true);
    expect(withinArchiveWindow({ sentAt: '2026-08-07T12:29:59Z' }, start)).toBe(false);
  });
});
