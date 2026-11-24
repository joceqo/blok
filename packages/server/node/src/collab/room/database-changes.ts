import { deepEqual } from '../../../../../../src/shared/deep-equal.ts';

type JsonObject = Record<string, unknown>;
type Action = 'created' | 'updated' | 'deleted';
interface EntryChange {
  id: string;
  name?: string;
  action: Action;
}
interface CellChange {
  id: string;
  before?: unknown;
  after?: unknown;
}

const maxEntries = 500;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function changesToCells(before: unknown, after: unknown): CellChange[] {
  const old = isObject(before) ? before : {};
  const current = isObject(after) ? after : {};
  const changes: CellChange[] = [];
  for (const [id, value] of Object.entries(current)) {
    if (!Object.hasOwn(old, id)) changes.push({ id, after: value });
    else if (!deepEqual(old[id], value)) changes.push({ id, before: old[id], after: value });
  }
  for (const [id, value] of Object.entries(old)) {
    if (!Object.hasOwn(current, id)) changes.push({ id, before: value });
  }
  return changes;
}

function entriesById(entries: unknown[]) {
  const result = new Map<string, JsonObject>();
  for (const entry of entries) {
    if (isObject(entry) && typeof entry.id === 'string' && !result.has(entry.id)) result.set(entry.id, entry);
  }
  return result;
}

function changesToEntries(before: unknown, after: unknown, includeName: boolean): EntryChange[] {
  const left = Array.isArray(before) ? before : [];
  const right = Array.isArray(after) ? after : [];
  if (left.length > maxEntries || right.length > maxEntries) return [];

  const old = entriesById(left);
  const current = entriesById(right);
  const changes: EntryChange[] = [];
  function add(id: string, entry: JsonObject, action: Action) {
    changes.push({ id, ...(includeName && typeof entry.name === 'string' && { name: entry.name }), action });
  }
  for (const [id, entry] of current) {
    const previous = old.get(id);
    if (!previous) add(id, entry, 'created');
    else if (!deepEqual(previous, entry)) add(id, entry, 'updated');
  }
  for (const [id, entry] of old) {
    if (!current.has(id)) add(id, entry, 'deleted');
  }
  return changes;
}

export function databaseChangeDetails(
  type: string | null,
  before: { data?: unknown } | null,
  after: { data?: unknown } | null,
) {
  if (!before || !after) return {};
  const left = isObject(before.data) ? before.data : {};
  const right = isObject(after.data) ? after.data : {};
  if (type === 'database-row') {
    const properties = changesToCells(left.properties, right.properties);
    return properties.length ? { properties } : {};
  }
  if (type === 'database') {
    const schema = changesToEntries(left.schema, right.schema, true);
    const views = changesToEntries(left.views, right.views, false);
    return { ...(schema.length > 0 && { schema }), ...(views.length > 0 && { views }) };
  }
  return {};
}

// Version changes ignore malformed optional filters for older Blok clients.
// Time-range changes use the same parser but refuse malformed filters.
export function changeQuery(query: URLSearchParams) {
  const detail: string[] = [];
  const block: string[] = [];
  for (const [key, value] of query) {
    if (key.toLowerCase() === 'detail') detail.push(value);
    if (key.toLowerCase() === 'block') block.push(value);
  }
  const properties = detail.length === 1 && detail[0] === 'properties';
  const blockId = block.length === 1 && block[0] ? block[0] : undefined;
  return {
    properties,
    blockId,
    valid: (detail.length === 0 || properties) && (block.length === 0 || !!blockId),
  };
}
