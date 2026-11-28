/**
 * What this host keeps when something goes wrong, and — just as load-bearing —
 * what it keeps quiet about. `apps/service/observe.go` is the model: one line
 * for a request that was refused, nothing for the rest, because keeping every
 * answered request would be a line per page view on a host whose journal lands
 * on an SD card.
 *
 * Everything here sits on top of `collabLog`, which is the one writer. The
 * escaping in `log.ts` is pinned by the fixture the Go, C# and Rust hosts read
 * and stops a document id forging a second RECORD; the quoting here is what
 * stops it forging a second FIELD on the line it does get.
 */
import type { CollabLog } from './log.ts';

/**
 * What a refusal may contribute to one line, as `causeLimit` bounds it in Go.
 * A refusal body is short; a handler that streams must not put its stream in
 * the journal.
 */
export const REASON_LIMIT = 256;

/** One `name="value"` pair, quoted so a value carrying a quote stays one field. */
function field(name: string, value: string | number | boolean): string {
  return ` ${name}=${JSON.stringify(value)}`;
}

export interface SocketClose {
  doc: string;
  /** The member whose socket it was, where the host got far enough to know. */
  actor?: string;
  code: number | undefined;
  reason: string;
}

/**
 * A member losing its socket. 1000 is how a session ends and a close with no
 * code at all is the peer hanging up, so neither is an event; every other code
 * is this host deciding to drop somebody, which is what a user experiences as
 * "it disconnected on its own" and what nothing anywhere used to record.
 */
export function logSocketClose(log: CollabLog, event: SocketClose): void {
  if (event.code === undefined || event.code === 1000) {
    return;
  }
  const actor = event.actor === undefined || event.actor === '' ? '' : field('actor', event.actor);

  log(
    'collab: socket closed' + field('code', event.code) + field('reason', trimmed(event.reason))
      + field('doc', event.doc) + actor,
    // 1011 is the room failing at its own work; every other code is a verdict
    // on the peer, and a verdict is not a fault.
    event.code === 1011 ? 'error' : 'warning',
  );
}

export interface HttpRefusal {
  method: string;
  path: string;
  status: number;
  /** The body this door is about to write, which is where the reason lives. */
  reason: string;
}

/**
 * A request the collaboration door turned away. The status code reaches the
 * caller; the reason does not reach anybody, and on a socket the caller never
 * reads the body at all.
 */
export function logHttpRefusal(log: CollabLog, event: HttpRefusal): void {
  if (event.status < 400) {
    return;
  }
  log(
    'collab: request refused' + field('status', event.status) + field('reason', trimmed(event.reason))
      + field('method', event.method) + field('path', event.path),
    event.status >= 500 ? 'error' : 'warning',
  );
}

export interface OutboundWait {
  upload: boolean;
  caller: string;
  waitedMs: number;
  granted: boolean;
}

/**
 * A caller that had to queue for an outbound slot, written once the wait is
 * over so the line can say how long it was. The pool holds four, and a slot
 * that is taken and never given back turns every later call into a silent
 * two-minute stall — which is how two leaked permits went unnoticed until a
 * test timed out.
 */
export function logOutboundWait(log: CollabLog, event: OutboundWait): void {
  log(
    'collab: outbound permit waited' + field('pool', event.upload ? 'upload' : 'check')
      + field('caller', event.caller) + field('waitedMs', event.waitedMs) + field('granted', event.granted),
    // A wait that ended with no slot is the pool failing its caller.
    event.granted ? 'warning' : 'error',
  );
}

function trimmed(reason: string): string {
  return reason.trim().slice(0, REASON_LIMIT);
}
