import { describe, expect, it } from 'vitest';

import { buildWorkspaceExportManifest } from './export-manifest.ts';

describe('buildWorkspaceExportManifest', () => {
  const createdAt = new Date('2026-03-15T12:00:00.000Z');
  const updatedAt = new Date('2026-03-16T08:30:00.000Z');

  it('returns top-level workspace, members, pages, and presets without page bodies', () => {
    const manifest = buildWorkspaceExportManifest({
      workspace: {
        id: 'ws-1',
        name: 'Acme',
        slug: 'acme',
        createdAt,
      },
      members: [
        { userId: 'u-owner', email: 'owner@example.com', role: 'owner' },
        { userId: 'u-guest', email: 'guest@example.com', role: 'guest' },
      ],
      pages: [
        {
          id: 'p-1',
          title: 'Home',
          parentId: null,
          trashed: false,
          updatedAt,
        },
        {
          id: 'p-2',
          title: 'Archive',
          parentId: 'p-1',
          trashed: true,
          updatedAt,
        },
      ],
      presets: [
        {
          id: 'preset-1',
          workspaceId: 'ws-1',
          name: 'Editors',
          config: { read: 'guest', edit: 'member' },
          createdAt,
        },
      ],
    });

    expect(manifest).toEqual({
      workspace: {
        id: 'ws-1',
        name: 'Acme',
        slug: 'acme',
        createdAt,
      },
      members: [
        { userId: 'u-owner', email: 'owner@example.com', role: 'owner' },
        { userId: 'u-guest', email: 'guest@example.com', role: 'guest' },
      ],
      pages: [
        {
          id: 'p-1',
          title: 'Home',
          parentId: null,
          trashed: false,
          updatedAt,
        },
        {
          id: 'p-2',
          title: 'Archive',
          parentId: 'p-1',
          trashed: true,
          updatedAt,
        },
      ],
      presets: [
        {
          id: 'preset-1',
          workspaceId: 'ws-1',
          name: 'Editors',
          config: { read: 'guest', edit: 'member' },
          createdAt,
        },
      ],
    });

    for (const page of manifest.pages) {
      expect(page).not.toHaveProperty('body');
      expect(page).not.toHaveProperty('docId');
      expect(page).not.toHaveProperty('blocks');
    }
  });
});