/**
 * The canonical form of an edit command, and the digest taken over it.
 *
 * Two servers must agree on the digest byte for byte, so this rewrites the
 * body rather than echoing it: members in a fixed order, strings escaped the
 * one way, and a number kept as the text it was sent as. `1.0` is not `1`,
 * and `12345678901234567890123` survives no round trip through a float — so
 * nothing here goes through `JSON.parse`.
 */

import { createHash } from 'node:crypto';
import { parseTree, type Node } from 'jsonc-parser';

/** An idempotency key is printable ASCII, and no longer than this. */
const KEY_MAX = 128;

/**
 * `JavaScriptEncoder.Default` keeps printable ASCII bare, except the few it
 * escapes so a value can never close a tag or a string in a page that embeds
 * it. Everything else, non-ASCII included, is escaped.
 */
const ESCAPED_ASCII = new Set(['"', '&', "'", '+', '<', '>', '`', '\\']);
const SHORT_ESCAPES = new Map([
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['\\', '\\\\'],
]);

/** Derives the operation id a key stands for, or null when the key is not one. */
export function operationIdForKey(key: string): string | null {
  if (key.length < 1 || key.length > KEY_MAX) return null;
  for (const unit of key) {
    const code = unit.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return null;
  }
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

/** One UTF-16 unit, so a surrogate pair becomes two escapes. */
function escapeUnit(unit: string): string {
  const short = SHORT_ESCAPES.get(unit);
  if (short !== undefined) return short;
  const code = unit.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e && !ESCAPED_ASCII.has(unit)) return unit;
  return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

const escapeString = (value: string): string =>
  `"${value.split('').map(escapeUnit).join('')}"`;

/** Sorts by UTF-16 code unit, which is what `<` on a JS string already does. */
const byCodeUnit = (a: [string, unknown], b: [string, unknown]): number =>
  a[0] < b[0] ? -1 : Number(a[0] > b[0]);

/** A parsed value that still knows the text a number was written as. */
export type Canonical = { tag: 'raw'; text: string } | { tag: 'string'; value: string }
  | { tag: 'array'; items: Canonical[] } | { tag: 'object'; members: [string, Canonical][] };

export function write(value: Canonical): string {
  switch (value.tag) {
    case 'raw':
      return value.text;
    case 'string':
      return escapeString(value.value);
    case 'array':
      return `[${value.items.map(write).join(',')}]`;
    case 'object':
      return `{${[...value.members]
        .sort(byCodeUnit)
        .map(([name, member]) => `${escapeString(name)}:${write(member)}`)
        .join(',')}}`;
  }
}

/** Reads a node, keeping a number as the source text it was written as. */
function read(node: Node, source: string): Canonical {
  switch (node.type) {
    case 'number':
      return { tag: 'raw', text: source.slice(node.offset, node.offset + node.length) };
    case 'string':
      return { tag: 'string', value: node.value as string };
    case 'boolean':
    case 'null':
      return { tag: 'raw', text: node.type === 'null' ? 'null' : String(node.value) };
    case 'array':
      return { tag: 'array', items: (node.children ?? []).map((child) => read(child, source)) };
    case 'property':
    case 'object':
      return {
        tag: 'object',
        members: (node.children ?? []).flatMap((property) => {
          const [name, member] = property.children ?? [];
          return name === undefined || member === undefined
            ? []
            : [[name.value as string, read(member, source)] as [string, Canonical]];
        }),
      };
    default:
      return { tag: 'raw', text: 'null' };
  }
}

const memberOf = (node: Node, name: string): Node | undefined =>
  node.children?.find((property) => property.children?.[0]?.value === name)?.children?.[1];

/**
 * The members each kind of op carries. An op is rebuilt from these rather than
 * echoed, and anything else is refused rather than dropped: a member the
 * sender believed in must never be silently ignored.
 */
const OP_MEMBERS: Record<string, string[]> = {
  insert: ['id', 'block', 'parent', 'after'],
  update: ['id', 'data'],
  remove: ['id'],
};

/** The members an insert names a place with, which are null when left out. */
const PLACE = ['parent', 'after'];

/** What a block may carry, and what each member must be. */
const BLOCK_TEXT = ['createdBy', 'createdWith', 'lastEditedBy', 'lastEditedWith'];
const BLOCK_NUMBER = ['createdAt', 'lastEditedAt'];
const BLOCK_MEMBERS = ['id', 'type', 'data', 'tunes', ...BLOCK_TEXT, ...BLOCK_NUMBER];

const NOT_JSON = 'collab: the request body is not valid JSON.';
const NOT_UNICODE = 'collab: the request body holds text that is not valid Unicode.';
const NO_OPS = 'collab: the request body must be an object with a non-empty "ops" array.';
const JSON_MAX_DEPTH = 512;

const isText = (node: Node | undefined): boolean =>
  node !== undefined && node.type === 'string' && (node.value as string).length > 0;

/**
 * Reads the body as UTF-8, keeping a byte-order mark so the parser refuses it.
 * A bad byte does not stop the read: the C# reader works through the stream and
 * reports whatever it meets first, so a NUL in an earlier op still wins. `utf8`
 * says whether the bytes were valid, which is the answer when nothing else is.
 */
function decodeBody(body: Uint8Array | string): { text: string; utf8: boolean } {
  if (typeof body === 'string') return { text: body, utf8: true };
  const lenient = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(body);
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    return { text: lenient, utf8: true };
  } catch {
    return { text: lenient, utf8: false };
  }
}

