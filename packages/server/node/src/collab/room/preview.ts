import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_APPEND_BYTES } from '../journal/append.ts';
import { verifyTicket } from '../../auth/ticket.ts';
import { openDocumentRoom } from './document-room.ts';

export interface RoomIdentity {
  id: string;
  write: boolean;
  workspaceId?: string;
  /** Recheck only this admitted connection, bound to its original page and identity. */
  revalidate?: () => Promise<RoomIdentity | null>;
}
export interface RoomOptions {
  directory: string;
  documentId: string;
  port?: number;
  listenHost?: '127.0.0.1' | '0.0.0.0';
  projection?: { origin: string; secret: string };
  recheckSecret?: string;
  allowedOrigins: ReadonlySet<string>;
  /** Verify ticket expiry, document scope and current read/write permissions. */
  authorize(ticket: string, documentId: string): Promise<RoomIdentity | null>;
}

/** Standalone demo admission. A product host can inject live workspace and page ACL checks. */
export function signedRoomTickets(secret: string): RoomOptions['authorize'] {
  if (secret.length < 32) throw new Error('Preview ticket secret must contain at least 32 characters');
  return async (ticket, documentId) => {
    const verified = verifyTicket(secret, ticket, Date.now());
    if (!verified.ok || !verified.claims.user || verified.claims.doc !== documentId) return null;
    return { id:verified.claims.user, write:verified.claims.write };
  };
}

type DocumentRoom = Awaited<ReturnType<typeof openDocumentRoom>>;
interface Resident {
  room: Promise<DocumentRoom>;
  users: number;
  closing?: Promise<void>;
}

interface WorkspaceOptions extends Omit<RoomOptions, 'documentId' | 'projection'> {
  workspaceId: string;
  projection: NonNullable<RoomOptions['projection']>;
}

export function startWorkspaceRooms(options: WorkspaceOptions) {
  if (!options.workspaceId || !options.projection) throw new Error('Workspace rooms require canonical document storage');
  return startHost(options);
}

export function startJournalRoom(options: RoomOptions) {
  if (!options.documentId) throw new Error('A document ID is required');
  return startHost(options);
}

