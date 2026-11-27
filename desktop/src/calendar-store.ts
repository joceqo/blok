import { CloudApiError, CloudClient } from './cloud/client';
import { nativeSessionAdapter } from './native-session';
import { readFile, writeFile } from './storage';
import type { WorkspaceRef } from './workspace-registry';

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  pageId: string | null;
  participantIds?: string[];
  readOnly?: boolean;
  revision: number;
  source?: {id: string; label: string; color: string};
}

export interface CalendarStore {
  remote?: {client: CloudClient; base: string; preferenceKey: string};
  list(from: string, to: string): Promise<CalendarEvent[]>;
  save(event: CalendarEvent): Promise<void>;
  remove(event: CalendarEvent): Promise<void>;
  /** Répondre à une invitation. Absent sans espace distant : il n'y a
   *  alors ni organisateur à prévenir ni service pour l'écrire. */
  respond?(eventId: string, response: 'needs-action' | 'accepted' | 'declined' | 'tentative'): Promise<void>;
}

function localDate(iso: string): string {
  const date = new Date(iso);
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

const refresh = { timer: undefined as number | undefined };
// Regroupe les écritures d’un import iCalendar en un seul rafraîchissement de la sidebar.
export function notifyCalendarChanged(): void {
  window.clearTimeout(refresh.timer);
  refresh.timer = window.setTimeout(() => window.dispatchEvent(new Event('blok:calendar-changed')), 150);
}

const queues = new Map<string, Promise<void>>();
async function withFileLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  const key = 'blok:calendar:' + workspace;
  if (navigator.locks) return navigator.locks.request(key, action);
  const task = (queues.get(key) ?? Promise.resolve()).then(action);
  const done = task.then(() => {}, () => {});
  queues.set(key, done);
  try { return await task; }
  finally { if (queues.get(key) === done) queues.delete(key); }
}

export function createCalendarStore(ref: WorkspaceRef, providedClient?: CloudClient): CalendarStore {
  if (ref.kind === 'remote') {
    const client = providedClient ?? new CloudClient({origin: ref.server, sessionAdapter: '__TAURI_INTERNALS__' in window ? nativeSessionAdapter(ref.server) : undefined});
    const base = '/api/workspaces/' + encodeURIComponent(ref.workspaceId) + '/calendar';
    return {
      remote: {client, base, preferenceKey: JSON.stringify([ref.server, ref.workspaceId, ref.accountId])},
      async list(from, to) {
        const query = new URLSearchParams({from, to, fromDate: localDate(from), toDate: localDate(to)});
        return (await client.request<{events: CalendarEvent[]}>(base + '?' + query)).events;
      },
      async save(event) {
        await client.request(base + '/' + encodeURIComponent(event.id), {method: 'PUT', body: JSON.stringify(event)});
        notifyCalendarChanged();
      },
      async remove(event) {
        await client.request(base + '/' + encodeURIComponent(event.id) + '?revision=' + encodeURIComponent(event.revision), {method: 'DELETE'});
        notifyCalendarChanged();
      },
      async respond(eventId, response) {
        await client.request(base + '/events/' + encodeURIComponent(eventId) + '/response', {method: 'PUT', body: JSON.stringify({response})});
        notifyCalendarChanged();
      },
    };
  }

  const file = 'workspace-calendar-v1';
  async function read(): Promise<CalendarEvent[]> {
    const data = await readFile(file, ref);
    if (data === null) return [];
    const events: unknown = JSON.parse(data);
    if (!Array.isArray(events)) throw new Error('Le fichier du calendrier est illisible.');
    return events as CalendarEvent[];
  }
  async function change(event: CalendarEvent, remove: boolean) {
    await withFileLock(ref.id, async () => {
      const events = await read();
      const current = events.find(entry => entry.id === event.id);
      if ((current?.revision ?? 0) !== event.revision || (remove && !current)) {
        throw new CloudApiError(409, 'Cet événement a changé. Rechargez le calendrier.');
      }
      const next = events.filter(entry => entry.id !== event.id);
      if (!remove) next.push({...event, revision: event.revision + 1});
      await writeFile(file, JSON.stringify(next), ref);
      notifyCalendarChanged();
    });
  }
  return {
    list: (from, to) => withFileLock(ref.id, async () => {
      const first = localDate(from), last = localDate(to);
      return (await read()).filter(event => event.allDay ? event.start < last && event.end > first : Date.parse(event.start) < Date.parse(to) && Date.parse(event.end) > Date.parse(from));
    }),
    save: event => change(event, false),
    remove: event => change(event, true),
  };
}
