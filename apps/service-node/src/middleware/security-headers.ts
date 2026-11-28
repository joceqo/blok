import { createMiddleware } from 'hono/factory';

export const securityHeadersMiddleware = createMiddleware(async (context, next) => {
  await next();
  context.res.headers.set('X-Content-Type-Options', 'nosniff');
  context.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
});