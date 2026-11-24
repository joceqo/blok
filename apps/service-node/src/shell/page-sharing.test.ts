import { describe, expect, it, vi } from 'vitest';
import type { PgPool } from '../db/pool.ts';
import { resolvePageLevel, type Role } from './page-level.ts';
import { createShellApp } from './app.ts';

describe('levels used by the access sheet and sidebar', () => {
  it.each([
    ['admin', 'full', 'full'], ['member', 'edit', 'full'], ['viewer', 'view', 'view'],
  ] as const)('%s has a workspace base and a ceiling on explicit grants', (role: Role, base, cap) => {
    expect(resolvePageLevel(role, 'workspace', -1)).toBe(base);
    expect(resolvePageLevel(role, 'private', -1)).toBeUndefined();
    expect(resolvePageLevel(role, 'private', 2)).toBe(cap);
    expect(resolvePageLevel(role, 'private', 0)).toBe('view');
  });
});

describe('sharing HTTP boundary', () => {
  const connect = vi.fn();
  const recheck = vi.fn();
  const app = createShellApp({ connect } as unknown as PgPool, 'a'.repeat(32), new Set(), recheck);
  it('requires a session before touching the database', async () => {
    const response = await app.request('/api/workspaces/demo/pages/p/access');
    expect(response.status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });
  it('refuses a cross-site cookie mutation with omitted origin', async () => {
    const response = await app.request('/api/workspaces/demo/pages/p/shares/me', {
      method: 'DELETE', headers: { Cookie: 'blok_session=me', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(response.status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
  });
});
