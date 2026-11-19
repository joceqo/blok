import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { Database } from './db/index.js';
import { onError } from './middleware/error.js';
import { dbMiddleware } from './middleware/db.js';
import { sessionMiddleware } from './middleware/session.js';
import { assetRoutes } from './routes/assets.js';
import { adminRoutes } from './routes/admin.js';
import { createAuthRoutes } from './routes/auth.js';
import { createBlokRoutes } from './routes/blok.js';
import { createDocumentsRoutes } from './routes/documents.js';
import { healthRoutes } from './routes/health.js';
import { instanceRoutes } from './routes/instance.js';
import { pageDocumentRoutes } from './routes/page-documents.js';
import { pageRoutes } from './routes/pages.js';
import { ticketRoutes } from './routes/tickets.js';
import { workspaceRoutes } from './routes/workspaces.js';

export interface AppOptions {
  database: Database | undefined;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.onError(onError);
  app.use('*', logger());
  app.use('*', cors({ credentials: true }));

  app.route('/', healthRoutes);
  app.route('/', instanceRoutes);
  app.route('/', createBlokRoutes());
  app.route('/', createDocumentsRoutes());

  if (options.database !== undefined) {
    const api = new Hono();
    api.use('*', dbMiddleware(options.database));
    api.use('*', sessionMiddleware(options.database));
    api.route('/', createAuthRoutes());
    api.route('/', workspaceRoutes);
    api.route('/', pageRoutes);
    api.route('/', pageDocumentRoutes);
    api.route('/', ticketRoutes);
    api.route('/', assetRoutes);
    api.route('/', adminRoutes);
    app.route('/', api);
  } else {
    app.all('/api/*', (context) =>
      context.json({ error: 'database_not_configured' }, 503),
    );
  }

  return app;
}