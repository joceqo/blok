import { expect, it } from 'vitest';
import { parseIndex, planIndexSave } from './index-save.js';
import { workspaceIndex, type IndexPage, type Role } from './workspace-index.js';

const cases = [
  ['admin', null, undefined], ['member', null, undefined], ['viewer', null, undefined],
  ['member', 'view', 'view'], ['member', 'edit', 'edit'], ['member', 'full', 'full'],
  ['viewer', 'edit', 'view'], ['viewer', 'full', 'view'],
] as const;

it.each(cases)('a %s with a %s ancestor grant projects and saves a private subtree consistently',
  (role: Role, share, expected) => {
    const root = { id: 'root', title: 'Root', parentId: null };
    const child = { id: 'child', title: 'Child', parentId: 'root' };
    const rows: IndexPage[] = [
      { id: root.id, metadata: root, visibility: 'private', share, shared: true, trashed: false },
      { id: child.id, metadata: child, visibility: 'inherit', share: null, shared: false, trashed: false },
    ];
    const index = workspaceIndex(rows, role, 0);
    expect(index.access.child?.level).toBe(expected);
    expect(index.pages.map(page => page.id)).toEqual(expected ? ['root', 'child'] : []);

    const pages = index.pages.map(page => ({ ...page, title: 'New title' }));
    const { incoming } = parseIndex({ revision: index.revision, pages });
    const saved = planIndexSave(rows, role, incoming);
    expect(saved.removed).toEqual([]);
    const writable = expected === 'edit' || expected === 'full';
    expect(saved.updates.map(row => row.metadata.title)).toEqual(writable ? ['New title', 'New title'] : []);
    expect(saved.fixed.map(row => row.id)).toEqual(writable ? [] : ['root', 'child']);
  });
