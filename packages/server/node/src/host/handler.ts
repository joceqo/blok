import type { Handler } from '../http/server.ts';
import { ResponseWriter } from '../http/response.ts';

export function createPhase0Handler(version: string, unfurlDisabled: boolean): Handler {
  return async (request, response) => {
    const path = request.path();
    if (unfurlDisabled && path === '/unfurl') {
      response.setStatus(404);
      return;
    }
    if (path !== '/health') {
      response.setStatus(404);
      response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
      await response.write(new TextEncoder().encode('404 page not found\n'));
      return;
    }
    const method = request.method().toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.setStatus(405);
      response.headersMut().set('Allow', 'GET, HEAD');
      return;
    }
    response.headersMut().set('Content-Type', 'application/json');
    if (method === 'HEAD') {
      return;
    }
    const body = `{"status":"ok","version":"${version}"}\n`;
    await response.write(new TextEncoder().encode(body));
  };
}
