/** Link-preview metadata (conformance fixtures; Open Graph precedence). */

export interface UnfurlMetadata {
  title: string;
  description: string;
  image: string;
  favicon: string;
  domain: string;
  oembed: string;
}

function firstMatch(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  return match?.[1]?.trim() ?? '';
}

function metaContent(html: string, key: string, by: 'property' | 'name'): string {
  const pattern = new RegExp(
    `<meta[^>]+${by}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  let value = firstMatch(html, pattern);
  if (value !== '') {
    return value;
  }
  const reverse = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+${by}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  );
  return firstMatch(html, reverse);
}

function titleTag(html: string): string {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim() ?? '';
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value !== '') {
      return value;
    }
  }
  return '';
}

export function parseUnfurlMetadata(body: Uint8Array, finalUrl: string): UnfurlMetadata {
  let host = '';
  try {
    const parsed = new URL(finalUrl);
    host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = '';
  }
  const html = new TextDecoder('utf-8', { fatal: false }).decode(body);
  const title = firstNonEmpty(metaContent(html, 'og:title', 'property'), metaContent(html, 'twitter:title', 'name'), titleTag(html));
  const description = firstNonEmpty(
    metaContent(html, 'og:description', 'property'),
    metaContent(html, 'twitter:description', 'name'),
    metaContent(html, 'description', 'name'),
  );
  const image = firstNonEmpty(metaContent(html, 'og:image', 'property'), metaContent(html, 'twitter:image', 'name'));
  let favicon = '';
  let oembed = '';
  const linkIcon = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i.exec(html);
  if (linkIcon) {
    favicon = linkIcon[1]!.trim();
  }
  const linkOembed = /<link[^>]+rel=["']alternate["'][^>]+type=["']application\/json\+oembed["'][^>]+href=["']([^"']+)["']/i.exec(html);
  if (linkOembed) {
    oembed = linkOembed[1]!.trim();
  }
  return { title, description, image, favicon, domain: host, oembed };
}