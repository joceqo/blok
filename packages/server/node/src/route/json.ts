import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';

/** Streamed JSON like Kestrel — no Content-Length. */
export async function writeJSON(request: Request, response: ResponseWriter, status: number, body: string): Promise<void> {
  response.setStatus(status);
  response.headersMut().set('Content-Type', 'application/json');
  await response.start(status);
  if (request.method() !== 'HEAD' && body.length > 0) {
    await response.write(new TextEncoder().encode(body));
  }
}