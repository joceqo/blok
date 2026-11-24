import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { decode, encode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import type { SyncWireFrame } from '../../../../../../src/components/modules/collaboration/types.ts';
import { preparePageStorage, type PageStorage } from './page-storage.ts';
import { verifyTicket } from '../../auth/ticket.ts';
import { acquireJournalWriter, MAX_APPEND_BYTES } from '../journal/append.ts';

export interface RoomIdentity {
  id: string;
  write: boolean;
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

interface Peer { ws: WebSocket; ticket: string; admission: RoomIdentity; synced: boolean }
type Operation = Extract<SyncWireFrame, { type:'operation' }>;

function send(peer: Peer, frame: SyncWireFrame) {
  if (peer.ws.readyState !== WebSocket.OPEN) return;
  if (peer.ws.bufferedAmount > 4 * MAX_APPEND_BYTES) { peer.ws.close(1008, 'outbound queue overflow'); return; }
  peer.ws.send(encode(frame));
}

function classifyUpdate(doc: Doc, update: Uint8Array, project?: PageStorage['validate']) {
  const probe = new Doc();
  try {
    applyUpdate(probe, encodeStateAsUpdate(doc));
    let changed = false;
    probe.on('update', () => { changed = true; });
    applyUpdate(probe, update);
    if (probe.store.pendingStructs !== null || probe.store.pendingDs !== null) return { kind:'invalid' } as const;
    return {kind:changed ? 'changed' : 'unchanged', data:project?.(probe)} as const;
  } catch { return {kind:'invalid'} as const; }
  finally { probe.destroy(); }
}

/** Bind one seeded copy on loopback. The journal lease spans all connected clients. */
export async function startJournalRoom(options: RoomOptions) {
  const { documentId, allowedOrigins, authorize } = options;
  if (!documentId || !allowedOrigins.size) throw new Error('A document ID and allowed origins are required');
  const storage = options.projection && await preparePageStorage(options.directory, documentId, options.projection.origin, options.projection.secret);
  const writer = await acquireJournalWriter(storage?.directory ?? options.directory);
  const doc = new Doc();
  const operations = new Map<string, { digest:Buffer; sequence:bigint }>();
  const peers = new Set<Peer>();
  const recheckKey = options.recheckSecret && createHash('sha256').update('Bearer '+options.recheckSecret).digest();
  const http = createServer((req, res) => {
    if (recheckKey && req.method === 'POST' && req.url === '/internal/room/recheck-access') {
      const presented = createHash('sha256').update(req.headers.authorization ?? '').digest();
      if (!timingSafeEqual(recheckKey, presented)) { res.writeHead(401).end(); return; }
      if (stopping) { res.writeHead(503).end(); return; }
      // Serialize the notification with existing writes. Re-read current permissions for idle peers too.
      queue = queue.then(async () => {
        await Promise.all(Array.from(peers, principal));
        res.writeHead(stopping ? 503 : 204).end();
      }).catch(() => { res.writeHead(503).end(); });
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz' && !stopping) {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({backend:'node',documentId}));
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer:true, perMessageDeflate:false, maxPayload:MAX_APPEND_BYTES+4096,
    handleProtocols: offered => offered.has('blok-sync.v2') ? 'blok-sync.v2' : false });
  let queue = Promise.resolve();
  let stopping = false;
  let pendingBytes = 0;
  let pendingFrames = 0;
  let closing: Promise<void> | undefined;
  const route = '/api/blok/sync/' + encodeURIComponent(documentId);
  let sweeping = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function principal(peer: Peer): Promise<RoomIdentity | null> {
    let identity: RoomIdentity | null;
    try { identity = peer.admission.revalidate ? await peer.admission.revalidate() : await authorize(peer.ticket, documentId); }
    catch { identity = null; }
    if (identity?.id === peer.admission.id && peer.ws.readyState === WebSocket.OPEN) return identity;
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close(4403, 'forbidden');
    return null;
  }
  function stop() {
    if (closing) return closing;
    stopping = true;
    clearInterval(timer);
    for (const peer of peers) peer.ws.terminate();
    closing = (async () => {
      await new Promise<void>(done => http.close(() => done()));
      await queue;
      await writer.close();
      wss.close();
      doc.destroy();
    })();
    return closing;
  }
  try {
    const { manifest, journal } = await writer.recover(frame => applyUpdate(doc,frame.update), r => {
      operations.set(r.operationId, {digest:Buffer.from(r.digest),sequence:r.sequence});
    });
    if (manifest.format !== 2 || manifest.epoch < 0n || manifest.epoch > BigInt(Number.MAX_SAFE_INTEGER) ||
        doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new Error('Room needs an intact seeded format-2 journal');
    const tag = { format:manifest.format, epoch:Number(manifest.epoch), lineage:manifest.lineage };
    let head = journal.durableThrough;
    await storage?.attach(doc,tag.lineage,head);

    async function operation(peer: Peer, identity: RoomIdentity, op: Operation) {
      const { lineage, operationId, update } = op;
      const reject = (code: string) => send(peer,{type:'rejection',lineage,operationId,code});
      const ack = (sequence: bigint) => send(peer,{type:'acknowledgement',lineage,operationId,serverSequence:String(sequence)});
      if (!identity.write) return reject('read-only');
      if (!peer.synced) return reject('not-synced');
      if (tag.lineage !== lineage) return reject('lineage-mismatch');
      if (update.length > MAX_APPEND_BYTES) return reject('oversized-update');
      const digest = createHash('sha256').update(update).digest();
      const previous = operations.get(operationId);
      if (previous) return digest.equals(previous.digest) ? ack(previous.sequence) : reject('operation-id-conflict');
      const candidate = classifyUpdate(doc,update,storage?.validate);
      if (candidate.kind === 'invalid') return reject('invalid-update');
      if (candidate.kind === 'unchanged' && head > 0n) return ack(head);
      try {
        const receipt = await writer.append({ expectedLineage:lineage, expectedThrough:head, operationId,
          update, actorId:identity.id, source:0 });
        if (receipt.outcome !== 'committed') throw new Error('Held journal changed');
        head = receipt.sequence;
        if (storage && candidate.data) await storage.publish(head,candidate.data);
        applyUpdate(doc,update);
        operations.set(operationId,{digest,sequence:head});
        await Promise.all([...peers].map(async member => {
          if (member.synced && await principal(member)) send(member,{type:'update',update});
        }));
        if (await principal(peer)) ack(head);
      } catch {
        // Nothing in RAM can be used as evidence of a commit after storage failure.
        stopping = true;
        for (const member of peers) member.ws.close(4503, 'commit unavailable');
        http.close();
        clearInterval(timer);
        // Reopen from disk only after the old room releases its lease.
        setImmediate(() => { void stop(); });
      }
    }

    async function receive(peer: Peer, payload: Uint8Array) {
      const identity = await principal(peer);
      if (!identity || stopping) return;
      const frame = decode(payload);
      switch (frame.type) {
        case 'operation': await operation(peer,identity,frame); break;
        case 'syncStep1': {
          let update;
          try { update = encodeStateAsUpdate(doc,frame.stateVector); } catch { return; }
          send(peer,{type:'syncStep2',update});
          send(peer,{type:'syncStep1',stateVector:encodeStateVector(doc)});
          peer.synced = true;
          break;
        }
        case 'syncStep2':
        case 'update': peer.ws.close(1008,'raw write on a v2 session'); break;
      }
    }

    function enqueue(peer: Peer, data: RawData, binary: boolean) {
      if (stopping || !binary) { peer.ws.close(1003,'binary frames required'); return; }
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (pendingFrames >= 128 || pendingBytes + bytes.length > 8 * MAX_APPEND_BYTES) {
        peer.ws.close(1008,'room queue overflow'); return;
      }
      pendingFrames++;
      pendingBytes += bytes.length;
      queue = queue.then(async () => {
        try { await receive(peer,bytes); }
        catch { peer.ws.close(1011,'room error'); }
        finally { pendingFrames--; pendingBytes -= bytes.length; }
      });
    }

    http.on('upgrade', async (req, socket, handshake) => {
      socket.on('error', () => socket.destroy());
      const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      if (stopping || peers.size >= 32) { refuse('503 Service Unavailable'); return; }
      if (req.url !== route) { refuse('404 Not Found'); return; }
      if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) { refuse('403 Forbidden'); return; }
      const offered = req.headers['sec-websocket-protocol']?.split(',').map(p => p.trim()) ?? [];
      const tickets = offered.filter(p => p !== 'blok-sync.v2' && p !== 'blok-sync.v1');
      if (!offered.includes('blok-sync.v2') || tickets.length !== 1) { refuse('401 Unauthorized'); return; }
      const ticket = tickets[0]!;
      let identity;
      try { identity = await authorize(ticket, documentId); } catch { identity = null; }
      if (!identity?.id) { refuse('403 Forbidden'); return; }
      if (stopping || peers.size >= 32 || socket.destroyed) { refuse('503 Service Unavailable'); return; }
      wss.handleUpgrade(req,socket,handshake,ws => {
        const peer: Peer = {ws,ticket,admission:identity,synced:false};
        peers.add(peer);
        ws.on('error', () => ws.terminate());
        ws.on('close', () => peers.delete(peer));
        ws.on('message', (data,binary) => enqueue(peer,data,binary));
        send(peer,{type:'control',tag});
        send(peer,{type:'limits',maxMessageBytes:MAX_APPEND_BYTES});
      });
    });
    await new Promise<void>((ok,fail) => {
      http.once('error',fail);
      http.listen(options.port ?? 0,options.listenHost ?? '127.0.0.1',() => { http.off('error',fail); ok(); });
    });
    timer = setInterval(async () => {
      if (sweeping || stopping) return;
      sweeping = true;
      try { await Promise.all([...peers].map(principal)); } finally { sweeping = false; }
    },1000);
    timer.unref();
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
    return { url:`ws://127.0.0.1:${address.port}${route}`, close:stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export { shellRoomTickets } from './shell-access.ts';
