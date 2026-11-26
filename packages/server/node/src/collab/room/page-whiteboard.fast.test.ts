import { Doc, applyUpdate } from 'yjs';
import { expect, it } from 'vitest';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../../src/components/modules/yjs/serializer.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';
import { exportPage, restorePage, seedUpdate } from './page-document.ts';

// Storage contract for a page-bound board. Both editors start on an ordinary page
// that predates the board, then place their first object independently offline.
it('merges board edits and restores the source note, shape and attached arrow on the original page', () => {
  const paragraph = { id: 'brief', type: 'paragraph', data: { text: 'Brief' } };
  const original = { blocks: [paragraph] };
  const seed = seedUpdate(original);
  const alice = new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));
  const bob = new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));
  const room = new Doc();
  const reopened = new Doc();
  try {
    alice.applyRemoteUpdate(seed);
    bob.applyRemoteUpdate(seed);
    const source = { id: 'source-a', type: 'whiteboardElement', data: { kind: 'document', x: 12, y: 24, w: 560, h: 220 } };
    const shape = { id: 'shape-b', type: 'whiteboardElement', data: { kind: 'rectangle', x: 720, y: 64, w: 152, h: 96 } };
    alice.addBlock(source);
    bob.addBlock(shape);
    bob.updateBlockData('brief', 'text', 'Brief révisé');

    const a = alice.encodeStateAsUpdate();
    const b = bob.encodeStateAsUpdate();
    alice.applyRemoteUpdate(b);
    bob.applyRemoteUpdate(a);
    expect(alice.toJSON()).toEqual(bob.toJSON());
    // One peer connects the two visible objects while the other drags the shape.
    // The source note's projection id stays independent of its geometry block id.
    const arrow = { id: 'arrow-a', type: 'whiteboardElement', data: {
      kind: 'arrow', x: 572, y: 112, w: 148, h: 22, points: [[0, 22], [148, 0]], from: 'page-note', to: shape.id,
    } };
    alice.addBlock(arrow);
    bob.updateBlockData(shape.id, 'x', 860);
    bob.updateBlockData(shape.id, 'y', 104);
    const connected = alice.encodeStateAsUpdate();
    const moved = bob.encodeStateAsUpdate();
    alice.applyRemoteUpdate(moved);
    bob.applyRemoteUpdate(connected);
    expect(alice.toJSON()).toEqual(bob.toJSON());

    applyUpdate(room, moved);
    applyUpdate(room, connected);
    const snapshot = exportPage(room, {});
    expect(snapshot.blocks).toHaveLength(4);
    expect(snapshot.blocks).toEqual(expect.arrayContaining([
      { ...paragraph, data: { text: 'Brief révisé' } }, source,
      { ...shape, data: { ...shape.data, x: 860, y: 104 } }, arrow,
    ]));

    applyUpdate(reopened, seedUpdate(snapshot));
    expect(exportPage(reopened, {})).toEqual(snapshot);
    applyUpdate(reopened, restorePage(reopened, original));
    expect(exportPage(reopened, {})).toEqual(original);
    applyUpdate(reopened, restorePage(reopened, snapshot));
    expect(exportPage(reopened, {})).toEqual(snapshot);
  } finally {
    alice.destroy();
    bob.destroy();
    room.destroy();
    reopened.destroy();
  }
});

it('merges card placement with an independent paragraph edit using the shell format', () => {
  const original = { blocks: [{ id: 'brief', type: 'paragraph', data: { text: 'Brief' } }] };
  const seed = seedUpdate(original);
  const board = new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));
  const editor = new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));
  const room = new Doc();
  try {
    board.applyRemoteUpdate(seed);
    editor.applyRemoteUpdate(seed);
    board.updateBlockTune('brief', 'whiteboardPlacement', true);
    editor.updateBlockData('brief', 'text', 'Brief révisé');
    applyUpdate(room, editor.encodeStateAsUpdate());
    applyUpdate(room, board.encodeStateAsUpdate());
    expect(exportPage(room, {}).blocks).toEqual([{
      id: 'brief', type: 'paragraph', data: { text: 'Brief révisé' }, tunes: { whiteboardPlacement: true },
    }]);
    applyUpdate(room, restorePage(room, original));
    expect(exportPage(room, {})).toEqual(original);
  } finally {
    board.destroy();
    editor.destroy();
    room.destroy();
  }
});
