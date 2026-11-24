import { createHash } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { decode, encode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import type { SyncWireFrame } from '../../../../../../src/components/modules/collaboration/types.ts';
import { preparePageStorage, type PageStorage } from './page-storage.ts';
import { acquireJournalWriter, MAX_APPEND_BYTES } from '../journal/append.ts';

import type { RoomIdentity, RoomOptions } from './preview.ts';

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

/** Own the journal lease while this document is loaded. */
export async function openDocumentRoom(options: RoomOptions) {
  const { documentId, allowedOrigins, authorize } = options;
  if (!documentId || !allowedOrigins.size) throw new Error('A document ID and allowed origins are required');
  const storage = options.projection && await preparePageStorage(options.directory, documentId, options.projection.origin, options.projection.secret);
  const writer = await acquireJournalWriter(storage?.directory ?? options.directory);
  const doc = new Doc();
  const operations = new Map<string, { digest:Buffer; sequence:bigint }>();
  const peers = new Set<Peer>();
  let queue = Promise.resolve();
  let stopping = false;
  let pendingBytes = 0;
  let pendingFrames = 0;
  let closing: Promise<void> | undefined;
  let sweeping = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function principal(peer: Peer): Promise<RoomIdentity | null> {
    let identity: RoomIdentity | null;
    try { identity = peer.admission.revalidate ? await peer.admission.revalidate() : await authorize(peer.ticket, documentId); }
    catch { identity = null; }
    if (identity?.id === peer.admission.id && identity.workspaceId === peer.admission.workspaceId &&
        peer.ws.readyState === WebSocket.OPEN) return identity;
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.close(4403, 'forbidden');
    return null;
  }
  function stop() {
    if (closing) return closing;
    stopping = true;
    clearInterval(timer);
    for (const peer of peers) peer.ws.terminate();
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
        clearInterval(timer);
        // Reopen from disk only after the old room releases its lease.
        setImmediate(() => { void stop().catch(() => {}); });
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

    function connect(ws: WebSocket, ticket: string, identity: RoomIdentity) {
      if (stopping) { ws.close(4503, 'room unavailable'); return; }
      const peer: Peer = {ws,ticket,admission:identity,synced:false};
      peers.add(peer);
      ws.on('error', () => ws.terminate());
      ws.on('close', () => peers.delete(peer));
      ws.on('message', (data,binary) => enqueue(peer,data,binary));
      send(peer,{type:'control',tag});
      send(peer,{type:'limits',maxMessageBytes:MAX_APPEND_BYTES});
    }

    function recheck() {
      const checked = queue.then(async () => {
        if (stopping) throw new Error('Room is stopping');
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
    return { connect, recheck, close: stop, available: () => !stopping };
  } catch (error) {
    await stop();
    throw error;
  }
}
