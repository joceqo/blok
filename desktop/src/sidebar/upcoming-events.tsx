import {shellText, shellLocale} from '../shell-i18n';
import { useEffect, useState } from 'react';
import { Button } from '../components';
import type { CalendarEvent } from '../calendar-store';
import { SidebarIcon } from './sidebar-icon';
import { useNavigationLayout } from './navigation-layout';

export interface UpcomingCalendar {
  events: CalendarEvent[];
  connected: boolean;
  unavailable: boolean;
}
interface Props {
  load?: (signal: AbortSignal) => Promise<UpcomingCalendar>;
  connect?: () => void;
  open: () => void;
}
const date = new Intl.DateTimeFormat(shellLocale(), { day: 'numeric', month: 'short' });
const time = new Intl.DateTimeFormat(shellLocale(), { hour: '2-digit', minute: '2-digit' });
const todayEmpty: UpcomingCalendar = { events: [], connected: false, unavailable: false };

export const UpcomingEvents = ({ load, connect, open }: Props) => {
  const limit = useNavigationLayout()?.limit('events') ?? 10;
  const [calendar, setCalendar] = useState<UpcomingCalendar | null>(load ? null : todayEmpty);
  useEffect(() => {
    if (!load) return;
    const pending: { request?: AbortController } = {};
    function refresh() {
      if (document.hidden || !load) return;
      pending.request?.abort();
      const request = new AbortController();
      pending.request = request;
      void load(request.signal)
        .then((result) => {
          if (!request.signal.aborted) setCalendar(result);
        })
        .catch(() => {
          if (!request.signal.aborted)
            setCalendar((previous) => ({ ...(previous ?? todayEmpty), unavailable: true }));
        });
    }
    refresh();
    const timer = window.setInterval(refresh, 300000);
    window.addEventListener('focus', refresh);
    window.addEventListener('blok:calendar-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      pending.request?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('blok:calendar-changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);
  if (!calendar)
    return (
      <div
        aria-label={shellText("Chargement des événements")}
        role="status"
      >
        <div
          className="sidebar-skeleton sidebar-skeleton-rows sidebar-upcoming-skeleton"
          aria-hidden="true"
        />
      </div>
    );
  const events = calendar.events.slice(0, limit || undefined);
  const offerConnection = Boolean(connect && !calendar.connected && !calendar.unavailable);
  return (
    <>
      {events.length > 0 && (
        <ul className="sidebar-upcoming-list">
          {events.map((event) => {
            const start = new Date(event.allDay ? `${event.start}T00:00:00` : event.start);
            return (
              <li key={event.id}>
                <span>{event.title}</span>
                <time dateTime={event.start}>
                  {date.format(start)}
                  {!event.allDay && ` · ${time.format(start)}`}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      {calendar.unavailable && (
        <p
          data-blok-sidebar-empty=""
          role="status"
        >
          {shellText("Certains événements sont indisponibles.")}
        </p>
      )}
      {calendar.connected && !events.length && !calendar.unavailable && (
        <p data-blok-sidebar-empty="">{shellText("Aucun événement à venir")}</p>
      )}
      <Button
        variant="plain"
        type="button"
        data-blok-sidebar-shortcut=""
        onClick={offerConnection ? connect : open}
      >
        <SidebarIcon name={offerConnection ? 'plus' : 'calendar'} />
        <span>{offerConnection ? shellText("Connecter votre calendrier") : shellText("Voir le calendrier")}</span>
      </Button>
    </>
  );
};
