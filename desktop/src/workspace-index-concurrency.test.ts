import { beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceRepository } from './workspace-repository';
import { initialWorkspace } from './workspace-registry';

interface Bridge { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }

async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The index belongs to every writer at once: a second desktop tab, an agent over
 * MCP, a sync tool. Guarding it like a document turned the first concurrent write
 * into a dead end — the window kept a fingerprint the file would never match
 * again, so every later save failed and leaving the page failed with it.
 */
describe('local workspace index under concurrent writers', () => {
  const disk = { index: '' };

  beforeEach(() => {
    vi.restoreAllMocks();
    disk.index = JSON.stringify({ pages: [{ id: 'ours', title: 'Notes', parentId: null }], activeId: 'ours', trash: [] });
    (window as unknown as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === 'load_workspace_file') return args?.name === 'index' ? disk.index : null;
        if (command !== 'save_workspace_file') return null;
        if (args?.name === 'index') {
          if (args.expected !== undefined && args.expected !== await fingerprint(disk.index)) throw new Error('stale workspace file');
          disk.index = args.data as string;
        }
        return null;
      },
    };
  });

  it('replays its own changes on top of a page an agent added in between', async () => {
    const repository = workspaceRepository(initialWorkspace);
    const index = await repository.loadIndex();

    disk.index = JSON.stringify({ pages: [...index.pages, { id: 'agent', title: 'Skills', parentId: null }], activeId: 'ours', trash: [] });
    index.pages[0]!.title = 'Notes renommées';

    const applied = await repository.saveIndex(index);
    expect(applied.pages.map((page) => page.id)).toEqual(['ours', 'agent']);
    expect(applied.pages.find((page) => page.id === 'ours')?.title).toBe('Notes renommées');
    expect(applied.pages.find((page) => page.id === 'agent')?.title).toBe('Skills');
    expect(JSON.parse(disk.index)).toMatchObject({ pages: applied.pages });
  });

  it('keeps saving after a refusal instead of stranding the window on a stale fingerprint', async () => {
    const repository = workspaceRepository(initialWorkspace);
    const index = await repository.loadIndex();

    disk.index = JSON.stringify({ pages: [...index.pages, { id: 'agent', title: 'Skills', parentId: null }], activeId: 'ours', trash: [] });
    index.activeId = 'ours';
    await repository.saveIndex(index);

    index.pages.push({ id: 'later', title: 'Créée ensuite', parentId: null });
    const applied = await repository.saveIndex(index);
    expect(applied.pages.map((page) => page.id)).toEqual(['ours', 'agent', 'later']);
  });

  it('carries the active page of this window without fighting the other writer', async () => {
    const repository = workspaceRepository(initialWorkspace);
    const index = await repository.loadIndex();

    disk.index = JSON.stringify({ pages: [...index.pages, { id: 'agent', title: 'Skills', parentId: null }], activeId: 'agent', trash: [] });
    index.activeId = 'ours';

    expect((await repository.saveIndex(index)).activeId).toBe('ours');
  });
});
