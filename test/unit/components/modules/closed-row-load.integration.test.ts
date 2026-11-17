import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Core } from '../../../../src/components/core';
import { DocumentStore } from '../../../../src/components/modules/yjs/document-store';
import { YBlockSerializer } from '../../../../src/components/modules/yjs/serializer';
import { Paragraph } from '../../../../src/tools/paragraph';
import { DatabaseTool } from '../../../../src/tools/database';
import { DatabaseRowTool } from '../../../../src/tools/database-row';
import { resetViewportRender } from '../../../../src/components/utils/viewport-render';

let core: Core | undefined;
let server: DocumentStore | undefined;

beforeEach(() => { vi.clearAllMocks(); resetViewportRender(); });
afterEach(async () => {
  if (core) {
    Object.values(core.moduleInstances).forEach(module => (module as { markDestroyed?: () => void }).markDestroyed?.());
    for (const module of Object.values(core.moduleInstances)) {
      await (module as { destroy?: () => void | Promise<void> }).destroy?.();
    }
  }
  server?.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  resetViewportRender();
});

it.each([false, true])('keeps closed bodies dormant after remote loading and switching readOnly to %s', async (readOnly) => {
  const blocks = [
    { id: 'db', type: 'database', data: {
      schema: [{ id: 'title', name: 'Name', type: 'title', position: 'a0' }],
      views: [{ id: 'v', type: 'table', name: 'Table', position: 'a0', sorts: [], filters: [], visibleProperties: [] }],
      activeViewId: 'v',
    }, content: ['r1', 'r2'] },
    ...['r1', 'r2'].flatMap((id, index) => [
      { id, type: 'database-row', parent: 'db', content: [`p${index}`], data: { properties: { title: id }, position: `a${index}`, bodyBlocks: true } },
      { id: `p${index}`, type: 'paragraph', parent: id, data: { text: `Body ${index}` } },
    ]),
  ];

  server = new DocumentStore(new YBlockSerializer());
  server.fromJSON(blocks);
  const holder = document.createElement('div');

  document.body.append(holder);
  core = new Core({ holder, readOnly: !readOnly, tools: { paragraph: Paragraph, database: DatabaseTool, 'database-row': DatabaseRowTool } });
  await core.isReady;
  const { BlockManager, YjsManager, ReadOnly, Saver } = core.moduleInstances;

  await BlockManager.clear(false);
  YjsManager.applyRemoteUpdate(server.encodeStateAsUpdate());
  await vi.waitFor(() => expect(BlockManager.isSyncingFromYjs).toBe(false));
  await ReadOnly.toggle(readOnly);
  const bodies = BlockManager.blocks.filter(block => block.name === 'paragraph');

  expect(bodies).toHaveLength(2);
  expect(bodies.every(block => block.holder.hasAttribute('data-blok-deferred-render'))).toBe(true);
  const before = await Saver.save();

  BlockManager.getBlockById('db')?.call('openRow', { rowId: 'r1' });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const opened = BlockManager.getBlockById('p0');

  expect(opened?.holder.hasAttribute('data-blok-deferred-render')).toBe(false);
  expect(opened?.holder.textContent).toContain('Body 0');
  expect(opened?.pluginsContent.contentEditable).toBe(String(!readOnly));
  expect(BlockManager.getBlockById('p1')?.holder.hasAttribute('data-blok-deferred-render')).toBe(true);
  expect((await Saver.save())?.blocks).toEqual(before?.blocks);
}, 10_000);
