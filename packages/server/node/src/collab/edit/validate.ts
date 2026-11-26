/**
 * The refusal pass POST /edit runs before anything is written.
 *
 * `applyEditOps` writes what it can and refuses nothing, so an `insert`
 * naming an id the document already holds silently overwrites that block.
 * The Go and C# planners refuse such an op instead, and refuse it for the
 * WHOLE request: a bad op at index 1 means index 0 is never written either.
 * This pass is that planner's judgment without its writes — it answers the
 * message of the first op that could not be carried out, so the caller can
 * refuse the request before `applyEditOps` touches a document.
 *
 * Like the planner, it keeps a picture of the document and moves it along as
 * it reads: a later op sees what the earlier ops of the same request did, so
 * an insert may place a block under a parent the request itself inserted, and
 * an op naming a block the request removed is refused.
 *
 * `parentId` is the arbiter of membership, as it is on export and in
 * `applyEditOps`; `contentIds` is the order a child sits in under its parent,
 * and the root array is that order at the top level. A block the blocks map
 * holds as something other than a map is in the document but is not a block:
 * reading it as one is what the planner refuses rather than risk mid-write.
 */

import { Array as YArray, Map as YMap } from 'yjs';
import { DocumentStore } from '../../../../../../src/components/modules/yjs/document-store.ts';
import { CURRENT_RICH_TEXT_FIELDS } from '../../../../../../src/shared/rich-text/fields.ts';
import type { EditCommand, EditValue, InsertCommand, RemoveCommand, UpdateCommand } from './canonical.ts';

/** The deepest a data value may nest, as `MaxValueDepth` in the Go converter. */
const DEPTH_MAX = 256;

/** The most HTML characters one edit may send in one rich field, as `MaxEditHTMLChars`. */
const HTML_MAX = 32768;

/** The planner's own guards speak about a document; the caller learns which op. */
type Say = (what: string) => string;

/**
 * The document as the pass reads it, and as it moves along.
 * - `parents` holds EVERY key of the blocks map, junk included, so "already
 *   there" and "no such block" both answer from it.
 * - `contents` tells a block with an empty children list from one carrying no
 *   list at all, which is the difference between an insert that is placed and
 *   one that is refused.
 * - `order` keeps a slot that is not an id as `null`: it is not a block, but
 *   it still counts towards the index an insert lands at.
 */
