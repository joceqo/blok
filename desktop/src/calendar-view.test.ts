import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CalendarEvent, CalendarStore} from './calendar-store';
import {mountCalendar, type CalendarOptions} from './calendar-view';
import {setTimeFormat} from './display-preferences';
import {must} from './test-helpers';

const lifetimes: Array<{destroy():void}> = [];
beforeEach(() => {
  vi.setSystemTime(new Date(2026, 10, 25, 13));
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', (query: string) => ({
    media:query, matches:false, addEventListener() {}, removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {configurable:true, value:vi.fn()});
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable:true, value:vi.fn()});
});
afterEach(() => {
  lifetimes.splice(0).forEach(view => view.destroy());
  localStorage.removeItem('blok:desktop:time-format');
  document.documentElement.removeAttribute('data-desktop-time-format');
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const fixture = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id:crypto.randomUUID(), title:'Réunion', start, end, allDay:false, pageId:null, revision:1, ...extra,
});
const createStore = (list: CalendarStore['list']) => ({
  list:vi.fn(list), save:vi.fn(async (_event:CalendarEvent) => {}), remove:vi.fn(async (_event:CalendarEvent) => {}),
});

function setup(list: CalendarStore['list'], options: Partial<CalendarOptions> = {}) {
  const store = createStore(list);
  const openPage = vi.fn();
  lifetimes.push(mountCalendar(document.body, {
    store, pages:[{id:'brief',title:'Brief'}], canEdit:true, openPage, onClose:vi.fn(), ...options,
  }));
  return {store,openPage};
}

async function element<T extends HTMLElement = HTMLElement>(selector: string) {
  return vi.waitFor(() => must(document.querySelector<T>(selector), selector));
}
const labeled = (label:string) => element<HTMLElement>(`[aria-label="${label}"]`);
const input = () => element<HTMLInputElement>('[data-event-title]');
const chip = (id:string) => element<HTMLElement>(`[data-event-id=${JSON.stringify(id)}]`);
function button(name:string) {
  return vi.waitFor(() => must([...document.querySelectorAll('button')].find(item=>item.textContent === name),name));
}
function type(field:HTMLInputElement, value:string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', {bubbles:true}));
}
async function choose(label:string, option:string) {
  const trigger = await element<HTMLButtonElement>(`button[aria-label="${label}"]`);
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  const item = await vi.waitFor(() => must([...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')]
    .find(optionNode=>(optionNode.getAttribute("aria-label") ?? optionNode.textContent?.trim()) === option), option));
  item.click();
}

it('opens the week on Monday and shows a multi-day banner alongside overlapping timed events', async () => {
  const overnight = fixture(new Date(2026,10,24,23).toISOString(), new Date(2026,10,25,11).toISOString());
  const overlap = fixture(new Date(2026,10,25,10).toISOString(), new Date(2026,10,25,11).toISOString());
  const sameDay = fixture(new Date(2026,10,25,10,30).toISOString(),new Date(2026,10,25,11,30).toISOString());
  const {store} = setup(async()=>[overnight,overlap,sameDay]);
  const conflict = await chip(overlap.id);
  const positions = document.querySelectorAll<HTMLElement>(`[data-event-id="${overnight.id}"]`);
  expect(positions).toHaveLength(1);
  expect((await chip(sameDay.id)).style.left).not.toEqual(conflict.style.left);
  expect(new Date(store.list.mock.calls[0][0]).getDay()).toBe(1);
  (await labeled('Période suivante')).click();
  await vi.waitFor(()=>expect(new Date(store.list.mock.calls.at(-1)![0]).getDate()).toBe(30));
});

it('previews a draft without writing, saves its linked page and persists an exclusive all-day end', async () => {
  const {store} = setup(async()=>[]);
  (await labeled('Nouvel événement')).click();
  const title = await input();
  await vi.waitFor(() => expect(document.activeElement).toBe(title));
  type(title,' Journée atelier ');
  (await labeled('Toute la journée')).click();
  await choose('Page Blok associée','Brief');
  expect(store.save).not.toHaveBeenCalled();
  (await button('Enregistrer')).click();
  await vi.waitFor(()=>expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
    title:'Journée atelier',start:'2026-11-25',end:'2026-11-26',pageId:'brief',allDay:true,revision:0,
  })));
  await vi.waitFor(()=>expect(document.querySelector('[data-calendar-event-inspector]')).toBeNull());
});

