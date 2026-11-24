import ICAL from 'ical.js';
import type { CalendarEvent } from './calendar-store';

/** Expand only the requested view. Run in a worker so a large remote rule can't block navigation. */
export function feedEvents(text: string, from: string, to: string): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(text));
  const parts = root.getAllSubcomponents('vevent');
  if (parts.length > 10000) throw new Error('Cet agenda est trop volumineux.');
  const events = new Map<string, CalendarEvent>();
  const overrides = new Map<string, InstanceType<typeof ICAL.Component>[]>();
  const masters = [];
  for (const part of parts) {
    if (part.hasProperty('recurrence-id')) {
      const uid = String(part.getFirstPropertyValue('uid'));
      const list = overrides.get(uid) ?? [];
      list.push(part); overrides.set(uid, list);
    } else masters.push(part);
  }
  const first = new Date(from).getTime(), last = new Date(to).getTime();
  type Time = InstanceType<typeof ICAL.Time>;
  function record(event: InstanceType<typeof ICAL.Event>, a: Time, b: Time, key: string) {
    if (a.toJSDate().valueOf() >= last || b.toJSDate().valueOf() <= first || event.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    for (const name of ['dtstart', 'dtend']) {
      const tz = event.component.getFirstProperty(name)?.getParameter('tzid');
      if (typeof tz === 'string' && !root.getTimeZoneByID(tz) && !ICAL.TimezoneService.has(tz)) throw new Error('Fuseau horaire absent du flux.');
    }
    const value = (d: Time) => d.isDate ? d.toString() : d.toJSDate().toISOString();
    const start = value(a), end = value(b);
    if (end <= start) return;
    events.set(key, {id: key, title: event.summary || 'Occupé', start, end, allDay: a.isDate, pageId: null, revision: 0});
    if (events.size > 3000) throw new Error('Trop d’événements sur cette période.');
  }
  let steps = 0;
  for (const part of masters) {
    if (!part.hasProperty('dtstart') || !part.hasProperty('uid') || part.getFirstPropertyValue('status') === 'CANCELLED') continue;
    const event = new ICAL.Event(part, {exceptions: overrides.get(String(part.getFirstPropertyValue('uid'))) ?? []});
    if (!event.isRecurring()) { record(event, event.startDate, event.endDate, event.uid); continue; }
    const iter = event.iterator();
    for (let when = iter.next(); when; when = iter.next()) {
      if (++steps > 80000) throw new Error('La série récurrente est trop étendue.');
      if (when.toJSDate().valueOf() >= last) break;
      const {item,startDate,endDate} = event.getOccurrenceDetails(when);
      record(item,startDate,endDate,event.uid + '/' + when.toString());
    }
  }
  for (const [uid, list] of overrides) {
    for (const part of list) {
      if (!part.hasProperty('dtstart')) continue;
      const event = new ICAL.Event(part, {exceptions: []});
      record(event, event.startDate, event.endDate, uid + '/' + event.recurrenceId.toString());
    }
  }
  return [...events.values()];
}
