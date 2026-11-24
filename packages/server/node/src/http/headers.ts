/** Ordered header lists with case-insensitive lookup. */

export function eqIgnoreAsciiCase(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (asciiLower(left.charCodeAt(i)) !== asciiLower(right.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function asciiLower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 32 : code;
}

/** Trim only the given characters, from both ends (Rust trim_matches). */
export function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) {
    start += 1;
  }
  while (end > start && chars.includes(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

export class Headers {
  private entries: Array<[string, string]> = [];

  static new(): Headers {
    return new Headers();
  }

  len(): number {
    return this.entries.length;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  get(name: string): string | undefined {
    const hit = this.entries.find(([entry]) => eqIgnoreAsciiCase(entry, name));
    return hit?.[1];
  }

  *getAll(name: string): Generator<string> {
    for (const [entry, value] of this.entries) {
      if (eqIgnoreAsciiCase(entry, name)) {
        yield value;
      }
    }
  }

  contains(name: string): boolean {
    return this.get(name) !== undefined;
  }

  *iter(): Generator<[string, string]> {
    for (const entry of this.entries) {
      yield entry;
    }
  }

  add(name: string, value: string): void {
    this.entries.push([name, value]);
  }

  set(name: string, value: string): void {
    const at = this.entries.findIndex(([entry]) => eqIgnoreAsciiCase(entry, name));
    if (at === -1) {
      this.entries.push([name, value]);
      return;
    }
    this.entries[at] = [name, value];
    let index = 0;
    this.entries = this.entries.filter((entry) => {
      const here = index;
      index += 1;
      return here <= at || !eqIgnoreAsciiCase(entry[0], name);
    });
  }

  remove(name: string): void {
    this.entries = this.entries.filter(([entry]) => !eqIgnoreAsciiCase(entry, name));
  }

  clear(): void {
    this.entries = [];
  }

  *tokens(name: string): Generator<string> {
    for (const value of this.getAll(name)) {
      for (const part of value.split(',')) {
        const token = trimChars(part, ' \t');
        if (token.length > 0) {
          yield token;
        }
      }
    }
  }

  hasToken(name: string, want: string): boolean {
    for (const token of this.tokens(name)) {
      if (eqIgnoreAsciiCase(token, want)) {
        return true;
      }
    }
    return false;
  }
}

/** Kestrel's response header check: tab and 0x20-0x7E only. */
export function isFieldValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 0x09) {
      continue;
    }
    if (c < 0x20 || c > 0x7e) {
      return false;
    }
  }
  return true;
}
