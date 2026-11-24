import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { decode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import { startWorkspaceRooms } from './preview.ts';
import { pageDirectory } from './page-seed.ts';
import { acquireJournalWriter } from '../journal/append.ts';

it.skipIf(!['darwin','linux'].includes(process.platform))('opens only authorized pages, shares one writer across concurrent connections, then drains its lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blok-workspace-'));
  const origin = 'http://localhost';
  const internalSecret = 'workspace-test'.repeat(3);
  const snapshots = new Map<string, { data: null; version: string; sequence: string | null; lineage: string | null }>();
  const loads = new Set<string>();
  const unavailable = new Set(['temporarily-unavailable']);
  const projection = createServer((req,res) => {
    const id = req.url!.split('/').pop()!;
    if (req.headers.authorization !== 'Bearer '+internalSecret) { res.writeHead(403).end(); return; }
    if (unavailable.has(id)) { res.writeHead(503).end(); return; }
    res.setHeader('Content-Type','application/json');
    if (req.method === 'GET') {
      loads.add(id);
      res.end(JSON.stringify(snapshots.get(id) ?? {data:null,version:'0',lineage:null,sequence:null}));
    } else if (req.method === 'PUT') {
      const previous = snapshots.get(id)?.version ?? '0';
      if (req.headers['blok-doc-version'] !== previous) { res.writeHead(409).end(); return; }
      const version = String(Number(previous)+1);
      snapshots.set(id,{data:null,version,sequence:String(req.headers['blok-doc-sequence']),lineage:String(req.headers['blok-doc-lineage'])});
      res.end(JSON.stringify({version}));
    } else res.writeHead(405).end();
  });
  projection.listen(0,'127.0.0.1');
  await once(projection, 'listening');
  const address = projection.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP');
  const host = await startWorkspaceRooms({directory,workspaceId:'selected',allowedOrigins:new Set([origin]),recheckSecret:internalSecret,
    projection:{origin:'http://127.0.0.1:'+address.port,secret:internalSecret},
    authorize:async (token,id) => token === 'valid' ? {id:'session',write:true,workspaceId:id==='foreign'?'other':'selected'} : null});
  const clients = new Set<WebSocket>();
  async function open(id: string, token = 'valid') {
    const ws = new WebSocket(host.url+id,['blok-sync.v2',token],{origin});
    clients.add(ws);
    ws.once('close', () => clients.delete(ws));
    const [data] = await once(ws,'message');
    const frame = decode(new Uint8Array(data));
    if (frame.type !== 'control') throw new Error('Expected control frame');
    return {ws,tag:frame.tag};
  }
  async function close(ws: WebSocket) {
    const closed = once(ws,'close');
    ws.close();
    await closed;
  }
  try {
    expect(await readdir(directory)).toEqual([]);
    await expect(open('foreign')).rejects.toThrow('403');
    await expect(open('a','invalid')).rejects.toThrow('403');
    expect(await readdir(directory)).toEqual([]);
    const [first,second,other] = await Promise.all([open('a'),open('a'),open('b')]);
    expect(first.tag).toEqual(second.tag);
    expect(other.tag.lineage).not.toBe(first.tag.lineage);
    expect(loads).toEqual(new Set(['a','b']));
    expect(snapshots.get('a')?.version).toBe('1');
    expect(snapshots.get('b')?.version).toBe('1');
    await close(first.ws);
    await expect(acquireJournalWriter(pageDirectory(directory,'a'))).rejects.toThrow();
    await close(second.ws);
    await expect.poll(async () => {
      try {
        const writer = await acquireJournalWriter(pageDirectory(directory,'a'));
        await writer.close();
        return true;
      } catch { return false; }
    }).toBe(true);
    const restored = await open('a');
    expect(restored.tag).toEqual(first.tag);
    expect(snapshots.get('a')?.version).toBe('1');
    await expect(open('temporarily-unavailable')).rejects.toThrow('503');
    unavailable.clear();
    const recovered = await open('temporarily-unavailable');
    expect(recovered.tag.lineage).not.toBe(other.tag.lineage);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const client of clients) client.terminate();
    await host.close();
    await new Promise<void>(resolve => projection.close(() => resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});