function depthOf(node: Node): number {
  const children = node.type === 'object' || node.type === 'array' || node.type === 'property'
    ? node.children ?? []
    : [];
  const nested = children.map(depthOf);
  return (node.type === 'object' || node.type === 'array' ? 1 : 0) + Math.max(0, ...nested);
}

/**
 * Whether a property NAME holds a byte the decoder could not read. A name is
 * read as its op is parsed, so a bad byte in one is met before that op's NUL --
 * while a bad byte in a value is only reached later, by which time the NUL has
 * already been refused.
 */
function badName(node: Node): boolean {
  const name = node.type === 'property' ? node.children?.[0] : undefined;
  if (name?.type === 'string' && (name.value as string).includes('\uFFFD')) return true;
  return (node.children ?? []).some(badName);
}

/**
 * A surrogate must come as a pair, high then low. A lone one or a reversed
 * pair names no character, so the text is not Unicode whatever it parses as.
 */
function loneSurrogate(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    if (unit < 0xd800 || unit > 0xdbff) continue;
    const next = at + 1 < value.length ? value.charCodeAt(at + 1) : 0;
    if (next < 0xdc00 || next > 0xdfff) return true;
    at += 1;
  }
  return false;
}

/** Any string under a node, name or value. */
function anyString(node: Node, holds: (value: string) => boolean): boolean {
  if (node.type === 'string' && holds(node.value as string)) return true;
  return (node.children ?? []).some((child) => anyString(child, holds));
}

/** A member written twice leaves which one was meant to an implementation. */
function duplicateMember(node: Node): boolean {
  if (node.type === 'object') {
    const names = namesOf(node);
    if (new Set(names).size !== names.length) return true;
  }
  return (node.children ?? []).some(duplicateMember);
}

/** Every string anywhere under a node, so a NUL cannot slip through. */
function holdsNul(node: Node): boolean {
  if (node.type === 'string') return (node.value as string).includes('\u0000');
  return (node.children ?? []).some(holdsNul);
}

/** A JSON value as the applier needs it, with a number back to being a double. */
export type EditValue = string | number | boolean | null | EditValue[] | { [key: string]: EditValue };

/** Places the block after `after` (null = first) under `parent` (null = the root). */
export interface InsertCommand {
  op: 'insert';
  id: string;
  block: Record<string, EditValue>;
  parent: string | null;
  after: string | null;
}

/** Replaces the block's data map wholesale. */
export interface UpdateCommand { op: 'update'; id: string; data: Record<string, EditValue> }

/** Removes the block and everything under it. */
export interface RemoveCommand { op: 'remove'; id: string }

export type EditCommand = InsertCommand | UpdateCommand | RemoveCommand;

/** The value a canonical node stands for. The digest keeps the number's text; nothing else needs it. */
function valueOf(value: Canonical): EditValue {
  switch (value.tag) {
    case 'raw':
      return JSON.parse(value.text) as EditValue;
    case 'string':
      return value.value;
    case 'array':
      return value.items.map(valueOf);
    case 'object':
      return Object.fromEntries(value.members.map(([name, member]) => [name, valueOf(member)]));
  }
}

/** A member that passed `readOp`'s checks, read as the kind the op promised. */
const objectOf = (value: Canonical | undefined): Record<string, EditValue> =>
  value?.tag === 'object' ? (valueOf(value) as Record<string, EditValue>) : {};

const textOf = (value: Canonical | undefined): string | null =>
  value?.tag === 'string' ? value.value : null;

/** The op as values, built from the same members the canonical form is written from. */
function commandOf(kind: string, members: [string, Canonical][]): EditCommand {
  const named = new Map(members);
  const id = textOf(named.get('id')) ?? '';

  if (kind === 'remove') return { op: 'remove', id };
  if (kind === 'update') return { op: 'update', id, data: objectOf(named.get('data')) };

  return {
    op: 'insert',
    id,
    block: objectOf(named.get('block')),
    parent: textOf(named.get('parent')),
    after: textOf(named.get('after')),
  };
}

export type CanonicalEdit = { canonical: string; ops: EditCommand[] } | { error: string };

