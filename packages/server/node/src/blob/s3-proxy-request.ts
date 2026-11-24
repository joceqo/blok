import net from 'node:net';
import tls from 'node:tls';

import type { ProxyTarget } from './environment-proxy.ts';

function proxyAuth(target: ProxyTarget): string {
  if (target.user === undefined) {
    return '';
  }
  const token = target.password === undefined
    ? target.user
    : `${target.user}:${target.password}`;
  return `Proxy-Authorization: Basic ${Buffer.from(token, 'utf8').toString('base64')}\r\n`;
}

function parseHttpResponse(buffer: Buffer): { status: number; headersEnd: number; body: Buffer } | undefined {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) {
    return undefined;
  }
  const head = buffer.subarray(0, end).toString('latin1');
  const status = Number.parseInt(head.split('\r\n')[0]?.split(' ')[1] ?? '', 10);
  if (!Number.isFinite(status)) {
    return undefined;
  }
  return { status, headersEnd: end + 4, body: buffer.subarray(end + 4) };
}

function sendRequest(
  socket: net.Socket,
  method: string,
  target: string,
  host: string,
  headers: Record<string, string>,
  body?: Buffer,
  proxy?: ProxyTarget,
  retry = true,
): Promise<{ status: number; body: Buffer }> {
  const ordered = { ...headers, Host: host };
  if (proxy !== undefined) {
    ordered.Host = host;
  }
  let head = `${method} ${target} HTTP/1.1\r\n`;
  for (const [name, value] of Object.entries(ordered)) {
    head += `${name}: ${value}\r\n`;
  }
  if (proxy !== undefined) {
    head += proxyAuth(proxy);
  }
  head += '\r\n';
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const parsed = parseHttpResponse(Buffer.concat(chunks));
      if (parsed === undefined) {
        return;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      if (parsed.status === 407 && retry && proxy !== undefined) {
        sendRequest(socket, method, target, host, headers, body, proxy, false).then(resolve, reject);
        return;
      }
      resolve({ status: parsed.status, body: parsed.body });
    };
    const onError = (error: Error): void => {
      reject(error);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(head);
    if (body !== undefined && body.length > 0) {
      socket.write(body);
    }
  });
}

async function connectTlsViaProxy(parsed: URL, proxy: ProxyTarget): Promise<net.Socket> {
  const authority = parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  const connectTarget = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(proxy.port, proxy.host.replace(/^\[|]$/g, ''), () => resolve(s));
    s.on('error', reject);
  });
  let head = `CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n${proxyAuth(proxy)}`;
  head += '\r\n';
  const response = await new Promise<{ status: number }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const parsedResponse = parseHttpResponse(Buffer.concat(chunks));
      if (parsedResponse === undefined) {
        return;
      }
      socket.off('data', onData);
      resolve({ status: parsedResponse.status });
    };
    socket.on('error', reject);
    socket.on('data', onData);
    socket.write(head);
  });
  if (response.status !== 200) {
    socket.destroy();
    throw new Error(`proxy connect ${response.status}`);
  }
  const secured = tls.connect({ socket, servername: parsed.hostname });
  await new Promise<void>((resolve, reject) => {
    secured.once('secureConnect', () => resolve());
    secured.once('error', reject);
  });
  return secured;
}

export async function requestThroughProxy(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  proxy: ProxyTarget,
): Promise<{ status: number; body: Buffer }> {
  const parsed = new URL(url);
  const host = parsed.host;
  if (parsed.protocol === 'https:') {
    const socket = await connectTlsViaProxy(parsed, proxy);
    try {
      return await sendRequest(socket, method, `${parsed.pathname}${parsed.search}`, host, headers, body);
    } finally {
      socket.destroy();
    }
  }
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(proxy.port, proxy.host.replace(/^\[|]$/g, ''), () => resolve(s));
    s.on('error', reject);
  });
  try {
    return await sendRequest(socket, method, url, host, headers, body, proxy);
  } finally {
    socket.destroy();
  }
}