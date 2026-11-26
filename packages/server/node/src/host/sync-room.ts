import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import { verifyTicket } from '../auth/ticket.ts';
import { DocEndpointClient } from '../collab/doc-endpoint.ts';
import { DocumentPurged, MAX_APPEND_BYTES, UnreadableJournalData } from '../collab/journal/append.ts';
import { openDocumentRoom, type EditCommand, type EditOutcome } from '../collab/room/document-room.ts';
import { seedUpdate, type Snapshot } from '../collab/room/page-document.ts';
import { existingDirectory, initializePage, newBaseline, pageDirectory } from '../collab/room/page-seed.ts';
import { resetGeneration } from '../collab/room/reset.ts';
import { createRoomRegistry, type Resident } from '../collab/room/room-registry.ts';
import type { RoomIdentity, RoomOptions } from '../collab/room/preview.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { writePlain } from '../route/respond.ts';
import type { HistoryRequest } from '../collab/room/history.ts';
import type { HistoryAnswer } from './collab-http.ts';
import { addressKey, classifyPass, hostRefused, inspectOrigin, type PassFailure } from './guard.ts';
import type { HostAppOptions } from './options.ts';
import {
  isSingleSegment,
  offeredPasses,
  offeredSubprotocols,
  PROTOCOL_V1,
  PROTOCOL_V2,
  selectSubprotocol,
  upgradeRefusal,
} from './sync-door.ts';
import { toUpgradeMessage } from './ws-upgrade.ts';

/** Section 2's close table: the room is reachable but cannot serve this document. */
const UNAVAILABLE_CLOSE = 4503;
const FORBIDDEN_CLOSE = 4403;
/** RFC 6455 "going away": what a graceful host owes a member it is about to drop. */
const DRAINING_CLOSE = 1001;
/** The old lineage is gone; a member must rejoin rather than retry on it. */
const RESET_CLOSE = 4409;
/** The target named more than one path segment, so it names no document. */
const BAD_DOCUMENT_CLOSE = 4400;
/** The offers carried no pass this host will honour. */
const UNAUTHORIZED_CLOSE = 4401;

/** Upgrades admitted at once, matching the standalone room host. */
const MAX_ADMISSIONS = 256;

/**
 * Sockets one member may hold on one document. Eight covers a person with the
 * page open in several tabs and a reconnect in flight; past that, a client in
 * a reconnect loop is spending the room's memory, not using it.
 */
const MAX_MEMBER_SOCKETS = 8;

/**
 * How long a refused socket is given to answer the close before the host drops
 * it. A peer that never answers must not hold the connection for the full
 * RFC 6455 timeout.
 */
const REFUSAL_LINGER_MS = 250;

/** The failures that reach the client as a close reason, worst last. */
const FAILURE_ORDER: PassFailure[] = ['missing pass', 'invalid pass', 'pass is for another document', 'pass names no user'];

type DocumentRoom = Awaited<ReturnType<typeof openDocumentRoom>>;

export interface SyncRooms {
  /** Takes over the connection for one `GET {prefix}/sync/{doc}` upgrade. */
  upgrade(request: Request, response: ResponseWriter, doc: string): Promise<void>;
  /** Runs one state, history or restore request inside the document's room queue. */
  history(doc: string, ticket: string, request: HistoryRequest): Promise<HistoryAnswer>;
  /** Runs one `POST /sync/{doc}/edit` command inside the document's room queue. */
  apply(doc: string, ticket: string, command: EditCommand): Promise<EditOutcome>;
  /** Publishes a fresh generation for one document; answers an HTTP status. */
  reset(doc: string): Promise<number>;
  /** Closes every member with 1001 and releases every journal lease. */
  close(): Promise<void>;
}

/**
 * The host's room admission. A ticket host verifies the pass the way every
 * other route does; a host without authentication admits whoever the guard let
 * through, and has no principal to journal.
 */
function roomAuthorizer(options: HostAppOptions): RoomOptions['authorize'] {
  if (options.auth !== 'ticket') {
    return async () => ({ id: '', write: true });
  }
  return async (ticket, documentId) => {
    const verified = verifyTicket(options.secret, ticket, Date.now());
    if (!verified.ok || verified.claims.doc !== documentId) {
      return null;
    }
    return { id: verified.claims.user, write: verified.claims.write };
  };
}

/**
 * Who the door admits, and what the limiter bills. A pass that does not
 * verify still costs the address a request: a caller that keeps presenting
 * bad passes is exactly what the limiter is there to slow down.
 */
interface Admission {
  key: string;
  ticket: string;
  identity?: RoomIdentity;
  failure?: PassFailure;
}

/**
 * Every offer that is not a protocol name is tried as the pass, so a client
 * may carry a stale one beside the one it just renewed. When none verifies,
 * the client is told the furthest the door got.
 */
