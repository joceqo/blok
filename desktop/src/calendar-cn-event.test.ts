import {describe, expect, it} from 'vitest';
import {fromCalendarCN, toCalendarCN} from './calendar-cn-event';
import type {CalendarEvent} from './calendar-store';

const event: CalendarEvent = {
  id: 'meeting', title: 'Revue', pageId: 'brief', revision: 4, allDay: true,
  start: '2026-03-28', end: '2026-03-31',
};

describe('CalendarCN event boundaries', () => {
  it.each([
    ['2026-03-28', '2026-03-31', 30], // Europe/Paris spring-forward
    ['2026-10-24', '2026-10-27', 26], // Europe/Paris fall-back
    ['2026-12-31', '2027-01-01', 31],
  ])('round-trips the exclusive dates %s to %s through local midnight', (start, end, lastDay) => {
    const stored = {...event, start, end};
    const display = toCalendarCN(stored);
    expect(display.start.getHours()).toBe(0);
    expect(display.end.getHours()).toBe(0);
    expect(display.end.getDate()).toBe(lastDay);
    expect(fromCalendarCN(display, stored)).toEqual(stored);
  });

  it('uses absolute instants for timed moves and keeps the original ID, page and revision', () => {
    const timed = {...event, allDay: false, start: '2026-03-29T01:30:00+01:00', end: '2026-03-29T03:30:00+02:00'};
    const display = toCalendarCN(timed, 'work/meeting', 'work', '#4185bb');
    expect(display).toMatchObject({id:'work/meeting', calendarId:'work', color:'#4185bb'});
    expect(+display.end - +display.start).toBe(3_600_000);
    const moved = fromCalendarCN({...display, end: new Date(+display.end + 900_000)}, timed);
    expect(moved).toMatchObject({id: 'meeting', pageId:'brief', revision:4, end:'2026-03-29T01:45:00.000Z'});
    expect(timed.end).toBe('2026-03-29T03:30:00+02:00');
  });

  it('keeps the external source and its own color when a workspace color is available', () => {
    const subscribed = {...event, source:{id:'feed', label:'Congés', color:'#549522'}};
    const display = toCalendarCN(subscribed, 'work/feed/event', 'work', '#111111');
    expect(display.color).toBe(subscribed.source.color);
    expect(fromCalendarCN(display, subscribed)).toEqual(subscribed);
  });
});
