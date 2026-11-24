import { Hono } from 'hono';

import { forwardToSidecar, sidecarBaseUrl } from '../sidecar/client.ts';

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** Plain-HTTP hint for live collab — product host does not terminate WebSockets yet. */
export function syncWebSocketHint(docId: string): string {
  const base = sidecarBaseUrl();
  if (base === undefined) {
    return (
      `Set BLOK_SIDECAR_URL to the blok-server base, then open a WebSocket to ` +
      `ws://<sidecar-host>/sync/${docId} (or wss:// when the sidecar is HTTPS).`
    );
  }
  const wsBase = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  return `Connect to the sidecar WebSocket at ${wsBase}/sync/${docId}`;
}

/**
 * Collaboration sidecar at `/api/blok` — reverse proxy when `BLOK_SIDECAR_URL` is set.
 *
 * `GET /api/blok/sync/:docId` is the live collab socket path on the sidecar. Plain HTTP
 * receives 501 `upgrade_required`. WebSocket upgrade is not reverse-proxied through this
 * host yet (needs an HTTP `upgrade` handler); upgraded requests get the same JSON with a
 * direct sidecar `ws:`/`wss:` hint.
 */
export function createBlokRoutes(): Hono {
  const blokRoutes = new Hono();

  const forward = (context: { req: { url: string; raw: Request; path: string } }) => {
    const incoming = new URL(context.req.url);
    const stripped = context.req.path.replace(/^\/api\/blok/, '') || '/';
    return forwardToSidecar(stripped, context.req.raw, incoming);
  };

  blokRoutes.get('/api/blok/unfurl', (context) => {
    const incoming = new URL(context.req.url);
    return forwardToSidecar('/unfurl', context.req.raw, incoming, { passThroughHeaders: true });
  });

  blokRoutes.get('/api/blok/sync/:docId', (context) => {
    const docId = context.req.param('docId');
    const hint = syncWebSocketHint(docId);

    if (!isWebSocketUpgrade(context.req.raw)) {
      return context.json({ error: 'upgrade_required', hint }, 501);
    }

    // Reverse WebSocket proxy needs node:http `upgrade`; forwardToSidecar is HTTP-only.
    return context.json(
      {
        error: 'upgrade_required',
        hint,
      },
      501,
    );
  });

  blokRoutes.all('/api/blok', (context) => forward(context));
  blokRoutes.all('/api/blok/*', (context) => forward(context));

  return blokRoutes;
}