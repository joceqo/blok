import { afterEach, describe, expect, it, vi } from 'vitest';
import { readZip } from '../../src/tools/file/zip/read-zip';
import { exportWorkspace, type ExportOptions } from './workspace-export';
import { workspaceRepository } from './workspace-repository';
import { initialWorkspace } from './workspace-registry';

describe('workspace ZIP export', () => {
  afterEach(() => vi.unstubAllGlobals());
  const settings: ExportOptions = {
    format: 'md',
    views: 'current',
    folders: true,
    attachments: true,
    privatePages: false,
  };
  async function contents(settings: ExportOptions) {
    // jsdom's TextEncoder returns Node bytes from a different JavaScript realm.
    vi.stubGlobal('Uint8Array', new TextEncoder().encode('').constructor);
    const repo = workspaceRepository(initialWorkspace);
    const blob = await exportWorkspace(repo, settings, new AbortController().signal);
    const zip = readZip(await blob.arrayBuffer());
    const texts = new Map<string, string>();
    for (const entry of zip.entries)
      texts.set(entry.name, new TextDecoder().decode(await zip.read(entry)));
    return texts;
  }

  it('preserves imported CSV values and only includes rows and row bodies in the selected views', async () => {
    const repo = workspaceRepository(initialWorkspace);
    const {
      pages: [root],
    } = await repo.loadIndex();
    const id = await repo.importMarkdown(
      crypto.randomUUID(),
      'Budget.csv',
      'Name,Amount\nCoffee,14\nTea,7',
    );
    const doc = JSON.parse((await repo.readPage(id))!);
    const [database, coffee, tea] = doc.blocks;
    const all = database.data.views[0];
    database.data.views.push({
      ...all,
      id: 'filtered',
      name: 'Coffee only',
      filters: [
        {
          propertyId: database.data.schema[0].id,
          operator: 'equals',
          value: 'Coffee',
        },
      ],
    });
    database.data.activeViewId = 'filtered';
    for (const [row, text] of [
      [coffee, 'Coffee notes'],
      [tea, 'Tea notes'],
    ]) {
      row.content = [row.id + '-body'];
      doc.blocks.push({ id: row.content[0], parent: row.id, type: 'paragraph', data: { text } });
    }
    await repo.writePage(id, JSON.stringify(doc));
    await repo.saveIndex({
      activeId: root.id,
      pages: [
        root,
        { id, title: 'Budget', parentId: root.id },
        { id: 'private', title: 'Secret', parentId: null, initialVisibility: 'private' },
        { id: 'child', title: 'Child', parentId: 'private' },
      ],
    });
    const current = await contents(settings);
    expect(
      [...current.keys()].some((name) => name.includes('/') && name.endsWith('Budget.md')),
    ).toBe(true);
    expect([...current.keys()].filter((name) => name.endsWith('.csv'))).toHaveLength(1);
    const text = [...current.values()].join('\n');
    expect(text).toContain('Coffee,14');
    expect(text).toContain('Coffee notes');
    expect(text).not.toMatch(/Tea|Secret|Child/);

    const complete = await contents({
      ...settings,
      format: 'html',
      views: 'all',
      folders: false,
      privatePages: true,
    });
    expect([...complete.keys()].filter((name) => name.endsWith('.csv'))).toHaveLength(2);
    expect(complete.has('4-Child.html')).toBe(true);
    expect([...complete.values()].join('\n')).toContain('Tea notes');
  });
});
