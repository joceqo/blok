import net from 'node:net';

import { parseIp } from '../http/listen.ts';

/** Host portion of --listen, matching Go listenHost. */
export function listenHost(listen: string): string {
  if (listen.startsWith('[')) {
    const bracket = listen.indexOf(']');
    if (bracket >= 0) {
      return listen.slice(1, bracket);
    }
  }
  const first = listen.indexOf(':');
  const last = listen.lastIndexOf(':');
  if (first >= 0 && first === last) {
    return listen.slice(0, first);
  }
  return listen.replace(/^\[|\]$/g, '');
}

function isLoopbackHost(host: string): boolean {
  if (host === '') {
    return false;
  }
  if (host.toLowerCase() === 'localhost') {
    return true;
  }
  const ip = parseIp(host) ?? host;
  if (net.isIPv4(ip)) {
    return ip.startsWith('127.');
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1') {
      return true;
    }
    const mapped = ip.toLowerCase();
    return mapped.startsWith('::ffff:127.');
  }
  return false;
}

function isAnyHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === '0.0.0.0' || lower === '::' || lower === '*' || lower === '+';
}

export function bindScope(listen: string): string {
  const host = listenHost(listen);
  if (host === '') {
    return ' (an address with no host binds every network interface)';
  }
  if (isAnyHost(host)) {
    return ' (which binds every network interface)';
  }
  const ip = parseIp(host) ?? host;
  if ((net.isIPv4(ip) && ip === '0.0.0.0') || (net.isIPv6(ip) && ip === '::')) {
    return ' (which binds every network interface)';
  }
  return '';
}

export function isLoopbackListen(listen: string): boolean {
  const host = listenHost(listen);
  if (host === '') {
    return false;
  }
  return isLoopbackHost(host);
}

export function originIsLoopback(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}