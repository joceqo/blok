import { expect, it, vi } from 'vitest';
import { createRoomRegistry, RoomBusy } from './room-registry.ts';

/** A stand-in for the part of DocumentRoom the registry touches. */
const stubRoom = (available = true) => ({ close: vi.fn(async () => {}), available: () => available });

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

it('holds a document for its linger after the last member leaves, and starts the wait over for the next one', async () => {
  vi.useFakeTimers();
  try {
    const room = stubRoom();
    const rooms = registry({ open: async () => room, evictionLingerMs: 30_000 });

    rooms.release('doc', await rooms.reserve('doc'));
    await vi.advanceTimersByTimeAsync(29_999);

    // The journal lease is still this host's, so the next request finds the room.
    expect(room.close).not.toHaveBeenCalled();
    expect(rooms.loaded()).toBe(1);

    rooms.release('doc', await rooms.reserve('doc'));
    await vi.advanceTimersByTimeAsync(29_999);

    expect(room.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rooms.settled();

    expect(room.close).toHaveBeenCalledOnce();
    expect(rooms.loaded()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('closes a lingering document with the host, and leaves no timer behind', async () => {
  vi.useFakeTimers();
  try {
    const room = stubRoom();
    const rooms = registry({ open: async () => room, evictionLingerMs: 30_000 });

    rooms.release('doc', await rooms.reserve('doc'));
    await rooms.close();

    expect(room.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('gives a lingering document its place back rather than refusing the host a new one', async () => {
  vi.useFakeTimers();
  try {
    const room = stubRoom();
    const rooms = registry({ open: async () => room, maxDocuments: 1, evictionLingerMs: 30_000 });

    rooms.release('first', await rooms.reserve('first'));

    // One place, and the document waiting out its linger is sitting in it.
    expect(rooms.loaded()).toBe(1);

    // A document nobody is in is held FOR the member who may come back, never
    // AGAINST one who is here now.
    await expect(rooms.reserve('second')).resolves.toBeDefined();
    expect(room.close).toHaveBeenCalledOnce();
    expect(rooms.peek('first')).toBeUndefined();
    expect(rooms.loaded()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('never lingers a room that can no longer serve its document', async () => {
  vi.useFakeTimers();
  try {
    // A room that discarded itself — a failed journal commit is how that
    // happens — can serve nobody, and holding it holds its lease too.
    const room = stubRoom(false);
    const rooms = registry({ open: async () => room, evictionLingerMs: 30_000 });

    rooms.release('doc', await rooms.reserve('doc'));
    await vi.advanceTimersByTimeAsync(0);
    await rooms.settled();

    // The member who reconnects gets a room opened over the document, never this one.
    expect(room.close).toHaveBeenCalledOnce();
    expect(rooms.loaded()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
