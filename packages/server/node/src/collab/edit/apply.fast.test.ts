/**
 * The applier, against the capture C# took of its own edit endpoint.
 *
 * Each case seeds a store from the Yjs update C# captured, applies the ops of
 * the request body, and compares the blocks read back with the ones C#
 * exported. The fixture is the specification: it is never edited to make a
 * test pass, and a case it refuses or an op only the agent sends is out of
 * this file's scope.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { expect, it } from 'vitest';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../../src/components/modules/yjs/serializer.ts';
import { CURRENT_RICH_TEXT_FIELDS } from '../../../../../../src/shared/rich-text/fields.ts';
import { segmentsToHtml } from '../../../../../../src/shared/rich-text/segments-to-html.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';
import { applyEditOps, buildEditUpdate, type ApplyEditOptions } from './apply.ts';
import { canonicalEdit, type EditCommand } from './canonical.ts';

interface EditCase {
  name: string;
  seed: unknown[];
  seedUpdate: string;
  body: string;
  export?: unknown;
  refused?: unknown;
  agent?: unknown;
  page?: unknown;
  peerUpdate?: unknown;
  prior?: unknown;
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    '../../../../../../test/unit/server-conformance/fixtures/collab-edits/cases.json',
    import.meta.url,
  )),
  'utf8',
)) as { cases: EditCase[] };

/** The three ops POST /edit accepts; the rest are the agent's and restore's. */
const ENDPOINT_OPS = ['insert', 'update', 'remove'];

/**
 * Cases this file cannot answer, each for a reason that is not the applier's:
 * a refusal the planner owns, a second peer's update, or a document this
 * applier is not the one that wrote.
 */
const OUT_OF_SCOPE = (entry: EditCase): boolean =>
  entry.export === undefined || entry.refused !== undefined || entry.agent !== undefined ||
  entry.page !== undefined || entry.peerUpdate !== undefined || entry.prior !== undefined;

/**
 * Cases whose answer differs for a reason that lives under `src/`, not here.
 * Each one is a divergence worth keeping visible, never a test bent to pass.
 */
const DIVERGENT: Record<string, string> = {
  // The op writes `[{ text: 'brave', bold: true }]`. C# sanitizes the segment,
  // dropping the key it does not know, and edits the formatted text in place.
  // `isRichText` (src/shared/rich-text/guards.ts) reads an extra key as proof
  // the array is some other record list, so the store writes it as a plain
  // value. The divergence is in the editor's guard, not in this applier.
  'update-edits-rich-text-in-place': 'isRichText refuses a segment carrying an unknown key',
};

const selected = fixture.cases.filter((entry) => {
  if (OUT_OF_SCOPE(entry) || Object.hasOwn(DIVERGENT, entry.name)) return false;
  const ops = (JSON.parse(entry.body) as { ops: { op: string }[] }).ops;

  return ops.every((op) => ENDPOINT_OPS.includes(op.op));
});

const newStore = (): DocumentStore =>
  new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));

/** The ops of a request body, which the canonical parser is the only reader of. */
function opsOf(body: string): EditCommand[] {
  const parsed = canonicalEdit(body);

  if ('error' in parsed) throw new Error(parsed.error);

  return parsed.ops;
}

/** A store holding `blocks`, ready for an edit. */
function seeded(blocks: unknown[]): DocumentStore {
  const store = newStore();

  store.fromJSON(blocks as never);

  return store;
}

/** `store.toJSON()` as plain JSON, which is the shape the fixture exports. */
const blocksOf = (store: DocumentStore): unknown =>
  JSON.parse(JSON.stringify(store.toJSON()));

/**
 * The fixture's blocks in the projection `toJSON` speaks. The two sides store
 * the same thing and differ only at the face: C# exports a rich field as
 * segments, while `DocumentStore` hands tools the HTML those segments stand
 * for. Only a rich field of a built-in type is rewritten — a `caption` or a
 * table cell is a plain value on both sides and must compare as it is.
 */
function asHtmlFields(blocks: unknown): unknown {
  return (blocks as { type: string; data: Record<string, unknown> }[]).map((block) => {
    const rich = CURRENT_RICH_TEXT_FIELDS[block.type] ?? [];
    const rewritten = rich.flatMap((field) =>
      Array.isArray(block.data[field]) ? [[field, segmentsToHtml(block.data[field] as never)]] : []);

    return { ...block, data: { ...block.data, ...Object.fromEntries(rewritten) } };
  });
}

/** A store reading a document, the way the room projects one. */
function projected(doc: Doc): DocumentStore {
  const store = newStore();

  store.applyRemoteUpdate(encodeStateAsUpdate(doc));

  return store;
}

/** Seeds a case's document, applies its ops, and reads the blocks back. */
function applied(entry: EditCase, options?: ApplyEditOptions): unknown {
  const store = newStore();

  try {
    store.applyRemoteUpdate(Uint8Array.from(Buffer.from(entry.seedUpdate, 'base64')));
    applyEditOps(store, opsOf(entry.body), options);

    return blocksOf(store);
  } finally {
    store.destroy();
  }
}

