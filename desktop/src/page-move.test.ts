import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveDestinations } from './page-move';
import { openPageMove } from './navigation-dialogs';

const pages = [
  { id: 'source', title: 'Source', parentId: null },
  { id: 'child', title: 'Child', parentId: 'source' },
  { id: 'grandchild', title: 'Grandchild', parentId: 'child' },
  { id: 'target', title: 'Destination', parentId: null },
  { id: 'readonly', title: 'Lecture seule', parentId: null },
];
beforeEach(() => vi.clearAllMocks());
afterEach(() => { document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('excludes the moved subtree, current parent and destinations without edit access', () => {
  expect(moveDestinations({ pages, sourceId: 'source', canEdit: id => id !== 'readonly', canMove: () => true, teamspaceOf: () => null, rootLabel: 'Équipe' }).map(item => item.parentId)).toEqual(['target']);
  expect(moveDestinations({ pages, sourceId: 'child', canEdit: () => true, canMove: () => true, teamspaceOf: () => null, rootLabel: 'Équipe' }).map(item => item.parentId)).toEqual([null, 'target', 'readonly']);
});
it('refuses moving a subtree with insufficient control or detached shared ancestry', () => {
  expect(moveDestinations({ pages, sourceId: 'source', canEdit: () => true, canMove: id => id !== 'child', teamspaceOf: () => null, rootLabel: 'Équipe' })).toEqual([]);
});
it('only offers destinations in the source teamspace', () => {
  expect(moveDestinations({ pages, sourceId: 'source', canEdit: () => true, canMove: () => true, teamspaceOf: id => id === 'target' ? 'other' : 'team', rootLabel: 'Équipe' }).map(item => item.parentId)).toEqual(['readonly']);
});
it('searches destinations and moves with the keyboard without closing until saved', async () => {
  let resolve: (() => void) | undefined;
  const onMove = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  openPageMove({ title: 'Source', destinations: () => [{ parentId: 'target', title: 'Destination', path: 'Équipe / Guide' }], onMove });
  const input = document.querySelector<HTMLInputElement>('input');
  expect(input).not.toBeNull();
  if (!input) return;
  input.value = 'destination'; input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'target' }));
  expect(input.disabled).toBe(true);
  expect(document.querySelector('[data-navigation-dialog]')).not.toBeNull();
  resolve?.(); await vi.waitFor(() => expect(document.querySelector('[data-navigation-dialog]')).toBeNull());
});
it('rechecks permissions and displays save failures while allowing retry', async () => {
  let available = true;
  const onMove = vi.fn().mockRejectedValue(new Error('Accès refusé'));
  openPageMove({ title: 'Source', destinations: () => available ? [{ parentId: 'target', title: 'Destination', path: 'Équipe' }] : [], onMove });
  available = false;
  document.querySelector<HTMLButtonElement>('[data-navigation-result]')?.click();
  expect(onMove).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click();
  available = true;
  openPageMove({ title: 'Source', destinations: () => [{ parentId: 'target', title: 'Destination', path: 'Équipe' }], onMove });
  document.querySelector<HTMLButtonElement>('[data-navigation-result]')?.click();
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Accès refusé'));
  expect(document.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
});

it('allows a directly controlled shared root to move to the real workspace root', () => {
  const options = { pages, sourceId: 'source', canEdit: () => true, canMove: () => true,
    teamspaceOf: () => null, rootLabel: 'Équipe', isSharedRoot: (id: string) => id === 'source' };
  expect(moveDestinations(options).map(item => item.parentId)).toEqual([null, 'target', 'readonly']);
});

it('offers writable teams to a private root and checks management when leaving a team', () => {
  const settings = { pages, sourceId: 'source', rootLabel: 'Nexenture', canMove: () => true, canEdit: () => true,
    teamspaceOf: (id: string) => id === 'target' ? 'tech' : null,
    teamspaces: [{ id: 'tech', name: 'Tech', canCreate: true }, { id: 'other', name: 'Produit', canCreate: false }] };
  expect(moveDestinations(settings)).toContainEqual(expect.objectContaining({ parentId: null, teamspaceId: 'tech' }));
  expect(moveDestinations(settings)).toContainEqual(expect.objectContaining({ parentId: 'target', path: 'Tech' }));
  expect(moveDestinations(settings).some(item => item.teamspaceId === 'other')).toBe(false);
  expect(moveDestinations({ ...settings, sourceId: 'target' })).toEqual([]);
});

it('revalidates the selected team when another team also has a null parent', () => {
  const onMove = vi.fn();
  const tech = { parentId: null, teamspaceId: 'tech', title: 'Tech', path: 'Espace d’équipe' };
  const product = { ...tech, teamspaceId: 'product', title: 'Produit' };
  let available = [tech, product];
  openPageMove({ title: 'Tenants', destinations: () => available, onMove });
  available = [product];
  document.querySelector<HTMLButtonElement>('[data-navigation-result]')?.click();
  expect(onMove).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('[data-navigation-result]')?.click();
  expect(onMove).toHaveBeenCalledWith(product);
});
