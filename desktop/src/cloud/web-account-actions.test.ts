import {afterEach, expect, it, vi} from 'vitest';
import {createDesktopFooter} from '../settings';
import {must} from '../test-helpers';
import {activeWorkspace, activateWorkspace, listWorkspaces, rememberWorkspace, type RemoteWorkspace} from '../workspace-registry';
import {CloudClient, type CloudInstance, type CloudSession} from './client';
import {mountCloudGateway} from './index';
import {hasWebAccount, leaveForWebAccount} from './web-account-actions';

const account: RemoteWorkspace = {kind:'remote',id:'work',name:'Travail',accountId:'u',workspaceId:'work',
  userName:'camille@example.test',server:'https://blok.example.org',role:'admin'};
const session: CloudSession = {user:{id:'u',email:account.userName!},workspaces:[{id:'work',slug:'work',name:'Travail',role:'admin'}]};
const instance: CloudInstance = {name:'Blok',setupRequired:false,signupPolicy:'open',workspaceCreation:'admins_only',defaultWorkspace:null};

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('shows new workspace only for the active account after server creation permission is confirmed', async () => {
  const client = new CloudClient();
  vi.spyOn(client, 'request').mockResolvedValue({notifications:[],unreadCount:0});
  const getSession = vi.spyOn(client, 'session').mockResolvedValue(session);
  const getInstance = vi.spyOn(client, 'instance').mockResolvedValue(instance);
  const signal = new AbortController();
  const footer = createDesktopFooter(() => {}, account, undefined, {client, signal: signal.signal});
  document.body.append(footer);
  const trigger = must(footer.querySelector<HTMLButtonElement>('[data-desktop-switcher]'));
  const create = () => footer.querySelector<HTMLButtonElement>('[data-desktop-menu-new-workspace]');
  try {
    trigger.click();
    await vi.waitFor(() => expect(getInstance).toHaveBeenCalled());
    expect(create()).toBeNull(); // Workspace admin is not an instance admin.
    expect(footer.querySelector('[data-desktop-menu-logout]')).toBeTruthy();
    trigger.click();
    getSession.mockResolvedValue({...session,user:{...session.user,instanceAdmin:true}});
    trigger.click();
    await vi.waitFor(() => expect(create()).toBeTruthy());
    const actions: string[] = [];
    footer.addEventListener('blok:desktop-connect-cloud', event => actions.push((event as CustomEvent).detail.section));
    must(create()).click();
    expect(actions).toEqual(['new-workspace']);
    trigger.click();
    must(footer.querySelector<HTMLButtonElement>('[data-desktop-menu-logout]')).click();
    expect(actions).toEqual(['new-workspace','logout']);
    getInstance.mockResolvedValue({...instance,workspaceCreation:'disabled'});
    trigger.click();
    await Promise.resolve();
    expect(create()).toBeNull();
  } finally { signal.abort(); }
});

it('keeps a single-workspace user inside the create form and checks permission again on arrival', async () => {
  const client = new CloudClient();
  vi.spyOn(client,'instance').mockResolvedValue({...instance,workspaceCreation:'anyone'});
  vi.spyOn(client,'session').mockResolvedValue(session);
  const host = document.createElement('div');
  const open = vi.fn();
  const mount = () => mountCloudGateway(host, {client,initialAccountSection:'create-workspace',onOpenWorkspace:open});
  let gateway = await mount();
  expect(host.querySelector('input[name="workspace-name"]')).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  gateway.destroy();
  gateway = await mountCloudGateway(host, {client,initialAccountSection:'accounts',onOpenWorkspace:open});
  expect(host.querySelector('[data-cloud-route=spaces]')).toBeTruthy();
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Changer de compte')).toBe(true);
  expect(open).not.toHaveBeenCalled();
  gateway.destroy();
  vi.mocked(client.instance).mockResolvedValue(instance);
  gateway = await mount();
  expect(host.querySelector('[data-cloud-route=spaces]')).toBeTruthy();
  expect(host.querySelector('input[name="workspace-name"]')).toBeNull();
  gateway.destroy();
});

it('flushes before leaving, logs out only the web account, and preserves the other workspaces', async () => {
  rememberWorkspace({...account,accountId:'other',id:'other'});
  rememberWorkspace({...account,device:true,embedded:true,id:'device',workspaceId:'device'});
  activateWorkspace(account);
  const calls: string[] = [];
  const navigate = vi.fn();
  const options = {workspace:account,native:false,navigate,
    flush:vi.fn(async () => { calls.push('flush'); }),
    client:{session:vi.fn(async () => { calls.push('session');return session; }), logout:vi.fn(async () => { calls.push('logout'); })},
  };
  await leaveForWebAccount('account', options);
  expect(calls).toEqual(['flush']);
  expect(navigate).toHaveBeenCalledWith(location.origin + '/?cloud=1&section=accounts');
  calls.length = 0;
  await leaveForWebAccount('new-workspace', options);
  expect(navigate).toHaveBeenCalledWith(location.origin + '/?cloud=1&section=create-workspace');
  expect(calls).toEqual(['flush']);
  expect(activeWorkspace()).toMatchObject({accountId:'u'});
  await leaveForWebAccount('logout', options);
  expect(calls).toEqual(['flush','flush','session','logout']);
  expect(navigate).toHaveBeenLastCalledWith(location.origin + '/?cloud=1');
  expect(listWorkspaces().map(workspace => workspace.id)).toEqual(['default','other','device']);
  expect(hasWebAccount({...account,embedded:true},false)).toBe(false);
  await leaveForWebAccount('logout', {...options,native:true});
  expect(options.client.logout).toHaveBeenCalledTimes(1);
});

it('preserves the current workspace when saving fails or the web session has switched users', async () => {
  const navigate = vi.fn(), logout = vi.fn();
  const options = {workspace:account,native:false,navigate,client:{logout,session:vi.fn().mockResolvedValue({...session,user:{id:'other'}})}};
  const unsaved = {...options,flush:vi.fn().mockRejectedValue(new Error('Sauvegarde'))};
  await expect(leaveForWebAccount('logout', unsaved)).rejects.toThrow('Sauvegarde');
  await expect(leaveForWebAccount('account', unsaved)).rejects.toThrow('Sauvegarde');
  await expect(leaveForWebAccount('logout', {...options,flush:vi.fn().mockResolvedValue(undefined)})).rejects.toThrow('Le compte actif a changé');
  expect(logout).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});
