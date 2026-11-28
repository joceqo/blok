import { randomBytes } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string | undefined;
  }
}

// What a refusal contributes to one line. The bodies this host refuses with are
// short; a handler that streams must not put its stream in the journal, and
// this journal lands on the SD card the production machine boots from.
const CAUSE_LIMIT = 256;

// Where an answered request becomes worth keeping on its own. Below it the
// request is ordinary and nobody will ever read the line.
const SLOW_REQUEST_MS = 2000;

export interface ObserveLine {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly request: string;
  readonly cause: string;
}

export interface ObserveOptions {
  readonly log?: (line: ObserveLine) => void;
  readonly now?: () => number;
}

// Names one request across the lines it produces. Random rather than
// sequential: a counter would leak how much this instance serves.
export function newRequestId(): string {
  return randomBytes(16).toString('hex');
}

export function requestIdOf(context: Context): string {
  return context.get('requestId') ?? '';
}

function writeLine(line: ObserveLine): void {
  const rendered = JSON.stringify(line);
  if (line.level === 'error') {
    console.error(rendered);
  } else {
    console.warn(rendered);
  }
}

/*
A refusal body carries the reason a status code cannot; an answered one is
either empty of interest or a stream nobody wants in the journal.

Read through a clone, so the body still reaches the client, and stop at the
limit rather than draining it: a handler is free to refuse with a stream, and
reading one to its end would hold the whole thing in memory for a log line.
*/
async function causeOf(response: Response): Promise<string> {
  if (response.status < 400 || response.body === null || response.bodyUsed) {
    return '';
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
  } catch {
    return '';
  }
  if (reader === undefined) {
    return '';
  }

  const decoder = new TextDecoder();
  let cause = '';
  try {
    while (cause.length < CAUSE_LIMIT) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      cause += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return '';
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  return cause.slice(0, CAUSE_LIMIT).trim();
}

/**
 * Writes one line for a request that was refused or that took too long, and
 * nothing for the rest. Keeping every answered request would be a line per page
 * view on a host whose journal lands on an SD card.
 */
export function observeMiddleware(options: ObserveOptions = {}): MiddlewareHandler {
  const log = options.log ?? writeLine;
  const now = options.now ?? Date.now;

  return createMiddleware(async (context, next) => {
    const started = now();
    const id = newRequestId();
    context.set('requestId', id);
    // Set before the handler runs so the identifier survives a throw: onError
    // builds its response from this same context's prepared headers.
    context.header('X-Request-Id', id);

    await next();
    context.res.headers.set('X-Request-Id', id);

    const ms = now() - started;
    const status = context.res.status;
    if (status < 400 && ms < SLOW_REQUEST_MS) {
      return;
    }

    log({
      level: status >= 500 ? 'error' : 'warn',
      message: status >= 400 ? 'request refused' : 'request slow',
      method: context.req.method,
      path: context.req.path,
      status,
      ms,
      request: id,
      cause: await causeOf(context.res),
    });
  });
}
