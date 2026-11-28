import {markdownToBlocksWithReport} from './index';
import {CURRENT_RICH_TEXT_FIELDS} from '../shared/rich-text/fields';
import {segmentsToHtml} from '../shared/rich-text/segments-to-html';

export async function markdownPage(fileName: string, source: string) {
  const imported = await markdownToBlocksWithReport(source, {title: true});
  // The collaboration room stores these fields as canonical HTML. The Markdown API
  // exposes structured segments, including link marks and inline code.
  for (const block of imported.blocks) {
    for (const field of CURRENT_RICH_TEXT_FIELDS[block.type] ?? []) {
      const value = block.data[field];
      if (Array.isArray(value)) block.data[field] = segmentsToHtml(value);
    }
  }
  const title = imported.title || fileName.replace(/\.(md|markdown)$/i, '').trim() || 'Sans titre';
  return {title, ...(imported.icon ? {icon: imported.icon} : {}), blocks: imported.blocks};
}
