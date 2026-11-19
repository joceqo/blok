import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const CONFIG_ENV_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'BLOK_SIDECAR_URL',
  'MAILER_HOST',
  'SMTP_HOST',
] as const;

describe('createApp integration (no PostgreSQL)', () => {
  let savedEnv: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of CONFIG_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) {
        savedEnv[key] = value;
      }
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function appWithoutDb() {
    return createApp({ database: undefined });
  }

  it('GET /health', async () => {
    const response = await appWithoutDb().request('http://localhost/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('responses include baseline security headers', async () => {
    const response = await appWithoutDb().request('http://localhost/health');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('GET /api/instance reflects env without a database URL', async () => {
    const response = await appWithoutDb().request('http://localhost/api/instance');
    expect(response.status).toBe(200);
    const body: {
      ready: boolean;
      database: boolean;
      sidecar: boolean;
      mailer: boolean;
      version: string;
    } = await response.json();
    expect(body).toEqual({
      ready: false,
      database: false,
      sidecar: false,
      mailer: false,
      version: expect.any(String) as string,
    });
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('GET and POST /api/workspaces return 503 when DATABASE is not wired into createApp', async () => {
    const app = appWithoutDb();

    const getResponse = await app.request('http://localhost/api/workspaces');
    expect(getResponse.status).toBe(503);
    await expect(getResponse.json()).resolves.toEqual({ error: 'database_not_configured' });

    const postResponse = await app.request('http://localhost/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    expect(postResponse.status).toBe(503);
    await expect(postResponse.json()).resolves.toEqual({ error: 'database_not_configured' });
  });

  it('workspace preset routes return 503 when DATABASE is not wired into createApp', async () => {
    const app = appWithoutDb();
    const workspaceId = '00000000-0000-0000-0000-000000000001';
    const presetId = '00000000-0000-0000-0000-000000000002';
    const presetBase = `http://localhost/api/workspaces/${workspaceId}/presets`;
    const presetOne = `${presetBase}/${presetId}`;

    const getList = await app.request(presetBase);
    expect(getList.status).toBe(503);
    await expect(getList.json()).resolves.toEqual({ error: 'database_not_configured' });

    const getOne = await app.request(presetOne);
    expect(getOne.status).toBe(503);
    await expect(getOne.json()).resolves.toEqual({ error: 'database_not_configured' });

    const postResponse = await app.request(presetBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Editors', config: { read: 'guest', edit: 'member' } }),
    });
    expect(postResponse.status).toBe(503);
    await expect(postResponse.json()).resolves.toEqual({ error: 'database_not_configured' });

    const patchResponse = await app.request(presetOne, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(patchResponse.status).toBe(503);
    await expect(patchResponse.json()).resolves.toEqual({ error: 'database_not_configured' });

    const deleteResponse = await app.request(presetOne, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(503);
    await expect(deleteResponse.json()).resolves.toEqual({ error: 'database_not_configured' });
  });

  it('GET /api/blok returns 503 when BLOK_SIDECAR_URL is unset', async () => {
    const response = await appWithoutDb().request('http://localhost/api/blok');
    expect(response.status).toBe(503);
    const body: { error?: string } = await response.json();
    expect(body.error).toBe('sidecar_not_configured');
  });

  it('GET /api/documents/:docId/state returns 503 when DATABASE is not wired into createApp', async () => {
    const response = await appWithoutDb().request(
      'http://localhost/api/documents/doc-1/state',
    );
    expect(response.status).toBe(503);
    const body: { error?: string } = await response.json();
    expect(body.error).toBe('database_not_configured');
  });
});