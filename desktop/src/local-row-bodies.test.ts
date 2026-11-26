/**
 * A row body is a document but not a page of the workspace. The server keeps
 * that apart by leaving `rowBodyOf` pages out of the index it serves; locally
 * the link lives in its own file, so `index.json` keeps meaning "the pages".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRowBodyRegistry } from './local-row-bodies';
import { initialWorkspace } from './workspace-registry';

interface Bridge { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }

const disk = { files: new Map<string, string>() };

beforeEach(() => {
  vi.restoreAllMocks();
  disk.files.clear();
  (window as unknown as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      const name = String(args?.name);

      if (command === 'load_workspace_file') return Promise.resolve(disk.files.get(name) ?? null);
      if (command === 'save_workspace_file') disk.files.set(name, String(args?.data));

      return Promise.resolve(null);
    },
  };
});

const entry = (over: Partial<Parameters<ReturnType<typeof createRowBodyRegistry>['add']>[1]> = {}) => ({
  publicId: 'public-1', documentId: 'skills', rowId: 'row-1', databaseId: 'db', title: 'Documenter un dépôt', ...over,
});

describe('the local row body registry', () => {
  it('keeps a body across a restart, with the row it belongs to', async () => {
    const first = createRowBodyRegistry(initialWorkspace);

    await first.load();
    await first.add('body-1', entry());

    const second = createRowBodyRegistry(initialWorkspace);

    await second.load();
    expect(second.get('body-1')?.rowId).toBe('row-1');
    expect(second.list()).toHaveLength(1);
  });

  it('climbs a body inside a body back to the page that holds them', async () => {
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    await registry.add('outer', entry({ title: 'Ligne externe' }));
    await registry.add('inner', entry({ documentId: 'outer', rowId: 'row-2', title: 'Ligne interne' }));

    expect(registry.rootOf('inner')).toBe('skills');
    expect(registry.rowsOf('inner').map((row) => row.rowId)).toEqual(['row-1', 'row-2']);
  });

  it('builds the shape the URL resolver expects, with no server to ask', async () => {
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    await registry.add('body-1', entry());

    const resolved = registry.resolvedPageFor('body-1', 'Espace local');

    expect(resolved?.rowBodyOf).toEqual({ documentId: 'skills', rowId: 'row-1' });
    expect(resolved?.location?.documentId).toBe('skills');
    expect(resolved?.location?.blockId).toBe('row-1');
    expect(resolved?.location?.rows).toHaveLength(1);
    expect(registry.resolvedPageFor('unknown', 'Espace local')).toBeNull();
  });

  it('survives a damaged registry instead of taking the workspace down', async () => {
    disk.files.set('row-bodies', '{ not json');
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    expect(registry.list()).toEqual([]);
  });

  it('does not loop on a registry whose chain points at itself', async () => {
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    await registry.add('loop', entry({ documentId: 'loop' }));

    expect(registry.rowsOf('loop')).toHaveLength(1);
    expect(registry.rootOf('loop')).toBe('loop');
  });

  it('keeps its copy of the title in step, and ignores an empty rename', async () => {
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    await registry.add('body-1', entry());
    await registry.rename('body-1', 'Documenter autrement', '🐰');

    expect(registry.get('body-1')?.title).toBe('Documenter autrement');
    expect(registry.get('body-1')?.icon).toBe('🐰');

    await registry.rename('body-1', '   ');
    expect(registry.get('body-1')?.title).toBe('Documenter autrement');
  });

  it('lists the bodies a document holds, so closing it can take them along', async () => {
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    await registry.add('body-1', entry());
    await registry.add('body-2', entry({ rowId: 'row-2' }));
    await registry.add('elsewhere', entry({ documentId: 'autre-page' }));

    expect(registry.childrenOf('skills').map((body) => body.bodyId).sort()).toEqual(['body-1', 'body-2']);
    expect(registry.childrenOf('inconnu')).toEqual([]);
  });

  it('forgets a body when it is removed', async () => {
    const registry = createRowBodyRegistry(initialWorkspace);

    await registry.load();
    await registry.add('body-1', entry());
    await registry.remove('body-1');

    expect(registry.get('body-1')).toBeUndefined();
    expect(JSON.parse(disk.files.get('row-bodies') ?? '{}')).toEqual({});
  });
});
