import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';

export async function writePlain(request: Request, response: ResponseWriter, status: number, body: string): Promise<void> {
  response.setStatus(status);
  response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
  await response.start(status);
  if (body.length > 0 && request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode(body));
  }
}

export async function notFound(request: Request, response: ResponseWriter): Promise<void> {
  await writePlain(request, response, 404, '404 page not found\n');
}

export async function methodNotAllowed(request: Request, response: ResponseWriter, allow: string): Promise<void> {
  response.setStatus(405);
  response.headersMut().set('Allow', allow);
  response.headersMut().set('Content-Type', 'text/plain; charset=utf-8');
  await response.start(405);
  if (request.method() !== 'HEAD') {
    await response.write(new TextEncoder().encode('Method Not Allowed\n'));
  }
}

export async function badRequest(response: ResponseWriter): Promise<void> {
  response.setStatus(400);
  response.headersMut().set('Connection', 'close');
  response.headersMut().set('Content-Length', '0');
  await response.start(400);
}