export function canonicalEdit(body: Uint8Array | string): CanonicalEdit {
  const { text, utf8 } = decodeBody(body);
  const errors: { error: number; offset: number; length: number }[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (root === undefined || errors.length > 0) return { error: utf8 ? NOT_JSON : NOT_UNICODE };
  if (depthOf(root) > JSON_MAX_DEPTH) return { error: NOT_JSON };
  if (duplicateMember(root)) return { error: NOT_JSON };
  if (anyString(root, loneSurrogate)) return { error: NOT_UNICODE };
  if (root.type !== 'object') return { error: NO_OPS };
  const ops = memberOf(root, 'ops');
  if (ops === undefined || ops.type !== 'array' || (ops.children ?? []).length === 0) {
    return { error: NO_OPS };
  }
  const written: Canonical[] = [];
  const commands: EditCommand[] = [];
  for (const [index, op] of (ops.children ?? []).entries()) {
    // Within one op, a name the decoder could not read is met before its NUL;
    // an op further along the array is not reached at all.
    if (!utf8 && badName(op)) return { error: NOT_UNICODE };
    const one = readOp(op, index, text);
    if ('error' in one) return one;
    written.push(one.op);
    commands.push(one.command);
  }
  // Nothing in the ops was wrong, so a bad byte is the only thing left.
  if (!utf8) return { error: NOT_UNICODE };
  return {
    canonical: write({ tag: 'object', members: [['ops', { tag: 'array', items: written }]] }),
    ops: commands,
  };
}

/** The names a node carries, in the order they were written. */
const namesOf = (node: Node): string[] =>
  (node.children ?? []).flatMap((property) => {
    const name = property.children?.[0]?.value;
    return typeof name === 'string' ? [name] : [];
  });

/** Checks a block against what a block may carry. */
function checkBlock(block: Node, id: Node | undefined, say: (what: string) => string): string | undefined {
  if (block.type !== 'object') return say('"block" must be a JSON object.');
  const stray = namesOf(block).find((name) => !BLOCK_MEMBERS.includes(name));
  if (stray !== undefined) return say(`"${stray}" is not part of this op.`);
  if (!isText(memberOf(block, 'type'))) return say('"type" must be a non-empty string.');
  const data = memberOf(block, 'data');
  if (data === undefined || data.type !== 'object') return say('"data" must be a JSON object.');
  const own = memberOf(block, 'id');
  if (own !== undefined && !isText(own)) return say('"id" must be a non-empty string.');
  if (own !== undefined && id !== undefined && own.value !== id.value) {
    return say('the block\'s "id" disagrees with the op\'s.');
  }
  const tunes = memberOf(block, 'tunes');
  if (tunes !== undefined && tunes.type !== 'object') return say('"tunes" must be a JSON object.');
  for (const name of BLOCK_TEXT) {
    const member = memberOf(block, name);
    if (member !== undefined && !isText(member)) return say(`"${name}" must be a non-empty string.`);
  }
  for (const name of BLOCK_NUMBER) {
    const member = memberOf(block, name);
    if (member !== undefined && member.type !== 'number' && member.type !== 'null') {
      return say(`the block's "${name}" must be a number.`);
    }
  }
  return undefined;
}

/** One op, rebuilt from the members its kind carries. */
function readOp(op: Node, index: number, body: string): { op: Canonical; command: EditCommand } | { error: string } {
  const say = (what: string): string => `collab: op ${index}: ${what}`;
  if (op.type !== 'object') return { error: say('an op must be a JSON object.') };
  // Read before anything else about the op: the reader meets it first in the
  // stream, so it is what it complains about first.
  if (holdsNul(op)) {
    return { error: say('a string contains a NUL character, which this endpoint does not accept.') };
  }
  const kind = memberOf(op, 'op');
  if (!isText(kind)) return { error: say('"op" must be a non-empty string.') };
  const members = OP_MEMBERS[kind?.value as string];
  if (members === undefined) {
    return { error: say('"op" must be "insert", "update" or "remove".') };
  }
  const stray = namesOf(op).find((name) => name !== 'op' && !members.includes(name));
  if (stray !== undefined) return { error: say(`"${stray}" is not part of this op.`) };
  const id = memberOf(op, 'id');
  if (!isText(id)) return { error: say('"id" must be a non-empty string.') };
  const data = memberOf(op, 'data');
  if (members.includes('data') && (data === undefined || data.type !== 'object')) {
    return { error: say('"data" must be a JSON object.') };
  }
  for (const name of PLACE) {
    const place = memberOf(op, name);
    if (place !== undefined && place.type !== 'null' && !isText(place)) {
      return { error: say(`"${name}" must be a non-empty string.`) };
    }
  }
  const block = memberOf(op, 'block');
  if (members.includes('block')) {
    const wrong = checkBlock(block ?? { type: 'null', offset: 0, length: 0 }, id, say);
    if (wrong !== undefined) return { error: wrong };
  }
  const entries: [string, Canonical][] = [['op', { tag: 'string', value: kind?.value as string }]];
  for (const name of members) {
    const member = memberOf(op, name);
    if (member !== undefined) entries.push([name, read(member, body)]);
    else if (PLACE.includes(name)) entries.push([name, { tag: 'raw', text: 'null' }]);
  }
  return { op: { tag: 'object', members: entries }, command: commandOf(kind?.value as string, entries) };
}