it('restores the original hours when switching an event to all-day and back before saving', async () => {
  const event = fixture(new Date(2026,10,25,16,30).toISOString(),new Date(2026,10,25,17,30).toISOString(),{revision:7});
  const {store} = setup(async()=>[event]);
  (await chip(event.id)).click();
  const toggle = await labeled('Toute la journée');
  toggle.click();
  await vi.waitFor(()=>expect(toggle.getAttribute('aria-checked')).toBe('true'));
  toggle.click();
  await vi.waitFor(()=>expect(toggle.getAttribute('aria-checked')).toBe('false'));
  (await button('Enregistrer')).click();
  await vi.waitFor(()=>expect(store.save).toHaveBeenCalledWith(event));
});

it('requires confirmation before deletion, retains the revision and allows retry on conflict', async () => {
  const event = fixture('2026-11-24','2026-11-26',{allDay:true,revision:3});
  const {store} = setup(async()=>[event]);
  store.remove.mockRejectedValueOnce(new Error('Cet événement a changé.'));
  (await chip(event.id)).click();
  (await labeled('Supprimer')).click();
  expect(store.remove).not.toHaveBeenCalled();
  (await labeled('Confirmer la suppression')).click();
  await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('Cet événement a changé.'));
  (await labeled('Confirmer la suppression')).click();
  await vi.waitFor(()=>expect(document.querySelector('[data-calendar-event-inspector]')).toBeNull());
  expect(store.remove.mock.calls).toEqual([[event],[event]]);
});

it.each([false,true])('keeps events read-only with source or workspace restrictions (external=%s)', async external => {
  const event = fixture('2026-11-25','2026-11-26',{allDay:true,pageId:'brief',
    ...external && {source:{id:'g',label:'Équipe',color:'#6482ae'}}});
  const {store,openPage} = setup(async()=>[event],{canEdit:external});
  (await chip(event.id)).click();
  expect((await input()).readOnly).toBe(true);
  expect(document.querySelector('[aria-label="Supprimer"]')).toBeNull();
  expect(document.querySelector('[data-calendar-event-inspector]')?.textContent).not.toContain('Enregistrer');
  if (external) expect((await labeled('Agenda')).textContent).toBe('Équipe');
  else expect(document.querySelector('[aria-label="Nouvel événement"]')).toBeNull();
  (await labeled('Ouvrir la page')).click();
  expect(openPage).toHaveBeenCalledWith('brief');
  expect(store.save).not.toHaveBeenCalled();
});

it('drops a late result from a previous week', async () => {
  let resolve!: (events: CalendarEvent[]) => void;
  const pending = new Promise<CalendarEvent[]>(done=>{resolve=done;});
  const old = fixture('2026-11-30','2026-12-01',{allDay:true,title:'Ancienne réponse'});
  const current = {...old,id:'new',title:'Semaine suivante'};
  const {store} = setup(async from => new Date(from).getDate()===23 ? pending : [current]);
  await vi.waitFor(()=>expect(store.list).toHaveBeenCalled());
  (await labeled('Période suivante')).click();
  await chip(current.id);
  resolve([old]);
  await new Promise(done=>setTimeout(done,0));
  expect(document.querySelector(`[data-event-id="${old.id}"]`)).toBeNull();
  expect(await chip(current.id)).toBeTruthy();
});

it('opens a page in its owning workspace and saves a new event to the selected workspace', async () => {
  const event = fixture('2026-11-25','2026-11-26',{allDay:true,id:'shared-id',pageId:'brief'});
  function workspace(id:string,connected:boolean) {
    const store = createStore(async()=>[{...event,title:id}]);
    return {id,name:id,ref:{kind:'local' as const,id,name:id},store,connected,visible:connected,canEdit:true,color:'#54836b'};
  }
  const a = workspace('A',true), b = workspace('B',false);
  const spaces = {
    activeId:a.id,entries:()=>[a,b],refresh:async()=>{},
    connect:async()=>{b.connected=b.visible=true;},disconnect:async()=>{b.connected=b.visible=false;},
    setVisible:async(id:string,value:boolean)=>{(id===b.id?b:a).visible=value;},
    pages:vi.fn(async()=>[{id:'brief',title:'Page B'}]),
  };
  const openWorkspacePage = vi.fn();
  setup(async()=>[],{store:a.store,workspaces:spaces,pages:[{id:'brief',title:'Page A'}],openWorkspacePage});
  (await labeled('Afficher B')).click();
  const secondaryEvent = await vi.waitFor(()=>must([...document.querySelectorAll<HTMLElement>('[data-event-id]')].find(node=>node.textContent?.includes('B'))));
  expect(document.querySelectorAll('[data-event-id]')).toHaveLength(2);
  secondaryEvent.click();
  const pageLink = await labeled('Ouvrir la page');
  expect((await labeled('Page Blok associée')).textContent).toBe('Page B');
  pageLink.click();
  expect(openWorkspacePage).toHaveBeenCalledWith(b.ref,'brief');
  (await labeled('Nouvel événement')).click();
  type(await input(),'Plénière');
  await choose('Agenda','B');
  await choose('Page Blok associée','Page B');
  (await button('Enregistrer')).click();
  await vi.waitFor(()=>expect(b.store.save).toHaveBeenCalledWith(expect.objectContaining({title:'Plénière',pageId:'brief'})));
  expect(a.store.save).not.toHaveBeenCalled();
});

