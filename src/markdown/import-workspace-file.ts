import type { LooseOutputData } from '../../types/data-formats/output-data';
import { markdownPage } from './import-page';

export async function importWorkspaceFile(
  name: string,
  source: string,
): Promise<LooseOutputData & { title: string }> {
  if (/\.html?$/i.test(name)) {
    const { htmlToBlocksWithReport } = await import('../view/html-to-blocks');
    const { title, icon, blocks } = htmlToBlocksWithReport(source, { title: true });
    const { CURRENT_RICH_TEXT_FIELDS } = await import('../shared/rich-text/fields');
    const { segmentsToHtml } = await import('../shared/rich-text/segments-to-html');
    for (const block of blocks)
      for (const field of CURRENT_RICH_TEXT_FIELDS[block.type] ?? []) {
        if (Array.isArray(block.data[field])) block.data[field] = segmentsToHtml(block.data[field]);
      }
    return { title: title || name.replace(/\.html?$/i, ''), ...(icon ? { icon } : {}), blocks };
  }
  if (!/\.csv$/i.test(name)) return markdownPage(name, source);
  const { parseCsv, csvDatabaseBlocks } = await import('../tools/database/database-csv');
  const table = parseCsv(source);
  if (!table.length || !table[0].length) throw new Error('Le fichier CSV est vide.');
  const title = name.slice(0, -4).trim() || 'Table';
  const database = csvDatabaseBlocks(table, {
    newId: () => crypto.randomUUID(),
    untitled: 'Column',
    viewName: 'Table',
    title,
  });
  return {
    title,
    blocks: [
      {
        type: 'database',
        id: database.id,
        data: JSON.parse(JSON.stringify(database.data)),
        content: database.rows.map((row) => row.id),
      },
      ...database.rows.map((row) => ({ ...row, type: 'database-row', parent: database.id })),
    ],
  };
}
