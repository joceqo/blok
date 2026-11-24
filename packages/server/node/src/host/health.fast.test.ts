import { describe, expect, it } from 'vitest';

import { healthBodySchema } from '../schemas/health.ts';
import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';

describe('@fast GET /health', () => {
  it('returns JSON validated by Zod', async () => {
    const response = await invokeHost(defaultTestHostOptions(), {
      method: 'GET',
      path: '/health',
    });
    expect(response.status).toBe(200);
    const json = JSON.parse(response.body.trim()) as unknown;
    expect(healthBodySchema.parse(json)).toEqual({ status: 'ok', version: 'dev' });
  });

  it('HEAD returns 200 without a body', async () => {
    const response = await invokeHost(defaultTestHostOptions(), {
      method: 'HEAD',
      path: '/health',
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('');
  });
});