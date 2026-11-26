/**
 * A local workspace keeps its pages as JSON files. Moving it onto the
 * collaboration path means those files get loaded into a Yjs document — and the
 * fear is that two documents built independently from the same file no longer
 * share a history, so merging them would duplicate every block instead of
 * reconciling it.
 *
 * These hold what actually happens, because the answer decides whether the file
 * format has to change at all.
 *
 * Scope: `updateBlockData` writes a value. Authored text is a `Y.Text`
 * (`serializer.ts`), where concurrent typing merges per character — that is a
 * different path from the scalar write exercised here.
 */
import { describe, expect, it } from 'vitest';

import { DocumentStore } from '../../../src/components/modules/yjs/document-store';
import { YBlockSerializer } from '../../../src/components/modules/yjs/serializer';

const storeFrom = (blocks: Array<{ id: string; type: string; data: Record<string, unknown> }>): DocumentStore => {
  const store = new DocumentStore(new YBlockSerializer());

  store.fromJSON(blocks);

  return store;
};

const textsOf = (store: DocumentStore): Array<{ id: string; text: string | undefined }> =>
  store.toJSON().map((block) => ({ id: block.id ?? '', text: (block.data as { text?: string }).text }));

const PAGE = [{ id: 'b1', type: 'paragraph', data: { text: 'the page as it sits in the file' } }];

describe('a page loaded into Yjs from its file', () => {
  it('merges two documents built separately from the same file, without duplicating a block', () => {
    const windowDoc = storeFrom(PAGE);
    const agentDoc = storeFrom(PAGE);

    windowDoc.addBlock({ id: 'typed', type: 'paragraph', data: { text: 'what the person wrote' } });
    agentDoc.addBlock({ id: 'added', type: 'paragraph', data: { text: 'what the agent wrote' } });

    const merged = storeFrom([]);

    merged.applyRemoteUpdate(windowDoc.encodeStateAsUpdate());
    merged.applyRemoteUpdate(agentDoc.encodeStateAsUpdate());

    expect([...merged.orderedIds()].sort()).toEqual(['added', 'b1', 'typed']);
    expect(merged.toJSON().filter((block) => block.id === 'b1')).toHaveLength(1);
  });

  it('settles a value written on both sides on one winner, the same one whatever the order', () => {
    const windowDoc = storeFrom(PAGE);
    const agentDoc = storeFrom(PAGE);

    windowDoc.updateBlockData('b1', 'text', 'edited by the person');
    agentDoc.updateBlockData('b1', 'text', 'edited by the agent');

    const merged = storeFrom([]);

    merged.applyRemoteUpdate(windowDoc.encodeStateAsUpdate());
    merged.applyRemoteUpdate(agentDoc.encodeStateAsUpdate());

    const reversed = storeFrom([]);

    reversed.applyRemoteUpdate(agentDoc.encodeStateAsUpdate());
    reversed.applyRemoteUpdate(windowDoc.encodeStateAsUpdate());

    // Convergence, not arbitration: both orders land on the same text, and the
    // losing write is gone. A host that needs both must not send a bare value.
    expect(merged.toJSON()).toHaveLength(1);
    expect(textsOf(merged)).toEqual(textsOf(reversed));
    expect(textsOf(merged)[0]?.text).toMatch(/^edited by the (person|agent)$/);
  });

  it('keeps two clones of one shared state converging', () => {
    const original = storeFrom(PAGE);
    const bytes = original.encodeStateAsUpdate();
    const first = storeFrom([]);
    const second = storeFrom([]);

    first.applyRemoteUpdate(bytes);
    second.applyRemoteUpdate(bytes);
    first.addBlock({ id: 'from-first', type: 'paragraph', data: { text: 'first' } });
    second.addBlock({ id: 'from-second', type: 'paragraph', data: { text: 'second' } });

    const merged = storeFrom([]);

    merged.applyRemoteUpdate(first.encodeStateAsUpdate());
    merged.applyRemoteUpdate(second.encodeStateAsUpdate());

    expect([...merged.orderedIds()].sort()).toEqual(['b1', 'from-first', 'from-second']);
  });
});
