import { expect, it, vi } from 'vitest';
import { createRoomRegistry, RoomBusy } from './room-registry.ts';

/** A stand-in for the part of DocumentRoom the registry touches. */
const stubRoom = () => ({ close: vi.fn(async () => {}) });

const registry = (overrides: Partial<Parameters<typeof createRoomRegistry>[0]> = {}) =>
  createRoomRegistry({ open: async () => stubRoom(), ...overrides });

it('loads a document once and shares it between members', async () => {
  const open = vi.fn(async () => stubRoom());
  const rooms = registry({ open });

  const first = await rooms.reserve('doc');
  const second = await rooms.reserve('doc');

  expect(open).toHaveBeenCalledOnce();
  expect(await first.room).toBe(await second.room);
  expect(first.users).toBe(2);
});

it('unloads a document when its last member leaves', async () => {
  const room = stubRoom();
  const rooms = registry({ open: async () => room });

  const entry = await rooms.reserve('doc');
  rooms.release('doc', entry);
  await rooms.settled();

  expect(room.close).toHaveBeenCalledOnce();
  expect(rooms.loaded()).toBe(0);
});

it('keeps a pinned document loaded after its last member leaves', async () => {
  const room = stubRoom();
  const rooms = registry({ open: async () => room, keepLoaded: true });

  rooms.release('doc', await rooms.reserve('doc'));
  await rooms.settled();

  expect(room.close).not.toHaveBeenCalled();
  expect(rooms.loaded()).toBe(1);
});

it('refuses a member past the per-document ceiling', async () => {
  const rooms = registry({ maxUsersPerDocument: 2 });

  await rooms.reserve('doc');
  await rooms.reserve('doc');

  await expect(rooms.reserve('doc')).rejects.toBeInstanceOf(RoomBusy);
});

it('refuses a new document past the host ceiling, but still admits a loaded one', async () => {
  const rooms = registry({ maxDocuments: 1 });

  await rooms.reserve('first');

  await expect(rooms.reserve('second')).rejects.toBeInstanceOf(RoomBusy);
  // The ceiling counts documents, not members: the loaded one keeps admitting.
  await expect(rooms.reserve('first')).resolves.toBeDefined();
});

it('holds admission while a transition runs, then serves the new room', async () => {
  const rooms = registry();
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => { finish = resolve; });

  const transition = rooms.exclusive('doc', () => gate);
  const admitted = vi.fn();
  const waiting = rooms.reserve('doc').then(admitted);

  // Several turns: enough for the transition chain to start, not enough to end it.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(admitted).not.toHaveBeenCalled();

  finish();
  await transition;
  await waiting;
  expect(admitted).toHaveBeenCalledOnce();
});

it('refuses admission to a document being purged, and releases it afterwards', async () => {
  const rooms = registry();

  // Never call reserve() from inside exclusive(): admission waits on the very
  // transition that would have to finish first.
  rooms.markPurging('doc');
  await expect(rooms.reserve('doc')).rejects.toThrow(/purge/i);

  // The marker must not outlive a failed purge: that is what strands a document.
  rooms.clearPurging('doc');
  await expect(rooms.reserve('doc')).resolves.toBeDefined();
});

it('refuses admission once the host is stopping', async () => {
  const rooms = registry();
  const entry = await rooms.reserve('doc');
  rooms.release('doc', entry);

  await rooms.close();

  await expect(rooms.reserve('doc')).rejects.toBeInstanceOf(RoomBusy);
});
