import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';

/** Buffers HTTP bytes written by the Kestrel stack (no real network). */
export function createCollectingSocket(): { socket: Socket; drain: () => Buffer } {
  const chunks: Buffer[] = [];
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer | string, _encoding, callback: (error?: Error | null) => void) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const socket = duplex as unknown as Socket;
  socket.remoteAddress = '127.0.0.1';
  socket.remotePort = 12_345;
  socket.localAddress = '127.0.0.1';
  socket.localPort = 4000;
  Object.defineProperty(socket, 'readableEnded', { value: false, writable: true, configurable: true });
  Object.defineProperty(socket, 'destroyed', { value: false, writable: true, configurable: true });
  Object.defineProperty(socket, 'readableLength', { value: 0, writable: true, configurable: true });
  return {
    socket,
    drain: () => Buffer.concat(chunks),
  };
}