// @vitest-environment node

import { expect, it as baseIt } from 'vitest';

// Only scripts/test-service-conformance.mjs sets this when a product API is listening.
const it = baseIt.skipIf(
  process.env.BLOK_SERVICE_CONFORMANCE_URL === undefined ||
  process.env.BLOK_SERVICE_CONFORMANCE_URL === '',
);

it('node app serves health', async () => {
  const base = process.env.BLOK_SERVICE_CONFORMANCE_URL ?? '';
  const response = await fetch(new URL('/health', base).toString());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
});