/**
 * The validation pass, against the capture C# took of its own edit endpoint.
 *
 * Every case the fixture marks `refused` carries the exact message the other
 * servers answer with, and that message is the specification: this file reads
 * it, never writes it. A case whose refusal belongs to an op only the agent
 * sends (`move`, `retype`, `setPageField`...) is out of this file's scope,
 * because `canonicalEdit` reads no such op.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../../src/components/modules/yjs/serializer.ts';
import { htmlToSegmentsNode } from '../../../../../../src/view/rich-text-node.ts';
import { canonicalEdit, type EditCommand } from './canonical.ts';
import { richTextCapRefusal, validateEditOps } from './validate.ts';

interface EditCase {
  name: string;
  seedUpdate: string;
  body?: string;
  export?: unknown;
  refused?: { kind: string; message: string };
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

const endpointBody = (entry: EditCase): boolean =>
  entry.agent === undefined && typeof entry.body === 'string' &&
  (JSON.parse(entry.body) as { ops: { op: string }[] }).ops
    .every((op) => ENDPOINT_OPS.includes(op.op));

/** A document this file cannot seed on its own is nobody's refusal to judge. */
const seedable = (entry: EditCase): boolean =>
  entry.peerUpdate === undefined && entry.prior === undefined && entry.page === undefined;

const REFUSED = fixture.cases.filter((entry) =>
  entry.refused !== undefined && seedable(entry) && endpointBody(entry));

const ACCEPTED = fixture.cases.filter((entry) =>
  entry.refused === undefined && entry.export !== undefined && seedable(entry) && endpointBody(entry));

const newStore = (): DocumentStore =>
  new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));

/** The ops of a request body, which the canonical parser is the only reader of. */
function opsOf(body: string): EditCommand[] {
  const parsed = canonicalEdit(body);

  if ('error' in parsed) throw new Error(parsed.error);

  return parsed.ops;
}

/** The case's document, as the capture left it — shape writes included. */
function seeded(entry: EditCase): DocumentStore {
  const store = newStore();

  store.applyRemoteUpdate(Uint8Array.from(Buffer.from(entry.seedUpdate, 'base64')));

  return store;
}

/** What the pass answers for one captured case. */
function answerFor(entry: EditCase): string | undefined {
  const store = seeded(entry);

  try {
    return validateEditOps(store, opsOf(entry.body ?? ''));
  } finally {
    store.destroy();
  }
}

/** What the pass answers for ops against a document holding `blocks`. */
function answerOn(blocks: unknown[], body: string): string | undefined {
  const store = newStore();

  try {
    store.fromJSON(blocks as never);

    return validateEditOps(store, opsOf(body));
  } finally {
    store.destroy();
  }
}

/** What the HTML cap pass answers for ops against a document holding `blocks`. */
function capOn(blocks: unknown[], body: string): string | undefined {
  const store = newStore();

  try {
    store.fromJSON(blocks as never);

    return richTextCapRefusal(store, opsOf(body));
  } finally {
    store.destroy();
  }
}

const paragraph = (id: string): unknown => ({ id, type: 'paragraph', data: { text: id } });

/** A body inserting one paragraph whose text is `length` characters of HTML. */
const inserting = (length: number): string => JSON.stringify({
  ops: [{ op: 'insert', id: 'big', block: { type: 'paragraph', data: { text: 'x'.repeat(length) } } }],
});

it('answers every captured refusal with the message the other servers send', () => {
  const expected = Object.fromEntries(REFUSED.map((entry) => [entry.name, entry.refused?.message]));
  const answered = Object.fromEntries(REFUSED.map((entry) => [entry.name, answerFor(entry)]));

  expect(answered).toEqual(expected);
  expect(REFUSED.length).toBeGreaterThanOrEqual(13);
});

it('refuses nothing the other servers applied', () => {
  const refused = ACCEPTED.flatMap((entry) => {
    const answer = answerFor(entry);

    return answer === undefined ? [] : [`${entry.name}: ${answer}`];
  });

  expect(refused).toEqual([]);
  expect(ACCEPTED.length).toBeGreaterThan(40);
});

