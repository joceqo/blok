import { chmodSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { publicPathFromUrl } from '../args/public-url.ts';
import { LocalStore } from '../blob/local.ts';
import { DefaultBlockedPolicy, OutboundFetcher } from '../outbound/fetcher.ts';
import { RateLimiter } from './rate-limit.ts';
import { hostNames } from './host-check.ts';
import type { HostAppOptions } from './options.ts';
import { defaultMaxUpload } from './upload.ts';
import { invokeHost } from '../test-kit/invoke-host.ts';
import type { ParsedHttpResponse } from '../test-kit/parse-http-response.ts';

function hostOptions(directory: string): HostAppOptions {
  const publicUrl = 'https://uploads.example.com/files/';

  return {
      version: 'dev',
      auth: 'none',
      secret: '',
      unfurlDisabled: false,
      unfurlEnabled: true,
      storageDirectory: directory,
      publicPath: publicPathFromUrl(publicUrl),
      publicUrl,
      maxUploadBytes: defaultMaxUpload(undefined),
      collabEnabled: false,
      collabDirectory: '',
      collabJournal: false,
      collabS3Prefix: '',
      docEndpoint: '',
      docEndpointAuth: '',
      collabLog: () => {},
      allowedOrigins: [],
      fileBytesEnabled: false,
      fileBytesMaxBytes: 100 << 20,
      filesCors: false,
      fetcher: new OutboundFetcher(new DefaultBlockedPolicy()),
      rateLimiter: new RateLimiter(0),
      rateLimitPerMinute: 0,
      loopbackHostCheck: false,
      allowedHostNames: hostNames([], publicUrl),
      blobStore: new LocalStore(directory, publicUrl),
    };
}

describe('local files', () => {
  it('serves a seeded file at the public path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'blok-node-local-file-'));
    const name = '0123456789abcdef0123456789abcdef.txt';
    const path = join(directory, name);
    const modified = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000 + 0.5;
    writeFileSync(path, '0123456789abcdefghij');
    utimesSync(path, modified, modified);
    const response = await invokeHost(hostOptions(directory), {
      method: 'GET',
      path: `/files/${name}`,
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('0123456789abcdefghij');
  });

  // C# opens the file before it writes a head, so a key it cannot read is a
  // 404 — never a 200 whose body dies halfway through.
  it('answers 404 for a key it may not read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'blok-node-local-file-'));
    const name = 'cccccccccccccccccccccccccccccccc.txt';
    const path = join(directory, name);
    writeFileSync(path, '0123456789abcdefghij');
    chmodSync(path, 0o000);

    try {
      const response = await invokeHost(hostOptions(directory), {
        method: 'GET',
        path: `/files/${name}`,
      });

      expect(response.status).toBe(404);
      expect(response.body.toString()).toBe('404 page not found\n');
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

const EXACT = 'Fri, 02 Jan 2026 03:04:05 GMT';

/**
 * The file is stamped half a second past EXACT. Last-Modified truncates to the
 * second, and C# compares preconditions against that truncated stamp, so the
 * half second must not tip a comparison either way.
 */
function seedTextFile(): { directory: string; name: string } {
  const directory = mkdtempSync(join(tmpdir(), 'blok-node-local-file-'));
  const name = '0123456789abcdef0123456789abcdef.txt';
  const modified = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000 + 0.5;

  writeFileSync(join(directory, name), '0123456789abcdefghij');
  utimesSync(join(directory, name), modified, modified);

  return { directory, name };
}

function ask(headers: Record<string, string>): Promise<ParsedHttpResponse> {
  const { directory, name } = seedTextFile();

  return invokeHost(hostOptions(directory), { method: 'GET', path: `/files/${name}`, headers });
}

describe('local file preconditions', () => {
  it('reads a date the way HeaderUtilities does, against the truncated stamp', async () => {
    // The stamp truncates to EXACT, so "not modified since EXACT" holds.
    expect((await ask({ 'If-Modified-Since': EXACT })).status).toBe(304);
    // And "unmodified since EXACT" holds too, so the answer is the file.
    expect((await ask({ 'If-Unmodified-Since': EXACT })).status).toBe(200);
    // Spellings .NET takes, all the same instant.
    expect((await ask({ 'If-Modified-Since': 'Friday, 02-Jan-26 03:04:05 GMT' })).status).toBe(304);
    expect((await ask({ 'If-Modified-Since': 'Fri Jan  2 03:04:05 2026' })).status).toBe(304);
    expect((await ask({ 'If-Modified-Since': 'Fri, 02 Jan 2026 04:04:05 +0100' })).status).toBe(304);
    // Spellings it refuses, where Date.parse would have taken them.
    expect((await ask({ 'If-Modified-Since': 'fri, 02 jan 2026 03:04:05 gmt' })).status).toBe(200);
    expect((await ask({ 'If-Modified-Since': 'Fri, 02 Jan 2026 03:04:05 UTC' })).status).toBe(200);
    expect((await ask({ 'If-Modified-Since': '2026-01-02T03:04:05Z' })).status).toBe(200);
    expect((await ask({ 'If-Modified-Since': 'Mon, 02 Jan 2026 03:04:05 GMT' })).status).toBe(200);
  });

  it('frames a 412 with a content length of its own', async () => {
    const refused = await ask({ 'If-Match': '"abc"' });

    expect(refused.status).toBe(412);
    expect(refused.headers['content-length']).toEqual(['0']);
    expect(refused.headers['transfer-encoding']).toBeUndefined();
  });
});

describe('local file ranges', () => {
  it('reads a zero suffix as no overlap, not as a broken range', async () => {
    const answer = await ask({ Range: 'bytes=-0' });

    expect([answer.status, answer.body.toString()])
      .toEqual([416, 'invalid range: failed to overlap\n']);
    expect(answer.headers['content-range']).toEqual(['bytes */20']);
  });

  it('takes a signed bound', async () => {
    const answer = await ask({ Range: 'bytes=+5-+9' });

    expect([answer.status, answer.body.toString()]).toEqual([206, '56789']);
    expect(answer.headers['content-range']).toEqual(['bytes 5-9/20']);
  });

  it('refuses a bound past Int64', async () => {
    const answer = await ask({ Range: 'bytes=0-9223372036854775808' });

    expect([answer.status, answer.body.toString()]).toEqual([416, 'invalid range\n']);
  });

  it('names too many ranges apart from a broken one', async () => {
    const seventeen = `bytes=${Array.from({ length: 17 }, (_, index) => `${index}-${index}`).join(',')}`;
    const answer = await ask({ Range: seventeen });

    expect([answer.status, answer.body.toString()]).toEqual([416, 'too many ranges\n']);
    // Seventeen specs, even when sixteen of them are empty.
    const padded = await ask({ Range: 'bytes=0-0,,,,,,,,,,,,,,,,' });

    expect([padded.status, padded.body.toString()]).toEqual([416, 'too many ranges\n']);
  });
});