import { expect, it } from 'vitest';
import { eventToIcal, readCalendarFile } from './calendar-ical';
import type { CalendarEvent } from './calendar-store';

const event: CalendarEvent = {
  id: '6e3d747b-2ee1-49ae-a13a-8e3489ed26fa', title: 'Comité, Lyon ; rentrée',
  start: '2026-11-25T09:00:00.000Z', end: '2026-11-25T09:30:00.000Z', allDay: false,
  pageId: 'confidentiel', revision: 3,
};

it('exports the visible entry, preserves the UID on reimport, and omits internal references', async () => {
  const source = eventToIcal(event);
  expect(source).not.toContain('confidentiel');
  const result = await readCalendarFile(source);
  expect(result.events).toEqual([{...event, revision: 0, pageId: null}]);
});

it('keeps date-only spans and exclusive ends through export and import', async () => {
  const days = {...event, allDay: true, start: '2026-10-24', end: '2026-10-27'};
  const source = eventToIcal(days);
  expect(source).toContain('DTEND;VALUE=DATE:20261027');
  expect((await readCalendarFile(source)).events[0]).toMatchObject({start: days.start, end: days.end, allDay: true});
});

it('identifies external UIDs consistently and reports recurrence rather than silently importing one occurrence', async () => {
  const source = eventToIcal(event).replace(event.id + '@blok.calendar', 'calendar-id@example.org');
  const first = (await readCalendarFile(source)).events[0];
  expect(first.id).toMatch(/^[\da-f-]{36}$/);
  expect((await readCalendarFile(source)).events[0].id).toBe(first.id);
  const recurring = await readCalendarFile(source.replace('END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT'));
  expect(recurring).toMatchObject({events: [], omitted: 1, skipped: ['séries récurrentes']});
});
