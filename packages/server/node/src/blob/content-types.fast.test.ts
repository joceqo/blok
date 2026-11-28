/**
 * content-types.json holds ASP.NET's FileExtensionContentTypeProvider table;
 * the C# host answers from it directly and the Go host generates its own copy.
 * Node's copy is generated too — this fails when it goes stale, so the three
 * hosts cannot disagree on a stored file's Content-Type.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONTENT_TYPES } from './content-types.ts';
import { contentTypeFor } from './local.ts';

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    '../../../../../test/unit/server-conformance/fixtures/content-types.json',
    import.meta.url,
  )),
  'utf8',
)) as Record<string, string>;

describe('content types', () => {
  it('carries the whole provider table', () => {
    // Regenerate with: node scripts/generate-node-content-types.mjs
    expect(CONTENT_TYPES).toEqual(fixture);
  });

  it('folds the case of an extension the table spells in upper case', () => {
    // ".IVF" is the provider's own spelling; a stored key is lower case.
    expect(fixture['.IVF']).toBe('video/x-ivf');
    expect(contentTypeFor('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.ivf')).toBe('video/x-ivf');
    expect(contentTypeFor('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.IVF')).toBe('video/x-ivf');
  });

  it('keeps the types the host already answered', () => {
    expect(contentTypeFor('a.txt')).toBe('text/plain');
    expect(contentTypeFor('a.json')).toBe('application/json');
    expect(contentTypeFor('a.pdf')).toBe('application/pdf');
  });

  it('falls back to a byte stream for an extension the table lacks', () => {
    expect(contentTypeFor('a.blokunknown')).toBe('application/octet-stream');
    expect(contentTypeFor('a')).toBe('application/octet-stream');
  });
});
