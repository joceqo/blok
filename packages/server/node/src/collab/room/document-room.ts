import { createHash, randomBytes } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { decode, encode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import type { SyncWireFrame } from '../../../../../../src/components/modules/collaboration/types.ts';
import { historyRequest, type HistoryRequest } from './history.ts';
import { writeRecordNote } from './record-notes.ts';
import { RoomPresence } from './presence.ts';
import { preparePageStorage, type PageStorage } from './page-storage.ts';
import { acquireJournalWriter, MAX_APPEND_BYTES } from '../journal/append.ts';
import { sweepHeartbeat, type HeartbeatMember } from './heartbeat.ts';
import { createAccessCache } from './access-cache.ts';

import type { RoomIdentity, RoomOptions } from './preview.ts';

interface Peer extends HeartbeatMember { ws: WebSocket; ticket: string; admission: RoomIdentity; synced: boolean;
  badAwareness: number; reportedMalformed: boolean }

/** Protocol section 6.1 and scenario S4 fix this text, not only the 4503 code. */
const COMMIT_UNAVAILABLE_REASON = 'commit unavailable, retry';

/** Probe period. A half-open socket is dropped between one and two of these. */
const HEARTBEAT_MS = 30_000;

/**
 * Floor under an authorization answer. The push on `/internal/room/recheck-access`
 * is the authority on a permission change and invalidates immediately; this only
 * bounds a change that was never pushed.
 */
const ACCESS_TTL_MS = 2_000;
type Operation = Extract<SyncWireFrame, { type:'operation' }>;

/** What `POST /sync/{doc}/edit` carries. Its digest covers the command, not the update. */
export interface EditCommand {
  operationId: string;
  digest: Uint8Array;
  update: Uint8Array;
  expected?: { lineage: string; sequence: bigint };
}

export type EditOutcome =
  | { ok: true; lineage: string; sequence: bigint }
  | { ok: false; reason: 'forbidden' | 'conflict' | 'invalid' | 'too-large' }
  | { ok: false; reason: 'precondition'; lineage: string; sequence: bigint };

/** What the admission rules decided, before a transport words it. */
type Verdict =
  | { kind: 'too-large' | 'conflict' | 'precondition' | 'invalid' }
  | { kind: 'settled'; sequence: bigint }
  | { kind: 'commit'; data?: Record<string, unknown> };

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

/** Own the journal lease while this document is loaded. */
export async function openDocumentRoom(options: RoomOptions) {
  const { documentId, allowedOrigins, authorize } = options;
  if (!documentId || !allowedOrigins.size) throw new Error('A document ID and allowed origins are required');
  const storage = options.projection && await preparePageStorage(options.directory, documentId, options.projection.origin, options.projection.secret);
  const writer = await acquireJournalWriter(storage?.directory ?? options.directory);
  const doc = new Doc();
  const operations = new Map<string, { digest:Buffer; sequence:bigint }>();
  const peers = new Set<Peer>();
  const presence = new RoomPresence<Peer>();
  const access = createAccessCache<Peer, RoomIdentity | null>({ ttlMs: ACCESS_TTL_MS });
  let queue = Promise.resolve();
  let stopping = false;
  let pendingBytes = 0;
  let pendingFrames = 0;
  let closing: Promise<void> | undefined;
  let sweeping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  async function principal(peer: Peer): Promise<RoomIdentity | null> {
    let identity: RoomIdentity | null;
    try {
      identity = await access.resolve(peer, () =>
        peer.admission.revalidate ? peer.admission.revalidate() : authorize(peer.ticket, documentId));
    }
    catch { identity = null; }
    if (identity?.id === peer.admission.id && identity.workspaceId === peer.admission.workspaceId &&
        peer.ws.readyState === WebSocket.OPEN) return identity;
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close(4403, 'forbidden');
    return null;
  }
  function stop(reason?: {code:number;message:string}) {
    if (closing) return closing;
    stopping = true;
    clearInterval(timer);
    clearInterval(keepalive);
    for (const peer of peers) {
      if (reason) peer.ws.close(reason.code,reason.message); else peer.ws.terminate();
    }
    closing = (async () => {
      await queue;
      await writer.close();
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
      const digest = createHash('sha256').update(update).digest();
      const verdict = admit(operationId,digest,update);
      if (verdict.kind === 'settled') return ack(verdict.sequence);
      if (verdict.kind === 'too-large') return reject('oversized-update');
      if (verdict.kind === 'conflict') return reject('operation-id-conflict');
      if (verdict.kind !== 'commit') return reject('invalid-update');
      try {
        await commit(identity,operationId,digest,update,0,verdict.data);
        if (await principal(peer)) ack(head);
      } catch { /* commit has already closed this room */ }
    }

    /**
     * Section 12: the rules an edit is admitted by, shared between the socket and
     * `POST /sync/{doc}/edit` so the two doors cannot drift. A key that already
     * committed answers its own receipt before any precondition is read (12.2).
     * Write permission is not among them: each door refuses in its own words,
     * and at its own point in the order.
     */
    function admit(operationId:string, digest:Buffer, update:Uint8Array,
        expected?:{lineage:string;sequence:bigint}): Verdict {
      if (update.length > MAX_APPEND_BYTES) return {kind:'too-large'};
      const previous = operations.get(operationId);
      if (previous) return digest.equals(previous.digest) ? {kind:'settled',sequence:previous.sequence} : {kind:'conflict'};
      if (expected && (expected.lineage !== tag.lineage || expected.sequence !== head)) return {kind:'precondition'};
      const candidate = classifyUpdate(doc,update,storage?.validate);
      if (candidate.kind === 'invalid') return {kind:'invalid'};
      // An edit that changes nothing records nothing, so its key stays spendable.
      if (candidate.kind === 'unchanged' && head > 0n) return {kind:'settled',sequence:head};
      return {kind:'commit',data:candidate.data};
    }

    /**
     * `POST /sync/{doc}/edit`. Serialised on the queue the socket uses, so no
     * frame can move the head between the admission and the append.
     */
    function apply(command: EditCommand, admission: RoomIdentity, token: string): Promise<EditOutcome> {
      const result = queue.then(async (): Promise<EditOutcome> => {
        if (stopping) throw new Error('Closing room');
        const who = admission.revalidate ? await admission.revalidate() : await authorize(token,documentId);
        if (!who || who.id !== admission.id || who.workspaceId !== admission.workspaceId ||
            !who.write || !admission.write) return {ok:false,reason:'forbidden'};
        const digest = Buffer.from(command.digest);
        const verdict = admit(command.operationId,digest,command.update,command.expected);
        if (verdict.kind === 'settled') return {ok:true,lineage:tag.lineage,sequence:verdict.sequence};
        if (verdict.kind === 'precondition') return {ok:false,reason:'precondition',lineage:tag.lineage,sequence:head};
        if (verdict.kind !== 'commit') return {ok:false,reason:verdict.kind};
        const sequence = await commit(who,command.operationId,digest,command.update,2,verdict.data);
        return {ok:true,lineage:tag.lineage,sequence};
      });
      queue = result.then(()=>{},()=>{});
      return result;
    }

    async function commit(identity: RoomIdentity, operationId:string, digest:Buffer, update:Uint8Array, source:0|1|2,
        data?:Record<string,unknown>, except?:Peer) {
      try {
        const receipt = await writer.append({ expectedLineage:tag.lineage, expectedThrough:head, operationId,
          update, actorId:identity.actorId ?? identity.id, source, digest });
        if (receipt.outcome !== 'committed') throw new Error('Held journal changed');
        head = receipt.sequence;
        // A note is auxiliary metadata. Its failure must never discard or reject a durable edit.
        if (identity.actorId || identity.id) {
          await writeRecordNote(storage?.directory ?? options.directory, tag.lineage, head, operationId,
            identity.recordNote ?? {kind:'person'}).catch(() => console.warn('Could not persist collaboration record note'));
        }
        if (storage && data) await storage.publish(head,data);
        applyUpdate(doc,update);
        operations.set(operationId,{digest,sequence:head});
        await Promise.all([...peers].map(async member => {
          if (member!==except && member.synced && await principal(member)) send(member,{type:'update',update});
        }));
        return head;
      } catch (error) {
        // Nothing in RAM can be used as evidence of a commit after storage failure.
        stopping = true;
        for (const member of peers) member.ws.close(4503, COMMIT_UNAVAILABLE_REASON);
        clearInterval(timer);
        clearInterval(keepalive);
        // Reopen from disk only after the old room releases its lease.
        setImmediate(() => { void stop().catch(() => {}); });
        throw error;
      }
    }

    function history(request: HistoryRequest, admission:RoomIdentity, token:string) {
      const result = queue.then(async () => {
        if (stopping) throw new Error('Closing room');
        const who = admission.revalidate ? await admission.revalidate() : await authorize(token,documentId);
        if (!who || who.id !== admission.id || who.workspaceId !== admission.workspaceId ||
            (request.method !== 'GET' && (!who.write || !admission.write))) return {status:403};
        return historyRequest({directory:storage?.directory ?? options.directory,doc,tag,head,request,
          project:storage?.validate,operations,commit:async (id,digest,update) => {
            const candidate = classifyUpdate(doc,update,storage?.validate);
            if (candidate.kind === 'invalid') throw new Error('Invalid restore');
            return commit(who,id,digest,update,2,candidate.data);
          }});
      });
      queue = result.then(()=>{},()=>{});
      return result;
    }

    async function broadcastPresence(frame: SyncWireFrame, except: Peer) {
      const identities = presence.identities();
      await Promise.all([...peers].map(async member => {
        if (!member.synced || !await principal(member)) return;
        send(member,identities);
        if (member !== except) send(member,frame);
      }));
    }

    async function receive(peer: Peer, payload: Uint8Array) {
      const identity = await principal(peer);
      if (!identity || stopping) return;
      const frame = decode(payload);
      switch (frame.type) {
        case 'awareness': {
          if (!peer.synced) return;
          let update;
          try { update = presence.receive(peer,identity.actorId,frame.update); }
          catch {
            if (++peer.badAwareness >= 3) peer.ws.close(1008,'invalid awareness');
            break;
          }
          if (update) await broadcastPresence(update,peer);
          break;
        }
        case 'queryAwareness': {
          const snapshot = presence.snapshot();
          if (peer.synced && snapshot) { send(peer,presence.identities()); send(peer,snapshot); }
          break;
        }
        case 'operation': if (peer.ws.protocol==='blok-sync.v2') await operation(peer,identity,frame); break;
        case 'syncStep1': {
          let update;
          try { update = encodeStateAsUpdate(doc,frame.stateVector); } catch { return; }
          send(peer,{type:'syncStep2',update});
          send(peer,{type:'syncStep1',stateVector:encodeStateVector(doc)});
          peer.synced = true;
          break;
        }
        // Section 10: an outer type this version does not know is ACCEPTED AND
        // IGNORED, never refused — a newer peer must not lose its session over it.
        case 'unknown': break;
        // Section 5 leaves the disposition of a malformed frame to the implementation:
        // the only closes it fixes are the 1008 of section 7 and the 4503 of section 6.1,
        // and the close table of section 2 names none for an undecodable frame. So the
        // room never acts on it, keeps the socket — section 9 still owes a v1 or stock
        // y-websocket reader its session — and says so once, since the reason can carry
        // bytes the sender chose and a flood must not become a flood of logs.
        case 'malformed': {
          if (!peer.reportedMalformed) {
            peer.reportedMalformed = true;
            console.warn(`Ignored a malformed collaboration frame: ${frame.reason.slice(0,120)}`);
          }
          break;
        }
        case 'syncStep2':
        case 'update': {
          if (peer.ws.protocol==='blok-sync.v2') { peer.ws.close(1008,'raw write on a v2 session'); break; }
          if (!identity.write || !peer.synced || frame.update.length>MAX_APPEND_BYTES) break;
          const update=frame.update;
          const candidate=classifyUpdate(doc,update,storage?.validate);
          if (candidate.kind==='changed') await commit(identity,randomBytes(16).toString('hex'),
            createHash('sha256').update(update).digest(),update,1,candidate.data,peer);
          break;
        }
      }
    }

    function enqueue(peer: Peer, data: RawData, binary: boolean) {
      // Two different refusals shared one reason: a stopping room is not a protocol
      // error, and 1003 told the peer its own frame was at fault. The transport
      // contract fixes the wording for the real one.
      if (stopping) { peer.ws.close(4503,'room unavailable'); return; }
      if (!binary) { peer.ws.close(1003,'binary frames only'); return; }
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

    function connect(ws: WebSocket, ticket: string, identity: RoomIdentity) {
      if (stopping) { ws.close(4503, 'room unavailable'); return; }
      const peer: Peer = {ws,ticket,admission:identity,synced:false,badAwareness:0,reportedMalformed:false,alive:true,
        ping:() => ws.ping(), terminate:() => ws.terminate()};
      peers.add(peer);
      ws.on('pong', () => { peer.alive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        peers.delete(peer);
        access.invalidate(peer);
        queue = queue.then(async () => {
          const removed = presence.leave(peer);
          if (removed && !stopping) await broadcastPresence(removed,peer);
        }).catch(() => {});
      });
      ws.on('message', (data,binary) => enqueue(peer,data,binary));
      send(peer,{type:'control',tag});
      send(peer,{type:'limits',maxMessageBytes:MAX_APPEND_BYTES});
    }

    function recheck() {
      const checked = queue.then(async () => {
        if (stopping) throw new Error('Room is stopping');
        access.invalidate();
        await Promise.all(Array.from(peers, principal));
      });
      queue = checked.catch(() => {});
      return checked;
    }

    timer = setInterval(async () => {
      if (sweeping || stopping) return;
      sweeping = true;
      try { await Promise.all(Array.from(peers, principal)); } finally { sweeping = false; }
    }, 1000);
    timer.unref();
    keepalive = setInterval(() => {
      if (stopping) return;
      // A copy: terminate() closes the socket, and the close handler leaves `peers`.
      sweepHeartbeat([...peers]);
    }, HEARTBEAT_MS);
    keepalive.unref();
    return { connect, apply, history, recheck, close: stop, available: () => !stopping };
  } catch (error) {
    await stop();
    throw error;
  }
}
