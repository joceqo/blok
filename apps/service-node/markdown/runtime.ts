import {markdownPage} from '../../../src/markdown/import-page';
import {seedUpdate} from '../../../packages/server/node/src/collab/room/page-document.ts';

export async function prepareDocument(name: string, source: string) {
  const document = await markdownPage(name, source);
  seedUpdate(document);
  return document;
}
