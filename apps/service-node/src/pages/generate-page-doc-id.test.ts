import { describe, expect, it } from 'vitest';

import { generatePageDocId } from './generate-page-doc-id.js';
import { resolvePageDocumentPostBind } from './page-document-post-bind.js';

const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generatePageDocId', () => {
  it('returns a v4 UUID string', () => {
    expect(generatePageDocId()).toMatch(uuidV4);
  });
});

describe('resolvePageDocumentPostBind', () => {
  it('mints docId with lineage null and sequence 0 when docId is omitted', () => {
    const resolved = resolvePageDocumentPostBind({}, () => 'doc-minted');
    expect(resolved).toEqual({
      ok: true,
      docId: 'doc-minted',
      lineage: null,
      sequence: 0n,
    });
  });

  it('keeps explicit docId, lineage, and sequence when docId is provided', () => {
    expect(
      resolvePageDocumentPostBind({
        docId: ' doc-1 ',
        lineage: 'fork-of:other',
        sequence: 3,
      }),
    ).toEqual({
      ok: true,
      docId: 'doc-1',
      lineage: 'fork-of:other',
      sequence: 3n,
    });
  });

  it('rejects an empty docId string', () => {
    expect(resolvePageDocumentPostBind({ docId: '   ' })).toEqual({
      ok: false,
      error: 'invalid_doc_id',
    });
  });
});