import { afterEach, expect, it, vi } from 'vitest';
import type { CalendarEvent, CalendarStore } from './calendar-store';
import { mountCalendar } from './calendar-view';
import { getTimeFormatter, setTimeFormat } from './display-preferences';
import { must } from './test-helpers';

const lifetimes: Array<{destroy():void}> = [];
afterEach(() => {
  lifetimes.splice(0).forEach(view => view.destroy());
  localStorage.removeItem('blok:desktop:time-format');
  document.documentElement.removeAttribute('data-desktop-time-format');
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

it('overlays two spaces with the same event id and saves edits and linked pages in the chosen space', async () => {
  vi.setSystemTime(new Date(2026,10,25,13));
  const event = fixture('2026-11-25','2026-11-26',{allDay:true,id:'overlap',pageId:'brief'});
  function workspace(id:string, connected:boolean) {
    const ref = {kind:'local' as const,id,name:id};
    const store = {list:vi.fn(async()=>[{...event,title:id}]),save:vi.fn(async()=>{}),remove:vi.fn(async()=>{})};
    return {id,ref,name:id,store,connected,visible:connected,canEdit:true,color:'#54836b'};
  }
  const a = workspace('A',true), b = workspace('B',false);
  const spaces = {
    activeId:a.id, entries:()=>[a,b], refresh:async()=>{},
    connect:async()=>{b.connected=b.visible=true;}, disconnect:async()=>{b.connected=b.visible=false;},
    setVisible:async(id:string,v:boolean)=>{(id===b.id?b:a).visible=v;},
    pages:vi.fn(async()=>[{id:'brief',title:'Page B'}]),
  };
  const openWorkspacePage = vi.fn();
  lifetimes.push(mountCalendar(document.body,{store:a.store,canEdit:true,pages:[{id:'brief',title:'Page A'}],
    workspaces:spaces,openPage:vi.fn(),openWorkspacePage,onClose:vi.fn()}));
  await vi.waitFor(()=>expect(document.querySelectorAll('.cal-event')).toHaveLength(1));
  const addSpace = get<HTMLSelectElement>('select[aria-label="Ajouter un espace"]');
  addSpace.value='B'; addSpace.dispatchEvent(new Event('change'));
  await vi.waitFor(()=>expect(document.querySelectorAll('.cal-event')).toHaveLength(2));
  get('.cal-event[data-workspace-id="B"]').click();
  await vi.waitFor(()=>expect(get('[name=pageId]').textContent).toContain('Page B'));
  expect(get('[name=pageId]').textContent).not.toContain('Page A');
  get<HTMLButtonElement>('.cal-fields button').click();
  expect(openWorkspacePage).toHaveBeenCalledWith(b.ref,'brief');
  click('Nouvel événement');
  const target = get<HTMLSelectElement>('[name=workspaceId]');
  target.value='B';target.dispatchEvent(new Event('change'));
  await vi.waitFor(()=>expect(get('[name=pageId]').textContent).toContain('Page B'));
  get<HTMLInputElement>('[name=title]').value='Plénière';
  get<HTMLSelectElement>('[name=pageId]').value='brief';
  get<HTMLFormElement>('.cal-editor').requestSubmit();
  await vi.waitFor(()=>expect(b.store.save).toHaveBeenCalledWith(expect.objectContaining({title:'Plénière',pageId:'brief'})));
  expect(a.store.save).not.toHaveBeenCalled();
  get<HTMLInputElement>('.cal-space-group[data-workspace-id="B"] input').click();
  await vi.waitFor(()=>expect(document.querySelector('.cal-event[data-workspace-id="B"]')).toBeNull());
});

it('opens a draft for the selected time range when dragging upwards through an empty day', async () => {
  setup(async()=>[]);
  await vi.waitFor(()=>expect(get('.cal-notice').textContent).toBe(''));
  const column=get('.cal-column');
  column.getBoundingClientRect=()=>new DOMRect(0,0,100,1440);
  const pointer=(node:EventTarget,type:string,y:number)=>node.dispatchEvent(new PointerEvent(type,{
    bubbles:true,isPrimary:true,pointerType:'mouse',pointerId:1,button:0,clientX:20,clientY:y,
  }));
  pointer(column,'pointerdown',690);
  pointer(document,'pointermove',570);
  expect(document.querySelector('.cal-drag-preview')).toBeTruthy();
  pointer(document,'pointerup',570);
  expect(get<HTMLInputElement>('[name=start]').value).toBe('2026-11-23T09:30');
  expect(get<HTMLInputElement>('[name=end]').value).toBe('2026-11-23T11:30');
});

it('shows a weekly planning grouped by local date with all-day entries first and exclusive ends', async () => {
  setTimeFormat('24h');
  const timed = fixture(new Date(2026,10,25,23).toISOString(), new Date(2026,10,26,1).toISOString(), {title:'Passation'});
  const allDay = fixture('2026-11-25','2026-11-26',{allDay:true,title:'Atelier'});
  setup(async () => [timed, allDay], false);
  const view = get<HTMLSelectElement>('.cal-view');
  view.value = 'agenda'; view.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelectorAll('.cal-planning-event')).toHaveLength(3));
  const groups = document.querySelectorAll('.cal-planning-day');
  expect(groups.length).toBe(2);
  expect(groups[0].querySelector('.cal-planning-event strong')?.textContent).toBe('Atelier');
  expect(groups[0].textContent).toContain('23:00 – 24:00');
  expect(groups[1].textContent).toContain('00:00 – 01:00');
  setTimeFormat('12h');
  const midnight = getTimeFormatter().format(new Date(2026,10,26));
  await vi.waitFor(() => expect(groups[0].textContent).toContain(getTimeFormatter().format(new Date(2026,10,25,23)) + ' – ' + midnight));
  expect(groups[1].textContent).toContain(midnight + ' – ' + getTimeFormatter().format(new Date(2026,10,26,1)));
  get<HTMLButtonElement>('.cal-planning-event').click();
  expect(get<HTMLInputElement>('[name=title]').value).toBe('Atelier');
  expect(document.querySelector('.cal-editor [type=submit]')).toBeNull();
});

