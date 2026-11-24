const MAX_ENVELOPE = 8 << 10;

export function readEnvelopeJson(data: Uint8Array): string | undefined {
  if (data.length > MAX_ENVELOPE) {
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  let target = '';
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() === 'url' && typeof value === 'string') {
      target = value;
    }
  }
  const trimmed = text.trimEnd();
  const withoutWs = trimmed.replace(/\s+$/, '');
  const afterClose = text.slice(withoutWs.lastIndexOf('}') + 1).trim();
  if (afterClose.length > 0 || target === '') {
    return undefined;
  }
  return target;
}