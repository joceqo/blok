import { describe, expect, it } from 'vitest';
import { type IndexPage, workspaceIndex } from './workspace-index.js';

function page(id: string, fields: Partial<IndexPage> = {}): IndexPage {
  return { id, metadata: { id }, trashed: false, visibility: 'workspace', share: null, shared: false, ...fields };
}

describe('workspace index page access', () => {
  const rows = [
    page('h', { visibility: 'private' }),
    page('s', { metadata: { id: 's', parentId: 'h' }, visibility: 'inherit', share: 'edit' }),
    page('t', { metadata: { id: 't', parentId: 's' }, visibility: 'inherit', trashed: true }),
    page('__proto__', { shared: true, share: 'full' }),
  ];

  it('keeps ordered metadata, hidden roots and trash consistent with the returned access map', () => {
    const index = workspaceIndex(rows, 'member', 42);
    expect(index.pages).toEqual([{ id: 's', parentId: null }, { id: '__proto__' }]);
    expect(index.trash).toEqual([{ id: 't', parentId: 's' }]);
    expect(index.access.s).toEqual({ level: 'edit', visibility: 'private', shared: false, sharedRoot: true });
    expect(index.access.t?.level).toBe('edit');
    expect(index.access['__proto__']).toEqual({ level: 'full', visibility: 'workspace', shared: true });
    expect(index.revision).toBe(42);
    expect(rows[1]?.metadata.parentId).toBe('h');
  });

  it('caps a viewer at read, including when a share grants full access', () => {
    const index = workspaceIndex(rows, 'viewer', 0);
    expect(Object.values(index.access).every((entry) => entry.level === 'view')).toBe(true);
  });

  it('keeps unshared private pages hidden even from workspace admins', () => {
    const index = workspaceIndex(rows, 'admin', 0);
    expect(index.access.h).toBeUndefined();
  });

  it('terminates on a cycle without granting inherited workspace visibility', () => {
    const cyclic = page('loop', { metadata: { id: 'loop', parentId: 'loop' }, visibility: 'inherit' });
    expect(workspaceIndex([cyclic], 'admin', 0).pages).toEqual([]);
  });
});
