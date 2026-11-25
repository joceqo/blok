import { isDeepStrictEqual } from 'node:util';
import { DocumentStore } from '../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../src/components/modules/yjs/serializer.ts';
import { CURRENT_RICH_TEXT_FIELDS } from '../../src/shared/rich-text/fields.ts';
import { segmentsToHtml } from '../../src/shared/rich-text/segments-to-html.ts';
import { htmlToSegmentsNode } from '../../src/view/rich-text-node.ts';
import { seedUpdate } from '../../packages/server/node/src/collab/room/page-document.ts';
import type { RichText } from '../../types/rich-text';

function compactRuns(input: RichText): RichText {
  // Y.Text joins consecutive runs with identical attributes. Keep embeds,
  // attributes, text and their order intact when comparing representations.
  const result: RichText = [];
  for (const run of input) {
    const prev = result.at(-1);
    if ('text' in run && Object.keys(run).every(k => k === 'text' || k === 'marks')) {
      if (run.text === '' && !run.marks) continue;
      if (prev && 'text' in prev && isDeepStrictEqual(prev.marks, run.marks)) {
        result[result.length - 1] = {...prev, text: prev.text + run.text};
        continue;
      }
    }
    result.push(run);
  }
  return result;
}

export function normalizeLegacyDocument(source: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(source.blocks)) throw new Error('Legacy document has no blocks.');
  const blocks = source.blocks.map(block => {
    if (!block || typeof block.type !== 'string' || typeof block.id !== 'string' || !block.id || !block.data) throw new Error('Invalid legacy block.');
    const data = {...block.data};
    const fields = Object.hasOwn(CURRENT_RICH_TEXT_FIELDS, block.type) ? CURRENT_RICH_TEXT_FIELDS[block.type] : [];
    for (const field of fields) {
      const runs = data[field];
      if (!Array.isArray(runs)) continue;
      const html = segmentsToHtml(runs);
      if (!isDeepStrictEqual(compactRuns(runs), compactRuns(htmlToSegmentsNode(html)))) {
        throw new Error('Cannot import all marks of a legacy rich-text field.');
      }
      data[field] = html;
    }
    return {...block, data};
  });
  const store = new DocumentStore(new YBlockSerializer({htmlToSegments: htmlToSegmentsNode}));
  try {
    store.fromJSON(blocks);
    const order = store.toJSON().map(block => block.id);
    const originals = new Map(blocks.map(block => [block.id, block]));
    if (originals.size !== blocks.length || order.length !== blocks.length || new Set(order).size !== blocks.length ||
        order.some(id => !originals.has(id))) throw new Error('Legacy block identities changed.');
    // A flat disk snapshot may interleave children of different parents.
    // The room writes tree order. Copy the original blocks by ID and check
    // the position of every root; child order lives in each parent's content.
    const ordered = order.map(id => originals.get(id)!);
    const roots = (list: typeof blocks) => list.filter(b => !b.parent).map(b => b.id);
    if (!isDeepStrictEqual(roots(blocks), roots(ordered))) throw new Error('Legacy root order changed.');
    const converted = {...source, blocks: ordered};
    seedUpdate(converted); // also rejects broken links, changed fields and unsupported metadata
    return converted;
  } finally { store.destroy(); }
}
