import { afterEach, expect, it, vi } from 'vitest';
import { createAccessRecheck } from './recheck-access.js';

afterEach(() => vi.unstubAllGlobals());

it('sends the recheck to the live server over loopback', async () => {
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', send);
  await createAccessRecheck('test-secret')('w1');
  expect(send).toHaveBeenCalledWith(new URL('http://127.0.0.1:8080/internal/workspaces/w1/recheck-access'), {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret' },
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
});

it('requires confirmation that the live server has finished the recheck', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  await expect(createAccessRecheck('test-secret')('w1')).rejects.toThrow('503');
});
