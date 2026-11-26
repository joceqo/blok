import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { DocumentPurged, UnreadableJournalData, MAX_APPEND_BYTES } from '../journal/append.ts';
import { verifyTicket } from '../../auth/ticket.ts';
import { pageDirectory } from './page-seed.ts';
import { preparePageStorage, ProjectionDiverged } from './page-storage.ts';
import { seedUpdate } from './page-document.ts';
import { resetGeneration } from './reset.ts';
import { purgeDocument } from './purge.ts';
import { openDocumentRoom } from './document-room.ts';
import { createRoomRegistry, type Resident } from './room-registry.ts';

export interface RoomIdentity {
  id: string;
  write: boolean;
  workspaceId?: string;
  actorId?: string;
  /** Set by the host after resolving the authenticated credential. */
  recordNote?: import('./record-notes.ts').RecordNote;
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
  /** Record notes are kept for the history routes to read an actor back off. */
  recordNotes?: boolean;
  /** `CollabEnforceRestoreGuards`: off, a restore never asks before it changes a locked or shared database. */
  enforceRestoreGuards?: boolean;
  /** `CollabRestoreTrashesPages`: on, a restore trashes a later page pointer in place instead of removing it. */
  restoreTrashesPages?: boolean;
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
type RoomResident = Resident<DocumentRoom>;

interface WorkspaceOptions extends Omit<RoomOptions, 'documentId' | 'projection'> {
  workspaceId: string;
  projection: NonNullable<RoomOptions['projection']>;
}

export function startWorkspaceRooms(options: WorkspaceOptions) {
  if (!options.workspaceId || !options.projection) throw new Error('Workspace rooms require canonical document storage');
  return startHost(options);
}

export function startAllRooms(options: Omit<WorkspaceOptions, 'workspaceId'>) {
  if (!options.projection) throw new Error('All rooms require canonical document storage');
  return startHost({...options, all:true});
}

export function startJournalRoom(options: RoomOptions) {
  if (!options.documentId) throw new Error('A document ID is required');
  return startHost(options);
}

async function startHost(options: RoomOptions | WorkspaceOptions | (Omit<WorkspaceOptions,'workspaceId'> & {all:true})) {
  const singlePage = 'documentId' in options ? options.documentId : undefined;
  const workspaceId = 'workspaceId' in options ? options.workspaceId : undefined;
  if (!options.allowedOrigins.size) throw new Error('Allowed origins are required');
  let stopping = false;
  let closing: Promise<void> | undefined;
  const rooms = createRoomRegistry<DocumentRoom>({
    open: id => openDocumentRoom({...options,documentId:id}),
    // A single-document host holds its room for the process lifetime.
    keepLoaded: Boolean(singlePage),
  });
  const sockets = new WebSocketServer({noServer:true, perMessageDeflate:false, maxPayload:MAX_APPEND_BYTES+4096,
    handleProtocols: protocols => protocols.has('blok-sync.v2') ? 'blok-sync.v2' : protocols.has('blok-sync.v1') ? 'blok-sync.v1' : false});
  sockets.on('headers', headers => headers.push('X-Blok-Collaboration: node'));
  const inScope = (identity:RoomIdentity|null):identity is RoomIdentity => !!identity?.id &&
    (!('all' in options) || !!identity.workspaceId) && (!workspaceId || identity.workspaceId === workspaceId);
  // A transition excludes new admissions until the old writer has drained
  // and released its lease. Other documents continue serving concurrently.
  // Tracked here too: shutdown waits for the ones still running.
  const transitions = new Set<Promise<void>>();
  function exclusive(id:string, work:()=>Promise<void>) {
    const pending = rooms.exclusive(id,work);
    transitions.add(pending);
    void pending.catch(()=>{}).finally(()=>transitions.delete(pending));
    return pending;
  }
  function directory(id:string) { return options.projection ? pageDirectory(options.directory,id) : options.directory; }
  async function retire(id:string, reason:{code:number;message:string}, recover:boolean) {
    try {
      // Recovery closes a document the host has not opened: a replaced record still holds a lease.
      await rooms.retire(id,reason,{load:recover});
    } catch(error) {
      // Explicit reset is how the host adopts an externally changed record.
      // Purge must also work when the old bytes are no longer readable.
      if(recover && !(error instanceof ProjectionDiverged) && !(error instanceof UnreadableJournalData)) throw error;
    }
  }
  async function purge(id:string, allowed:()=>boolean|Promise<boolean>) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || (singlePage && id!==singlePage)) throw new Error('Invalid document ID');
    await exclusive(id,async()=>{
      if(stopping) throw new Error('Host stopping');
      if (!await allowed()) throw new Error('Document purge not authorized');
      rooms.markPurging(id);
      try {
        await retire(id,{code:4403,message:'forbidden'},false);
        await purgeDocument(directory(id),Boolean(options.projection));
      } finally {
        // On success the durable marker protects future opens; on failure nothing
        // was erased, and an in-memory marker would strand the document for good.
        rooms.clearPurging(id);
      }
    });
  }
  async function reset(id:string, token:string, admitted:RoomIdentity) {
    let forbidden=false;
    await exclusive(id,async()=>{
      if(stopping) throw new Error('Host stopping');
      const who=admitted.revalidate ? await admitted.revalidate() : await options.authorize(token,id);
      if (!inScope(who) || !who.write || who.id!==admitted.id || who.workspaceId!==admitted.workspaceId) {
        forbidden=true; return;
      }
      await retire(id,{code:4409,message:'document reset'},true);
      const cfg=options.projection;
      const storage=cfg && await preparePageStorage(options.directory,id,cfg.origin,cfg.secret);
      let lineage='';
      await resetGeneration(directory(id),async next=>{
        lineage=next;
        return storage ? storage.prepareReset(next) : seedUpdate(null);
      },async()=>{ await storage?.finishReset(lineage); });
    });
    return forbidden ? 403 : 204;
  }
  let admissions = 0;

  const recheckKey = options.recheckSecret && createHash('sha256').update('Bearer '+options.recheckSecret).digest();
  const http = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const single = singlePage && rooms.peek(singlePage);
      if (stopping || (single && !await single.room.then(room=>room.available(),()=>false))) { res.writeHead(503).end(); return; }
      const scope = singlePage ? {documentId:singlePage} : workspaceId ? {workspaceId} : {all:true};
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({backend:'node',...scope}));
      return;
    }
    if (recheckKey && req.method === 'POST' && req.url?.split('?')[0] === '/internal/room/recheck-access') {
      const presented = createHash('sha256').update(req.headers.authorization ?? '').digest();
      if (!timingSafeEqual(recheckKey,presented)) { res.writeHead(401).end(); return; }
      try {
        const id = new URL(req.url,'http://localhost').searchParams.get('documentId');
        const entries = id === null ? rooms.residents() : [rooms.peek(id)];
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
    let url:URL;
    try { url = new URL(req.url ?? '/','http://localhost'); }
    catch { res.writeHead(400).end(); return; }
    if (recheckKey && req.method==='POST' && url.pathname==='/internal/room/purge') {
      if (!timingSafeEqual(recheckKey,createHash('sha256').update(req.headers.authorization ?? '').digest())) {
        res.writeHead(401).end(); return;
      }
      const id=url.searchParams.get('documentId');
      if(!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || (singlePage && singlePage!==id) || workspaceId) {
        res.writeHead(400).end(); return;
      }
      try { await purge(id,()=>true); res.writeHead(204).end(); }
      catch(error) { res.writeHead((error as NodeJS.ErrnoException).code==='JOURNAL_BUSY'?409:503).end(); }
      return;
    }
    const match = /^\/api\/blok\/sync\/([A-Za-z0-9_-]{1,128})\/(?:history(?:\/|$)|state$|reset$)/.exec(url.pathname);
    if (match && (!singlePage || match[1] === singlePage)) {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Vary','Origin');
      const origin = req.headers.origin;
      if (origin && !options.allowedOrigins.has(origin)) { res.writeHead(403).end(); return; }
      if (origin) res.setHeader('Access-Control-Allow-Origin',origin);
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Authorization, X-Blok-Ticket, Content-Type, If-Match, Blok-Idempotency-Key, X-Blok-Restore-Confirm');
        res.writeHead(204).end(); return;
      }
      const id = match[1]!;
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ??
        (typeof req.headers['x-blok-ticket']==='string' ? req.headers['x-blok-ticket'] : undefined) ?? url.searchParams.get('ticket');
      if (!token) { res.writeHead(401).end(); return; }
      if (stopping || admissions >= 256) { res.writeHead(503).end(); return; }
      admissions++;
      let resident:RoomResident|undefined;
      try {
        const identity = await options.authorize(token,id);
        if (!inScope(identity) || (req.method !== 'GET' && !identity.write)) { res.writeHead(403).end(); return; }
        if (url.pathname==='/api/blok/sync/'+id+'/reset') {
          if (req.method!=='POST') { res.writeHead(405).end(); return; }
          res.writeHead(await reset(id,token,identity)).end(); return;
        }
        const confirmed = String(req.headers['x-blok-restore-confirm'] ?? '').split(',').map(k=>k.trim());
        if (req.method === 'POST') {
          const body = await confirmations(req);
          if (!body) { res.writeHead(413).end(); return; }
          confirmed.push(...body);
        }
        resident = await rooms.reserve(id);
        const room = await resident.room;
        const result = await room.history({url,asJSON:req.headers.accept?.includes('application/json'),method:req.method ?? '',key:req.headers['blok-idempotency-key'] as string|undefined,
          match:req.headers['if-match'],confirmed}, identity, token);
        res.setHeader('Access-Control-Expose-Headers','Blok-History-Lineage, Blok-History-Sequence, Blok-Doc-Lineage, Blok-Doc-Sequence, ETag, X-Blok-Restore-Refusal');
        res.writeHead(result.status,{'Content-Type':'application/json',...('headers' in result && result.headers)});
        res.end('body' in result ? JSON.stringify(result.body) : undefined);
      } catch (error) { res.writeHead(error instanceof DocumentPurged ? 403 : 503).end(); }
      finally { if (resident) rooms.release(id,resident); admissions--; }
      return;
    }
    res.writeHead(404).end();
  });

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
    if ((!offers.includes('blok-sync.v2') && !offers.includes('blok-sync.v1')) || tickets.length !== 1 || !tickets[0]) { refuse('401 Unauthorized'); return; }
    if (stopping || admissions >= 256) { refuse('503 Service Unavailable'); return; }
    admissions++;
    let reserved: RoomResident | undefined;
    function release() {
      if (!reserved) return;
      const entry = reserved;
      reserved = undefined;
      rooms.release(id!,entry);
    }
    try {
      const ticket = tickets[0];
      const identity = await options.authorize(ticket,id).catch(() => null);
      if (!inScope(identity)) { refuse('403 Forbidden'); return; }
      if (socket.destroyed) return;
      const entry = await rooms.reserve(id);
      reserved = entry;
      const room = await entry.room;
      if (stopping || !room.available() || socket.destroyed) { refuse('503 Service Unavailable'); return; }
      socket.once('close', release);
      sockets.handleUpgrade(req,socket,handshake,ws => room.connect(ws,ticket,identity));
    } catch(error) {
      release();
      refuse(error instanceof DocumentPurged ? '403 Forbidden' : '503 Service Unavailable');
    } finally {
      if (socket.destroyed || socket.writableEnded) release();
      admissions--;
    }
  });

  function stop() {
    if (!closing) {
      stopping = true;
      const closed = new Promise<void>(resolve => http.close(() => resolve()));
      closing = Promise.allSettled([...transitions, rooms.close()]).then(async results => {
        sockets.close();
        await closed;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
    }
    return closing;
  }
  try {
    if (singlePage) {
      const entry = await rooms.reserve(singlePage);
      rooms.release(singlePage,entry);
      await entry.room.catch(error=>{ if(!(error instanceof DocumentPurged)) throw error; });
    }
    await new Promise<void>((resolve,reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 0, options.listenHost ?? '127.0.0.1',() => { http.off('error',reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const path = singlePage ? '/api/blok/sync/'+encodeURIComponent(singlePage) : '/api/blok/sync/';
    return { url:`ws://127.0.0.1:${address.port}${path}`, close:stop, purgeDocument:purge };
  } catch (error) { await stop(); throw error; }
}

export { shellRoomTickets } from './shell-access.ts';

async function confirmations(req:IncomingMessage):Promise<string[]|null> {
  let length = 0;
  const chunks:Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) return null;
    chunks.push(chunk);
  }
  if (!length) return [];
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    return Array.isArray(parsed?.confirm) ? parsed.confirm.filter((item:unknown)=>typeof item === 'string') : [];
  } catch { return []; }
}