function admissionFor(options: HostAppOptions, request: Request, doc: string, passes: readonly string[]): Admission {
  if (options.auth !== 'ticket') {
    return { key: addressKey(request), ticket: passes[0] ?? '', identity: { id: '', write: true } };
  }
  const now = Date.now();
  let failure: PassFailure = 'missing pass';
  for (const pass of passes) {
    const verdict = classifyPass(options.secret, pass, doc, now);
    if (verdict.ok) {
      return { key: `user:${verdict.user}`, ticket: pass, identity: { id: verdict.user, write: verdict.write } };
    }
    if (FAILURE_ORDER.indexOf(verdict.reason!) > FAILURE_ORDER.indexOf(failure)) {
      failure = verdict.reason!;
    }
  }
  return { key: addressKey(request), ticket: '', failure };
}

export function createSyncRooms(options: HostAppOptions): SyncRooms {
  const authorize = roomAuthorizer(options);
  const endpoint = options.docEndpoint === ''
    ? undefined
    : new DocEndpointClient({ endpoint: options.docEndpoint, authorization: options.docEndpointAuth });
  // openDocumentRoom refuses an empty set but never consults it: the room is
  // reached through the host's own guard, which is the one origin policy here.
  const allowedOrigins = new Set(options.allowedOrigins.length > 0 ? options.allowedOrigins : ['*']);

  async function seed(documentId: string): Promise<Snapshot> {
    if (endpoint === undefined) {
      return null;
    }
    return (await endpoint.load(documentId)).data as Snapshot;
  }

  async function openRoom(documentId: string): Promise<DocumentRoom> {
    const directory = pageDirectory(options.collabDirectory, documentId);
    if (!(await existingDirectory(directory))) {
      // The anchor belongs to canonical projection, which this host does not
      // run. An empty one refuses a later projection rather than lying to it.
      await initializePage(
        options.collabDirectory,
        documentId,
        newBaseline(seedUpdate(await seed(documentId))),
        '{}',
        async () => {},
      );
    }
    return openDocumentRoom({ directory, documentId, allowedOrigins, authorize });
  }

  const rooms = createRoomRegistry<DocumentRoom>({ open: openRoom });
  // The documents this host currently holds. The registry can name its
  // residents but not their ids, and a drain has to close them BY id.
  const held = new Set<string>();
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_APPEND_BYTES + 4096,
    // The door has already chosen, and hands its answer down as the only offer.
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  sockets.on('headers', (headers) => headers.push('X-Blok-Collaboration: node'));
  // A reset holds the document against admission while it runs; a drain has to
  // wait for the ones still in flight before it closes the registry.
  const transitions = new Set<Promise<void>>();
  // One entry per socket a named member holds, keyed by member and document.
  // A slot is taken before the handshake and still empty while it runs, so a
  // burst of upgrades cannot all pass the count before any of them is counted.
  const memberSockets = new Map<string, Set<{ ws?: WebSocket }>>();
  let admissions = 0;
  let stopping = false;

  /** Takes one of the member's slots on this document, or nothing when all eight are live. */
  function claimSocket(key: string): { ws?: WebSocket } | undefined {
    let held = memberSockets.get(key);
    if (held === undefined) {
      held = new Set();
      memberSockets.set(key, held);
    }
    let live = 0;
    for (const slot of held) {
      // A socket answering a close is already leaving: `ws` moves it out of
      // OPEN the moment the peer's close frame is read, which is before the
      // answering close is written. The slot is free from that moment.
      if (slot.ws === undefined || slot.ws.readyState === WebSocket.OPEN) {
        live += 1;
      }
    }
    if (live >= MAX_MEMBER_SOCKETS) {
      return undefined;
    }
    const slot: { ws?: WebSocket } = {};
    held.add(slot);
    return slot;
  }

  function releaseSocket(key: string, slot: { ws?: WebSocket }): void {
    const held = memberSockets.get(key);
    if (held === undefined) {
      return;
    }
    held.delete(slot);
    if (held.size === 0) {
      memberSockets.delete(key);
    }
  }

  /**
   * Tells a client on the socket why it was not served. The handshake has
   * already been answered, so a status code is no longer available: section
   * 2's 44xx closes are the only way left to name the reason.
   */
  function refuse(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason);
    const linger = setTimeout(() => ws.terminate(), REFUSAL_LINGER_MS);
    linger.unref();
    ws.once('close', () => clearTimeout(linger));
  }

  /**
   * The conformance keep-alive. A room runs its own half-minute heartbeat; this
   * one exists so the contract can watch a probe and an abort inside a test,
   * and stays off unless a build asks for it.
   */
  function keepAlive(ws: WebSocket): void {
    const interval = options.collabKeepAliveMs ?? 0;
    if (interval <= 0) {
      return;
    }
    let unanswered = 0;
    const probe = setInterval(() => {
      if (unanswered >= 2) {
        // Two probes with no answer: the peer is gone and owes no close frame.
        ws.terminate();
        return;
      }
      unanswered += 1;
      try {
        ws.ping(Buffer.alloc(8));
      } catch {
        ws.terminate();
      }
    }, interval);
    probe.unref();
    ws.on('pong', () => {
      unanswered = 0;
    });
    ws.once('close', () => clearInterval(probe));
  }

  /** Joins the room on an established socket, and reports the lease to release. */
  async function admit(
    ws: WebSocket,
    doc: string,
    ticket: string,
    identity: RoomIdentity,
  ): Promise<Resident<DocumentRoom> | undefined> {
    let entry: Resident<DocumentRoom> | undefined;
    try {
      entry = await rooms.reserve(doc);
      held.add(doc);
      const room = await entry.room;
      if (stopping || !room.available()) {
        ws.close(UNAVAILABLE_CLOSE, 'room unavailable');
        return entry;
      }
      room.connect(ws, ticket, identity);
    } catch (error) {
      // A document that cannot be served is refused ON the socket, never by
      // withholding the handshake: the client is owed the reason.
      ws.close(error instanceof DocumentPurged ? FORBIDDEN_CLOSE : UNAVAILABLE_CLOSE, 'room unavailable');
    }
    return entry;
  }

  /**
   * Answers the handshake and runs `serve` on the socket it produced. The
   * exchange owns the connection for the whole session: the HTTP loop destroys
   * the socket the moment this returns, so it returns only once that socket is
   * closed.
   */
  async function accept(
    request: Request,
    response: ResponseWriter,
    protocol: string | undefined,
    serve: (ws: WebSocket) => Promise<void> | void,
  ): Promise<void> {
    admissions += 1;
    let socket: Socket;
    let buffered: Uint8Array;
    try {
      ({ socket, buffered } = await response.hijack());
    } catch {
      admissions -= 1;
      return;
    }
    try {
      socket.on('error', () => socket.destroy());
      const closed = new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
      });
      // `ws` answers the handshake on the socket itself; an upgrade it refuses
      // destroys the socket instead of calling back, which `closed` settles.
      const connected = await new Promise<WebSocket | undefined>((resolve) => {
        socket.once('close', () => resolve(undefined));
        sockets.handleUpgrade(
          toUpgradeMessage(request, protocol) as unknown as IncomingMessage,
          socket,
          Buffer.from(buffered),
          (ws) => resolve(ws),
        );
      });
      if (connected !== undefined) {
        await serve(connected);
      }
      await closed;
    } finally {
      admissions -= 1;
    }
  }

  /**
   * The door. Everything the handshake itself can refuse is answered with a
   * status; everything that needs the document or the pass is refused on the
   * socket, because a browser WebSocket never sees the body of a 4xx.
   */
  async function upgrade(request: Request, response: ResponseWriter, doc: string): Promise<void> {
    const refusal = upgradeRefusal(request);
    if (refusal !== undefined) {
      await writePlain(request, response, 426, refusal);
      return;
    }
    if (hostRefused(options, request)) {
      await writePlain(request, response, 421, 'host not allowed\n');
      return;
    }
    // A refusal spends nothing: the limiter protects the work behind the door,
    // and a request this host never meant to answer did none of it.
    if (inspectOrigin(options, request).refused) {
      await writePlain(request, response, 403, 'origin not allowed\n');
      return;
    }

    const offers = offeredSubprotocols(request);
    const protocol = selectSubprotocol(offers, options.collabJournal);

    // Before the pass: a target that names no document cannot be the scope a
    // pass would be checked against.
    if (!isSingleSegment(doc)) {
      await accept(request, response, protocol, (ws) =>
        refuse(ws, BAD_DOCUMENT_CLOSE, 'document ids must be a single path segment'));
      return;
    }
    // A browser WebSocket has no Authorization header, so a ticket host reads
    // the pass out of the offer list — which it can only do when the client
    // named the protocol that puts it there.
    if (options.auth === 'ticket' && !offers.includes(PROTOCOL_V1)) {
      await writePlain(request, response, 400, `${PROTOCOL_V1} must be offered in Sec-WebSocket-Protocol\n`);
      return;
    }

    const admission = admissionFor(options, request, doc, offeredPasses(offers));
    if (!options.rateLimiter.allow(admission.key)) {
      await writePlain(request, response, 429, 'rate limit exceeded\n');
      return;
    }
    const identity = admission.identity;
    if (identity === undefined) {
      await accept(request, response, protocol, (ws) => refuse(ws, UNAUTHORIZED_CLOSE, admission.failure!));
      return;
    }
    // A host without authentication has no member to count against, so the
    // per-member cap applies only where a pass named one.
    const slotKey = identity.id === '' ? undefined : `${identity.id}\0${doc}`;
    const slot = slotKey === undefined ? undefined : claimSocket(slotKey);
    if (slotKey !== undefined && slot === undefined) {
      await writePlain(request, response, 429, 'too many connections\n');
      return;
    }
    if (stopping || admissions >= MAX_ADMISSIONS) {
      if (slotKey !== undefined && slot !== undefined) {
        releaseSocket(slotKey, slot);
      }
      await writePlain(request, response, 503, 'the room is not accepting connections\n');
      return;
    }

    let entry: Resident<DocumentRoom> | undefined;
    try {
      await accept(request, response, protocol, async (ws) => {
        if (slot !== undefined) {
          slot.ws = ws;
        }
        keepAlive(ws);
        entry = await admit(ws, doc, admission.ticket, identity);
      });
    } finally {
      if (slotKey !== undefined && slot !== undefined) {
        releaseSocket(slotKey, slot);
      }
      if (entry !== undefined) {
        rooms.release(doc, entry);
        // The id is owed to the drain only while the document is loaded. The
        // release above may unload it; `settled` is when that has run.
        void rooms.settled().then(() => {
          if (rooms.peek(doc) === undefined) {
            held.delete(doc);
          }
        });
      }
    }
  }

  /**
   * Reaches the room for one HTTP request. The room serialises it behind its
   * own queue, so a reader never sees a half-applied commit; the lease is held
   * only for as long as the request runs.
   */
  async function history(doc: string, ticket: string, request: HistoryRequest): Promise<HistoryAnswer> {
    if (stopping) {
      throw new Error('Host draining');
    }
    const identity = await authorize(ticket, doc).catch(() => null);
    if (identity === null) {
      return { status: 403 };
    }
    const entry = await rooms.reserve(doc);
    held.add(doc);
    try {
      const room = await entry.room;
      if (stopping || !room.available()) {
        throw new Error('Room unavailable');
      }
      return await room.history(request, identity, ticket);
    } finally {
      rooms.release(doc, entry);
      void rooms.settled().then(() => {
        if (rooms.peek(doc) === undefined) {
          held.delete(doc);
        }
      });
    }
  }

  /**
   * Reaches the room for one edit command. It takes the same shared lease a
   * reader takes, never the exclusive one a reset takes: an edit is ordinary
   * traffic, and the room's own queue is what orders it against the sockets.
   */
  async function apply(doc: string, ticket: string, command: EditCommand): Promise<EditOutcome> {
    if (stopping) {
      throw new Error('Host draining');
    }
    const identity = await authorize(ticket, doc).catch(() => null);
    if (identity === null) {
      return { ok: false, reason: 'forbidden' };
    }
    const entry = await rooms.reserve(doc);
    held.add(doc);
    try {
      const room = await entry.room;
      if (stopping || !room.available()) {
        throw new Error('Room unavailable');
      }
      return await room.apply(command, identity, ticket);
    } finally {
      rooms.release(doc, entry);
      void rooms.settled().then(() => {
        if (rooms.peek(doc) === undefined) {
          held.delete(doc);
        }
      });
    }
  }

  /**
   * Retires the live room and publishes a new lineage over it. The writer must
   * have released its lease before resetGeneration can take one of its own,
   * and `load` covers a document this host has never opened.
   */
  async function reset(doc: string): Promise<number> {
    if (stopping) {
      return 503;
    }
    const pending = rooms.exclusive(doc, async () => {
      if (stopping) {
        throw new Error('Host draining');
      }
      held.add(doc);
      try {
        await rooms.retire(doc, { code: RESET_CLOSE, message: 'document reset' }, { load: true });
      } catch (error) {
        // An explicit reset is how a host adopts a record replaced underneath
        // it: the superseded bytes need not still be readable.
        if (!(error instanceof UnreadableJournalData)) {
          throw error;
        }
      }
      await resetGeneration(
        pageDirectory(options.collabDirectory, doc),
        async () => seedUpdate(null),
        async () => {},
      );
    });
    transitions.add(pending);
    void pending.catch(() => {}).finally(() => transitions.delete(pending));
    try {
      await pending;
      return 204;
    } catch (error) {
      return error instanceof DocumentPurged ? 403 : 503;
    }
  }

  async function close(): Promise<void> {
    stopping = true;
    await Promise.allSettled([...transitions]);
    // retire() closes every member with a reason; the registry's own close
    // terminates them, which reaches a peer as an abnormal 1006.
    await Promise.all([...held].map((doc) =>
      rooms.retire(doc, { code: DRAINING_CLOSE, message: 'host draining' }).catch(() => {})));
    await rooms.close();
    sockets.close();
  }

  return { upgrade, history, apply, reset, close };
}
