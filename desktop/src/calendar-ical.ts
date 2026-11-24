import ICAL from 'ical.js';
import type { CalendarEvent, CalendarStore } from './calendar-store';
import { CloudApiError } from './cloud/client';
import './calendar-import.css';

const maxEvents = 250;
const blockedProperties = ['rrule', 'rdate', 'exdate', 'recurrence-id'];
const exportUid = /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})@blok\.calendar$/i;

async function importId(uid: string): Promise<string> {
  const existing = exportUid.exec(uid);
  if (existing) return existing[1].toLowerCase();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blok-calendar-ical:' + uid)));
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export async function readCalendarFile(source: string) {
  const root = new ICAL.Component(ICAL.parse(source.trim()));
  if (root.name !== 'vcalendar') throw new Error('Ce fichier ne contient pas de calendrier iCalendar.');
  const components = root.getAllSubcomponents('vevent');
  if (components.length > maxEvents) throw new Error('Importez au maximum 250 événements par fichier.');
  const events: CalendarEvent[] = [];
  const skipped = new Set<string>();
  const seen = new Set<string>();
  for (const item of components) {
    if (blockedProperties.some(key => item.hasProperty(key))) { skipped.add('séries récurrentes'); continue; }
    if (root.getFirstPropertyValue('method') === 'CANCEL' || item.getFirstPropertyValue('status') === 'CANCELLED') {
      skipped.add('événements annulés'); continue;
    }
    const event = new ICAL.Event(item);
    const title = (event.summary || '').trim();
    if (!event.uid || !title || [...title].length > 300 || title.includes('\0') || !item.hasProperty('dtstart')) {
      skipped.add('événements incomplets ou titre trop long'); continue;
    }
    if (['dtstart', 'dtend'].some(key => {
      const tz = item.getFirstProperty(key)?.getParameter('tzid');
      return typeof tz === 'string' && !root.getTimeZoneByID(tz) && !ICAL.TimezoneService.has(tz);
    })) { skipped.add('fuseaux horaires sans définition'); continue; }
    const startDate = event.startDate, endDate = event.endDate;
    const allDay = startDate.isDate;
    const start = allDay ? startDate.toString() : startDate.toJSDate().toISOString();
    const end = allDay ? endDate.toString() : endDate.toJSDate().toISOString();
    if (allDay !== endDate.isDate || start >= end) { skipped.add('durées absentes ou invalides'); continue; }
    const id = await importId(event.uid);
    if (seen.has(id)) { skipped.add('identifiants en double'); continue; }
    seen.add(id);
    events.push({id, title, start, end, allDay, pageId: null, revision: 0});
  }
  return {events, skipped: [...skipped], omitted: components.length - events.length};
}

export function eventToIcal(event: CalendarEvent): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//Blok//Calendrier//FR');
  const component = new ICAL.Component('vevent');
  calendar.addSubcomponent(component);
  const entry = new ICAL.Event(component);
  entry.uid = event.id + '@blok.calendar';
  entry.summary = event.title;
  const time = (value: string) => event.allDay ? ICAL.Time.fromDateString(value) : ICAL.Time.fromJSDate(new Date(value), true);
  entry.startDate = time(event.start);
  entry.endDate = time(event.end);
  component.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  return calendar.toString() + '\r\n';
}

export function exportCalendarEvent(event: CalendarEvent): void {
  const url = URL.createObjectURL(new Blob([eventToIcal(event)], {type: 'text/calendar;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'blok-' + event.id + '.ics';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function importCalendarFile(host: HTMLElement, store: CalendarStore, refresh: () => void | Promise<void>): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'blok-calendar-import';
  dialog.setAttribute('aria-label', 'Importer un calendrier');
  const title = document.createElement('h2');
  title.textContent = 'Importer un calendrier';
  const description = document.createElement('p');
  description.textContent = 'Les événements importés seront visibles dans cet espace. Seuls les titres et les horaires seront ajoutés.';
  const file = document.createElement('input');
  file.type = 'file'; file.accept = '.ics,text/calendar'; file.setAttribute('aria-label', 'Fichier iCalendar');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const list = document.createElement('ul');
  const actions = document.createElement('footer');
  const close = document.createElement('button');
  close.textContent = 'Fermer'; close.onclick = () => dialog.close();
  const confirm = document.createElement('button');
  confirm.textContent = 'Importer'; confirm.disabled = true;
  actions.append(close, confirm);
  dialog.append(title, description, file, status, list, actions);
  host.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), {once: true});
  dialog.showModal();
  let pending: CalendarEvent[] = [];
  let busy = false;
  let selection = 0;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  file.onchange = async () => {
    const chosen = file.files?.[0];
    const version = ++selection;
    pending = []; confirm.disabled = true; list.replaceChildren(); status.textContent = '';
    if (!chosen) return;
    try {
      if (chosen.size > 2_000_000) throw new Error('Le fichier doit faire moins de 2 Mo.');
      const {events, skipped, omitted} = await readCalendarFile(await chosen.text());
      if (selection !== version || !dialog.isConnected) return;
      pending = events;
      for (const item of events) {
        const row = document.createElement('li');
        row.textContent = item.title + ' · ' + (item.allDay ? item.start : new Date(item.start).toLocaleString('fr-FR', {dateStyle: 'short', timeStyle: 'short'}));
        list.append(row);
      }
      status.textContent = events.length + ' à importer.' + (omitted ? ' Éléments ignorés (' + omitted + ') : ' + skipped.join(', ') + '.' : '');
      confirm.disabled = !events.length;
    } catch (error) { if (version === selection) status.textContent = error instanceof Error ? error.message : 'Fichier illisible.'; }
  };
  confirm.onclick = async () => {
    if (busy || !pending.length) return;
    busy = true; confirm.disabled = true; file.disabled = true; close.disabled = true;
    let added = 0, duplicates = 0;
    try {
      while (pending.length && dialog.isConnected) {
        try { await store.save(pending[0]); added++; }
        catch (error) {
          if (!(error instanceof CloudApiError && error.status === 409)) throw error;
          duplicates++;
        }
        pending.shift();
      }
      status.textContent = added + ' ajouté(s), ' + duplicates + ' déjà présent(s).';
    } catch (error) {
      status.textContent = added + ' ajouté(s). ' + (error instanceof Error ? error.message : 'Import interrompu.');
    } finally {
      busy = false; file.disabled = false; close.disabled = false; confirm.disabled = !pending.length;
      if (added && host.isConnected) await refresh();
    }
  };
}
