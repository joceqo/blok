import {addDays, format, parseISO} from 'date-fns';
import type {DetailedCalendarEvent} from './calendarcn/components/calendar-types';
import type {CalendarEvent} from './calendar-store';

/** Blok stores an exclusive end date. CalendarCN draws through the last day, inclusively. */
export function toCalendarCN(
  event: CalendarEvent, key = event.id, calendarId?: string, color?: string,
): DetailedCalendarEvent {
  const start = parseISO(event.start);
  const end = parseISO(event.end);
  return {
    id: key, title: event.title, start, end: event.allDay ? addDays(end, -1) : end,
    isAllDay: event.allDay, calendarId,
    color: event.source?.color ?? color,
  };
}

export function fromCalendarCN(event: DetailedCalendarEvent, original: CalendarEvent): CalendarEvent {
  const allDay = Boolean(event.isAllDay);
  return {
    ...original,
    title: event.title, allDay,
    start: allDay ? format(event.start, 'yyyy-MM-dd') : event.start.toISOString(),
    end: allDay ? format(addDays(event.end, 1), 'yyyy-MM-dd') : event.end.toISOString(),
  };
}
