import { afterEach, expect, it, vi } from 'vitest';
import { openRemoteTrash } from './trash';
import type { RemoteWorkspace } from '../workspace-registry';

const ref: RemoteWorkspace = {
  kind: 'remote',
  id: 'a',
  workspaceId: 'équipe',
  name: 'Équipe',
  server: 'https://example.test',
  accountId: 'account',
  role: 'member',
};
const base = 'https://example.test/api/workspaces/%C3%A9quipe';
const snapshot = {
  trash: [
    { id: 'p', title: 'Compte rendu' },
    { id: 'q', title: 'Lecture' },
  ],
  access: { p: { level: 'full' }, q: { level: 'view' } },
};
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
afterEach(() => {
  document.querySelector<HTMLButtonElement>('[data-navigation-close]')?.click();
  vi.unstubAllGlobals();
});

it.each(['purged', 'pending'])(
  'requires explicit confirmation and reloads the authorized trash (%s)',
  async (key) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ [key]: 'p' }, { status: key === 'pending' ? 202 : 200 }))
      .mockResolvedValueOnce(Response.json({ trash: [], access: {} }));
    vi.stubGlobal('fetch', fetch);
    const changed = vi.fn(async () => {});
    openRemoteTrash(ref, async () => {}, changed);
    await vi.waitFor(() => expect(button('Supprimer…')).toBeDefined());
    expect(document.querySelectorAll('[aria-label^="Supprimer définitivement"]')).toHaveLength(1);
    button('Supprimer…')!.click();
    expect(document.body.textContent).toContain('« Compte rendu » et son historique');
    button('Annuler')!.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    button('Supprimer…')!.click();
    button('Supprimer définitivement')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('La corbeille est vide.'));
    expect(fetch.mock.calls[1]![0]).toBe(base + '/pages/p/purge');
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(key === 'pending' ? 'en cours' : 'a été supprimée');
  },
);

it('does not offer permanent deletion to a viewer even if the cached page reports full access', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(snapshot)));
  openRemoteTrash(
    { ...ref, role: 'viewer' },
    async () => {},
    async () => {},
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain('Compte rendu'));
  expect(button('Supprimer…')).toBeUndefined();
});

it('keeps the page when the server refuses a parent with children', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ error: 'Page has children' }, { status: 409 })),
  );
  const changed = vi.fn(async () => {});
  openRemoteTrash(ref, async () => {}, changed);
  await vi.waitFor(() => expect(button('Supprimer…')).toBeDefined());
  button('Supprimer…')!.click();
  button('Supprimer définitivement')!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('sous-pages'));
  expect(changed).not.toHaveBeenCalled();
  expect(button('Actualiser')).toBeDefined();
});

it('sends the native account credential for the matching server', async () => {
  const invoke = vi.fn().mockResolvedValue('native-account-token');
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  try {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ purged: 'p' }))
      .mockResolvedValueOnce(Response.json({ trash: [] }));
    vi.stubGlobal('fetch', fetch);
    openRemoteTrash(
      ref,
      async () => {},
      async () => {},
    );
    await vi.waitFor(() => expect(button('Supprimer…')).toBeDefined());
    button('Supprimer…')!.click();
    button('Supprimer définitivement')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('La corbeille est vide.'));
    expect(invoke).toHaveBeenCalledWith('load_cloud_session', { server: ref.server });
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('Authorization')).toBe(
      'Bearer native-account-token',
    );
  } finally {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  }
});
