import { afterEach, expect, it, vi } from 'vitest';
import { openMovePicker } from './navigation-dialogs';
import { pageAccess, type PageAccessMap } from './page-access';
import { moveDestinations } from './page-move';
import { workspaceRepository } from './workspace-repository';
import { initialWorkspace, type RemoteWorkspace } from './workspace-registry';
import type { WorkspaceIndex } from './storage';

const remote: RemoteWorkspace = { kind: 'remote', id: 'r', workspaceId: 'team', accountId: 'a', name: 'Équipe', server: 'https://example.test', role: 'member' };
const item = (id: string, parentId: string | null = null) => ({ id, parentId, title: id });
const pages = [item('old'), item('source', 'old'), item('child', 'source'), item('grandchild', 'child'),
  item('readOnly'), item('Plans', 'readOnly'), item('Planning'), item('workspace')];
const access: PageAccessMap = Object.fromEntries(pages.map((page) => [page.id, { level: page.id === 'readOnly' ? 'view' : 'edit' }]));
const index: WorkspaceIndex = { pages, activeId: 'child', trash: [], access };
afterEach(() => {
  document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click();
  document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals();
});

it('excludes the current parent, every descendant and read-only targets while keeping editable nested targets', () => {
  expect([...moveDestinations(pages, 'source', pageAccess(remote, access))]).toEqual([null, 'Plans', 'Planning', 'workspace']);
  expect(moveDestinations(pages, 'missing', pageAccess(remote, access)).size).toBe(0);
  expect(moveDestinations(pages, 'readOnly', pageAccess(remote, access)).size).toBe(0);
  expect(moveDestinations(pages, 'source', pageAccess({ ...remote, role: 'viewer' }, access)).size).toBe(0);
  expect(moveDestinations(pages, 'workspace', pageAccess(remote, access)).has(null)).toBe(false);
});

it('searches destinations with their visible ancestry, handles a revoked choice and selects by keyboard', () => {
  let grants = access;
  const onChoose = vi.fn();
  openMovePicker({ workspaceName: 'Équipe', pages: () => pages, sourceTitle: 'source', remote: true,
    destinations: () => moveDestinations(pages, 'source', pageAccess(remote, grants)), onChoose });
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Rechercher une destination"]')!;
  expect(document.activeElement).toBe(input);
  input.value = 'Plan'; input.dispatchEvent(new Event('input'));
  expect(document.querySelector('[data-navigation-result-path]')?.textContent).toBe('Équipe / readOnly');
  const press = (key: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  press('ArrowDown');
  grants = { ...access, Planning: { level: 'view' } };
  press('Enter');
  expect(onChoose).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[data-navigation-result]')).toHaveLength(1);
  press('Enter');
  expect(onChoose).toHaveBeenCalledWith('Plans');
});

it('persists a local move to the workspace root while keeping descendants and open page', async () => {
  const repository = workspaceRepository(initialWorkspace);
  await repository.movePage(index, 'source', null);
  const reloaded = await repository.loadIndex();
  expect(reloaded.pages.find((page) => page.id === 'source')?.parentId).toBeNull();
  expect(reloaded.pages.find((page) => page.id === 'child')?.parentId).toBe('source');
  expect(reloaded.activeId).toBe('child');
  await expect(repository.movePage(reloaded, 'source', 'grandchild')).rejects.toThrow();
});

it('saves on the fresh remote revision, preserving remote additions and the open page on subsequent saves', async () => {
  const fresh = { ...index, pages: [...pages, item('newRemote')], revision: 8 };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(fresh))
    .mockResolvedValueOnce(Response.json({revision: 9})).mockResolvedValueOnce(Response.json({revision: 10}));
  vi.stubGlobal('fetch', fetch);
  const repository = workspaceRepository(remote);
  await repository.movePage(index, 'source', 'Planning');
  const sent = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(sent.revision).toBe(8);
  expect(sent.pages).toContainEqual(item('source', 'Planning'));
  expect(sent.pages).toContainEqual(item('newRemote'));
  await repository.saveIndex({ ...index, pages: pages.map((page) => page.id === 'source' ? { ...page, parentId: 'Planning', title: 'Moved' } : page) });
  const next = JSON.parse(fetch.mock.calls[2]![1].body);
  expect(next.revision).toBe(9);
  expect(next.pages).toContainEqual(item('newRemote'));
});

it.each([
  ['revoked destination', { ...index, access: { ...access, Plans: {level: 'view'} } }],
  ['moved source', { ...index, pages: pages.map((page) => page.id === 'source' ? item('source', 'Planning') : page) }],
  ['destination now inside source', { ...index, pages: pages.map((page) => page.id === 'Plans' ? item('Plans', 'child') : page) }],
])('declines the remote move before writing if the index changed (%s)', async (_label, current) => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...current, revision: 8 }));
  vi.stubGlobal('fetch', fetch);
  await expect(workspaceRepository(remote).movePage(index, 'source', 'Plans')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not replay a move after a concurrent index write', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...index, revision: 8 }))
    .mockResolvedValueOnce(new Response(null, {status: 409}));
  vi.stubGlobal('fetch', fetch);
  await expect(workspaceRepository(remote).movePage(index, 'source', 'Plans')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(index.pages.find((page) => page.id === 'source')?.parentId).toBe('old');
});
