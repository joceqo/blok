import { unescapeDataString } from '../dotnet/unescape.ts';

export interface ProxyTarget {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly password?: string;
}

type Lookup = (name: string) => string | undefined;

function proxyUrl(value: string): ProxyTarget | undefined {
  if (value === '') {
    return undefined;
  }
  let scheme = 'http';
  let port = 80;
  for (const prefix of [
    { text: 'http://', scheme: 'http', port: 80 },
    { text: 'https://', scheme: 'https', port: 443 },
    { text: 'socks4://', scheme: 'socks4', port: 80 },
    { text: 'socks5://', scheme: 'socks5', port: 80 },
    { text: 'socks4a://', scheme: 'socks4a', port: 80 },
  ]) {
    if (value.length >= prefix.text.length && value.slice(0, prefix.text.length).toLowerCase() === prefix.text) {
      scheme = prefix.scheme;
      port = prefix.port;
      value = value.slice(prefix.text.length);
      break;
    }
  }
  let user: string | undefined;
  let password: string | undefined;
  const at = value.lastIndexOf('@');
  if (at >= 0) {
    const info = unescapeDataString(value.slice(0, at));
    value = value.slice(at + 1);
    const colon = info.indexOf(':');
    if (colon >= 0) {
      user = info.slice(0, colon);
      password = info.slice(colon + 1);
    } else {
      user = info;
    }
  }
  let host = value;
  const bracket = value.indexOf(']');
  const colon = value.lastIndexOf(':');
  if (colon >= 0 && (bracket < 0 || colon > bracket)) {
    host = value.slice(0, colon);
    const digits = value.slice(colon + 1).match(/^\d+/);
    if (digits === null) {
      return undefined;
    }
    const parsed = Number.parseInt(digits[0]!, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
      return undefined;
    }
    port = parsed;
  }
  if (host === '' || /[\s/?#@]/.test(host)) {
    return undefined;
  }
  if (host.includes(':') && !host.startsWith('[')) {
    host = `[${host}]`;
  }
  return { scheme, host, port, user, password };
}

function firstProxy(lower: string, upper: string): ProxyTarget | undefined {
  return proxyUrl(lower) ?? proxyUrl(upper);
}

function uriHost(url: URL): string {
  const host = url.hostname;
  return host.includes(':') ? `[${host}]` : host;
}

function bypassed(entries: string[], host: string): boolean {
  const lowered = host.toLowerCase();
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1).toLowerCase();
      if (lowered === suffix || (lowered.length >= entry.length && lowered.endsWith(entry.toLowerCase()))) {
        return true;
      }
    } else if (lowered === entry.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function resolveEnvironmentProxy(
  requestUrl: string,
  lookup: Lookup = (name) => process.env[name],
): ProxyTarget | undefined {
  const get = (name: string): string => lookup(name) ?? '';
  const has = (name: string): boolean => lookup(name) !== undefined;
  let httpProxy = proxyUrl(get('http_proxy'));
  if (httpProxy === undefined && !has('GATEWAY_INTERFACE')) {
    httpProxy = proxyUrl(get('HTTP_PROXY'));
  }
  let httpsProxy = firstProxy(get('https_proxy'), get('HTTPS_PROXY'));
  if (httpProxy === undefined || httpsProxy === undefined) {
    const all = firstProxy(get('all_proxy'), get('ALL_PROXY'));
    if (httpProxy === undefined) {
      httpProxy = all;
    }
    if (httpsProxy === undefined) {
      httpsProxy = all;
    }
  }
  if (httpProxy === undefined && httpsProxy === undefined) {
    return undefined;
  }
  const bypassText = has('no_proxy') ? get('no_proxy') : get('NO_PROXY');
  const entries = bypassText.split(',').map((part) => part.trim()).filter((part) => part !== '');
  const url = new URL(requestUrl);
  const proxy = url.protocol === 'http:' ? httpProxy : httpsProxy;
  if (proxy === undefined || bypassed(entries, uriHost(url))) {
    return undefined;
  }
  return proxy;
}