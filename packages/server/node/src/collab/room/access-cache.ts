export interface AccessCache<Key, Value> {
  /**
   * Serves a fresh answer, joins the load already in flight for `key`, or starts
   * one. Concurrent callers never produce more than one load.
   */
  resolve(key: Key, load: () => Promise<Value>): Promise<Value>;

  /**
   * Drops `key`'s answer, or every answer when `key` is omitted. A load already
   * in flight still settles for its callers, but its result is not stored: the
   * permission it was reading changed while it was reading it.
   */
  invalidate(key?: Key): void;
}

interface Entry<Value> { value: Value; at: number }

/**
 * A short-lived memo in front of the room's authorization RPC.
 *
 * The room asks for an identity once per inbound frame and once per broadcast
 * recipient, so a document with N members costs N round trips per edit. The
 * authority on a permission change is the push on `/internal/room/recheck-access`,
 * which calls `invalidate`; the TTL is only the floor under a push that never
 * arrives.
 */
export function createAccessCache<Key, Value>(options: { ttlMs: number; now?: () => number }): AccessCache<Key, Value> {
  const { ttlMs } = options;
  const now = options.now ?? Date.now;

  const fresh = new Map<Key, Entry<Value>>();
  const inFlight = new Map<Key, Promise<Value>>();
  const generations = new Map<Key, number>();
  let epoch = 0;

  const generationOf = (key: Key): number => generations.get(key) ?? 0;

  return {
    resolve(key, load) {
      const entry = fresh.get(key);
      if (entry !== undefined && now() - entry.at < ttlMs) return Promise.resolve(entry.value);

      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;

      const startedAt = { epoch, generation: generationOf(key) };
      const promise = load()
        .then((value) => {
          if (epoch === startedAt.epoch && generationOf(key) === startedAt.generation) {
            fresh.set(key, { value, at: now() });
          }
          return value;
        })
        .finally(() => {
          // A newer load may already own the slot; only the owner clears it.
          if (inFlight.get(key) === promise) inFlight.delete(key);
        });

      inFlight.set(key, promise);
      return promise;
    },

    invalidate(key) {
      if (key === undefined) {
        fresh.clear();
        epoch += 1;
        return;
      }
      fresh.delete(key);
      generations.set(key, generationOf(key) + 1);
    },
  };
}
