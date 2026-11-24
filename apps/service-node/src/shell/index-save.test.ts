import { describe, expect, it } from 'vitest';
import { parseIndex, planIndexSave } from './index-save.js';
import type { IndexPage } from './workspace-index.js';

const meta = (id: string, parentId: string | null = null) => ({ id, title: id, parentId });
const row = (id: string, fields: Partial<IndexPage> = {}): IndexPage => ({
  id, metadata: meta(id), visibility: 'workspace', trashed: false, share: null, shared: false, ...fields,
});
const input = (pages: unknown[], trash: unknown[] = []) => parseIndex({ revision: 2, pages, trash }).incoming;

describe('shell index validation and ordering', () => {
  it.each([
    { pages: [], revision: 1.2 }, { revision: 0 }, { pages: [], revision: 0, trash: {} },
    { pages: [meta('a'), meta('a')], revision: 1 }, { pages: [meta('a','b')], revision: 1 },
    { pages: [meta('a','b'), meta('b','a')], revision: 1 }, { pages: [meta('a/b')], revision: 1 },
    { pages: [{ ...meta('a'), title: 'é'.repeat(2049) }], revision: 1 },
    { pages: [{ ...meta('a'), favorite: 1 }], revision: 1 },
    { pages: [{ ...meta('a'), titleDateDisplay: { timeZone: 'Not/AZone' } }], revision: 1 },
    { pages: Array(10_001).fill(null), revision: 0 },
  ])('rejects malformed metadata and hierarchy', body => expect(() => parseIndex(body)).toThrow());

  it('validates long trees without recursion', () => {
    const pages = Array.from({ length: 10_000 }, (_, i) => meta(String(i), i < 9_999 ? String(i+1) : null));
    expect(input(pages)).toHaveLength(10_000);
  });

  it('keeps invisible and read-only pages behind their preceding writable page', () => {
    const rows = [row('a'), row('h', { visibility:'private' }), row('r', { visibility:'private', share:'view' }), row('b')];
    const planned = planIndexSave(rows, 'member', input([meta('b'), meta('a'), { ...meta('r'), title:'ignored' }]));
    expect(planned.fixed).toEqual([{ id:'h', position:2 }, { id:'r', position:3 }]);
    expect(planned.updates.map(p => [p.id,p.metadata.position])).toEqual([['b',0],['a',1]]);
    expect(planned.removed).toEqual([]);
  });

  it('restores the real hidden parent of a detached shared root', () => {
    const rows = [row('h', { visibility:'private' }), row('s', { metadata:meta('s','h'), visibility:'inherit', share:'edit' })];
    expect(planIndexSave(rows,'member',input([meta('s')])).updates[0]?.metadata.parentId).toBe('h');
    expect(() => planIndexSave(rows,'member',input([meta('h')]))).toThrow('Page access refused');
  });

  it('requires edit on the source and its existing destination for a move or child creation', () => {
    const rows = [row('w'), row('r', {visibility:'private', share:'view'})];
    for (const pages of [
      [meta('w','r'),meta('r')], [meta('w'),meta('r','w')], [meta('w'),meta('r'),meta('new','r')],
    ]) expect(() => planIndexSave(rows,'member',input(pages))).toThrow('Write access');
  });

  it('finds a cycle that is hidden by the detached root shown to the client', () => {
    const rows = [
      row('a'), row('h',{metadata:meta('h','a'),visibility:'private'}),
      row('s',{metadata:meta('s','h'),visibility:'inherit',share:'edit'}),
    ];
    expect(() => planIndexSave(rows,'member',input([meta('s'),meta('a','s')]))).toThrow('cycle');
  });

  it('applies private visibility only when creating a root, shares the parent hierarchy otherwise', () => {
    const {creations} = planIndexSave([], 'admin', input([{ ...meta('r'), initialVisibility:'private' },meta('c','r'),meta('open')]));
    expect(creations.map(p => p.visibility)).toEqual(['private','inherit','workspace']);
    expect(creations[0]?.metadata).not.toHaveProperty('initialVisibility');
    expect(() => planIndexSave([], 'admin', input([meta('p'), { ...meta('c','p'), initialVisibility:'private' }]))).toThrow();
  });
});
