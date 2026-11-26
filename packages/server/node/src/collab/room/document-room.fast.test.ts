import { cp, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from '../../../../../../src/components/modules/collaboration/sync-wire.ts';
import type { SyncWireFrame } from '../../../../../../src/components/modules/collaboration/types.ts';
import { startJournalRoom } from './preview.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/go-journal-rich', import.meta.url));
const origin = 'http://localhost:18099';
const lineage = '00112233445566778899aabbccddeeff';

/** Section 6.1 and section 11.2 S4: the exact reason every member must read. */
const COMMIT_UNAVAILABLE_REASON = 'commit unavailable, retry';

/**
 * A type-102 frame whose metadata section is not UTF-8 and whose update section
 * is empty. Section 5 pins it to rule 4 (the lowest-numbered rule it breaks),
 * and it is the worked example the section spells out byte for byte.
 */
const MALFORMED_OPERATION = Uint8Array.of(0x66, 0x01, 0xff, 0x00);

/** Type 105: an outer type this version does not know. Section 10: accept and ignore. */
const UNKNOWN_TYPE = Uint8Array.of(105, 0x00);

async function client(url: string, token: string) {
  const ws = new WebSocket(url, ['blok-sync.v2', 'blok-sync.v1', token], { origin });
  const inbox: ReturnType<typeof decode>[] = [];
  let wake: (() => void) | undefined;
  ws.on('message', data => {
    inbox.push(decode(new Uint8Array(data as Buffer)));
    wake?.();
  });
  const closed = new Promise<{ code: number; reason: string }>(ok =>
    ws.once('close', (code: number, reason: Buffer) => ok({ code, reason: reason.toString() })));
  await new Promise<void>((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
  async function next() {
    for (;;) {
      if (!inbox.length) await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('Missing room frame')), 2500);
        wake = () => { clearTimeout(timer); wake = undefined; ok(); };
      });
      const frame = inbox.shift();

      // A queryAwareness is the room prompting every member the moment
      // another one joins, not an answer to anything this client asked.
      if (frame !== undefined && frame.type !== 'queryAwareness') return frame;
    }
  }
  const send = (frame: SyncWireFrame) => ws.send(encode(frame));
  expect(await next()).toEqual({ type: 'control', tag: { lineage, format: 2, epoch: 7 } });
  expect(await next()).toMatchObject({ type: 'limits' });
  // Sent on every join, empty or not, so a reconnect overwrites the map the
  // client still holds from its last session.
  expect(await next()).toMatchObject({ type: 'identities' });
  const doc = new Doc();
  ws.once('close', () => doc.destroy());
  async function sync() {
    send({ type: 'syncStep1', stateVector: encodeStateVector(doc) });
    const step = await next();
    expect(step.type).toBe('syncStep2');
    if (step.type === 'syncStep2') applyUpdate(doc, step.update);
    expect((await next()).type).toBe('syncStep1');
  }
  return { ws, doc, sync, closed, send, next };
}

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('document room protocol dispositions', () => {
  let dir: string;
  let room: Awaited<ReturnType<typeof startJournalRoom>>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blok-room-'));
    await cp(fixture, dir, { recursive: true });
    room = await startJournalRoom({ directory: dir, documentId: 'protocol-page', allowedOrigins: new Set([origin]),
      authorize: async token => ['editor', 'viewer'].includes(token) ? { id: token, write: token === 'editor' } : null });
  });
  afterEach(async () => { vi.restoreAllMocks(); await room?.close(); await rm(dir, { recursive: true, force: true }); });

  it('closes every member with the reason section 6.1 names when a commit is not confirmed', async () => {
    const a = await client(room.url, 'editor');
    const b = await client(room.url, 'viewer');
    await a.sync();
    await b.sync();
    const before = encodeStateVector(a.doc);
    a.doc.getText('room').insert(0, 'unconfirmed');
    const file = await open(join(dir, 'journal.1.1'));
    const prototype = Object.getPrototypeOf(file) as typeof file;
    await file.close();
    vi.spyOn(prototype, 'sync').mockRejectedValueOnce(new Error('test flush failure'));
    a.send({ type: 'operation', lineage, operationId: randomBytes(16).toString('hex'),
      update: encodeStateAsUpdate(a.doc, before) });

    expect(await a.closed).toEqual({ code: 4503, reason: COMMIT_UNAVAILABLE_REASON });
    expect(await b.closed).toEqual({ code: 4503, reason: COMMIT_UNAVAILABLE_REASON });
  });

  it('accepts and ignores a frame of an unknown outer type', async () => {
    const peer = await client(room.url, 'editor');
    expect(decode(UNKNOWN_TYPE)).toEqual({ type: 'unknown', messageType: 105 });

    peer.ws.send(Buffer.from(UNKNOWN_TYPE));
    await peer.sync();

    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('ignores a malformed frame, keeps the session and reports it once per member', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const peer = await client(room.url, 'editor');
    expect(decode(MALFORMED_OPERATION)).toMatchObject({ type: 'malformed', rule: 4 });

    peer.ws.send(Buffer.from(MALFORMED_OPERATION));
    peer.ws.send(Buffer.from(MALFORMED_OPERATION));
    await peer.sync();

    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('malformed');
  });
});
