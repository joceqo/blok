import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { Database } from './db/index.js';
import { onError } from './middleware/error.js';
import { dbMiddleware } from './middleware/db.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { blokRoutes } from './routes/blok.js';
import { healthRoutes } from './routes/health.js';
import { pageRoutes } from './routes/pages.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { sessionMiddleware } from './middleware/session.js';

export interface AppOptions {
  database: Database | undefined;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.onError(onError);
  app.use('*', logger());
  app.use('*', cors());

  app.route('/', healthRoutes);

  app.route('/', blokRoutes);

  if (options.database !== undefined) {
    const api = new Hono();
    api.use('*', dbMiddleware(options.database));
    api.use('*', sessionMiddleware());
    api.route('/', workspaceRoutes);
    api.route('/', pageRoutes);
    api.route('/', adminRoutes);
    app.route('/', api);
  } else {
    app.get('/api/*', (context) =>
      context.json({ error: 'database_not_configured' }, 503),
    );
  }

  app.route('/', authRoutes);

  return app;
}