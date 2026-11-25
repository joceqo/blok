import { afterEach, expect, it, vi } from 'vitest';
import { createCalendarWorkspaces } from './calendar-workspaces';
import { rememberWorkspace, type RemoteWorkspace } from './workspace-registry';

const personal: RemoteWorkspace = {kind:'remote', server:'https://calendar.example', id:'first-id', workspaceId:'first', name:'Personnel', role:'admin', accountId:'user-1'};
const first = {id:personal.id, slug:personal.workspaceId, name:personal.name, role:'admin'};
const second = {id:'second-id', slug:'studio', name:'Studio', role:'member'};
const event = {id:'same-id', title:'Rencontre', start:'2026-04-01', end:'2026-04-02', allDay:true, revision:0, pageId:null};
afterEach(() => {localStorage.clear(); vi.unstubAllGlobals();});

it('discovers memberships without switching the shell, writes and reads links in their originating workspace', async () => {
  let accountId = personal.accountId;
  let memberships = [first, second];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/session') return Response.json({user:{id:accountId},workspaces:memberships});
    if (path === '/api/workspaces/studio/index') return Response.json({pages:[{id:'notes',title:'Notes studio'}]});
    if (path.endsWith('/calendar/same-id') && init.method === 'PUT') return Response.json({ok:true});
    if (path.endsWith('/calendar')) return Response.json({events:[{...event,title:path}]});
    throw Error('Unexpected request: ' + path);
  });
  vi.stubGlobal('fetch',fetch);
  rememberWorkspace({...personal,accountId:'someone-else',id:'stale',workspaceId:'other'});
  const calendars = createCalendarWorkspaces(personal);
  await calendars.refresh();
  expect(calendars.entries().map(e => [e.id,e.connected])).toEqual([[first.id,true],[second.id,false]]);
  const studio = calendars.entries()[1]!.store;
  await expect(studio.list('2026-04-01','2026-04-02')).rejects.toThrow('connecté');
  await calendars.connect(second.id);
  await studio.save(event);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe(personal.server + '/api/workspaces/studio/calendar/same-id');
  expect(await calendars.pages(second.id)).toEqual([{id:'notes',title:'Notes studio'}]);
  expect((await studio.list('2026-04-01','2026-04-02'))[0]?.title).toContain('/studio/');
  expect((await calendars.entries()[0]!.store.list('2026-04-01','2026-04-02'))[0]?.title).toContain('/first/');
  await calendars.setVisible(second.id, false);
  const reopened = createCalendarWorkspaces({...personal, id:second.id,workspaceId:second.slug,name:second.name});
  await reopened.refresh();
  expect(reopened.entries().map(e => [e.connected,e.visible])).toEqual([[false,false],[true,false]]);
  memberships = [first, {...second,role:'viewer'}];
  await calendars.refresh();
  await expect(studio.save(event)).rejects.toThrow('lecture seule');
  memberships = [first];
  await calendars.refresh();
  expect(calendars.entries()).toHaveLength(1);
  await expect(studio.remove(event)).rejects.toThrow('connecté');
  memberships = [first, second]; accountId = 'someone-else';
  await expect(calendars.refresh()).rejects.toThrow('compte');
  expect(calendars.entries()).toEqual([]);
  const otherAccount = createCalendarWorkspaces({...personal,accountId});
  await otherAccount.refresh();
  expect(otherAccount.entries()[1]?.connected).toBe(false);
});

it('aggregates device disk workspaces separately, preserves events when unlinked and handles duplicate ids', async () => {
  const one = {kind:'local',id:'default',name:'Personnel'} as const;
  rememberWorkspace({kind:'local',id:'studio',name:'Studio'});
  rememberWorkspace(personal);
  const calendars = createCalendarWorkspaces(one);
  await calendars.refresh();
  expect(calendars.entries().map(e=>e.id)).toEqual(['default','studio']);
  await calendars.connect('studio');
  const [a,b] = calendars.entries();
  await a!.store.save({...event,title:'Déjeuner'});
  await b!.store.save({...event,title:'Atelier'});
  await calendars.disconnect('studio');
  await expect(b!.store.list(event.start,event.end)).rejects.toThrow('connecté');
  await calendars.connect('studio');
  expect((await b!.store.list(event.start,event.end))[0]?.title).toBe('Atelier');
  expect((await a!.store.list(event.start,event.end))[0]?.title).toBe('Déjeuner');
  expect(await calendars.pages('studio')).toEqual([]);
});

it('reads server preferences from another device and persists only the explicitly changed workspace and field', async () => {
  const prefs = new Map<string,{id:string;connected:boolean;visible:boolean}>();
  let refuse = false;
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/session') return Response.json({
      user:{id:personal.accountId},workspaces:[first,second],calendarWorkspaces:[...prefs.values()],
    });
    if (path === '/api/workspaces/studio/calendar/preferences') {
      const patch = JSON.parse(String(init.body));
      writes.push(patch);
      if (refuse) return Response.json({error:'Session expirée'}, {status:401});
      const {accountId, ...fields} = patch;
      expect(accountId).toBe(personal.accountId);
      prefs.set(second.id,{id:second.id,connected:false,visible:true,...prefs.get(second.id),...fields});
      return Response.json({ok:true});
    }
    throw Error('Unexpected request: ' + path);
  }));
  const a = createCalendarWorkspaces(personal);
  await a.refresh();
  expect(writes).toEqual([]);
  await a.connect(second.id);
  await a.setVisible(second.id,false);
  expect(writes).toEqual([{accountId:personal.accountId,connected:true,visible:true},{accountId:personal.accountId,visible:false}]);
  localStorage.clear();
  const b = createCalendarWorkspaces(personal);
  await b.refresh();
  expect(b.entries()[1]).toMatchObject({connected:true,visible:false});
  refuse = true;
  await expect(b.disconnect(second.id)).rejects.toMatchObject({status:401});
  expect(b.entries()[1]?.connected).toBe(true);
  refuse = false;
  await b.disconnect(second.id);
  await a.refresh();
  expect(a.entries()[1]?.connected).toBe(false);
  expect(prefs.has(first.id)).toBe(false);
});

it('distinguishes connected workspaces with colliding IDs even when other memberships exhaust the palette', async () => {
  const spaces = ['a','f','k','p','u','z'].map(id=>({id,slug:id,name:id,role:'member'}));
  const current = {...personal,id:'u',workspaceId:'u'};
  let members = [...spaces];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    user:{id:current.accountId}, workspaces:members, calendarWorkspaces:[{id:'z',connected:true,visible:true}],
  })));
  async function read() {
    const view = createCalendarWorkspaces(current);
    await view.refresh();
    return new Map(view.entries().map(entry=>[entry.id,entry.color]));
  }
  const assigned = await read();
  expect(assigned.get('u')).not.toBe(assigned.get('z'));
  members = members.reverse();
  expect(await read()).toEqual(assigned);
});
