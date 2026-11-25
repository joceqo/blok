import { openModalDialog } from '@blok/modal-dialog';
import { IconChevronLeft, IconChevronRight, IconCross, IconPlus, IconSidebarRight } from '../../src/components/icons';
import { button, el } from './ui/dom';
import type { CalendarEvent, CalendarStore } from './calendar-store';
import { exportCalendarEvent, importCalendarFile } from './calendar-ical';
import { bindCalendarGestures, rangeDraft } from './calendar-gestures';
import { mountWorkspaceRail } from './calendar-workspace-rail';
import { mountPlanning } from './calendar-planning';
import { getTimeFormatter, subscribeDisplayPreferences } from './display-preferences';
import type { CalendarWorkspaceEntry, CalendarWorkspaces } from './calendar-workspaces';
import type { WorkspaceRef } from './workspace-registry';
import './calendar.css';

export interface CalendarOptions {
  store: CalendarStore;
  pages: Array<{ id: string; title: string }>;
  openPage(id: string): void;
  workspaces?: CalendarWorkspaces;
  openWorkspacePage?(ref: WorkspaceRef, id: string): void;
  canEdit: boolean;
  onClose(): void;
  onToggleSidebar?(): void;
}

const fullDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const monthTitle = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const dayName = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });
const weekRange = new Intl.DateTimeFormat('fr-FR', { month: 'short', day: 'numeric' });
const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const localTime = (d: Date) => dateKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
const midnight = (d: Date, offset = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
const mondayOf = (d: Date) => midnight(d, -((d.getDay() + 6) % 7));
const minutes = (d: Date) => d.getHours() * 60 + d.getMinutes();
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'Le calendrier est indisponible.';

function iconAction(label: string, svg: string, click: () => void) {
  const node = button({ label, className: 'cal-icon', onClick: click });
  node.title = label;
  node.setAttribute('aria-label', label);
  node.innerHTML = svg;
  return node;
}

function draft(day: Date, time: number, allDay = false): CalendarEvent {
  const start = midnight(day);
  start.setMinutes(time);
  const end = new Date(start.valueOf() + 60 * 60_000);
  return { id: crypto.randomUUID(), title: '', start: allDay ? dateKey(day) : start.toISOString(),
    end: allDay ? dateKey(midnight(day, 1)) : end.toISOString(), allDay, pageId: null, revision: 0 };
}

/** Split at local midnight and assign overlapping appointments separate columns. */
function timedLayout(events: CalendarEvent[], day: Date) {
  const next = midnight(day, 1);
  const segments = events.filter(e => !e.allDay && Date.parse(e.start) < +next && Date.parse(e.end) > +day).map(event => {
    const start = new Date(event.start), end = new Date(event.end);
    const top = start <= day ? 0 : minutes(start);
    const bottom = end >= next ? 1440 : minutes(end);
    return { event, top, bottom: Math.max(top + 1, bottom), column: 0, count: 1 };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.event.id.localeCompare(b.event.id));
  let first = 0;
  while (first < segments.length) {
    let last = first, boundary = segments[first].bottom;
    const ends: number[] = [];
    while (last < segments.length && (last === first || segments[last].top < boundary)) {
      const segment = segments[last++];
      const free = ends.findIndex(end => end <= segment.top);
      segment.column = free < 0 ? ends.length : free;
      ends[segment.column] = segment.bottom;
      boundary = Math.max(boundary, segment.bottom);
    }
    for (let i = first; i < last; i++) segments[i].count = ends.length;
    first = last;
  }
  return segments;
}

function field(label: string, control: HTMLElement) {
  return el('label', { className: 'cal-field', children: [el('span', { text: label }), control] });
}

function editEvent(sidebar: HTMLElement, options: CalendarOptions, event: CalendarEvent, existing: boolean, changed: () => void, owner?: CalendarWorkspaceEntry) {
  const titleText = existing ? 'Événement' : 'Nouvel événement';
  const opener = document.activeElement;
  const form = el('form', { className: 'cal-editor', attrs: { 'aria-label':titleText } });
  const close = iconAction('Fermer', IconCross, () => { if (!busy) modal.close(); });
  form.append(el('header', { children: [el('h2', { text: titleText }), close] }));
  const title = el('input', { attrs: { name: 'title', placeholder: 'Titre de l’événement', required: '', maxlength: '200' } });
  title.value = event.title;
  const allDay = el('input', { attrs: { type: 'checkbox', name: 'allDay' } });
  allDay.checked = event.allDay;
  const start = el('input', { attrs: { name: 'start', required: '' } });
  const end = el('input', { attrs: { name: 'end', required: '' } });
  start.type = end.type = event.allDay ? 'date' : 'datetime-local';
  start.value = event.allDay ? event.start : localTime(new Date(event.start));
  // Users choose the last included day. The stored end of an all-day event is exclusive.
  end.value = event.allDay ? dateKey(midnight(new Date(event.end + 'T00:00'), -1)) : localTime(new Date(event.end));
  let previousStart = start.value;
  start.onchange = () => {
    if (!start.value || !end.value) return;
    if (allDay.checked) {
      // The distance between calendar dates stays the same through a clock change.
      const days = (Date.parse(end.value) - Date.parse(previousStart)) / 86_400_000;
      if (days >= 0) end.value = dateKey(midnight(new Date(start.value + 'T00:00'), days));
    } else {
      const duration = Date.parse(end.value) - Date.parse(previousStart);
      if (duration > 0) end.value = localTime(new Date(Date.parse(start.value) + duration));
    }
    previousStart = start.value;
  };
  allDay.onchange = () => {
    const a = start.value.slice(0, 10), b = end.value.slice(0, 10);
    start.type = end.type = allDay.checked ? 'date' : 'datetime-local';
    start.value = allDay.checked || !a ? a : a + 'T09:00';
    end.value = allDay.checked || !b ? b : b + 'T10:00';
    previousStart = start.value;
  };
  const page = el('select', { attrs: { name: 'pageId' } });
  const open = button({ label: 'Ouvrir la page', onClick: () => {
    if (!page.value) return;
    modal.close();
    if (destination && options.openWorkspacePage) options.openWorkspacePage(destination.ref, page.value);
    else options.openPage(page.value);
  } });
  const workspaces = options.workspaces;
  const choices = workspaces?.entries().filter(entry => entry.connected && (existing ? entry.id === owner?.id : entry.canEdit)) ?? [];
  let destination: CalendarWorkspaceEntry | undefined = owner ?? choices.find(entry => entry.visible && entry.id === workspaces?.activeId) ?? choices.find(entry => entry.visible) ?? choices[0];
  const target = el('select', {attrs:{name:'workspaceId'}});
  for (const entry of choices) target.append(new Option(entry.name, entry.id));
  if (destination) target.value = destination.id;
  target.disabled = existing || choices.length <= 1;
  const body = el('div', { className: 'cal-fields', children: [
    field('Titre', title), ...(workspaces ? [field('Agenda',target)] : []),
    el('label', { className: 'cal-check', children: [allDay, 'Toute la journée'] }),
    field('Début', start), field('Fin', end), field('Page Blok associée', page), open,
  ] });
  const footer = el('footer'), error = el('p', { className: 'cal-error', attrs: { role: 'alert' } });
  let busy = false;
  let alive = true;
  let pageRequest = 0, linkedPage = event.pageId;
  const canEdit = (destination?.canEdit ?? options.canEdit) && !event.source;
  function populate(pages: CalendarOptions['pages']) {
    page.replaceChildren(new Option('Aucune page',''), ...pages.map(p => new Option(p.title || 'Sans titre',p.id)));
    if (linkedPage && !pages.some(p => p.id === linkedPage)) page.append(new Option('Page liée',linkedPage));
    page.value = linkedPage ?? '';
    open.hidden = !linkedPage || !pages.some(p => p.id === linkedPage);
    page.disabled = !canEdit;
  }
  async function loadPages() {
    const stamp = ++pageRequest;
    if (!destination || destination.id === workspaces?.activeId) { populate(options.pages); return; }
    populate([]); page.disabled = true;
    try {
      const pages = await workspaces!.pages(destination.id);
      if (alive && stamp === pageRequest) populate(pages);
    } catch {
      if (alive && stamp === pageRequest) error.textContent = 'Impossible de charger les pages de cet espace.';
    }
  }
  page.onchange = () => { linkedPage = page.value || null; open.hidden = !linkedPage; };
  target.onchange = () => {
    destination = choices.find(entry => entry.id === target.value);
    linkedPage = null; error.textContent = ''; void loadPages();
  };
  void loadPages();
  let confirming = false;

  if (!canEdit) for (const control of [title, allDay, start, end, page]) control.disabled = true;
  const save = el('button', { text: 'Enregistrer', className: 'cal-primary', attrs: { type: 'submit' } });
  const remove = button({ label: 'Supprimer', className: 'cal-delete', onClick: () => {
    if (confirming) { void mutate(() => (destination?.store ?? options.store).remove(event)); return; }
    confirming = true;
    remove.textContent = 'Confirmer la suppression';
    remove.focus();
  } });
  async function mutate(operation: () => Promise<void>) {
    if (busy || !canEdit) return;
    busy = true;
    save.disabled = remove.disabled = true;
    error.textContent = '';
    try {
      await operation();
      if (alive) { modal.close(); changed(); }
    } catch (err) {
      if (alive) error.textContent = errorMessage(err);
    } finally {
      busy = false;
      save.disabled = remove.disabled = false;
    }
  }
  form.onsubmit = e => {
    e.preventDefault();
    if (!canEdit) return;
    const name = title.value.trim();
    if (!name) { error.textContent = 'Saisissez un titre.'; title.focus(); return; }
    // Keep the original instant when the wall time is unchanged, including through the autumn clock change.
    const instant = (value: string, original: string) => !allDay.checked && !event.allDay && value === localTime(new Date(original))
      ? new Date(original) : new Date(value + (allDay.checked ? 'T00:00' : ''));
    const from = instant(start.value, event.start), to = instant(end.value, event.end);
    if (allDay.checked) to.setDate(to.getDate() + 1);
    if (!(to > from)) { error.textContent = 'La fin doit être après le début.'; end.focus(); return; }
    void mutate(() => (destination?.store ?? options.store).save({ ...event, title: name, allDay: allDay.checked,
      start: allDay.checked ? dateKey(from) : from.toISOString(),
      end: allDay.checked ? dateKey(to) : to.toISOString(), pageId: page.value || linkedPage }));
  };
  if (existing) body.append(button({ label: 'Exporter en .ics', className: 'cal-export', onClick: () => exportCalendarEvent(event) }));
  if (canEdit && existing) footer.append(remove);
  if (canEdit) footer.append(button({label:'Annuler', onClick:() => { if (!busy) modal.close(); }}),save);
  form.append(body, error, footer);
  if (event.source) body.prepend(el('p', { className: 'cal-source-label', text: event.source.label }));
  const modal = { close() {
    const restoreFocus = form.contains(document.activeElement);
    alive = false;
    form.remove();
    if (restoreFocus && opener instanceof HTMLElement && opener.isConnected) opener.focus({preventScroll:true});
  } };
  form.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && !busy) {
      e.preventDefault();
      modal.close();
    }
  });
  sidebar.prepend(form);
  (canEdit ? title : close).focus();
  return modal;
}

