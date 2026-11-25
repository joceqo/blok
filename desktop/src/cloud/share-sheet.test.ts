import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_LEVELS, PAGE_RIGHTS_CUMULATIVE } from '../access-vocabulary';
import { mountShareSheet, type PageAccessSheet } from './share-sheet';
import { CloudClient } from './client';

const sheet = (over: Partial<PageAccessSheet> = {}): PageAccessSheet => ({
  visibility: 'private',
  effectiveVisibility: 'private',
  myLevel: 'full',
  shares: [{ userId: 'alice', email: 'alice@example.test', level: 'edit' }],
  inherited: [{ userId: 'zoe', email: 'zoe@example.test', level: 'view', from: 'parent' }],
  ...over,
});

function client(responses: { get?: PageAccessSheet; fail?: boolean } = {}): CloudClient {
  const instance = new CloudClient({ origin: 'https://example.org' });
  vi.spyOn(instance, 'request').mockImplementation(async (_path: string, init?: RequestInit) => {
    if (_path.endsWith('/members')) return { members: [{ id: 'bob', email: 'bob@example.test' }] };
    if (!init || init.method === undefined || init.method === 'GET') return responses.get ?? sheet();
    if (responses.fail) throw new Error('Refusé');
    return { ok: true };
  });
  return instance;
}

const mount = async (instance: CloudClient, pageTitle = 'Page') => {
  const host = document.createElement('div');
  document.body.append(host);
  const handle = mountShareSheet(host, { client: instance, slug: 'equipe', pageId: 'p', pageTitle });
  await vi.waitFor(() => expect(host.querySelector('[data-cloud-share-row]')).not.toBeNull());
  return { host, handle };
};

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('share sheet', () => {
  it('only requests member suggestions for people who may manage access', async () => {
    const instance = client({ get: sheet({ myLevel: 'view' }) });
    const { host } = await mount(instance);
    expect(host.querySelector('[data-cloud-share-invitation]')).toBeNull();
    expect(vi.mocked(instance.request).mock.calls.some(([path])=>path.endsWith('/members'))).toBe(false);
  });

  it('notifies navigation after an individual share changes, without opening the page to the workspace', async () => {
    const instance = client();
    const onChanged = vi.fn();
    const host = document.createElement('div'); document.body.append(host);
    const handle = mountShareSheet(host, { client: instance, slug: 'equipe', pageId: 'p', pageTitle: 'Privé', onChanged });
    await vi.waitFor(() => expect(host.querySelector('[data-cloud-share-row]')).not.toBeNull());
    const input = host.querySelector<HTMLInputElement>('input[role=combobox]')!;
    await vi.waitFor(()=>expect(input.disabled).toBe(false));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    await vi.waitFor(()=>expect(host.querySelector('[role=option]')?.textContent).toContain('bob@example.test'));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const grant = host.querySelector<HTMLButtonElement>('[data-cloud-share-add]')!;
    await vi.waitFor(()=>expect(grant.disabled).toBe(false));
    grant.click();
    await vi.waitFor(()=>expect(onChanged).toHaveBeenCalledOnce());
    expect(instance.request).toHaveBeenCalledWith('/api/workspaces/equipe/pages/p/shares/bob', { method: 'PUT', body: JSON.stringify({ level: 'view' }) });
    expect(instance.request).not.toHaveBeenCalledWith(expect.stringContaining('/access'), expect.objectContaining({ method: 'PUT' }));
    expect(onChanged).toHaveBeenCalledOnce();
    handle.destroy();
  });
  it('separates rights decided here from rights that come from a parent', async () => {
    const { host } = await mount(client());
    const own = host.querySelectorAll('[data-cloud-share-row]:not([data-cloud-share-inherited])');
    const inherited = host.querySelectorAll('[data-cloud-share-row][data-cloud-share-inherited]');
    expect(own).toHaveLength(1);
    expect(inherited).toHaveLength(1);
    expect(own[0].textContent).toContain('alice@example.test');
    // Nommer la page d'origine est ce qui explique pourquoi le droit ne se
    // retire pas ici.
    expect(inherited[0].textContent).toContain('parent');
  });

  it('leaves an inherited right without a control to change it', async () => {
    const { host } = await mount(client());
    const inherited = host.querySelector('[data-cloud-share-inherited]');
    expect(inherited?.querySelector('button:not([disabled])')).toBeNull();
  });

  // Consultable et inerte : voir qui a accès n'est pas gouverner l'accès.
  it('is readable but inert without full access', async () => {
    const { host } = await mount(client({ get: sheet({ myLevel: 'view' }) }));
    expect(host.textContent).toContain('alice@example.test');
    for (const control of host.querySelectorAll('button')) expect(control.disabled).toBe(true);
  });

  it('restores the shown value when the server refuses', async () => {
    const instance = client({ fail: true });
    const { host } = await mount(instance);
    const row = host.querySelector('[data-cloud-share-row]:not([data-cloud-share-inherited])');
    const control = row!.querySelector<HTMLSelectElement>('[data-cloud-share-select]')!;
    expect(control.value).toBe('edit');
    control.value='view';
    control.dispatchEvent(new Event('change',{bubbles:true}));
    await vi.waitFor(() => expect(host.querySelector('[data-cloud-share-error]')?.textContent).toBeTruthy());
    expect(control.selectedOptions[0].textContent).toBe(PAGE_LEVELS.edit);
  });

  it('says who the page is open to, in plain words', async () => {
    const { host } = await mount(client({ get: sheet({ visibility: 'workspace', effectiveVisibility: 'workspace' }) }));
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Accès général"]')?.selectedOptions[0].textContent).toContain('espace');
  });

  it('names the cumulative ceiling so a workspace viewer is not promised edit', async () => {
    const { host } = await mount(client());
    const line = host.querySelector('[data-cloud-share-cumulative]');
    expect(line?.textContent).toBe(PAGE_RIGHTS_CUMULATIVE);
  });
});

