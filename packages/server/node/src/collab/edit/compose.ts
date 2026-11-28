/**
 * The canonical form of ops built in memory, which is the way back in: a
 * request body is rewritten by `canonicalEdit`, while the agent's ops are born
 * as values and are written from them.
 *
 * The digest is stored in the journal and compared across servers, so these
 * bytes must be the ones C# and Go write: members sorted by UTF-16 unit, the
 * writer's escaping, and every number written as .NET writes a double — a JS
 * number carries no text of its own to keep.
 */

import { createHash } from 'node:crypto';
import { write, type Canonical } from './canonical.ts';
import { formatDouble } from './dotnet-double.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Places the block, keeping its map. A missing end is the start of the root. */
export interface Move { op: 'move'; id: string; after?: string | null; parent?: string | null }

/** Moves the block's children into its slot, right after it. */
export interface Lift { op: 'lift'; id: string }

/** Sets the type and replaces the data. */
export interface Retype { op: 'retype'; id: string; type: string; data: JsonValue }

/** Writes each named tune; a null deletes it. */
export interface SetTunes { op: 'setTunes'; id: string; tunes: JsonValue }

/** Writes who last touched the block, and when. */
export interface SetMetadata {
  op: 'setMetadata';
  id: string;
  lastEditedAt: number;
  lastEditedBy: string;
  lastEditedWith?: string | null;
}

/** Writes the page title or icon; a null deletes it. Names no block. */
export interface SetPageField { op: 'setPageField'; key: string; value: JsonValue }

export type AgentOp = Move | Lift | Retype | SetTunes | SetMetadata | SetPageField;

/**
 * A map patch is in the union to be refused: restore builds one, and restore
 * never digests its ops, so it has no canonical form to write.
 */
export type EditOp = AgentOp | { op: 'patchMaps' };

const NO_PATCH_CANONICAL =
  'collab: a map patch comes only from restore, which never digests its ops';

const NULL: Canonical = { tag: 'raw', text: 'null' };

const text = (value: string): Canonical => ({ tag: 'string', value });

/** An end of a move: written `null` when the op does not name one. */
const place = (value: string | null | undefined): Canonical =>
  value === undefined || value === null ? NULL : text(value);

/** A value built in memory, where a number is a double and nothing else. */
function valueOf(value: JsonValue): Canonical {
  if (value === null) return NULL;
  if (typeof value === 'string') return text(value);
  if (typeof value === 'number') return { tag: 'raw', text: formatDouble(value) };
  if (typeof value === 'boolean') return { tag: 'raw', text: String(value) };
  if (Array.isArray(value)) return { tag: 'array', items: value.map(valueOf) };
  return {
    tag: 'object',
    members: Object.entries(value).map(([name, member]) => [name, valueOf(member)]),
  };
}

/** The members an op carries. `write` sorts them, so the order here is free. */
function membersOf(op: EditOp): [string, Canonical][] {
  switch (op.op) {
    case 'move':
      return [['op', text('move')], ['id', text(op.id)],
        ['after', place(op.after)], ['parent', place(op.parent)]];
    case 'lift':
      return [['op', text('lift')], ['id', text(op.id)]];
    case 'retype':
      return [['op', text('retype')], ['id', text(op.id)],
        ['type', text(op.type)], ['data', valueOf(op.data)]];
    case 'setTunes':
      return [['op', text('setTunes')], ['id', text(op.id)], ['tunes', valueOf(op.tunes)]];
    case 'setMetadata':
      return [['op', text('setMetadata')], ['id', text(op.id)],
        ['lastEditedAt', { tag: 'raw', text: formatDouble(op.lastEditedAt) }],
        ['lastEditedBy', text(op.lastEditedBy)],
        // Asymmetric with a move's ends on purpose: a tool nobody named is
        // left out of the body, not written `null` in it.
        ...withTool(op.lastEditedWith)];
    case 'setPageField':
      return [['op', text('setPageField')], ['key', text(op.key)], ['value', valueOf(op.value)]];
    case 'patchMaps':
      throw new Error(NO_PATCH_CANONICAL);
  }
}

const withTool = (value: string | null | undefined): [string, Canonical][] =>
  value === undefined || value === null ? [] : [['lastEditedWith', text(value)]];

/** Stable JSON for ops built in memory, written the way Utf8JsonWriter writes it. */
export function canonicalBody(ops: EditOp[]): string {
  const written = ops.map((op): Canonical => ({ tag: 'object', members: membersOf(op) }));
  return write({ tag: 'object', members: [['ops', { tag: 'array', items: written }]] });
}

/** The SHA-256 of the canonical body's UTF-8 bytes, as lower-case hex. */
export const canonicalBodyDigest = (ops: EditOp[]): string =>
  createHash('sha256').update(canonicalBody(ops), 'utf8').digest('hex');
