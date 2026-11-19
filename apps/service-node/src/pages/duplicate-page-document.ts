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
 * Limitation: doc_id (and lineage/sequence) are copied as-is — the duplicate does not
 * receive its own collaboration document yet; both pages reference the same doc.
 */
export function duplicatePageDocumentBinding(
  source: PageDocumentBindingSource | undefined,
  newPageId: string,
): PageDocumentBindingInsert | undefined {
  if (source === undefined) {
    return undefined;
  }
  return {
    pageId: newPageId,
    docId: source.docId,
    lineage: source.lineage,
    sequence: source.sequence,
  };
}