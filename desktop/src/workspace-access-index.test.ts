import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceRepository } from './workspace-repository';
import { pageAccess } from './page-access';
import type { RemoteWorkspace } from './workspace-registry';

const remote: RemoteWorkspace = { kind: 'remote', id: 'r', name: 'Équipe', server: 'https://example.org', accountId: 'a', workspaceId: 'equipe', role: 'member' };

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('page levels reaching the interface', () => {
  // Sans ce transport, l'interface retomberait sur le rôle d'espace et rouvrirait
  // en écriture une page que le serveur refuse.
  it('keeps the levels the index reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      pages: [{ id: 'mienne', title: 'Mienne', parentId: null }, { id: 'lue', title: 'Lue', parentId: null }],
      trash: [], revision: 3,
      access: { mienne: { level: 'full' }, lue: { level: 'view' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const index = await workspaceRepository(remote).loadIndex();
    const access = pageAccess(remote, index.access);
    expect(access.canEdit('mienne')).toBe(true);
    expect(access.canEdit('lue')).toBe(false);
    expect(access.canShare('mienne')).toBe(true);
  });

  it('reads the new page level after an index write returned only a revision', async () => {
    const page = { id: 'new', title: 'New', parentId: null };
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ pages: [], trash: [], access: {}, revision: 1 }))
      .mockResolvedValueOnce(Response.json({ revision: 2 }))
      .mockResolvedValueOnce(Response.json({ pages: [page], access: { new: { level: 'edit' } }, revision: 2 }))
      .mockResolvedValueOnce(Response.json({ pages: [page], access: { new: { level: 'view' } }, revision: 2 }))
      .mockResolvedValueOnce(Response.json({ pages: [], access: {}, revision: 3 }));
    vi.stubGlobal('fetch', fetch);
    const repository = workspaceRepository(remote);
    const index = await repository.loadIndex();
    index.pages.push(page);
    await repository.saveIndex(index);
    expect(pageAccess(remote, index.access).canEdit(page.id)).toBe(false);
    expect((await repository.readPageAccess(page.id)).level).toBe('edit');
    expect((await repository.readPageAccess(page.id)).level).toBe('view');
    await expect(repository.readPageAccess(page.id)).rejects.toThrow('Page not found');
  });

  it('stays usable against a server that reports no levels at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      pages: [{ id: 'page', title: 'Page', parentId: null }], trash: [], revision: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const index = await workspaceRepository(remote).loadIndex();
    expect(index.access).toBeUndefined();
    expect(pageAccess(remote, index.access).canEdit('page')).toBe(true);
  });
});
