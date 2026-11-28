import { equalsOrdinalIgnoreCase } from '../dotnet/ordinal.ts';

/** Host names from allowed origins and the public URL (no port). */
export function hostNames(allowedOrigins: string[], publicUrl: string): string[] {
  const names: string[] = [];
  for (const raw of [...allowedOrigins, publicUrl]) {
    const trimmed = raw.trim();
    const scheme = trimmed.indexOf('://');
    if (scheme < 0) {
      continue;
    }
    let authority = trimmed.slice(scheme + 3);
    const slash = authority.search(/[/?#]/);
    if (slash >= 0) {
      authority = authority.slice(0, slash);
    }
    const parsed = hostName(authority);
    if (parsed.ok && parsed.name !== '') {
      names.push(parsed.name);
    }
  }
  return names;
}

export function hostAllowed(host: string, names: string[]): boolean {
  if (host === '') {
    return true;
  }
  const parsed = hostName(host);
  if (!parsed.ok) {
    return false;
  }
  const { name } = parsed;
  if (equalsOrdinalIgnoreCase(name, 'localhost') || isLoopbackIPv4(name)) {
    return true;
  }
  if (name.startsWith('[')) {
    const inner = name.slice(1, -1);
    if (inner === '::1') {
      return true;
    }
  }
  for (const allowed of names) {
    if (equalsOrdinalIgnoreCase(allowed, name)) {
      return true;
    }
  }
  return false;
}

function hostName(host: string): { ok: true; name: string } | { ok: false } {
  let name = host;
  let port = '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) {
      return { ok: false };
    }
    name = host.slice(0, end + 1);
    port = host.slice(end + 1);
    if (port !== '' && port[0] !== ':') {
      return { ok: false };
    }
    port = port.slice(1);
  } else {
    const colon = host.indexOf(':');
    if (colon >= 0) {
      name = host.slice(0, colon);
      port = host.slice(colon + 1);
    }
  }
  for (let i = 0; i < port.length; i += 1) {
    const c = port.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      return { ok: false };
    }
  }
  return { ok: true, name };
}

function isLoopbackIPv4(name: string): boolean {
  const parts = name.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) {
      return false;
    }
    let value = 0;
    for (let i = 0; i < part.length; i += 1) {
      const c = part.charCodeAt(i);
      if (c < 0x30 || c > 0x39) {
        return false;
      }
      value = value * 10 + (c - 0x30);
    }
    if (value > 255) {
      return false;
    }
  }
  return parts[0] === '127';
}