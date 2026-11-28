import { Duplex } from 'node:stream';

/**
 * The stream `ws` is handed in place of the connection. Everything `ws` writes
 * — the 101, every frame the room sends, the close — is forwarded to the wire
 * in order; nothing is ever pushed back, because this host reads the peer's
 * frames itself (see ws-frames.ts). Keeping `ws` behind a stream of our own is
 * also what makes `bufferedAmount` mean "what the peer has not taken yet".
 */
export class SocketBridge extends Duplex {
  private inflight = 0;
  private ending = false;

  constructor(private readonly wire: Duplex) {
    super();
    wire.on('close', () => this.destroy());
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.inflight += 1;
    // A write that fails means the wire is gone, and its own close is what
    // tears this stream down: failing the write too would only add an error
    // `ws` has no answer for.
    this.wire.write(chunk, () => {
      this.inflight -= 1;
      // The chunk only leaves writableLength once the callback has run, and
      // settle() reads that length to decide whether anything is still owed.
      callback();
      this.settle();
    });
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.wire.destroy();
    callback(error);
  }

  /** Half-closes the wire once everything written so far has reached it. */
  endAfterFlush(): void {
    this.ending = true;
    this.settle();
  }

  private settle(): void {
    if (this.ending && this.inflight === 0 && this.writableLength === 0) {
      this.wire.end();
    }
  }
}
