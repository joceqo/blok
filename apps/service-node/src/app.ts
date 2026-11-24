import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { Database } from './db/index.ts';
import { onError } from './middleware/error.ts';
import { dbMiddleware } from './middleware/db.ts';
import { securityHeadersMiddleware } from './middleware/security-headers.ts';
import { sessionMiddleware } from './middleware/session.ts';
import { assetRoutes } from './routes/assets.ts';
import { workspaceImageRoutes } from './routes/workspace-images.ts';
import { adminRoutes } from './routes/admin.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createUserRoutes } from './routes/users.ts';
import { createBlokRoutes } from './routes/blok.ts';
import { createDocumentsRoutes } from './routes/documents.ts';
import { healthRoutes } from './routes/health.ts';
import { createInstanceRoutes } from './routes/instance.ts';
import { createSetupRoutes } from './routes/setup.ts';
import { pageDocumentRoutes } from './routes/page-documents.ts';
import { pageSyncRoutes } from './routes/page-sync.ts';
import { pageRoutes } from './routes/pages.ts';
import { inviteRoutes } from './routes/invites.ts';
import { ticketRoutes } from './routes/tickets.ts';
import { teamspaceRoutes } from './routes/teamspaces.ts';
import { workspaceRoutes } from './routes/workspaces.ts';

export interface AppOptions {
  database: Database | undefined;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.onError(onError);
  app.use('*', logger());
  app.use('*', cors({ credentials: true }));
  app.use('*', securityHeadersMiddleware);

  app.route('/', healthRoutes);
  app.route('/', createInstanceRoutes({ database: options.database }));
  app.route('/', createBlokRoutes());

  if (options.database !== undefined) {
    const api = new Hono();
    api.use('*', dbMiddleware(options.database));
    api.use('*', sessionMiddleware(options.database));
    api.route('/', createSetupRoutes());
    api.route('/', createAuthRoutes());
    api.route('/', createUserRoutes());
    api.route('/', workspaceRoutes);
    api.route('/', teamspaceRoutes);
    api.route('/', inviteRoutes);
    api.route('/', pageRoutes);
    api.route('/', pageDocumentRoutes);
    api.route('/', pageSyncRoutes);
    api.route('/', createDocumentsRoutes());
    api.route('/', ticketRoutes);
    api.route('/', assetRoutes);
    api.route('/', workspaceImageRoutes);
    api.route('/', adminRoutes);
    app.route('/', api);
  } else {
    app.all('/api/*', (context) =>
      context.json({ error: 'database_not_configured' }, 503),
    );
  }

  return app;
}