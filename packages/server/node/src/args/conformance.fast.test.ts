/**
 * The conformance-only flags, and the seam one of them opens.
 *
 * Four of them were accepted and then dropped on the floor: the generic
 * `--conformance-` branch swallowed them, `ParsedConformanceArgs` never
 * carried them, and nothing downstream could read them. The first half of
 * this file holds the parser to them.
 *
 * The second half holds the one whose effect this host owns:
 * `--conformance-stamp-authority`, which makes the server — not the caller —
 * say who wrote a block and when. Its wiring lives in the edit route, so the
 * route is driven here rather than in a file of its own, this being the test
 * home of the flags' lot.
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';

import { DocumentStore } from '../../../../../src/components/modules/yjs/document-store.ts';
import { YBlockSerializer } from '../../../../../src/components/modules/yjs/serializer.ts';
import type { YjsOutputBlockData } from '../../../../../src/components/modules/yjs/serializer.ts';
import { htmlToSegmentsNode } from '../../../../../src/view/rich-text-node.ts';
import type { EditCommand, EditOutcome } from '../collab/room/document-room.ts';
import { createCollabHttp, IDEMPOTENCY_KEY } from '../host/collab-http.ts';
import type { HostAppOptions } from '../host/options.ts';
import { Headers } from '../http/headers.ts';
import type { Request } from '../http/request.ts';
import type { ResponseWriter } from '../http/response.ts';
import { defaultTestHostOptions } from '../test-kit/invoke-host.ts';
import { parseConformanceArguments } from './conformance.ts';

describe('@fast the conformance flags of the Node host', () => {
  it('carries each of the four switches the generic branch used to swallow', () => {
    const parsed = parseConformanceArguments([
      '--conformance-record-notes',
      '--conformance-stamp-authority',
      '--conformance-restore-guards',
      '--conformance-restore-trashes-pages',
      '--auth',
      'none',
    ]);

    expect([parsed.recordNotes, parsed.stampAuthority, parsed.restoreGuards, parsed.restoreTrashesPages])
      .toEqual([true, true, true, true]);
    expect(parsed.argv).toEqual(['--auth', 'none']);
    expect(parsed.err).toBe('');
  });

  it('leaves every switch off when the command line names none of them', () => {
    const parsed = parseConformanceArguments(['--auth', 'none']);

    expect([parsed.recordNotes, parsed.stampAuthority, parsed.restoreGuards, parsed.restoreTrashesPages])
      .toEqual([false, false, false, false]);
  });

  it('turns on only the switch it was given', () => {
    const parsed = parseConformanceArguments(['--conformance-stamp-authority']);

    expect([parsed.recordNotes, parsed.stampAuthority, parsed.restoreGuards, parsed.restoreTrashesPages])
      .toEqual([false, true, false, false]);
  });

  it('still swallows a --conformance- flag nothing knows, rather than handing it to the host parser', () => {
    const parsed = parseConformanceArguments(['--conformance-nothing-knows-this', '--auth', 'none']);

    expect(parsed.argv).toEqual(['--auth', 'none']);
    expect(parsed.err).toBe('');
  });

  it('keeps reading the flags that already worked', () => {
    const parsed = parseConformanceArguments([
      '--conformance-journal',
      '--conformance-origin=http://127.0.0.1:4100',
      '--conformance-record-notes',
    ]);

    expect([parsed.journal, parsed.origin, parsed.port]).toEqual([true, 'http://127.0.0.1:4100', 4100]);
    expect(parsed.recordNotes).toBe(true);
  });

  it('names a bad origin even when a switch rides beside it', () => {
    const parsed = parseConformanceArguments(['--conformance-stamp-authority', '--conformance-origin=http://evil/']);

    expect(parsed.err).toContain('must be exactly http://127.0.0.1:PORT');
    expect(parsed.stampAuthority).toBe(false);
  });
});

const SECRET = 'a'.repeat(48);
const DOC = 'd';

/** A pass naming `user`, the way the sync tests mint one. */
function ticketFor(user: string): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    user,
    doc: DOC,
    write: true,
    exp: Math.ceil(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signed = `${header}.${payload}`;

  return `${signed}.${createHmac('sha256', SECRET).update(signed).digest('base64url')}`;
}

function fakeRequest(headers: Record<string, string>, body: string): Request {
  const bag = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    bag.set(name, value);
  }
  const bytes = new TextEncoder().encode(body);

  return {
    method: () => 'POST',
    headers: () => bag,
    setBodyLimit: () => {},
    takeBody: () => {
      // The door reads in chunks and counts as it goes, so the double has to
      // drain the same way: one hand-off, then end-of-body.
      let sent = false;

      return {
        read: async (into: Uint8Array) => {
          if (sent) return 0;
          sent = true;
          into.set(bytes);

          return bytes.length;
        },
        readToEnd: async (chunks: Uint8Array[]) => {
          chunks.push(bytes);
        },
      };
    },
  } as unknown as Request;
}

function fakeResponse(): { writer: ResponseWriter; written: { status: number } } {
  const bag = new Headers();
  const written = { status: 0 };
  const writer = {
    headersMut: () => bag,
    headers: () => bag,
    setStatus: (status: number) => {
      written.status = status;
    },
    start: async (status: number) => {
      written.status = status;
    },
    write: async () => {},
  } as unknown as ResponseWriter;

  return { writer, written };
}

const newStore = (): DocumentStore =>
  new DocumentStore(new YBlockSerializer({ htmlToSegments: htmlToSegmentsNode }));