interface Picture {
  parents: Map<string, string | null>;
  notBlocks: Set<string>;
  contents: Map<string, string[] | null>;
  order: (string | null)[];
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The ids a block lists as its children, or null when it carries no list. */
function childIdsOf(block: YMap<unknown>): string[] | null {
  const listed: unknown = block.get('contentIds');

  if (!(listed instanceof YArray)) return null;

  return (listed.toArray() as unknown[]).filter((id): id is string => typeof id === 'string');
}

function readBlock(picture: Picture, id: string, entry: unknown): void {
  if (!(entry instanceof YMap)) {
    picture.notBlocks.add(id);
    picture.parents.set(id, null);

    return;
  }
  picture.parents.set(id, textOrNull(entry.get('parentId')));
  picture.contents.set(id, childIdsOf(entry));
}

function pictureOf(store: DocumentStore): Picture {
  const picture: Picture = {
    parents: new Map(),
    notBlocks: new Set(),
    contents: new Map(),
    order: (store.rootOrder.toArray() as unknown[]).map(textOrNull),
  };

  for (const id of store.blocksMap.keys()) readBlock(picture, id, store.blocksMap.get(id));

  return picture;
}

/** How a message names the place a block was to go under. */
const childOf = (parent: string | null): string =>
  parent === null ? 'the document root' : `"${parent}"`;

const asObject = (value: EditValue | undefined): Record<string, EditValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

const deepest = (values: EditValue[]): number =>
  // Annotated: 0 is itself an EditValue, so inference picks the overload that
  // carries the element type through and the accumulator stops being a number.
  values.reduce<number>((most, value) => Math.max(most, nestingOf(value)), 0);

/** How many containers deep a value goes; a leaf is none. */
function nestingOf(value: EditValue): number {
  if (Array.isArray(value)) return 1 + deepest(value);
  if (value !== null && typeof value === 'object') return 1 + deepest(Object.values(value));

  return 0;
}

/**
 * A data map's values are written one level inside the map, so the first
 * container of a value sits at depth 1 and the guard bites at `DEPTH_MAX + 1`.
 * The converter's own message already says "collab:", and the op's index is
 * put in front of it as the planner does — hence the doubled word.
 */
function depthRefusal(data: Record<string, EditValue>, say: Say): string | undefined {
  if (deepest(Object.values(data)) <= DEPTH_MAX) return undefined;

  return say(`collab: a data value is nested deeper than ${DEPTH_MAX} levels.`);
}

const parentOf = (picture: Picture, id: string): string | null => picture.parents.get(id) ?? null;

/** What refuses an insert under a named parent: the parent, then the place in it. */
function underRefusal(picture: Picture, parent: string, after: string | null, say: Say): string | undefined {
  if (picture.notBlocks.has(parent)) return say(`"${parent}" is in the document but is not a block.`);
  const siblings = picture.contents.get(parent) ?? null;

  if (siblings === null) {
    return say(`block "${parent}" has no children list, so nothing can be placed under it.`);
  }
  if (after !== null && !siblings.includes(after)) {
    return say(`block "${after}" is not in the document order, so nothing can be placed after it.`);
  }

  return undefined;
}

/** What refuses the place an insert names, whether at the root or under a block. */
function placeRefusal(picture: Picture, op: InsertCommand, say: Say): string | undefined {
  const { parent, after } = op;

  if (parent !== null && !picture.parents.has(parent)) {
    return say(`there is no block "${parent}" to insert under.`);
  }
  if (after !== null && !picture.parents.has(after)) {
    return say(`there is no block "${after}" to insert after.`);
  }
  if (after !== null && parentOf(picture, after) !== parent) {
    return say(`block "${after}" is not a child of ${childOf(parent)}.`);
  }
  if (parent === null) return undefined;

  return underRefusal(picture, parent, after, say);
}

/**
 * A root block the root array does not list: its `parentId` says the root, so
 * the place is well named, and yet there is no index to insert after.
 */
function rootOrderRefusal(picture: Picture, op: InsertCommand, say: Say): string | undefined {
  if (op.parent !== null || op.after === null) return undefined;
  if (picture.order.includes(op.after)) return undefined;

  return say(`block "${op.after}" is not in the document order, so nothing can be placed after it.`);
}

/** Where the block lands among its siblings: after `after`, or first. */
const indexAfter = (siblings: readonly (string | null)[], after: string | null): number =>
  after === null ? 0 : siblings.indexOf(after) + 1;

function recordInsert(picture: Picture, op: InsertCommand): void {
  picture.parents.set(op.id, op.parent);
  picture.contents.set(op.id, []);
  const siblings = op.parent === null ? null : picture.contents.get(op.parent) ?? null;

  if (siblings === null) picture.order.splice(indexAfter(picture.order, op.after), 0, op.id);
  else siblings.splice(indexAfter(siblings, op.after), 0, op.id);
}

function insertRefusal(picture: Picture, op: InsertCommand, say: Say): string | undefined {
  if (picture.parents.has(op.id)) return say(`the document already has a block "${op.id}".`);
  const placed = placeRefusal(picture, op, say);

  if (placed !== undefined) return placed;
  // The planner builds the block before it reaches the root order, so a value
  // too deep to write is what it answers first.
  const deep = depthRefusal(asObject(op.block.data), say);

  if (deep !== undefined) return deep;

  return rootOrderRefusal(picture, op, say);
}

function checkInsert(picture: Picture, op: InsertCommand, say: Say): string | undefined {
  const refusal = insertRefusal(picture, op, say);

  if (refusal !== undefined) return refusal;
  recordInsert(picture, op);

  return undefined;
}

function checkUpdate(picture: Picture, op: UpdateCommand, say: Say): string | undefined {
  if (!picture.parents.has(op.id)) return say(`there is no block "${op.id}" to update.`);
  if (picture.notBlocks.has(op.id)) return say(`"${op.id}" is in the document but is not a block.`);

  return depthRefusal(op.data, say);
}

/** Every block under `id`, following `parentId` — as `applyEditOps` removes them. */
function subtreeOf(picture: Picture, id: string): string[] {
  const children = new Map<string, string[]>();

  picture.parents.forEach((parent, child) => {
    if (parent === null) return;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  });
  const doomed = [id];
  const seen = new Set(doomed);

  // The array grows while it is walked, so a child's children are reached too.
  for (const next of doomed) {
    const kept = (children.get(next) ?? []).filter((child) => !seen.has(child));

    kept.forEach((child) => seen.add(child));
    doomed.push(...kept);
  }

  return doomed;
}

function unlist(listed: string[] | null, gone: string): void {
  const at = listed === null ? -1 : listed.indexOf(gone);

  if (listed === null || at < 0) return;
  listed.splice(at, 1);
}

function forget(picture: Picture, gone: string): void {
  picture.parents.delete(gone);
  picture.notBlocks.delete(gone);
  picture.contents.delete(gone);
  picture.order = picture.order.filter((slot) => slot !== gone);
  picture.contents.forEach((listed) => unlist(listed, gone));
}

function checkRemove(picture: Picture, op: RemoveCommand, say: Say): string | undefined {
  if (!picture.parents.has(op.id)) return say(`there is no block "${op.id}" to remove.`);
  subtreeOf(picture, op.id).forEach((gone) => forget(picture, gone));

  return undefined;
}

function checkOne(picture: Picture, op: EditCommand, index: number): string | undefined {
  const say: Say = (what) => `collab: op ${index}: ${what}`;

  if (op.op === 'insert') return checkInsert(picture, op, say);
  if (op.op === 'remove') return checkRemove(picture, op, say);

  return checkUpdate(picture, op, say);
}

/**
 * Judges a whole request before any of it is written.
 * @param store - the document the ops would be applied to
 * @param ops - the canonical ops, in the order the request sent them
 * @returns the message of the first op that cannot be carried out, or
 * `undefined` when every op is applicable
 */
export function validateEditOps(store: DocumentStore, ops: readonly EditCommand[]): string | undefined {
  const picture = pictureOf(store);

  for (const [index, op] of ops.entries()) {
    const refusal = checkOne(picture, op, index);

    if (refusal !== undefined) return refusal;
  }

  return undefined;
}

/** The block's rich fields, from the table the server-side serializer reads. */
const richFieldsOf = (type: string): readonly string[] =>
  Object.hasOwn(CURRENT_RICH_TEXT_FIELDS, type) ? CURRENT_RICH_TEXT_FIELDS[type] ?? [] : [];

/**
 * The first rich field of one block whose HTML is past the cap. A value that
 * is already segments carries no HTML, so only a string is counted, and it is
 * counted in UTF-16 units — what `len` reads off the Go converter's string.
 */
function oversizedField(type: string, data: Record<string, EditValue>): string | undefined {
  for (const field of richFieldsOf(type)) {
    const html = data[field];

    if (typeof html !== 'string' || html.length <= HTML_MAX) continue;

    return `collab: rich text field "${type}.${field}" holds ${html.length} ` +
      `HTML characters; an edit may send at most ${HTML_MAX}.`;
  }

  return undefined;
}

/** The type each block will be once the request's own inserts are counted. */
function typesOf(store: DocumentStore, ops: readonly EditCommand[]): Map<string, string> {
  const types = new Map<string, string>();

  for (const id of store.blocksMap.keys()) {
    const entry: unknown = store.blocksMap.get(id);
    const type: unknown = entry instanceof YMap ? entry.get('type') : undefined;

    if (typeof type === 'string') types.set(id, type);
  }
  for (const op of ops) {
    if (op.op !== 'insert') continue;
    if (typeof op.block.type === 'string') types.set(op.id, op.block.type);
  }

  return types;
}

/**
 * Judges the HTML a whole request sends, AFTER `validateEditOps` has passed
 * it: the Go converter plans the request first and only then measures what the
 * plan collected, so a structural refusal on any op beats an oversized field
 * on any other. The door answers this one refusal with 413, never 422.
 * @param store - the document the ops would be applied to
 * @param ops - the canonical ops, in the order the request sent them
 * @returns the message of the first field past the cap, or `undefined`
 */
export function richTextCapRefusal(store: DocumentStore, ops: readonly EditCommand[]): string | undefined {
  const types = typesOf(store, ops);

  for (const op of ops) {
    if (op.op === 'remove') continue;
    const type = types.get(op.id);

    if (type === undefined) continue;
    const refusal = oversizedField(type, op.op === 'insert' ? asObject(op.block.data) : op.data);

    if (refusal !== undefined) return refusal;
  }

  return undefined;
}
