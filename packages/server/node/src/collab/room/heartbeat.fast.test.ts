import { expect, it, vi, type Mock } from 'vitest';
import { sweepHeartbeat } from './heartbeat.ts';

/** Structurally a HeartbeatMember; the mocks let each call be asserted. */
interface TestMember { alive: boolean; ping: Mock; terminate: Mock }

const member = (alive: boolean): TestMember => ({ alive, ping: vi.fn(), terminate: vi.fn() });

it('probes a member that answered and drops one that did not', () => {
  const answered = member(true);
  const silent = member(false);

  expect(sweepHeartbeat([answered, silent])).toBe(1);

  expect(answered.ping).toHaveBeenCalledOnce();
  expect(answered.terminate).not.toHaveBeenCalled();
  // Cleared before the probe: the next sweep drops it unless a pong arrives first.
  expect(answered.alive).toBe(false);

  expect(silent.ping).not.toHaveBeenCalled();
  expect(silent.terminate).toHaveBeenCalledOnce();
});

it('keeps sweeping when one socket refuses the probe', () => {
  const broken = member(true);
  broken.ping.mockImplementation(() => { throw new Error('not open'); });
  const healthy = member(true);

  // The throwing socket is dropped, not left half-probed, and never stops the sweep.
  expect(sweepHeartbeat([broken, healthy])).toBe(1);

  expect(broken.terminate).toHaveBeenCalledOnce();
  expect(healthy.ping).toHaveBeenCalledOnce();
  expect(healthy.terminate).not.toHaveBeenCalled();
});

it('reports nothing to drop for an empty room', () => {
  expect(sweepHeartbeat([])).toBe(0);
});