/** A live document already holding `blocks`, as the room holds one. */
function docHolding(blocks: unknown[]): Doc {
  const store = newStore();

  store.fromJSON(blocks as YjsOutputBlockData[]);
  const doc = new Doc();

  applyUpdate(doc, store.encodeStateAsUpdate());
  store.destroy();

  return doc;
}

/** What the command this host built writes into a document holding `blocks`. */
function blocksAfter(command: EditCommand, blocks: unknown[]): YjsOutputBlockData[] {
  const build = command.build;

  if (build === undefined) throw new Error('the edit route built no update');
  const doc = docHolding(blocks);

  applyUpdate(doc, build(doc));
  const store = newStore();

  store.applyRemoteUpdate(encodeStateAsUpdate(doc));
  const written = store.toJSON();

  store.destroy();
  doc.destroy();

  return written;
}

/** Posts one edit and hands back the command the room was given. */
async function posted(options: HostAppOptions, body: string, user = 'u1'): Promise<EditCommand> {
  const taken: EditCommand[] = [];
  const rooms = {
    apply: async (_doc: string, _ticket: string, command: EditCommand): Promise<EditOutcome> => {
      taken.push(command);

      return { ok: true, lineage: '0'.repeat(32), sequence: 1n };
    },
  };
  const collab = createCollabHttp(options, undefined, rooms);
  const request = fakeRequest(
    { [IDEMPOTENCY_KEY]: `k${taken.length}${user}`, authorization: `Bearer ${ticketFor(user)}` },
    body,
  );
  const { writer, written } = fakeResponse();

  await collab.edit(request, writer, { doc: DOC });
  expect(written.status).toBe(204);
  const [command] = taken;

  if (command === undefined) throw new Error('the edit never reached the room');

  return command;
}

describe('@fast stamp authority on POST /sync/{doc}/edit', () => {
  const host = (stamping: boolean): HostAppOptions => ({
    ...defaultTestHostOptions(),
    auth: 'ticket',
    secret: SECRET,
    collabEnabled: true,
    collabStampAuthority: stamping,
  });

  const INSERT = '{"ops":[{"op":"insert","id":"b1","block":{"type":"paragraph","data":{},'
    + '"createdAt":11,"createdBy":"them","createdWith":"agent:them:x",'
    + '"lastEditedAt":12,"lastEditedBy":"them","lastEditedWith":"agent:them:y"}}]}';

  it('keeps the caller\'s own stamps while the flag is off', async () => {
    const command = await posted(host(false), INSERT);

    expect(blocksAfter(command, [])[0]).toEqual({
      id: 'b1',
      type: 'paragraph',
      data: { text: '' },
      createdAt: 11,
      createdBy: 'them',
      createdWith: 'agent:them:x',
      lastEditedAt: 12,
      lastEditedBy: 'them',
      lastEditedWith: 'agent:them:y',
    });
  });

  it('takes an insert\'s six stamps off the caller and writes its own', async () => {
    const before = Date.now();
    const command = await posted(host(true), INSERT);
    const written = blocksAfter(command, [])[0];

    expect([written?.createdBy, written?.lastEditedBy]).toEqual(['u1', 'u1']);
    expect(written?.createdWith).toBeUndefined();
    expect(written?.lastEditedWith).toBeUndefined();
    expect(written?.createdAt).toBe(written?.lastEditedAt);
    expect(Number(written?.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it('digests the request as it was sent, so a retry of that body still matches', async () => {
    const plain = await posted(host(false), INSERT);
    const stamping = await posted(host(true), INSERT);
    // The body as sent, in the canonical spelling: the stamps the caller
    // wrote are in it, and the ones the server writes instead are not.
    const canonical = createHash('sha256').update(
      '{"ops":[{"after":null,"block":{"createdAt":11,"createdBy":"them","createdWith":"agent:them:x",'
      + '"data":{},"lastEditedAt":12,"lastEditedBy":"them","lastEditedWith":"agent:them:y",'
      + '"type":"paragraph"},"id":"b1","op":"insert","parent":null}]}',
      'utf8',
    ).digest();

    expect(Buffer.from(stamping.digest)).toEqual(Buffer.from(plain.digest));
    expect(Buffer.from(stamping.digest)).toEqual(canonical);
  });

  /**
   * The credit on an update is written ONCE. `stampAuthority` offers a second
   * `setMetadata` op behind every update because the Go applier credits
   * nobody; this host's applier does, so only one of the two may write.
   */
  it('credits an update once, at the same instant the insert beside it is stamped', async () => {
    const command = await posted(
      host(true),
      '{"ops":[{"op":"insert","id":"b2","block":{"type":"paragraph","data":{}}},'
      + '{"op":"update","id":"a","data":{"text":"two"}}]}',
    );
    const written = blocksAfter(command, [
      { id: 'a', type: 'paragraph', data: { text: 'one' }, lastEditedAt: 1, lastEditedBy: 'them' },
    ]);
    const updated = written.find((block) => block.id === 'a');
    const inserted = written.find((block) => block.id === 'b2');

    expect([updated?.lastEditedBy, updated?.lastEditedWith]).toEqual(['u1', undefined]);
    expect(updated?.lastEditedAt).toBe(inserted?.createdAt);
    expect(updated?.data).toEqual({ text: 'two' });
  });

  it('credits nobody when the request carries no pass to name one', async () => {
    const options = { ...host(true), auth: 'none' };
    const command = await posted(options, '{"ops":[{"op":"update","id":"a","data":{"text":"two"}}]}');
    const [written] = blocksAfter(command, [
      { id: 'a', type: 'paragraph', data: { text: 'one' }, lastEditedAt: 1, lastEditedBy: 'them' },
    ]);

    expect([written?.lastEditedAt, written?.lastEditedBy]).toEqual([1, 'them']);
  });
});
