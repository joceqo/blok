import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEmbeddedWorkspace, startEmbeddedServer, useEmbeddedServer } from './native-runtime';
import { nativeSessionAdapter } from './native-session';
import { activateWorkspace, createLocalWorkspace, initialWorkspace, listWorkspaces, rememberWorkspace, type RemoteWorkspace } from './workspace-registry';

afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); localStorage.clear(); vi.unstubAllGlobals(); });

describe('embedded desktop server', () => {
  const remote: RemoteWorkspace = {kind:'remote', id:'one', accountId:'alice', name:'Project', workspaceId:'project', server:'http://127.0.0.1:51230', embedded:true};
  it('opens the bundled runtime for fresh and upgraded default profiles, preserving explicit disk and remote choices', async () => {
    const params = new URLSearchParams();
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(false);
    const invoke = vi.fn().mockResolvedValue(true);
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(true);
    localStorage.setItem('blok:desktop:active-workspace:v1', 'local:default');
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(true);
    expect(await useEmbeddedServer(params, {...initialWorkspace,id:'autre'})).toBe(false);
    localStorage.setItem('blok:desktop:prefer-default-disk:v1', '1');
    expect(await useEmbeddedServer(params, initialWorkspace)).toBe(false);
    expect(await useEmbeddedServer(new URLSearchParams('embedded=1'), initialWorkspace)).toBe(true);
    invoke.mockClear();
    expect(await useEmbeddedServer(new URLSearchParams('local=1'), initialWorkspace)).toBe(false);
    expect(await useEmbeddedServer(params, {...remote, embedded:false})).toBe(false);
    expect(await useEmbeddedServer(params, remote)).toBe(true);
    expect(await useEmbeddedServer(new URLSearchParams('server=https://example.org'), remote)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('accepts only the local origin returned by the native supervisor', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(remote.server).mockResolvedValueOnce('https://example.org');
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    expect(await startEmbeddedServer()).toBe(remote.server);
    await expect(startEmbeddedServer()).rejects.toThrow('Adresse');
    expect(invoke).toHaveBeenCalledWith('ensure_embedded_server');
  });

  it('opens the device workspace issued by native IPC and keeps its bearer out of browser and keychain storage', async () => {
    const origin = 'http://127.0.0.1:51231';
    const device = {id:'own',slug:'maison',role:'admin',name:'Mon espace'};
    const invoke = vi.fn().mockResolvedValue({origin,token:'device-session',user:{id:'device',name:'Profil local',email:''},
      workspaces:[{...device,id:'other',slug:'other'},device],deviceWorkspaceId:'own',deviceActivePageId:'last-edited'});
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    const ref = await openEmbeddedWorkspace(initialWorkspace, false);
    expect(ref.activePageId).toBe('last-edited');
    expect(ref.workspace).toMatchObject({device:true, server:origin, userName:'Profil local', workspaceId:'maison', accountId:'device'});
    expect(await nativeSessionAdapter(origin).getToken()).toBe('device-session');
    expect(invoke.mock.calls).toEqual([['embedded_device_session']]);
    expect(localStorage.length).toBe(0);
    invoke.mockResolvedValue(null);
    expect(await nativeSessionAdapter('https://remote.example').getToken()).toBeNull();
  });
  it('selects an imported workspace on disk upgrade and keeps both local workspaces available', async () => {
    const own = {id:'own', slug:'local', name:'Mon espace', role:'admin'};
    const imported = {...own,id:'import',slug:'bibliotheque',name:'Bibliothèque'};
    const invoke = vi.fn().mockResolvedValue({origin:remote.server,token:'local-session',user:{id:'device'},workspaces:[own,imported],
      deviceWorkspaceId:own.id,deviceImportedWorkspaceId:imported.id,deviceActivePageId:'ancienne-page'});
    Reflect.set(window,'__TAURI_INTERNALS__',{invoke});
    const migrated = await openEmbeddedWorkspace(initialWorkspace,false);
    expect(migrated.workspace.id).toBe(imported.id);
    expect(migrated.activePageId).toBe('ancienne-page');
    expect(migrated.otherWorkspaces?.map(w=>w.id)).toEqual(['own']);
    const additionalDisk = createLocalWorkspace('Archives');
    rememberWorkspace(migrated.otherWorkspaces![0]!);
    expect(listWorkspaces()).toContainEqual(initialWorkspace);
    activateWorkspace(migrated.workspace);
    expect(listWorkspaces().map(ref => ref.id)).toEqual([additionalDisk.id, own.id, imported.id]);
    localStorage.setItem('blok:desktop:prefer-default-disk:v1', '1');
    expect(listWorkspaces()).toContainEqual(initialWorkspace);
    const selected = await openEmbeddedWorkspace({...remote,device:true,id:own.id,accountId:'device'},false);
    expect(selected.workspace.id).toBe(own.id);
    expect(selected.activePageId).toBeUndefined();
  });
  it('preserves a previous embedded workspace when the keychain session matches the saved account', async () => {
    const invoke = vi.fn((command:string) => Promise.resolve(command === 'ensure_embedded_server' ? remote.server : 'legacy-token'));
    Reflect.set(window, '__TAURI_INTERNALS__', {invoke});
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({user:{id:'alice'}, workspaces:[{id:'one',slug:'project',name:'Archives',role:'admin'}]})));
    vi.stubGlobal('fetch', fetch);
    expect((await openEmbeddedWorkspace(remote, false)).workspace).toMatchObject({...remote,name:'Archives',role:'admin'});
    expect(invoke.mock.calls.flat()).not.toContain('embedded_device_session');
    expect(fetch.mock.calls[0][0]).toBe(remote.server+'/api/session');
  });
  it('recovers an obsolete local sign-in by opening the device account without assuming ownership of old pages', async () => {
    const session = {origin:remote.server,token:'new',user:{id:'local-owner',name:'Profil local',email:''},
      deviceWorkspaceId:'safe',workspaces:[{id:'safe',slug:'local',name:'Mon espace',role:'admin'}]};
    const invoke = vi.fn((cmd:string) => Promise.resolve(cmd === 'ensure_embedded_server' ? remote.server : cmd === 'load_cloud_session' ? 'expired' : session));
    Reflect.set(window,'__TAURI_INTERNALS__',{invoke});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:401})));
    expect((await openEmbeddedWorkspace(remote,false)).workspace).toMatchObject({accountId:'local-owner',device:true,id:'safe'});
  });
});
