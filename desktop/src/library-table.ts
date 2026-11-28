import {mountPageTable} from '@blok/page-table';
import type {PageTableData} from '@blok/page-table';
import type {DesktopPage} from './storage';
import {shellI18n} from './shell-i18n';

export function libraryTable(host: HTMLElement, open: (id: string) => void, close: () => void) {
  const grid = mountPageTable(host, {i18n:shellI18n, open, close});
  let previous: PageTableData | undefined;
  return {
    update(label: string, pages: DesktopPage[], location: ((page: DesktopPage) => string) | undefined, peekedId?: string) {
      const schema: PageTableData['schema'] = [{id:'name', name:'Nom', type:'title', position:'a0'}];
      if (location) schema.push({id:'location', name:'Emplacement', type:'text', position:'a1'});
      const data: PageTableData = {
        label, schema, titlePropertyId:'name', widths:{name:480, location:220}, peekedId,
        rows: pages.map((page, i) => ({
          id:page.id, pageId:page.id, position:String(i), icon:page.icon,
          properties: {name:page.title || 'Nouvelle page', ...(location ? {location:location(page)} : {})},
        })),
      };
      // A search box, menu or unrelated manifest refresh must leave the live selection and focus intact.
      if (previous?.label === label && previous.peekedId === peekedId && previous.schema.length === schema.length &&
        previous.rows.length === data.rows.length && previous.rows.every((old, i) => {
          const row = data.rows[i];
          return old.id === row.id && old.icon === row.icon && old.properties.name === row.properties.name && old.properties.location === row.properties.location;
        })) return;
      previous = data;
      grid.update(data);
    },
    destroy: grid.destroy,
  };
}
