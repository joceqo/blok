import {importWorkspaceFile} from '../../../src/markdown/import-workspace-file';
import {seedUpdate} from '../../../packages/server/node/src/collab/room/page-document.ts';

export async function prepareDocument(name: string, source: string) {
  const document = await importWorkspaceFile(name, source);
  seedUpdate(document);
  return document;
}

export async function prepareArchive(bytes: Uint8Array, name: string, rootId: string) {
  const {prepareWorkspaceArchive} = await import('../../../src/markdown/import-workspace-archive');
  const pages = await prepareWorkspaceArchive(bytes,name,rootId);
  for (const page of pages) seedUpdate(page.document);
  return pages;
}
