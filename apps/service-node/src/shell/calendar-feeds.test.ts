import {describe,expect,it,vi} from 'vitest';
import {feedUrl,fetchCalendarFeed} from './calendar-feeds.ts';

describe('subscribed calendars', () => {
  const url='webcal://caldav.icloud.com/published/2/calendar';
  it('accepts supported calendar URLs and checks the transport and provider on redirects', async () => {
    expect(feedUrl(url).protocol).toBe('https:');
    expect(()=>feedUrl('https://localhost/calendar.ics')).toThrow();
    const redirected=vi.fn(async()=>new Response(null,{status:302,headers:{Location:'https://other.example/calendar.ics'}}));
    await expect(fetchCalendarFeed(url,redirected)).rejects.toThrow('fournisseur');
    expect(redirected).toHaveBeenCalledTimes(1);
  });
  it('reads only bounded calendars and hides the private subscription URI in errors', async () => {
    const calendar='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
    await expect(fetchCalendarFeed(url,async()=>new Response(calendar))).resolves.toBe(calendar);
    await expect(fetchCalendarFeed(url,async()=>new Response('<html>private URI</html>'))).rejects.toThrow('Impossible de lire');
  });
});
