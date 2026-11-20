import { describe, expect, it } from 'vitest';

import {
  parseTeamspaceCreateBody,
  parseTeamspaceMemberAddBody,
} from '@/workspaces/teamspace-body.js';

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