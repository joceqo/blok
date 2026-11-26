import { BodyError } from '../http/body.ts';
import type { Headers } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import type { ResponseWriter } from '../http/response.ts';
import type { RouteHandler } from '../route/router.ts';
import { writePlain } from '../route/respond.ts';
import type { HistoryRequest } from '../collab/room/history.ts';
import type { HostAppOptions } from './options.ts';

/** What `historyRequest` answers, as the room hands it back. */
export interface HistoryAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The room side of the history routes: one request, run inside the room's queue. */
export interface CollabRooms {
  history(doc: string, ticket: string, request: HistoryRequest): Promise<HistoryAnswer>;
}

export const IDEMPOTENCY_KEY = 'Blok-Idempotency-Key';

/** Section 12.4's refusals, spelled as the reference host spells them. */
const NO_SUCH_VERSION = 'no such version\n';
const NO_HISTORY = 'history needs a journal that keeps it\n';
const BAD_SEQUENCE = 'the sequence must be a whole number\n';
const BAD_SINCE = 'since must be a whole number no greater than the sequence\n';
const BAD_GROUP = 'group must be 1, 15 or 60\n';
const BAD_TIME = 'time must be an ISO 8601 time with an offset\n';
const BAD_RANGE = 'from and to must be ISO 8601 times with an offset, from no later than to\n';
const BAD_BEFORE = 'before must be one <lineage>:<sequence>\n';
const BAD_DETAIL = 'detail must be properties\n';
const BAD_BLOCK = 'block must be one block id\n';
const BAD_DATABASES = 'databases must be keep or restore\n';
const BAD_KEY = `a valid ${IDEMPOTENCY_KEY} header is required\n`;
const BAD_IF_MATCH = 'If-Match must be one quoted "<lineage>:<sequence>" tag\n';
const KEY_REUSED = 'the idempotency key was already used for a different edit\n';
const STALE_IF_MATCH = 'the document is no longer at the If-Match head\n';
const CURRENT_LINEAGE = 'the document is on this lineage; it cannot be deleted\n';
const UNAVAILABLE = 'the document is unavailable, retry\n';
const UNLOADABLE = 'the document could not be loaded\n';
const UNREADABLE = 'a stored version could not be read\n';
const RESTORE_TOO_LARGE = 'collab: the restore is larger than one update may be.\n';
const FORBIDDEN = 'forbidden\n';

const LINEAGE = /^[0-9a-f]{32}$/;
const DIGITS = /^[0-9]+$/;
const UINT64_MAX = (1n << 64n) - 1n;
/** The at and range routes take the same shape ASP.NET's DateTimeOffset.Parse takes. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)$/;
const BEFORE_POINT = /^[0-9a-f]{32}:(?:0|[1-9][0-9]*)$/;

/** The confirm body a restore may carry, past which nothing is read. */
const MAX_CONFIRM_BYTES = 16384;

/**
 * Query values under one name, matched the way ASP.NET matches them: `&`
 * splits pairs, `;` is data, `+` is a space, a bad escape stays as written,
 * and the name matches ignoring case.
 */
function queryValues(query: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const found: string[] = [];
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.toLowerCase() === wanted) {
      found.push(value);
    }
  }
  return found;
}

/** `ulong.TryParse` reads a value a NUL was appended to; it stops at anything else. */
function wholeNumber(value: string): string | undefined {
  const trimmed = value.replace(/\0+$/, '');
  if (!DIGITS.test(trimmed) || BigInt(trimmed) > UINT64_MAX) {
    return undefined;
  }
  return String(BigInt(trimmed));
}

function single(query: string, name: string): string | undefined | null {
  const values = queryValues(query, name);
  if (values.length === 0) {
    return undefined;
  }
  const [only] = values;
  return values.length === 1 && only !== undefined ? only : null;
}

function headerValues(headers: Headers, name: string): string[] {
  return [...headers.getAll(name)];
}

/** Section 12.1: one printable-ASCII key of 1 to 128 characters, sent once. */
function idempotencyKey(headers: Headers): string | undefined {
  const values = headerValues(headers, IDEMPOTENCY_KEY);
  const key = values.length === 1 ? values[0] ?? '' : '';
  return /^[\x20-\x7e]{1,128}$/.test(key) ? key : undefined;
}

