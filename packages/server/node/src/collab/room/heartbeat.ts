export interface HeartbeatMember {
  /** Cleared before every probe; an inbound pong sets it back. */
  alive: boolean;
  ping(): void;
  terminate(): void;
}

/**
 * One keepalive round. A member that never answered the previous probe is gone:
 * nothing else notices a half-open socket before the OS TCP timeout, and until
 * then it holds a room slot and a presence entry. Terminating it releases both,
 * the presence entry through the `close` handler.
 *
 * Returns how many members were dropped.
 */
export function sweepHeartbeat(members: Iterable<HeartbeatMember>): number {
  let dropped = 0;

  for (const member of members) {
    if (!member.alive) {
      member.terminate();
      dropped += 1;
      continue;
    }

    member.alive = false;
    // A socket that refuses the probe cannot carry the next committed update either.
    try {
      member.ping();
    } catch {
      member.terminate();
      dropped += 1;
    }
  }

  return dropped;
}
