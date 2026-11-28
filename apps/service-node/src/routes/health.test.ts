import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { healthRoutes } from './health.ts';

describe('GET /health', () => {
  let savedServiceVersion: string | undefined;

  beforeEach(() => {
    savedServiceVersion = process.env.SERVICE_VERSION;
    delete process.env.SERVICE_VERSION;
  });

  afterEach(() => {
    if (savedServiceVersion === undefined) {
      delete process.env.SERVICE_VERSION;
    } else {
      process.env.SERVICE_VERSION = savedServiceVersion;
    }
  });

  it('returns status ok and the service version', async () => {
    const response = await healthRoutes.request('http://localhost/health');
    expect(response.status).toBe(200);
    const body: { status: string; version: string } = await response.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.0.0');
  });

  it('uses SERVICE_VERSION when set', async () => {
    process.env.SERVICE_VERSION = '1.2.3';
    const response = await healthRoutes.request('http://localhost/health');
    const body: { status: string; version: string } = await response.json();
    expect(body).toEqual({ status: 'ok', version: '1.2.3' });
  });
});