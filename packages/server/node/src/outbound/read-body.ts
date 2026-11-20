import { DecodeError, decodeBody, encodingTokens } from './decode.ts';
import { OutboundFailure, OutboundError } from './fetcher.ts';

export function readBounded(
  raw: Buffer,
  contentLength: number | undefined,
  headers: Record<string, string[]>,
  maxBytes: number,
  truncate: boolean,
): Buffer {
  let encodings: string[] = [];
  for (const line of headers['content-encoding'] ?? []) {
    const tokens = encodingTokens(line);
    if (tokens === undefined) {
      encodings = [];
      break;
    }
    encodings.push(...tokens);
  }
  if (encodings.length > 1) {
    throw new OutboundError(OutboundFailure.UnsupportedContentEncoding);
  }
  const identity = encodings.length === 0 || encodings[0]!.toLowerCase() === 'identity';
  if (!truncate && contentLength !== undefined && contentLength > maxBytes) {
    throw new OutboundError(OutboundFailure.TooLarge);
  }
  if (truncate) {
    const prefix = raw.subarray(0, maxBytes);
    if (identity) {
      return Buffer.from(prefix);
    }
    try {
      return decodeBody(encodings[0]!, prefix);
    } catch (error) {
      if (error instanceof DecodeError) {
        throw new OutboundError(OutboundFailure.UnsupportedContentEncoding);
      }
      throw error;
    }
  }
  if (raw.length > maxBytes) {
    throw new OutboundError(OutboundFailure.TooLarge);
  }
  if (identity) {
    return Buffer.from(raw);
  }
  try {
    return decodeBody(encodings[0]!, raw);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new OutboundError(OutboundFailure.UnsupportedContentEncoding);
    }
    throw error;
  }
}