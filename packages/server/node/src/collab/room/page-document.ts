import { isDeepStrictEqual } from 'node:util';
import { Doc, encodeStateVector, encodeStateAsUpdate } from 'yjs';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../../src/components/modules/yjs/serializer.ts';
import { readPageFields } from '../../../../../../src/components/modules/yjs/page-fields.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';

export type Snapshot = Record<string, unknown> | null;
const core = new Set(['blocks', 'title', 'icon', 'cover']);
export function envelope(data: Snapshot): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !core.has(key)));
}
function store() {
  return new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));
}
function requireJson(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return;
  if (Array.isArray(value)) {
    value.forEach(requireJson);
    return;
  }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    Object.values(value).forEach(requireJson);
    return;
  }
  throw new Error('Unrepresentable page value');
}
function output(s: DocumentStore, extra: Record<string, unknown>): Record<string, unknown> {
  const data = { ...extra, blocks: s.toJSON(), ...readPageFields(s.page) };
  requireJson(data);
  return JSON.parse(JSON.stringify(data));
}
const blockKeys = new Set([
  'id',
  'type',
  'data',
  'tunes',
  'parentId',
  'contentIds',
  'createdAt',
  'createdBy',
  'createdWith',
  'lastEditedAt',
  'lastEditedBy',
  'lastEditedWith',
]);

// Use the editor's format-2 serializer in both directions. Refuse to seed
// data which it would silently normalize away, including missing block IDs.
export function seedUpdate(data: Snapshot): Uint8Array {
  const s = store();
  try {
    if (data !== null) {
      if (!Array.isArray(data.blocks)) throw new Error('Page must contain a blocks array');
      s.fromJSON(data.blocks);
      s.pageFromJSON(data);
      if (!isDeepStrictEqual(output(s, envelope(data)), data))
        throw new Error('Page cannot round-trip through the format-2 schema without loss');
    }
    return s.encodeStateAsUpdate();
  } finally {
    s.destroy();
  }
}

export function exportPage(doc: Doc, extra: Record<string, unknown>): Record<string, unknown> {
  for (const key of doc.share.keys()) {
    if (!['blocks', 'root', 'page', 'values'].includes(key))
      throw new Error('Unprojectable Yjs root: ' + key);
  }
  const s = store();
  try {
    s.applyRemoteUpdate(encodeStateAsUpdate(doc));
    if (s.values.size) throw new Error('A page projection cannot represent host-owned history values');
    for (const key of s.page.keys())
      if (!['title', 'icon', 'cover'].includes(key)) throw new Error('Unprojectable page field: ' + key);
    for (const [id, block] of s.blocksMap) {
      if (!block || typeof block.keys !== 'function' || block.get('id') !== id)
        throw new Error('Unprojectable block ID');
      for (const key of block.keys())
        if (!blockKeys.has(key)) throw new Error('Unprojectable block field: ' + key);
    }
    const result = output(s, extra);
    if (!Array.isArray(result.blocks) || result.blocks.length !== s.blocksMap.size)
      throw new Error('Unprojectable block structure');
    const visiblePageFields = readPageFields(s.page);
    if (!isDeepStrictEqual(s.page.toJSON(), JSON.parse(JSON.stringify(visiblePageFields))))
      throw new Error('Unprojectable page metadata');
    return result;
  } finally {
    s.destroy();
  }
}

/** Derive a CRDT operation on the current document, retaining the IDs of blocks that survive. */
export function restorePage(doc: Doc, data: Record<string,unknown>): Uint8Array {
  const s = store();
  try {
    if (!Array.isArray(data.blocks)) throw new Error('Invalid historical blocks');
    s.applyRemoteUpdate(encodeStateAsUpdate(doc));
    s.fromJSON(data.blocks);
    s.pageFromJSON(data);
    if (!isDeepStrictEqual(output(s,envelope(data)),data)) throw new Error('Restore changed the target projection');
    return s.encodeStateAsUpdate(encodeStateVector(doc));
  } finally { s.destroy(); }
}
