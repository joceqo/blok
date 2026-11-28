import { describe, expect, it, vi } from 'vitest';
import type { PgPool } from '../db/pool.ts';
import { createShellApp } from './app.ts';
import { parseUserId } from '../models/User.ts';

describe('shell teamspace directory', () => {
  it('accepts canonical opaque IDs and earlier UUIDs', () => {
    for (const id of ['AZ_u-7', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']) {
      expect(parseUserId(' ' + id + ' ')).toBe(id);
    }
    for (const input of ['', ' ', 'a/b', null, {}, 12]) expect(parseUserId(input)).toBeUndefined();
  });

  it('requires a session and supports the native POST and PATCH preflight', async () => {
    const db = { connect: vi.fn() };
    const app = createShellApp(db as unknown as PgPool, 'a'.repeat(32), new Set(['tauri://localhost']));
    const path = '/api/workspaces/demo/teamspaces';
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(401);
    const preflight = await app.request(path, { method: 'OPTIONS', headers: { Origin: 'tauri://localhost' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')?.split(', ')).toEqual(expect.arrayContaining(['POST','PATCH']));
    expect(db.connect).not.toHaveBeenCalled();
  });
});
