import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { PermissionDeniedError } from '../permissions.js';

export function onError(error: Error, context: Context): Response {
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