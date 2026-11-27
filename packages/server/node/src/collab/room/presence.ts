import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { SyncWireFrame } from '../../../../../../src/components/modules/collaboration/types.ts';

interface Entry {
  clientId: number;
  clock: number;
  state: string;
}
const maxClients = 128;

function pack(entries: Entry[]): SyncWireFrame {
  const buffer = encoding.createEncoder();
  encoding.writeVarUint(buffer, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(buffer, entry.clientId);
    encoding.writeVarUint(buffer, entry.clock);
    encoding.writeVarString(buffer, entry.state);
  }
  return { type: 'awareness', update: encoding.toUint8Array(buffer) };
}

function unpack(bytes: Uint8Array): Entry[] {
  if (bytes.length > 65536) throw new Error('Presence exceeds size limit');
  const buffer = decoding.createDecoder(bytes);
  const count = decoding.readVarUint(buffer);
  if (count > maxClients) throw new Error('Too many presence entries');
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    const clientId = decoding.readVarUint(buffer);
    const clock = decoding.readVarUint(buffer);
    const state = decoding.readVarString(buffer);
    const parsed = JSON.parse(state);
    if (
      !Number.isSafeInteger(clientId) ||
      !Number.isSafeInteger(clock) ||
      (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed)))
    )
      throw new Error('Invalid presence entry');
    entries.push({ clientId, clock, state });
  }
  if (decoding.hasContent(buffer)) throw new Error('Trailing presence bytes');
  return entries;
}

/** Verified actors belong to admissions. The contents of a cursor are self-reported. */
export class RoomPresence<Peer> {
  private readonly clients = new Map<number, Entry & { peer: Peer; actor?: string }>();

  identities(): SyncWireFrame {
    return {
      type: 'identities',
      identities: Array.from(this.clients.values()).flatMap((entry) =>
        entry.actor ? [{ clientId: entry.clientId, actorId: entry.actor }] : [],
      ),
    };
  }

  snapshot(): SyncWireFrame | undefined {
    if (this.clients.size) return pack([...this.clients.values()]);
  }

  receive(peer: Peer, actor: string | undefined, update: Uint8Array): SyncWireFrame | undefined {
    const entries = unpack(update);
    const accepted: Entry[] = [];
    for (const entry of entries) {
      const current = this.clients.get(entry.clientId);
      if (current && (current.peer !== peer || entry.clock < current.clock)) continue;
      if (entry.state === 'null') {
        if (!current) continue;
        this.clients.delete(entry.clientId);
      } else {
        if (!current && (entries.length !== 1 || this.clients.size >= maxClients)) continue;
        // A re-publish at the clock already held changes nothing here, and is
        // still relayed: it is how a member answers the room's join-time
        // queryAwareness, and the only frame a late joiner has to learn from.
        // A receiver that already holds that clock ignores it, so no peer can
        // overwrite a state by re-sending one at a clock it does not own.
        if (!current || entry.clock > current.clock) this.clients.set(entry.clientId, { ...entry, peer, actor });
      }
      accepted.push(entry);
    }
    if (accepted.length) return pack(accepted);
  }

  leave(peer: Peer): SyncWireFrame | undefined {
    const gone: Entry[] = [];
    for (const entry of this.clients.values()) {
      if (entry.peer !== peer) continue;
      this.clients.delete(entry.clientId);
      gone.push({ ...entry, state: 'null' });
    }
    if (gone.length) return pack(gone);
  }
}
