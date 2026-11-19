import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (context) => {
  return context.json({ status: 'ok' });
});