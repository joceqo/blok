import { beforeEach, expect, it, vi } from 'vitest';
import { createCalendarStore, type CalendarEvent } from './calendar-store';

const space = {kind: 'local', id: 'one', name: 'One'} as const;
const week = ['2026-11-23T00:00:00', '2026-11-30T00:00:00'].map(day => new Date(day).toISOString());
const event: CalendarEvent = {id: 'a', title: 'Semaine', allDay: true, start: '2026-11-21', end: '2026-11-25', revision: 0, pageId: null};
beforeEach(() => localStorage.clear());

it('preserves concurrent additions, date boundaries and workspace isolation across reopening', async () => {
  const store = createCalendarStore(space);
  await Promise.all([store.save(event), store.save({...event, id: 'b', end: '2026-11-23'})]);
  expect(await createCalendarStore(space).list(week[0], week[1])).toEqual([{...event, revision: 1}]);
  expect(await createCalendarStore({...space, id: 'two'}).list(week[0], week[1])).toEqual([]);
});

it('refuses stale writes and deletions and keeps the newer value', async () => {
  const store = createCalendarStore(space);
  await store.save(event);
  await store.save({...event, title: 'Updated', revision: 1});
  await expect(store.remove({...event, revision: 1})).rejects.toMatchObject({status: 409});
  await expect(store.save({...event, revision: 1})).rejects.toMatchObject({status: 409});
  await store.remove({...event, revision: 2});
  expect(await store.list(week[0], week[1])).toEqual([]);
});

it('answers an invitation through the workspace, and offers no answer without one', async () => {
  const request = vi.fn().mockResolvedValue({ok: true, response: 'accepted'});
  const store = createCalendarStore(
    {kind: 'remote', server: 'https://blok.test', workspaceId: 'acme', accountId: 'me'} as never,
    {request} as never,
  );
  await store.respond?.('event-1', 'accepted');
  expect(request).toHaveBeenCalledWith(
    '/api/workspaces/acme/calendar/events/event-1/response',
    expect.objectContaining({method: 'PUT', body: JSON.stringify({response: 'accepted'})}),
  );
  // A local workspace has no organiser to tell: the store offers nothing.
  const local = createCalendarStore({kind: 'local', id: 'solo'} as never);
  expect(local.respond).toBeUndefined();
});
