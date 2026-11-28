import { describe, expect, it } from 'vitest';
import { pageIdForWorkspaceLink, pageUrlForView, pageView, parsePageLink, resolveWorkspacePageLink, webPageLink, workspacePageLink } from './page-link';
import { diskPageWorkspace } from './disk-page-link';
import type { RemoteWorkspace } from './workspace-registry';
import { activateWorkspace, initialWorkspace, rememberWorkspace, selectStartupPage } from './workspace-registry';

const device: RemoteWorkspace = {kind:'remote', device:true, embedded:true, id:'workspace-1', workspaceId:'local',
  server:'http://127.0.0.1:31337', name:'Local', accountId:'user', userName:'Profil local'};

describe('native page links', () => {
  it('copies the device server URL, scoped to the current workspace', () => {
    const url = workspacePageLink(device,'page-1');
    expect(url).toBe(device.server + '/?page=page-1&workspace=workspace-1');
    expect(parsePageLink(url)).toEqual({id:'page-1', device:true, origin:device.server, workspace:'workspace-1'});
    expect(pageIdForWorkspaceLink(device,url)).toBe('page-1');
    expect(pageIdForWorkspaceLink({...device, id:'other'},url)).toBeUndefined();
    expect(pageIdForWorkspaceLink(device,url+'&workspace=other')).toBeUndefined();
    expect(pageIdForWorkspaceLink(device,url+'&page=other')).toBeUndefined();
  });

  it('round-trips the whiteboard on device, remote and native page URLs', () => {
    for (const ref of [device, {...device, device:false, server:'https://team.example'}]) {
      const href = workspacePageLink(ref, 'p', 'whiteboard');
      expect(webPageLink(new URL(href))).toMatchObject({id:'p', view:'whiteboard', workspace:ref.id});
      expect(resolveWorkspacePageLink(ref, href)).toMatchObject({id:'p', view:'whiteboard'});
      expect(resolveWorkspacePageLink({...ref, id:'other'}, href)).toBeUndefined();
    }
    expect(parsePageLink('blok://page/p?view=whiteboard')).toEqual({id:'p', device:false, view:'whiteboard'});
    expect(parsePageLink('blok://page/p?view=unexpected')).toEqual({id:'p', device:false});
    expect(pageView(new URL('https://team.example/?page=p&view=whiteboard&view=calendar'))).toBe('document');
  });

  it('reopens a disk page in its local browser or native environment', () => {
    const href = workspacePageLink(initialWorkspace, 'p', 'whiteboard');
    expect(href).toBe(location.origin + '/?page=p&local=1&workspace=default&view=whiteboard');
    expect(resolveWorkspacePageLink(initialWorkspace, href)).toMatchObject({id:'p', view:'whiteboard'});
    Reflect.set(window, '__TAURI_INTERNALS__', {});
    try {
      expect(workspacePageLink(initialWorkspace, 'p', 'whiteboard')).toBe('blok://page/p?local=1&workspace=default&view=whiteboard');
    } finally { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); }
  });

  it('resolves two disk workspaces with colliding page IDs and rejects missing targets', async () => {
    const source = {...initialWorkspace, id:'a'};
    const other = {...initialWorkspace, id:'b'};
    const remote = {...device, device:false, id:source.id, server:location.origin};
    try {
      rememberWorkspace(source);
      activateWorkspace(other);
      for (const ref of [source, other]) {
        localStorage.setItem('blok:workspace:' + ref.id + ':index', JSON.stringify({pages:[{id:'p',title:ref.id}]}));
      }
      const web = workspacePageLink(source, 'p', 'whiteboard');
      const disk = webPageLink(new URL(web))!;
      expect(await diskPageWorkspace(disk.workspace!, disk.id)).toEqual(source);
      expect(resolveWorkspacePageLink(other,web)).toBeUndefined();
      expect(resolveWorkspacePageLink(remote,web)).toBeUndefined();
      Reflect.set(window, '__TAURI_INTERNALS__', {});
      const native = workspacePageLink(source, 'p', 'whiteboard');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
      expect(parsePageLink(native)).toMatchObject({workspace:'a',local:true,id:'p',view:'whiteboard'});
      expect(resolveWorkspacePageLink(other,native)).toBeUndefined();
      expect(resolveWorkspacePageLink(remote,native)).toBeUndefined();
      expect(parsePageLink(native+'&device=1')).toBeUndefined();
      expect(resolveWorkspacePageLink(other,'blok://page/p')).toMatchObject({id:'p'});
      await expect(diskPageWorkspace('absent','p')).rejects.toThrow('Espace sur disque introuvable');
      await expect(diskPageWorkspace('a','absent')).rejects.toThrow('Page introuvable');
    } finally { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); localStorage.clear(); }
  });

  it('starts a different page in Document and preserves the workspace when changing views', () => {
    const board = pageUrlForView(new URL('https://team.example/library/recents?p=p&pm=s&workspace=w'), 'p', 'whiteboard');
    expect(board.pathname).toBe('/');
    expect([...board.searchParams]).toEqual([['workspace','w'], ['page','p'], ['view','whiteboard']]);
    expect(pageUrlForView(board, 'next').search).toBe('?workspace=w&page=next');
  });

  it('resolves legacy page links and pasted links only in their own server', () => {
    const nativeLink = 'blok://page/page-1?device=1&workspace=workspace-1';
    expect(pageIdForWorkspaceLink(device,nativeLink)).toBe('page-1');
    expect(pageIdForWorkspaceLink({...device,id:'other'},nativeLink)).toBeUndefined();
    expect(parsePageLink('blok://page/page-1')).toEqual({id:'page-1',device:false});
    expect(parsePageLink(device.server+'/?page=page-1')).toEqual({id:'page-1',device:true,origin:device.server});
    expect(pageIdForWorkspaceLink(device,device.server+'/?page=page-1')).toBe('page-1');
    expect(pageIdForWorkspaceLink(device,'http://127.0.0.1:123/?page=page-1')).toBeUndefined();
    const remote = {...device, embedded:false,device:false,server:'https://team.example'};
    expect(pageIdForWorkspaceLink(remote,'https://team.example/?page=page-1')).toBe('page-1');
    expect(pageIdForWorkspaceLink(remote,'https://other.example/?page=page-1')).toBeUndefined();
    expect(parsePageLink('blok://page/page-1?origin=https%3A%2F%2Fteam.example')).toBeUndefined();
    expect(parsePageLink('blok://page/%2Fetc')).toBeUndefined();
    expect(parsePageLink('blok://user@page/page-1')).toBeUndefined();
  });

  it('resolves web launches without a handoff flag and scopes shared links to their workspace', () => {
    const ref = {...device, device:false, server:'https://team.example'};
    const link = workspacePageLink(ref,'notes-reunion');
    expect(webPageLink(new URL(link))).toEqual({id:'notes-reunion',origin:ref.server,workspace:ref.id});
    expect(webPageLink(new URL('/?review=move&page=roadmap', ref.server))).toEqual({id:'roadmap',origin:ref.server});
    expect(parsePageLink(link)).toBeUndefined();
    expect(pageIdForWorkspaceLink(ref,link)).toBe('notes-reunion');
    expect(pageIdForWorkspaceLink({...ref,id:'other'},link)).toBeUndefined();
    expect(pageIdForWorkspaceLink(ref,link+'&page=other')).toBeUndefined();
    expect(pageIdForWorkspaceLink(ref,link+'&workspace=other')).toBeUndefined();
    expect(pageIdForWorkspaceLink(ref,'https://wrong.example/?page=notes-reunion')).toBeUndefined();
  });

  it('retains other launch parameters alongside the page chosen at the gateway', () => {
    const before = location.href;
    try {
      history.replaceState(null,'','/?review=move&page=notes-reunion&workspace=workspace-1&view=whiteboard');
      const link = webPageLink(new URL(location.href))!;
      selectStartupPage({...device,server:link.origin},link.id,link.view);
      expect(pageView(new URL(location.href))).toBe('whiteboard');
      expect(new URL(location.href).searchParams.get('page')).toBe('notes-reunion');
      expect(new URL(location.href).searchParams.get('review')).toBe('move');
      expect(new URL(location.href).searchParams.get('workspace')).toBe('workspace-1');
    } finally { history.replaceState(null,'',before); localStorage.clear(); }
  });
});
