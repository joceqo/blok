import { csQuote } from './numbers.ts';

const DEFAULT_TICKET_RATE_LIMIT = 60;

function splitListenAddress(listen: string): { host: string; port: string } {
  if (listen.startsWith('[')) {
    const bracket = listen.indexOf(']');
    if (bracket >= 0) {
      let port = '';
      if (bracket + 1 < listen.length && listen[bracket + 1] === ':') {
        port = listen.slice(bracket + 2);
      }
      return { host: listen.slice(1, bracket), port };
    }
  }
  const first = listen.indexOf(':');
  const last = listen.lastIndexOf(':');
  if (first >= 0 && first === last) {
    return { host: listen.slice(0, first), port: listen.slice(first + 1) };
  }
  return { host: listen.replace(/^\[|\]$/g, ''), port: '' };
}

export function defaultPublicUrl(listen: string): string {
  let { host, port } = splitListenAddress(listen);
  if (host === '' || host === '*' || host === '+') {
    host = '127.0.0.1';
  } else if (
    (host === '0.0.0.0' || host === '::' || host === '[::]')
  ) {
    host = '127.0.0.1';
  }
  let authority = host;
  if (host.includes(':')) {
    authority = `[${host}]`;
  }
  if (port !== '') {
    authority += `:${port}`;
  }
  return `http://${authority}/files`;
}

export function resolveRateLimitPerMinute(
  auth: string,
  fromFlag: number | undefined,
): number {
  if (fromFlag !== undefined) {
    return fromFlag;
  }
  return auth === 'ticket' ? DEFAULT_TICKET_RATE_LIMIT : 0;
}

export function validatePublicUrl(publicUrl: string): string | undefined {
  if (publicUrl.includes('?') || publicUrl.includes('#')) {
    return `PublicUrl must not contain a query or fragment (got ${csQuote(publicUrl)})`;
  }
  return undefined;
}

export function validateRateLimit(rateLimitPerMinute: number): string | undefined {
  if (rateLimitPerMinute < 0) {
    return `--rate-limit must be zero or greater (got ${rateLimitPerMinute})`;
  }
  return undefined;
}