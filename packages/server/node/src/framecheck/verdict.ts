export const VERDICT_ALLOWED = 'allowed';
export const VERDICT_BLOCKED = 'blocked';
export const VERDICT_INSECURE = 'insecure';
export const VERDICT_UNKNOWN = 'unknown';

export interface HeaderLine {
  name: string;
  value: string;
}

interface Origin {
  scheme: string;
  host: string;
  domain: boolean;
  port: number;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function defaultPort(scheme: string): number {
  if (scheme === 'http' || scheme === 'ws') {
    return 80;
  }
  if (scheme === 'https' || scheme === 'wss') {
    return 443;
  }
  return -1;
}

function parseOrigin(raw: string): Origin | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') {
    return undefined;
  }
  const scheme = url.protocol.replace(/:$/, '');
  let port = url.port === '' ? 0 : Number.parseInt(url.port, 10);
  const def = defaultPort(scheme);
  if (port === def) {
    port = 0;
  }
  const host = asciiLower(url.hostname);
  const domain = !/^\d/.test(host) && !host.includes(':');
  return { scheme, host, domain, port };
}

export function frameVerdict(finalUrl: string, embedder: string, headers: HeaderLine[]): string {
  const self = parseOrigin(finalUrl);
  if (!self) {
    return VERDICT_UNKNOWN;
  }
  const ancestor = embedder === '' ? undefined : parseOrigin(embedder);
  if (ancestor && blocked(self, ancestor, headers)) {
    return VERDICT_BLOCKED;
  }
  if (self.scheme !== 'https') {
    return VERDICT_INSECURE;
  }
  if (!ancestor) {
    return VERDICT_UNKNOWN;
  }
  return VERDICT_ALLOWED;
}

function blocked(self: Origin, ancestor: Origin, headers: HeaderLine[]): boolean {
  let sawFa = false;
  for (const h of headers) {
    if (!eqFold(h.name, 'Content-Security-Policy')) {
      continue;
    }
    for (const serialized of h.value.split(',')) {
      const sources = frameAncestors(serialized);
      if (!sources) {
        continue;
      }
      sawFa = true;
      if (!matchesSourceList(ancestor, sources, self)) {
        return true;
      }
    }
  }
  if (sawFa) {
    return false;
  }
  return xFrameOptionsBlocks(self, ancestor, headers);
}

function eqFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isAsciiWhitespace(c: number): boolean {
  return c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

function frameAncestors(serialized: string): string[] | undefined {
  const seen = new Set<string>();
  for (const token of serialized.split(';')) {
    const trimmed = token.trim();
    if (trimmed === '' || [...trimmed].some((ch) => ch.codePointAt(0)! >= 0x80)) {
      continue;
    }
    const fields = trimmed.split(/\s+/).filter((f) => f !== '');
    if (fields.length === 0) {
      continue;
    }
    const name = asciiLower(fields[0]!);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (name === 'frame-ancestors') {
      return fields.slice(1);
    }
  }
  return undefined;
}

function matchesSourceList(u: Origin, sources: string[], self: Origin): boolean {
  if (sources.length === 0 || (sources.length === 1 && eqFold(sources[0]!, "'none'"))) {
    return false;
  }
  return sources.some((expression) => matchesExpression(u, expression, self));
}

function matchesExpression(u: Origin, expression: string, self: Origin): boolean {
  if (expression === '*') {
    return u.scheme === 'http' || u.scheme === 'https' || u.scheme === self.scheme;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):$/.exec(expression);
  if (scheme) {
    return schemePartMatches(scheme[1]!, u.scheme);
  }
  const host = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?)(?::([0-9]+|\*))?(\/.*)?$/.exec(expression);
  if (host) {
    const [, schemePart, hostPart, portPart, pathPart] = host;
    if (schemePart && !schemePartMatches(schemePart, u.scheme)) {
      return false;
    }
    if (!schemePart && !schemePartMatches(self.scheme, u.scheme)) {
      return false;
    }
    if (!hostPartMatches(hostPart!, u) || !portPartMatches(portPart ?? '', u)) {
      return false;
    }
    return pathPart === undefined || pathPart === '' || pathPart === '/';
  }
  if (eqFold(expression, "'self'")) {
    if (self.host === u.host && self.port === u.port && self.scheme === u.scheme) {
      return true;
    }
    return self.host === u.host && self.port === u.port
      && (u.scheme === 'https' || (self.scheme === 'http' && u.scheme === 'http'));
  }
  return false;
}

function schemePartMatches(a: string, b: string): boolean {
  a = asciiLower(a);
  b = asciiLower(b);
  if (a === b) {
    return true;
  }
  if (a === 'http') {
    return b === 'https';
  }
  if (a === 'ws') {
    return b === 'wss' || b === 'http' || b === 'https';
  }
  if (a === 'wss') {
    return b === 'https';
  }
  return false;
}

function hostPartMatches(pattern: string, u: Origin): boolean {
  if (!u.domain) {
    return false;
  }
  if (pattern === '*') {
    return true;
  }
  if (pattern.startsWith('*.')) {
    return u.host.endsWith(asciiLower(pattern.slice(1)));
  }
  return asciiLower(pattern) === u.host;
}

function portPartMatches(input: string, u: Origin): boolean {
  if (input === '*') {
    return true;
  }
  let want = 0;
  if (input !== '') {
    const trimmed = input.replace(/^0+/, '');
    if (trimmed.length > 5) {
      return false;
    }
    want = Number.parseInt(`0${trimmed}`, 10);
  }
  if (input === '') {
    return u.port === 0;
  }
  if (want === u.port) {
    return true;
  }
  return u.port === 0 && want === defaultPort(u.scheme);
}

function xFrameOptionsBlocks(self: Origin, ancestor: Origin, headers: HeaderLine[]): boolean {
  const lines: string[] = [];
  for (const h of headers) {
    if (eqFold(h.name, 'X-Frame-Options')) {
      lines.push(h.value);
    }
  }
  if (lines.length === 0) {
    return false;
  }
  const values = getDecodeSplit(lines.join(', '));
  const set = new Set(values.map((v) => asciiLower(v)));
  if (set.size > 1) {
    return set.has('deny') || set.has('allowall') || set.has('sameorigin');
  }
  const first = asciiLower(values[0] ?? '');
  if (first === 'deny') {
    return true;
  }
  if (first === 'sameorigin') {
    return !(self.host === ancestor.host && self.port === ancestor.port && self.scheme === ancestor.scheme);
  }
  return false;
}

function getDecodeSplit(input: string): string[] {
  const values: string[] = [];
  let position = 0;
  let temporary = '';
  while (position < input.length) {
    while (position < input.length && input[position] !== '"' && input[position] !== ',') {
      temporary += input[position];
      position += 1;
    }
    if (position < input.length && input[position] === '"') {
      const start = position;
      position += 1;
      while (position < input.length) {
        const c = input[position]!;
        position += 1;
        if (c === '\\') {
          if (position < input.length) {
            position += 1;
          }
          continue;
        }
        if (c === '"') {
          break;
        }
      }
      temporary += input.slice(start, position);
      if (position < input.length) {
        continue;
      }
    }
    values.push(temporary.trim());
    temporary = '';
    if (position >= input.length) {
      return values;
    }
    position += 1;
  }
  return values;
}