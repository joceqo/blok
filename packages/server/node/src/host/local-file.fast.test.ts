import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
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

describe('local files', () => {
  it('serves a seeded file at the public path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'blok-node-local-file-'));
    const name = '0123456789abcdef0123456789abcdef.txt';
    const path = join(directory, name);
    const modified = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000 + 0.5;
    writeFileSync(path, '0123456789abcdefghij');
    utimesSync(path, modified, modified);
    const publicUrl = 'https://uploads.example.com/files/';
    const options: HostAppOptions = {
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
    const response = await invokeHost(options, {
      method: 'GET',
      path: `/files/${name}`,
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('0123456789abcdefghij');
  });
});