/** Section 12.2: one strong `"<lineage>:<sequence>"` tag, or none at all. */
function ifMatch(headers: Headers): { tag?: string } | undefined {
  const values = headerValues(headers, 'If-Match');
  if (values.length === 0) {
    return {};
  }
  const [tag] = values;
  if (values.length !== 1 || tag === undefined || !/^"[0-9a-f]{32}:(?:0|[1-9][0-9]*)"$/.test(tag)) {
    return undefined;
  }
  return { tag };
}

function acceptsJson(headers: Headers): boolean {
  return (headers.get('accept') ?? '').toLowerCase().includes('application/json');
}

/**
 * The room reads the point out of the path, and `historyRequest` splits that
 * path the way the standalone room host lays it out. The host serves the same
 * routes under its own prefix, so the request it hands down is rewritten onto
 * that layout, with a query holding only what the room reads.
 */
function roomUrl(doc: string, tail: string[], query: Record<string, string | undefined>): URL {
  const url = new URL(`http://host/api/blok/sync/${encodeURIComponent(doc)}`);
  url.pathname = ['/api/blok/sync', encodeURIComponent(doc), ...tail.map(encodeURIComponent)].join('/');
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url;
}

/**
 * Section 12.4 spells a window that was not cut by leaving `truncated` out;
 * the change window builds its envelope with `truncated: false` instead, so
 * the key is dropped here, where the wire shape is decided.
 */
function untruncated(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && (body as { truncated?: unknown }).truncated === false) {
    const rest = { ...(body as Record<string, unknown>) };
    delete rest.truncated;
    return rest;
  }
  return body;
}

async function refuse(request: Request, response: ResponseWriter, status: number, body: string): Promise<void> {
  response.headersMut().set('Cache-Control', 'no-store');
  await writePlain(request, response, status, body);
}

/** Only a page the guard let through as an allowed origin may read these back. */
function expose(response: ResponseWriter, names: string): void {
  if (response.headersMut().contains('Access-Control-Allow-Origin')) {
    response.headersMut().set('Access-Control-Expose-Headers', names);
  }
}

async function writeJson(
  request: Request,
  response: ResponseWriter,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  const out = response.headersMut();
  out.set('Cache-Control', 'no-store');
  out.set('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(headers)) {
    out.set(name, value);
  }
  response.setStatus(status);
  await response.start(status);
  if (request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode(JSON.stringify(body)));
  }
}

async function writeEmpty(
  request: Request,
  response: ResponseWriter,
  status: number,
  headers: Record<string, string> = {},
): Promise<void> {
  const out = response.headersMut();
  out.set('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) {
    out.set(name, value);
  }
  out.set('Content-Length', '0');
  response.setStatus(status);
  await response.start(status);
}

/**
 * What a failure to reach the room means on the wire. A purge is a refusal, a
 * journal another process holds is a retry, and a record that will not decode
 * is this server's own 500 (section 12.4), never a 503 the caller may retry.
 */
export function roomFailure(error: unknown): { status: number; body: string } {
  const name = error instanceof Error ? error.constructor.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'DocumentPurged') {
    return { status: 403, body: FORBIDDEN };
  }
  if (name === 'UnreadableJournalData' || /Inconsistent history|Inconsistent historical journal/.test(message)) {
    return { status: 500, body: UNREADABLE };
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'JOURNAL_BUSY' || /lease|busy|locked/i.test(message)) {
    return { status: 503, body: UNAVAILABLE };
  }
  return { status: 503, body: UNLOADABLE };
}

