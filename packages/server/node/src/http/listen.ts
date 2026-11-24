/** Kestrel-compatible listen binding on node:net. */

import net from 'node:net';

export class ListenError extends Error {
  readonly inUse: boolean;

  constructor(message: string, inUse = false) {
    super(message);
    this.name = 'ListenError';
    this.inUse = inUse;
  }
}

export function splitHostPort(hostport: string): [string, string] {
  const fail = (why: string) => {
    throw new ListenError(`listen tcp: address ${hostport}: ${why}`);
  };
  const colon = hostport.lastIndexOf(':');
  if (colon < 0) {
    fail('missing port in address');
  }
  let host: string;
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']');
    if (end < 0) {
      fail("missing ']' in address");
    }
    if (end + 1 === hostport.length) {
      fail('missing port in address');
    }
    if (end + 1 !== colon) {
      if (hostport[end + 1] === ':') {
        fail('too many colons in address');
      }
      fail('missing port in address');
    }
    host = hostport.slice(1, end);
  } else {
    host = hostport.slice(0, colon);
    if (host.includes(':')) {
      fail('too many colons in address');
    }
  }
  if (hostport.includes('[') && !hostport.startsWith('[')) {
    fail("unexpected '[' in address");
  }
  if (hostport.includes(']') && !hostport.startsWith('[')) {
    fail("unexpected ']' in address");
  }
  return [host, hostport.slice(colon + 1)];
}

function parsePort(text: string): number {
  if (text.length === 0 || !/^\d+$/.test(text)) {
    throw new ListenError(`listen tcp: address ${text}: invalid port`);
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ListenError(`listen tcp: address ${text}: invalid port`);
  }
  return port;
}

function bindOne(host: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      const address = host.length === 0 ? `:${port}` : `${host}:${port}`;
      if (err.code === 'EADDRINUSE') {
        reject(
          new ListenError(
            `Failed to bind to address http://${host || '127.0.0.1'}:${port}: address already in use.`,
            true,
          ),
        );
        return;
      }
      reject(new ListenError(`listen tcp ${address}: ${err.message}`));
    });
    server.listen({ host: host.length === 0 ? '0.0.0.0' : host, port, ipv6Only: false }, () => resolve(server));
  });
}

async function bindLocalhost(port: number): Promise<net.Server[]> {
  if (port === 0) {
    throw new ListenError(
      'Dynamic port binding is not supported when binding to localhost. You must either bind to 127.0.0.1:0 or [::1]:0, or both.',
    );
  }
  const listeners: net.Server[] = [];
  for (const host of ['127.0.0.1', '::1']) {
    try {
      listeners.push(await bindOne(host, port));
    } catch (error) {
      if (error instanceof ListenError && error.inUse) {
        throw error;
      }
    }
  }
  if (listeners.length === 0) {
    throw new ListenError(`Failed to bind to address http://localhost:${port}.`);
  }
  return listeners;
}

export function parseIp(text: string): string | undefined {
  const trimmed = text.split('%')[0];
  if (net.isIP(trimmed)) {
    return trimmed;
  }
  if (trimmed === '127.1') {
    return '127.0.0.1';
  }
  return undefined;
}

export async function listen(address: string, parse: (host: string) => string | undefined): Promise<net.Server[]> {
  const [host, portText] = splitHostPort(address);
  const port = parsePort(portText);
  if (host.length === 0) {
    return [await bindOne('0.0.0.0', port)];
  }
  if (host === '*' || host === '+') {
    try {
      return [await bindOne('::', port)];
    } catch {
      return [await bindOne('0.0.0.0', port)];
    }
  }
  if (host.toLowerCase() === 'localhost') {
    return bindLocalhost(port);
  }
  const ip = parse(host);
  if (ip === undefined) {
    throw new ListenError(`listen tcp: address ${address}: not an IP address`);
  }
  if (net.isIPv6(ip) && ip.startsWith('::ffff:')) {
    throw new ListenError("Can't assign requested address");
  }
  return [await bindOne(ip, port)];
}
