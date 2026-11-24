/** Re-encode bad % sequences the way .NET Uri.AbsoluteUri does. */
export function absoluteUri(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const fix = (part: string): string => {
    let out = '';
    for (let i = 0; i < part.length; i += 1) {
      if (part[i] === '%' && (i + 2 >= part.length || !isHex(part[i + 1]) || !isHex(part[i + 2]))) {
        out += '%25';
      } else {
        out += part[i];
      }
    }
    return out;
  };
  const search = fix(url.search);
  const pathname = fix(url.pathname);
  if (search === url.search && pathname === url.pathname) {
    return url.href;
  }
  return `${url.origin}${pathname}${search}${url.hash}`;
}

function isHex(c: string | undefined): boolean {
  if (c === undefined) {
    return false;
  }
  const code = c.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}