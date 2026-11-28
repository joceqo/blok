import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { WorkspaceNotFoundError } from '../errors.ts';
import { PermissionDeniedError } from '../permissions.ts';
import { requestIdOf } from './observe.ts';

export function onError(error: Error, context: Context): Response {
  if (error instanceof WorkspaceNotFoundError) {
    return context.json({ error: 'not_found' }, 404);
  }
  if (error instanceof PermissionDeniedError) {
    return context.json(
      { error: 'permission_denied', action: error.action },
      403,
    );
  }

  const message = error instanceof Error ? error.message : 'internal_error';
  // Carries the identifier observeMiddleware gave the request, so this line and
  // the request line it produced can be read as one event.
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'request failed',
      method: context.req.method,
      path: context.req.path,
      request: requestIdOf(context),
      cause: message,
      stack: error.stack ?? '',
    }),
  );
  return context.json({ error: message }, 500 as ContentfulStatusCode);
}
