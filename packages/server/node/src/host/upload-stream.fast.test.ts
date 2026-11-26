import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { defaultTestHostOptions, invokeHost } from '../test-kit/invoke-host.ts';

/**
 * An upload that fails part-way destroys the spool file's write stream, which
 * can report in-flight writes afterwards. An 'error' nobody listens for is an
 * uncaught exception: it kills the media process, and every later upload then
 * answers 503 at the CORS preflight until the app is restarted.
 */
describe('@fast upload stream teardown', () => {
  it('refuses an oversized upload and stays alive', async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      const boundary = 'overflowboundary';
      const body = new TextEncoder().encode(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="big.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        `${'x'.repeat(200_000)}\r\n` +
        `--${boundary}--\r\n`,
      );
      const response = await invokeHost(
        { ...defaultTestHostOptions(), maxUploadBytes: 40_000 },
        { method: 'POST', path: '/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body },
      );
      expect(response.status).toBe(413);
      // A destroyed stream reports its in-flight write a tick later.
      await delay(100);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
    }
  });
});
