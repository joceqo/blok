import { describe, expect, it, vi } from 'vitest';
import type { PgPool } from '../db/pool.ts';
import { createShellApp } from './app.ts';
import { calendarInput, calendarRange } from './calendar.ts';

const id = '10000000-0000-4000-8000-000000000001';
const event = { id, title: ' Point équipe ', start: '2026-03-29T00:30:00Z', end: '2026-03-29T01:30:00Z', pageId: null, allDay: false, revision: 0 };

describe('calendar dates and revision checks', () => {
  it('normalizes timed events and floating dates separately', () => {
    expect(calendarInput(id, event)).toMatchObject({ title: 'Point équipe', start: '2026-03-29T00:30:00.000Z' });
    expect(calendarInput(id, { ...event, allDay: true, start: '2028-02-29', end: '2028-03-01' }).start).toBe('2028-02-29T00:00:00.000Z');
  });

  it.each([
    { id: 'another-id' }, { title: '  ' }, { revision: 0.1 }, { revision: -1 }, { pageId: [] },
    { allDay: 'true' }, { end: event.start }, { start: '2026-02-29T00:00:00Z' },
    { start: '2026-01-02T24:00:00Z' }, { start: '2026-01-02T12:00:00' },
    { allDay: true, start: '2026-02-29', end: '2026-03-01' },
  ])('rejects invalid event %o', patch => {
    expect(() => calendarInput(id, { ...event, ...patch })).toThrow();
  });

  it('preserves independent local-day and instant boundaries across a DST transition', () => {
    const range = { from: '2026-03-22T23:00:00Z', to: '2026-03-29T22:00:00Z', fromDate: '2026-03-23', toDate: '2026-03-30' };
    expect(calendarRange(range)).toEqual({ from:'2026-03-22T23:00:00.000Z', to:'2026-03-29T22:00:00.000Z',
      fromDay:'2026-03-23T00:00:00.000Z', toDay:'2026-03-30T00:00:00.000Z' });
    expect(() => calendarRange({ ...range, fromDate: range.toDate })).toThrow();
  });
});

it.each([['PUT', 'viewer', 403], ['DELETE', 'viewer', 403], ['GET', null, 403]])(
  '%s refuses insufficient membership before reading events', async (method, role, status) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rows: [{user_id: 'bob'}] };
      if (sql.includes('FROM workspaces')) return { rows: [{id: 'space'}] };
      if (sql.includes('FROM memberships')) return { rows: role ? [{role}] : [] };
      return { rows: [] };
    });
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as PgPool;
    const app = createShellApp(pool, 'k'.repeat(32), new Set());
    const path = '/api/workspaces/test/calendar' + (method === 'GET' ? '' : '/' + id);
    expect((await app.request(path, {method: String(method), headers:{Authorization:'Bearer bob'}})).status).toBe(status);
    expect(query.mock.calls.some(([sql]) => sql.includes('workspace_calendar_events'))).toBe(false);
  });
