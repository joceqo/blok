import { afterEach, expect, it, vi } from 'vitest';
import type { CalendarEvent, CalendarStore } from './calendar-store';
import { mountCalendar } from './calendar-view';
import { must } from './test-helpers';

const lifetimes: Array<{destroy():void}> = [];
afterEach(() => {
  lifetimes.splice(0).forEach(view => view.destroy());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const fixture = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: crypto.randomUUID(), title: 'Réunion', start, end, allDay: false, pageId: null, revision: 1, ...extra,
});

function setup(list: CalendarStore['list'], canEdit = true) {
  vi.setSystemTime(new Date(2026, 10, 25, 13));
  const store = { list: vi.fn(list), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const openPage = vi.fn();
  lifetimes.push(mountCalendar(document.body, { store, pages: [{ id: 'brief', title: 'Brief' }], canEdit, openPage, onClose: vi.fn() }));
  return { store, openPage };
}
function get<T extends HTMLElement = HTMLElement>(selector: string) {
  return must(document.querySelector<T>(selector), selector);
}
const click = (label: string) => get<HTMLButtonElement>('[aria-label="' + label + '"]').click();

it('uses Monday as the start, splits overnight events and places conflicting events side by side', async () => {
  const overnight = fixture(new Date(2026, 10, 24, 23).toISOString(), new Date(2026, 10, 25, 11).toISOString());
  const overlap = fixture(new Date(2026, 10, 25, 10).toISOString(), new Date(2026, 10, 25, 11).toISOString());
  const { store } = setup(async () => [overnight, overlap]);
  await vi.waitFor(() => expect(document.querySelectorAll('.cal-event')).toHaveLength(3));
  expect(new Date(store.list.mock.calls[0][0]).getDay()).toBe(1);
  const positions = document.querySelectorAll<HTMLButtonElement>('[data-event-id="' + overnight.id + '"]');
  expect(positions[1].style.width).toBe('calc(50% - 4px)');
  expect(get('[data-event-id="' + overlap.id + '"]').style.left).toBe('calc(50% + 2px)');
  click('Période suivante');
  expect(new Date(store.list.mock.calls[1][0]).getDate()).toBe(30);
});

it('saves an all-day event with inclusive dates in the form and an exclusive end in storage', async () => {
  const { store } = setup(async () => []);
  click('Nouvel événement');
  get<HTMLInputElement>('[name=title]').value = ' Journée atelier ';
  get<HTMLInputElement>('[name=allDay]').click();
  get<HTMLInputElement>('[name=start]').value = '2026-11-24';
  get<HTMLInputElement>('[name=end]').value = '2026-11-25';
  get<HTMLSelectElement>('[name=pageId]').value = 'brief';
  get<HTMLFormElement>('.cal-editor').requestSubmit();
  await vi.waitFor(() => expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Journée atelier', start: '2026-11-24', end: '2026-11-26', pageId: 'brief', allDay: true, revision: 0,
  })));
  expect(document.querySelector('.cal-editor')).toBeNull();
});

it('preserves revision on deletion, shows server errors and requires confirmation', async () => {
  const e = fixture('2026-11-24','2026-11-26',{allDay:true, revision:3});
  const { store } = setup(async () => [e]);
  store.remove.mockRejectedValueOnce(new Error('Cet événement a changé.'));
  await vi.waitFor(() => expect(document.querySelectorAll('.cal-all .cal-event')).toHaveLength(2));
  get('.cal-event').click();
  get('.cal-delete').click(); expect(store.remove).not.toHaveBeenCalled();
  get('.cal-delete').click();
  await vi.waitFor(() => expect(get('.cal-error').textContent).toBe('Cet événement a changé.'));
  expect(store.remove).toHaveBeenCalledWith(e);
  expect(document.querySelector('.cal-editor')).toBeTruthy();
});

it('allows viewing and opening an associated page with read-only access', async () => {
  const e = fixture('2026-11-25','2026-11-26',{allDay:true,pageId:'brief'});
  const { store, openPage } = setup(async () => [e], false);
  expect(document.querySelector('[aria-label="Nouvel événement"]')).toBeNull();
  await vi.waitFor(() => expect(document.querySelector('.cal-event')).toBeTruthy());
  get('.cal-event').click();
  expect(get<HTMLInputElement>('[name=title]').disabled).toBe(true);
  expect(document.querySelector('.cal-delete')).toBeNull();
  get<HTMLFormElement>('.cal-editor').requestSubmit();
  expect(store.save).not.toHaveBeenCalled();
  const link = [...document.querySelectorAll<HTMLButtonElement>('.cal-fields button')].find(b => b.textContent === 'Ouvrir la page');
  must(link).click();
  expect(openPage).toHaveBeenCalledWith('brief');
});

it('discards previous results if a different week was opened before loading finished', async () => {
  let first: (e: CalendarEvent[]) => void = () => {};
  let calls = 0;
  setup(() => ++calls === 1 ? new Promise(resolve => { first = resolve; }) : Promise.resolve([]));
  click('Période suivante');
  await vi.waitFor(() => expect(get('.cal-notice').textContent).toBe(''));
  first([fixture('2026-11-30', '2026-12-01', { allDay: true })]);
  await Promise.resolve();
  expect(document.querySelector('.cal-event')).toBeNull();
});

it('shows a subscribed event in its source color with no edit or drag affordances', async () => {
  const e = fixture('2026-11-25','2026-11-26',{allDay:true,source:{id:'g',label:'Équipe',color:'#6482ae'}});
  setup(async () => [e]);
  await vi.waitFor(() => expect(document.querySelector('.cal-external')).toBeTruthy());
  const chip = get('.cal-external');
  expect(chip.style.getPropertyValue('--event-color')).toBe('#6482ae');
  expect(chip.hasAttribute('data-editable-event')).toBe(false);
  chip.click();
  expect(get('.cal-source-label').textContent).toBe('Équipe');
  expect(get<HTMLInputElement>('[name=title]').disabled).toBe(true);
  expect(document.querySelector('.cal-editor button[type=submit]')).toBeNull();
});

it('reloads the stored event and reports a conflicting drop', async () => {
  const e = fixture(new Date(2026,10,23,10).toISOString(),new Date(2026,10,23,11).toISOString());
  const {store} = setup(async () => [e]);
  store.save.mockRejectedValueOnce(new Error('Événement modifié entre-temps.'));
  await vi.waitFor(() => expect(document.querySelector('.cal-column .cal-event')).toBeTruthy());
  const columns = document.querySelectorAll<HTMLElement>('.cal-column');
  columns.forEach((col, i) => { col.getBoundingClientRect = () => new DOMRect(100*i,0,100,1440); });
  const dispatch = (node: EventTarget, type: string, clientX: number, clientY: number) => {
    node.dispatchEvent(new PointerEvent(type, {bubbles:true,pointerId:1,isPrimary:true,button:0,clientX,clientY}));
  };
  dispatch(get('.cal-column .cal-event'), 'pointerdown', 10, 605);
  dispatch(document, 'pointermove', 110, 635);
  expect(document.querySelector('.cal-drag-preview')).toBeTruthy();
  dispatch(document, 'pointerup', 110, 635);
  await vi.waitFor(() => expect(get('.cal-notice').textContent).toContain('modifié entre-temps'));
  expect(store.save).toHaveBeenCalledWith(expect.objectContaining({revision:e.revision,start:new Date(2026,10,24,10,30).toISOString()}));
  expect(get('.cal-event').closest('.cal-column')?.getAttribute('data-date')).toBe('2026-11-23');
});
