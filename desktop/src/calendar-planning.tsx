import type {CSSProperties} from 'react';
import {createRoot} from 'react-dom/client';
import type {CalendarEvent} from './calendar-store';
import type {CalendarWorkspaceEntry} from './calendar-workspaces';

const dayName = new Intl.DateTimeFormat('fr-FR', {weekday:'long',day:'numeric',month:'long'});

interface PlanningProps {
  days: Date[];
  events: CalendarEvent[];
  hour: Intl.DateTimeFormat;
  ownerOf(event: CalendarEvent): CalendarWorkspaceEntry | undefined;
  keyOf(event: CalendarEvent): string;
  open(event: CalendarEvent): void;
  create?: () => void;
  loading: boolean;
}

function Planning({days, events, hour, ownerOf, keyOf, open, create, loading}: PlanningProps) {
  const sorted = events.map(event => ({
    event,
    start: new Date(event.start + (event.allDay ? 'T00:00' : '')),
    end: new Date(event.end + (event.allDay ? 'T00:00' : '')),
  })).sort((a,b) => Number(b.event.allDay) - Number(a.event.allDay) || +a.start - +b.start || a.event.title.localeCompare(b.event.title));
  const today = new Date().toDateString();
  return <section className="cal-planning" aria-label="Planning de la semaine">
    {days.map(day => {
      const tomorrow = new Date(day.getFullYear(),day.getMonth(),day.getDate()+1);
      const entries = sorted.filter(({start,end}) => start < tomorrow && end > day);
      if (!entries.length) return null;
      return <section key={+day} className="cal-planning-day">
        <h2 aria-current={day.toDateString() === today ? 'date' : undefined}>{dayName.format(day)}</h2>
        <ul>{entries.map(({event,start,end}) => {
          const owner = ownerOf(event);
          const source = event.source?.label ?? owner?.name;
          const color = event.source?.color ?? owner?.color ?? '#54836b';
          const hours = event.allDay ? 'Toute la journée' :
            hour.format(start < day ? day : start) + ' – ' +
            (end >= tomorrow && !hour.resolvedOptions().hour12 ? '24:00' : hour.format(end >= tomorrow ? tomorrow : end));
          return <li key={keyOf(event)}>
            <button type="button" className="cal-planning-event" style={{'--event-color':color} as CSSProperties}
              data-event-id={keyOf(event)} onClick={() => open(event)}>
              <span className="cal-planning-time">{hours}</span>
              <span className="cal-planning-name"><strong>{event.title}</strong>{source && <small>{source}</small>}</span>
            </button>
          </li>;
        })}</ul>
      </section>;
    })}
    {!loading && !sorted.length && <div className="cal-planning-empty"><p>Aucun événement cette semaine.</p>
      {create && <button type="button" onClick={create}>Créer un événement</button>}
    </div>}
  </section>;
}

export function mountPlanning(host: HTMLElement) {
  const root = createRoot(host);
  return {
    render(props: PlanningProps) { root.render(<Planning {...props}/>); },
    destroy() { root.unmount(); },
  };
}
