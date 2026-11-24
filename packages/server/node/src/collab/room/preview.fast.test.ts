import { appendFile, cp, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import type { SyncWireFrame } from '../../../../../../src/components/modules/collaboration/types.ts';
import { appendJournal } from '../journal/append.ts';
import { signedRoomTickets, startJournalRoom } from './preview.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/go-journal-rich', import.meta.url));
const origin = 'http://localhost:18098';
const lineage = '00112233445566778899aabbccddeeff';
async function client(url: string, token: string) {
  const ws = new WebSocket(url,['blok-sync.v2','blok-sync.v1',token],{origin});
  const inbox: ReturnType<typeof decode>[] = [];
  let wake: (() => void) | undefined;
  ws.on('message', data => {
    inbox.push(decode(new Uint8Array(data as Buffer)));
    wake?.();
  });
  const closed = new Promise<number>(ok => ws.once('close',code => ok(code)));
  await new Promise<void>((ok,fail) => { ws.once('open',ok); ws.once('error',fail); });
  async function next() {
    if (!inbox.length) await new Promise<void>((ok,fail) => {
      const timer = setTimeout(() => fail(new Error('Missing preview frame')),2500);
      wake = () => { clearTimeout(timer); wake = undefined; ok(); };
    });
    return inbox.shift()!;
  }
  const send = (frame: SyncWireFrame) => ws.send(encode(frame));
  expect(await next()).toEqual({type:'control',tag:{lineage,format:2,epoch:7}});
  expect(await next()).toMatchObject({type:'limits'});
  const doc = new Doc();
  ws.once('close',() => doc.destroy());
  async function sync() {
    send({type:'syncStep1',stateVector:encodeStateVector(doc)});
    const step = await next();
    expect(step.type).toBe('syncStep2');
    if (step.type === 'syncStep2') applyUpdate(doc,step.update);
    expect((await next()).type).toBe('syncStep1');
  }
  return {ws,doc,sync,closed,send,next};
}

