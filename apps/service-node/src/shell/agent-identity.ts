import { createHash } from 'node:crypto';

// Keep the actor ID that earlier history responses derived from the token digest.
// The token lookup key stays inside the authenticated transport.
export function publicMcpActor(principal: string) {
  return 'actor-' + createHash('sha256').update(principal).digest('hex').slice(0, 16);
}
