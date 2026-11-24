import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { WorkspaceNotFoundError } from '../errors.ts';
import { PermissionDeniedError } from '../permissions.ts';

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
  console.error('[service-node]', error);
  return context.json({ error: message }, 500 as ContentfulStatusCode);
}