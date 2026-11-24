/** node:net helpers for the write half. */

import net from 'node:net';

export function writeAll(socket: net.Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || !socket.writable) {
      reject(Object.assign(new Error('not connected'), { code: 'EPIPE' }));
      return;
    }
    socket.write(bytes, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/** SO_LINGER 0: the peer sees a reset, as socket2 set_linger(Some(0)) does. */
export function resetSocket(socket: net.Socket): void {
  const reset = socket.resetAndDestroy;
  if (typeof reset === 'function') {
    reset.call(socket);
    return;
  }
  socket.destroy();
}

export interface SocketAddr {
  address: string;
  port: number;
  family: 'IPv4' | 'IPv6';
}

export function remoteAddr(socket: net.Socket): SocketAddr {
  return {
    address: socket.remoteAddress ?? '0.0.0.0',
    port: socket.remotePort ?? 0,
    family: socket.remoteFamily === 'IPv6' ? 'IPv6' : 'IPv4',
  };
}

export function localAddr(socket: net.Socket, fallback: SocketAddr): SocketAddr {
  const address = socket.localAddress;
  const port = socket.localPort;
  if (!address || port === undefined) {
    return fallback;
  }
  return {
    address,
    port,
    family: socket.localFamily === 'IPv6' ? 'IPv6' : 'IPv4',
  };
}
