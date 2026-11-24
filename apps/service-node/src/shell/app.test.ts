import { describe, expect, it, vi } from 'vitest';
import type { PgPool } from '../db/pool.js';
import { createShellApp } from './app.js';

const secret = 's'.repeat(32);
const origins = new Set(['https://example.test', 'tauri://localhost']);

describe('shell API admission', () => {
  const unused = {} as PgPool;
  const app = createShellApp(unused, secret, origins);

  it('refuses a document callback before reading the request body', async () => {
    const res = await app.request('/internal/documents/p', { method: 'PUT', body: 'invalid' });
    expect(res.status).toBe(401);
  });

  it('requires a shell session before looking up a page', async () => {
    expect((await app.request('/api/workspaces/demo/pages/p')).status).toBe(401);
    expect((await app.request('/api/session')).status).toBe(401);
  });

  it('separates native and foreign origins', async () => {
    const res = await app.request('/api/session', { method: 'OPTIONS', headers: { Origin: 'tauri://localhost' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    expect((await app.request('/api/session', { headers: { Origin: 'https://other.test' } })).status).toBe(403);
  });

  it('refuses malformed/oversized documents and inconsistent journal headers', async () => {
    const headers = new Headers({ Authorization: 'Bearer ' + secret });
    const put = (body: string) => app.request('/internal/documents/p', { method: 'PUT', headers, body });
    expect((await put('{')).status).toBe(400);
    headers.set('Blok-Doc-Lineage', 'lineage');
    expect((await put('{}')).status).toBe(400);
    headers.set('Content-Length', '67108865');
    expect((await put('{}')).status).toBe(413);
  });

  it('returns stored numeric JSON lexemes unchanged to the collaboration engine', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ content: '{"id":9007199254740993}', version: '1' }] }) };
    const withPage = createShellApp(db as unknown as PgPool, secret, origins);
    const res = await withPage.request('/internal/documents/p', { headers: { Authorization: 'Bearer ' + secret } });
    expect(await res.text()).toBe('{"data":{"id":9007199254740993},"version":"1"}');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