async function startHost(options: RoomOptions | WorkspaceOptions) {
  const singlePage = 'documentId' in options ? options.documentId : undefined;
  const workspaceId = 'workspaceId' in options ? options.workspaceId : undefined;
  if (!options.allowedOrigins.size) throw new Error('Allowed origins are required');
  let stopping = false;
  let closing: Promise<void> | undefined;
  const pages = new Map<string, Resident>();
  const sockets = new WebSocketServer({noServer:true, perMessageDeflate:false, maxPayload:MAX_APPEND_BYTES+4096,
    handleProtocols: protocols => protocols.has('blok-sync.v2') ? 'blok-sync.v2' : false});
  function load(id: string): Resident {
    const entry: Resident = {room:openDocumentRoom({...options,documentId:id}),users:0};
    pages.set(id, entry);
    void entry.room.catch(() => { if (pages.get(id) === entry) pages.delete(id); });
    return entry;
  }
  function unload(id: string, entry: Resident) {
    // Keep the entry registered while the writer drains its queue and releases flock.
    entry.closing ??= entry.room.then(room => room.close()).finally(() => {
      if (pages.get(id) === entry) pages.delete(id);
    });
    return entry.closing;
  }

  const recheckKey = options.recheckSecret && createHash('sha256').update('Bearer '+options.recheckSecret).digest();
  const http = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const single = singlePage && pages.get(singlePage);
      if (stopping || (single && !(await single.room).available())) { res.writeHead(503).end(); return; }
      const scope = singlePage ? {documentId:singlePage} : {workspaceId};
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({backend:'node',...scope}));
      return;
    }
    if (recheckKey && req.method === 'POST' && req.url?.split('?')[0] === '/internal/room/recheck-access') {
      const presented = createHash('sha256').update(req.headers.authorization ?? '').digest();
      if (!timingSafeEqual(recheckKey,presented)) { res.writeHead(401).end(); return; }
      try {
        const id = new URL(req.url,'http://localhost').searchParams.get('documentId');
        const entries = id === null ? [...pages.values()] : [pages.get(id)];
        // An absent or draining room has no active clients and must not be reopened by this notification.
        await Promise.all(entries.map(async entry => {
          if (!entry || entry.closing) return;
          const room = await entry.room;
          if (!entry.closing) await room.recheck();
        }));
        res.writeHead(stopping ? 503 : 204).end();
      } catch { res.writeHead(503).end(); }
      return;
    }
    res.writeHead(404).end();
  });

  let admissions = 0;
  http.on('upgrade', async (req, socket, handshake) => {
    socket.on('error', () => socket.destroy());
    const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const url = req.url ?? '';
    const id = singlePage
      ? (url === '/api/blok/sync/'+encodeURIComponent(singlePage) ? singlePage : undefined)
      : /^\/api\/blok\/sync\/([A-Za-z0-9_-]{1,128})$/.exec(url)?.[1];
    if (!id) { refuse('404 Not Found'); return; }
    if (!req.headers.origin || !options.allowedOrigins.has(req.headers.origin)) { refuse('403 Forbidden'); return; }
    const offers = req.headers['sec-websocket-protocol']?.split(',').map(p => p.trim()) ?? [];
    const tickets = offers.filter(p => p !== 'blok-sync.v2' && p !== 'blok-sync.v1');
    if (!offers.includes('blok-sync.v2') || tickets.length !== 1 || !tickets[0]) { refuse('401 Unauthorized'); return; }
    if (stopping || admissions >= 256) { refuse('503 Service Unavailable'); return; }
    admissions++;
    let reserved: Resident | undefined;
    function release() {
      if (!reserved) return;
      const entry = reserved;
      reserved = undefined;
      if (--entry.users === 0 && !singlePage) void unload(id!,entry).catch(() => {});
    }
    try {
      const ticket = tickets[0];
      const identity = await options.authorize(ticket,id).catch(() => null);
      if (!identity?.id || (workspaceId && identity.workspaceId !== workspaceId)) { refuse('403 Forbidden'); return; }
      // Two clients may arrive during an eviction. Both wait for the same lease to close.
      let entry = pages.get(id);
      while (entry?.closing) { await entry.closing; entry = pages.get(id); }
      if (stopping || socket.destroyed || (!entry && pages.size >= 128)) { refuse('503 Service Unavailable'); return; }
      entry ??= load(id);
      if (entry.users >= 32) { refuse('503 Service Unavailable'); return; }
      reserved = entry;
      entry.users++;
      const room = await entry.room;
      if (stopping || !room.available() || socket.destroyed) { refuse('503 Service Unavailable'); return; }
      socket.once('close', release);
      sockets.handleUpgrade(req,socket,handshake,ws => room.connect(ws,ticket,identity));
    } catch {
      release();
      refuse('503 Service Unavailable');
    } finally {
      if (socket.destroyed || socket.writableEnded) release();
      admissions--;
    }
  });

  function stop() {
    if (!closing) {
      stopping = true;
      const closed = new Promise<void>(resolve => http.close(() => resolve()));
      closing = Promise.allSettled([...pages].map(([id,entry]) => unload(id,entry))).then(async results => {
        sockets.close();
        await closed;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
    }
    return closing;
  }
  try {
    if (singlePage) await load(singlePage).room;
    await new Promise<void>((resolve,reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 0, options.listenHost ?? '127.0.0.1',() => { http.off('error',reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const path = singlePage ? '/api/blok/sync/'+encodeURIComponent(singlePage) : '/api/blok/sync/';
    return { url:`ws://127.0.0.1:${address.port}${path}`, close:stop };
  } catch (error) { await stop(); throw error; }
}

export { shellRoomTickets } from './shell-access.ts';
