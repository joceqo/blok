// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataOf, errorOf, property, row, run, seedOf, SESSIONS, valuesOf } from './database-seed';
import { invoke } from '../../../src/view/server-runtime';
import { TEST_ACTOR } from './harness';

import type { AgentBatch, OutputData } from '../../../types';

const seed = (): OutputData => seedOf([
  { id: 'db', view: { sorts: [], filters: [], visibleProperties: [] }, schema: [property('title', 'title'), property('done', 'checkbox')], rows: [
    row('r', { title: 'Sprint', done: false }, { pageId: 'body-doc', bodyBlocks: true }),
    row('inline', { title: 'Inline', done: false }),
    row('tpl', { title: 'Template' }, { template: true }),
  ] },
  { id: 'other', view: { sorts: [], filters: [], visibleProperties: [] }, schema: [property('title', 'title'), property('done', 'checkbox')], rows: [] },
], [
  { id: 'template-text', type: 'paragraph', data: { text: 'Template body' }, parent: 'tpl' },
  { id: 'loose', type: 'paragraph', data: { text: 'Keep me' } },
]);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe.each(SESSIONS)('database external bodies (%s)', (_label, open) => {
  it('exposes the body document in the outline and preserves it through cell edits and moves', async () => {
    const session = open(seed());
    try {
      expect((await session.read({ detail: 'outline' })).blocks.find(block => block.id === 'r')?.attrs).toMatchObject({ pageId: 'body-doc' });
      expect(errorOf(await run(session, 'database.setRowValues', { id: 'db', rowId: 'r', values: { done: true } }))).toBeUndefined();
      expect(await valuesOf(session, 'r')).toEqual({ title: 'Sprint', done: true });
      expect(errorOf(await run(session, 'database.addComment', { id: 'db', rowId: 'r', text: 'Row comment' }))).toBeUndefined();
      expect((await session.read({ detail: 'full' })).blocks.find(block => block.id === 'r')?.comments?.threads).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Row comment' })]));
      expect(errorOf(await run(session, 'database.moveRowTo', { id: 'db', rowId: 'r', databaseId: 'other' }))).toBeUndefined();
      expect(await dataOf(session, 'r')).toMatchObject({ pageId: 'body-doc', properties: { title: 'Sprint', done: true } });
    } finally { await session.close(); }
  });

  const unsafe: Array<[string, string, Record<string, unknown>]> = [
    ['insert into a detached body', 'block.insert', { type: 'paragraph', data: { text: 'Hidden' }, parentId: 'r' }],
    ['insert a table into a detached body', 'table.create', { rows: 1, cols: 1, parentId: 'r' }],
    ['move into a detached body', 'block.move', { id: 'loose', parentId: 'r', position: 'end' }],
    ['replace the body pointer', 'block.update', { id: 'r', data: { pageId: 'other-doc' } }],
    ['remove the body pointer', 'block.update', { id: 'r', data: { pageId: null } }],
    ['convert away the body pointer', 'block.convert', { id: 'r', type: 'paragraph' }],
    ['duplicate a detached row without its content', 'database.duplicateRow', { id: 'db', rowId: 'r' }],
    ['duplicate a detached row through the generic command', 'block.duplicate', { id: 'r' }],
    ['duplicate a database sharing detached bodies', 'block.duplicate', { id: 'db' }],
    ['apply a template to an unread detached body', 'database.applyTemplate', { id: 'db', rowId: 'r', templateId: 'tpl' }],
  ];

  it.each(unsafe)('refuses to %s atomically and explains the separate body', async (_case, name, args) => {
    const session = open(seed());
    try {
      const before = await session.read({ detail: 'full' });
      const result = await session.execute({ commands: [
        { name: 'database.setRowValues', args: { id: 'db', rowId: 'inline', values: { done: true } } },
        { name, args },
      ] } as AgentBatch);
      expect(result.ok).toBe(false);
      expect(errorOf(result)?.message).toMatch(/pageId|separate.*body|body.*document/i);
      expect((await session.read({ detail: 'full' })).blocks).toEqual(before.blocks);
    } finally { await session.close(); }
  });

  it('still edits an inline body and deletes a detached row without touching another document', async () => {
    const session = open(seed());
    try {
      expect(errorOf(await run(session, 'block.insert', { type: 'paragraph', data: { text: 'Visible' }, parentId: 'inline' }))).toBeUndefined();
      expect(errorOf(await run(session, 'database.deleteRow', { id: 'db', rowId: 'r' }))).toBeUndefined();
      expect(await dataOf(session, 'r')).toBeUndefined();
      expect(await dataOf(session, 'inline')).toMatchObject({ properties: { title: 'Inline' } });
    } finally { await session.close(); }
  });

  it('edits tables in a body document without changing the parent database', async () => {
    const parent = open(seed());
    const body = open({ blocks: [] });
    try {
      const before = await parent.read({ detail: 'full' });
      expect(errorOf(await run(body, 'table.create', { rows: 1, cols: 1, cells: [['Initial']] }))).toBeUndefined();
      const table = (await body.read({ detail: 'full' })).blocks.find(block => block.type === 'table');
      if (table === undefined) throw new Error('Missing table');
      expect(errorOf(await run(body, 'table.insertRows', { id: table.id, at: 1, cells: [['Added']] }))).toBeUndefined();
      const paragraph = (await body.read({ detail: 'full' })).blocks.find(block => block.text === 'Initial');
      if (paragraph === undefined) throw new Error('Missing cell text');
      expect(errorOf(await run(body, 'text.replace', { id: paragraph.id, range: { find: 'Initial' }, with: 'Updated' }))).toBeUndefined();
      const texts = (await body.read({ detail: 'full' })).blocks.map(block => block.text);
      expect(texts).toContain('Updated');
      expect(texts).toContain('Added');
      expect((await parent.read({ detail: 'full' })).blocks).toEqual(before.blocks);
    } finally { await body.close(); await parent.close(); }
  });
});

