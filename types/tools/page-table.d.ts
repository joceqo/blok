import type {I18n} from '../api/i18n';
import type {DatabaseRow, PropertyDefinition} from './database';

export interface PageTableData {
  label: string;
  schema: PropertyDefinition[];
  rows: DatabaseRow[];
  titlePropertyId: string;
  widths: Record<string, number>;
  peekedId?: string;
}

export function mountPageTable(host: HTMLElement, options: {
  i18n: I18n;
  open(id: string): void;
  close(): void;
}): {
  update(data: PageTableData): void;
  destroy(): void;
};
