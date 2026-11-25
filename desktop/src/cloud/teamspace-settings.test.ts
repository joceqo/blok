import {afterEach, expect, it, vi} from 'vitest';
import {CloudClient} from './client';
import {openTeamspaces} from './teamspaces';
import type {RemoteWorkspace} from '../workspace-registry';
import {must} from '../test-helpers';

const workspace: RemoteWorkspace = {kind:'remote', role:'admin', name:'Atelier', id:'w', workspaceId:'w', accountId:'me', server:'https://example.test'};
const base = '/api/workspaces/w/teamspaces';
const team = {id:'D', name:'Design', description:'Conception', icon:'', owners:[], isDefault:false, joined:false, memberCount:1, canManage:true, updatedAt:'2026-11-25T12:00:00Z'};
const button = (scope: ParentNode, label: string) => must([...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') || item.textContent) === label));
let dismiss: (() => void) | undefined;
afterEach(() => {dismiss?.(); document.body.replaceChildren();});

function mount(reply: (path: string, init: RequestInit) => unknown, role: RemoteWorkspace['role'] = 'admin', initialView?: 'create') {
  const client = new CloudClient();
  const request = vi.spyOn(client, 'request').mockImplementation(async (path, init = {}) => reply(path, init));
  const host = document.createElement('div'); document.body.append(host);
  dismiss = openTeamspaces({...workspace, role}, {initialView,pages:() => [], canEdit:() => false, open:async () => {}}, client, host);
  return {host, request};
}

it('opens details from the settings table, identifies a member who has no email and restores row focus', async () => {
  const {host, request} = mount(path => {
    if (path === base) return {teamspaces:[team], settings:{restrictCreation:false}, canCreate:true};
    if (path === base + '/D/members') return {members:[{userId:'me',name:'Lou',email:'',role:'owner',workspaceRole:'admin'}]};
    throw Error(path);
  });
  await vi.waitFor(() => expect(host.querySelector('.teamspace-row-button')).not.toBeNull());
  expect(request).toHaveBeenCalledTimes(1);
  const trigger = must(host.querySelector<HTMLButtonElement>('.teamspace-row-button')); trigger.click();
  await vi.waitFor(() => expect(document.querySelector('.teamspace-roster')?.textContent).toContain('Lou (vous)'));
  expect(document.querySelector('.teamspace-roster')?.textContent).toContain('Propriétaire');
  button(document, 'Fermer la fenêtre').click();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('saves the default-team selection only when confirmed', async () => {
  let isDefault = false;
  const {host, request} = mount((path,init) => {
    if (path === base + '/settings' && init.method === 'PATCH') {isDefault = true; return {ok:true};}
    return {teamspaces:[{...team,isDefault}], settings:{restrictCreation:true}, canCreate:true};
  });
  await vi.waitFor(() => expect(host.querySelector('.teamspace-default-field select')).not.toBeNull());
  const select = must(host.querySelector<HTMLSelectElement>('.teamspace-default-field select'));
  select.value = team.id; select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(() => expect(button(host, 'Mettre à jour').disabled).toBe(false));
  expect(request).toHaveBeenCalledTimes(1);
  button(host, 'Mettre à jour').click();
  await vi.waitFor(() => expect(button(host, 'Mettre à jour').disabled).toBe(true));
  expect(request).toHaveBeenCalledWith(base + '/settings',expect.objectContaining({method:'PATCH',body:JSON.stringify({defaultTeamspaceIds:['D']})}));
});

it('applies the server’s creation restriction to library shortcuts and hides administrator settings for members', async () => {
  const {host, request} = mount(() => ({teamspaces:[], settings:{restrictCreation:true}, canCreate:false}), 'member', 'create');
  await vi.waitFor(() => expect(host.textContent).toContain('Aucun espace d’équipe.'));
  expect(host.querySelector('[role=switch]')).toBeNull();
  expect(host.textContent).not.toContain('Nouvel espace d’équipe');
  expect(document.querySelector('.teamspace-dialog')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
