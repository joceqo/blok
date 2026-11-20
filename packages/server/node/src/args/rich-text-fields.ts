function readJsonString(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== '"') {
    return undefined;
  }
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      return { value, end: index + 1 };
    }
    if (ch === '\\') {
      if (index + 1 >= text.length) {
        return undefined;
      }
      value += ch + text[index + 1];
      index += 2;
      continue;
    }
    value += ch;
    index += 1;
  }
  return undefined;
}

function hasTopLevelDuplicateKey(text: string): boolean {
  let index = 0;
  const skipWs = (): void => {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
  };
  skipWs();
  if (text[index] !== '{') {
    return false;
  }
  index += 1;
  skipWs();
  const seen = new Set<string>();
  if (text[index] === '}') {
    return false;
  }
  while (index < text.length) {
    skipWs();
    const key = readJsonString(text, index);
    if (key === undefined) {
      return false;
    }
    if (seen.has(key.value)) {
      return true;
    }
    seen.add(key.value);
    index = key.end;
    skipWs();
    if (text[index] !== ':') {
      return false;
    }
    index += 1;
    skipWs();
    let depth = 0;
    let inString = false;
    while (index < text.length) {
      const ch = text[index];
      if (inString) {
        if (ch === '\\') {
          index += 2;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        index += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        index += 1;
        continue;
      }
      if (ch === '[' || ch === '{') {
        depth += 1;
        index += 1;
        continue;
      }
      if (ch === ']' || ch === '}') {
        if (depth === 0) {
          index += 1;
          break;
        }
        depth -= 1;
        index += 1;
        continue;
      }
      if (depth === 0 && ch === ',') {
        index += 1;
        break;
      }
      index += 1;
    }
    skipWs();
    if (text[index] === '}') {
      return false;
    }
    if (text[index] !== ',') {
      return false;
    }
    index += 1;
  }
  return false;
}

/** A JSON object of string lists, matching options.RichTextFields in the C# host. */
export function parseRichTextFields(value: string): Record<string, string[]> | undefined {
  if (hasTopLevelDuplicateKey(value)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const fields: Record<string, string[]> = {};
  for (const [blockType, keys] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
      return undefined;
    }
    fields[blockType] = keys;
  }
  return fields;
}