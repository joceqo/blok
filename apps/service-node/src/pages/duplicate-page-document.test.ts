import { describe, expect, it } from 'vitest';

import {
  duplicatePageDocumentBinding,
  type PageDocumentBindingSource,
} from './duplicate-page-document.js';

describe('duplicatePageDocumentBinding', () => {
  const source: PageDocumentBindingSource = {
    pageId: 'page-source',
    docId: 'doc-abc',
    lineage: 'lineage-1',
    sequence: 42n,
  };

  it('returns undefined when the source page has no binding', () => {
    expect(duplicatePageDocumentBinding(undefined, 'page-copy')).toBeUndefined();
  });

  it('reuses doc_id, lineage, and sequence on the new page_id', () => {
    expect(duplicatePageDocumentBinding(source, 'page-copy')).toEqual({
      pageId: 'page-copy',
      docId: 'doc-abc',
      lineage: 'lineage-1',
      sequence: 42n,
    });
  });

  it('preserves null lineage and sequence', () => {
    expect(
      duplicatePageDocumentBinding(
        { ...source, lineage: null, sequence: null },
        'page-copy',
      ),
    ).toEqual({
      pageId: 'page-copy',
      docId: 'doc-abc',
      lineage: null,
      sequence: null,
    });
  });
});