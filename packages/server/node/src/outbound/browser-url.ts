/** HTTPS-only URLs safe to hand to a browser (C# BrowserUrl.Secure). */

const MAX_BROWSER_URL_LENGTH = 2048;

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function plainName(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const c = name[i]!;
    const start = i === 0 || name[i - 1] === '.';
    if (
      !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.'
        || ((c === '-' || c === '_') && !start))
    ) {
      return false;
    }
  }
  return true;
}

function publicHost(hostname: string): string | undefined {
  if (hostname.includes('%')) {
    return undefined;
  }
  const lower = hostname.toLowerCase();
  if (netIsIp(hostname)) {
    if (lower === '127.0.0.1' || lower === '::1' || lower === 'localhost') {
      return undefined;
    }
    return hostname;
  }
  const dot = lower.lastIndexOf('.');
  if (!plainName(lower) || dot < 0 || dot === lower.length - 1 || lower.endsWith('.localhost')) {
    return undefined;
  }
  const labelStart = lower[dot + 1];
  if (labelStart !== undefined && labelStart >= '0' && labelStart <= '9') {
    return undefined;
  }
  return lower;
}

function netIsIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function hasEncodedControl(url: string): boolean {
  for (let i = 0; i + 2 < url.length; i += 1) {
    if (url[i] !== '%') {
      continue;
    }
    const hi = url[i + 1]!.toLowerCase();
    const lo = url[i + 2]!.toLowerCase();
    if (hi === '0' || hi === '1' || (hi === '7' && lo === 'f')) {
      return true;
    }
    if (hi === 'c' && lo === '2' && i + 5 < url.length && url[i + 3] === '%' && (url[i + 4] === '8' || url[i + 4] === '9')) {
      return true;
    }
  }
  return false;
}

export function browserUrl(baseHref: string | undefined, reference: string): string {
  if (reference === '' || hasControl(reference)) {
    return '';
  }
  let url: URL;
  try {
    url = baseHref === undefined ? new URL(reference) : new URL(reference, baseHref);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return '';
  }
  const host = publicHost(url.hostname);
  if (host === undefined) {
    return '';
  }
  const built = `https://${host}${url.pathname}${url.search}${url.hash}`;
  if (hasEncodedControl(built) || [...built].length > MAX_BROWSER_URL_LENGTH) {
    return '';
  }
  return built;
}