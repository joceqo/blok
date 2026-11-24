import { generatePageDocId } from './generate-page-doc-id.js';

export type PageDocumentPostBody = {
  docId?: string;
  lineage?: string | null;
  sequence?: string | number | null;
};

export type ResolvedPageDocumentPostBind =
  | { ok: true; docId: string; lineage: string | null; sequence: bigint | null }
  | { ok: false; error: 'invalid_doc_id' | 'invalid_sequence' };

function parseSequence(value: string | number): bigint | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

export function resolvePageDocumentPostBind(
  body: PageDocumentPostBody,
  mintDocId: () => string = generatePageDocId,
): ResolvedPageDocumentPostBind {
  const docIdOmitted = body.docId === undefined;

  let docId: string;
  if (docIdOmitted) {
    docId = mintDocId();
  } else if (typeof body.docId === 'string') {
    docId = body.docId.trim();
    if (docId.length === 0) {
      return { ok: false, error: 'invalid_doc_id' };
    }
  } else {
    return { ok: false, error: 'invalid_doc_id' };
  }

  if (docIdOmitted) {
    return { ok: true, docId, lineage: null, sequence: 0n };
  }

  const lineage = typeof body.lineage === 'string' ? body.lineage : null;
  const sequence =
    body.sequence === null || body.sequence === undefined
      ? null
      : (parseSequence(body.sequence) ?? null);

  if (body.sequence !== undefined && body.sequence !== null && sequence === null) {
    return { ok: false, error: 'invalid_sequence' };
  }

  return { ok: true, docId, lineage, sequence };
}