it('shows the agenda, switches the time format and opens an entry from that view', async () => {
  const start = new Date(2026,10,25,16,30), end = new Date(2026,10,25,17,30);
  const event = fixture(start.toISOString(),end.toISOString());
  setTimeFormat('24h');
  setup(async()=>[event]);
  await choose('Vue du calendrier','Agenda');
  await chip(event.id);
  expect((await chip(event.id)).getAttribute('aria-label')).toContain('16:30');
  setTimeFormat('12h');
  await vi.waitFor(()=>expect(document.querySelector('[data-event-id]')?.getAttribute('aria-label')).toMatch(/4:30/i));
  (await chip(event.id)).click();
  expect((await input()).value).toBe(event.title);
  expect((await element<HTMLInputElement>('[data-testid=event-start-time]')).value).toMatch(/4:30/);
});

it('loads the month and year, navigates across years and opens a dated day from the year', async () => {
  const event = fixture(new Date(2026,10,25,10).toISOString(), new Date(2026,10,25,11).toISOString());
  const {store} = setup(async () => [event]);
  await choose('Vue du calendrier', 'Mois');
  await chip(event.id);
  const heading = document.querySelector('[data-calendar-grid] h1')!;
  await vi.waitFor(() => expect(heading.textContent).toMatch(/novembre/i));
  (await labeled('Période suivante')).click();
  await vi.waitFor(() => expect(heading.textContent).toMatch(/décembre/i));
  (await button('Aujourd’hui')).click();
  await vi.waitFor(() => expect(heading.textContent).toMatch(/novembre/i));
  const lastRange = () => store.list.mock.calls.at(-1)!.map(value => new Date(value));
  await vi.waitFor(() => expect(+lastRange()[1] - +lastRange()[0]).toBeGreaterThan(27 * 86400000));
  await choose('Vue du calendrier', 'Année');
  const day = (value:string) => element<HTMLButtonElement>(`button[data-date="${value}"]`);
  await day('2026-12-31');
  await vi.waitFor(() => expect((document.querySelector('button[data-date="2026-11-25"]')?.getAttribute('aria-label'))).toMatch(/1 (event|événement)/));
  expect(lastRange()[0].getMonth()).toBe(0);
  (await labeled('Période suivante')).click();
  await day('2027-12-31');
  (await button('Aujourd’hui')).click();
  (await day('2026-10-15')).click();
  await vi.waitFor(() => {
    expect(document.querySelector('[aria-label="Vue du calendrier"]')?.textContent).toBe('Jour');
    expect(lastRange()[0].getMonth()).toBe(9);
    expect(lastRange()[0].getDate()).toBe(15);
  });
});

it('uses a single right panel and returns focus to the opener when cancelling a draft', async () => {
  const {store} = setup(async()=>[]);
  const opener = await labeled('Nouvel événement');
  opener.focus(); opener.click();
  await input();
  expect(document.querySelectorAll('.blok-calendar-panel')).toHaveLength(1);
  expect(document.querySelector('aside .blok-calendar-sources')).toBeNull();
  (await button('Annuler')).click();
  await vi.waitFor(()=>expect(document.activeElement).toBe(opener));
  expect(document.querySelector('[data-calendar-event-inspector]')).toBeNull();
  expect(document.querySelector('aside .blok-calendar-sources')).toBeTruthy();
  expect(store.save).not.toHaveBeenCalled();
});

it('keeps participants in the draft until the organizer confirms the invitation', async () => {
  const event = fixture('2026-11-25','2026-11-26',{allDay:true});
  const request = vi.fn(async (url:string) => {
    if (url.endsWith('/invitees')) return {members:[{id:'lou',title:'Lou'}]};
    return {members:[],feeds:[],connected:false};
  });
  const store = {...createStore(async()=>[event]),remote:{base:'/calendar',preferenceKey:'test',accountId:'moi',
    client:{request} as unknown as NonNullable<CalendarStore['remote']>['client']}};
  setup(store.list, {store});
  (await chip(event.id)).click();
  const trigger = await button('Ajouter des participants');
  await vi.waitFor(()=>expect(trigger.disabled).toBe(false));
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  (await element('[role=menuitemcheckbox]')).click();
  expect(store.save).not.toHaveBeenCalled();
  (await button('Enregistrer et inviter')).click();
  await vi.waitFor(()=>expect(store.save).toHaveBeenCalledWith(expect.objectContaining({id:event.id,participantIds:['lou']})));
});
