import {expect,it} from 'vitest';
import {feedEvents} from './calendar-feed-events';
it('expands the visible week, respects excluded dates and replaces a rescheduled occurrence',()=>{
  const text=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:weekly','DTSTART:20261005T100000Z','DTEND:20261005T103000Z','RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR','EXDATE:20261125T100000Z','SUMMARY:Point équipe','END:VEVENT','BEGIN:VEVENT','UID:weekly','RECURRENCE-ID:20261127T100000Z','DTSTART:20261127T140000Z','DTEND:20261127T143000Z','SUMMARY:Point déplacé','END:VEVENT','END:VCALENDAR'].join('\r\n');
  expect(feedEvents(text,'2026-11-23T00:00:00Z','2026-11-30T00:00:00Z').map(e=>[e.title,e.start])).toEqual([
    ['Point équipe','2026-11-23T10:00:00.000Z'],['Point déplacé','2026-11-27T14:00:00.000Z']
  ]);
});