/** Reads the `confirm` list a restore may send, past which the body is refused. */
async function confirmations(request: Request): Promise<string[] | undefined> {
  const body = request.takeBody();
  if (!body) {
    return [];
  }
  const chunks: Uint8Array[] = [];
  try {
    await body.readToEnd(chunks);
  } catch (error) {
    return error === BodyError.TooLarge ? undefined : [];
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  if (total === 0) {
    return [];
  }
  if (total > MAX_CONFIRM_BYTES) {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  chunks.reduce((at, part) => {
    bytes.set(part, at);
    return at + part.length;
  }, 0);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const confirm = (parsed as { confirm?: unknown } | null)?.confirm;
    return Array.isArray(confirm) ? confirm.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function confirmHeader(headers: Headers): string[] {
  const confirmed: string[] = [];
  for (const value of headers.getAll('X-Blok-Restore-Confirm')) {
    for (const part of value.split(',')) {
      confirmed.push(part.trim());
    }
  }
  return confirmed;
}

/** The pass the room authorizes with; a host without tickets has none to hand it. */
function presentedTicket(options: HostAppOptions, headers: Headers): string {
  if (options.auth !== 'ticket') {
    return '';
  }
  const authorization = headers.get('authorization') ?? '';
  if (/^Bearer /i.test(authorization)) {
    return authorization.slice(7);
  }
  return headers.get('x-blok-ticket') ?? '';
}

export function createCollabHttp(options: HostAppOptions, sync: CollabRooms | undefined) {
  /** Runs one prepared request against the room and writes what it answered. */
  async function run(
    request: Request,
    response: ResponseWriter,
    doc: string,
    prepared: HistoryRequest,
    exposed?: string,
  ): Promise<void> {
    if (sync === undefined) {
      await refuse(request, response, 501, NO_HISTORY);
      return;
    }
    try {
      const answer = await sync.history(doc, presentedTicket(options, request.headers()), prepared);
      await write(request, response, answer, prepared, exposed);
    } catch (error) {
      const failure = roomFailure(error);
      await refuse(request, response, failure.status, failure.body);
    }
  }

  async function write(
    request: Request,
    response: ResponseWriter,
    answer: HistoryAnswer,
    prepared: HistoryRequest,
    exposed?: string,
  ): Promise<void> {
    const headers = answer.headers ?? {};
    const restore = prepared.url.pathname.includes('/restore');
    switch (answer.status) {
      case 200:
        if (exposed !== undefined) {
          expose(response, exposed);
        }
        await writeJson(request, response, 200, untruncated(answer.body), headers);
        return;
      case 204:
        await writeEmpty(request, response, 204, headers);
        return;
      case 302:
        await writeEmpty(request, response, 302, headers);
        return;
      case 403:
        await refuse(request, response, 403, FORBIDDEN);
        return;
      case 400:
        // Every 400 this layer can tell apart was decided before the room ran.
        await refuse(request, response, 400, restore ? BAD_KEY : BAD_SEQUENCE);
        return;
      case 404:
        // The point-at-a-time read answers its own refusal as JSON; every
        // other route names the version the journal never held.
        if (answer.body !== undefined) {
          await writeJson(request, response, 404, answer.body, headers);
          return;
        }
        await refuse(request, response, 404, NO_SUCH_VERSION);
        return;
      case 405:
        await refuse(request, response, 405, NO_SUCH_VERSION);
        return;
      case 409:
        if (answer.body !== undefined && 'X-Blok-Restore-Refusal' in headers) {
          // The room names the refusal `guards`; the wire contract names the
          // thing the caller must do about it.
          const guards = (answer.body as { guards?: unknown }).guards ?? [];
          await writeJson(request, response, 409, { error: 'confirmation_required', guards }, {
            'X-Blok-Restore-Refusal': 'confirmation_required',
          });
          return;
        }
        await refuse(request, response, 409, restore ? KEY_REUSED : CURRENT_LINEAGE);
        return;
      case 412:
        await writeEmpty(request, response, 412, headers);
        return;
      case 413:
        await refuse(request, response, 413, RESTORE_TOO_LARGE);
        return;
      default: {
        const failure = roomFailure(new Error('history failed'));
        await refuse(request, response, answer.status >= 500 ? answer.status : failure.status,
          answer.status === 500 ? UNREADABLE : failure.body);
        return;
      }
    }
  }

  /** GET {prefix}/sync/{doc}/state */
  const state: RouteHandler = async (request, response, values) => {
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['state'], {}),
      method: 'GET',
      confirmed: [],
    }, 'Blok-Doc-Lineage, Blok-Doc-Sequence, ETag');
  };

  /** GET {prefix}/sync/{doc}/history */
  const list: RouteHandler = async (request, response, values) => {
    const query = request.query();
    const group = single(query, 'group');
    if (group === null) {
      await refuse(request, response, 400, BAD_GROUP);
      return;
    }
    const normalized = group === undefined ? undefined : wholeNumber(group);
    if (group !== undefined && (normalized === undefined || !['1', '15', '60'].includes(normalized))) {
      await refuse(request, response, 400, BAD_GROUP);
      return;
    }
    const by = single(query, 'by');
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['history'], {
        group: normalized,
        by: by === 'actor' ? 'actor' : undefined,
      }),
      method: 'GET',
      confirmed: [],
    });
  };

  /** The point in `{lineage}/{sequence}`, or the refusal it earns. */
  function point(values: Record<string, string>): { lineage: string; sequence: string } | string {
    const sequence = wholeNumber(values.sequence ?? '');
    const lineage = values.lineage ?? '';
    if (sequence === undefined) {
      return BAD_SEQUENCE;
    }
    if (!LINEAGE.test(lineage)) {
      return NO_SUCH_VERSION;
    }
    return { lineage, sequence };
  }

  /** The detail and block filters, kept only when the shipped route would read them. */
  function filters(query: string): { detail?: string; block?: string } {
    const detail = single(query, 'detail');
    const block = single(query, 'block');
    return {
      detail: detail === 'properties' ? 'properties' : undefined,
      block: typeof block === 'string' && block !== '' ? block : undefined,
    };
  }

  /** GET {prefix}/sync/{doc}/history/{lineage}/{sequence} */
  const version: RouteHandler = async (request, response, values) => {
    const place = point(values);
    if (typeof place === 'string') {
      await refuse(request, response, place === BAD_SEQUENCE ? 400 : 404, place);
      return;
    }
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['history', place.lineage, place.sequence], {}),
      method: 'GET',
      confirmed: [],
    }, 'Blok-History-Lineage, Blok-History-Sequence');
  };

  /** GET {prefix}/sync/{doc}/history/{lineage}/{sequence}/changes */
  const changes: RouteHandler = async (request, response, values) => {
    const place = point(values);
    if (typeof place === 'string') {
      await refuse(request, response, place === BAD_SEQUENCE ? 400 : 404, place);
      return;
    }
    const query = request.query();
    const raw = single(query, 'since');
    if (raw === null) {
      await refuse(request, response, 400, BAD_SINCE);
      return;
    }
    const since = raw === undefined ? undefined : wholeNumber(raw);
    if (raw !== undefined && (since === undefined || BigInt(since) > BigInt(place.sequence))) {
      await refuse(request, response, 400, BAD_SINCE);
      return;
    }
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['history', place.lineage, place.sequence, 'changes'], {
        since,
        ...filters(query),
      }),
      method: 'GET',
      confirmed: [],
    }, 'Blok-History-Lineage, Blok-History-Sequence');
  };

  /** DELETE {prefix}/sync/{doc}/history/{lineage} */
  const remove: RouteHandler = async (request, response, values) => {
    const lineage = values.lineage ?? '';
    if (!LINEAGE.test(lineage)) {
      await refuse(request, response, 404, NO_SUCH_VERSION);
      return;
    }
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['history', lineage], {}),
      method: 'DELETE',
      confirmed: [],
    });
  };

  /** POST {prefix}/sync/{doc}/history/{lineage}/{sequence}/restore[/preview] */
  function restoreHandler(preview: boolean): RouteHandler {
    return async (request, response, values) => {
      const place = point(values);
      if (typeof place === 'string') {
        await refuse(request, response, place === BAD_SEQUENCE ? 400 : 404, place);
        return;
      }
      const key = preview ? undefined : idempotencyKey(request.headers());
      if (!preview && key === undefined) {
        await refuse(request, response, 400, BAD_KEY);
        return;
      }
      const match = ifMatch(request.headers());
      if (match === undefined) {
        await refuse(request, response, 400, BAD_IF_MATCH);
        return;
      }
      const query = request.query();
      const databases = single(query, 'databases');
      if (databases === null || (typeof databases === 'string' && !['keep', 'restore'].includes(databases))) {
        await refuse(request, response, 400, BAD_DATABASES);
        return;
      }
      const confirmed = confirmHeader(request.headers());
      const body = await confirmations(request);
      if (body === undefined) {
        await refuse(request, response, 413, RESTORE_TOO_LARGE);
        return;
      }
      confirmed.push(...body);
      const tail = ['history', place.lineage, place.sequence, 'restore', ...(preview ? ['preview'] : [])];
      await run(request, response, values.doc ?? '', {
        url: roomUrl(values.doc ?? '', tail, { databases: databases ?? undefined }),
        method: 'POST',
        key,
        match: match.tag,
        confirmed,
      });
    };
  }

  /** GET {prefix}/sync/{doc}/history/at */
  const at: RouteHandler = async (request, response, values) => {
    const query = request.query();
    const time = single(query, 'time');
    if (time === null || time === undefined || !ISO_TIME.test(time)) {
      await refuse(request, response, 400, BAD_TIME);
      return;
    }
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['history', 'at'], { time }),
      method: 'GET',
      asJSON: acceptsJson(request.headers()),
      confirmed: [],
    }, 'Blok-History-Lineage, Blok-History-Sequence');
  };

  /** GET {prefix}/sync/{doc}/history/changes */
  const range: RouteHandler = async (request, response, values) => {
    const query = request.query();
    const from = single(query, 'from');
    const to = single(query, 'to');
    for (const bound of [from, to]) {
      if (bound === null || (typeof bound === 'string' && !ISO_TIME.test(bound))) {
        await refuse(request, response, 400, BAD_RANGE);
        return;
      }
    }
    if (typeof from === 'string' && typeof to === 'string' && Date.parse(from) > Date.parse(to)) {
      await refuse(request, response, 400, BAD_RANGE);
      return;
    }
    const before = single(query, 'before');
    if (before === null || (typeof before === 'string' && !BEFORE_POINT.test(before))) {
      await refuse(request, response, 400, BAD_BEFORE);
      return;
    }
    const detail = single(query, 'detail');
    if (detail === null || (typeof detail === 'string' && detail !== 'properties')) {
      await refuse(request, response, 400, BAD_DETAIL);
      return;
    }
    const block = single(query, 'block');
    if (block === null || block === '') {
      await refuse(request, response, 400, BAD_BLOCK);
      return;
    }
    await run(request, response, values.doc ?? '', {
      url: roomUrl(values.doc ?? '', ['history', 'changes'], {
        from: from ?? undefined,
        to: to ?? undefined,
        before: before ?? undefined,
        detail: detail ?? undefined,
        block: block ?? undefined,
      }),
      method: 'GET',
      confirmed: [],
    });
  };

  /**
   * `at` and `changes` are GET routes, but they sit where a lineage would:
   * a DELETE there is a lineage this journal never held, not a bad method.
   */
  const notAVersion: RouteHandler = async (request, response) => {
    await refuse(request, response, 404, NO_SUCH_VERSION);
  };

  /** The edit route is not served by this host; section 12.4's words fit it too. */
  const unimplemented: RouteHandler = async (request, response) => {
    await refuse(request, response, 501, NO_HISTORY);
  };

  /**
   * A host that keeps no journal knows nothing about lineages, sequences or
   * keys, so it has nothing to refuse them for: section 12.4's 501 comes
   * first, ahead of every check below it.
   */
  function served(handler: RouteHandler): RouteHandler {
    return async (request, response, values) => {
      if (sync === undefined) {
        await refuse(request, response, 501, NO_HISTORY);
        return;
      }
      await handler(request, response, values);
    };
  }

  return {
    state,
    list: served(list),
    version: served(version),
    changes: served(changes),
    remove: served(remove),
    restore: served(restoreHandler(false)),
    preview: served(restoreHandler(true)),
    at: served(at),
    range: served(range),
    notAVersion: served(notAVersion),
    unimplemented,
    STALE_IF_MATCH,
  };
}