it('updates clock labels and event times in place while keeping local input values', async () => {
  const start = new Date(2026,10,25,16,30), end = new Date(2026,10,25,17,30);
  const { store } = setup(async () => [fixture(start.toISOString(), end.toISOString())]);
  await vi.waitFor(() => expect(document.querySelector('.cal-event')).toBeTruthy());
  for (const mode of ['24h', '12h'] as const) {
    setTimeFormat(mode);
    const format = getTimeFormatter();
    expect(format.resolvedOptions().hour12).toBe(mode === '12h');
    expect(get('.cal-scale').textContent).toContain(format.format(new Date(2000,0,15,16)));
    expect(get('.cal-event small').textContent).toBe(format.format(start) + ' – ' + format.format(end));
    expect(get('.cal-agenda-entry').textContent).toContain(format.format(start));
  }
  expect(store.list).toHaveBeenCalledTimes(1);
  get<HTMLButtonElement>('.cal-event').click();
  expect(get<HTMLInputElement>('[name=start]').value).toBe('2026-11-25T16:30');
});

it('opens a day from the week, keeps draft duration when moving it, then cancels back to its opener', async () => {
  const {store} = setup(async () => []);
  get<HTMLButtonElement>('button.cal-day-label').click();
  expect(get<HTMLSelectElement>('.cal-view').value).toBe('1');
  const newEvent = get<HTMLButtonElement>('[aria-label="Nouvel événement"]');
  newEvent.focus(); newEvent.click();
  expect(get('.cal-details .cal-editor')).toBeTruthy();
  expect(get('.cal-details .cal-mini')).toBeTruthy();
  const start = get<HTMLInputElement>('[name=start]');
  expect(start.value).toBe('2026-11-23T09:00');
  start.value = '2026-11-23T15:30'; start.dispatchEvent(new Event('change'));
  expect(get<HTMLInputElement>('[name=end]').value).toBe('2026-11-23T16:30');
  start.focus();
  start.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  expect(document.querySelector('.cal-editor')).toBeNull();
  expect(document.activeElement).toBe(newEvent);
  expect(store.save).not.toHaveBeenCalled();
});