it('requires an explicit confirmation before changing the page to workspace-wide access', async () => {
  const instance = client();
  const {host,handle} = await mount(instance);
  const select=host.querySelector<HTMLSelectElement>('select[aria-label="Accès général"]')!;
  select.value='workspace';
  select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(host.querySelector('[data-cloud-share-apply]')).toBeTruthy());
  const put=()=>vi.mocked(instance.request).mock.calls.filter(([path,req])=>path.endsWith('/access')&&req?.method==='PUT');
  expect(put()).toEqual([]);
  host.querySelector<HTMLButtonElement>('[data-cloud-share-apply]')!.click();
  await vi.waitFor(()=>expect(put()).toEqual([['/api/workspaces/equipe/pages/p/access',{method:'PUT',body:JSON.stringify({visibility:'workspace'})}]]));
  handle.destroy();
});

it('limits a workspace viewer to a read grant and keeps the parent authorization intact', async () => {
  const instance=client();
  vi.mocked(instance.request).mockImplementation(async(path,init)=>{
    if(path.endsWith('/members'))return {members:[{id:'sam',email:'s@example.test',name:'Samuel',role:'viewer'}]};
    if(init?.method==='PUT')return {ok:true};
    return sheet();
  });
  const {host,handle}=await mount(instance);
  const input=host.querySelector<HTMLInputElement>('input[role=combobox]')!;
  input.click();
  await vi.waitFor(()=>expect(host.querySelector('[role=option]')?.textContent).toContain('Samuel'));
  host.querySelector<HTMLElement>('[role=option]')!.click();
  await vi.waitFor(()=>expect(host.querySelector('[data-cloud-share-invite-level]')?.textContent).toContain(PAGE_LEVELS.view));
  expect(host.querySelector('select[aria-label="Accès à accorder"]')).toBeNull();
  host.querySelector<HTMLButtonElement>('[data-cloud-share-add]')!.click();
  await vi.waitFor(()=>expect(instance.request).toHaveBeenCalledWith('/api/workspaces/equipe/pages/p/shares/sam',{method:'PUT',body:'{"level":"view"}'}));
  expect(host.querySelector('[data-cloud-share-inherited]')?.querySelector('select')).toBeNull();
  handle.destroy();
});