it('refuses an insert carrying the id of a block the document already holds', () => {
  const body = '{"ops":[{"op":"insert","id":"root","block":{"type":"header","data":{}}}]}';

  expect(answerOn([paragraph('root')], body))
    .toBe('collab: op 0: the document already has a block "root".');
});

it('lets a later op see the block an earlier one inserted', () => {
  const body = '{"ops":[{"op":"insert","id":"new","after":"root","block":{"type":"paragraph","data":{}}},' +
    '{"op":"update","id":"new","data":{"text":"x"}},{"op":"remove","id":"new"}]}';

  expect(answerOn([paragraph('root')], body)).toBeUndefined();
});

it('refuses a second insert of the id a first one took in the same request', () => {
  const body = '{"ops":[{"op":"insert","id":"a","block":{"type":"paragraph","data":{}}},' +
    '{"op":"insert","id":"a","block":{"type":"paragraph","data":{}}}]}';

  expect(answerOn([paragraph('root')], body))
    .toBe('collab: op 1: the document already has a block "a".');
});

it('refuses an op naming a block an earlier op removed, children included', () => {
  const blocks = [
    { id: 'tg', type: 'toggle', data: { text: 't' }, content: ['kid'] },
    { id: 'kid', type: 'paragraph', data: { text: 'k' }, parent: 'tg' },
  ];
  const body = '{"ops":[{"op":"remove","id":"tg"},{"op":"update","id":"kid","data":{}}]}';

  expect(answerOn(blocks, body)).toBe('collab: op 1: there is no block "kid" to update.');
});

it('accepts an insert placed under a parent the same request inserted', () => {
  const body = '{"ops":[{"op":"insert","id":"tg","block":{"type":"toggle","data":{}}},' +
    '{"op":"insert","id":"kid","parent":"tg","block":{"type":"paragraph","data":{}}},' +
    '{"op":"insert","id":"kin","parent":"tg","after":"kid","block":{"type":"paragraph","data":{}}}]}';

  expect(answerOn([paragraph('root')], body)).toBeUndefined();
});

it('refuses an insert placed after a block that is not a child of the named parent', () => {
  const blocks = [
    { id: 'tg', type: 'toggle', data: { text: 't' }, content: ['kid'] },
    { id: 'kid', type: 'paragraph', data: { text: 'k' }, parent: 'tg' },
    paragraph('root'),
  ];
  const body = '{"ops":[{"op":"insert","id":"new","parent":"tg","after":"root",' +
    '"block":{"type":"paragraph","data":{}}}]}';

  expect(answerOn(blocks, body)).toBe('collab: op 0: block "root" is not a child of "tg".');
});

it('refuses a rich text field past the HTML cap, naming the field and both counts', () => {
  expect(capOn([paragraph('root')], inserting(32769)))
    .toBe('collab: rich text field "paragraph.text" holds 32769 HTML characters; an edit may send at most 32768.');
});

it('takes a rich text field at the HTML cap', () => {
  expect(capOn([paragraph('root')], inserting(32768))).toBeUndefined();
});

it('reads an updated block\'s type from the document, and leaves a field that is not rich alone', () => {
  const blocks = [{ id: 'pic', type: 'image', data: { caption: 'c' } }, paragraph('p')];
  const oversized = JSON.stringify({ ops: [{ op: 'update', id: 'p', data: { text: 'x'.repeat(32769) } }] });

  expect(capOn(blocks, oversized))
    .toBe('collab: rich text field "paragraph.text" holds 32769 HTML characters; an edit may send at most 32768.');
  expect(capOn(blocks, JSON.stringify({ ops: [{ op: 'update', id: 'pic', data: { caption: 'x'.repeat(32769) } }] })))
    .toBeUndefined();
});

it('reads the type an earlier op of the same request gave the block', () => {
  const body = JSON.stringify({
    ops: [
      { op: 'insert', id: 'h', block: { type: 'header', data: {} } },
      { op: 'update', id: 'h', data: { text: 'x'.repeat(32769) } },
    ],
  });

  expect(capOn([paragraph('root')], body))
    .toBe('collab: rich text field "header.text" holds 32769 HTML characters; an edit may send at most 32768.');
});