export function mountCalendar(host: HTMLElement, options: CalendarOptions): { destroy(): void } {
  let hour = getTimeFormatter();
  let selected = midnight(new Date());
  let length = window.matchMedia?.('(max-width: 650px)').matches ? 1 : 7;
  const owners = new WeakMap<CalendarEvent, CalendarWorkspaceEntry>();
  const eventKey = (e: CalendarEvent) => owners.has(e) ? JSON.stringify([owners.get(e)!.id, e.id]) : e.id;
  let events: CalendarEvent[] = [], version = 0, modal: { close(): void } | undefined;
  let destroyed = false, visibleRange = '';
  const root = el('section', { className: 'blok-calendar', attrs: { 'aria-label': 'Calendrier' } });
  const rail = el('section', { className: 'cal-rail', attrs: { 'aria-label': 'Calendriers' } });
  function toggleRail(open: boolean) {
    rail.classList.toggle('cal-open', open); railToggle.setAttribute('aria-expanded',String(open));
  }
  const railToggle = button({ label: 'Agendas', className:'cal-rail-toggle', onClick:() => {
    const opening = !rail.classList.contains('cal-open');
    toggleRail(opening);
    if (opening) closeRail.focus();
  } });
  const closeRail = iconAction('Fermer les agendas',IconCross,() => { toggleRail(false); railToggle.focus(); });
  closeRail.classList.add('cal-rail-close');
  root.addEventListener('keydown',e => {
    if (!e.defaultPrevented && e.key === 'Escape' && rail.classList.contains('cal-open') && !root.querySelector('.cal-editor')) {
      toggleRail(false); railToggle.focus();
    }
  });
  root.addEventListener('pointerdown',e => {
    if (rail.classList.contains('cal-open') && !e.composedPath().includes(details) && !e.composedPath().includes(railToggle)) toggleRail(false);
  });
  railToggle.setAttribute('aria-expanded', 'false');
  const mini = el('div', { className: 'cal-mini' });
  const sourceHost = el('div', { className: 'cal-sources' });
  const details = el('section', { className: 'cal-details', attrs: { 'aria-label': 'Détails du calendrier' } });
  const agenda = el('div', { className: 'cal-agenda' });
  details.append(rail);
  const returnToBlok = button({label:'Blok', className:'cal-return', onClick:options.onClose});
  returnToBlok.setAttribute('aria-label','Retour à Blok'); returnToBlok.title = 'Retour à Blok';
  const back = el('span',{attrs:{'aria-hidden':'true'}}); back.innerHTML = IconChevronLeft; returnToBlok.prepend(back);
  rail.append(el('header', {className:'cal-brand', children:[el('h2',{text:'Calendrier',className:'cal-rail-title'}),returnToBlok,closeRail]}), mini, sourceHost, agenda);
  const heading = el('h1');
  let miniMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  let miniFocus = dateKey(selected);
  function selectDay(day: Date) {
    const wasInDrawer = rail.classList.contains('cal-open') && rail.contains(document.activeElement);
    selected = midnight(day);
    miniMonth = new Date(day.getFullYear(), day.getMonth(), 1);
    miniFocus = dateKey(day);
    toggleRail(false);
    void load();
    if (wasInDrawer) railToggle.focus();
  }
  function drawMini() {
    const focused = document.activeElement;
    const focusLabel = focused instanceof HTMLButtonElement && mini.contains(focused)
      ? focused.getAttribute('aria-label') : null;
    function browse(direction: number) {
      miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() + direction, 1);
      miniFocus = dateKey(miniMonth); drawMini();
    }
    const label = monthTitle.format(miniMonth);
    const caption = el('div', { className: 'cal-mini-toolbar', children: [
      el('strong', { text: label }), iconAction('Mois précédent', IconChevronLeft, () => browse(-1)),
      iconAction('Mois suivant', IconChevronRight, () => browse(1)),
    ] });
    const days = el('div', { className: 'cal-mini-grid', attrs: { role: 'group', 'aria-label': label } });
    for (const name of ['L', 'M', 'M', 'J', 'V', 'S', 'D']) days.append(el('span', { text: name, attrs: { 'aria-hidden': 'true' } }));
    const first = mondayOf(miniMonth);
    const selectedKey = dateKey(selected), current = dateKey(new Date());
    const weekStart = dateKey(length === 1 ? selected : mondayOf(selected));
    const weekEnd = dateKey(length === 1 ? selected : midnight(mondayOf(selected), 6));
    for (let i = 0; i < 42; i++) {
      const day = midnight(first, i), key = dateKey(day);
      const b = button({ label: String(day.getDate()), className: 'cal-mini-date', onClick: () => selectDay(day) });
      b.setAttribute('aria-label', fullDate.format(day) + ' ' + day.getFullYear());
      b.setAttribute('aria-pressed', String(selectedKey === key));
      b.dataset.date = key;
      b.tabIndex = key === miniFocus ? 0 : -1;
      b.onkeydown = e => {
        const offset: Record<string, number> = {ArrowLeft:-1, ArrowRight:1, ArrowUp:-7, ArrowDown:7,
          Home:-((day.getDay() + 6) % 7), End:6 - ((day.getDay() + 6) % 7)};
        if (!Object.hasOwn(offset, e.key)) return;
        e.preventDefault();
        const next = midnight(day, offset[e.key]);
        miniFocus = dateKey(next); miniMonth = new Date(next.getFullYear(), next.getMonth(), 1);
        drawMini();
        mini.querySelector<HTMLElement>('[data-date="' + miniFocus + '"]')?.focus();
      };
      if (key === current) b.setAttribute('aria-current', 'date');
      if (key >= weekStart && key <= weekEnd) b.classList.add('cal-in-week');
      if (day.getMonth() !== miniMonth.getMonth()) b.classList.add('cal-out-month');
      days.append(b);
    }
    mini.replaceChildren(caption, days);
    if (focusLabel) mini.querySelector<HTMLButtonElement>('[aria-label="' + CSS.escape(focusLabel) + '"]')?.focus({preventScroll:true});
  }
  const period = el('p');
  const today = button({ label: 'Aujourd’hui', onClick: () => selectDay(new Date()) });
  const view = el('select', { className: 'cal-view', attrs: { 'aria-label': 'Vue du calendrier' } });
  view.append(new Option('Jour', '1'), new Option('Semaine', '7'), new Option('Planning', 'agenda'));
  view.value = String(length);
  let timelineScroll = 7 * 56;
  view.onchange = () => {
    const wasPlanning = Boolean(planning);
    length = view.value === '1' ? 1 : 7;
    if (view.value === 'agenda') timelineScroll = scroll.scrollTop;
    void load();
    if (view.value === 'agenda') scroll.scrollTop = 0;
    else if (wasPlanning) scroll.scrollTop = timelineScroll;
  };
  function move(direction: number) { selectDay(midnight(selected, direction * length)); }
  const actions = el('div', { className: 'cal-actions', children: [railToggle, today,
    iconAction('Période précédente', IconChevronLeft, () => move(-1)),
    iconAction('Période suivante', IconChevronRight, () => move(1)), view] });
  const headingRow = el('header', { className: 'cal-heading',
    children: [el('div', { className: 'cal-title', children: [heading, period] }), actions] });
  if (options.onToggleSidebar) {
    const toggle = iconAction('Afficher ou masquer la barre latérale', IconSidebarRight, options.onToggleSidebar);
    toggle.setAttribute('data-desktop-sidebar-toggle', '');
    headingRow.prepend(toggle);
  }
  const destinations = () => options.workspaces?.entries().filter(entry => entry.connected && entry.canEdit);
  const canCreate = () => options.workspaces ? destinations()!.length > 0 : options.canEdit;
  const editable = (event: CalendarEvent) => !event.source && (owners.get(event)?.canEdit ?? options.canEdit);
  function openEvent(event: CalendarEvent, existing = true) {
    modal?.close();
    modal = editEvent(details, options, event, existing, () => { void load(); }, owners.get(event));
  }
  function drawCreateActions() {
    const current = actions.querySelector('.cal-create-actions');
    if (!canCreate()) { current?.remove(); return; }
    if (current) return;
    const importButton = button({ label: 'Importer .ics', className:'cal-import', onClick:() => {
      const writable = destinations() ?? [];
      if (writable.length < 2) { void importCalendarFile(root, writable[0]?.store ?? options.store, load); return; }
      const menu = el('div',{className:'cal-editor'});
      const select = el('select',{attrs:{name:'workspaceId'}});
      writable.forEach(entry => select.append(new Option(entry.name,entry.id)));
      const next = button({label:'Choisir le fichier',className:'cal-primary',onClick:() => {
        const selected = writable.find(entry => entry.id === select.value);
        if (selected) { dialog.close(); void importCalendarFile(root,selected.store,load); }
      }});
      menu.append(el('header',{children:[el('h2',{text:'Importer un calendrier'})]}),el('div',{className:'cal-fields',children:[field('Agenda',select)]}),el('footer',{children:[button({label:'Annuler',onClick:()=>dialog.close()}),next]}));
      const dialog = openModalDialog({label:'Importer un calendrier',content:el('div',{className:'cal-overlay',children:[menu]}),surface:menu,container:root,initialFocus:()=>select,onDismiss:()=>dialog.close()});
      modal?.close(); modal=dialog;
    } });
    const add = button({label:'Événement',className:'cal-primary',onClick:()=>openEvent(draft(selected,9*60),false)});
    const glyph = el('span',{attrs:{'aria-hidden':'true'}}); glyph.innerHTML=IconPlus; add.prepend(glyph);
    add.setAttribute('aria-label','Nouvel événement');
    actions.append(el('div',{className:'cal-create-actions',children:[importButton,add]}));
  }
  drawCreateActions();
  const notice = el('div', { className: 'cal-notice', attrs: { role: 'status', 'aria-live': 'polite' } });
  const scroll = el('div', { className: 'cal-scroll' });
  const board = el('div', { className: 'cal-board' });
  scroll.append(board);
  const main = el('section', { className: 'cal-main', children: [headingRow, notice, scroll] });
  root.append(main, details);
  host.append(root);
  const sources = mountWorkspaceRail(sourceHost, options.store, options.workspaces, () => { drawCreateActions(); void load(); });
  function shortcut(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || (target !== document.body && !root.contains(target)) ||
        target.closest('input, select, textarea, [contenteditable=true], button, [role=dialog]') || root.querySelector('.cal-editor')) return;
    switch (event.key.toLowerCase()) {
      case 'n': if (!canCreate()) return; openEvent(draft(selected,9*60),false); break;
      case 't': selectDay(new Date()); break;
      case 'j': move(-1); break;
      case 'k': move(1); break;
      default: return;
    }
    event.preventDefault();
  }
  document.addEventListener('keydown', shortcut);
  const stopGestures = bindCalendarGestures(board, id => events.find(e => editable(e) && eventKey(e) === id), async (event, original) => {
    if (!editable(original) || destroyed) return;
    try { await (owners.get(original)?.store ?? options.store).save(event); await load(); }
    catch (error) {
      if (destroyed) return;
      await load();
      if (!destroyed) notice.textContent = errorMessage(error);
    }
  }, (from, to, allDay) => {
    if (canCreate()) openEvent({...rangeDraft(from,to,allDay),id:crypto.randomUUID(),title:''},false);
  }, canCreate);
  function drawAgenda() {
    const now = new Date(), key = dateKey(now);
    const startOf = (e: CalendarEvent) => e.allDay ? new Date(e.start + 'T00:00') : new Date(e.start);
    const endOf = (e: CalendarEvent) => e.allDay ? new Date(e.end + 'T00:00') : new Date(e.end);
    const selectedDay = dateKey(selected);
    const period = selectedDay === key ? now : selected;
    const items = events.filter(e => endOf(e) > period).sort((a, b) => +startOf(a) - +startOf(b)).slice(0, 5);
    agenda.replaceChildren(el('h2', { text: 'À suivre' }));
    if (!items.length) agenda.append(el('p', { text: 'Aucun événement à venir sur cette période.' }));
    for (const e of items) {
      const item = button({ label: '', className: 'cal-agenda-entry', onClick: () => openEvent(e) });
      const date = startOf(e), label = dateKey(date) === key ? 'Aujourd’hui' : weekRange.format(date);
      item.style.setProperty('--event-color', e.source?.color ?? owners.get(e)?.color ?? '#54836b');
      item.append(el('small', { text: label + ' · ' + (e.allDay ? 'Journée' : hour.format(date)) }), el('strong', { text: e.title }));
      agenda.append(item);
    }
  }
  function eventButton(e: CalendarEvent, lastSegment: boolean) {
    const item = button({ label: e.title, className: 'cal-event', onClick: () => openEvent(e) });
    item.dataset.eventId = eventKey(e);
    const owner = owners.get(e);
    if (owner) { item.dataset.workspaceId = owner.id; item.style.setProperty('--event-color',owner.color); }
    item.title = e.title;
    if (editable(e)) {
      item.dataset.editableEvent = '';
      if (lastSegment) item.append(el('span', { className: 'cal-resize', attrs: { 'aria-hidden': 'true', title: 'Ajuster la fin' } }));
    }
    if (e.source) { item.classList.add('cal-external'); item.style.setProperty('--event-color', e.source.color); }
    item.setAttribute('aria-label', e.title + ', ' + (e.allDay ? 'toute la journée' : hour.format(new Date(e.start)) + ' à ' + hour.format(new Date(e.end))));
    if (!e.allDay) item.append(el('small', { text: hour.format(new Date(e.start)) + ' – ' + hour.format(new Date(e.end)) }));
    return item;
  }
  let planning: ReturnType<typeof mountPlanning> | undefined;
  function draw(start: Date, loading = false) {
    const days = Array.from({ length }, (_, i) => midnight(start, i));
    root.toggleAttribute('data-clock-12h', Boolean(hour.resolvedOptions().hour12));
    if (view.value === 'agenda') {
      board.dataset.length = 'agenda';
      if (!planning) { board.replaceChildren(); planning = mountPlanning(board); }
      planning.render({days,events,hour,ownerOf:event=>owners.get(event),keyOf:eventKey,open:openEvent,
        create:canCreate() ? () => openEvent(draft(selected, 9 * 60),false) : undefined, loading});
      return;
    }
    planning?.destroy(); planning = undefined;
    const focused = document.activeElement;
    const focusKey = focused instanceof HTMLButtonElement && board.contains(focused) ? focused.dataset.eventId : undefined;
    const focusDate = focused?.closest<HTMLElement>('[data-date]')?.dataset.date;
    board.replaceChildren();
    board.style.setProperty('--cal-days', String(length));
    board.dataset.length = String(length);
    const now = new Date();
    const dayLabels = el('div', { className: 'cal-days' });
    const zone = new Intl.DateTimeFormat('fr-FR', { timeZoneName: 'shortOffset' }).formatToParts(start).find(p => p.type === 'timeZoneName')?.value ?? '';
    dayLabels.append(el('span', { className: 'cal-zone', text: zone }));
    const allDay = el('div', { className: 'cal-all' });
    allDay.append(el('span', { text: 'Journée' }));
    const timeline = el('div', { className: 'cal-timeline' });
    const scale = el('div', { className: 'cal-scale' });
    for (let h = 1; h < 24; h++) {
      const label = el('span', { text: hour.format(new Date(2000, 0, 15, h)) }); label.style.top = (h / 24 * 100) + '%'; scale.append(label);
    }
    timeline.append(scale);
    for (const day of days) {
      const key = dateKey(day);
      const isToday = key === dateKey(now);
      const label = el(length === 7 ? 'button' : 'div', { className: 'cal-day-label', children: [
        el('span', { text: dayName.format(day).replace('.', '') }), el('strong', { text: String(day.getDate()) }),
      ] });
      if (label instanceof HTMLButtonElement) {
        label.type = 'button'; label.setAttribute('aria-label', 'Voir la journée du ' + fullDate.format(day));
        label.onclick = () => { view.value = '1'; length = 1; selectDay(day); view.focus(); };
      }
      if (isToday) label.setAttribute('aria-current', 'date');
      dayLabels.append(label);
      const lane = el('div', { className: 'cal-all-cell', attrs: { 'data-date': key } });
      const column = el('div', { className: 'cal-column', attrs: { 'data-date': key } });
      if (canCreate()) {
        const pick = (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('button')) return;
          const bounds = column.getBoundingClientRect();
          if (bounds.height) {
            const slot = Math.max(0, Math.min(1410, Math.floor((e.clientY - bounds.top) / bounds.height * 48) * 30));
            openEvent(draft(day, slot), false);
          }
        };
        column.addEventListener('click', pick);
        lane.addEventListener('click', e => { if (e.target === lane) openEvent(draft(day, 0, true), false); });
      }
      for (const event of events.filter(e => e.allDay && e.start <= key && e.end > key)) lane.append(eventButton(event, event.end === dateKey(midnight(day, 1))));
      allDay.append(lane);
      for (const item of timedLayout(events, day)) {
        const chip = eventButton(item.event, Date.parse(item.event.end) <= +midnight(day, 1));
        chip.style.top = (item.top / 1440 * 100) + '%';
        chip.style.height = 'calc(' + ((item.bottom - item.top) / 1440 * 100) + '% - 1px)';
        chip.style.left = 'calc(' + (item.column / item.count * 100) + '% + 2px)';
        chip.style.width = 'calc(' + (100 / item.count) + '% - 4px)';
        column.append(chip);
      }
      if (isToday) {
        const marker = el('div', { className: 'cal-now', attrs: { 'aria-hidden': 'true' } });
        marker.style.top = (minutes(now) / 1440 * 100) + '%'; column.append(marker);
      }
      timeline.append(column);
    }
    board.append(el('div', { className: 'cal-sticky', children: [dayLabels, allDay] }), timeline);
    if (focusKey) {
      const chips = Array.from(board.querySelectorAll<HTMLButtonElement>('[data-event-id]')).filter(chip => chip.dataset.eventId === focusKey);
      const sameDay = chips.find(chip => chip.closest<HTMLElement>('[data-date]')?.dataset.date === focusDate);
      (sameDay ?? chips[0] ?? view).focus({preventScroll:true});
    }
  }
  async function load() {
    if (destroyed) return;
    const stamp = ++version;
    const start = length === 7 ? mondayOf(selected) : selected;
    const last = midnight(start, length - 1);
    heading.textContent = monthTitle.format(selected);
    period.textContent = length === 1 ? fullDate.format(start) : weekRange.formatRange(start, last);
    const range = dateKey(start) + '/' + view.value;
    if (range !== visibleRange) {
      visibleRange = range; events = []; drawMini(); draw(start,true); drawAgenda();
      notice.textContent = 'Chargement…';
    } else {
      if (options.workspaces) {
        const allowed = new Set(options.workspaces.entries().filter(entry=>entry.connected && entry.visible).map(entry=>entry.id));
        const visible = events.filter(e=>allowed.has(owners.get(e)?.id ?? ''));
        if (visible.length < events.length) { events = visible; draw(start); drawAgenda(); }
        const editing = root.querySelector<HTMLSelectElement>('.cal-editor [name=workspaceId]');
        if (editing && !options.workspaces.entries().some(entry=>entry.id===editing.value && entry.connected)) modal?.close();
      }
      drawMini();
    }
    try {
      const from = start.toISOString(), to = midnight(start, length).toISOString();
      const {items,failed} = await sources.list(from,to);
      if (destroyed || stamp !== version) return;
      events = items.map(({event,owner}) => { if (owner) owners.set(event,owner); return event; });
      notice.replaceChildren();
      if (failed.length) notice.append('Agenda indisponible : '+failed.join(', ')+'. ',button({label:'Réessayer',onClick:load}));
      draw(start); drawAgenda();
    } catch (error) {
      if (destroyed || stamp !== version) return;
      notice.replaceChildren(document.createTextNode(errorMessage(error)), button({ label: 'Réessayer', onClick: load }));
    }
  }

  const stopPreferences = subscribeDisplayPreferences(() => {
    const next = getTimeFormatter();
    if (next === hour) return;
    hour = next;
    if (view.value !== 'agenda' || events.length) draw(length === 7 ? mondayOf(selected) : selected);
    drawAgenda();
  });
  void load();
  // Storybook and the shell may attach the returned DOM after mounting the view.
  const frame = window.requestAnimationFrame(() => { if (view.value !== 'agenda') scroll.scrollTop = 7 * 56; });
  return { destroy() { destroyed = true; version++; window.cancelAnimationFrame(frame); document.removeEventListener('keydown',shortcut); stopPreferences(); stopGestures(); sources.destroy(); modal?.close(); planning?.destroy(); root.remove(); } };
}
