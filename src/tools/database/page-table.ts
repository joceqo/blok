import type {mountPageTable as MountPageTable} from '../../../types/tools/page-table';
import {loadHostSheet} from '../../components/utils/lazy-styles';
import {DatabaseTableView, createTableState} from './database-table-view';

/** A read-only projection of external page records through the database's normal table and grid. */
export const mountPageTable: typeof MountPageTable = (host, options) => {
  void loadHostSheet('database');
  const state = createTableState();
  let table: DatabaseTableView | undefined;
  let previousPeek: string | undefined;
  return {
    update(data) {
      const hadFocus = host.contains(document.activeElement);
      table?.destroy();
      const visible = new Set(data.rows.map(row => row.id));
      const columns = new Set(data.schema.map(property => property.id));
      const peek = data.peekedId;
      if (peek && peek !== previousPeek && visible.has(peek)) {
        const cell = {rowId: peek, propertyId: data.titlePropertyId};
        state.selection = {kind:'cell', anchor:cell, focus:cell};
      } else if (state.selection?.kind === 'cell') {
        const {anchor, focus} = state.selection;
        if (![anchor, focus].every(cell => visible.has(cell.rowId) && columns.has(cell.propertyId))) state.selection = null;
      } else if (state.selection?.kind === 'rows') {
        const remaining = state.selection.rowIds.filter(id => visible.has(id));
        state.selection = remaining.length ? {kind:'rows', rowIds:remaining} : null;
      }
      previousPeek = peek;
      state.focused = hadFocus;
      if (!hadFocus) delete state.focusedCell;
      // The host already filters and orders the records. Keep every projected row navigable.
      state.loaded.set('', data.rows.length);
      table = new DatabaseTableView({
        i18n: options.i18n,
        readOnly: true,
        schema: data.schema,
        rows: data.rows,
        titlePropertyId: data.titlePropertyId,
        state,
        openRow: options.open,
        peek: {rowId: () => peek ?? null, close: options.close},
        view: {
          id:'pages', type:'table', name:data.label, position:'a0', filters:[], sorts:[],
          visibleProperties: data.schema.map(property => property.id),
          properties: data.schema.map(property => ({id:property.id, width:data.widths[property.id]})),
        },
      });
      const element = table.createView();
      element.querySelector('[role=grid]')?.setAttribute('aria-label', data.label);
      host.replaceChildren(element);
    },
    destroy() { table?.destroy(); host.replaceChildren(); },
  };
};
