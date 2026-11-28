import {afterEach, expect, it, vi} from 'vitest';
import {createCalendarDirectory} from './calendar-directory';
import {rememberWorkspace, workspaceKey, type RemoteWorkspace} from './workspace-registry';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window,'__TAURI_INTERNALS__');
});

it('overlays calendars from two accounts on the same server and isolates an expired account', async () => {
  const device = {kind:'local', id:'default', name:'Mon espace'} as const;
  const work: RemoteWorkspace = {kind:'remote', id:'shared', workspaceId:'studio', server:'https://cal.example',
    name:'Studio', accountId:'work', userName:'Work', role:'member'};
  const personal = {...work, accountId:'private', userName:'Personal'};
  rememberWorkspace(work);
  rememberWorkspace(personal);
  Reflect.set(window,'__TAURI_INTERNALS__',{invoke: async (command:string, {account}:{account:string}) =>
    command === 'load_cloud_session' ? account : null});
  let expired = false;
  vi.stubGlobal('fetch',vi.fn(async (url:string, init:RequestInit) => {
    const who = new Headers(init.headers).get('authorization')?.split(' ')[1];
    if (url.endsWith('/session')) {
      if (who === 'work' && expired) return Response.json({}, {status:401});
      return Response.json({user:{id:who}, workspaces:[{id:'shared',slug:'studio',name:'Studio',role:'member'}]});
    }
    if (url.includes('/calendar?')) return Response.json({events:[{title:who}]});
    throw Error(url);
  }));
  const directory = createCalendarDirectory(device);
  await directory.refresh();
  expect(directory.entries().map(entry => entry.visible)).toEqual([true,false,false]);
  for (const ref of [work,personal]) await directory.connect(workspaceKey(ref));
  const [, a, b] = directory.entries();
  expect(a!.id).not.toBe(b!.id);
  for (const [entry, ref] of [[a!,work],[b!,personal]] as const)
    expect((await entry.store.list('2026-11-25','2026-11-26'))[0]?.title).toBe(ref.accountId);
  await directory.setVisible(a!.id,false);
  const reopened = createCalendarDirectory(device);
  await reopened.refresh();
  expect(reopened.entries().map(e => e.visible)).toEqual([true,false,true]);
  expired = true;
  await reopened.refresh();
  expect(reopened.entries().map(e => e.id)).toEqual([workspaceKey(device),workspaceKey(personal)]);
  expect(reopened.unavailable?.()).toEqual([work]);
});
