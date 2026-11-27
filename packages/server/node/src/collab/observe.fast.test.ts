/**
 * What the sidecar keeps when something goes wrong, and — just as load-bearing
 * — what it keeps quiet about. The production machine boots off an SD card, so
 * an ordinary event has to write no line at all.
 *
 * Every value is quoted. The line escaping in log.ts stops a document id
 * forging a second RECORD; quoting is what stops it forging a second FIELD.
 */
import { describe, expect, it } from 'vitest';

import type { CollabLog } from './log.ts';
import { logHttpRefusal, logOutboundWait, logSocketClose } from './observe.ts';

function recorder(): { lines: Array<[string, string]>; log: CollabLog } {
  const lines: Array<[string, string]> = [];

  return { lines, log: (message, level) => { lines.push([level, message]); } };
}

describe('@fast socket close lines', () => {
  it('names the code, the reason, the document and the actor', () => {
    const { lines, log } = recorder();

    logSocketClose(log, { doc: 'd-1', actor: 'u-7', code: 1008, reason: 'room queue overflow' });

    expect(lines).toEqual([[
      'warning',
      'collab: socket closed code=1008 reason="room queue overflow" doc="d-1" actor="u-7"',
    ]]);
  });

  it('says nothing for a clean close', () => {
    const { lines, log } = recorder();

    logSocketClose(log, { doc: 'd-1', code: 1000, reason: '' });

    expect(lines).toEqual([]);
  });

  it('says nothing for a close that carries no code', () => {
    const { lines, log } = recorder();

    logSocketClose(log, { doc: 'd-1', code: undefined, reason: '' });

    expect(lines).toEqual([]);
  });

  it('calls the room own fault an error', () => {
    const { lines, log } = recorder();

    logSocketClose(log, { doc: 'd-1', code: 1011, reason: 'room error' });

    expect(lines[0]?.[0]).toBe('error');
  });

  it('leaves the actor out when the close named none', () => {
    const { lines, log } = recorder();

    logSocketClose(log, { doc: 'd-1', code: 4401, reason: 'no pass' });

    expect(lines[0]?.[1]).toBe('collab: socket closed code=4401 reason="no pass" doc="d-1"');
  });

  it('quotes a document id that carries a quote of its own', () => {
    const { lines, log } = recorder();

    logSocketClose(log, { doc: 'a" actor="root', code: 1008, reason: 'malformed awareness' });

    expect(lines[0]?.[1]).toBe(
      'collab: socket closed code=1008 reason="malformed awareness" doc="a\\" actor=\\"root"',
    );
  });
});

describe('@fast collaboration refusal lines', () => {
  it('names the status, the reason and the request', () => {
    const { lines, log } = recorder();

    logHttpRefusal(log, {
      method: 'POST',
      path: '/api/blok/sync/d-1/edit',
      status: 422,
      reason: 'collab: the edit was refused.\n',
    });

    expect(lines).toEqual([[
      'warning',
      'collab: request refused status=422 reason="collab: the edit was refused." '
        + 'method="POST" path="/api/blok/sync/d-1/edit"',
    ]]);
  });

  it('calls a refusal this host owns an error', () => {
    const { lines, log } = recorder();

    logHttpRefusal(log, { method: 'GET', path: '/x', status: 503, reason: 'unavailable\n' });

    expect(lines[0]?.[0]).toBe('error');
  });

  it('says nothing about an answer that refused nothing', () => {
    const { lines, log } = recorder();

    logHttpRefusal(log, { method: 'GET', path: '/x', status: 200, reason: '' });
    logHttpRefusal(log, { method: 'GET', path: '/x', status: 302, reason: '' });

    expect(lines).toEqual([]);
  });

  it('keeps a long reason to what one line may carry', () => {
    const { lines, log } = recorder();

    logHttpRefusal(log, { method: 'GET', path: '/x', status: 413, reason: 'z'.repeat(400) });

    expect(lines[0]?.[1]).toContain(`reason="${'z'.repeat(256)}"`);
  });
});

describe('@fast outbound permit lines', () => {
  it('names the pool, the caller and how long the wait was', () => {
    const { lines, log } = recorder();

    logOutboundWait(log, { upload: true, caller: 'u-7', waitedMs: 1500, granted: true });

    expect(lines).toEqual([[
      'warning',
      'collab: outbound permit waited pool="upload" caller="u-7" waitedMs=1500 granted=true',
    ]]);
  });

  it('calls a wait that never got a slot an error', () => {
    const { lines, log } = recorder();

    logOutboundWait(log, { upload: false, caller: '', waitedMs: 120000, granted: false });

    expect(lines).toEqual([[
      'error',
      'collab: outbound permit waited pool="check" caller="" waitedMs=120000 granted=false',
    ]]);
  });
});
