type Rewrite = (value: string, key: string) => string;
function walk(value: unknown, rewrite: Rewrite, key = ''): unknown {
  if (typeof value === 'string') return rewrite(value, key);
  if (Array.isArray(value)) return value.map((item) => walk(item, rewrite, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, walk(item, rewrite, field)]),
    );
  return value;
}

export function portableValue(value: unknown, origin: string, assets: Set<string>) {
  return walk(value, (text) => {
    if (!text.startsWith(origin + '/files/') && !text.startsWith('/files/')) return text;
    const name = new URL(text, origin).pathname.slice('/files/'.length);
    if (!assets.has(name)) throw new Error('Pièce jointe absente de cet espace : ' + name);
    return 'blok-backup-media:' + name;
  });
}

const pageFields = new Set([
  'pageId',
  'parentId',
  'documentId',
  'sourcePageId',
  'targetPageId',
  'rowPageId',
  'pageIds',
  'linkedPageId',
]);
export function restoredValue(
  value: unknown,
  pages: Map<string, string>,
  media: Map<string, string>,
  workspace: string,
  destination: string,
  origin: string,
) {
  return walk(value, (text, key) => {
    if (text.startsWith('blok-backup-media:')) {
      const asset = media.get(text.slice('blok-backup-media:'.length));
      if (!asset) throw new Error('Pièce jointe manquante dans la sauvegarde.');
      return origin + '/files/' + asset;
    }
    if (pageFields.has(key)) return pages.get(text) ?? text;
    if (text.startsWith('blok://page/') || /^http:\/\/127\.0\.0\.1:\d+\/\?/.test(text)) {
      const link = new URL(text);
      const old = link.protocol === 'blok:' ? link.pathname.slice(1) : link.searchParams.get('page');
      if (
        old &&
        pages.has(old) &&
        (!link.searchParams.has('workspace') || link.searchParams.get('workspace') === workspace)
      ) {
        const target = new URL('blok://page/' + pages.get(old));
        target.searchParams.set('workspace', destination);
        target.searchParams.set('device', '1');
        if (link.searchParams.get('view') === 'whiteboard') target.searchParams.set('view', 'whiteboard');
        return target.href;
      }
    }
    return text;
  });
}
