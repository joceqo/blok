import { unescapeDataString } from '../dotnet/unescape.ts';
import type { Request } from '../http/request.ts';
import { ResponseWriter } from '../http/response.ts';
import { badRequest, notFound } from './respond.ts';

export type RouteHandler = (
  request: Request,
  response: ResponseWriter,
  pathValues: Record<string, string>,
) => Promise<void>;

interface Segment {
  literal?: string;
  param?: string;
}

interface Entry {
  segments: Segment[];
  methods: string[] | undefined;
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Entry[] = [];
  fallback: RouteHandler | undefined;

  handle(pattern: string, methods: string[] | undefined, handler: RouteHandler): void {
    if (!pattern.startsWith('/') || pattern === '/' || pattern.endsWith('/')) {
      throw new Error(`route: bad pattern ${pattern}`);
    }
    const segments: Segment[] = [];
    for (const part of pattern.slice(1).split('/')) {
      if (part === '') {
        throw new Error(`route: empty segment in ${pattern}`);
      }
      if (part.startsWith('{') || part.endsWith('}')) {
        const name = part.slice(1, -1);
        if (name.length !== part.length - 2 || name === '') {
          throw new Error(`route: bad parameter in ${pattern}`);
        }
        segments.push({ param: name });
      } else {
        segments.push({ literal: part });
      }
    }
    this.routes.push({ segments, methods, handler });
  }

  async dispatch(request: Request, response: ResponseWriter): Promise<void> {
    const target = request.target();
    if (target.includes('\0') || !isAscii(target)) {
      await badRequest(response);
      return;
    }
    const path = request.path();
    const decoded = decodeKeepingSlash(path);
    if (decoded.includes('\0')) {
      await badRequest(response);
      return;
    }
    const split = pathSegments(decoded);
  if (!split.ok) {
      if (this.fallback) {
        await this.fallback(request, response, {});
        return;
      }
      await notFound(request, response);
      return;
    }
    for (const anyMethod of [false, true]) {
      let best: Entry | undefined;
      let bestValues: Record<string, string> | undefined;
      for (const entry of this.routes) {
        const isAny = entry.methods === undefined;
        if (isAny !== anyMethod || !allows(entry, request.method())) {
          continue;
        }
        const matched = matchEntry(entry, split.parts);
        if (matched && (!best || moreLiteralThan(entry, best))) {
          best = entry;
          bestValues = matched;
        }
      }
      if (best && bestValues) {
        await best.handler(request, response, bestValues);
        return;
      }
    }
    if (this.fallback) {
      await this.fallback(request, response, {});
      return;
    }
    await notFound(request, response);
  }
}

export function inGroup(request: Request, prefix: string): boolean {
  const path = targetPath(request.target());
  const split = pathSegments(decodeKeepingSlash(path));
  if (!split.ok) {
    return false;
  }
  const trimmed = prefix.replace(/\/+$/, '');
  const groupSplit = pathSegments(trimmed === '' ? '/' : trimmed);
  const group = groupSplit.ok ? groupSplit.parts : [];
  if (split.parts.length < group.length) {
    return false;
  }
  for (let i = 0; i < group.length; i += 1) {
    if (!asciiEqualFold(split.parts[i] ?? '', group[i] ?? '')) {
      return false;
    }
  }
  return true;
}

function targetPath(target: string): string {
  const q = target.indexOf('?');
  return q < 0 ? target : target.slice(0, q);
}

function allows(entry: Entry, method: string): boolean {
  if (entry.methods === undefined) {
    return true;
  }
  for (const m of entry.methods) {
    if (asciiEqualFold(m, method)) {
      return true;
    }
  }
  return false;
}

function moreLiteralThan(a: Entry, b: Entry): boolean {
  for (let i = 0; i < a.segments.length; i += 1) {
    const left = a.segments[i];
    const right = b.segments[i];
    const aParam = left?.param !== undefined;
    const bParam = right?.param !== undefined;
    if (aParam !== bParam) {
      return bParam;
    }
  }
  return false;
}

function matchEntry(entry: Entry, parts: string[]): Record<string, string> | undefined {
  if (parts.length !== entry.segments.length) {
    return undefined;
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < entry.segments.length; i += 1) {
    const segment = entry.segments[i];
    const part = parts[i] ?? '';
    if (part === '') {
      return undefined;
    }
    if (segment?.literal !== undefined) {
      if (!asciiEqualFold(segment.literal, part)) {
        return undefined;
      }
      continue;
    }
    if (segment?.param !== undefined) {
      values[segment.param] = part;
    }
  }
  return values;
}

function pathSegments(decoded: string): { ok: true; parts: string[] } | { ok: false } {
  if (!decoded.startsWith('/')) {
    return { ok: false };
  }
  let path = removeDotSegments(decoded);
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path === '/') {
    return { ok: true, parts: [] };
  }
  return { ok: true, parts: path.slice(1).split('/') };
}

function decodeKeepingSlash(s: string): string {
  if (!s.includes('%')) {
    return s;
  }
  let out = '';
  let rest = s;
  for (;;) {
    const i = indexEncodedSlash(rest);
    if (i < 0) {
      out += unescapeDataString(rest);
      return out;
    }
    out += unescapeDataString(rest.slice(0, i));
    out += rest.slice(i, i + 3);
    rest = rest.slice(i + 3);
  }
}

function indexEncodedSlash(s: string): number {
  for (let i = 0; i + 2 < s.length; i += 1) {
    const c2 = s.charAt(i + 2);
    if (s.charAt(i) === '%' && s.charAt(i + 1) === '2' && (c2 === 'F' || c2 === 'f')) {
      return i;
    }
  }
  return -1;
}

function removeDotSegments(path: string): string {
  const parts = path.slice(1).split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const last = i === parts.length - 1;
    switch (part) {
      case '.':
        if (last) {
          out.push('');
        }
        break;
      case '..':
        if (out.length > 0) {
          out.pop();
        }
        if (last) {
          out.push('');
        }
        break;
      default:
        out.push(part);
    }
  }
  return `/${out.join('/')}`;
}

function asciiEqualFold(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (lower(a.charCodeAt(i)) !== lower(b.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function lower(c: number): number {
  if (c >= 0x41 && c <= 0x5a) {
    return c + 0x20;
  }
  return c;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) >= 0x80) {
      return false;
    }
  }
  return true;
}