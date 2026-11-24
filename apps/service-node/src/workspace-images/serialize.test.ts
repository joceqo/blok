import { describe, expect, it } from 'vitest';

import { toWorkspaceImageJson } from './serialize.ts';

describe('toWorkspaceImageJson', () => {
  it('stringifies byteSize', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      toWorkspaceImageJson({
        id: 'img-1',
        workspaceId: 'w1',
        storageKey: 'images/cover.png',
        byteSize: 2048n,
        createdAt,
      }),
    ).toEqual({
      id: 'img-1',
      workspaceId: 'w1',
      storageKey: 'images/cover.png',
      byteSize: '2048',
      createdAt,
    });
  });
});