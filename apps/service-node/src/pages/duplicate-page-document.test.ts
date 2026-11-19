import { describe, expect, it } from 'vitest';

import {
  duplicatePageDocumentBinding,
  formatPageDocumentBinding,
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

  it('mints a new doc_id, fork lineage, and sequence 0 on the new page_id', () => {
    expect(duplicatePageDocumentBinding(source, 'page-copy', 'doc-new')).toEqual({
      pageId: 'page-copy',
      docId: 'doc-new',
      lineage: 'fork-of:doc-abc',
      sequence: 0n,
    });
  });

  it('still records fork-of lineage when the source lineage was null', () => {
    expect(
      duplicatePageDocumentBinding(
        { ...source, lineage: null, sequence: 99n },
        'page-copy',
        'doc-new',
      ),
    ).toEqual({
      pageId: 'page-copy',
      docId: 'doc-new',
      lineage: 'fork-of:doc-abc',
      sequence: 0n,
    });
  });
});

describe('formatPageDocumentBinding', () => {
  it('serializes sequence as a string for JSON responses', () => {
    expect(
      formatPageDocumentBinding({
        pageId: 'page-copy',
        docId: 'doc-new',
        lineage: 'fork-of:doc-abc',
        sequence: 0n,
      }),
    ).toEqual({
      pageId: 'page-copy',
      docId: 'doc-new',
      lineage: 'fork-of:doc-abc',
      sequence: '0',
    });
  });
});