import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { SocketBridge } from './socket-bridge.ts';

function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => resolve()));
}

describe('SocketBridge', () => {
  it('forwards everything written to it, in order', async () => {
    const wire = new PassThrough();
    const bridge = new SocketBridge(wire);

    bridge.write(Buffer.from('one'));
    bridge.write(Buffer.from('two'));
    await settled();

    expect(wire.read()?.toString()).toBe('onetwo');
  });

  it('half-closes the wire once what was written has reached it', async () => {
    const wire = new PassThrough();
    const bridge = new SocketBridge(wire);
    const finished = new Promise<void>((resolve) => wire.once('finish', () => resolve()));

    bridge.write(Buffer.from('bye'));
    bridge.endAfterFlush();
    await finished;

    expect(wire.read()?.toString()).toBe('bye');
  });

  it('ends a wire that has nothing in flight', async () => {
    const wire = new PassThrough();
    const bridge = new SocketBridge(wire);
    const finished = new Promise<void>((resolve) => wire.once('finish', () => resolve()));

    bridge.endAfterFlush();

    await expect(finished).resolves.toBeUndefined();
  });

  it('destroys the wire when it is destroyed, and is destroyed when the wire closes', async () => {
    const wire = new PassThrough();
    const bridge = new SocketBridge(wire);

    bridge.destroy();
    await settled();
    expect(wire.destroyed).toBe(true);

    const other = new PassThrough();
    const peer = new SocketBridge(other);

    other.destroy();
    await settled();
    expect(peer.destroyed).toBe(true);
  });

  it('counts what it still owes the wire, so a stalled peer backs up', async () => {
    const wire = new PassThrough({ highWaterMark: 1 });

    wire.pause();

    const bridge = new SocketBridge(wire);

    bridge.write(Buffer.alloc(64 * 1024));
    bridge.write(Buffer.alloc(64 * 1024));
    await settled();

    expect(bridge.writableLength).toBeGreaterThan(0);
  });
});
