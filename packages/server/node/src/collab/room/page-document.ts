import { isDeepStrictEqual } from 'node:util';
import { Doc, encodeStateAsUpdate } from 'yjs';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../../src/components/modules/yjs/serializer.ts';
import { readPageFields } from '../../../../../../src/components/modules/yjs/page-fields.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';

export type Snapshot = Record<string, unknown> | null;
const core = new Set(['blocks','title','icon','cover']);
export function envelope(data: Snapshot): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !core.has(key)));
}
function store() { return new DocumentStore(new YBlockSerializer({htmlToSegments:htmlToSegmentsNode})); }
function output(s: DocumentStore, extra: Record<string, unknown>) {
  return JSON.parse(JSON.stringify({...extra,blocks:s.toJSON(),...readPageFields(s.page)})) as Record<string,unknown>;
}

// Use the editor's format-2 serializer in both directions. Refuse to seed
// data which it would silently normalize away, including missing block IDs.
export function seedUpdate(data: Snapshot): Uint8Array {
  const s = store();
  try {
    if (data !== null) {
      if (!Array.isArray(data.blocks)) throw new Error('Page must contain a blocks array');
      s.fromJSON(data.blocks);
      s.pageFromJSON(data);
      if (!isDeepStrictEqual(output(s,envelope(data)),data)) throw new Error('Page cannot round-trip through the format-2 schema without loss');
    }
    return s.encodeStateAsUpdate();
  } finally { s.destroy(); }
}

export function exportPage(doc: Doc, extra: Record<string,unknown>): Record<string,unknown> {
  for (const key of doc.share.keys()) {
    if (!['blocks','root','page','values'].includes(key)) throw new Error('Unprojectable Yjs root: '+key);
  }
  const s = store();
  try {
    s.applyRemoteUpdate(encodeStateAsUpdate(doc));
    if (s.values.size) throw new Error('A page projection cannot represent host-owned history values');
    for (const key of s.page.keys()) if (!['title','icon','cover'].includes(key)) throw new Error('Unprojectable page field: '+key);
    const result = output(s,extra);
    if (!Array.isArray(result.blocks) || result.blocks.length !== s.blocksMap.size) throw new Error('Unprojectable block structure');
    const visiblePageFields = readPageFields(s.page);
    if (!isDeepStrictEqual(s.page.toJSON(),JSON.parse(JSON.stringify(visiblePageFields)))) throw new Error('Unprojectable page metadata');
    return result;
  } finally { s.destroy(); }
}
