/** ASP.NET MediaTypeHeaderValue parsing (Kestrel upload wire parity). */

export interface MediaParam {
  name: string;
  value: string;
}

function isTokenChar(c: number): boolean {
  if (c <= 0x20 || c >= 0x7f) {
    return false;
  }
  return !'()<>@,;:\\"/[]?={}'.includes(String.fromCharCode(c));
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  space(): void {
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) {
      this.i += 1;
    }
  }

  eat(c: string): boolean {
    if (this.i < this.s.length && this.s[this.i] === c) {
      this.i += 1;
      return true;
    }
    return false;
  }

  token(): boolean {
    const start = this.i;
    while (this.i < this.s.length && isTokenChar(this.s.charCodeAt(this.i)!)) {
      this.i += 1;
    }
    return this.i > start;
  }

  quoted(): boolean {
    if (this.i >= this.s.length || this.s[this.i] !== '"') {
      return false;
    }
    this.i += 1;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '\\') {
        this.i += 2;
        continue;
      }
      if (c === '"') {
        this.i += 1;
        return true;
      }
      this.i += 1;
    }
    return false;
  }
}

export function removeQuotes(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1);
  }
  return value;
}

export function parseMediaType(s: string): { mediaType: string; params: MediaParam[]; ok: true } | { ok: false } {
  const p = new Parser(s);
  p.space();
  const typeStart = p.i;
  if (!p.token()) {
    return { ok: false };
  }
  p.space();
  if (!p.eat('/')) {
    return { ok: false };
  }
  p.space();
  if (!p.token()) {
    return { ok: false };
  }
  const mediaType = s.slice(typeStart, p.i).replace(/[ \t]/g, '');
  const params: MediaParam[] = [];
  for (;;) {
    p.space();
    if (p.i === s.length) {
      return { mediaType, params, ok: true };
    }
    if (!p.eat(';')) {
      return { ok: false };
    }
    p.space();
    if (p.i === s.length) {
      return { mediaType, params, ok: true };
    }
    const nameStart = p.i;
    if (!p.token()) {
      return { ok: false };
    }
    const param: MediaParam = { name: s.slice(nameStart, p.i), value: '' };
    p.space();
    if (p.eat('=')) {
      p.space();
      const valueStart = p.i;
      if (p.i < s.length && s[p.i] === '"') {
        if (!p.quoted()) {
          return { ok: false };
        }
      } else {
        p.token();
      }
      param.value = s.slice(valueStart, p.i);
    }
    params.push(param);
  }
}

export function unquoteParameter(value: string): string {
  const quoted = value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"';
  const unquoted = removeQuotes(value);
  if (!quoted || !unquoted.includes('\\')) {
    return unquoted;
  }
  let out = '';
  for (let i = 0; i < unquoted.length; i += 1) {
    if (unquoted[i] === '\\' && i + 1 < unquoted.length && '()<>@,;:\\"/[]?='.includes(unquoted[i + 1]!)) {
      i += 1;
    }
    out += unquoted[i];
  }
  return out;
}

export function hasConflictingParameters(params: MediaParam[]): boolean {
  const seen = new Map<string, string>();
  for (const param of params) {
    const name = param.name.toLowerCase();
    const value = unquoteParameter(param.value);
    const existing = seen.get(name);
    if (existing !== undefined && existing !== value) {
      return true;
    }
    seen.set(name, value);
  }
  return false;
}

export function sanitizeWire(value: string): string {
  const candidate = value.trim();
  let length = 0;
  for (const r of candidate) {
    length += 1;
    if (r.codePointAt(0)! > 0xffff) {
      length += 1;
    }
  }
  if (length === 0 || length > 255) {
    return '';
  }
  const parsed = parseMediaType(candidate);
  if (!parsed.ok || hasConflictingParameters(parsed.params)) {
    return '';
  }
  return candidate;
}

export function boundaryFromContentType(contentType: string): string | undefined {
  const parsed = parseMediaType(contentType);
  if (!parsed.ok || parsed.mediaType.toLowerCase() !== 'multipart/form-data' || hasConflictingParameters(parsed.params)) {
    return undefined;
  }
  for (const param of parsed.params) {
    if (param.name.toLowerCase() === 'boundary') {
      const boundary = removeQuotes(param.value);
      return boundary === '' ? undefined : boundary;
    }
  }
  return undefined;
}

export function isJsonContentType(contentType: string): boolean {
  const parsed = parseMediaType(contentType);
  return parsed.ok && parsed.mediaType.toLowerCase() === 'application/json' && !hasConflictingParameters(parsed.params);
}