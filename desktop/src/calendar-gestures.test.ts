import { expect, it } from 'vitest';
import { reschedule } from './calendar-gestures';
import type { CalendarEvent } from './calendar-store';

const event: CalendarEvent = {id:'e',title:'Réunion',start:'2026-11-25T09:00:00Z',end:'2026-11-25T10:00:00Z',allDay:false,pageId:null,revision:4};

it('moves timed events across days while retaining their duration and optimistic revision', () => {
  const next = reschedule(event, {date:'2026-11-25',minutes:630}, {date:'2026-11-26',minutes:660}, false);
  expect(next).toMatchObject({start:'2026-11-26T09:30:00.000Z',end:'2026-11-26T10:30:00.000Z',revision:4});
  expect(event.start).toBe('2026-11-25T09:00:00Z');
});

it('changes only the end when resizing and prevents an invalid range', () => {
  expect(reschedule(event, {date:'2026-11-25',minutes:600}, {date:'2026-11-25',minutes:630}, true)?.end).toBe('2026-11-25T10:30:00.000Z');
  expect(reschedule(event, {date:'2026-11-25',minutes:600}, {date:'2026-11-25',minutes:540}, true)).toBeNull();
});

it('moves floating all-day dates across months and keeps the end exclusive', () => {
  const holiday = {...event, allDay:true, start:'2026-11-29', end:'2026-12-01'};
  expect(reschedule(holiday, {date:'2026-11-29',minutes:0}, {date:'2026-12-01',minutes:0}, false))
    .toMatchObject({start:'2026-12-01', end:'2026-12-03'});
  expect(reschedule(holiday, {date:'2026-11-30',minutes:0}, {date:'2026-12-01',minutes:0}, true))
    .toMatchObject({start:'2026-11-29', end:'2026-12-02'});
});
