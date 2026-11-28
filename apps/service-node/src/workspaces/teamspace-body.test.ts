import { describe, expect, it } from 'vitest';

import {
  parseTeamspaceCreateBody,
  parseTeamspaceMemberAddBody,
  parseTeamspaceMemberUserIdParam,
  parseTeamspacePatchBody,
  serializeTeamspace,
} from './teamspace-body.ts';

describe('parseTeamspaceCreateBody', () => {
  it('accepts a non-blank name', () => {
    expect(parseTeamspaceCreateBody({ name: ' Design ' })).toEqual({
      ok: true,
      name: 'Design',
    });
  });

  it('rejects missing or blank name', () => {
    expect(parseTeamspaceCreateBody({})).toEqual({ ok: false, reason: 'invalid_request' });
    expect(parseTeamspaceCreateBody({ name: '   ' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects non-object body', () => {
    expect(parseTeamspaceCreateBody(null)).toEqual({ ok: false, reason: 'invalid_request' });
  });
});

describe('parseTeamspacePatchBody', () => {
  it('accepts a non-blank name', () => {
    expect(parseTeamspacePatchBody({ name: ' Product ' })).toEqual({
      ok: true,
      name: 'Product',
    });
  });

  it('rejects missing or blank name', () => {
    expect(parseTeamspacePatchBody({})).toEqual({ ok: false, reason: 'invalid_request' });
    expect(parseTeamspacePatchBody({ name: '' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });
});

describe('parseTeamspaceMemberAddBody', () => {
  const userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  it('accepts a UUID userId', () => {
    expect(parseTeamspaceMemberAddBody({ userId })).toEqual({ ok: true, userId });
  });

  it('rejects missing or invalid userId', () => {
    expect(parseTeamspaceMemberAddBody({})).toEqual({ ok: false, reason: 'invalid_request' });
    expect(parseTeamspaceMemberAddBody({ userId: 'not-a-uuid' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });
});

describe('parseTeamspaceMemberUserIdParam', () => {
  const userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  it('accepts a UUID path param', () => {
    expect(parseTeamspaceMemberUserIdParam(userId)).toEqual({ ok: true, userId });
    expect(parseTeamspaceMemberUserIdParam(` ${userId} `)).toEqual({ ok: true, userId });
  });

  it('rejects invalid ids', () => {
    expect(parseTeamspaceMemberUserIdParam('')).toEqual({ ok: false, reason: 'invalid_request' });
    expect(parseTeamspaceMemberUserIdParam('bad')).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });
});

describe('serializeTeamspace', () => {
  it('returns id, workspaceId, name, createdAt unchanged', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      serializeTeamspace({
        id: '00000000-0000-0000-0000-000000000001',
        workspaceId: '00000000-0000-0000-0000-000000000002',
        name: 'Design',
        createdAt,
      }),
    ).toEqual({
      id: '00000000-0000-0000-0000-000000000001',
      workspaceId: '00000000-0000-0000-0000-000000000002',
      name: 'Design',
      createdAt,
    });
  });
});