describe.each(['stored', 'live'])('MCP server runtime (%s)', mode => {
  const call = async (document: OutputData, commands: AgentBatch['commands']) => JSON.parse(await invoke('agentExecute', JSON.stringify({
    mcp: { pageTitles: 'off', sync: mode === 'live', source: true, uploads: false, mode, write: true },
    document, actor: TEST_ACTOR, batch: { commands },
  }))) as { result: { ok: boolean }; document: OutputData; ops: unknown[]; save: boolean };

  it('batches cell, schema and view edits while preserving the separate body pointer', async () => {
    const output = await call(seed(), [
      { name: 'database.setRowValues', args: { id: 'db', rowId: 'r', values: { done: true } } },
      { name: 'database.setRowValues', args: { id: 'db', rowId: 'inline', values: { title: 'Renamed' } } },
      { name: 'database.addProperty', args: { id: 'db', name: 'Effort', type: 'number' } },
      { name: 'database.updateView', args: { id: 'db', viewId: 'db-v', changes: { wrapCells: true } } },
    ]);
    expect(output.result).toMatchObject({ ok: true });
    expect(output.document.blocks.find(block => block.id === 'r')?.data).toMatchObject({ pageId: 'body-doc', properties: { title: 'Sprint', done: true } });
    expect(output.document.blocks.find(block => block.id === 'inline')?.data).toMatchObject({ properties: { title: 'Renamed' } });
    const database = output.document.blocks.find(block => block.id === 'db')?.data;
    expect(database?.schema).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Effort', type: 'number' })]));
    expect(database?.views).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'db-v', wrapCells: true })]));
  });

  it('does not apply the first cell update when a later command targets the wrong document', async () => {
    const document = seed();
    const before = await call(document, [{ name: 'doc.read', args: {} }]);
    const output = await call(document, [
      { name: 'database.setRowValues', args: { id: 'db', rowId: 'r', values: { done: true } } },
      { name: 'block.insert', args: { parentId: 'r', type: 'paragraph', data: { text: 'Invisible' } } },
    ]);
    expect(output.result).toMatchObject({ ok: false });
    expect(output.document).toEqual(before.document);
    expect(output.save).toBe(false);
  });
});
