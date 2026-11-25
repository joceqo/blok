import { describe, expect, it } from 'vitest';
import { pageIdForWorkspaceLink, parsePageLink, webPageLink, workspacePageLink } from './page-link';
import type { RemoteWorkspace } from './workspace-registry';
import { selectStartupPage } from './workspace-registry';

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
      history.replaceState(null,'','/?review=move&page=notes-reunion&workspace=workspace-1');
      const link = webPageLink(new URL(location.href))!;
      selectStartupPage({...device,server:link.origin},link.id);
      expect(new URL(location.href).searchParams.get('page')).toBe('notes-reunion');
      expect(new URL(location.href).searchParams.get('review')).toBe('move');
      expect(new URL(location.href).searchParams.get('workspace')).toBe('workspace-1');
    } finally { history.replaceState(null,'',before); localStorage.clear(); }
  });
});
