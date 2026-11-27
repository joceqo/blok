import { readZip, type ZipEntry } from '../tools/file/zip/read-zip';
import { importWorkspaceEntries, MAX_EXPANDED_BYTES, type ImportedPage } from './import-workspace-entries';

export type { ImportedPage } from './import-workspace-entries';

export const MAX_ARCHIVE_BYTES = 64 << 20;
const limits = { maxEntries: 5000, maxEntryBytes: 32 << 20, maxTotalBytes: MAX_EXPANDED_BYTES };

export async function prepareWorkspaceArchive(
  bytes: Uint8Array,
  name: string,
  rootId: string,
): Promise<ImportedPage[]> {
  if (bytes.length > MAX_ARCHIVE_BYTES)
    throw new Error('La taille maximale d’une archive ZIP est de 64 Mio.');
  let zip = readZip(bytes, limits);
  const visible = (entries: readonly ZipEntry[]) =>
    entries.filter(
      (e) => !e.dir && e.name.split('/').every((p) => p && !p.startsWith('.') && p !== '__MACOSX'),
    );
  let entries = visible(zip.entries);
  // Notion sometimes wraps a single exported part in an outer ZIP.
  if (entries.length === 1 && /\.zip$/i.test(entries[0].name)) {
    zip = readZip(await zip.read(entries[0]), limits);
    entries = visible(zip.entries);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files = entries.map((entry) => ({
    ...entry,
    text: async () => decoder.decode(await zip.read(entry)),
    base64: async () => {
      const content = await zip.read(entry);
      const chunks: string[] = [];
      for (let i = 0; i < content.length; i += 0x4000)
        chunks.push(String.fromCharCode(...content.subarray(i, i + 0x4000)));
      return btoa(chunks.join(''));
    },
  }));
  const pageId = async (path: string): Promise<string> => {
    const key = new TextEncoder().encode(JSON.stringify([rootId, path]));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
    return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  return importWorkspaceEntries(files, name, rootId, pageId, () => crypto.randomUUID());
}
