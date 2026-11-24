import { randomUUID } from 'node:crypto';

/** Row fields copied from page_documents when duplicating a page. */
export type PageDocumentBindingSource = {
  pageId: string;
  docId: string;
  lineage: string | null;
  sequence: bigint | null;
};

export type PageDocumentBindingInsert = {
  pageId: string;
  docId: string;
  lineage: string | null;
  sequence: bigint | null;
};

/**
 * Builds a page_documents row for a duplicated page when the source page is bound.
 *
 * The duplicate gets a new `doc_id` (fresh collaboration document). Optionally records
 * provenance in `lineage` as `fork-of:<source doc_id>` and resets `sequence` to 0.
 */
export function duplicatePageDocumentBinding(
  source: PageDocumentBindingSource | undefined,
  newPageId: string,
  newDocId: string = randomUUID(),
): PageDocumentBindingInsert | undefined {
  if (source === undefined) {
    return undefined;
  }
  return {
    pageId: newPageId,
    docId: newDocId,
    lineage: `fork-of:${source.docId}`,
    sequence: 0n,
  };
}

export function formatPageDocumentBinding(binding: PageDocumentBindingInsert) {
  return {
    pageId: binding.pageId,
    docId: binding.docId,
    lineage: binding.lineage,
    sequence: binding.sequence === null ? null : binding.sequence.toString(),
  };
}