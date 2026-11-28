import * as encoding from 'lib0/encoding';
import { expect, it } from 'vitest';
import { RoomPresence } from './presence.ts';

function publish(id: number, clock: number, state: unknown) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, id);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}
it('relays cursors, keeps their verified actor and removes them when the connection closes', () => {
  const room = new RoomPresence<string>();
  const own = publish(17, 1, { user: { name: 'Alice' } });
  expect(room.receive('first', 'account-1', own)).toEqual({ type: 'awareness', update: own });
  expect(room.receive('second', 'account-2', publish(17, 5, null))).toBeUndefined();
  expect(room.snapshot()).toEqual({ type: 'awareness', update: own });
  expect(room.identities()).toEqual({
    type: 'identities',
    identities: [{ clientId: 17, actorId: 'account-1' }],
  });
  expect(room.leave('first')).toEqual({ type: 'awareness', update: publish(17, 1, null) });
  expect(room.snapshot()).toBeUndefined();
  expect(room.identities()).toEqual({ type: 'identities', identities: [] });
  expect(() => room.receive('first', 'account-1', Uint8Array.of(255))).toThrow();
});

/**
 * No y-websocket client sends queryAwareness of its own, so a late joiner is
 * served by the room ASKING the members already here to announce themselves
 * again. A member that has not touched its state since answers with the same
 * clock it published before — and Go relays that frame verbatim. Dropping it
 * as "nothing new" is dropping the one frame the late joiner was waiting for.
 */
it('relays a re-published state at the clock it already holds, which is what answers a join', () => {
  const room = new RoomPresence<string>();
  const own = publish(17, 1, { user: { name: 'Alice' } });

  expect(room.receive('first', 'account-1', own)).toEqual({ type: 'awareness', update: own });
  expect(room.receive('first', 'account-1', own)).toEqual({ type: 'awareness', update: own });
  expect(room.snapshot()).toEqual({ type: 'awareness', update: own });
});
