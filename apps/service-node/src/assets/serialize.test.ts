import { describe, expect, it } from 'vitest';

import { toAssetJson } from './serialize.js';

describe('toAssetJson', () => {
  it('stringifies byteSize', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      toAssetJson({
        id: 'a1',
        workspaceId: 'w1',
        storageKey: 'files/a.png',
        byteSize: 1024n,
        createdAt,
      }),
    ).toEqual({
      id: 'a1',
      workspaceId: 'w1',
      storageKey: 'files/a.png',
      byteSize: '1024',
      createdAt,
    });
  });
});