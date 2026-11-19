import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Blok } from '../../../../src/blok';
import { Paragraph } from '../../../../src/tools/paragraph';
import { DatabaseTool } from '../../../../src/tools/database';
import { DatabaseRowTool } from '../../../../src/tools/database-row';
import type { OutputBlockData, OutputData } from '../../../../types';

interface TestEditor {
  isReady: Promise<unknown>;
  save: () => Promise<OutputData>;
  destroy: () => void;
}

const COVER = 'https://example.com/cover.png';

const quiet = async (): Promise<void> => {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => {
      requestAnimationFrame(() => resolve(undefined));
    });
  }
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
};

const doc = (rowData: Record<string, unknown> = {}): OutputBlockData[] => [
  {
    id: 'db',
    type: 'database',
    data: {
      schema: [{ id: 't', name: 'Name', type: 'title', position: 'a0' }],
      views: [{ id: 'v', name: 'Table', type: 'table', position: 'a0', sorts: [], filters: [], visibleProperties: [] }],
      activeViewId: 'v',
    },
    content: ['r1'],
  },
  { id: 'r1', type: 'database-row', parent: 'db', data: { properties: { t: 'One' }, position: 'a0', ...rowData } },
];

let editor: TestEditor | undefined;
let holder: HTMLDivElement | undefined;

const make = async (blocks: OutputBlockData[], config: Record<string, unknown>): Promise<void> => {
  editor = new Blok({
    holder,
    dataModel: 'hierarchical',
    tools: {
      paragraph: Paragraph,
      database: { class: DatabaseTool, config },
      'database-row': DatabaseRowTool,
    },
    data: { blocks },
  } as never) as unknown as TestEditor;
  await editor.isReady;
  await quiet();
};

const q = <T extends Element = HTMLElement>(selector: string): T | null => holder?.querySelector<T>(selector)
  ?? document.querySelector<T>(selector);

const click = async (el: Element | null): Promise<void> => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await quiet();
};

const openRow = (rowId: string): Promise<void> =>
  click(q(`[data-row-id="${rowId}"] [data-blok-database-table-open]`));

/** Add cover → the picker's "From a link" field → Insert. */
const addCover = async (url: string): Promise<void> => {
  await click(q('[data-blok-database-drawer-add-cover]'));
  await click(q('[data-action="from-link"]'));
  const field = q<HTMLInputElement>('.blok-media-empty__embed-input');

  if (field === null) throw new Error('no cover URL field');
  field.value = url;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await click(q('[data-action="submit-url"]'));
};

const savedRow = async (): Promise<Record<string, unknown>> =>
  (await editor!.save()).blocks.find(block => block.id === 'r1')?.data as Record<string, unknown>;

/** A host that keeps every row page's cover with the page, as its page shell reads it. */
const hostPages = (covers: Map<string, { cover?: string; position?: number }> = new Map()) => ({
  covers,
  config: {
    lookup: vi.fn().mockResolvedValue(null),
    copyFromLegacy: vi.fn(),
    reconcileLegacy: vi.fn(),
    mount: vi.fn(() => ({ destroy: vi.fn() })),
    cover: {
      read: (pageId: string) => covers.get(pageId),
      write: vi.fn((pageId: string, patch: { cover?: string | null; position?: number }) => {
        const current = covers.get(pageId) ?? {};

        if (patch.cover === null) covers.delete(pageId);
        else covers.set(pageId, {
          ...current,
          ...(patch.cover !== undefined ? { cover: patch.cover } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          ...(patch.cover !== undefined ? { position: undefined } : {}),
        });
      }),
    },
  },
});

describe('a row page cover belongs to the page, not to the row block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    holder = document.createElement('div');
    document.body.appendChild(holder);
  });

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('writes a cover to the row page the host owns, never into the row block', async () => {
    const host = hostPages();

    await make(doc({ pageId: 'page-1' }), { rowPages: host.config });
    await openRow('r1');
    await addCover(COVER);

    expect(host.config.cover.write).toHaveBeenCalledWith('page-1', { cover: COVER });
    expect(host.covers.get('page-1')?.cover).toBe(COVER);
    expect((await savedRow()).cover).toBeUndefined();
  });

  it('shows the page cover in the side peek, so the peek and the full page agree', async () => {
    const host = hostPages(new Map([['page-1', { cover: COVER, position: 20 }]]));

    await make(doc({ pageId: 'page-1' }), { rowPages: host.config });
    await openRow('r1');

    const image = q<HTMLImageElement>('[data-blok-database-drawer-cover] > img');

    expect(image?.getAttribute('src')).toBe(COVER);
    expect(image?.style.objectPosition).toBe('50% 20%');
  });

  it('keeps the cover in the block while the row has no page of its own', async () => {
    const host = hostPages();

    await make(doc(), { rowPages: host.config });
    await openRow('r1');
    await addCover(COVER);

    expect(host.config.cover.write).not.toHaveBeenCalled();
    expect((await savedRow()).cover).toBe(COVER);
  });
});