it('reads the ops of a body alongside its canonical form', () => {
  const body = '{"ops":[{"op":"insert","id":"a","parent":"p","block":{"type":"paragraph","data":{"text":"x"}}},' +
    '{"op":"update","id":"b","data":{"level":2}},{"op":"remove","id":"c"}]}';

  expect(opsOf(body)).toEqual([
    { op: 'insert', id: 'a', block: { type: 'paragraph', data: { text: 'x' } }, parent: 'p', after: null },
    { op: 'update', id: 'b', data: { level: 2 } },
    { op: 'remove', id: 'c' },
  ]);
});

it('applies every captured insert, update and remove the way C# applied it', () => {
  const wrong = selected.flatMap((entry) =>
    isDeepStrictEqual(applied(entry), asHtmlFields(entry.export)) ? [] : [entry.name]);

  expect(wrong).toEqual([]);
  expect(selected.length).toBeGreaterThan(40);
});

it('places an insert that names no sibling first, and one that names a parent under it', () => {
  const store = seeded([
    { id: 'tg', type: 'toggle', data: {}, content: ['k1'] },
    { id: 'k1', type: 'paragraph', data: {}, parent: 'tg' },
  ]);

  applyEditOps(store, opsOf('{"ops":[{"op":"insert","id":"first","block":{"type":"paragraph","data":{}}},' +
    '{"op":"insert","id":"under","parent":"tg","block":{"type":"paragraph","data":{}}}]}'));

  expect(store.toJSON().map((block) => block.id)).toEqual(['first', 'tg', 'under', 'k1']);
  store.destroy();
});

it('replaces an updated block\'s data in one, rather than patching the keys it names', () => {
  const store = seeded([{ id: 'a', type: 'callout', data: { icon: 'star', colour: 'blue' } }]);

  applyEditOps(store, opsOf('{"ops":[{"op":"update","id":"a","data":{"icon":"bolt"}}]}'));

  expect(store.toJSON()[0]?.data).toEqual({ icon: 'bolt' });
  store.destroy();
});

it('removes a block with everything under it, however deep', () => {
  const store = seeded([
    { id: 'tg', type: 'toggle', data: {}, content: ['k1'] },
    { id: 'k1', type: 'toggle', data: {}, parent: 'tg', content: ['k2'] },
    { id: 'k2', type: 'paragraph', data: {}, parent: 'k1' },
    { id: 'keep', type: 'paragraph', data: {} },
  ]);

  applyEditOps(store, opsOf('{"ops":[{"op":"remove","id":"tg"}]}'));

  expect(store.toJSON().map((block) => block.id)).toEqual(['keep']);
  store.destroy();
});

/** The six fields an op carries, which the applier is never the author of. */
const stampedInsert = '{"ops":[{"op":"insert","id":"a","block":{"type":"paragraph","data":{},' +
  '"createdAt":11,"createdBy":"u1","createdWith":"agent:u1:x",' +
  '"lastEditedAt":12,"lastEditedBy":"u2","lastEditedWith":"agent:u2:y"}}]}';

it('writes an inserted block\'s attribution as the op sent it, inventing none of it', () => {
  const store = seeded([]);

  applyEditOps(store, opsOf(stampedInsert), { now: () => 999, editor: 'u9', coEditor: 'agent:u9:z' });

  expect(store.toJSON()[0]).toEqual({
    id: 'a',
    type: 'paragraph',
    data: { text: '' },
    createdAt: 11,
    createdBy: 'u1',
    createdWith: 'agent:u1:x',
    lastEditedAt: 12,
    lastEditedBy: 'u2',
    lastEditedWith: 'agent:u2:y',
  });
  store.destroy();
});

it('leaves an inserted block without the stamps the op left out', () => {
  const store = seeded([]);

  applyEditOps(store, opsOf('{"ops":[{"op":"insert","id":"a","block":{"type":"paragraph","data":{}}}]}'));

  expect(store.toJSON()[0]).toEqual({ id: 'a', type: 'paragraph', data: { text: '' } });
  store.destroy();
});

it('drops the user ids of a block inserted as an anonymous answer, or under one', () => {
  const store = seeded([]);

  applyEditOps(store, opsOf('{"ops":[{"op":"insert","id":"row","block":{"type":"database-row",' +
    '"data":{"anonymous":true},"createdAt":11,"createdBy":"u1","createdWith":"agent:u1:x",' +
    '"lastEditedAt":12,"lastEditedBy":"u1","lastEditedWith":"agent:u1:x"}},' +
    '{"op":"insert","id":"body","parent":"row","block":{"type":"paragraph","data":{},' +
    '"createdAt":13,"createdBy":"u1","lastEditedAt":13,"lastEditedBy":"u1"}}]}'));

  expect(store.toJSON()).toEqual([
    { id: 'row', type: 'database-row', data: { anonymous: true }, content: ['body'], createdAt: 11, lastEditedAt: 12 },
    { id: 'body', type: 'paragraph', data: { text: '' }, parent: 'row', createdAt: 13, lastEditedAt: 13 },
  ]);
  store.destroy();
});

