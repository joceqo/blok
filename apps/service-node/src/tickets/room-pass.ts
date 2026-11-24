import { parseTree, type ParseError } from 'jsonc-parser';
import { authenticatedTicketPayload } from './hmac.ts';

// The Go verifier requires a JSON integer (including lexical form) within int64.
// Preserve the signed text so exponent/decimal spellings and duplicate claims
// behave identically in both hosts. All expiry checks use integer Unix seconds.
export function roomPass(secret: string, token: string, documentId: string, now = Date.now()) {
  try {
    const text = authenticatedTicketPayload(secret, token);
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { disallowComments: true });
    if (errors.length || root?.type !== 'object') return;
    let user = '',
      doc = '',
      write = false,
      expiry = 0n;
    for (const property of root.children ?? []) {
      const [key, value] = property.children ?? [];
      if (!value) return;
      if (key?.value === 'user' || key?.value === 'doc') {
        if (value.type !== 'null' && value.type !== 'string') return;
        if (key.value === 'user') user = value.value ?? '';
        else doc = value.value ?? '';
      } else if (key?.value === 'write') {
        if (value.type !== 'boolean') return;
        write = value.value;
      } else if (key?.value === 'exp') {
        const raw = text.slice(value.offset, value.offset + value.length);
        if (value.type !== 'number' || !/^-?\d{1,19}$/.test(raw)) return;
        expiry = BigInt(raw);
        if (expiry < -(1n << 63n) || expiry > (1n << 63n) - 1n) return;
      }
    }
    if (doc === documentId && user && expiry > BigInt(Math.floor(now / 1000))) return { user, write };
  } catch {
    /* Invalid signature, encoding or JSON. */
  }
}