describe.skipIf(!['linux','darwin'].includes(process.platform))('isolated v2 WebSocket room', () => {
  let dir: string;
  let room: Awaited<ReturnType<typeof startJournalRoom>>;
  let revoked: Set<string>;
  const recheckSecret = 'room-api-test'.repeat(3);
  async function listen() {
    return startJournalRoom({ directory:dir, documentId:'preview-page',recheckSecret,allowedOrigins:new Set([origin]),
      authorize: async token => ['editor','viewer'].includes(token) && !revoked.has(token) ? {id:token,write:token==='editor'} : null });
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(),'blok-ws-'));
    await cp(fixture,dir,{recursive:true});
    revoked = new Set();
    room = await listen();
  });
  afterEach(async () => { vi.restoreAllMocks(); await room?.close(); await rm(dir,{recursive:true,force:true}); });

  it('syncs two real clients, broadcasts and acknowledges durable bytes, and deduplicates after restart', async () => {
    const a = await client(room.url,'editor');
    const b = await client(room.url,'viewer');
    await a.sync();
    await b.sync();
    const before = encodeStateVector(a.doc);
    a.doc.getText('room').insert(0,'replayed');
    const operation = {type:'operation' as const,lineage,operationId:randomBytes(16).toString('hex'),update:encodeStateAsUpdate(a.doc,before)};
    a.send(operation);
    const relay = await b.next();
    expect(relay.type).toBe('update');
    if (relay.type === 'update') applyUpdate(b.doc,relay.update);
    expect(b.doc.getText('room').toString()).toBe('replayed');
    expect((await a.next()).type).toBe('update');
    expect(await a.next()).toMatchObject({type:'acknowledgement',operationId:operation.operationId,serverSequence:'4'});
    b.send(operation);
    expect(await b.next()).toMatchObject({type:'rejection',code:'read-only'});
    await expect(appendJournal(dir,{expectedLineage:lineage,expectedThrough:4n,operationId:'0'.repeat(32),
      actorId:null,source:0,update:operation.update})).rejects.toMatchObject({code:'JOURNAL_BUSY'});
    await room.close();
    room = await listen();
    const reopened = await client(room.url,'editor');
    await reopened.sync();
    expect(reopened.doc.getText('room').toString()).toBe('replayed');
    reopened.send(operation);
    expect(await reopened.next()).toMatchObject({type:'acknowledgement',serverSequence:'4'});
    reopened.send({...operation,update:Uint8Array.of(0,0)});
    expect(await reopened.next()).toMatchObject({type:'rejection',code:'operation-id-conflict'});
    reopened.send({...operation,lineage:'f'.repeat(32)});
    expect(await reopened.next()).toMatchObject({type:'rejection',code:'lineage-mismatch'});
  });
  it('checks authorization on upgrade, raw writes and later revocation', async () => {
    await expect(client(room.url,'invalid')).rejects.toThrow('403');
    const a = await client(room.url,'editor');
    a.send({type:'syncStep2',update:Uint8Array.of(0,0)});
    expect(await a.closed).toBe(1008);
    const b = await client(room.url,'viewer');
    revoked.add('viewer');
    b.send({type:'syncStep1',stateVector:Uint8Array.of(0)});
    expect(await b.closed).toBe(4403);
  });
  it('stabilizes a torn tail before serving a restarted client', async () => {
    await room.close();
    const path = join(dir,'journal.1.1');
    const previous = (await stat(path)).size;
    await appendFile(path,Buffer.from([0x00,0x01]));
    room = await listen();
    expect((await stat(path)).size).toBe(previous);
    const a = await client(room.url,'editor');
    await a.sync();
  });
  it('revalidates an idle connection on an authenticated access notification', async () => {
    const viewer = await client(room.url, 'viewer');
    await viewer.sync();
    const url = new URL('/internal/room/recheck-access', room.url);
    url.protocol = 'http:';
    expect((await fetch(url,{method:'POST'})).status).toBe(401);
    revoked.add('viewer');
    const result = await fetch(url,{method:'POST', headers:{Authorization:'Bearer '+recheckSecret}});
    expect(result.status).toBe(204);
    expect(await viewer.closed).toBe(4403);
  });

  it('refuses a foreign origin even with an authorized ticket', async () => {
    const ws = new WebSocket(room.url,['blok-sync.v2','editor'],{origin:'https://other.invalid'});
    await expect(new Promise<void>((ok,fail) => { ws.once('open',ok); ws.once('error',fail); })).rejects.toThrow('403');
  });
  it('sends no receipt for a failed fsync, closes all clients and permits retry after restart', async () => {
    const a = await client(room.url,'editor');
    const b = await client(room.url,'viewer');
    await a.sync();
    await b.sync();
    const old = encodeStateVector(a.doc);
    a.doc.getText('room').insert(0,'retry me');
    const operation = {type:'operation' as const,lineage,operationId:'e'.repeat(32),update:encodeStateAsUpdate(a.doc,old)};
    const file = await open(join(dir,'journal.1.1'));
    const prototype = Object.getPrototypeOf(file) as typeof file;
    await file.close();
    vi.spyOn(prototype,'sync').mockRejectedValueOnce(new Error('test flush failure'));
    a.send(operation);
    expect(await a.closed).toBe(4503);
    expect(await b.closed).toBe(4503);
    await room.close();
    room = await listen();
    const again = await client(room.url,'editor');
    await again.sync();
    expect(again.doc.getText('room').toString()).toBe('');
    again.send(operation);
    expect((await again.next()).type).toBe('update');
    expect(await again.next()).toMatchObject({type:'acknowledgement',serverSequence:'4'});
  });
});

it('checks the preview signature, expiry and exact document before granting a role', async () => {
  const secret = 's'.repeat(32);
  const verify = signedRoomTickets(secret);
  const token = (doc: string, exp: number, key = secret) => {
    const body = Buffer.from(JSON.stringify({user:'viewer',doc,write:false,exp})).toString('base64url');
    const prefix = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + body;
    return prefix + '.' + createHmac('sha256',key).update(prefix).digest('base64url');
  };
  const later = Math.floor(Date.now()/1000)+60;
  expect(await verify(token('doc',later),'doc')).toEqual({id:'viewer',write:false});
  expect(await verify(token('other',later),'doc')).toBeNull();
  expect(await verify(token('doc',0),'doc')).toBeNull();
  expect(await verify(token('doc',later,'wrong'),'doc')).toBeNull();
});