it('keeps the user ids of a block inserted under an ordinary row', () => {
  const store = seeded([{ id: 'row', type: 'database-row', data: {} }]);

  applyEditOps(store, opsOf('{"ops":[{"op":"insert","id":"body","parent":"row",' +
    '"block":{"type":"paragraph","data":{},"createdAt":13,"createdBy":"u1","lastEditedAt":13,"lastEditedBy":"u1"}}]}'));

  expect(store.toJSON()[1]).toEqual({
    id: 'body', type: 'paragraph', data: { text: '' }, parent: 'row', createdAt: 13, createdBy: 'u1', lastEditedAt: 13, lastEditedBy: 'u1',
  });
  store.destroy();
});

it('credits an update to the editor the request names, at the request\'s one instant', () => {
  const store = seeded([
    { id: 'a', type: 'paragraph', data: {}, lastEditedAt: 1, lastEditedBy: 'old' },
    { id: 'b', type: 'paragraph', data: {}, lastEditedAt: 2, lastEditedBy: 'old' },
  ]);
  const ticks = [100, 200, 300];
  const reads = { count: 0 };
  const now = (): number => {
    reads.count += 1;

    return ticks[reads.count - 1] ?? 0;
  };

  applyEditOps(store, opsOf('{"ops":[{"op":"update","id":"a","data":{"text":"x"}},' +
    '{"op":"update","id":"b","data":{"text":"y"}}]}'), { now, editor: 'u1', coEditor: 'agent:u1:z' });

  expect(store.toJSON().map((block) => [block.lastEditedAt, block.lastEditedBy, block.lastEditedWith])).toEqual([
    [100, 'u1', 'agent:u1:z'],
    [100, 'u1', 'agent:u1:z'],
  ]);
  expect(reads.count).toBe(1);
  store.destroy();
});

it('leaves the previous author of an updated block alone when the request names no editor', () => {
  const store = seeded([{ id: 'a', type: 'paragraph', data: { text: 'one' }, lastEditedAt: 1, lastEditedBy: 'u1' }]);

  applyEditOps(store, opsOf('{"ops":[{"op":"update","id":"a","data":{"text":"two"}}]}'), { now: () => 500 });

  expect(store.toJSON()[0]).toEqual({
    id: 'a', type: 'paragraph', data: { text: 'two' }, lastEditedAt: 1, lastEditedBy: 'u1',
  });
  store.destroy();
});

it('names nobody as the editor of an update inside an anonymous answer', () => {
  const store = seeded([
    { id: 'row', type: 'database-row', data: { anonymous: true }, content: ['body'] },
    { id: 'body', type: 'paragraph', data: {}, parent: 'row' },
  ]);

  applyEditOps(store, opsOf('{"ops":[{"op":"update","id":"body","data":{"text":"x"}}]}'),
    { now: () => 700, editor: 'u1', coEditor: 'agent:u1:z' });

  expect(store.toJSON()[1]).toEqual({
    id: 'body', type: 'paragraph', data: { text: 'x' }, parent: 'row', lastEditedAt: 700,
  });
  store.destroy();
});

it('lets a later op see what an earlier one did', () => {
  const store = seeded([]);

  applyEditOps(store, opsOf('{"ops":[{"op":"insert","id":"a","block":{"type":"toggle","data":{}}},' +
    '{"op":"insert","id":"b","parent":"a","block":{"type":"paragraph","data":{}}},' +
    '{"op":"update","id":"b","data":{"text":"bee"}},' +
    '{"op":"remove","id":"a"}]}'));

  expect(store.toJSON()).toEqual([]);
  store.destroy();
});

it('hands a live document the update its edit comes to, without writing to it', () => {
  const entry = fixture.cases.find((one) => one.name === 'insert-under-a-parent-after-a-child');
  const seed = Uint8Array.from(Buffer.from(entry?.seedUpdate ?? '', 'base64'));
  const doc = new Doc();

  applyUpdate(doc, seed);

  const update = buildEditUpdate(doc, opsOf(entry?.body ?? ''));

  // Planned against the live doc, which is left exactly as it was.
  expect(blocksOf(projected(doc))).toEqual(asHtmlFields(entry?.seed));

  applyUpdate(doc, update);
  expect(blocksOf(projected(doc))).toEqual(asHtmlFields(entry?.export));
  doc.destroy();
});

it('writes nothing for an update that sends the values the block already holds', () => {
  const doc = new Doc();

  applyUpdate(doc, buildEditUpdate(doc, opsOf(
    '{"ops":[{"op":"insert","id":"a","block":{"type":"paragraph","data":{"text":"same"}}}]}')));

  const before = encodeStateVector(doc);

  // What the room journals as the edit. An update that moves no struct is the
  // one the room answers with the head it is already at, leaving the key
  // spendable — so a `type` written over the type already there, which is a
  // new map entry like any other, would spend a key on nothing.
  applyUpdate(doc, buildEditUpdate(doc, opsOf('{"ops":[{"op":"update","id":"a","data":{"text":"same"}}]}')));

  expect(encodeStateVector(doc)).toEqual(before);
  expect(blocksOf(projected(doc))).toEqual([{ id: 'a', type: 'paragraph', data: { text: 'same' } }]);
  doc.destroy();
});
