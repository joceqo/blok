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
type Canonical = { tag: 'raw'; text: string } | { tag: 'string'; value: string }
  | { tag: 'array'; items: Canonical[] } | { tag: 'object'; members: [string, Canonical][] };

function write(value: Canonical): string {
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
 * echoed, so an unknown member cannot reach the digest.
 */
const OP_MEMBERS: Record<string, string[]> = {
  insert: ['id', 'block', 'parent', 'after'],
  update: ['id', 'data'],
  remove: ['id'],
};

/** The members an insert names a place with, which are null when left out. */
const PLACE = ['parent', 'after'];

export type CanonicalEdit = { canonical: string } | { error: string };

export function canonicalEdit(body: string): CanonicalEdit {
  const errors: { error: number; offset: number; length: number }[] = [];
  const root = parseTree(body, errors, { allowTrailingComma: false, disallowComments: true });
  if (root === undefined || errors.length > 0 || root.type !== 'object') {
    return { error: 'collab: the request body is not valid JSON.' };
  }
  const ops = memberOf(root, 'ops');
  if (ops === undefined || ops.type !== 'array') {
    return { error: 'collab: "ops" must be a JSON array.' };
  }
  const written: Canonical[] = [];
  for (const [index, op] of (ops.children ?? []).entries()) {
    const one = readOp(op, index, body);
    if ('error' in one) return one;
    written.push(one.op);
  }
  return { canonical: write({ tag: 'object', members: [['ops', { tag: 'array', items: written }]] }) };
}

/** One op, rebuilt from the members its kind carries. */
function readOp(op: Node, index: number, body: string): { op: Canonical } | { error: string } {
  if (op.type !== 'object') return { error: `collab: op ${index} must be a JSON object.` };
  const kind = memberOf(op, 'op');
  if (kind === undefined || kind.type !== 'string') {
    return { error: `collab: op ${index}: "op" must be a non-empty string.` };
  }
  const members = OP_MEMBERS[kind.value as string];
  if (members === undefined) {
    return { error: `collab: op ${index}: unknown operation "${String(kind.value)}".` };
  }
  const entries: [string, Canonical][] = [['op', { tag: 'string', value: kind.value as string }]];
  for (const name of members) {
    const member = memberOf(op, name);
    const missingPlace = member === undefined && PLACE.includes(name);
    if (member !== undefined) entries.push([name, read(member, body)]);
    else if (missingPlace) entries.push([name, { tag: 'raw', text: 'null' }]);
  }
  return { op: { tag: 'object', members: entries } };
}
