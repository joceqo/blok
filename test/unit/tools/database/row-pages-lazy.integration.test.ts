import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blok } from '../../../../src/blok';
import { Paragraph } from '../../../../src/tools/paragraph';
import { DatabaseTool } from '../../../../src/tools/database';
import { DatabaseRowTool } from '../../../../src/tools/database-row';
import type { OutputBlockData } from '../../../../types';
import type { DatabaseRowPages } from '../../../../types/tools/database';

let editor: Blok | undefined;
let holder: HTMLElement;
const mounts: Array<{ pageId: string; destroy: ReturnType<typeof vi.fn> }> = [];
const pages: DatabaseRowPages = {
  lookup: vi.fn(async () => null),
  copyFromLegacy: vi.fn(async () => { throw new Error('unexpected legacy copy'); }),
  reconcileLegacy: vi.fn(async () => { throw new Error('unexpected legacy reconcile'); }),
  mount: vi.fn((pageId, target) => {
    target.textContent = `Body ${pageId}`;
    const mounted = { pageId, destroy: vi.fn() };
    mounts.push(mounted);
    return mounted;
  }),
};
const stale = { blocks: [{ id: 'old', type: 'paragraph', data: { text: [{text: 'stale legacy blob'}] } }] };

const quiet = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
};

async function make(options: { inline?: boolean; emptyInline?: boolean; bodyBlocks?: boolean; readOnly?: boolean } = {}) {
  const inline = options.inline || options.emptyInline;
  const blocks: OutputBlockData[] = [{
    id: 'db', type: 'database', content: ['r1', 'r2'],
    data: {
      schema: [{ id: 't', name: 'Name', type: 'title', position: 'a0' },
        { id: 'd', name: 'Details', type: 'richText', position: 'a1' }],
      views: [{ id: 'v', name: 'Table', type: 'table', position: 'a0', sorts: [], filters: [], visibleProperties: [] }],
      activeViewId: 'v',
    },
  }, {
    id: 'r1', type: 'database-row', parent: 'db',
    ...(options.inline ? { content: ['c1'] } : {}),
    data: {
      properties: { t: 'First', ...(!options.emptyInline ? { d: stale } : {}) }, position: 'a0',
      ...(inline ? { bodyBlocks: options.bodyBlocks ?? !options.emptyInline } : { pageId: 'body-one', bodyBlocks: true }),
    },
  }, ...(options.inline ? [{ id: 'c1', type: 'paragraph', parent: 'r1', data: { text: 'current inline body' } }] : []), {
    id: 'r2', type: 'database-row', parent: 'db',
    data: { properties: { t: 'Second' }, position: 'a1', pageId: 'body-two', bodyBlocks: true },
  }];
  editor = new Blok({ holder, readOnly: options.readOnly ?? false, dataModel: 'hierarchical',
    tools: { paragraph: Paragraph, database: { class: DatabaseTool, config: { rowPages: pages } }, 'database-row': DatabaseRowTool },
    data: { blocks },
  });
  await editor.isReady;
  await quiet();
}

async function open(rowId: string) {
  const button = holder.querySelector<HTMLElement>(`[data-row-id="${rowId}"] [data-blok-database-table-open]`)
    ?? holder.querySelector<HTMLElement>(`[data-blok-database-table-open][data-row-id="${rowId}"]`);
  expect(button).not.toBeNull();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await quiet();
}

beforeEach(() => {
  vi.clearAllMocks();
  mounts.length = 0;
  holder = document.createElement('div');
  document.body.append(holder);
});
afterEach(() => { editor?.destroy(); editor = undefined; holder.remove(); });

it('keeps migrated bodies unopened until a row is opened and destroys the old body when switching rows', async () => {
  await make();
  expect(pages.lookup).not.toHaveBeenCalled();
  expect(pages.mount).not.toHaveBeenCalled();
  await open('r1');
  expect(pages.mount).toHaveBeenCalledTimes(1);
  expect(mounts[0]?.pageId).toBe('body-one');
  await open('r2');
  expect(mounts[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(mounts[1]?.pageId).toBe('body-two');
  expect(pages.copyFromLegacy).not.toHaveBeenCalled();
  expect(pages.reconcileLegacy).not.toHaveBeenCalled();
  expect((await editor!.save()).blocks.filter(block => block.parent === 'r1' || block.parent === 'r2')).toEqual([]);
});

it('keeps a new empty row inline rather than silently migrating it on open', async () => {
  await make({ emptyInline: true });
  await open('r1');
  expect(holder.querySelector('[data-blok-database-drawer-editor] [data-blok-id="r1"]')).not.toBeNull();
  expect(pages.mount).not.toHaveBeenCalled();
  expect(pages.copyFromLegacy).not.toHaveBeenCalled();
  expect(pages.reconcileLegacy).not.toHaveBeenCalled();
});

it.each([true, false])('retains the actual inline body when host lookup returns null (bodyBlocks=%s)', async bodyBlocks => {
  await make({ inline: true, bodyBlocks });
  expect(pages.mount).not.toHaveBeenCalled();
  await open('r1');
  const body = holder.querySelector('[data-blok-database-drawer-editor]');
  expect(body?.textContent).toContain('current inline body');
  expect(body?.textContent).not.toContain('stale legacy blob');
  expect(pages.mount).not.toHaveBeenCalled();
  const saved = await editor!.save();
  expect(saved.blocks.filter(block => block.parent === 'r1').map(block => block.id)).toEqual(['c1']);
  expect(saved.blocks.find(block => block.id === 'r1')?.data.properties).toEqual({ t: 'First', d: stale });
  expect(pages.copyFromLegacy).not.toHaveBeenCalled();
  expect(pages.reconcileLegacy).not.toHaveBeenCalled();
});

it('opens a migrated body read-only without performing migration writes', async () => {
  await make({ readOnly: true });
  await open('r1');
  expect(mounts[0]?.pageId).toBe('body-one');
  expect(pages.lookup).not.toHaveBeenCalled();
  expect(pages.copyFromLegacy).not.toHaveBeenCalled();
  expect(pages.reconcileLegacy).not.toHaveBeenCalled();
});

it('keeps an unconverted inline body visible to a read-only viewer', async () => {
  await make({ inline: true, readOnly: true });
  await open('r1');
  expect(holder.querySelector('[data-blok-database-drawer-editor]')?.textContent).toContain('current inline body');
  expect(pages.copyFromLegacy).not.toHaveBeenCalled();
  expect(pages.reconcileLegacy).not.toHaveBeenCalled();
});

it('duplicates an external body into independent inline blocks without opening the body', async () => {
  const snapshot = vi.fn(async () => ({ blocks: [{id:'remote-p',type:'paragraph',data:{text:[{text:'Copied body'}]}}] }));
  Object.assign(pages, {snapshot});
  try {
    await make();
    editor!.blocks.getById('db')!.call('duplicateTableRow', 'r1' as never);
    await vi.waitFor(async () => {
      const saved = await editor!.save();
      const copy = saved.blocks.find(b => b.type === 'database-row' && b.id !== 'r1' && b.id !== 'r2');
      expect(copy).toBeDefined();
      expect(copy!.data.pageId).toBeUndefined();
      expect(saved.blocks.filter(b => b.parent === copy!.id)).toHaveLength(1);
      expect(JSON.stringify(saved.blocks.filter(b => b.parent === copy!.id))).toContain('Copied body');
    });
    expect(snapshot).toHaveBeenCalledExactlyOnceWith('body-one');
    expect(pages.mount).not.toHaveBeenCalled();
  } finally { delete (pages as DatabaseRowPages & {snapshot?: unknown}).snapshot; }
});
